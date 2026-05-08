/**
 * Phase 3: Stream → Tool Execution Bridge
 *
 * Connects stream_cutoff events to MCP tool execution via executionGuard.
 * Pure bridge module — does not modify Phase 1/2 stream logic.
 *
 * Production source of truth (TypeScript).
 * Tests: streamToolBridge.test.ts imports directly from this file.
 */

import { formatFunctionResult } from './functionResultFormatter.ts';

// --- Constants ---

/** Maximum allowed size for raw arguments string (64KB). Reject before parse to prevent DoS. */
export const MAX_ARGS_SIZE = 65_536;

// --- Interfaces ---

export interface StreamToolBridgeConfig {
  enabled: boolean;           // allows MCP tool execution
  autoInsert: boolean;
  autoSubmit: boolean;
  toolTimeoutMs: number;
  // Reserved for Gate 5. No runtime enforcement in Gate 3C-prep.
  circuitBreaker?: {
    maxToolCallsPerStream?: number;
  };
  // Gate 3C: tool name allowlist. undefined/empty = allow all (backward compatible).
  toolAllowlist?: string[];
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
  insertText(text: string): Promise<boolean>;
  submitForm?(): Promise<boolean>;
  getInputContent?(): string | null;
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
  mcpClient: () => McpClientLike | null;
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

// --- Adapter Diagnostic (P0-3) ---

export type AdapterStatus = 'ok' | 'partial' | 'input_not_found' | 'input_not_editable' | 'submit_not_found' | 'unknown_error';

export interface AdapterDiagnostic {
  adapterAvailable: boolean;
  adapterStatus: AdapterStatus;
  inputEmpty: boolean | null;
  inputTextLength: number | null;
}

/**
 * Pure diagnostic function — inspects an adapter and returns health info.
 * Does not expose input content, only length and emptiness.
 */
export function getAdapterDiagnostic(adapter: AdapterLike | null): AdapterDiagnostic {
  if (!adapter) {
    return { adapterAvailable: false, adapterStatus: 'input_not_found', inputEmpty: null, inputTextLength: null };
  }

  if (typeof adapter.insertText !== 'function') {
    return { adapterAvailable: true, adapterStatus: 'input_not_editable', inputEmpty: null, inputTextLength: null };
  }

  if (typeof adapter.submitForm !== 'function') {
    // Can insert but cannot submit
    const inputInfo = getInputInfo(adapter);
    return { adapterAvailable: true, adapterStatus: 'submit_not_found', ...inputInfo };
  }

  const inputInfo = getInputInfo(adapter);
  // 'partial' if we cannot inspect input content (getInputContent missing or throws)
  const status: AdapterStatus = inputInfo.inputEmpty === null ? 'partial' : 'ok';
  return { adapterAvailable: true, adapterStatus: status, ...inputInfo };
}

function getInputInfo(adapter: AdapterLike): { inputEmpty: boolean | null; inputTextLength: number | null } {
  if (typeof adapter.getInputContent !== 'function') {
    return { inputEmpty: null, inputTextLength: null };
  }
  try {
    const content = adapter.getInputContent();
    if (content === null) {
      return { inputEmpty: null, inputTextLength: null };
    }
    return { inputEmpty: !content, inputTextLength: content.length };
  } catch {
    return { inputEmpty: null, inputTextLength: null };
  }
}

// --- Implementation ---

export function createStreamToolHandler(deps: StreamToolBridgeDeps) {
  const { config, mcpClient: resolveMcpClient, guard, adapter, storage, onEvent } = deps;

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

    // Step 1b: Tool allowlist check (before parse to save work on rejected tools)
    if (config.toolAllowlist && config.toolAllowlist.length > 0) {
      if (!config.toolAllowlist.includes(identity.name)) {
        emit(streamId, identity, 'failed', {
          phase: 'identity',
          error: `Tool "${identity.name}" not in allowlist`,
          errorCode: 'TOOL_NOT_ALLOWED',
        });
        return;
      }
    }

    // Step 2: Parse arguments (BEFORE reserve)
    // Accept null/undefined as empty args — no-arg tools (e.g. get_bridge_info) are valid
    let parsedArgs: Record<string, unknown>;
    const rawArgs = identity.arguments ?? '{}';

    // Step 2a: Reject oversized arguments BEFORE parse (prevent DoS on JSON.parse)
    if (rawArgs.length > MAX_ARGS_SIZE) {
      emit(streamId, identity, 'failed', {
        phase: 'parse',
        error: `Arguments too large: ${rawArgs.length} bytes (max ${MAX_ARGS_SIZE})`,
        errorCode: 'ARGS_TOO_LARGE',
      });
      return;
    }

    try {
      parsedArgs = JSON.parse(rawArgs);
    } catch (e) {
      emit(streamId, identity, 'failed', {
        phase: 'parse',
        error: `JSON parse failed: ${(e as Error).message}`,
        errorCode: 'PARSE_ERROR',
      });
      return;
    }

    // Step 2b: Validate parsed type is a plain object (not array, null, number, string)
    if (parsedArgs === null || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
      emit(streamId, identity, 'failed', {
        phase: 'parse',
        error: `Arguments must be a plain object, got ${Array.isArray(parsedArgs) ? 'array' : typeof parsedArgs}`,
        errorCode: 'ARGS_NOT_OBJECT',
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

    // Step 5: Check mcpClient availability (lazy per-event resolution)
    const mcpClient = resolveMcpClient();
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
      clearTimeout(timeoutHandle!);
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
      if (existingContent === null) {
        // Cannot inspect input (element not found) — fail-closed, skip insert
        emit(streamId, identity, 'succeeded', {
          result,
          durationMs,
          error: 'Input element not found — insert skipped (fail-closed)',
          errorCode: 'INSERT_SKIPPED_NO_INSPECT',
        });
        return;
      }
      if (existingContent) {
        // User has draft — skip insert
        emit(streamId, identity, 'succeeded', { result, durationMs });
        return;
      }

      // P0-4 fix: try/catch around insert with structured error
      try {
        const formattedResult = formatFunctionResult({
          callId,
          name: identity.name!,
          status: 'ok',
          result,
        });
        const insertOk = await currentAdapter.insertText(formattedResult);
        if (insertOk === false) {
          emit(streamId, identity, 'failed', {
            phase: 'inject',
            error: 'insertText returned false',
            errorCode: 'INSERT_FAILED',
            durationMs: Date.now() - startTime,
          });
          return;
        }
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
          const submitOk = await currentAdapter.submitForm();
          if (submitOk === false) {
            emit(streamId, identity, 'failed', {
              phase: 'submit',
              error: 'submitForm returned false',
              errorCode: 'SUBMIT_FAILED',
              durationMs: Date.now() - startTime,
            });
            return;
          }
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
