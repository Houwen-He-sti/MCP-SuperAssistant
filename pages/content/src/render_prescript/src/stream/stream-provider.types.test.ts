/**
 * Gate 6-R-B: StreamProviderAdapter type conformance tests.
 *
 * These tests verify that the interfaces are implementable and
 * that mock adapters conform to the contract. No runtime behavior
 * is tested — this validates the type definitions themselves.
 *
 * Run: node --test --experimental-strip-types stream-provider.types.test.ts
 * (from render_prescript/src/stream/ directory)
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type {
  InterceptRequestContext,
  StreamChunkContent,
  StreamFormat,
  StreamProviderAdapter,
  StreamProviderRegistration,
} from './stream-provider.types.ts';

// ============================================================================
// Mock Adapters — prove the interface is implementable
// ============================================================================

/** Mock Notion stream provider — based on real interceptorMain.ts behavior */
class MockNotionStreamProvider implements StreamProviderAdapter {
  readonly providerId = 'notion';
  readonly streamFormat: StreamFormat = 'ndjson';
  private counter = 0;

  shouldIntercept(ctx: InterceptRequestContext): boolean {
    try {
      const url = new URL(ctx.url);
      return url.pathname === '/api/v3/runInferenceTranscript';
    } catch {
      return false;
    }
  }

  parseChunk(raw: string): StreamChunkContent[] {
    const lines = raw.split('\n');
    const results: StreamChunkContent[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      results.push({ text: trimmed, complete: true });
    }
    return results;
  }

  createStreamId(): string {
    return `notion-ai-${++this.counter}`;
  }

  isEligibleContentType(contentType: string): boolean {
    return contentType.includes('ndjson') || contentType.includes('json');
  }
}

/** Mock ChatGPT SSE provider — demonstrates SSE format support */
class MockChatGPTStreamProvider implements StreamProviderAdapter {
  readonly providerId = 'chatgpt';
  readonly streamFormat: StreamFormat = 'sse';
  private counter = 0;

  shouldIntercept(ctx: InterceptRequestContext): boolean {
    try {
      const url = new URL(ctx.url);
      return url.pathname.includes('/backend-api/conversation');
    } catch {
      return false;
    }
  }

