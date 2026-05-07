/**
 * Unit tests for interceptorBridge.ts validation logic
 *
 * Tests message validation, security checks, and event routing.
 * Since interceptorBridge.ts imports @extension/shared (can't resolve in Node),
 * we test the security-critical validation logic by extracting it here.
 *
 * Run: node --test --experimental-strip-types interceptorBridge.test.ts
 * (from render_prescript/src/stream/ directory)
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// Protocol constants (must match interceptorBridge.ts and interceptorMain.ts)
const CHANNEL = 'mcp-superassistant.stream';
const DIRECTION = 'main-to-isolated';
const PROTOCOL_VERSION = 1;
const SOURCE_ID = 'notion-main-fetch-interceptor';
const VALID_EVENT_TYPES = new Set([
  'stream_start', 'stream_end', 'stream_error',
  'function_call', 'stream_cutoff', 'stream_drain_complete',
]);
const MAX_RAW_LINE_LENGTH = 65536;

// Re-implement validation functions (must stay in sync with interceptorBridge.ts)
function isValidEnvelope(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  return (
    obj.channel === CHANNEL &&
    obj.direction === DIRECTION &&
    obj.version === PROTOCOL_VERSION &&
    obj.source === SOURCE_ID &&
    obj.event !== null &&
    typeof obj.event === 'object'
  );
}

function isValidStreamEvent(raw: Record<string, unknown>): boolean {
  const type = raw.type;
  if (typeof type !== 'string' || !VALID_EVENT_TYPES.has(type)) return false;

  const streamId = raw.streamId;
  if (typeof streamId !== 'string' || streamId.length === 0 || streamId.length > 100) return false;

  switch (type) {
    case 'stream_start':
    case 'stream_end':
    case 'stream_error':
      return typeof raw.url === 'string';

    case 'function_call':
      return typeof raw.rawLine === 'string' && raw.rawLine.length <= MAX_RAW_LINE_LENGTH;

    case 'stream_cutoff':
    case 'stream_drain_complete':
      return true;

    default:
      return false;
  }
}

function shouldAcceptMessage(
  source: unknown, origin: string,
  windowRef: unknown, windowOrigin: string,
  data: unknown
): boolean {
  if (source !== windowRef) return false;
  if (origin !== windowOrigin) return false;
  if (!isValidEnvelope(data)) return false;
  const envelope = data as { event: Record<string, unknown> };
  return isValidStreamEvent(envelope.event);
}

// ============================================================================
// Tests
// ============================================================================

describe('interceptorBridge validation', () => {
  const mockWindow = {};
  const ORIGIN = 'https://www.notion.so';

  function validData(event: Record<string, unknown>) {
    return {
      channel: CHANNEL,
      direction: DIRECTION,
      version: PROTOCOL_VERSION,
      source: SOURCE_ID,
      event,
    };
  }

  describe('security — rejects invalid messages', () => {
    test('rejects wrong source window', () => {
      const data = validData({ type: 'stream_start', streamId: 'x', url: 'u' });
      assert.equal(shouldAcceptMessage({}, ORIGIN, mockWindow, ORIGIN, data), false);
    });

    test('rejects wrong origin', () => {
      const data = validData({ type: 'stream_start', streamId: 'x', url: 'u' });
      assert.equal(shouldAcceptMessage(mockWindow, 'https://evil.com', mockWindow, ORIGIN, data), false);
    });

    test('rejects wrong channel', () => {
      const data = { channel: 'bad', direction: DIRECTION, version: PROTOCOL_VERSION, source: SOURCE_ID, event: { type: 'stream_start', streamId: 'x', url: 'u' } };
      assert.equal(shouldAcceptMessage(mockWindow, ORIGIN, mockWindow, ORIGIN, data), false);
    });

    test('rejects wrong version', () => {
      const data = { channel: CHANNEL, direction: DIRECTION, version: 99, source: SOURCE_ID, event: { type: 'stream_start', streamId: 'x', url: 'u' } };
      assert.equal(shouldAcceptMessage(mockWindow, ORIGIN, mockWindow, ORIGIN, data), false);
    });

    test('rejects wrong source id', () => {
      const data = { channel: CHANNEL, direction: DIRECTION, version: PROTOCOL_VERSION, source: 'bad', event: { type: 'stream_start', streamId: 'x', url: 'u' } };
      assert.equal(shouldAcceptMessage(mockWindow, ORIGIN, mockWindow, ORIGIN, data), false);
    });

    test('rejects invalid event type', () => {
      const data = validData({ type: 'execute_tool', streamId: 'x', url: 'u' });
      assert.equal(shouldAcceptMessage(mockWindow, ORIGIN, mockWindow, ORIGIN, data), false);
    });

    test('rejects oversized rawLine in function_call', () => {
      const data = validData({ type: 'function_call', streamId: 'x', rawLine: 'a'.repeat(100000) });
      assert.equal(shouldAcceptMessage(mockWindow, ORIGIN, mockWindow, ORIGIN, data), false);
    });

    test('rejects empty streamId', () => {
      const data = validData({ type: 'stream_start', streamId: '', url: 'u' });
      assert.equal(shouldAcceptMessage(mockWindow, ORIGIN, mockWindow, ORIGIN, data), false);
    });

    test('rejects too-long streamId', () => {
      const data = validData({ type: 'stream_start', streamId: 'a'.repeat(101), url: 'u' });
      assert.equal(shouldAcceptMessage(mockWindow, ORIGIN, mockWindow, ORIGIN, data), false);
    });

    test('rejects null data', () => {
      assert.equal(shouldAcceptMessage(mockWindow, ORIGIN, mockWindow, ORIGIN, null), false);
    });

    test('rejects non-object data', () => {
      assert.equal(shouldAcceptMessage(mockWindow, ORIGIN, mockWindow, ORIGIN, 'hello'), false);
    });

    test('rejects null event in envelope', () => {
      const data = { channel: CHANNEL, direction: DIRECTION, version: PROTOCOL_VERSION, source: SOURCE_ID, event: null };
      assert.equal(shouldAcceptMessage(mockWindow, ORIGIN, mockWindow, ORIGIN, data), false);
    });

    test('rejects old-style __MCP_SA_STREAM__ messages', () => {
      const data = { type: '__MCP_SA_STREAM__', event: { type: 'stream_cutoff', streamId: 'fake' } };
      assert.equal(shouldAcceptMessage(mockWindow, ORIGIN, mockWindow, ORIGIN, data), false);
    });

    test('rejects stream_start without url', () => {
      const data = validData({ type: 'stream_start', streamId: 'x' });
      assert.equal(shouldAcceptMessage(mockWindow, ORIGIN, mockWindow, ORIGIN, data), false);
    });

    test('rejects function_call without rawLine', () => {
      const data = validData({ type: 'function_call', streamId: 'x' });
      assert.equal(shouldAcceptMessage(mockWindow, ORIGIN, mockWindow, ORIGIN, data), false);
    });
  });

  describe('security — accepts valid messages', () => {
    test('accepts stream_start', () => {
      const data = validData({ type: 'stream_start', streamId: 'notion-ai-1', url: 'https://www.notion.so/api/v3/runInferenceTranscript' });
      assert.equal(shouldAcceptMessage(mockWindow, ORIGIN, mockWindow, ORIGIN, data), true);
    });

    test('accepts stream_end', () => {
      const data = validData({ type: 'stream_end', streamId: 'notion-ai-1', url: 'u', totalChunks: 15 });
      assert.equal(shouldAcceptMessage(mockWindow, ORIGIN, mockWindow, ORIGIN, data), true);
    });

    test('accepts stream_error', () => {
      const data = validData({ type: 'stream_error', streamId: 'notion-ai-1', url: 'u' });
      assert.equal(shouldAcceptMessage(mockWindow, ORIGIN, mockWindow, ORIGIN, data), true);
    });

    test('accepts function_call', () => {
      const data = validData({
        type: 'function_call', streamId: 'notion-ai-2',
        rawLine: '{"type":"function_call","name":"mcp__search","arguments":"{}"}',
        identity: { name: 'mcp__search', callId: 'call_123', arguments: '{}' },
        chunkIndex: 9, elapsedMs: 1500,
      });
      assert.equal(shouldAcceptMessage(mockWindow, ORIGIN, mockWindow, ORIGIN, data), true);
    });

    test('accepts stream_cutoff', () => {
      const data = validData({
        type: 'stream_cutoff', streamId: 'notion-ai-3',
        cutoffChunkIndex: 10, elapsedMs: 2000,
        identity: { name: 'git_commit', callId: 'c1', arguments: '{}' },
        reason: 'function_call_detected', forwardedTriggerChunk: true, mode: 'drain-drop',
      });
      assert.equal(shouldAcceptMessage(mockWindow, ORIGIN, mockWindow, ORIGIN, data), true);
    });

    test('accepts stream_drain_complete', () => {
      const data = validData({
        type: 'stream_drain_complete', streamId: 'notion-ai-4',
        droppedChunks: 15, droppedBytes: 8192, drainDurationMs: 500, timedOut: false,
      });
      assert.equal(shouldAcceptMessage(mockWindow, ORIGIN, mockWindow, ORIGIN, data), true);
    });

    test('accepts rawLine at exactly 64KB limit', () => {
      const data = validData({
        type: 'function_call', streamId: 'x',
        rawLine: 'a'.repeat(MAX_RAW_LINE_LENGTH),
        identity: null, chunkIndex: 1, elapsedMs: 10,
      });
      assert.equal(shouldAcceptMessage(mockWindow, ORIGIN, mockWindow, ORIGIN, data), true);
    });
  });

  describe('attack scenarios', () => {
    test('old-style postMessage attack is blocked', () => {
      const attack = { type: '__MCP_SA_STREAM__', event: { type: 'stream_cutoff', streamId: 'fake', identity: { name: 'rm_rf' } } };
      assert.equal(shouldAcceptMessage(mockWindow, ORIGIN, mockWindow, ORIGIN, attack), false);
    });

    test('cross-origin attack with valid envelope is blocked', () => {
      const data = validData({ type: 'stream_cutoff', streamId: 'x' });
      assert.equal(shouldAcceptMessage(mockWindow, 'https://evil.notion.so', mockWindow, ORIGIN, data), false);
    });

    test('wrong window with valid envelope is blocked', () => {
      const data = validData({ type: 'stream_start', streamId: 'x', url: 'u' });
      assert.equal(shouldAcceptMessage({}, ORIGIN, mockWindow, ORIGIN, data), false);
    });
  });
});
