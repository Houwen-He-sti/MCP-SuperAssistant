/**
 * L5B-2 Pre-Observation v2: Notion AI → MCP-SuperAssistant → committee-bridge → GitHub API
 *
 * Author: Opus 4.7 (v2 with GPT P1 fixes)
 * Date: 2026-05-13
 *
 * Two-phase pre-observation script:
 *   Phase 1 (full-auto): CDP preflight — extension activation, DOM injection, execution context enumeration,
 *                         MCP connection, write gate verification, gh auth check
 *   Phase 2 (requires BRIDGE_ENABLE_WRITES=true): send test prompt, monitor interception, verify PR comment
 *
 * Usage:
 *   Phase 1 only (preflight):
 *     node l5b2-obs-mcp-write-back.cjs
 *
 *   Phase 1 + 2 (full smoke test):
 *     node l5b2-obs-mcp-write-back.cjs --full
 *
 *   Phase 2 requires BRIDGE_ENABLE_WRITES=true in the local committee-bridge env.
 *   Do not commit BRIDGE_ENABLE_WRITES=true to shared config.
 *
 * Environment:
 *   CDP_PORT=9222 (default)
 *
 * v2 Changes (addressing GPT P1-1 through P1-6):
 *   P1-1: Prompt no longer contains executable JSONL; Phase 2 records structured tool-call evidence
 *   P1-2: Phase 1 enumerates CDP execution contexts (main/isolated/extension)
 *   P1-3: Fail-closed bridge check via MCP JSON-RPC (initialize → tools/list → get_bridge_info)
 *   P1-4: Multi-line Markdown test body (pass/fail: ACK + code fence; mention neutralization = unit tests)
 *   P1-5: RUN_ID per run, createdAt filtering, exactly-1 assertion
 *   P1-6: CDP Input.insertText + submit transcript confirmation (FAIL/STOP if not confirmed)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createHash, randomUUID } = require('crypto');
const { preflight, sleep, getTargets } = require('./lib/cdp-preflight.cjs');
const {
    createMcpBridgeInventorySequence,
    extractToolNamesFromToolsList,
    extractBridgeInfoFromToolCallResult,
    evaluateWriteGate,
    classifyPhase2Verdict,
    classifyPhase1Verdict,
    repoNameMatches,
    validateEvidenceMetadata,
    buildSmokeBodyContract,
    buildComposerProbeExpression,
    classifyExecutionContexts,
} = require('./lib/l5b2-writeback-preflight.cjs');

const CDP_PORT = process.env.CDP_PORT || 9222;
const FULL_MODE = process.argv.includes('--full');

// ─── Per-run identity ──────────────────────────────────────────────────────
// P1-5: Every run gets a unique RUN_ID to prevent false positives from stale data

const RUN_ID = `L5B2-OBS-${Date.now()}-${randomUUID().slice(0, 8)}`;
const TEST_START_TIME = new Date().toISOString();
const SCRIPT_PATH = __filename;
const MCP_SUPERASSISTANT_ROOT = path.resolve(__dirname, '..');
const ROOT_REPO = path.resolve(MCP_SUPERASSISTANT_ROOT, '..');
const EXPECTED_REPO = 'Houwen-He-sti/VSCode-Dir';

// ─── CDP send helper ────────────────────────────────────────────────────────

let _counter = 0;
function cdpSend(ws, method, params = {}) {
    const id = ++_counter;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000);
        const handler = (raw) => {
            const msg = JSON.parse(raw);
            if (msg.id === id) {
                ws.removeListener('message', handler);
                clearTimeout(timer);
                if (msg.error) reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`));
                else resolve(msg.result);
            }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
    });
}

// ─── Test body (P1-4: multi-line Markdown) ─────────────────────────────────
// P1-1: NO executable JSONL in user prompt — this is the expected PR comment body only.
// P1-4: Rich multi-line body exercises: ACK marker, reviewer line, neutralized mention,
//        code fence, line count — all verifiable.

const TEST_BODY_CONTRACT = buildSmokeBodyContract({ runId: RUN_ID, reviewer: 'Notion AI' });
const TEST_BODY = TEST_BODY_CONTRACT.body;
const TEST_BODY_SHA256 = TEST_BODY_CONTRACT.sha256;

// ─── P1-1: Natural language prompt (NO executable JSONL) ────────────────────
// Instead of embedding JSONL function_call in the user message (which could be
// scanned by the stream interceptor as a false positive), we ask Notion AI
// naturally to post a comment. The MCP-SuperAssistant extension should detect
// the tool use intent from the assistant's response stream, not from the user prompt.

const TEST_PROMPT = [
    `Please post a comment on PR #97 in the Houwen-He-sti/VSCode-Dir repository.`,
    ``,
    `Use the comment_on_pr tool with these exact parameters:`,
    `- number: 97`,
    `- body: (the multi-line Markdown content below)`,
    ``,
    `Comment body content:`,
    ``,
    TEST_BODY,
].join('\n');

// ─── Observation log collector ──────────────────────────────────────────────

const evidence = {
    runId: RUN_ID,
    testStartTime: TEST_START_TIME,
    timestamp: new Date().toISOString(),
    runMetadata: collectRunMetadata({ targetUrl: null, endedAt: null }),
    phase1: {},
    phase2: null,
    structuredEvents: [],
    consoleLogs: [],
    verdict: null,
};

function log(phase, msg) {
    const line = `[${phase}] ${msg}`;
    console.log(line);
}

function execGit(cwd, args) {
    try {
        return execSync(`git ${args}`, {
            cwd,
            encoding: 'utf-8',
            timeout: 10000,
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
    } catch {
        return null;
    }
}

function collectRepoMetadata(cwd) {
    const status = execGit(cwd, 'status --porcelain') || '';
    return {
        branch: execGit(cwd, 'branch --show-current') || 'unknown',
        commit: execGit(cwd, 'rev-parse HEAD') || 'unknown',
        dirty: status.length > 0,
        untracked_files_present: status.split(/\r?\n/).some(line => line.startsWith('?? ')),
    };
}

function isScriptTracked() {
    try {
        execSync(`git ls-files --error-unmatch scripts/l5b2-obs-mcp-write-back.cjs`, {
            cwd: MCP_SUPERASSISTANT_ROOT,
            encoding: 'utf-8',
            timeout: 10000,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return true;
    } catch {
        return false;
    }
}

function collectRunMetadata({ targetUrl, endedAt }) {
    const scriptContent = fs.readFileSync(SCRIPT_PATH);
    const scriptSha256 = createHash('sha256').update(scriptContent).digest('hex');
    return {
        script_path: path.relative(ROOT_REPO, SCRIPT_PATH).replace(/\\/g, '/'),
        script_sha256: scriptSha256,
        script_git_tracked: isScriptTracked(),
        root_repo: collectRepoMetadata(ROOT_REPO),
        mcp_superassistant_repo: collectRepoMetadata(MCP_SUPERASSISTANT_ROOT),
        command: `node ${process.argv.slice(1).join(' ')}`,
        mode: FULL_MODE ? 'full' : 'phase1',
        cdp_port: Number(CDP_PORT),
        target_url: targetUrl || 'unknown',
        run_id: RUN_ID,
        started_at: TEST_START_TIME,
        ended_at: endedAt || TEST_START_TIME,
    };
}

function readCurrentGhRepoName() {
    try {
        return execSync('gh repo view --json nameWithOwner --jq .nameWithOwner', {
            cwd: ROOT_REPO,
            encoding: 'utf-8',
            timeout: 10000,
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
    } catch {
        return 'unknown';
    }
}

function validateCurrentEvidenceContext() {
    const targetUrl = evidence.runMetadata?.target_url || 'unknown';
    const metadata = collectRunMetadata({
        targetUrl,
        endedAt: new Date().toISOString(),
    });
    const validation = validateEvidenceMetadata(metadata);
    evidence.runMetadata = {
        ...metadata,
        validation,
    };
    return validation;
}

// ─── P1-2: Execution Context Enumeration ────────────────────────────────────
// Enumerate CDP execution contexts to distinguish main world / isolated world / extension context.

async function enumerateContexts(ws, options = {}) {
    log('CTX', 'Enumerating CDP execution contexts...');

    // Collect executionContextCreated events before resetting Runtime replay.
    const contexts = [];
    const contextHandler = (raw) => {
        const msg = JSON.parse(raw);
        if (msg.method === 'Runtime.executionContextCreated') {
            contexts.push(msg.params.context);
        }
    };
    ws.on('message', contextHandler);

    // Force context replay for long-lived CDP sessions where Runtime may already be enabled.
    try {
        await cdpSend(ws, 'Runtime.disable');
    } catch { /* ignore */ }

    await cdpSend(ws, 'Runtime.enable');

    // Trigger a small evaluation to ensure contexts are created
    try {
        await cdpSend(ws, 'Runtime.evaluate', {
            expression: '1+1',
            returnByValue: true,
        });
    } catch { /* ignore */ }

    // Wait a bit for context events to arrive
    await sleep(1000);
    ws.removeListener('message', contextHandler);

    // Classify contexts
    const classified = classifyExecutionContexts(contexts, {
        mcpExtensionId: options.extensionId,
        mcpExtensionName: options.extensionName,
    });

    log('CTX', `Total contexts: ${classified.total}`);
    log('CTX', `Main world contexts: ${classified.main.length}`);
    log('CTX', `Isolated world contexts: ${classified.isolated.length}`);
    log('CTX', `Extension contexts: ${classified.extension.length}`);
    for (const ext of classified.extension) {
        log('CTX', `  Extension: ${ext.name} (${ext.origin}) contextId=${ext.id}`);
    }
    log('CTX', `MCP-SuperAssistant contexts: ${classified.mcpSuperAssistant.length}`);
    log('CTX', `Other contexts: ${classified.other.length}`);

    return classified;
}

