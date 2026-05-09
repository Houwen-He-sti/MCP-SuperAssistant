/**
 * Phase 3: Stream → Tool Execution Bridge
 *
 * Connects stream_cutoff events to MCP tool execution via executionGuard.
 * Pure bridge module — does not modify Phase 1/2 stream logic.
 *
 * Production source of truth (TypeScript).
 * Tests: streamToolBridge.test.ts imports directly from this file.
 */

import { formatFunctionResult, appendAckInstruction } from './functionResultFormatter.ts';
import { generateNonce, type AckTracker } from './ackTracker.ts';

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
  phase?: 'identity' | 'parse' | 'reserve' | 'mcp_client' | 'tool_call' | 'inject' | 'submit' | 'error_inject';
  result?: unknown;
  error?: string;
  errorCode?: string;
  durationMs?: number;
}

export interface BridgeHandoffAckEvent {
  type: 'bridge_handoff_ack';
  streamId: string;
  callId: string;
  functionName: string;
  nonce: string;
  timestamp: number;
  outcome: 'RESULT_SUBMITTED';
}

export type BridgeEvent = StreamToolExecutionEvent | BridgeHandoffAckEvent;

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
  onEvent: (event: BridgeEvent) => void;
  ackTracker?: AckTracker | null;
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

// --- Constants (Gate 5) ---

/** Default max tool calls per stream when circuitBreaker config is undefined. */
export const DEFAULT_MAX_TOOL_CALLS_PER_STREAM = 5;

/** TTL for stream call count entries (10 minutes). */
export const STREAM_CALL_TTL_MS = 10 * 60 * 1000;

// --- Shared Safe-Injection Helper (Gate 5) ---

export type InjectOutcome =
  | 'RESULT_INJECTED'
  | 'RESULT_SUBMITTED'
  | 'INJECT_SKIPPED_NO_ADAPTER'
  | 'INJECT_SKIPPED_NO_INSPECT'
  | 'INJECT_SKIPPED_DRAFT'
  | 'INSERT_FAILED'
  | 'SUBMIT_FAILED';

export interface InjectResult {
  outcome: InjectOutcome;
  error?: string;
}

export interface InjectResultParams {
  callId: string;
  name: string;
  status: 'success' | 'error';
  result: unknown;
  autoSubmit: boolean;
  adapter: () => AdapterLike | null;
  /** Gate 5c.1: If provided, append ACK instruction with this nonce. */
  nonce?: string;
}

/**
 * Shared safe-injection logic used by both success and error paths.
 * Returns a structured InjectResult so callers can emit appropriate events.
 *
 * Steps:
 * 1. Resolve adapter → null check
 * 2. Check getInputContent is function → fail-closed
 * 3. Check getInputContent() !== null → fail-closed
 * 4. Check input empty → skip if draft present
 * 5. formatFunctionResult({ callId, name, status, result })
 * 6. insertText(formatted) → check === false
 * 7. If autoSubmit → submitForm() → check === false
 */
export async function injectResultIfSafe(params: InjectResultParams): Promise<InjectResult> {
  const { callId, name, status, result, autoSubmit, adapter, nonce } = params;

  const currentAdapter = adapter();
  if (!currentAdapter) {
    return { outcome: 'INJECT_SKIPPED_NO_ADAPTER' };
  }

  if (typeof currentAdapter.getInputContent !== 'function') {
    return { outcome: 'INJECT_SKIPPED_NO_INSPECT' };
  }

  let existingContent: string | null;
  try {
    existingContent = currentAdapter.getInputContent();
  } catch {
    return { outcome: 'INJECT_SKIPPED_NO_INSPECT' };
  }
  if (existingContent === null) {
    return { outcome: 'INJECT_SKIPPED_NO_INSPECT' };
  }
  if (existingContent) {
    return { outcome: 'INJECT_SKIPPED_DRAFT' };
  }

  const formatted = nonce
    ? appendAckInstruction(formatFunctionResult({ callId, name, status, result }), nonce)
    : formatFunctionResult({ callId, name, status, result });

  try {
    const insertOk = await currentAdapter.insertText(formatted);
    if (insertOk === false) {
      return { outcome: 'INSERT_FAILED', error: 'insertText returned false' };
    }
  } catch (e) {
    return { outcome: 'INSERT_FAILED', error: (e as Error).message };
  }

  if (autoSubmit && typeof currentAdapter.submitForm === 'function') {
    try {
      const submitOk = await currentAdapter.submitForm();
      if (submitOk === false) {
        return { outcome: 'SUBMIT_FAILED', error: 'submitForm returned false' };
      }
    } catch (e) {
      return { outcome: 'SUBMIT_FAILED', error: (e as Error).message };
    }
    return { outcome: 'RESULT_SUBMITTED' };
  }

  return { outcome: 'RESULT_INJECTED' };
}

// --- Implementation ---

