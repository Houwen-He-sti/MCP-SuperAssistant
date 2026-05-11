/**
 * Phase 3: BatchCollector — collects tool execution results for a batch
 * and flushes them when all expected calls have settled (or timeout).
 *
 * Flush conditions (priority order):
 * 1. All expectedCallIds settled → flush immediately
 * 2. Idle timeout (no new results for idleTimeoutMs) → flush partial
 * 3. Max timeout (maxTimeoutMs since batch registration) → force flush
 *
 * Single-call batches flush immediately with no extra delay (backward compat).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BatchCallResult {
  callId: string;
  functionName: string;
  result: string;
  status: 'success' | 'error';
}

export interface BatchFlushResult {
  batchId: string;
  results: BatchCallResult[];
  flushReason: 'all_settled' | 'idle_timeout' | 'max_timeout';
}

export interface BatchCollectorOptions {
  /** Called when a batch is ready to be flushed */
  onFlush: (result: BatchFlushResult) => void;
  /** Milliseconds of no new results before partial flush (default: 3000) */
  idleTimeoutMs?: number;
  /** Hard maximum milliseconds before force flush (default: 15000) */
  maxTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Internal batch context
// ---------------------------------------------------------------------------

interface BatchContext {
  batchId: string;
  expectedCallIds: string[];
  orderedCallIds: string[];
  results: Map<string, BatchCallResult>;
  startTime: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  maxTimer: ReturnType<typeof setTimeout> | null;
  flushed: boolean;
}

// ---------------------------------------------------------------------------
// BatchCollector
// ---------------------------------------------------------------------------

export class BatchCollector {
  private batches = new Map<string, BatchContext>();
  private readonly onFlush: (result: BatchFlushResult) => void;
  private readonly idleTimeoutMs: number;
  private readonly maxTimeoutMs: number;

  constructor(options: BatchCollectorOptions) {
    this.onFlush = options.onFlush;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 3000;
    this.maxTimeoutMs = options.maxTimeoutMs ?? 15000;
  }

  /**
   * Register a new batch expectation. Must be called before execution starts.
   */
  registerBatch(
    batchId: string,
    expectedCallIds: string[],
    orderedCallIds: string[],
  ): void {
    if (this.batches.has(batchId)) return; // idempotent

    const ctx: BatchContext = {
      batchId,
      expectedCallIds,
      orderedCallIds,
      results: new Map(),
      startTime: Date.now(),
      idleTimer: null,
      maxTimer: null,
      flushed: false,
    };

    // Set max timeout
    ctx.maxTimer = setTimeout(() => this.flush(ctx, 'max_timeout'), this.maxTimeoutMs);

    this.batches.set(batchId, ctx);
  }

  /**
   * Add a result for a call within a batch.
   * Triggers flush if all expected calls have settled.
   */
  addResult(batchId: string, result: BatchCallResult): void {
    const ctx = this.batches.get(batchId);
    if (!ctx || ctx.flushed) return;

    // Ignore duplicate
    if (ctx.results.has(result.callId)) return;

    ctx.results.set(result.callId, result);

    // Reset idle timer on each new result
    if (ctx.idleTimer !== null) {
      clearTimeout(ctx.idleTimer);
      ctx.idleTimer = null;
    }

    // Check if all expected calls are settled
    const allSettled = ctx.expectedCallIds.every(id => ctx.results.has(id));
    if (allSettled) {
      this.flush(ctx, 'all_settled');
      return;
    }

    // Start idle timer for partial flush
    ctx.idleTimer = setTimeout(() => this.flush(ctx, 'idle_timeout'), this.idleTimeoutMs);
  }

  /**
   * Check if a batch is pending (registered but not yet flushed).
   */
  hasPendingBatch(batchId: string): boolean {
    const ctx = this.batches.get(batchId);
    return ctx !== undefined && !ctx.flushed;
  }

  /**
   * Clean up all timers and state.
   */
  dispose(): void {
    for (const ctx of this.batches.values()) {
      this.clearTimers(ctx);
    }
    this.batches.clear();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private flush(ctx: BatchContext, reason: BatchFlushResult['flushReason']): void {
    if (ctx.flushed) return;
    ctx.flushed = true;
    this.clearTimers(ctx);

    // Order results by orderedCallIds
    const orderedResults: BatchCallResult[] = [];
    for (const callId of ctx.orderedCallIds) {
      const result = ctx.results.get(callId);
      if (result) orderedResults.push(result);
    }
    // Include any results not in orderedCallIds (shouldn't happen, but defensive)
    for (const [callId, result] of ctx.results) {
      if (!ctx.orderedCallIds.includes(callId)) {
        orderedResults.push(result);
      }
    }

    this.onFlush({
      batchId: ctx.batchId,
      results: orderedResults,
      flushReason: reason,
    });

    // Clean up
    this.batches.delete(ctx.batchId);
  }

  private clearTimers(ctx: BatchContext): void {
    if (ctx.idleTimer !== null) {
      clearTimeout(ctx.idleTimer);
      ctx.idleTimer = null;
    }
    if (ctx.maxTimer !== null) {
      clearTimeout(ctx.maxTimer);
      ctx.maxTimer = null;
    }
  }
}