// ─── P1-3: Write Gate Pre-checks (fail-closed) ──────────────────────────────
// Before Phase 2, verify all prerequisites for write operations.
// If any check fails, canProceed = false (fail-closed).

async function checkWriteGate() {
    log('GATE', '=== Write Gate Pre-checks (fail-closed) ===');
    const results = {
        ghAuth: false,
        bridgeReachable: false,
        bridgeSessionOk: false,
        bridgeToolsListOk: false,
        bridgeWritesEnabled: false,
        commentOnPrExists: false,
        bridgeWorkspaceOk: false,
        toolNames: [],
        bridgeInfo: null,
        gateVerdict: null,
        failures: [],
    };

    // Check 1: gh auth status
    log('GATE', 'Check 1: gh auth status...');
    try {
        const ghAuth = execSync('gh auth status 2>&1', {
            encoding: 'utf-8',
            timeout: 10000,
        });
        if (ghAuth.includes('Logged in') || ghAuth.includes('github.com')) {
            results.ghAuth = true;
            log('GATE', '  ✅ gh CLI authenticated');
        } else {
            log('GATE', '  ❌ gh CLI not authenticated');
        }
    } catch (err) {
        const output = err.stdout || err.stderr || err.message;
        if (output.includes('Logged in') || output.includes('github.com')) {
            results.ghAuth = true;
            log('GATE', '  ✅ gh CLI authenticated');
        } else {
            log('GATE', `  ❌ gh CLI auth failed: ${output.substring(0, 200)}`);
        }
    }

    // Check 2: MCP proxy HTTP reachability
    log('GATE', 'Check 2: MCP proxy HTTP reachability...');
    try {
        const healthBody = await new Promise((resolve, reject) => {
            const req = http.get('http://localhost:3006/health', (res) => {
                let d = '';
                res.on('data', c => d += c);
                res.on('end', () => resolve(d));
            });
            req.on('error', reject);
            req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
        });
        log('GATE', `  ✅ MCP proxy responding: ${healthBody.substring(0, 100)}`);
        results.bridgeReachable = true;
    } catch (err) {
        log('GATE', `  ❌ MCP proxy not accessible: ${err.message}`);
    }

    // Check 3: MCP JSON-RPC session + tool inventory (fail-closed)
    log('GATE', 'Check 3: MCP JSON-RPC bridge inventory...');
    let toolsListResult = null;
    if (results.bridgeReachable) {
        try {
            const inventory = await mcpBridgeInventoryCheck();
            toolsListResult = inventory.toolsListResult;
            const bridgeInfo = inventory.bridgeInfo;
            const toolNames = extractToolNamesFromToolsList(toolsListResult);
            results.toolNames = toolNames;
            results.bridgeInfo = bridgeInfo;
            results.bridgeSessionOk = true;
            results.bridgeToolsListOk = true;
            results.bridgeWritesEnabled = bridgeInfo?.writes_enabled === true;
            results.commentOnPrExists = toolNames.includes('comment_on_pr') &&
                Array.isArray(bridgeInfo?.tools?.git_write) &&
                bridgeInfo.tools.git_write.includes('comment_on_pr');

            log('GATE', `  tools/list: ${JSON.stringify(toolNames)}`);
            log('GATE', `  Bridge info: version=${bridgeInfo?.version || bridgeInfo?.server_version || 'unknown'} tools.git_write=${JSON.stringify(bridgeInfo?.tools?.git_write || [])}`);

            if (bridgeInfo.workspace_root) {
                results.bridgeWorkspaceOk = true;
                log('GATE', `  ✅ workspace: ${bridgeInfo.workspace_root}`);
            } else {
                log('GATE', '  ⚠️  workspace_root not reported');
            }
        } catch (err) {
            log('GATE', `  ❌ Bridge JSON-RPC failed: ${err.message}`);
            log('GATE', '     Attempted: initialize → initialized → tools/list → tools/call get_bridge_info');
        }
    } else {
        log('GATE', '  ⏭️  Skipping (bridge not reachable)');
    }

    // Check 4: repo context and evidence metadata must be real, not assumed.
    log('GATE', 'Check 4: repo/evidence context...');
    const actualRepo = readCurrentGhRepoName();
    const repoMatches = repoNameMatches(actualRepo, EXPECTED_REPO);
    const metadataValidation = validateCurrentEvidenceContext();
    results.repo = { expected: EXPECTED_REPO, actual: actualRepo, matches: repoMatches };
    results.evidenceContext = metadataValidation;
    log('GATE', `  repo: actual=${actualRepo} expected=${EXPECTED_REPO} matches=${repoMatches}`);
    log('GATE', `  evidence metadata: ${metadataValidation.ok ? 'ok' : `invalid (${metadataValidation.failures.join(', ')})`}`);

    const gate = evaluateWriteGate({
        ghAuthOk: results.ghAuth,
        bridgeReachable: results.bridgeReachable,
        mcpSessionOk: results.bridgeSessionOk && results.bridgeToolsListOk,
        toolsListResult,
        bridgeInfo: results.bridgeInfo,
        repoMatches,
        evidenceContextOk: metadataValidation.ok,
    });

    results.gateVerdict = gate.verdict;
    results.failures = gate.failures;

    // Summary
    log('GATE', '');
    log('GATE', '--- Write Gate Summary (fail-closed) ---');
    log('GATE', `  gh auth:          ${results.ghAuth ? '✅' : '❌ BLOCKER'}`);
    log('GATE', `  bridge reachable: ${results.bridgeReachable ? '✅' : '❌ BLOCKER'}`);
    log('GATE', `  bridge session:   ${results.bridgeSessionOk ? '✅' : '❌ BLOCKER'}`);
    log('GATE', `  writes_enabled:   ${results.bridgeWritesEnabled ? '✅' : '❌ BLOCKER'}`);
    log('GATE', `  comment_on_pr:    ${results.commentOnPrExists ? '✅' : '❌ BLOCKER'}`);
    log('GATE', `  gate verdict:     ${results.gateVerdict}`);

    const canProceed = gate.ok;
    if (!canProceed) {
        log('GATE', '');
        log('GATE', `❌ BLOCKER: ${results.failures.length} failure(s) — cannot proceed to Phase 2`);
        for (const f of results.failures) {
            log('GATE', `   - ${f}`);
        }
    }

    return { ...results, canProceed };
}

