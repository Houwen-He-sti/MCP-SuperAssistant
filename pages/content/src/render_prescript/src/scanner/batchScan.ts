/**
 * Phase 2: ToolCallBatch types and scanAssistantMessage()
 *
 * Groups individual function-call codeblocks by their parent assistant message,
 * producing ToolCallBatch objects for downstream batch collection (Phase 3).
 *
 * Design constraints:
 * - Core parsers are unchanged — grouping is purely an outer-layer concern
 * - ChatGPT: uses data-message-author-role="assistant" + data-message-id
 * - Notion / others: falls back to synthetic grouping or single-call batches
 * - 1 codeblock = 1 call invariant is maintained
 */

import type { ParsedFunctionCall } from '../core/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single tool call within a batch, linking the parsed call to its DOM element.
 */
export interface ToolCall {
  /** Parsed function call data (name, callId, parameters, etc.) */
  parsed: ParsedFunctionCall;
  /** The DOM element (pre/code block) containing this call */
  blockElement: HTMLElement;
  /** Extension-assigned block ID (data-block-id) */
  blockId: string;
}

/**
 * A group of tool calls originating from the same assistant message.
 * Produced by scanAssistantMessage(); consumed by Phase 3 BatchCollector.
 */
export interface ToolCallBatch {
  /** Unique batch ID — typically derived from sourceMessageId */
  batchId: string;
  /** Identifier for the assistant message (data-message-id, or synthetic) */
  sourceMessageId: string;
  /** Detection source */
  source: 'dom' | 'stream';
  /** Ordered list of tool calls in this batch */
  calls: ToolCall[];
  /** Expected call IDs in original order — used by BatchCollector flush logic */
  expectedCallIds: string[];
  /** Call IDs in original DOM order — preserved for result ordering */
  orderedCallIds: string[];
}

// ---------------------------------------------------------------------------
// Message boundary detection
// ---------------------------------------------------------------------------

/**
 * Stable synthetic ID map for assistant message elements that lack an explicit ID.
 * Keyed by DOM element reference so the same element always gets the same ID.
 */
const syntheticIdMap = new WeakMap<Element, string>();
let syntheticIdCounter = 0;

function getOrCreateSyntheticId(element: Element): string {
  let id = syntheticIdMap.get(element);
  if (!id) {
    id = `synthetic-msg-${++syntheticIdCounter}`;
    syntheticIdMap.set(element, id);
  }
  return id;
}

/**
 * Find the assistant message container for a given block element.
 * Returns { element, messageId } or null if not inside a recognized container.
 */
export function findAssistantMessageContainer(
  block: HTMLElement,
): { element: Element; messageId: string } | null {
  const msg = block.closest('[data-message-author-role="assistant"]');
  if (!msg) return null;

  const messageId =
    msg.getAttribute('data-message-id') ??
    msg.getAttribute('data-testid') ??
    // Fallback: assign a stable synthetic ID per element instance
    getOrCreateSyntheticId(msg);

  return { element: msg, messageId };
}

// ---------------------------------------------------------------------------
// scanAssistantMessage
// ---------------------------------------------------------------------------

/**
 * Given a list of individually-detected ToolCalls (from the existing per-block
 * render pipeline), group them into ToolCallBatch objects by assistant message.
 *
 * Calls sharing the same assistant message container become one batch.
 * Calls without a recognized container each get their own single-call batch.
 *
 * @param calls – ToolCall objects detected by the existing scanner pipeline
 * @returns Array of ToolCallBatch (one per distinct assistant message)
 */
export function scanAssistantMessage(calls: ToolCall[]): ToolCallBatch[] {
  if (calls.length === 0) return [];

  // Group by messageId
  const groups = new Map<string, ToolCall[]>();
  const messageOrder: string[] = []; // preserve first-seen order

  for (const call of calls) {
    const container = findAssistantMessageContainer(call.blockElement);
    const messageId = container?.messageId ?? `synthetic-${call.blockId}`;

    let group = groups.get(messageId);
    if (!group) {
      group = [];
      groups.set(messageId, group);
      messageOrder.push(messageId);
    }
    group.push(call);
  }

  // Build batches in first-seen order
  const batches: ToolCallBatch[] = [];
  for (const messageId of messageOrder) {
    const group = groups.get(messageId)!;
    const callIds = group.map(c => c.parsed.callId);
    batches.push({
      batchId: `batch-${messageId}`,
      sourceMessageId: messageId,
      source: 'dom',
      calls: group,
      expectedCallIds: callIds,
      orderedCallIds: callIds,
    });
  }

  return batches;
}

// ---------------------------------------------------------------------------
// Dedup key helper
// ---------------------------------------------------------------------------

/**
 * Compute a deduplication key for a tool call within a batch.
 * Key = sourceMessageId + callId — prevents re-execution when MutationObserver
 * re-scans the same assistant message.
 */
export function getToolCallDedupeKey(
  sourceMessageId: string,
  callId: string,
): string {
  return `${sourceMessageId}::${callId}`;
}
