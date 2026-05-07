/**
 * Phase 3: Stream → Tool Execution Bridge
 *
 * Connects stream_cutoff events to MCP tool execution via executionGuard.
 * Pure bridge module — does not modify Phase 1/2 stream logic.
 *
 * Production source of truth (TypeScript).
 * Tests: streamToolBridge.test.ts imports directly from this file.
 */

// --- Interfaces ---

export interface StreamToolBridgeConfig {
  enabled: boolean;
  autoInsert: boolean;
  autoSubmit: boolean;
  toolTimeoutMs: number;
}

export interface StreamToolExecutionEvent {
  type: 'stream_tool_execution';
  streamId: string;
  identity: FunctionCallIdentityLike;
  status: 'reserved' | 'executing' | 'succeeded' | 'failed' | 'duplicate';
  phase?: 'identity' | 'parse' | 'reserve' | 'mcp_client' | 'tool_call' | 'inject' | 'submit';
  result?: unknown;
  error?: string;
  errorCode?: string;
  durationMs?: number;
}

export interface FunctionCallIdentityLike {
  name?: string | null;
  callId?: string | null;
  arguments?: string | null;
}

export interface McpClientLike {
  callTool(name: string, params: Record<string, unknown>): Promise<unknown>;
  isReady(): boolean;
}

export interface AdapterLike {
  insertText(text: string): Promise<void>;
  submitForm?(): Promise<void>;
  getInputContent?(): string;
}

export interface ExecutionGuardLike {
  reserveExecution(input: { functionName: string; callId: string; params: Record<string, unknown> }): string | null;
  executionGuardStore: {
    markSucceeded(key: string): void;
    markFailed(key: string, error?: string): void;
  };
}

export interface StorageLike {
  storeExecutedFunction(name: string, callId: string, params: Record<string, unknown>, sig: string): void;
  generateContentSignature(name: string, params: Record<string, unknown>): string;
}

export interface StreamToolBridgeDeps {
  config: StreamToolBridgeConfig;
  mcpClient: McpClientLike | null;
  guard: ExecutionGuardLike;
  adapter: () => AdapterLike | null;
  storage: StorageLike;
  onEvent: (event: StreamToolExecutionEvent) => void;
}

export interface StreamEvent {
  type?: string;
  streamId?: string;
  identity?: FunctionCallIdentityLike;
}

// --- Implementation ---