// ─── MCP JSON-RPC helper (for bridge inventory check) ────────────────────────
let _mcpSessionId = null;

function parseMcpHttpResponse(data, expectResponse) {
    const trimmed = data.trim();
    if (!trimmed && !expectResponse) return {};
    if (!trimmed) throw new Error('empty MCP response');

    if (trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
        const dataLines = trimmed
            .split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice('data:'.length).trim())
            .filter(Boolean);
        if (dataLines.length === 0) {
            if (!expectResponse) return {};
            throw new Error(`SSE response had no data lines: ${trimmed.substring(0, 200)}`);
        }
        return JSON.parse(dataLines[dataLines.length - 1]);
    }

    return JSON.parse(trimmed);
}

function mcpPostJsonRpcBody(body, options = {}) {
    const expectResponse = options.expectResponse !== false;
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
        };
        if (_mcpSessionId) {
            headers['Mcp-Session-Id'] = _mcpSessionId;
        }

        const req = http.request({
            hostname: 'localhost',
            port: 3006,
            path: '/mcp',
            method: 'POST',
            headers,
            timeout: 10000,
        }, (res) => {
            const sessionId = res.headers['mcp-session-id'];
            if (sessionId) _mcpSessionId = sessionId;

            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const parsed = parseMcpHttpResponse(data, expectResponse);
                    if (parsed.error) reject(new Error(`JSON-RPC error: ${JSON.stringify(parsed.error)}`));
                    else resolve(parsed.result || {});
                } catch (e) {
                    reject(new Error(`MCP response parse error: ${e.message}; body=${data.substring(0, 200)}`));
                }
            });
        });

        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

async function mcpBridgeInventoryCheck() {
    _mcpSessionId = null;
    const sequence = createMcpBridgeInventorySequence({
        clientName: 'l5b2-obs-script',
        clientVersion: 'v3',
    });
    const executed = [];
    let toolsListResult = null;
    let bridgeInfo = null;

    for (const step of sequence) {
        log('GATE', `  MCP ${step.step}: ${step.body.method}`);
        const result = await mcpPostJsonRpcBody(step.body, { expectResponse: step.kind !== 'notification' });
        executed.push({ step: step.step, method: step.body.method });
        if (step.step === 'tools_list') {
            toolsListResult = result;
        }
        if (step.step === 'get_bridge_info') {
            bridgeInfo = extractBridgeInfoFromToolCallResult(result);
        }
    }

    if (!toolsListResult) {
        throw new Error('tools/list did not return a result');
    }
    if (!bridgeInfo) {
        throw new Error('get_bridge_info did not return bridge info');
    }

    return { sequence: executed, toolsListResult, bridgeInfo };
}

// ─── Phase 1: Preflight (enhanced with P1-2 and P1-3) ──────────────────────

