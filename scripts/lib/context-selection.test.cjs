/**
 * Tests for context-selection.cjs — frame-aware CDP context selection logic.
 *
 * These tests use mock execution context arrays captured from a real Notion
 * agent page via CDP. They verify that context selection correctly identifies:
 *   - Top frame MAIN context (NOT iframe MAIN contexts)
 *   - Extension isolated context in top frame (NOT iframe isolated contexts)
 *   - Fetch interceptor status under Sentry wrapping
 *
 * Run: node --test scripts/lib/context-selection.test.cjs
 * (from MCP-SuperAssistant root)
 *
 * @see debug_frame-aware-probe.cjs — source of the captured context data
 */

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
    getTopFrameId,
    selectNotionMainContext,
    selectExtensionIsolatedContext,
    assessFetchInterceptor,
} = require('./context-selection.cjs');

// ============================================================================
// Mock data — captured from real Notion agent page CDP session
// ============================================================================

const TOP_FRAME_ID = '274DE09A5BFFB7B7E489DF3B7E7F53B1';
const AIF_FRAME_ID = '7BBE24440B23B5FA73F851EFB9051574';
const AUTH_FRAME_ID = '6ED29B0B8CDC56496BA3CE1286FDACAE';
const EXTENSION_ID = 'emkjlggeacidfpddopmalnpbjmdjcolj';

// Real execution contexts as reported by Runtime.executionContextCreated
const MOCK_CONTEXTS = [
    // Context 1: Top frame MAIN — www.notion.so/agent/...
    {
        id: 1,
        origin: 'https://www.notion.so',
        name: '',
        auxData: { isDefault: true, type: 'default', frameId: TOP_FRAME_ID },
    },
    // Context 2: aif.notion.so iframe MAIN
    {
        id: 2,
        origin: 'https://aif.notion.so',
        name: '',
        auxData: { isDefault: true, type: 'default', frameId: AIF_FRAME_ID },
    },
    // Context 3: identity.notion.so iframe MAIN
    {
        id: 3,
        origin: 'https://identity.notion.so',
        name: '',
        auxData: { isDefault: true, type: 'default', frameId: AUTH_FRAME_ID },
    },
    // Context 4: Extension isolated world in aif iframe (wrong frame!)
    {
        id: 4,
        origin: `chrome-extension://${EXTENSION_ID}`,
        name: 'MCP SuperAssistant',
        auxData: { isDefault: false, type: 'isolated', frameId: AIF_FRAME_ID },
    },
    // Context 5: Extension isolated world in top frame (correct!)
    {
        id: 5,
        origin: `chrome-extension://${EXTENSION_ID}`,
        name: 'MCP SuperAssistant',
        auxData: { isDefault: false, type: 'isolated', frameId: TOP_FRAME_ID },
    },
];

const MOCK_FRAME_TREE_RESULT = {
    result: {
        frameTree: {
            frame: {
                id: TOP_FRAME_ID,
                url: 'https://www.notion.so/agent/359cae42116c806fb9c4009257f4c5d1?wfv=chat',
                securityOrigin: 'https://www.notion.so',
            },
            childFrames: [
                {
                    frame: {
                        id: AIF_FRAME_ID,
                        url: 'https://aif.notion.so/aif-production.html',
                        securityOrigin: 'https://aif.notion.so',
                    },
                },
                {
                    frame: {
                        id: AUTH_FRAME_ID,
                        url: 'https://identity.notion.so/authSync',
                        securityOrigin: 'https://identity.notion.so',
                    },
                },
            ],
        },
    },
};

// ============================================================================
// Tests
// ============================================================================

describe('getTopFrameId', () => {
    test('extracts top frame id from frame tree', () => {
        assert.equal(getTopFrameId(MOCK_FRAME_TREE_RESULT), TOP_FRAME_ID);
    });

    test('returns null for missing result', () => {
        assert.equal(getTopFrameId(null), null);
        assert.equal(getTopFrameId({}), null);
        assert.equal(getTopFrameId({ result: {} }), null);
    });
});

