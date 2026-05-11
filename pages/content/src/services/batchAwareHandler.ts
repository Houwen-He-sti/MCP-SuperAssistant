/**
 * Phase 4: BatchAwareHandler — routes tool execution results to either
 * direct single-result processing or batch collection + merged flush.
 *
 * This is the integration layer between AutomationService and BatchCollector.
 * It decides per-result whether to process immediately (single/unbatched)
 * or defer to BatchCollector (multi-call batch).
 *
 * Design:
 * - AutomationService owns one BatchAwareHandler instance
 * - When DOM scanner detects a multi-call message → registerBatch()
 * - Each mcp:tool-execution-complete event → handleResult()
 * - Unbatched callIds → onSingleResult (legacy path, unchanged behavior)
 * - Batched callIds → BatchCollector → onBatchResult (merged text)
 */

import {
  BatchCollector,
  type BatchCallResult,
  type BatchFlushResult,
  type BatchCollectorOptions,
} from '../render_prescript/src/scanner/batchCollector.ts';
import { formatFunctionResult } from '../render_prescript/src/stream/functionResultFormatter.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal detail from mcp:tool-execution-complete for routing */
export interface ResultDetail {
  callId?: string;
  functionName?: string;
  result?: string;
  status?: 'success' | 'error';
  /** Pass-through fields (file attachment, etc.) */
  [key: string]: unknown;
}

/** Merged batch result delivered to onBatchResult callback */
export interface MergedBatchResult {
  batchId: string;
  mergedText: string;
  callCount: number;
  flushReason: BatchFlushResult['flushReason'];
}

export interface BatchAwareHandlerOptions {
  /** Called for results NOT belonging to any active batch */
  onSingleResult: (detail: ResultDetail) => void;
  /** Called when a batch flushes with merged result text */
  onBatchResult: (result: MergedBatchResult) => void;
  /** BatchCollector idle timeout (ms) */
  idleTimeoutMs?: number;
  /** BatchCollector max timeout (ms) */
  maxTimeoutMs?: number;
  /** BatchCollector stream-end debounce (ms) */
  streamEndDebounceMs?: number;
}

// ---------------------------------------------------------------------------
// BatchAwareHandler
// ---------------------------------------------------------------------------

export class BatchAwareHandler {
  private collector: BatchCollector;
  private readonly onSingleResult: (detail: ResultDetail) => void;
  private readonly onBatchResult: (result: MergedBatchResult) => void;
  /** Maps callId → batchId for active (unflushed) batches */
  private callToBatch = new Map<string, string>();

  constructor(options: BatchAwareHandlerOptions) {
    this.onSingleResult = options.onSingleResult;
    this.onBatchResult = options.onBatchResult;

    this.collector = new BatchCollector({
      onFlush: (flushResult) => this.handleFlush(flushResult),
      idleTimeoutMs: options.idleTimeoutMs,
      maxTimeoutMs: options.maxTimeoutMs,
      streamEndDebounceMs: options.streamEndDebounceMs,
    });
  }

  /**
   * Register a batch of expected call IDs.
   * Must be called before results arrive for those callIds.
   */
  registerBatch(batchId: string, expectedCallIds: string[], orderedCallIds: string[]): void {
    this.collector.registerBatch(batchId, expectedCallIds, orderedCallIds);
    for (const callId of expectedCallIds) {
      this.callToBatch.set(callId, batchId);
    }
  }

  /**
   * Route a tool execution result.
   * - If callId is in an active batch → collector
   * - Otherwise → onSingleResult
   */
  handleResult(detail: ResultDetail): void {
    const callId = detail.callId;

    if (callId && this.callToBatch.has(callId)) {
      const batchId = this.callToBatch.get(callId)!;
      this.collector.addResult(batchId, {
        callId,
        functionName: detail.functionName ?? 'unknown',
        result: detail.result ?? '',
        status: detail.status ?? 'success',
      });
    } else {
      this.onSingleResult(detail);
    }
  }

  /**
   * Check if a callId belongs to an active (unflushed) batch.
   */
  isBatchedCall(callId: string): boolean {
    return this.callToBatch.has(callId);
  }

  /**
   * Signal that the stream/message has ended for a batch.
   */
  markStreamEnded(batchId: string): void {
    this.collector.markStreamEnded(batchId);
  }

  /**
   * Clean up all timers and state.
   */
  dispose(): void {
    this.collector.dispose();
    this.callToBatch.clear();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private handleFlush(flushResult: BatchFlushResult): void {
    // Remove flushed callIds from mapping
    for (const r of flushResult.results) {
      this.callToBatch.delete(r.callId);
    }
    // Also clean up any expected callIds that didn't produce results
    // (they're no longer in active batch either)
    for (const [callId, batchId] of this.callToBatch) {
      if (batchId === flushResult.batchId) {
        this.callToBatch.delete(callId);
      }
    }

    const mergedText = this.mergeResults(flushResult.results);

    this.onBatchResult({
      batchId: flushResult.batchId,
      mergedText,
      callCount: flushResult.results.length,
      flushReason: flushResult.flushReason,
    });
  }

  /**
   * Merge batch results into a single text block for insertion.
   * Each result is formatted using the existing formatFunctionResult() XML format.
   */
  private mergeResults(results: BatchCallResult[]): string {
    const header = `Tool execution results (${results.length} calls):\n\n`;
    const blocks = results.map(r =>
      formatFunctionResult({
        callId: r.callId,
        name: r.functionName,
        status: r.status,
        result: r.result,
      }),
    );
    return header + blocks.join('\n\n');
  }
}
