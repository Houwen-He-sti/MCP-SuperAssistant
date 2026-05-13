#!/usr/bin/env node
/**
 * Unit tests for L5B-2 Notion MCP write-back preflight helpers.
 *
 * These tests intentionally avoid CDP, Notion, GitHub, and live bridge calls.
 * They pin the fail-closed helper contract before the observation script is
 * allowed to produce acceptance evidence.
 *
 * Run:
 *   node scripts/test-l5b2-writeback-preflight.cjs
 *
 * Author: Codex/GPT-5
 */

const {
    createMcpBridgeInventorySequence,
    extractToolNamesFromToolsList,
    extractBridgeInfoFromToolCallResult,
    parseBridgeWriteInventory,
    repoNameMatches,
    evaluateWriteGate,
    classifyPhase1Verdict,
    classifyPhase2Verdict,
    validateEvidenceMetadata,
    buildSmokeBodyContract,
    buildCommentOnPrJsonl,
    buildComposerProbeExpression,
} = require('./lib/l5b2-writeback-preflight.cjs');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function assert(condition, name) {
    if (condition) {
        console.log(`  PASS ${name}`);
        passed++;
    } else {
        console.log(`  FAIL ${name}`);
        failed++;
    }
}

function assertEqual(actual, expected, name) {
    assert(actual === expected, `${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertIncludes(items, expected, name) {
    assert(Array.isArray(items) && items.includes(expected), `${name}: includes ${JSON.stringify(expected)}`);
}

console.log('\n--- L5B-2 TDD: MCP protocol sequence ---');
const sequence = createMcpBridgeInventorySequence({ startId: 10, clientName: 'l5b2-test', clientVersion: 'test' });
assertEqual(sequence.length, 4, 'sequence has initialize, initialized notification, tools/list, get_bridge_info');
assertEqual(sequence[0].body.method, 'initialize', 'step 1 is initialize request');
assertEqual(sequence[0].body.id, 10, 'initialize request id uses startId');
assertEqual(sequence[0].body.params.clientInfo.name, 'l5b2-test', 'initialize includes client name');
assertEqual(sequence[1].body.method, 'notifications/initialized', 'step 2 is initialized notification');
assert(!('id' in sequence[1].body), 'initialized notification has no id');
assertEqual(sequence[2].body.method, 'tools/list', 'step 3 is tools/list request');
assertEqual(sequence[2].body.id, 11, 'tools/list id increments after initialize');
assertEqual(sequence[3].body.method, 'tools/call', 'step 4 is tools/call request');
assertEqual(sequence[3].body.id, 12, 'tools/call id increments after tools/list');
assertEqual(sequence[3].body.params.name, 'get_bridge_info', 'tools/call invokes get_bridge_info');

console.log('\n--- L5B-2 TDD: tools/list parser ---');
const toolsListResult = {
    tools: [
        { name: 'get_bridge_info' },
        { name: 'comment_on_pr' },
        { name: 'get_pr' },
    ],
};
const toolNames = extractToolNamesFromToolsList(toolsListResult);
assertIncludes(toolNames, 'comment_on_pr', 'extractToolNamesFromToolsList reads tool objects');
assertEqual(extractToolNamesFromToolsList({ tools: [] }).length, 0, 'empty tools/list returns empty array');
assertEqual(extractToolNamesFromToolsList({ tools: [{ title: 'not-a-name' }] }).length, 0, 'malformed tool item is ignored');
assertEqual(extractToolNamesFromToolsList(null).length, 0, 'null tools/list returns empty array');

console.log('\n--- L5B-2 TDD: bridge write inventory parser ---');
const validBridgeInfo = {
    writes_enabled: true,
    tools: {
        core: ['echo', 'get_bridge_info'],
        git_read: ['get_pr'],
        git_write: ['comment_on_pr'],
        gated: [],
    },
};
const validInventory = parseBridgeWriteInventory(validBridgeInfo);
assert(validInventory.ok, 'valid bridge info passes');
assertEqual(validInventory.writesEnabled, true, 'valid bridge info records writesEnabled true');
assertIncludes(validInventory.gitWriteTools, 'comment_on_pr', 'valid bridge info reads tools.git_write');

const bridgeInfoDirect = extractBridgeInfoFromToolCallResult(validBridgeInfo);
assertEqual(bridgeInfoDirect.writes_enabled, true, 'tool-call extractor accepts direct bridge info object');

const bridgeInfoStructured = extractBridgeInfoFromToolCallResult({ structuredContent: validBridgeInfo });
assertEqual(bridgeInfoStructured.writes_enabled, true, 'tool-call extractor accepts structuredContent');

const bridgeInfoText = extractBridgeInfoFromToolCallResult({
    content: [{ type: 'text', text: JSON.stringify(validBridgeInfo) }],
});
assertEqual(bridgeInfoText.writes_enabled, true, 'tool-call extractor parses JSON text content');

const bridgeInfoNested = extractBridgeInfoFromToolCallResult({ result: { structuredContent: validBridgeInfo } });
assertEqual(bridgeInfoNested.writes_enabled, true, 'tool-call extractor accepts nested result wrapper');

const bridgeInfoMissing = extractBridgeInfoFromToolCallResult({ content: [{ type: 'text', text: 'not json' }] });
assertEqual(bridgeInfoMissing, null, 'tool-call extractor returns null for malformed text content');

const flatToolsInventory = parseBridgeWriteInventory({
    writes_enabled: true,
    tools: ['comment_on_pr'],
});
assert(!flatToolsInventory.ok, 'flat tools array is rejected as non-authoritative');
assertIncludes(flatToolsInventory.failures, 'tools.git_write_missing', 'flat tools array reports missing git_write');

const readOnlyInventory = parseBridgeWriteInventory({
    writes_enabled: false,
    tools: { core: [], git_read: [], git_write: ['comment_on_pr'], gated: [] },
});
assert(!readOnlyInventory.ok, 'writes_enabled false fails');
assertIncludes(readOnlyInventory.failures, 'writes_disabled', 'writes_enabled false reports writes_disabled');

const wrongBucketInventory = parseBridgeWriteInventory({
    writes_enabled: true,
    tools: { core: ['comment_on_pr'], git_read: [], git_write: [], gated: [] },
});
assert(!wrongBucketInventory.ok, 'comment_on_pr outside git_write fails');
assertIncludes(wrongBucketInventory.failures, 'comment_on_pr_not_write_enabled', 'wrong bucket reports write-enabled failure');

console.log('\n--- L5B-2 TDD: full-mode write gate ---');
assert(repoNameMatches('Houwen-He-sti/VSCode-Dir', 'Houwen-He-sti/VSCode-Dir'), 'repoNameMatches accepts exact owner/repo');
assert(repoNameMatches('houwen-he-sti/vscode-dir', 'Houwen-He-sti/VSCode-Dir'), 'repoNameMatches is case-insensitive');
assert(!repoNameMatches('Houwen-He-sti/MCP-SuperAssistant', 'Houwen-He-sti/VSCode-Dir'), 'repoNameMatches rejects wrong repo');
assert(!repoNameMatches('unknown', 'Houwen-He-sti/VSCode-Dir'), 'repoNameMatches rejects unknown repo');

const gateOk = evaluateWriteGate({
    ghAuthOk: true,
    bridgeReachable: true,
    mcpSessionOk: true,
    toolsListResult,
    bridgeInfo: validBridgeInfo,
    repoMatches: true,
    evidenceContextOk: true,
});
assert(gateOk.ok, 'write gate passes when all required checks pass');
assertEqual(gateOk.verdict, 'WRITE_GATE_OK', 'write gate success verdict');

const gateNoBridge = evaluateWriteGate({
    ghAuthOk: true,
    bridgeReachable: false,
    mcpSessionOk: false,
    toolsListResult,
    bridgeInfo: validBridgeInfo,
    repoMatches: true,
    evidenceContextOk: true,
});
assert(!gateNoBridge.ok, 'write gate blocks unreachable bridge');
assertEqual(gateNoBridge.verdict, 'BRIDGE_UNREACHABLE', 'unreachable bridge verdict');

const gateNoListedTool = evaluateWriteGate({
    ghAuthOk: true,
    bridgeReachable: true,
    mcpSessionOk: true,
    toolsListResult: { tools: [{ name: 'get_bridge_info' }] },
    bridgeInfo: validBridgeInfo,
    repoMatches: true,
    evidenceContextOk: true,
});
assert(!gateNoListedTool.ok, 'write gate blocks when tools/list lacks comment_on_pr');
assertEqual(gateNoListedTool.verdict, 'TOOL_NOT_LISTED', 'missing tool-list verdict');

const gateWritesDisabled = evaluateWriteGate({
    ghAuthOk: true,
    bridgeReachable: true,
    mcpSessionOk: true,
    toolsListResult,
    bridgeInfo: readOnlyInventory.source,
    repoMatches: true,
    evidenceContextOk: true,
});
assert(!gateWritesDisabled.ok, 'write gate blocks writes disabled');
assertEqual(gateWritesDisabled.verdict, 'WRITES_DISABLED', 'writes disabled verdict');

const gateRepoMismatch = evaluateWriteGate({
    ghAuthOk: true,
    bridgeReachable: true,
    mcpSessionOk: true,
    toolsListResult,
    bridgeInfo: validBridgeInfo,
    repoMatches: false,
    evidenceContextOk: true,
});
assert(!gateRepoMismatch.ok, 'write gate blocks repo mismatch');
assertEqual(gateRepoMismatch.verdict, 'REPO_MISMATCH', 'repo mismatch verdict');

console.log('\n--- L5B-2 TDD: Phase 1 verdict classification ---');
assertEqual(classifyPhase1Verdict({
    domComposerObserved: true,
    bridgeInventoryOk: false,
}), 'DOM_COMPOSER_OBSERVED', 'DOM-only evidence is not PREFLIGHT_OK');

assertEqual(classifyPhase1Verdict({
    domComposerObserved: false,
    bridgeInventoryOk: false,
}), 'PREFLIGHT_BLOCKED_NO_COMPOSER', 'missing composer blocks phase 1');

assertEqual(classifyPhase1Verdict({
    domComposerObserved: true,
    bridgeInventoryOk: true,
    ghAuthOk: true,
    repoMatches: true,
    contextMetadataOk: true,
}), 'PREFLIGHT_OK', 'full preflight facts can produce PREFLIGHT_OK');

assertEqual(classifyPhase1Verdict({
    domComposerObserved: true,
    bridgeInventoryOk: true,
    ghAuthOk: true,
    repoMatches: true,
    contextMetadataOk: true,
    transcriptConfirmed: false,
    phase2Started: true,
}), 'SUBMIT_NOT_CONFIRMED_STOP', 'missing transcript confirmation is stop verdict');

console.log('\n--- L5B-2 TDD: Phase 2 verdict classification ---');
assertEqual(classifyPhase2Verdict({
    submitConfirmed: false,
}), 'FAIL_SUBMIT_NOT_CONFIRMED', 'Phase 2 stops when transcript is not confirmed');

assertEqual(classifyPhase2Verdict({
    submitConfirmed: true,
    commentFound: true,
    exactMatch: true,
    hasAssistantFunctionCall: false,
    hasCallToolInvocation: false,
}), 'PARTIAL_EXACT_COMMENT_WITHOUT_TOOL_EVIDENCE', 'exact comment without structured tool evidence cannot PASS');

assertEqual(classifyPhase2Verdict({
    submitConfirmed: true,
    commentFound: true,
    exactMatch: true,
    hasAssistantFunctionCall: true,
    hasCallToolInvocation: true,
}), 'PASS', 'exact comment plus structured tool evidence can PASS');

assertEqual(classifyPhase2Verdict({
    submitConfirmed: true,
    commentFound: true,
    exactMatch: false,
    hasAssistantFunctionCall: true,
    hasCallToolInvocation: true,
}), 'PARTIAL_BODY_MISMATCH', 'comment body mismatch is partial');

assertEqual(classifyPhase2Verdict({
    submitConfirmed: true,
    commentFound: false,
    hasAssistantFunctionCall: true,
    hasCallToolInvocation: false,
}), 'PARTIAL_TOOL_CALL_WITHOUT_COMMENT', 'tool-call evidence without PR comment is partial');

assertEqual(classifyPhase2Verdict({
    submitConfirmed: true,
    commentFound: false,
    hasAssistantFunctionCall: false,
    hasCallToolInvocation: false,
}), 'FAIL_NO_STRUCTURED_TOOL_CALL', 'no structured tool-call evidence fails');

console.log('\n--- L5B-2 TDD: evidence metadata validation ---');
const validMetadata = {
    script_path: 'MCP-SuperAssistant/scripts/l5b2-obs-mcp-write-back.cjs',
    script_sha256: 'a'.repeat(64),
    script_git_tracked: false,
    root_repo: { branch: 'feat/l5b-2-plan', commit: 'b'.repeat(40), dirty: true },
    mcp_superassistant_repo: {
        branch: 'chore/committee-github-tools-inventory',
        commit: 'c'.repeat(40),
        dirty: true,
        untracked_files_present: true,
    },
    command: 'node scripts/l5b2-obs-mcp-write-back.cjs',
    mode: 'phase1',
    cdp_port: 9222,
    target_url: 'https://www.notion.so/chat',
    run_id: 'L5B2-OBS-123',
    started_at: '2026-05-14T00:00:00.000Z',
    ended_at: '2026-05-14T00:00:01.000Z',
};
const metadataOk = validateEvidenceMetadata(validMetadata);
assert(metadataOk.ok, 'valid evidence metadata passes even for untracked script when sha is present');

const metadataNoHash = validateEvidenceMetadata({ ...validMetadata, script_sha256: '' });
assert(!metadataNoHash.ok, 'missing script hash fails metadata validation');
assertIncludes(metadataNoHash.failures, 'script_sha256_missing', 'missing script hash failure is explicit');

const metadataBadMode = validateEvidenceMetadata({ ...validMetadata, mode: 'maybe' });
assert(!metadataBadMode.ok, 'invalid mode fails metadata validation');
assertIncludes(metadataBadMode.failures, 'mode_invalid', 'invalid mode failure is explicit');

const metadataUnknownRootCommit = validateEvidenceMetadata({
    ...validMetadata,
    root_repo: { ...validMetadata.root_repo, commit: 'unknown' },
});
assert(!metadataUnknownRootCommit.ok, 'unknown root repo commit fails metadata validation');
assertIncludes(metadataUnknownRootCommit.failures, 'root_repo.commit_invalid', 'unknown root commit failure is explicit');

const metadataUnknownBranch = validateEvidenceMetadata({
    ...validMetadata,
    mcp_superassistant_repo: { ...validMetadata.mcp_superassistant_repo, branch: 'unknown' },
});
assert(!metadataUnknownBranch.ok, 'unknown subrepo branch fails metadata validation');
assertIncludes(metadataUnknownBranch.failures, 'mcp_superassistant_repo.branch_invalid', 'unknown branch failure is explicit');

console.log('\n--- L5B-2 TDD: actual observation script integration guard ---');
const observationScript = fs.readFileSync(path.join(__dirname, 'l5b2-obs-mcp-write-back.cjs'), 'utf8');
assert(observationScript.includes('classifyPhase1Verdict({'), 'observation script uses classifyPhase1Verdict for Phase 1 verdict');
assert(!observationScript.includes("let preflightLevel = 'PREFLIGHT_OK'"), 'observation script no longer starts Phase 1 from PREFLIGHT_OK');
assert(!observationScript.includes('repoMatches: true'), 'observation script does not hard-code repoMatches=true');
assert(!observationScript.includes('evidenceContextOk: true'), 'observation script does not hard-code evidenceContextOk=true');

console.log('\n--- L5B-2 TDD: composer probe expression ---');
function runComposerProbeExpression(expression, fakeDocument) {
    const vm = require('vm');
    const sandbox = {
        document: fakeDocument,
        Event: function Event(type, options) {
            this.type = type;
            this.options = options || {};
        },
        JSON,
        Array,
    };
    return JSON.parse(vm.runInNewContext(expression, sandbox));
}

function fakeButton(attrs = {}) {
    return {
        tagName: 'BUTTON',
        type: attrs.typeProperty || 'button',
        textContent: attrs.textContent || '',
        className: attrs.className || '',
        offsetHeight: attrs.visible === false ? 0 : 10,
        offsetWidth: attrs.visible === false ? 0 : 10,
        offsetParent: attrs.visible === false ? null : {},
        getAttribute(name) {
            if (name === 'type') return attrs.typeAttr || null;
            if (name === 'aria-label') return attrs.ariaLabel || null;
            if (name === 'data-testid') return attrs.testId || null;
            return null;
        },
    };
}

function fakeInput() {
    return {
        tagName: 'DIV',
        textContent: '',
        className: '',
        getAttribute(name) {
            if (name === 'role') return 'textbox';
            if (name === 'contenteditable') return 'true';
            return null;
        },
        dispatchEvent() {},
    };
}

const buttonPropertyOnlyDoc = {
    input: fakeInput(),
    buttons: [fakeButton({ typeProperty: 'submit', typeAttr: null })],
    querySelector(selector) {
        if (selector.includes('role="textbox"')) return this.input;
        return null;
    },
    querySelectorAll(selector) {
        return selector === 'button' ? this.buttons : [];
    },
};
const propertyOnlyProbe = runComposerProbeExpression(buildComposerProbeExpression(), buttonPropertyOnlyDoc);
assert(propertyOnlyProbe.hasInput, 'composer probe detects contenteditable input');
assert(propertyOnlyProbe.hasSubmitButton, 'composer probe detects submit button by button.type property without type attribute');
assertEqual(propertyOnlyProbe.submitButtonMatchReason, 'type_property_submit', 'composer probe records type_property_submit reason');

const insertProbe = runComposerProbeExpression(buildComposerProbeExpression({ insertText: 'probe' }), buttonPropertyOnlyDoc);
assertEqual(buttonPropertyOnlyDoc.input.textContent, 'probe', 'composer probe can insert probe text when requested');
assert(insertProbe.hasSubmitButton, 'composer probe with inserted text still detects submit button');

console.log('\n--- L5B-2 TDD: exact body contract preparation ---');
const bodyContract = buildSmokeBodyContract({ runId: 'L5B2-OBS-123', reviewer: 'Notion AI' });
assert(bodyContract.body.includes('ACK: L5B2-OBS-123'), 'smoke body includes per-run ACK');
assert(bodyContract.body.includes('```text'), 'smoke body includes text code fence');
assert(bodyContract.body.includes('@\u200Bopu-47'), 'smoke body uses actual zero-width neutralized mention sample');
assertEqual(bodyContract.hasStaticAck, false, 'body contract rejects static ACK');
assertEqual(bodyContract.sha256.length, 64, 'body contract computes sha256');
assert(bodyContract.lineCount >= 10, 'body contract is multiline');

const jsonl = buildCommentOnPrJsonl({ callId: 'call-L5B2-OBS-123', number: 97, body: bodyContract.body });
assert(jsonl.includes('"type":"function_call_start"'), 'JSONL includes function_call_start');
assert(jsonl.includes('"name":"comment_on_pr"'), 'JSONL targets comment_on_pr');
assert(jsonl.includes('"body"'), 'JSONL includes body argument');
assert(jsonl.includes('\\n'), 'JSONL safely escapes multiline body');
assert(!jsonl.includes('undefined'), 'JSONL does not serialize undefined');

console.log(`\nL5B-2 preflight helper tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
