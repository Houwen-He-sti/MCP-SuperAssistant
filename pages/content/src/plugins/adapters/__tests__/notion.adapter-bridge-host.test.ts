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

// ---------------------------------------------------------------------------
// T-BH-01 / T-BH-02 — insertText
// ---------------------------------------------------------------------------

describe('NotionAdapterBridgeHost.insertText()', () => {
    it('T-BH-01: adapter returning true → RuntimeResult.ok === true', async () => {
        const adapter = makeMockAdapter({ insertResult: true });
        const host = new NotionAdapterBridgeHost({ adapter, document: makeMockDocument('hello') });
        const result = await host.insertText('hello');
        assert.equal(result.ok, true);
    });

    it('T-BH-02: adapter returning false → ok===false, code=NOTION_INSERT_FAILED', async () => {
        const adapter = makeMockAdapter({ insertResult: false });
        const host = new NotionAdapterBridgeHost({ adapter, document: makeMockDocument('hello') });
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
        const host = new NotionAdapterBridgeHost({ adapter, document: makeMockDocument(null) });
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
        const host = new NotionAdapterBridgeHost({ adapter, document: makeMockDocument(null) });
        const result = await host.clickSubmit();
        assert.equal(result.ok, true);
    });

    it('T-BH-04: adapter returning false → ok===false, code=NOTION_SUBMIT_FAILED', async () => {
        const adapter = makeMockAdapter({ submitResult: false });
        const host = new NotionAdapterBridgeHost({ adapter, document: makeMockDocument(null) });
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
        });
        const content = host.getInputContent();
        assert.equal(content, 'user typed text');
    });

    it('T-BH-06: element absent → returns null', () => {
        const adapter = makeMockAdapter();
        const host = new NotionAdapterBridgeHost({
            adapter,
            document: makeMockDocument(null),
        });
        const content = host.getInputContent();
        assert.equal(content, null);
    });

    it('T-BH-05b: empty element → returns empty string (not null)', () => {
        const adapter = makeMockAdapter();
        const host = new NotionAdapterBridgeHost({
            adapter,
            document: makeMockDocument(''),
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
        });
        assert.deepEqual(host.getSubmitButtonState(), { kind: 'missing' });
    });

    it('T-BH-07c: button present, not connected (detached) → { kind: "detached" }', () => {
        const btn = { isConnected: false, getAttribute: (_n: string) => null };
        const host = new NotionAdapterBridgeHost({
            adapter: makeMockAdapter(),
            document: { querySelector: () => btn } as unknown as Document,
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
        });
        assert.deepEqual(host.getSubmitButtonState(), { kind: 'disabled' });
    });

    it('T-BH-07e: button connected, no aria-disabled → { kind: "enabled" }', () => {
        const btn = { isConnected: true, getAttribute: (_n: string) => null };
        const host = new NotionAdapterBridgeHost({
            adapter: makeMockAdapter(),
            document: { querySelector: () => btn } as unknown as Document,
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
            '../../../../../../../../../AppData/Local/Temp/vscode-dir-shared-context-post121/mcp-runtime/src/index.ts',
        );
        const contents = readFileSync(indexPath, 'utf-8');
        assert.ok(
            !contents.includes('NotionAdapterBridgeHost'),
            'Bridge host must NOT appear in mcp-runtime public exports (separation of concerns)',
        );
    });
});