export function createStreamToolHandler(deps: StreamToolBridgeDeps) {
  const { config, mcpClient, guard, adapter, storage, onEvent } = deps;

  let executionCounter = 0;
  const expiredExecutions = new Set<number>();

  function emit(streamId: string, identity: FunctionCallIdentityLike, status: StreamToolExecutionEvent['status'], extra: Partial<StreamToolExecutionEvent> = {}) {
    onEvent({
      type: 'stream_tool_execution',
      streamId,
      identity,
      status,
      ...extra,
    });
  }

  return async function handleStreamEvent(event: StreamEvent) {
    // Step 0: Filter — only handle stream_cutoff
    if (!event || event.type !== 'stream_cutoff') return;

    const streamId = event.streamId || 'unknown';
    const identity = event.identity;

    // Step 0b: Check enabled
    if (!config.enabled) return;

    // Step 1: Validate identity
    if (!identity || !identity.name) {
      emit(streamId, identity || ({} as FunctionCallIdentityLike), 'failed', {
        phase: 'identity',
        error: 'identity.name is null or missing',
        errorCode: 'IDENTITY_INVALID',
      });
      return;
    }
    if (identity.arguments === null || identity.arguments === undefined) {
      emit(streamId, identity, 'failed', {
        phase: 'identity',
        error: 'identity.arguments is null',
        errorCode: 'IDENTITY_INVALID',
      });
      return;
    }

    // Step 2: Parse arguments (BEFORE reserve)
    let parsedArgs: Record<string, unknown>;
    try {
      parsedArgs = JSON.parse(identity.arguments);
    } catch (e) {
      emit(streamId, identity, 'failed', {
        phase: 'parse',
        error: `JSON parse failed: ${(e as Error).message}`,
        errorCode: 'PARSE_ERROR',
      });
      return;
    }

    // Step 3: Determine callId with fallback
    const callId = identity.callId ?? storage.generateContentSignature(identity.name, parsedArgs);

    // Step 4: Reserve execution
    const guardInput = { functionName: identity.name, callId, params: parsedArgs };
    const reservedKey = guard.reserveExecution(guardInput);
    if (reservedKey === null) {
      emit(streamId, identity, 'duplicate', { phase: 'reserve' });
      return;
    }

    // Step 5: Check mcpClient availability
    if (!mcpClient) {
      guard.executionGuardStore.markFailed(reservedKey, 'mcpClient not available');
      emit(streamId, identity, 'failed', {
        phase: 'mcp_client',
        error: 'mcpClient not available',
        errorCode: 'MCP_CLIENT_MISSING',
      });
      return;
    }

    if (!mcpClient.isReady || !mcpClient.isReady()) {
      guard.executionGuardStore.markFailed(reservedKey, 'mcpClient not ready');
      emit(streamId, identity, 'failed', {
        phase: 'mcp_client',
        error: 'mcpClient not ready',
        errorCode: 'MCP_CLIENT_NOT_READY',
      });
      return;
    }

    // Step 6: Execute tool with timeout
    const executionId = ++executionCounter;
    const startTime = Date.now();
    emit(streamId, identity, 'executing');

    let result: unknown;
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout>;

    try {
      result = await Promise.race([
        mcpClient.callTool(identity.name, parsedArgs),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            expiredExecutions.add(executionId);
            reject(new Error('Tool execution timeout'));
          }, config.toolTimeoutMs);
        }),
      ]);
      // P1 fix: clear timeout on success to prevent timer leak
      clearTimeout(timeoutHandle!);
    } catch (e) {
      if (expiredExecutions.has(executionId)) {
        guard.executionGuardStore.markFailed(reservedKey, 'timeout');
        emit(streamId, identity, 'failed', {
          phase: 'tool_call',
          error: 'Tool execution timeout',
          errorCode: 'TIMEOUT',
          durationMs: Date.now() - startTime,
        });
        return;
      }
      guard.executionGuardStore.markFailed(reservedKey, (e as Error).message);
      emit(streamId, identity, 'failed', {
        phase: 'tool_call',
        error: (e as Error).message,
        errorCode: 'TOOL_ERROR',
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // Step 7: Check if execution expired during await (late result)
    if (expiredExecutions.has(executionId)) {
      return;
    }

    const durationMs = Date.now() - startTime;

    // Step 8: Mark succeeded + persist
    guard.executionGuardStore.markSucceeded(reservedKey);
    const contentSignature = storage.generateContentSignature(identity.name, parsedArgs);
    storage.storeExecutedFunction(identity.name, callId, parsedArgs, contentSignature);

    // Step 9: DOM injection (with fail-closed protection)
    if (config.autoInsert) {
      const currentAdapter = adapter();
      if (!currentAdapter) {
        // P1 fix: adapter missing is a structured failure
        emit(streamId, identity, 'failed', {
          phase: 'inject',
          error: 'No adapter available for DOM injection',
          errorCode: 'ADAPTER_MISSING',
          durationMs,
        });
        return;
      }

      // P0-3 fix: fail-closed — if getInputContent is not a function, we cannot
      // reliably inspect whether user has a draft. Skip insert to avoid overwriting.
      if (typeof currentAdapter.getInputContent !== 'function') {
        emit(streamId, identity, 'succeeded', {
          result,
          durationMs,
          error: 'Cannot inspect input content — insert skipped (fail-closed)',
          errorCode: 'INSERT_SKIPPED_NO_INSPECT',
        });
        return;
      }

      const existingContent = currentAdapter.getInputContent();
      if (existingContent) {
        // User has draft — skip insert
        emit(streamId, identity, 'succeeded', { result, durationMs });
        return;
      }

      // P0-4 fix: try/catch around insert with structured error
      try {
        const formattedResult = `<function_result call_id="${callId}">\n${typeof result === 'string' ? result : JSON.stringify(result)}\n</function_result>`;
        await currentAdapter.insertText(formattedResult);
      } catch (e) {
        emit(streamId, identity, 'failed', {
          phase: 'inject',
          error: (e as Error).message,
          errorCode: 'INSERT_FAILED',
          durationMs: Date.now() - startTime,
        });
        return;
      }

      // Step 10: Optional auto-submit (P0-4 fix: try/catch)
      if (config.autoSubmit && typeof currentAdapter.submitForm === 'function') {
        try {
          await currentAdapter.submitForm();
        } catch (e) {
          emit(streamId, identity, 'failed', {
            phase: 'submit',
            error: (e as Error).message,
            errorCode: 'SUBMIT_FAILED',
            durationMs: Date.now() - startTime,
          });
          return;
        }
      }
    }

    // Step 11: Emit success
    emit(streamId, identity, 'succeeded', { result, durationMs });
  };
}
