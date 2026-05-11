/**
 * Phase 2 TDD: Tests for batchScan.ts
 *
 * Tests scanAssistantMessage() grouping logic and findAssistantMessageContainer().
 * Uses minimal DOM stubs — no real browser needed.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  findAssistantMessageContainer,
  scanAssistantMessage,
  type ToolCall,
  type ToolCallBatch,
} from './batchScan.ts';

// ---------------------------------------------------------------------------
// DOM stub helpers
// ---------------------------------------------------------------------------

/** Minimal DOM element stub for testing */
function makeElement(attrs: Record<string, string> = {}, parent?: any): any {
  const el: any = {
    _attrs: { ...attrs },
    _parent: parent ?? null,
    getAttribute(name: string) { return this._attrs[name] ?? null; },
    closest(selector: string) {
      // Simple closest() stub: walk up parents matching selector
      let current: any = this;
      while (current) {
        if (matchesSelector(current, selector)) return current;
        current = current._parent;
      }
      return null;
    },
  };
  return el;
}

function matchesSelector(el: any, selector: string): boolean {
  // Parse simple attribute selectors like [data-message-author-role="assistant"]
  const attrMatch = selector.match(/\[([^=]+)="([^"]+)"\]/);
  if (attrMatch) {
    return el.getAttribute(attrMatch[1]) === attrMatch[2];
  }
  return false;
}

function makeToolCall(
  callId: string,
  blockId: string,
  blockElement: any,
): ToolCall {
  return {
    parsed: {
      format: 'json',
      functionName: `tool_${callId}`,
      callId,
      parameters: {},
      isComplete: true,
      isExecutable: true,
      rawContent: '',
    },
    blockElement,
    blockId,
  };
}

function makeAssistantMessage(messageId: string) {
  return makeElement({
    'data-message-author-role': 'assistant',
    'data-message-id': messageId,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('findAssistantMessageContainer', () => {
  it('returns null for block not inside assistant message', () => {
    const block = makeElement({});
    assert.equal(findAssistantMessageContainer(block), null);
  });

  it('finds assistant message container with data-message-id', () => {
    const msg = makeAssistantMessage('msg-123');
    const block = makeElement({ 'data-block-id': 'b1' }, msg);
    const result = findAssistantMessageContainer(block);
    assert.notEqual(result, null);
    assert.equal(result!.messageId, 'msg-123');
    assert.equal(result!.element, msg);
  });

  it('uses data-testid fallback when data-message-id is absent', () => {
    const msg = makeElement({
      'data-message-author-role': 'assistant',
      'data-testid': 'conv-turn-42',
    });
    const block = makeElement({}, msg);
    const result = findAssistantMessageContainer(block);
    assert.notEqual(result, null);
    assert.equal(result!.messageId, 'msg-conv-turn-42');
  });
});

describe('scanAssistantMessage', () => {
  it('returns empty array for empty input', () => {
    assert.deepEqual(scanAssistantMessage([]), []);
  });

  it('groups two calls in same assistant message into one batch', () => {
    const msg = makeAssistantMessage('msg-A');
    const block1 = makeElement({ 'data-block-id': 'b1' }, msg);
    const block2 = makeElement({ 'data-block-id': 'b2' }, msg);
    const call1 = makeToolCall('c1', 'b1', block1);
    const call2 = makeToolCall('c2', 'b2', block2);

    const batches = scanAssistantMessage([call1, call2]);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].sourceMessageId, 'msg-A');
    assert.deepEqual(batches[0].expectedCallIds, ['c1', 'c2']);
    assert.deepEqual(batches[0].orderedCallIds, ['c1', 'c2']);
    assert.equal(batches[0].calls.length, 2);
    assert.equal(batches[0].source, 'dom');
  });

  it('splits calls from different messages into separate batches', () => {
    const msgA = makeAssistantMessage('msg-A');
    const msgB = makeAssistantMessage('msg-B');
    const call1 = makeToolCall('c1', 'b1', makeElement({}, msgA));
    const call2 = makeToolCall('c2', 'b2', makeElement({}, msgB));

    const batches = scanAssistantMessage([call1, call2]);
    assert.equal(batches.length, 2);
    assert.equal(batches[0].sourceMessageId, 'msg-A');
    assert.equal(batches[1].sourceMessageId, 'msg-B');
  });

  it('creates synthetic single-call batch for block without message container', () => {
    const block = makeElement({ 'data-block-id': 'orphan-1' });
    const call = makeToolCall('c1', 'orphan-1', block);

    const batches = scanAssistantMessage([call]);
    assert.equal(batches.length, 1);
    assert.ok(batches[0].sourceMessageId.startsWith('synthetic-'));
    assert.deepEqual(batches[0].expectedCallIds, ['c1']);
  });

  it('preserves call order within a batch', () => {
    const msg = makeAssistantMessage('msg-X');
    const calls = ['c3', 'c1', 'c2'].map((id, i) =>
      makeToolCall(id, `b${i}`, makeElement({}, msg))
    );

    const batches = scanAssistantMessage(calls);
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].orderedCallIds, ['c3', 'c1', 'c2']);
  });

  it('batchId is derived from sourceMessageId', () => {
    const msg = makeAssistantMessage('msg-42');
    const call = makeToolCall('c1', 'b1', makeElement({}, msg));
    const batches = scanAssistantMessage([call]);
    assert.equal(batches[0].batchId, 'batch-msg-42');
  });

  it('handles mixed: some calls in message, some orphaned', () => {
    const msg = makeAssistantMessage('msg-M');
    const call1 = makeToolCall('c1', 'b1', makeElement({}, msg));
    const call2 = makeToolCall('c2', 'b2', makeElement({})); // orphan
    const call3 = makeToolCall('c3', 'b3', makeElement({}, msg));

    const batches = scanAssistantMessage([call1, call2, call3]);
    assert.equal(batches.length, 2);
    // First batch: msg-M with c1 and c3
    assert.equal(batches[0].sourceMessageId, 'msg-M');
    assert.deepEqual(batches[0].expectedCallIds, ['c1', 'c3']);
    // Second batch: synthetic orphan
    assert.ok(batches[1].sourceMessageId.startsWith('synthetic-'));
    assert.deepEqual(batches[1].expectedCallIds, ['c2']);
  });
});