describe('selectNotionMainContext', () => {
    test('selects top frame MAIN context by frameId (primary strategy)', () => {
        const ctx = selectNotionMainContext(MOCK_CONTEXTS, TOP_FRAME_ID);
        assert.ok(ctx !== null);
        assert.equal(ctx.id, 1, 'should select context 1 (top frame)');
        assert.equal(ctx.origin, 'https://www.notion.so');
        assert.equal(ctx.auxData.frameId, TOP_FRAME_ID);
    });

    test('MUST NOT select aif.notion.so iframe context', () => {
        const ctx = selectNotionMainContext(MOCK_CONTEXTS, TOP_FRAME_ID);
        assert.notEqual(ctx.id, 2, 'must not select aif iframe (context 2)');
        assert.ok(!ctx.origin.includes('aif.notion.so'));
    });

    test('MUST NOT select identity.notion.so iframe context', () => {
        const ctx = selectNotionMainContext(MOCK_CONTEXTS, TOP_FRAME_ID);
        assert.notEqual(ctx.id, 3, 'must not select identity iframe (context 3)');
        assert.ok(!ctx.origin.includes('identity.notion.so'));
    });

    test('fallback: excludes known iframe origins when no frameId', () => {
        const ctx = selectNotionMainContext(MOCK_CONTEXTS, null);
        assert.ok(ctx !== null);
        assert.equal(ctx.id, 1, 'fallback should still select top frame');
        assert.equal(ctx.origin, 'https://www.notion.so');
    });

    test('returns null for empty contexts array', () => {
        assert.equal(selectNotionMainContext([], TOP_FRAME_ID), null);
        assert.equal(selectNotionMainContext(null, TOP_FRAME_ID), null);
    });

    test('returns null when no notion.so context exists', () => {
        const nonNotion = [
            { id: 1, origin: 'https://example.com', name: '', auxData: { type: 'default', frameId: 'abc' } },
        ];
        assert.equal(selectNotionMainContext(nonNotion, 'abc'), null);
    });
});

describe('selectExtensionIsolatedContext', () => {
    test('selects extension context in top frame by frameId', () => {
        const ctx = selectExtensionIsolatedContext(MOCK_CONTEXTS, EXTENSION_ID, TOP_FRAME_ID);
        assert.ok(ctx !== null);
        assert.equal(ctx.id, 5, 'should select context 5 (top frame isolated)');
        assert.equal(ctx.auxData.frameId, TOP_FRAME_ID);
    });

    test('MUST NOT select extension context in iframe', () => {
        const ctx = selectExtensionIsolatedContext(MOCK_CONTEXTS, EXTENSION_ID, TOP_FRAME_ID);
        assert.notEqual(ctx.id, 4, 'must not select context 4 (aif iframe isolated)');
    });

    test('fallback: selects by name when no frameId', () => {
        const ctx = selectExtensionIsolatedContext(MOCK_CONTEXTS, EXTENSION_ID, null);
        assert.ok(ctx !== null);
        // Should find by name 'MCP SuperAssistant' — could be either 4 or 5
        assert.ok(ctx.name.includes('MCP SuperAssistant'));
    });

    test('returns null for missing extensionId', () => {
        assert.equal(selectExtensionIsolatedContext(MOCK_CONTEXTS, null, TOP_FRAME_ID), null);
        assert.equal(selectExtensionIsolatedContext(MOCK_CONTEXTS, '', TOP_FRAME_ID), null);
    });

    test('returns null for empty contexts', () => {
        assert.equal(selectExtensionIsolatedContext([], EXTENSION_ID, TOP_FRAME_ID), null);
    });
});

describe('assessFetchInterceptor', () => {
    test('ACTIVE: installKey=true, fetchWrapped=true', () => {
        const result = assessFetchInterceptor({
            installKey: true,
            fetchWrapped: true,
            fetchIsNative: false,
        });
        assert.equal(result.status, 'PASS');
        assert.equal(result.tier, 'ACTIVE');
    });

    test('LIKELY_ACTIVE: installKey=true, Sentry wrapper hides marker', () => {
        // This is the actual Notion state: Sentry wraps our fetch, hiding __mcpSaWrapped
        const result = assessFetchInterceptor({
            installKey: true,
            fetchWrapped: false,
            fetchIsNative: false,
        });
        assert.equal(result.status, 'PASS');
        assert.equal(result.tier, 'LIKELY_ACTIVE');
    });

    test('NOT_INSTALLED: installKey=false', () => {
        const result = assessFetchInterceptor({
            installKey: false,
            fetchWrapped: false,
            fetchIsNative: true,
        });
        assert.equal(result.status, 'FAIL');
        assert.equal(result.tier, 'NOT_INSTALLED');
    });

    test('INCONSISTENT: installKey=true but fetch is native', () => {
        const result = assessFetchInterceptor({
            installKey: true,
            fetchWrapped: false,
            fetchIsNative: true,
        });
        assert.equal(result.status, 'FAIL');
        assert.equal(result.tier, 'INCONSISTENT');
    });

    test('NO_DATA: null input', () => {
        const result = assessFetchInterceptor(null);
        assert.equal(result.status, 'FAIL');
        assert.equal(result.tier, 'NO_DATA');
    });
});