export function createStreamToolHandler(deps: StreamToolBridgeDeps) {
  const { config, mcpClient: resolveMcpClient, guard, adapter, storage, onEvent, ackTracker } = deps;

  let executionCounter = 0;
  const expiredExecutions = new Set<number>();

  // Gate 5: Circuit breaker state
  const streamCallCounts = new Map<string, { count: number; lastAccess: number }>();

  function sweepExpiredEntries() {
    const now = Date.now();
    for (const [id, entry] of streamCallCounts) {
      if (now - entry.lastAccess > STREAM_CALL_TTL_MS) {
        streamCallCounts.delete(id);
      }
    }
  }

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

    // Step 4b (Gate 5): Circuit breaker check — only after valid + reserved + non-duplicate
    sweepExpiredEntries();
    const maxCalls = config.circuitBreaker?.maxToolCallsPerStream ?? DEFAULT_MAX_TOOL_CALLS_PER_STREAM;
    if (maxCalls > 0) {
      const entry = streamCallCounts.get(streamId);
      const currentCount = entry ? entry.count : 0;
      if (currentCount >= maxCalls) {
        guard.executionGuardStore.markFailed(reservedKey, `Circuit breaker: max ${maxCalls} tool calls per stream exceeded`);
        emit(streamId, identity, 'failed', {
          phase: 'reserve',
          error: `Circuit breaker: max ${maxCalls} tool calls per stream exceeded`,
          errorCode: 'CIRCUIT_BREAKER_OPEN',
        });
        return;
      }
      streamCallCounts.set(streamId, { count: currentCount + 1, lastAccess: Date.now() });
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
        // Gate 5: inject error result for AI consumption
        if (config.autoInsert) {
          const { outcome, error: injectError } = await injectResultIfSafe({
            callId, name: identity.name!, status: 'error',
            result: 'Tool execution timeout',
            autoSubmit: !!config.autoSubmit, adapter,
          });
          emit(streamId, identity, 'failed', {
            phase: 'error_inject',
            error: injectError || undefined,
            errorCode: outcome,
            durationMs: Date.now() - startTime,
          });
        }
        return;
      }
      guard.executionGuardStore.markFailed(reservedKey, (e as Error).message);
      emit(streamId, identity, 'failed', {
        phase: 'tool_call',
        error: (e as Error).message,
        errorCode: 'TOOL_ERROR',
        durationMs: Date.now() - startTime,
      });
      // Gate 5: inject error result for AI consumption
      if (config.autoInsert) {
        const { outcome, error: injectError } = await injectResultIfSafe({
          callId, name: identity.name!, status: 'error',
          result: (e as Error).message,
          autoSubmit: !!config.autoSubmit, adapter,
        });
        emit(streamId, identity, 'failed', {
          phase: 'error_inject',
          error: injectError || undefined,
          errorCode: outcome,
          durationMs: Date.now() - startTime,
        });
      }
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

    // Step 9: DOM injection via shared safe-injection helper (Gate 5 refactor)
    if (config.autoInsert) {
      // Gate 5c.1: Generate nonce for ACK tracking (only for success + autoSubmit)
      const nonce = (config.autoSubmit && ackTracker) ? generateNonce(callId) : undefined;

      const { outcome, error: injectError } = await injectResultIfSafe({
        callId, name: identity.name!, status: 'success',
        result, autoSubmit: !!config.autoSubmit, adapter, nonce,
      });

      switch (outcome) {
        case 'RESULT_SUBMITTED':
          emit(streamId, identity, 'succeeded', { result, durationMs });
          // Gate 5c.1: Emit bridge handoff ACK + register nonce for cross-turn tracking
          if (nonce && ackTracker) {
            onEvent({
              type: 'bridge_handoff_ack',
              streamId,
              callId,
              functionName: identity.name!,
              nonce,
              timestamp: Date.now(),
              outcome: 'RESULT_SUBMITTED',
            });
            ackTracker.registerPending(nonce, callId, identity.name!);
          }
          return;
        case 'RESULT_INJECTED':
          emit(streamId, identity, 'succeeded', { result, durationMs });
          return;
        case 'INJECT_SKIPPED_NO_ADAPTER':
          emit(streamId, identity, 'failed', {
            phase: 'inject',
            error: 'No adapter available for DOM injection',
            errorCode: 'ADAPTER_MISSING',
            durationMs,
          });
          return;
        case 'INJECT_SKIPPED_NO_INSPECT':
          emit(streamId, identity, 'succeeded', {
            result, durationMs,
            error: 'Cannot inspect input content — insert skipped (fail-closed)',
            errorCode: 'INSERT_SKIPPED_NO_INSPECT',
          });
          return;
        case 'INJECT_SKIPPED_DRAFT':
          emit(streamId, identity, 'succeeded', { result, durationMs });
          return;
        case 'INSERT_FAILED':
          emit(streamId, identity, 'failed', {
            phase: 'inject',
            error: injectError || 'insertText failed',
            errorCode: 'INSERT_FAILED',
            durationMs: Date.now() - startTime,
          });
          return;
        case 'SUBMIT_FAILED':
          emit(streamId, identity, 'failed', {
            phase: 'submit',
            error: injectError || 'submitForm failed',
            errorCode: 'SUBMIT_FAILED',
            durationMs: Date.now() - startTime,
          });
          return;
      }
    }

    // Step 10: Emit success (no autoInsert, or injection not attempted)
    emit(streamId, identity, 'succeeded', { result, durationMs });
  };
}
