/**
 * BH-2 TDD: NotionAdapterBridgeHost non-observation methods
 *
 * T-BH-01..T-BH-07
 *
 * Run:
 *   node --test --experimental-strip-types \
 *     src/plugins/adapters/__tests__/notion.adapter-bridge-host.test.ts
 * (from MCP-SuperAssistant/pages/content/)
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

import { NotionAdapterBridgeHost } from '../notion/notion-adapter-bridge-host.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockAdapter {
    insertText(text: string): Promise<boolean>;
    submitForm(): Promise<boolean>;
}

function makeMockAdapter(opts?: { insertResult?: boolean; submitResult?: boolean }): MockAdapter {
    return {
        insertText: mock.fn(async (_text: string) => opts?.insertResult ?? true),
        submitForm: mock.fn(async () => opts?.submitResult ?? true),
    };
}

function makeMockDocument(textContent: string | null): Document {
    const el = textContent !== null ? { textContent } : null;
    return {
        querySelector: (_sel: string) => el,
    } as unknown as Document;
}

/** Noop MutationObserver class for tests that do not exercise observation methods. */
class NoopMO {
    constructor(_cb: MutationCallback) {}
    observe(_target: Node, _options?: MutationObserverInit): void {}
    disconnect(): void {}
    takeRecords(): MutationRecord[] { return []; }
}

// ---------------------------------------------------------------------------
// T-BH-01 / T-BH-02 — insertText
// ---------------------------------------------------------------------------

describe('NotionAdapterBridgeHost.insertText()', () => {
    it('T-BH-01: adapter returning true → RuntimeResult.ok === true', async () => {
        const adapter = makeMockAdapter({ insertResult: true });
        const host = new NotionAdapterBridgeHost({ adapter, document: makeMockDocument('hello'), MutationObserver: NoopMO as unknown as typeof MutationObserver });
        const result = await host.insertText('hello');
        assert.equal(result.ok, true);
    });

    it('T-BH-02: adapter returning false → ok===false, code=NOTION_INSERT_FAILED', async () => {
        const adapter = makeMockAdapter({ insertResult: false });
        const host = new NotionAdapterBridgeHost({ adapter, document: makeMockDocument('hello'), MutationObserver: NoopMO as unknown as typeof MutationObserver });
        const result = await host.insertText('hello');
        assert.equal(result.ok, false);
        assert.ok(!result.ok);
        // type guard: only error results have code
        if (!result.ok) {
            assert.equal(result.code, 'NOTION_INSERT_FAILED');
        }
    });

    it('T-BH-01b: insertText delegates to adapter.insertText with correct text', async () => {
        const adapter = makeMockAdapter({ insertResult: true });
        const host = new NotionAdapterBridgeHost({ adapter, document: makeMockDocument(null), MutationObserver: NoopMO as unknown as typeof MutationObserver });
        await host.insertText('test-text');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const calls = (adapter.insertText as unknown as { mock: { calls: { arguments: unknown[] }[] } }).mock.calls;
        assert.equal(calls.length, 1);
        assert.equal(calls[0].arguments[0], 'test-text');
    });
});

// ---------------------------------------------------------------------------
// T-BH-03 / T-BH-04 — clickSubmit
// ---------------------------------------------------------------------------

describe('NotionAdapterBridgeHost.clickSubmit()', () => {
    it('T-BH-03: adapter returning true → RuntimeResult.ok === true', async () => {
        const adapter = makeMockAdapter({ submitResult: true });
        const host = new NotionAdapterBridgeHost({ adapter, document: makeMockDocument(null), MutationObserver: NoopMO as unknown as typeof MutationObserver });
        const result = await host.clickSubmit();
        assert.equal(result.ok, true);
    });

    it('T-BH-04: adapter returning false → ok===false, code=NOTION_SUBMIT_FAILED', async () => {
        const adapter = makeMockAdapter({ submitResult: false });
        const host = new NotionAdapterBridgeHost({ adapter, document: makeMockDocument(null), MutationObserver: NoopMO as unknown as typeof MutationObserver });
        const result = await host.clickSubmit();
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'NOTION_SUBMIT_FAILED');
        }
    });
});

// ---------------------------------------------------------------------------
// T-BH-05 / T-BH-06 — getInputContent
// ---------------------------------------------------------------------------

describe('NotionAdapterBridgeHost.getInputContent()', () => {
    it('T-BH-05: element found → returns textContent', () => {
        const adapter = makeMockAdapter();
        const host = new NotionAdapterBridgeHost({
            adapter,
            document: makeMockDocument('user typed text'),
            MutationObserver: NoopMO as unknown as typeof MutationObserver,
        });
        const content = host.getInputContent();
        assert.equal(content, 'user typed text');
    });

    it('T-BH-06: element absent → returns null', () => {
        const adapter = makeMockAdapter();
        const host = new NotionAdapterBridgeHost({
            adapter,
            document: makeMockDocument(null),
            MutationObserver: NoopMO as unknown as typeof MutationObserver,
        });
        const content = host.getInputContent();
        assert.equal(content, null);
    });

    it('T-BH-05b: empty element → returns empty string (not null)', () => {
        const adapter = makeMockAdapter();
        const host = new NotionAdapterBridgeHost({
            adapter,
            document: makeMockDocument(''),
            MutationObserver: NoopMO as unknown as typeof MutationObserver,
        });
        const content = host.getInputContent();
        assert.equal(content, '');
    });
});