async function phase1Preflight(ws, tab, options = {}) {
    // Wait for SPA to fully render after reload
    await sleep(3000);

    log('PHASE-1', '=== Extension & DOM Injection Check (extension-aware) ===');

    // P1-2: Enumerate execution contexts
    const contexts = await enumerateContexts(ws, options);
    evidence.phase1.contexts = {
        total: contexts.total,
        mainCount: contexts.main.length,
        isolatedCount: contexts.isolated.length,
        extensionCount: contexts.extension.length,
        otherCount: contexts.other.length,
        mcpSuperAssistantCount: contexts.mcpSuperAssistant.length,
        main: contexts.main,
        isolated: contexts.isolated,
        extension: contexts.extension,
        other: contexts.other,
        extensionContexts: contexts.extension,
        mcpSuperAssistant: contexts.mcpSuperAssistant,
        mcpSuperAssistantContexts: contexts.mcpSuperAssistant,
    };

    // Check 1: Extension DOM injection signals
    const domSignals = await cdpSend(ws, 'Runtime.evaluate', {
        expression: `(function() {
            return JSON.stringify({
                mcpPopover: !!document.querySelector('.mcp-popover'),
                dataMcpSuperassistant: !!document.querySelector('[data-mcp-superassistant]'),
                dataMcpProcessed: !!document.querySelector('[data-mcp-processed]'),
                functionResultContainers: document.querySelectorAll('.function-result-container, .function-result-batch-container').length,
                toolLoopElements: document.querySelectorAll('[data-tool-loop], [class*="tool-loop"]').length,
                mcpElements: document.querySelectorAll('[class*="mcp-"]').length,
                shadowHosts: document.querySelectorAll('[data-shadow-host], [class*="shadow"]').length,
            });
        })()`,
        returnByValue: true,
    });
    const dom = JSON.parse(domSignals.result.value);
    log('PHASE-1', `DOM injection: mcpPopover=${dom.mcpPopover} dataMcpSuperassistant=${dom.dataMcpSuperassistant} mcpElements=${dom.mcpElements}`);
    evidence.phase1.domInjection = dom;

    // Check 2: Global extension state (may be in isolated world — not accessible from main world)
    const globals = await cdpSend(ws, 'Runtime.evaluate', {
        expression: `(function() {
            const found = {};
            ['__MCP_SUPERASSISTANT__', '__TOOL_LOOP__', '__BRIDGE__',
             '__functionCallExtractor', 'mcpSuperAssistant', 'toolLoopState',
             'mcpClient', 'streamToolBridge'].forEach(key => {
                try { if (window[key]) found[key] = typeof window[key]; } catch(e) {}
            });
            return JSON.stringify(found);
        })()`,
        returnByValue: true,
    });
    const globalState = JSON.parse(globals.result.value);
    log('PHASE-1', `Global state: ${JSON.stringify(globalState)}`);
    evidence.phase1.globals = globalState;

    // Check 3: MCP proxy health (if accessible from main world)
    const proxyHealth = await cdpSend(ws, 'Runtime.evaluate', {
        expression: `(async function() {
            try {
                const resp = await fetch('http://localhost:3006/health', { method: 'GET' });
                const text = await resp.text();
                return JSON.stringify({ status: 'ok', body: text.substring(0, 200) });
            } catch(e) {
                return JSON.stringify({ status: 'error', message: e.message });
            }
        })()`,
        awaitPromise: true,
        returnByValue: true,
    });
    const proxy = JSON.parse(proxyHealth.result.value);
    log('PHASE-1', `MCP proxy: ${proxy.status} ${proxy.body || proxy.message || ''}`);
    evidence.phase1.mcpProxy = proxy;

    // Check 4: Notion AI composer/input presence (empty state)
    const composerCheck = await cdpSend(ws, 'Runtime.evaluate', {
        expression: buildComposerProbeExpression(),
        returnByValue: true,
    });
    const composer = JSON.parse(composerCheck.result.value);
    log('PHASE-1', `Composer (empty): hasInput=${composer.hasInput} hasSubmitButton=${composer.hasSubmitButton}`);
    evidence.phase1.composer = composer;

    // Check 4b: Notion AI composer/input presence (with text — submit button may appear only when input has content)
    const composerWithText = await cdpSend(ws, 'Runtime.evaluate', {
        expression: buildComposerProbeExpression({ insertText: 'test' }),
        returnByValue: true,
    });
    const composerTextState = JSON.parse(composerWithText.result.value);
    log('PHASE-1', `Composer (with text): hasSubmitButton=${composerTextState.hasSubmitButton} visible=${composerTextState.submitButtonVisible}`);
    evidence.phase1.composerWithText = composerTextState;

    // Check 5: URL and page context
    evidence.phase1.pageUrl = tab.url;
    evidence.phase1.isOnChatPage = tab.url.includes('/chat') || tab.url.includes('/ai');

    // Verdict
    const extActivated = dom.mcpPopover || dom.dataMcpSuperassistant || dom.mcpElements > 0;
    const hasInput = composer.hasInput;
    const hasSubmitButtonEmpty = composer.hasSubmitButton;
    const hasSubmitButtonWithText = composerTextState.hasSubmitButton;
    const submitButtonVisible = composerTextState.submitButtonVisible;
    const canSubmit = hasInput && (hasSubmitButtonEmpty || hasSubmitButtonWithText);

    const blockers = [];
    const warnings = [];

    if (!extActivated) {
        blockers.push('Extension DOM injection not detected');
    }
    if (!hasInput) {
        blockers.push('Composer input not found');
    }
    if (hasInput && !canSubmit) {
        blockers.push('Submit button not detected (empty or with text)');
    }
    if (canSubmit && !submitButtonVisible) {
        warnings.push('Submit button detected but not visible — may need CSS inspection');
    }

    // Bridge check result
    if (evidence.phase1.mcpProxy && evidence.phase1.mcpProxy.status === 'error') {
        warnings.push('Bridge MCP not reachable (localhost:3006) — Phase 2 blocked');
    }

    let preflightLevel = classifyPhase1Verdict({
        domComposerObserved: extActivated && hasInput && canSubmit,
        bridgeInventoryOk: false,
    });
    if (!extActivated) {
        preflightLevel = 'PREFLIGHT_BLOCKED_NO_EXTENSION';
    } else if (!hasInput) {
        preflightLevel = 'PREFLIGHT_BLOCKED_NO_INPUT';
    } else if (!canSubmit) {
        preflightLevel = 'PREFLIGHT_BLOCKED_SUBMIT_SELECTOR';
    }

    evidence.preflightLevel = preflightLevel;
    evidence.blockers = blockers;
    evidence.warnings = warnings;

    log('PHASE-1', '');
    log('PHASE-1', '--- Phase 1 Verdict ---');
    log('PHASE-1', `Preflight level: ${preflightLevel}`);
    if (blockers.length > 0) {
        log('PHASE-1', `Blockers: ${blockers.join('; ')}`);
    }
    if (warnings.length > 0) {
        log('PHASE-1', `Warnings: ${warnings.join('; ')}`);
    }
    log('PHASE-1', '');
    if (extActivated) {
        log('PHASE-1', '✅ Extension: MCP-SuperAssistant DOM injection detected');
    } else {
        log('PHASE-1', '❌ Extension: No DOM injection signals — extension may not be active on this page');
        log('PHASE-1', '   Try: reload extension, then refresh Notion page');
    }
    if (contexts.extension.length > 0) {
        log('PHASE-1', `✅ Extension context: ${contexts.extension.length} extension execution context(s) found`);
    } else {
        log('PHASE-1', '⚠️  Extension context: No extension execution contexts found');
        log('PHASE-1', '   Extension scripts may not be loaded on this page');
    }
    if (globalState.mcpClient || globalState.streamToolBridge) {
        log('PHASE-1', '✅ MCP Client: mcpClient/streamToolBridge accessible from main world');
    } else if (dom.mcpPopover || dom.mcpElements > 0) {
        log('PHASE-1', '⚠️  MCP Client: not accessible from main world (expected — runs in isolated world)');
        log('PHASE-1', '   Extension active via DOM signals, isolated world access is normal');
    } else {
        log('PHASE-1', '❌ MCP Client: no signals — extension likely not loaded');
    }
    if (canSubmit) {
        log('PHASE-1', `✅ Composer: input found, submit button ${hasSubmitButtonEmpty ? '(empty state)' : '(with text)'} visible=${submitButtonVisible}`);
    } else {
        log('PHASE-1', '❌ Composer: input or submit button missing — navigate to Notion AI chat page');
    }
    if (evidence.phase1.isOnChatPage) {
        log('PHASE-1', '✅ Page context: on Notion AI /chat or /ai page');
    } else {
        log('PHASE-1', '⚠️  Page context: NOT on /chat or /ai — may need navigation');
    }

    return { extActivated, canSubmit, contexts, preflightLevel, blockers, warnings };
}

