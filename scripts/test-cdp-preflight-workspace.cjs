#!/usr/bin/env node
/**
 * Unit tests for cdp-preflight.cjs workspace config reading.
 *
 * Tests the readWorkspaceConfig() / REQUIRED_WORKSPACE logic WITHOUT
 * requiring a live CDP connection. Run standalone:
 *
 *   node scripts/test-cdp-preflight-workspace.cjs
 *
 * Author: GLM (智谱清言)
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
let failed = 0;

function assert(condition, name) {
    if (condition) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.log(`  ❌ ${name}`);
        failed++;
    }
}

// ─── Test 1: Default config reads correctly ─────────────────────────────────
console.log('\n1. Default config reads REQUIRED_WORKSPACE from config/workspace.toml');
delete process.env.NOTION_WORKSPACE;
delete process.env.WORKSPACE_ROOT;
// Clear module cache to re-evaluate
Object.keys(require.cache).forEach(k => {
    if (k.includes('cdp-preflight')) delete require.cache[k];
});
const m1 = require('./lib/cdp-preflight.cjs');
assert(m1.REQUIRED_WORKSPACE === 'sjzj030的工作空间',
    `REQUIRED_WORKSPACE = "${m1.REQUIRED_WORKSPACE}" (expected "sjzj030的工作空间")`);

// ─── Test 2: Env override ──────────────────────────────────────────────────
console.log('\n2. NOTION_WORKSPACE env override takes precedence');
process.env.NOTION_WORKSPACE = 'custom-workspace';
Object.keys(require.cache).forEach(k => {
    if (k.includes('cdp-preflight')) delete require.cache[k];
});
const m2 = require('./lib/cdp-preflight.cjs');
assert(m2.REQUIRED_WORKSPACE === 'custom-workspace',
    `REQUIRED_WORKSPACE = "${m2.REQUIRED_WORKSPACE}" (expected "custom-workspace")`);
delete process.env.NOTION_WORKSPACE;

// ─── Test 3: Fallback when config missing ──────────────────────────────────
console.log('\n3. Fallback to default when config file is missing');
process.env.WORKSPACE_ROOT = 'C:/nonexistent/path';
Object.keys(require.cache).forEach(k => {
    if (k.includes('cdp-preflight')) delete require.cache[k];
});
const m3 = require('./lib/cdp-preflight.cjs');
assert(m3.REQUIRED_WORKSPACE === 'sjzj030的工作空间',
    `Fallback REQUIRED_WORKSPACE = "${m3.REQUIRED_WORKSPACE}" (expected "sjzj030的工作空间")`);
delete process.env.WORKSPACE_ROOT;

// ─── Test 4: EXPORTED in module.exports ────────────────────────────────────
console.log('\n4. REQUIRED_WORKSPACE is exported');
Object.keys(require.cache).forEach(k => {
    if (k.includes('cdp-preflight')) delete require.cache[k];
});
const m4 = require('./lib/cdp-preflight.cjs');
assert('REQUIRED_WORKSPACE' in m4, 'REQUIRED_WORKSPACE in module.exports');

// ─── Test 5: Other expected exports present ────────────────────────────────
console.log('\n5. All expected exports present');
const expectedExports = [
    'resolveExtensionId', 'ensureAgentPage', 'preflight',
    'getTargets', 'sleep', 'CDP_PORT', 'AGENT_URL', 'REQUIRED_WORKSPACE'
];
for (const exp of expectedExports) {
    assert(exp in m4, `module.exports has "${exp}"`);
}

// ─── Test 6: readWorkspaceConfig picks up [notion] section ─────────────────
console.log('\n6. readWorkspaceConfig parses [notion] section correctly');
// Create a temp config to test parsing
const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wp-test-'));
const tmpConfig = path.join(tmpDir, 'config', 'workspace.toml');
fs.mkdirSync(path.dirname(tmpConfig), { recursive: true });
fs.writeFileSync(tmpConfig, `[workspace]\nroot = "${tmpDir.replace(/\\/g, '/')}"\n\n[notion]\nrequired_workspace = "test-notion-ws"\n`);
process.env.WORKSPACE_ROOT = tmpDir;
Object.keys(require.cache).forEach(k => {
    if (k.includes('cdp-preflight')) delete require.cache[k];
});
const m6 = require('./lib/cdp-preflight.cjs');
assert(m6.REQUIRED_WORKSPACE === 'test-notion-ws',
    `REQUIRED_WORKSPACE = "${m6.REQUIRED_WORKSPACE}" (expected "test-notion-ws")`);
delete process.env.WORKSPACE_ROOT;
fs.rmSync(tmpDir, { recursive: true, force: true });

// ─── Test 7: Env override still works with valid config ────────────────────
console.log('\n7. Env override beats valid config file');
fs.mkdirSync(path.dirname(tmpConfig), { recursive: true });
fs.writeFileSync(tmpConfig, `[notion]\nrequired_workspace = "file-value"\n`);
process.env.WORKSPACE_ROOT = tmpDir;
process.env.NOTION_WORKSPACE = 'env-value';
Object.keys(require.cache).forEach(k => {
    if (k.includes('cdp-preflight')) delete require.cache[k];
});
const m7 = require('./lib/cdp-preflight.cjs');
assert(m7.REQUIRED_WORKSPACE === 'env-value',
    `REQUIRED_WORKSPACE = "${m7.REQUIRED_WORKSPACE}" (expected "env-value")`);
delete process.env.WORKSPACE_ROOT;
delete process.env.NOTION_WORKSPACE;
fs.rmSync(tmpDir, { recursive: true, force: true });

// ─── TDD-1: extractWorkspaceInfoFromDocument contract ────────────────────
console.log('\n--- TDD-1: extractWorkspaceInfoFromDocument contract ---');
// Clear module cache to ensure fresh REQUIRED_WORKSPACE from config/workspace.toml
delete process.env.NOTION_WORKSPACE;
delete process.env.WORKSPACE_ROOT;
Object.keys(require.cache).forEach(k => {
    if (k.includes('cdp-preflight')) delete require.cache[k];
});
const { extractWorkspaceInfoFromDocument } = require('./lib/cdp-preflight.cjs');
assert(typeof extractWorkspaceInfoFromDocument === 'function', 'extractWorkspaceInfoFromDocument is exported as a function');

// Helper: build a minimal synthetic DOM that mimics Notion sidebar text node structure.
function buildSyntheticDocument(workspaceText) {
    // Minimal fake DOM: a root with a text node inside nested divs
    // We only need the function to traverse text nodes like in the browser.
    // Because cjs unit tests run in Node, we provide a minimal adapter object
    // that exposes TreeWalker semantics the pure function expects.
    const root = {
        childNodes: [
            {
                nodeType: 3, // TEXT_NODE
                textContent: workspaceText
            }
        ]
    };
    return root;
}

// Case A: workspace text present
const domA = buildSyntheticDocument('sjzj030的工作空间');
const resultA = extractWorkspaceInfoFromDocument(domA);
assert(resultA.workspaceName === 'sjzj030的工作空间', 'returns workspaceName when text present');
assert(typeof resultA.confidence === 'string' && resultA.confidence.length > 0, 'returns non-empty confidence');

// Case B: no workspace text
const domB = buildSyntheticDocument('Notion AI');
const resultB = extractWorkspaceInfoFromDocument(domB);
assert(resultB.workspaceName === null, 'returns null workspaceName when not found');
assert(resultB.confidence === 'not_found', 'confidence is not_found when absent');

// ─── TDD-2: WorkspaceMismatchError + checkWorkspace contract ─────────────
console.log('\n--- TDD-2: WorkspaceMismatchError + checkWorkspace contract ---');
const { WorkspaceMismatchError, checkWorkspace } = require('./lib/cdp-preflight.cjs');
assert(typeof WorkspaceMismatchError === 'function' && WorkspaceMismatchError.prototype instanceof Error,
    'WorkspaceMismatchError is an Error subclass');

// Case A: match — should not throw
const matchResult = checkWorkspace('sjzj030的工作空间', 'sjzj030的工作空间');
assert(matchResult.matched === true, 'checkWorkspace returns matched=true when same workspace');
assert(matchResult.error === null, 'checkWorkspace returns no error when matched');

// Case B: mismatch — should throw WorkspaceMismatchError
let threwCorrectly = false;
try {
    checkWorkspace('houwen的工作空间', 'sjzj030的工作空间');
} catch (e) {
    threwCorrectly = (e instanceof WorkspaceMismatchError) &&
        e.detected === 'houwen的工作空间' &&
        e.expected === 'sjzj030的工作空间';
}
assert(threwCorrectly, 'checkWorkspace throws WorkspaceMismatchError on mismatch with detected/expected fields');

// Case C: null detected — should throw with detected=null
let threwNull = false;
try {
    checkWorkspace(null, 'sjzj030的工作空间');
} catch (e) {
    threwNull = (e instanceof WorkspaceMismatchError) &&
        e.detected === null &&
        e.expected === 'sjzj030的工作空间';
}
assert(threwNull, 'checkWorkspace throws when detected is null');

// ─── TDD-3: WorkspaceHealthMonitor (polling core logic) ─────────────────
console.log('\n--- TDD-3: WorkspaceHealthMonitor polling core ---');
// Re-require with clean env to ensure REQUIRED_WORKSPACE is from config
delete process.env.NOTION_WORKSPACE;
delete process.env.WORKSPACE_ROOT;
Object.keys(require.cache).forEach(k => {
    if (k.includes('cdp-preflight')) delete require.cache[k];
});
const { WorkspaceHealthMonitor } = require('./lib/cdp-preflight.cjs');
assert(typeof WorkspaceHealthMonitor === 'function', 'WorkspaceHealthMonitor is exported');

// Case A: record success — shouldDrift returns false
const monA = new WorkspaceHealthMonitor({ maxConsecutiveFailures: 2 });
monA.recordCheck('sjzj030的工作空间');
assert(monA.consecutiveFailures === 0, 'consecutiveFailures is 0 after success');
assert(monA.shouldDriftFail() === false, 'shouldDriftFail returns false after success');

// Case B: record one failure — shouldDrift returns false (below threshold)
const monB = new WorkspaceHealthMonitor({ maxConsecutiveFailures: 2 });
monB.recordCheck('wrong-workspace');
assert(monB.consecutiveFailures === 1, 'consecutiveFailures is 1 after one failure');
assert(monB.shouldDriftFail() === false, 'shouldDriftFail returns false with 1 failure');

// Case C: record two consecutive failures — shouldDrift returns true
const monC = new WorkspaceHealthMonitor({ maxConsecutiveFailures: 2 });
monC.recordCheck('wrong-1');
monC.recordCheck('wrong-2');
assert(monC.consecutiveFailures === 2, 'consecutiveFailures is 2 after two failures');
assert(monC.shouldDriftFail() === true, 'shouldDriftFail returns true at threshold');

// Case D: success resets failure counter
const monD = new WorkspaceHealthMonitor({ maxConsecutiveFailures: 3 });
monD.recordCheck('wrong-1');
monD.recordCheck('wrong-2');
monD.recordCheck('sjzj030的工作空间'); // success resets
assert(monD.consecutiveFailures === 0, 'consecutiveFailures reset after success');
assert(monD.shouldDriftFail() === false, 'shouldDriftFail returns false after reset');

// Case E: null detected counts as failure
const monE = new WorkspaceHealthMonitor({ maxConsecutiveFailures: 1 });
monE.recordCheck(null);
assert(monE.consecutiveFailures === 1, 'null detected counts as failure');
assert(monE.shouldDriftFail() === true, 'shouldDriftFail returns true when null at threshold');

// ─── TDD-4a: CDP workspace detection expression seam ─────────────────────
console.log('\n--- TDD-4a: CDP workspace detection expression seam ---');
delete process.env.NOTION_WORKSPACE;
delete process.env.WORKSPACE_ROOT;
Object.keys(require.cache).forEach(k => {
    if (k.includes('cdp-preflight')) delete require.cache[k];
});
const {
    buildWorkspaceDetectionExpression,
    enforceWorkspaceInfo,
    WorkspaceMismatchError: Tdd4WorkspaceMismatchError,
} = require('./lib/cdp-preflight.cjs');

assert(typeof buildWorkspaceDetectionExpression === 'function',
    'buildWorkspaceDetectionExpression is exported');
assert(typeof enforceWorkspaceInfo === 'function',
    'enforceWorkspaceInfo is exported');

function evaluateWorkspaceExpression(root) {
    const expression = buildWorkspaceDetectionExpression();
    assert(typeof expression === 'string' && expression.trim().length > 0,
        'buildWorkspaceDetectionExpression returns a non-empty expression string');
    return vm.runInNewContext(expression, {
        document: { body: root },
    });
}

const exprResultA = evaluateWorkspaceExpression(buildSyntheticDocument('sjzj030的工作空间'));
assert(exprResultA.workspaceName === 'sjzj030的工作空间',
    'CDP expression returns workspaceName from document.body');
assert(exprResultA.confidence === 'text_match',
    'CDP expression returns text_match confidence');

const multiWorkspaceDom = {
    childNodes: [
        { nodeType: 3, textContent: 'sjzj030的工作空间' },
        { nodeType: 3, textContent: 'houwen的工作空间' },
    ],
};
const exprResultB = evaluateWorkspaceExpression(multiWorkspaceDom);
assert(exprResultB.workspaceName === 'sjzj030的工作空间',
    'CDP expression keeps first document-order workspace candidate');

const exprResultC = evaluateWorkspaceExpression(null);
assert(exprResultC.workspaceName === null,
    'CDP expression handles missing document.body as no workspace');
assert(exprResultC.confidence === 'no_root',
    'CDP expression returns no_root confidence for missing body');

const enforced = enforceWorkspaceInfo(
    { workspaceName: 'sjzj030的工作空间', confidence: 'text_match' },
    'sjzj030的工作空间'
);
assert(enforced.matched === true, 'enforceWorkspaceInfo returns matched=true on DOM match');

let failClosedOnMissingDom = false;
try {
    enforceWorkspaceInfo(
        {
            workspaceName: null,
            confidence: 'not_found',
            titleObserved: 'sjzj030的工作空间',
        },
        'sjzj030的工作空间'
    );
} catch (e) {
    failClosedOnMissingDom = e instanceof Tdd4WorkspaceMismatchError &&
        e.detected === null &&
        e.expected === 'sjzj030的工作空间';
}
assert(failClosedOnMissingDom,
    'enforceWorkspaceInfo fails closed when DOM workspace is missing even if title contains expected workspace');

// ─── TDD-4b: ensureAgentPage wiring with fake CDP ─────────────────────────
console.log('\n--- TDD-4b: ensureAgentPage workspace wiring with fake CDP ---');
process.env.CDP_PORT = '9';
Object.keys(require.cache).forEach(k => {
    if (k.includes('cdp-preflight')) delete require.cache[k];
});

async function runEnsureAgentPageWiringTests() {
    const {
        ensureAgentPage: ensureAgentPageUnderTest,
        WorkspaceMismatchError: WiringWorkspaceMismatchError,
    } = require('./lib/cdp-preflight.cjs');

    function createFakeWebSocket(runtimeValue, sentMessages) {
        return class FakeWebSocket {
            constructor(url) {
                this.url = url;
                this.handlers = {};
            }

            on(event, handler) {
                if (event === 'open') {
                    handler();
                } else {
                    this.handlers[event] = handler;
                }
                return this;
            }

            removeListener(event, handler) {
                if (this.handlers[event] === handler) {
                    delete this.handlers[event];
                }
            }

            send(raw) {
                const msg = JSON.parse(raw);
                sentMessages.push(msg);
                if (msg.method !== 'Runtime.evaluate') {
                    throw new Error(`Unexpected CDP method in fake websocket: ${msg.method}`);
                }
                this.handlers.message(JSON.stringify({
                    id: msg.id,
                    result: {
                        result: {
                            value: runtimeValue,
                        },
                    },
                }));
            }

            close() {}
        };
    }

    const fakeTargets = [{
        type: 'page',
        url: 'https://www.notion.so/ai',
        title: '[notion-tab-0] Notion AI | Notion',
        webSocketDebuggerUrl: 'ws://fake-notion-tab',
    }];

    const successMessages = [];
    const successPage = await ensureAgentPageUnderTest('https://www.notion.so/chat', {
        getTargets: async () => fakeTargets,
        WebSocket: createFakeWebSocket({
            workspaceName: 'sjzj030的工作空间',
            confidence: 'text_match',
            matchedText: 'sjzj030的工作空间',
        }, successMessages),
        sleep: async () => {},
    });

    assert(successPage.workspaceInfo.workspaceName === 'sjzj030的工作空间',
        'ensureAgentPage returns workspaceInfo from fake CDP result');
    assert(successMessages.length === 1 && successMessages[0].method === 'Runtime.evaluate',
        'ensureAgentPage uses Runtime.evaluate for workspace detection');

    const missingMessages = [];
    let threwMissingWorkspace = false;
    try {
        await ensureAgentPageUnderTest('https://www.notion.so/chat', {
            getTargets: async () => fakeTargets,
            WebSocket: createFakeWebSocket({
                workspaceName: null,
                confidence: 'no_root',
                matchedText: null,
            }, missingMessages),
            sleep: async () => {},
        });
    } catch (e) {
        threwMissingWorkspace = e instanceof WiringWorkspaceMismatchError &&
            e.detected === null &&
            e.titleObserved === '[notion-tab-0] Notion AI | Notion' &&
            e.workspaceInfo?.confidence === 'no_root';
    }
    assert(threwMissingWorkspace,
        'ensureAgentPage fails closed with WorkspaceMismatchError and title diagnostic when DOM workspace is missing');
}

// ─── Summary ───────────────────────────────────────────────────────────────
function finish() {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    } else {
        console.log('All tests passed! ✅');
    }
}

runEnsureAgentPageWiringTests()
    .then(finish)
    .catch(err => {
        console.log(`  ❌ ensureAgentPage fake-CDP wiring test threw: ${err.message}`);
        failed++;
        console.error(err.stack || err);
        finish();
    });