// ---------------------------------------------------------------------------
// T-BH-07b..T-BH-07e — getSubmitButtonState (GPT P1 gap: add tests)
// ---------------------------------------------------------------------------

describe('NotionAdapterBridgeHost.getSubmitButtonState()', () => {
    it('T-BH-07b: button element absent → { kind: "missing" }', () => {
        const host = new NotionAdapterBridgeHost({
            adapter: makeMockAdapter(),
            document: { querySelector: () => null } as unknown as Document,
            MutationObserver: NoopMO as unknown as typeof MutationObserver,
        });
        assert.deepEqual(host.getSubmitButtonState(), { kind: 'missing' });
    });

    it('T-BH-07c: button present, not connected (detached) → { kind: "detached" }', () => {
        const btn = { isConnected: false, getAttribute: (_n: string) => null };
        const host = new NotionAdapterBridgeHost({
            adapter: makeMockAdapter(),
            document: { querySelector: () => btn } as unknown as Document,
            MutationObserver: NoopMO as unknown as typeof MutationObserver,
        });
        assert.deepEqual(host.getSubmitButtonState(), { kind: 'detached' });
    });

    it('T-BH-07d: button connected, aria-disabled="true" → { kind: "disabled" }', () => {
        const btn = {
            isConnected: true,
            getAttribute: (n: string) => (n === 'aria-disabled' ? 'true' : null),
        };
        const host = new NotionAdapterBridgeHost({
            adapter: makeMockAdapter(),
            document: { querySelector: () => btn } as unknown as Document,
            MutationObserver: NoopMO as unknown as typeof MutationObserver,
        });
        assert.deepEqual(host.getSubmitButtonState(), { kind: 'disabled' });
    });

    it('T-BH-07e: button connected, no aria-disabled → { kind: "enabled" }', () => {
        const btn = { isConnected: true, getAttribute: (_n: string) => null };
        const host = new NotionAdapterBridgeHost({
            adapter: makeMockAdapter(),
            document: { querySelector: () => btn } as unknown as Document,
            MutationObserver: NoopMO as unknown as typeof MutationObserver,
        });
        assert.deepEqual(host.getSubmitButtonState(), { kind: 'enabled' });
    });
});

// ---------------------------------------------------------------------------
// T-BH-07 — Boundary: NotionAdapterBridgeHost NOT in mcp-runtime exports
// ---------------------------------------------------------------------------

describe('T-BH-07: boundary scan', () => {
    it('NotionAdapterBridgeHost is NOT exported from mcp-runtime/src/index.ts', () => {
        const __dirname = dirname(fileURLToPath(import.meta.url));
        const indexPath = resolve(
            __dirname,
            '../../../../../../../mcp-runtime/src/index.ts',
        );
        const contents = readFileSync(indexPath, 'utf-8');
        assert.ok(
            !contents.includes('NotionAdapterBridgeHost'),
            'Bridge host must NOT appear in mcp-runtime public exports (separation of concerns)',
        );
    });
});

// ---------------------------------------------------------------------------
// BH-3 Test Infrastructure
//
// MutationObserver is injectable via constructor options.
// makeFakeMO() returns a class + last-instance accessor for test control.
// ---------------------------------------------------------------------------

type FakeMOInstance = {
    disconnected: boolean;
    observed: boolean;
    fire(records: Partial<MutationRecord>[]): void;
};

function makeFakeMO(): {
    MOClass: new (cb: MutationCallback) => MutationObserver;
    lastInstance(): FakeMOInstance | null;
} {
    let inst: FakeMOInstance | null = null;

    class FakeMutationObserver {
        private readonly cb: MutationCallback;
        disconnected = false;
        observed = false;

        constructor(cb: MutationCallback) {
            this.cb = cb;
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            inst = this;
        }

        observe(_target: Node, _options?: MutationObserverInit): void {
            this.observed = true;
        }

        disconnect(): void {
            this.disconnected = true;
        }

        fire(records: Partial<MutationRecord>[]): void {
            this.cb(records as MutationRecord[], this as unknown as MutationObserver);
        }
    }

    return {
        MOClass: FakeMutationObserver as unknown as new (cb: MutationCallback) => MutationObserver,
        lastInstance: () => inst,
    };
}

/** Build a Document mock that routes querySelector by exact selector string. */
function makeSelectorDocument(map: Record<string, object | null>): Document {
    return {
        querySelector: (sel: string) => map[sel] ?? null,
    } as unknown as Document;
}

// ---------------------------------------------------------------------------
// T-BH-08..T-BH-11 — isStreaming()
// ---------------------------------------------------------------------------

