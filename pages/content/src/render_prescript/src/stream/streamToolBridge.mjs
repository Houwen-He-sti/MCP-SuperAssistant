/**
 * Phase 3: Stream → Tool Execution Bridge
 *
 * Connects stream_cutoff events to MCP tool execution via executionGuard.
 * Pure bridge module — does not modify Phase 1/2 stream logic.
 *
 * Dependencies (injected):
 * - mcpClient: { callTool(name, params), isReady() }
 * - guard: { reserveExecution(input), executionGuardStore: { markSucceeded, markFailed } }
 * - adapter: () => { insertText(text), submitForm(), getInputContent?() }
 * - storage: { storeExecutedFunction(name, callId, params, sig), generateContentSignature(name, params) }
 */

/**
 * @typedef {Object} StreamToolBridgeConfig
 * @property {boolean} enabled
 * @property {boolean} autoInsert
 * @property {boolean} autoSubmit
 * @property {number} toolTimeoutMs
 */

/**
 * @typedef {Object} StreamToolExecutionEvent
 * @property {'stream_tool_execution'} type
 * @property {string} streamId
 * @property {Object} identity
 * @property {'reserved'|'executing'|'succeeded'|'failed'|'duplicate'} status
 * @property {string} [phase]
 * @property {*} [result]
 * @property {string} [error]
 * @property {string} [errorCode]
 * @property {number} [durationMs]
 */

/**
 * Creates a stream tool handler function that processes stream events.
 *
 * @param {Object} deps - Injected dependencies
 * @param {StreamToolBridgeConfig} deps.config
 * @param {Object|null} deps.mcpClient
 * @param {Object} deps.guard
 * @param {Function} deps.adapter - () => adapter instance or null
 * @param {Object} deps.storage
 * @param {Function} deps.onEvent - (StreamToolExecutionEvent) => void
 * @returns {Function} async handler(event) => void
 */
export function createStreamToolHandler(deps) {
  const { config, mcpClient, guard, adapter, storage, onEvent } = deps;

  let executionCounter = 0;
  const expiredExecutions = new Set();

  function emit(streamId, identity, status, extra = {}) {
    onEvent({
      type: 'stream_tool_execution',
      streamId,
      identity,
      status,
      ...extra,
    });
  }

  return async function handleStreamEvent(event) {
    // Step 0: Filter — only handle stream_cutoff
    if (!event || event.type !== 'stream_cutoff') return;

    const streamId = event.streamId || 'unknown';
    const identity = event.identity;

    // Step 0b: Check enabled
    if (!config.enabled) return;

    // Step 1: Validate identity
    if (!identity || !identity.name) {
      emit(streamId, identity || {}, 'failed', { phase: 'identity', error: 'identity.name is null or missing', errorCode: 'IDENTITY_INVALID' });
      return;
    }
    if (identity.arguments === null || identity.arguments === undefined) {
      emit(streamId, identity, 'failed', { phase: 'identity', error: 'identity.arguments is null', errorCode: 'IDENTITY_INVALID' });
      return;
    }

    // Step 2: Parse arguments (BEFORE reserve)
    let parsedArgs;
    try {
      parsedArgs = JSON.parse(identity.arguments);
    } catch (e) {
      emit(streamId, identity, 'failed', { phase: 'parse', error: `JSON parse failed: ${e.message}`, errorCode: 'PARSE_ERROR' });
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
      emit(streamId, identity, 'failed', { phase: 'mcp_client', error: 'mcpClient not available', errorCode: 'MCP_CLIENT_MISSING' });
      return;
    }

    if (!mcpClient.isReady || !mcpClient.isReady()) {
      guard.executionGuardStore.markFailed(reservedKey, 'mcpClient not ready');
      emit(streamId, identity, 'failed', { phase: 'mcp_client', error: 'mcpClient not ready', errorCode: 'MCP_CLIENT_NOT_READY' });
      return;
    }

    // Step 6: Execute tool with timeout
    const executionId = ++executionCounter;
    const startTime = Date.now();
    emit(streamId, identity, 'executing');

    let result;
    let timedOut = false;

    try {
      result = await Promise.race([
        mcpClient.callTool(identity.name, parsedArgs),
        new Promise((_, reject) => {
          setTimeout(() => {
            timedOut = true;
            expiredExecutions.add(executionId);
            reject(new Error('Tool execution timeout'));
          }, config.toolTimeoutMs);
        }),
      ]);
    } catch (e) {
      // Check if this execution was expired (late resolution after timeout)
      if (expiredExecutions.has(executionId)) {
        // Already handled by timeout path
        guard.executionGuardStore.markFailed(reservedKey, 'timeout');
        emit(streamId, identity, 'failed', {
          phase: 'tool_call',
          error: 'Tool execution timeout',
          errorCode: 'TIMEOUT',
          durationMs: Date.now() - startTime,
        });
        return;
      }
      guard.executionGuardStore.markFailed(reservedKey, e.message);
      emit(streamId, identity, 'failed', {
        phase: 'tool_call',
        error: e.message,
        errorCode: 'TOOL_ERROR',
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // Step 7: Check if execution expired during await (late result)
    if (expiredExecutions.has(executionId)) {
      // Late result — do NOT process
      return;
    }

    const durationMs = Date.now() - startTime;

    // Step 8: Mark succeeded + persist
    guard.executionGuardStore.markSucceeded(reservedKey);
    const contentSignature = storage.generateContentSignature(identity.name, parsedArgs);
    storage.storeExecutedFunction(identity.name, callId, parsedArgs, contentSignature);

    // Step 9: DOM injection
    if (config.autoInsert) {
      const currentAdapter = adapter();
      if (currentAdapter) {
        // Check user draft
        const existingContent = typeof currentAdapter.getInputContent === 'function'
          ? currentAdapter.getInputContent()
          : '';
        
        if (!existingContent) {
          const formattedResult = `<function_result call_id="${callId}">\n${typeof result === 'string' ? result : JSON.stringify(result)}\n</function_result>`;
          await currentAdapter.insertText(formattedResult);

          // Step 10: Optional auto-submit
          if (config.autoSubmit && typeof currentAdapter.submitForm === 'function') {
            await currentAdapter.submitForm();
          }
        }
      }
    }

    // Step 11: Emit success
    emit(streamId, identity, 'succeeded', { result, durationMs });
  };
}
