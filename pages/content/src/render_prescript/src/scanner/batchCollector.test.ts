/**
 * Phase 3 TDD: Tests for BatchCollector
 *
 * BatchCollector holds execution results until all expected calls in a batch
 * have completed (or timeout), then flushes merged results.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  BatchCollector,
  type BatchFlushResult,
} from './batchCollector.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(callId: string, result: string = `result-${callId}`) {
  return { callId, functionName: `tool_${callId}`, result, status: 'success' as const };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BatchCollector', () => {
  let collector: BatchCollector;
  let flushed: BatchFlushResult[];

  beforeEach(() => {
    flushed = [];
    collector = new BatchCollector({
      onFlush: (result) => { flushed.push(result); },
      idleTimeoutMs: 100,
      maxTimeoutMs: 500,
    });
  });

  afterEach(() => {
    collector.dispose();
  });

  describe('single-call batch', () => {
    it('flushes immediately when single expected call arrives', () => {
      collector.registerBatch('b1', ['c1'], ['c1']);
      collector.addResult('b1', makeResult('c1'));

      assert.equal(flushed.length, 1);
      assert.equal(flushed[0].batchId, 'b1');
      assert.equal(flushed[0].results.length, 1);
      assert.equal(flushed[0].flushReason, 'all_settled');
    });

    it('preserves backward compat: no extra delay for single call', () => {
      collector.registerBatch('b1', ['c1'], ['c1']);
      const before = Date.now();
      collector.addResult('b1', makeResult('c1'));
      const elapsed = Date.now() - before;
      assert.ok(elapsed < 50, `Should flush immediately, took ${elapsed}ms`);
    });
  });

  describe('multi-call batch', () => {
    it('waits for all calls before flushing', () => {
      collector.registerBatch('b1', ['c1', 'c2'], ['c1', 'c2']);
      collector.addResult('b1', makeResult('c1'));

      assert.equal(flushed.length, 0, 'Should not flush with only 1 of 2 results');

      collector.addResult('b1', makeResult('c2'));
      assert.equal(flushed.length, 1);
      assert.equal(flushed[0].flushReason, 'all_settled');
    });

    it('orders results by orderedCallIds, not arrival order', () => {
      collector.registerBatch('b1', ['c1', 'c2', 'c3'], ['c1', 'c2', 'c3']);

      // Arrive out of order
      collector.addResult('b1', makeResult('c3'));
      collector.addResult('b1', makeResult('c1'));
      collector.addResult('b1', makeResult('c2'));

      assert.equal(flushed.length, 1);
      assert.deepEqual(
        flushed[0].results.map(r => r.callId),
        ['c1', 'c2', 'c3'],
      );
    });

    it('handles partial failure — failed calls do not block flush', () => {
      collector.registerBatch('b1', ['c1', 'c2'], ['c1', 'c2']);
      collector.addResult('b1', { callId: 'c1', functionName: 'tool_c1', result: 'ok', status: 'success' });
      collector.addResult('b1', { callId: 'c2', functionName: 'tool_c2', result: 'err', status: 'error' });

      assert.equal(flushed.length, 1);
      assert.equal(flushed[0].results[1].status, 'error');
    });
  });

  describe('timeout behavior', () => {
    it('idle timeout flushes partial results', async () => {
      collector.registerBatch('b1', ['c1', 'c2'], ['c1', 'c2']);
      collector.addResult('b1', makeResult('c1'));

      // Wait for idle timeout (100ms + margin)
      await new Promise(r => setTimeout(r, 200));

      assert.equal(flushed.length, 1);
      assert.equal(flushed[0].flushReason, 'idle_timeout');
      assert.equal(flushed[0].results.length, 1);
    });

    it('max timeout flushes even with no results', async () => {
      collector = new BatchCollector({
        onFlush: (result) => { flushed.push(result); },
        idleTimeoutMs: 10000, // large idle
        maxTimeoutMs: 100,    // short max
      });
      collector.registerBatch('b1', ['c1', 'c2'], ['c1', 'c2']);

      await new Promise(r => setTimeout(r, 200));

      assert.equal(flushed.length, 1);
      assert.equal(flushed[0].flushReason, 'max_timeout');
      assert.equal(flushed[0].results.length, 0);
    });
  });

  describe('edge cases', () => {
    it('ignores result for unknown batch', () => {
      collector.addResult('unknown', makeResult('c1'));
      assert.equal(flushed.length, 0);
    });

    it('ignores duplicate result for same callId', () => {
      collector.registerBatch('b1', ['c1'], ['c1']);
      collector.addResult('b1', makeResult('c1'));
      collector.addResult('b1', makeResult('c1')); // duplicate

      assert.equal(flushed.length, 1); // only one flush
    });

    it('does not flush already-flushed batch', () => {
      collector.registerBatch('b1', ['c1'], ['c1']);
      collector.addResult('b1', makeResult('c1'));
      assert.equal(flushed.length, 1);

      // Try adding more results
      collector.addResult('b1', makeResult('c1'));
      assert.equal(flushed.length, 1); // still 1
    });

    it('hasPendingBatch returns correct state', () => {
      assert.equal(collector.hasPendingBatch('b1'), false);
      collector.registerBatch('b1', ['c1'], ['c1']);
      assert.equal(collector.hasPendingBatch('b1'), true);
      collector.addResult('b1', makeResult('c1'));
      assert.equal(collector.hasPendingBatch('b1'), false);
    });
  });
});