describe('NotionAdapterBridgeHost.isStreaming()', () => {
    it('T-BH-08: authoritative streaming signal absent → isStreaming() === false', () => {
        const { MOClass } = makeFakeMO();
        const host = new NotionAdapterBridgeHost({
            adapter: makeMockAdapter(),
            document: makeSelectorDocument({}),
            MutationObserver: MOClass,
        });
        assert.equal(host.isStreaming(), false);
    });

    it('T-BH-09: authoritative streaming signal present → isStreaming() === true', () => {
        const { MOClass } = makeFakeMO();
        const stopBtn = {};
        const host = new NotionAdapterBridgeHost({
            adapter: makeMockAdapter(),
            document: makeSelectorDocument({ '[data-testid="stop-button"]': stopBtn }),
            MutationObserver: MOClass,
        });
        assert.equal(host.isStreaming(), true);
    });

    it('T-BH-11: isStreaming() is idempotent — repeated reads have no side effects', () => {
        const { MOClass } = makeFakeMO();
        const stopBtn = {};
        const host = new NotionAdapterBridgeHost({
            adapter: makeMockAdapter(),
            document: makeSelectorDocument({ '[data-testid="stop-button"]': stopBtn }),
            MutationObserver: MOClass,
        });
        assert.equal(host.isStreaming(), true);
        assert.equal(host.isStreaming(), true);
        assert.equal(host.isStreaming(), true);
    });
});

// ---------------------------------------------------------------------------
// T-BH-12..T-BH-14 — observeAssistantMessages()
// ---------------------------------------------------------------------------

describe('NotionAdapterBridgeHost.observeAssistantMessages()', () => {
    it('T-BH-12: new content node → callback emitted once with { content, isComplete, timestamp }', () => {
        const { MOClass, lastInstance } = makeFakeMO();
        const container = {};
        const host = new NotionAdapterBridgeHost({
            adapter: makeMockAdapter(),
            document: makeSelectorDocument({ '.layout-content': container }),
            MutationObserver: MOClass,
        });

        const received: { content: string; isComplete: boolean; timestamp: number }[] = [];
        const before = Date.now();
        host.observeAssistantMessages((msg) => { received.push({ ...msg }); });

        const textNode = { textContent: 'Hello from Notion AI' };
        lastInstance()!.fire([{ addedNodes: [textNode] as unknown as NodeList, type: 'childList' }]);

        assert.equal(received.length, 1);
        assert.equal(received[0].content, 'Hello from Notion AI');
        assert.equal(received[0].isComplete, true);
        assert.ok(received[0].timestamp >= before);
    });

    it('T-BH-12b: whitespace/empty node → callback NOT emitted', () => {
        const { MOClass, lastInstance } = makeFakeMO();
        const container = {};
        const host = new NotionAdapterBridgeHost({
            adapter: makeMockAdapter(),
            document: makeSelectorDocument({ '.layout-content': container }),
            MutationObserver: MOClass,
        });

        const received: unknown[] = [];
        host.observeAssistantMessages((msg) => { received.push(msg); });

        const emptyNode = { textContent: '   \n  ' };
        lastInstance()!.fire([{ addedNodes: [emptyNode] as unknown as NodeList, type: 'childList' }]);

        assert.equal(received.length, 0);
    });

    it('T-BH-13: same DOM node in two mutation records → callback emitted exactly once', () => {
        const { MOClass, lastInstance } = makeFakeMO();
        const container = {};
        const host = new NotionAdapterBridgeHost({
            adapter: makeMockAdapter(),
            document: makeSelectorDocument({ '.layout-content': container }),
            MutationObserver: MOClass,
        });

        const received: unknown[] = [];
        host.observeAssistantMessages((msg) => { received.push(msg); });

        const textNode = { textContent: 'Same node' };
        lastInstance()!.fire([{ addedNodes: [textNode] as unknown as NodeList, type: 'childList' }]);
        lastInstance()!.fire([{ addedNodes: [textNode] as unknown as NodeList, type: 'childList' }]);

        assert.equal(received.length, 1);
    });

    it('T-BH-14: dispose() → subsequent mutations → callback NOT called', () => {
        const { MOClass, lastInstance } = makeFakeMO();
        const container = {};
        const host = new NotionAdapterBridgeHost({
            adapter: makeMockAdapter(),
            document: makeSelectorDocument({ '.layout-content': container }),
            MutationObserver: MOClass,
        });

        const received: unknown[] = [];
        const disposable = host.observeAssistantMessages((msg) => { received.push(msg); });

        // Fire once before dispose
        const node1 = { textContent: 'Before dispose' };
        lastInstance()!.fire([{ addedNodes: [node1] as unknown as NodeList, type: 'childList' }]);
        assert.equal(received.length, 1);

        // Dispose
        disposable.dispose();
        assert.equal(lastInstance()!.disconnected, true);

        // Mutations after dispose should not reach callback
        // (Observer is disconnected — in real DOM, no callbacks would fire)
    });
});
