/**
 * Phase 4 TDD: BatchAwareHandler tests
 *
 * BatchAwareHandler routes tool execution results to either:
 * - Direct single-result callback (legacy path, no batch)
 * - BatchCollector → merged result callback (batch path)
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  BatchAwareHandler,
  type BatchAwareHandlerOptions,
  type MergedBatchResult,
} from './batchAwareHandler.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createOptions(overrides: Partial<BatchAwareHandlerOptions> = {}): BatchAwareHandlerOptions {
  return {
    onSingleResult: mock.fn(() => {}),
    onBatchResult: mock.fn(() => {}),
    idleTimeoutMs: 100,
    maxTimeoutMs: 500,
    streamEndDebounceMs: 50,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BatchAwareHandler', () => {
  let handler: BatchAwareHandler;
  let opts: BatchAwareHandlerOptions;

  beforeEach(() => {
    opts = createOptions();
    handler = new BatchAwareHandler(opts);
  });

  afterEach(() => {
    handler.dispose();
  });

  // =========================================================================
  // Single-call (no batch registered) → direct callback
  // =========================================================================

  it('routes result to onSingleResult when no batch is registered', () => {
    const detail = { result: 'hello', callId: 'c1', functionName: 'test' };
    handler.handleResult(detail);

    const fn = opts.onSingleResult as ReturnType<typeof mock.fn>;
    assert.equal(fn.mock.calls.length, 1);
    assert.deepEqual(fn.mock.calls[0].arguments[0], detail);
  });

  it('does not call onBatchResult for unbatched results', () => {
    handler.handleResult({ result: 'hello', callId: 'c1', functionName: 'test' });

    const fn = opts.onBatchResult as ReturnType<typeof mock.fn>;
    assert.equal(fn.mock.calls.length, 0);
  });

  // =========================================================================
  // Batch registered → results go to collector
  // =========================================================================

  it('does not call onSingleResult for batched callIds', () => {
    handler.registerBatch('b1', ['c1', 'c2'], ['c1', 'c2']);
    handler.handleResult({ result: 'r1', callId: 'c1', functionName: 'f1' });

    const fn = opts.onSingleResult as ReturnType<typeof mock.fn>;
    assert.equal(fn.mock.calls.length, 0);
  });

  it('flushes merged result when all batch calls settle', () => {
    handler.registerBatch('b1', ['c1', 'c2'], ['c1', 'c2']);
    handler.handleResult({ result: 'r1', callId: 'c1', functionName: 'f1' });
    handler.handleResult({ result: 'r2', callId: 'c2', functionName: 'f2' });

    const fn = opts.onBatchResult as ReturnType<typeof mock.fn>;
    assert.equal(fn.mock.calls.length, 1);

    const merged: MergedBatchResult = fn.mock.calls[0].arguments[0];
    assert.equal(merged.batchId, 'b1');
    assert.equal(merged.flushReason, 'all_settled');
    assert.equal(merged.callCount, 2);
    // mergedText should contain function_results XML for both calls
    assert.ok(merged.mergedText.includes('call_id="c1"'));
    assert.ok(merged.mergedText.includes('call_id="c2"'));
    assert.ok(merged.mergedText.includes('f1'));
    assert.ok(merged.mergedText.includes('f2'));
  });

  it('preserves original call order in merged result', () => {
    handler.registerBatch('b1', ['c1', 'c2', 'c3'], ['c1', 'c2', 'c3']);
    // Add in reverse order
    handler.handleResult({ result: 'r3', callId: 'c3', functionName: 'f3' });
    handler.handleResult({ result: 'r1', callId: 'c1', functionName: 'f1' });
    handler.handleResult({ result: 'r2', callId: 'c2', functionName: 'f2' });

    const fn = opts.onBatchResult as ReturnType<typeof mock.fn>;
    const merged: MergedBatchResult = fn.mock.calls[0].arguments[0];

    // c1 should appear before c2, c2 before c3
    const idx1 = merged.mergedText.indexOf('call_id="c1"');
    const idx2 = merged.mergedText.indexOf('call_id="c2"');
    const idx3 = merged.mergedText.indexOf('call_id="c3"');
    assert.ok(idx1 < idx2, 'c1 should come before c2');
    assert.ok(idx2 < idx3, 'c2 should come before c3');
  });

  // =========================================================================
  // Single-call batch → immediate flush (backward compat)
  // =========================================================================

  it('flushes immediately for single-call batch', () => {
    handler.registerBatch('b1', ['c1'], ['c1']);
    handler.handleResult({ result: 'r1', callId: 'c1', functionName: 'f1' });

    const batchFn = opts.onBatchResult as ReturnType<typeof mock.fn>;
    assert.equal(batchFn.mock.calls.length, 1);

    const merged: MergedBatchResult = batchFn.mock.calls[0].arguments[0];
    assert.equal(merged.callCount, 1);
    assert.equal(merged.flushReason, 'all_settled');
  });

  // =========================================================================
  // Error results included
  // =========================================================================

  it('includes error results in merged output', () => {
    handler.registerBatch('b1', ['c1', 'c2'], ['c1', 'c2']);
    handler.handleResult({ result: 'ok', callId: 'c1', functionName: 'f1', status: 'success' });
    handler.handleResult({ result: 'fail', callId: 'c2', functionName: 'f2', status: 'error' });

    const fn = opts.onBatchResult as ReturnType<typeof mock.fn>;
    const merged: MergedBatchResult = fn.mock.calls[0].arguments[0];
    assert.ok(merged.mergedText.includes('status="success"'));
    assert.ok(merged.mergedText.includes('status="error"'));
  });

  // =========================================================================
  // Partial flush on timeout
  // =========================================================================

  it('flushes partial results on idle timeout', async () => {
    handler.registerBatch('b1', ['c1', 'c2'], ['c1', 'c2']);
    handler.handleResult({ result: 'r1', callId: 'c1', functionName: 'f1' });

    // Wait for idle timeout (100ms + margin)
    await new Promise(r => setTimeout(r, 150));

    const fn = opts.onBatchResult as ReturnType<typeof mock.fn>;
    assert.equal(fn.mock.calls.length, 1);

    const merged: MergedBatchResult = fn.mock.calls[0].arguments[0];
    assert.equal(merged.flushReason, 'idle_timeout');
    assert.equal(merged.callCount, 1);
  });

  // =========================================================================
  // Mixed: batched + unbatched coexist
  // =========================================================================

  it('routes batched and unbatched results correctly', () => {
    handler.registerBatch('b1', ['c1'], ['c1']);

    // Unbatched result
    handler.handleResult({ result: 'unbatched', callId: 'c99', functionName: 'other' });
    // Batched result
    handler.handleResult({ result: 'batched', callId: 'c1', functionName: 'f1' });

    const singleFn = opts.onSingleResult as ReturnType<typeof mock.fn>;
    const batchFn = opts.onBatchResult as ReturnType<typeof mock.fn>;

    assert.equal(singleFn.mock.calls.length, 1);
    assert.equal(batchFn.mock.calls.length, 1);

    assert.equal(singleFn.mock.calls[0].arguments[0].callId, 'c99');
    assert.equal(batchFn.mock.calls[0].arguments[0].batchId, 'b1');
  });

  // =========================================================================
  // isBatchedCall query
  // =========================================================================

  it('isBatchedCall returns true for registered batch callIds', () => {
    handler.registerBatch('b1', ['c1', 'c2'], ['c1', 'c2']);
    assert.equal(handler.isBatchedCall('c1'), true);
    assert.equal(handler.isBatchedCall('c2'), true);
    assert.equal(handler.isBatchedCall('c99'), false);
  });

  it('isBatchedCall returns false after batch is flushed', () => {
    handler.registerBatch('b1', ['c1'], ['c1']);
    handler.handleResult({ result: 'r1', callId: 'c1', functionName: 'f1' });
    // batch flushed
    assert.equal(handler.isBatchedCall('c1'), false);
  });

  // =========================================================================
  // streamEnded
  // =========================================================================

  it('markStreamEnded triggers flush after debounce', async () => {
    handler.registerBatch('b1', ['c1', 'c2'], ['c1', 'c2']);
    handler.handleResult({ result: 'r1', callId: 'c1', functionName: 'f1' });
    handler.markStreamEnded('b1');

    await new Promise(r => setTimeout(r, 100));

    const fn = opts.onBatchResult as ReturnType<typeof mock.fn>;
    assert.equal(fn.mock.calls.length, 1);
    assert.equal(fn.mock.calls[0].arguments[0].flushReason, 'stream_end');
  });

  // =========================================================================
  // dispose
  // =========================================================================

  it('dispose cleans up without flushing', () => {
    handler.registerBatch('b1', ['c1', 'c2'], ['c1', 'c2']);
    handler.handleResult({ result: 'r1', callId: 'c1', functionName: 'f1' });
    handler.dispose();

    const fn = opts.onBatchResult as ReturnType<typeof mock.fn>;
    assert.equal(fn.mock.calls.length, 0);
  });

  // =========================================================================
  // mergedText header format
  // =========================================================================

  it('merged text has proper header', () => {
    handler.registerBatch('b1', ['c1', 'c2'], ['c1', 'c2']);
    handler.handleResult({ result: 'r1', callId: 'c1', functionName: 'f1' });
    handler.handleResult({ result: 'r2', callId: 'c2', functionName: 'f2' });

    const fn = opts.onBatchResult as ReturnType<typeof mock.fn>;
    const merged: MergedBatchResult = fn.mock.calls[0].arguments[0];
    assert.ok(merged.mergedText.startsWith('Tool execution results'));
    assert.ok(merged.mergedText.includes('2 calls'));
  });

  // =========================================================================
  // P1 fix: Late results after partial flush are suppressed
  // =========================================================================

  it('suppresses late result after idle_timeout partial flush', async () => {
    handler.registerBatch('b1', ['c1', 'c2'], ['c1', 'c2']);
    handler.handleResult({ result: 'r1', callId: 'c1', functionName: 'f1' });

    // Wait for idle timeout flush
    await new Promise(r => setTimeout(r, 150));

    const batchFn = opts.onBatchResult as ReturnType<typeof mock.fn>;
    assert.equal(batchFn.mock.calls.length, 1);
    assert.equal(batchFn.mock.calls[0].arguments[0].flushReason, 'idle_timeout');

    const singleFn = opts.onSingleResult as ReturnType<typeof mock.fn>;

    // Late result for c2 — should NOT route to onSingleResult
    handler.handleResult({ result: 'r2', callId: 'c2', functionName: 'f2' });

    assert.equal(singleFn.mock.calls.length, 0, 'late result must not route to onSingleResult');
    assert.equal(batchFn.mock.calls.length, 1, 'late result must not trigger second onBatchResult');
  });

  it('suppresses late result after stream_end partial flush', async () => {
    handler.registerBatch('b1', ['c1', 'c2'], ['c1', 'c2']);
    handler.handleResult({ result: 'r1', callId: 'c1', functionName: 'f1' });
    handler.markStreamEnded('b1');

    await new Promise(r => setTimeout(r, 100));

    const batchFn = opts.onBatchResult as ReturnType<typeof mock.fn>;
    assert.equal(batchFn.mock.calls.length, 1);

    const singleFn = opts.onSingleResult as ReturnType<typeof mock.fn>;
    handler.handleResult({ result: 'r2', callId: 'c2', functionName: 'f2' });

    assert.equal(singleFn.mock.calls.length, 0, 'late result must be suppressed');
    assert.equal(batchFn.mock.calls.length, 1, 'no second batch flush');
  });

  // =========================================================================
  // P2 fix: Duplicate registerBatch is idempotent
  // =========================================================================

  it('duplicate registerBatch does not cause state drift', () => {
    handler.registerBatch('b1', ['c1'], ['c1']);
    handler.registerBatch('b1', ['c1', 'c99'], ['c1', 'c99']); // should be ignored

    handler.handleResult({ result: 'r1', callId: 'c1', functionName: 'f1' });

    const batchFn = opts.onBatchResult as ReturnType<typeof mock.fn>;
    assert.equal(batchFn.mock.calls.length, 1);

    // c99 should NOT be batched (second registerBatch was ignored)
    assert.equal(handler.isBatchedCall('c99'), false);
  });
});
