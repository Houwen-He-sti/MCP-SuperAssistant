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
// Current production code does NOT export extractWorkspaceInfoFromDocument yet.
// Test expresses the target contract BEFORE implementation.
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

// ─── Summary ───────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
} else {
    console.log('All tests passed! ✅');
}