// ─── Phase 2: Full Smoke Test (P1-6: CDP Input.insertText) ──────────────────

async function phase2SmokeTest(ws) {
    log('PHASE-2', '=== Full Smoke Test ===');
    evidence.phase2 = {};

    // P1-3: Re-check write gate before proceeding
    log('PHASE-2', 'Pre-flight write gate check...');
    const gate = await checkWriteGate();
    if (!gate.canProceed) {
        log('PHASE-2', '❌ Write gate check failed — cannot proceed to Phase 2');
        evidence.phase2.gateCheck = gate;
        return false;
    }
    if (!gate.bridgeWriteGate) {
        log('PHASE-2', '⚠️  BRIDGE_ENABLE_WRITES not confirmed as "true" — write may fail');
        log('PHASE-2', '   Continuing anyway to observe the failure path...');
    }
    evidence.phase2.gateCheck = gate;

    // Step 1: Collect console messages during test
    const consoleMessages = [];
    const consoleHandler = (raw) => {
        const msg = JSON.parse(raw);
        if (msg.method === 'Runtime.consoleAPICalled') {
            const args = msg.params.args.map(a => a.value || a.description || '').join(' ');
            consoleMessages.push({
                type: msg.params.type,
                text: args.substring(0, 500),
                timestamp: Date.now(),
            });
        }
    };
    await cdpSend(ws, 'Runtime.enable');
    await cdpSend(ws, 'Log.enable');
    ws.on('message', consoleHandler);

    // Step 2: P1-6 — Insert test prompt using CDP Input.insertText (reliable for contenteditable)
    log('PHASE-2', 'Step 2: Inserting test prompt via CDP Input.insertText...');
    await sleep(500);

    // First, focus the input element
    const focusResult = await cdpSend(ws, 'Runtime.evaluate', {
        expression: `(function() {
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]')
                || document.querySelector('[class*="notion-ai"] [contenteditable="true"]');
            if (!input) return JSON.stringify({ error: 'no input found' });
            input.focus();
            // Select all existing content to replace it
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(input);
            selection.removeAllRanges();
            selection.addRange(range);
            return JSON.stringify({ focused: true, existingContent: input.textContent.substring(0, 100) });
        })()`,
        returnByValue: true,
    });
    const focus = JSON.parse(focusResult.result.value);
    log('PHASE-2', `Focus: ${JSON.stringify(focus)}`);

    if (focus.error) {
        log('PHASE-2', `❌ Cannot focus input: ${focus.error}`);
        return false;
    }

    // P1-6: Use CDP Input.insertText instead of textContent + input event
    // Input.insertText is the native browser input method — it triggers
    // all the correct DOM events and React state updates
    await cdpSend(ws, 'Input.insertText', { text: TEST_PROMPT });
    await sleep(500);

    // Verify insertion
    const verifyResult = await cdpSend(ws, 'Runtime.evaluate', {
        expression: `(function() {
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]')
                || document.querySelector('[class*="notion-ai"] [contenteditable="true"]');
            if (!input) return JSON.stringify({ error: 'no input found after insert' });
            return JSON.stringify({
                contentLen: input.textContent.length,
                contentPreview: input.textContent.substring(0, 150),
                hasContent: input.textContent.length > 10,
            });
        })()`,
        returnByValue: true,
    });
    const verify = JSON.parse(verifyResult.result.value);
    log('PHASE-2', `Verify: ${JSON.stringify(verify)}`);
    evidence.phase2.insert = { method: 'CDP_Input_insertText', ...verify };

    if (!verify.hasContent) {
        log('PHASE-2', '❌ Input insertion failed — content is empty');
        return false;
    }

    // Step 3: P1-6 — Submit the prompt using scoped selector
    log('PHASE-2', 'Step 3: Submitting prompt...');
    await sleep(500);

    const submitResult = await cdpSend(ws, 'Runtime.evaluate', {
        expression: `(function() {
            // P1-6: Scope submit button search to the composer area
            // Look for the submit button near the input
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            const form = input ? input.closest('form') : null;

            // Try form submit first (most reliable)
            if (form) {
                const submitBtn = form.querySelector('button[type="submit"]');
                if (submitBtn) {
                    submitBtn.click();
                    return JSON.stringify({ method: 'form-submit-button', label: submitBtn.getAttribute('aria-label') || 'submit' });
                }
                form.requestSubmit();
                return JSON.stringify({ method: 'form-requestSubmit' });
            }

            // Fallback: search in nearby container
            const composerContainer = input ? input.closest('[class*="composer"], [class*="input"], [class*="chat"]') : null;
            if (composerContainer) {
                const submitBtn = composerContainer.querySelector('button[type="submit"], [aria-label="\u53d1\u9001"], [aria-label="Send"]');
                if (submitBtn) {
                    submitBtn.click();
                    return JSON.stringify({ method: 'container-button', label: submitBtn.getAttribute('aria-label') || submitBtn.type });
                }
            }

            // Global fallback
            const globalBtn = document.querySelector('button[type="submit"]');
            if (globalBtn) {
                globalBtn.click();
                return JSON.stringify({ method: 'global-submit', label: globalBtn.getAttribute('aria-label') || 'submit' });
            }

            return JSON.stringify({ error: 'no submit mechanism found' });
        })()`,
        returnByValue: true,
    });
    const submit = JSON.parse(submitResult.result.value);
    log('PHASE-2', `Submit: ${JSON.stringify(submit)}`);

    if (submit.error) {
        // Fallback: try Enter key
        log('PHASE-2', 'Trying Enter key fallback...');
        await cdpSend(ws, 'Input.dispatchKeyEvent', {
            type: 'keyDown', key: 'Enter', code: 'Enter',
            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
        });
        await cdpSend(ws, 'Input.dispatchKeyEvent', {
            type: 'keyUp', key: 'Enter', code: 'Enter',
            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
        });
    }

    // Step 4: Wait for Notion AI to process and generate response
    log('PHASE-2', 'Step 4: Waiting for Notion AI response (up to 90s)...');
    const startTime = Date.now();
    const TIMEOUT_MS = 90000;
    const structuredEvents = [];
    let functionCallDetected = false;
    let interceptionDetected = false;
    let transcriptConfirmed = false;

    while (Date.now() - startTime < TIMEOUT_MS) {
        await sleep(3000);

        // Check console for function_call interception logs
        const recentLogs = consoleMessages.filter(m =>
            m.text.includes('function_call') ||
            m.text.includes('comment_on_pr') ||
            m.text.includes('callTool') ||
            m.text.includes('mcp') ||
            m.text.includes('tool') ||
            m.text.includes('bridge') ||
            m.text.includes('WRITES_DISABLED') ||
            m.text.includes('error')
        );

        if (recentLogs.length > 0) {
            log('PHASE-2', `Console signals: ${recentLogs.length} relevant messages`);
            for (const logEntry of recentLogs) {
                log('PHASE-2', `  [${logEntry.type}] ${logEntry.text.substring(0, 200)}`);

                // P1-1: Record structured events with sourceConfidence
                if (logEntry.text.includes('function_call') && !functionCallDetected) {
                    functionCallDetected = true;
                    // Try to extract identity from console text
                    const identityMatch = logEntry.text.match(/comment_on_pr|"name"\s*:\s*"comment_on_pr"/);
                    const callIdMatch = logEntry.text.match(/callId['":\s]+([a-f0-9-]+)/i);
                    structuredEvents.push({
                        type: 'assistant_function_call_detected',
                        source: 'console_keyword',
                        sourceConfidence: 'low',
                        data: {
                            raw: logEntry.text.substring(0, 300),
                            hasCommentOnPr: !!identityMatch,
                            callId: callIdMatch ? callIdMatch[1] : null,
                        },
                        timestamp: logEntry.timestamp,
                    });
                    log('PHASE-2', '✅ function_call detected in console');
                }
                if (logEntry.text.includes('callTool') && !interceptionDetected) {
                    interceptionDetected = true;
                    structuredEvents.push({
                        type: 'call_tool_invoked',
                        source: 'console_keyword',
                        sourceConfidence: 'low',
                        data: {
                            raw: logEntry.text.substring(0, 300),
                            toolName: logEntry.text.includes('comment_on_pr') ? 'comment_on_pr' : 'unknown',
                        },
                        timestamp: logEntry.timestamp,
                    });
                    log('PHASE-2', '✅ callTool() detected — MCP interception confirmed');
                }
            }
        }

        // P1-6: Check transcript for user message confirmation
        const transcriptCheck = await cdpSend(ws, 'Runtime.evaluate', {
            expression: `(function() {
                // Search for user message containing RUN_ID or test body fragment
                const allMessages = document.querySelectorAll('[data-message-id], [class*="message"], [class*="chat"]');
                for (const el of allMessages) {
                    const text = el.textContent || '';
                    if (text.includes('${RUN_ID}') || text.includes('L5B-2 Pre-Observation Test')) {
                        return JSON.stringify({ found: true, preview: text.substring(0, 200) });
                    }
                }
                // Fallback: search entire body
                const bodyText = document.body.innerText;
                if (bodyText.includes('${RUN_ID}')) {
                    return JSON.stringify({ found: true, preview: '(found in body text)', method: 'body' });
                }
                return JSON.stringify({ found: false });
            })()`,
            returnByValue: true,
        });
        const transcript = JSON.parse(transcriptCheck.result.value);
        if (transcript.found && !transcriptConfirmed) {
            transcriptConfirmed = true;
            log('PHASE-2', `✅ Transcript confirmation: user message found`);
            structuredEvents.push({
                type: 'user_message_confirmed',
                source: 'dom_transcript',
                sourceConfidence: 'high',
                data: { preview: transcript.preview.substring(0, 200) },
                timestamp: Date.now(),
            });
        }

        // Check if Notion AI has finished generating (input is empty and no stop button)
        const doneCheck = await cdpSend(ws, 'Runtime.evaluate', {
            expression: `(function() {
                const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
                const stopBtn = document.querySelector('[aria-label="\u505c\u6b62"], [aria-label="Stop"]');
                return JSON.stringify({
                    inputEmpty: input ? input.textContent.length < 5 : false,
                    hasStopButton: !!stopBtn,
                    generating: !!stopBtn,
                });
            })()`,
            returnByValue: true,
        });
        const done = JSON.parse(doneCheck.result.value);
        log('PHASE-2', `Status: generating=${done.generating} inputEmpty=${done.inputEmpty} (${Math.round((Date.now() - startTime) / 1000)}s)`);

        // P1-6: Fail-fast if submit not confirmed after 30s
        if (!transcriptConfirmed && Date.now() - startTime > 30000) {
            log('PHASE-2', '❌ FAIL_SUBMIT_NOT_CONFIRMED: user message not found in transcript after 30s');
            log('PHASE-2', '   Stopping — not waiting for assistant/tool-call');
            evidence.phase2.submitConfirmed = false;
            evidence.phase2.structuredEvents = structuredEvents;
            evidence.verdict = 'FAIL_SUBMIT_NOT_CONFIRMED';
            ws.removeListener('message', consoleHandler);
            return false;
        }

        if (!done.generating && done.inputEmpty && Date.now() - startTime > 5000) {
            log('PHASE-2', 'Notion AI appears to have finished');
            break;
        }
    }

    // Step 5: Extract Notion AI response
    log('PHASE-2', 'Step 5: Extracting Notion AI response...');
    const responseResult = await cdpSend(ws, 'Runtime.evaluate', {
        expression: `(function() {
            // Look for the last assistant response in the chat
            const chatContent = document.querySelector('[class*="chat-content"], [class*="notion-ai"]');
            if (!chatContent) {
                // Fallback: get all visible text
                const allText = document.body.innerText;
                return JSON.stringify({ method: 'body', text: allText.substring(allText.length - 2000) });
            }
            return JSON.stringify({ method: 'chat', text: chatContent.textContent.substring(chatContent.textContent.length - 2000) });
        })()`,
        returnByValue: true,
    });
    const response = JSON.parse(responseResult.result.value);
    log('PHASE-2', `Response (${response.method}): ${response.text.substring(0, 300)}...`);
    evidence.phase2.response = response;

    // Step 6: P1-5 — Check PR #97 for new comments with RUN_ID filtering and exactly-1 assertion
    log('PHASE-2', 'Step 6: Checking PR #97 for new comments via gh CLI...');
    try {
        const prCommentsRaw = execSync('gh pr view 97 --json comments --repo Houwen-He-sti/VSCode-Dir', {
            encoding: 'utf-8',
            timeout: 15000,
        });
        const prData = JSON.parse(prCommentsRaw);
        const comments = prData.comments || [];

        log('PHASE-2', `PR #97 has ${comments.length} total comments`);

        // P1-5: Filter by createdAt >= testStartTime AND RUN_ID
        const testTimeMs = new Date(TEST_START_TIME).getTime();
        const postTestComments = comments.filter(c => {
            const commentTime = new Date(c.createdAt).getTime();
            return commentTime >= testTimeMs;
        });
        log('PHASE-2', `Comments after test start (${TEST_START_TIME}): ${postTestComments.length}`);

        // Look for our test comment by RUN_ID (unique per run), scoped to this run window.
        const matchingComments = postTestComments.filter(c =>
            c.body && c.body.includes(RUN_ID)
        );
        log('PHASE-2', `Comments matching RUN_ID ${RUN_ID}: ${matchingComments.length}`);

        if (matchingComments.length === 0) {
            log('PHASE-2', '❌ No test comment found on PR #97');
            evidence.phase2.prComment = { found: false, totalComments: comments.length, transcriptConfirmed };
        } else if (matchingComments.length > 1) {
            // P1-5: Exactly-1 assertion
            log('PHASE-2', `⚠️  Multiple comments match RUN_ID (${matchingComments.length}) — exactly-1 expected`);
            log('PHASE-2', '   This indicates a re-run or duplicate submission');
            for (const mc of matchingComments) {
                log('PHASE-2', `   Comment ID: ${mc.id} by ${mc.author?.login} at ${mc.createdAt}`);
            }
            evidence.phase2.prComment = {
                found: true,
                count: matchingComments.length,
                assertionFailed: true,
                comments: matchingComments.map(c => ({ id: c.id, author: c.author?.login, createdAt: c.createdAt })),
            };
        } else {
            const testComment = matchingComments[0];

            log('PHASE-2', '✅ Test comment found on PR #97 (exactly 1)');
            log('PHASE-2', `  ID: ${testComment.id}`);
            log('PHASE-2', `  Author: ${testComment.author?.login || 'unknown'}`);
            log('PHASE-2', `  Created: ${testComment.createdAt}`);

            // Compute SHA-256 of the body
            const bodySha256 = createHash('sha256').update(testComment.body).digest('hex');
            log('PHASE-2', `  Body SHA-256: ${bodySha256}`);
            log('PHASE-2', `  Expected SHA-256: ${TEST_BODY_SHA256}`);

            // P1-4: Exact-body verification (multi-line)
            const exactMatch = testComment.body === TEST_BODY;
            log('PHASE-2', `  Exact body match: ${exactMatch}`);
            if (!exactMatch) {
                log('PHASE-2', `  Body diff: expected ${TEST_BODY.length} chars, got ${testComment.body.length} chars`);
                // Show first difference
                for (let i = 0; i < Math.max(TEST_BODY.length, testComment.body.length); i++) {
                    if (TEST_BODY[i] !== testComment.body[i]) {
                        log(`PHASE-2`, `  First diff at char ${i}: expected "${TEST_BODY.substring(i, i + 20)}", got "${testComment.body.substring(i, i + 20)}"`);
                        break;
                    }
                }
            }

            evidence.phase2.prComment = {
                found: true,
                id: testComment.id,
                author: testComment.author?.login,
                createdAt: testComment.createdAt,
                bodySha256,
                expectedSha256: TEST_BODY_SHA256,
                exactMatch,
                bodyLength: testComment.body.length,
                // P1-4: verify multi-line body
                lineCount: testComment.body.split('\n').length,
                hasAckMarker: testComment.body.includes(TEST_BODY_CONTRACT.ack),
                hasRunId: testComment.body.includes(RUN_ID),
                hasCodeFence: testComment.body.includes('```text'),
                // P1-4: mention neutralization verified by unit tests, not here
            };
        }

        evidence.phase2.prCommentsRaw = comments.length;
        evidence.phase2.testStartTime = TEST_START_TIME;
        evidence.phase2.postTestComments = postTestComments.length;
    } catch (err) {
        log('PHASE-2', `❌ gh CLI error: ${err.message}`);
        evidence.phase2.ghError = err.message;
    }

    // Step 7: Collect all console messages + structured events
    ws.removeListener('message', consoleHandler);
    evidence.phase2.consoleMessages = consoleMessages;
    evidence.phase2.structuredEvents = structuredEvents;
    evidence.phase2.transcriptConfirmed = transcriptConfirmed;

    log('PHASE-2', '');
    log('PHASE-2', `--- Console messages captured: ${consoleMessages.length} ---`);
    log('PHASE-2', `--- Structured events: ${structuredEvents.length} ---`);
    for (const ev of structuredEvents) {
        log(`PHASE-2`, `  [${ev.type}] source=${ev.source} confidence=${ev.sourceConfidence}`);
    }
    const relevantLogs = consoleMessages.filter(m =>
        m.text.includes('function_call') || m.text.includes('comment_on_pr') ||
        m.text.includes('callTool') || m.text.includes('mcp') ||
        m.text.includes('bridge') || m.text.includes('error') ||
        m.text.includes('WRITES')
    );
    for (const m of relevantLogs) {
        log('PHASE-2', `  [${m.type}] ${m.text.substring(0, 300)}`);
    }

    // Step 8: Verdict
    log('PHASE-2', '');
    log('PHASE-2', '--- Phase 2 Verdict ---');

    // P1-1: Full PASS requires structured tool-call evidence chain
    const hasStructuredFunctionCall = structuredEvents.some(e => e.type === 'assistant_function_call_detected');
    const hasStructuredCallTool = structuredEvents.some(e => e.type === 'call_tool_invoked');

    const commentCountExceeded = evidence.phase2.prComment?.assertionFailed === true;

    const phase2Verdict = classifyPhase2Verdict({
        submitConfirmed: evidence.phase2.transcriptConfirmed,
        commentFound: evidence.phase2.prComment?.found === true,
        exactMatch: evidence.phase2.prComment?.exactMatch === true,
        hasAssistantFunctionCall: hasStructuredFunctionCall,
        hasCallToolInvocation: hasStructuredCallTool,
        commentCountExceeded,
    });

    // Coverage markers: explicitly record which steps are NOT covered in this run
    const coverageMarkers = {
        step7_exactly_once_beyond_comment_count: false,
        step8_failure_path: false,
        step9_result_injection: false,
    };
    evidence.coverageMarkers = coverageMarkers;

    if (!coverageMarkers.step7_exactly_once_beyond_comment_count) {
        log('PHASE-2', 'ℹ️  Step 7 (exactly-once beyond comment count): NOT VERIFIED in this run');
    }
    if (!coverageMarkers.step8_failure_path) {
        log('PHASE-2', 'ℹ️  Step 8 (failure-path: WRITES_DISABLED / invalid PR): NOT EXECUTED in this run');
    }
    if (!coverageMarkers.step9_result_injection) {
        log('PHASE-2', 'ℹ️  Step 9 (function_result injection into Notion AI): NOT VERIFIED in this run');
    }

    if (phase2Verdict === 'PASS_HAPPY_PATH_ONLY') {
        log('PHASE-2', '✅ PASS_HAPPY_PATH_ONLY: Happy-path write-back verified (exact body match)');
        log('PHASE-2', '   Notion AI → MCP-SuperAssistant → committee-bridge → GitHub API');
        log('PHASE-2', `   Comment ID: ${evidence.phase2.prComment.id}`);
        log('PHASE-2', `   RUN_ID: ${RUN_ID}`);
        log('PHASE-2', `   Structured events: ${structuredEvents.length}`);
        log('PHASE-2', '   ⚠️  This is NOT full 10-step smoke acceptance.');
        log('PHASE-2', '   Step 7/8/9 were not verified. See coverageMarkers in evidence JSON.');
        evidence.verdict = 'PASS_HAPPY_PATH_ONLY';
    } else if (phase2Verdict === 'FAIL_DUPLICATE_OR_STALE_MATCH') {
        log('PHASE-2', '❌ FAIL: Multiple comments match RUN_ID — exactly-1 expected');
        log('PHASE-2', '   Indicates re-run or duplicate submission');
        evidence.verdict = phase2Verdict;
    } else if (phase2Verdict === 'PARTIAL_EXACT_COMMENT_WITHOUT_TOOL_EVIDENCE') {
        log('PHASE-2', '⚠️  PARTIAL: Exact comment found but structured tool-call evidence is incomplete');
        log('PHASE-2', '   This cannot be accepted as full Notion MCP write-back evidence');
        evidence.verdict = phase2Verdict;
    } else if (phase2Verdict === 'PARTIAL_BODY_MISMATCH') {
        log('PHASE-2', '⚠️  PARTIAL: Comment found but body mismatch');
        log('PHASE-2', '   Possible: MCP connector modified the body');
        evidence.verdict = phase2Verdict;
    } else if (phase2Verdict === 'PARTIAL_TOOL_CALL_WITHOUT_COMMENT') {
        log('PHASE-2', '⚠️  PARTIAL: Structured function_call detected but comment not on PR');
        log('PHASE-2', '   Possible: WRITES_DISABLED, gh auth issue, or wrong PR number');
        evidence.verdict = phase2Verdict;
    } else if (phase2Verdict === 'FAIL_SUBMIT_NOT_CONFIRMED') {
        log('PHASE-2', '❌ FAIL: Submit not confirmed (P1-6)');
        evidence.verdict = phase2Verdict;
    } else {
        log('PHASE-2', '❌ FAIL: No structured tool-call evidence detected');
        log('PHASE-2', '   Possible causes:');
        log('PHASE-2', '   1. Notion AI did not generate function_call');
        log('PHASE-2', '   2. MCP-SuperAssistant stream interceptor not active');
        log('PHASE-2', '   3. committee-bridge tools not injected via bridge prompt');
        log('PHASE-2', `   Structured events captured: ${structuredEvents.length}`);
        evidence.verdict = phase2Verdict;
    }

    // Never return true for PASS — this script only does happy-path smoke
    return false;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
    console.log('L5B-2 Pre-Observation v2: Notion AI → MCP-SuperAssistant → committee-bridge → GitHub API');
    console.log('='.repeat(70));
    console.log(`Mode: ${FULL_MODE ? 'FULL (Phase 1 + 2)' : 'PREFLIGHT ONLY (Phase 1)'}`);
    console.log(`RUN_ID: ${RUN_ID}`);
    console.log(`TEST_START_TIME: ${TEST_START_TIME}`);
    console.log('');

    // Step 0: CDP preflight (extension + page)
    let preflightResult;
    try {
        preflightResult = await preflight();
    } catch (err) {
        console.error(`❌ Preflight failed: ${err.message}`);
        console.error('   Ensure Chrome is running with --remote-debugging-port=9222');
        console.error('   And MCP-SuperAssistant extension is loaded');
        process.exit(1);
    }

    const { tab, extensionId, extensionName } = preflightResult;
    evidence.runMetadata = collectRunMetadata({ targetUrl: tab.url, endedAt: null });
    console.log(`✅ Extension: ${extensionName} (${extensionId})`);
    console.log(`✅ Page: ${tab.url.substring(0, 80)}`);
    console.log('');

    // Connect to Notion tab
    const WebSocket = require('ws');
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

    try {
        // Phase 1: Preflight
        const { extActivated, canSubmit, contexts, preflightLevel, blockers, warnings } = await phase1Preflight(ws, tab, {
            extensionId,
            extensionName,
        });

        if (!FULL_MODE) {
            log('PHASE-1', '');
            log('PHASE-1', 'Phase 1 complete. Run with --full for Phase 2 (requires BRIDGE_ENABLE_WRITES=true).');
            // Use the computed preflightLevel from phase1Preflight
            evidence.verdict = preflightLevel;
        } else {
            // Phase 2: Full smoke test
            if (blockers.length > 0) {
                console.error(`❌ Cannot proceed to Phase 2: ${blockers.join('; ')}`);
                console.error('   Fix blockers before running Phase 2');
                process.exit(1);
            }
            if (!extActivated) {
                console.error('❌ Cannot proceed to Phase 2: Extension not active');
                console.error('   Reload MCP-SuperAssistant extension and refresh Notion page');
                process.exit(1);
            }

            await phase2SmokeTest(ws);
        }
    } finally {
        ws.close();
    }

    // Write evidence file
    const endedAt = new Date().toISOString();
    const targetUrl = evidence.runMetadata?.target_url || tab?.url || 'unknown';
    evidence.runMetadata = collectRunMetadata({ targetUrl, endedAt });
    evidence.runMetadata.validation = validateEvidenceMetadata(evidence.runMetadata);
    const evidencePath = `l5b2-obs-mcp-write-back-${RUN_ID}.json`;
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.log(`\nEvidence written to: ${evidencePath}`);

    // Also write a stable symlink-like file for latest
    fs.writeFileSync('l5b2-obs-mcp-write-back-evidence.json', JSON.stringify(evidence, null, 2));
    console.log(`Latest evidence: l5b2-obs-mcp-write-back-evidence.json`);
}

main().catch(err => {
    console.error(`❌ Fatal: ${err.message}`);
    process.exit(1);
});