  parseChunk(raw: string): StreamChunkContent[] {
    const lines = raw.split('\n');
    const results: StreamChunkContent[] = [];
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      results.push({ text: data, complete: true });
    }
    return results;
  }

  createStreamId(): string {
    return `chatgpt-${++this.counter}`;
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('StreamProviderAdapter types (Gate 6-R-B)', () => {
  describe('interface conformance', () => {
    test('MockNotionStreamProvider satisfies StreamProviderAdapter', () => {
      const adapter: StreamProviderAdapter = new MockNotionStreamProvider();
      assert.equal(adapter.providerId, 'notion');
      assert.equal(adapter.streamFormat, 'ndjson');
    });

    test('MockChatGPTStreamProvider satisfies StreamProviderAdapter', () => {
      const adapter: StreamProviderAdapter = new MockChatGPTStreamProvider();
      assert.equal(adapter.providerId, 'chatgpt');
      assert.equal(adapter.streamFormat, 'sse');
    });
  });

  describe('shouldIntercept', () => {
    test('Notion adapter intercepts runInferenceTranscript', () => {
      const adapter = new MockNotionStreamProvider();
      const ctx: InterceptRequestContext = {
        url: 'https://www.notion.so/api/v3/runInferenceTranscript',
      };
      assert.equal(adapter.shouldIntercept(ctx), true);
    });

    test('Notion adapter ignores other endpoints', () => {
      const adapter = new MockNotionStreamProvider();
      const ctx: InterceptRequestContext = {
        url: 'https://www.notion.so/api/v3/getPage',
      };
      assert.equal(adapter.shouldIntercept(ctx), false);
    });

    test('ChatGPT adapter intercepts conversation API', () => {
      const adapter = new MockChatGPTStreamProvider();
      const ctx: InterceptRequestContext = {
        url: 'https://chatgpt.com/backend-api/conversation',
      };
      assert.equal(adapter.shouldIntercept(ctx), true);
    });

    test('handles invalid URLs gracefully', () => {
      const adapter = new MockNotionStreamProvider();
      const ctx: InterceptRequestContext = { url: 'not-a-url' };
      assert.equal(adapter.shouldIntercept(ctx), false);
    });
  });

  describe('parseChunk', () => {
    test('Notion NDJSON: splits lines and trims', () => {
      const adapter = new MockNotionStreamProvider();
      const raw = '{"type":"text","value":"hello"}\n{"type":"function_call","name":"mcp__search"}\n';
      const results = adapter.parseChunk(raw);
      assert.equal(results.length, 2);
      assert.equal(results[0].text, '{"type":"text","value":"hello"}');
      assert.equal(results[0].complete, true);
      assert.equal(results[1].text, '{"type":"function_call","name":"mcp__search"}');
    });

    test('Notion NDJSON: skips empty lines', () => {
      const adapter = new MockNotionStreamProvider();
      const raw = '\n  \n{"data":"test"}\n\n';
      const results = adapter.parseChunk(raw);
      assert.equal(results.length, 1);
      assert.equal(results[0].text, '{"data":"test"}');
    });

    test('ChatGPT SSE: strips data prefix', () => {
      const adapter = new MockChatGPTStreamProvider();
      const raw = 'data: {"message":{"content":"hello"}}\ndata: [DONE]\n';
      const results = adapter.parseChunk(raw);
      assert.equal(results.length, 1);
      assert.equal(results[0].text, '{"message":{"content":"hello"}}');
    });

    test('ChatGPT SSE: handles empty chunk', () => {
      const adapter = new MockChatGPTStreamProvider();
      const results = adapter.parseChunk('');
      assert.equal(results.length, 0);
    });
  });

  describe('createStreamId', () => {
    test('generates unique IDs per call', () => {
      const adapter = new MockNotionStreamProvider();
      const id1 = adapter.createStreamId();
      const id2 = adapter.createStreamId();
      assert.notEqual(id1, id2);
      assert.match(id1, /^notion-ai-\d+$/);
    });
  });

  describe('isEligibleContentType (optional)', () => {
    test('Notion accepts ndjson', () => {
      const adapter = new MockNotionStreamProvider();
      assert.equal(adapter.isEligibleContentType!('application/x-ndjson'), true);
    });

    test('Notion accepts json', () => {
      const adapter = new MockNotionStreamProvider();
      assert.equal(adapter.isEligibleContentType!('application/json'), true);
    });

    test('Notion rejects html', () => {
      const adapter = new MockNotionStreamProvider();
      assert.equal(adapter.isEligibleContentType!('text/html'), false);
    });

    test('optional method: ChatGPT adapter has no isEligibleContentType', () => {
      const adapter: StreamProviderAdapter = new MockChatGPTStreamProvider();
      assert.equal(adapter.isEligibleContentType, undefined);
    });
  });

  describe('StreamProviderRegistration', () => {
    test('can register a provider with hostnames', () => {
      const registration: StreamProviderRegistration = {
        adapter: new MockNotionStreamProvider(),
        hostnames: ['notion.so', 'www.notion.so'],
        priority: 10,
      };
      assert.equal(registration.adapter.providerId, 'notion');
      assert.ok(registration.hostnames.includes('notion.so'));
      assert.equal(registration.priority, 10);
    });

    test('supports RegExp hostnames', () => {
      const registration: StreamProviderRegistration = {
        adapter: new MockChatGPTStreamProvider(),
        hostnames: [/chatgpt\.com$/, /chat\.openai\.com$/],
      };
      assert.ok(registration.hostnames[0] instanceof RegExp);
      assert.equal((registration.hostnames[0] as RegExp).test('chatgpt.com'), true);
    });
  });
});
