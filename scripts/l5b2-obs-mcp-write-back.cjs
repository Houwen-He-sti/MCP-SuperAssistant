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
 *   Phase 2 requires BRIDGE_ENABLE_WRITES=true in committee-bridge env.
 *   If running under VS Code Roo, temporarily set in config/mcp-servers.json:
 *     "BRIDGE_ENABLE_WRITES": "true"
 *   Then reconnect the MCP server. Revert after smoke test.
 *
 * Environment:
 *   CDP_PORT=9222 (default)
 *
 * v2 Changes (addressing GPT P1-1 through P1-6):
 *   P1-1: Prompt no longer contains executable JSONL — uses natural language tool request
 *   P1-2: Phase 1 enumerates CDP execution contexts (main/isolated/extension)
 *   P1-3: Pre-Phase 2 checks: gh auth, write gate, comment_on_pr availability
 *   P1-4: Multi-line Markdown test body with ACK, reviewer line, neutralized mention, code fence
 *   P1-5: RUN_ID per run, createdAt filtering, exactly-1 assertion
 *   P1-6: CDP Input.insertText for reliable contenteditable injection
 */

const http = require('http');
const { execSync } = require('child_process');
const { createHash, randomUUID } = require('crypto');
const { preflight, sleep, getTargets } = require('./lib/cdp-preflight.cjs');

const CDP_PORT = process.env.CDP_PORT || 9222;
const FULL_MODE = process.argv.includes('--full');

// ─── Per-run identity ──────────────────────────────────────────────────────
// P1-5: Every run gets a unique RUN_ID to prevent false positives from stale data

const RUN_ID = `L5B2-OBS-${Date.now()}-${randomUUID().slice(0, 8)}`;
const TEST_START_TIME = new Date().toISOString();

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

const TEST_BODY = [
    `## L5B-2 Pre-Observation Test`,
    ``,
    `**Run ID:** \`${RUN_ID}\``,
    `**ACK:** L5B2-OBS-MCP-001`,
    `**Reviewer:** @opu-47 (neutralized — actual mention suppressed)`,
    ``,
    `### Verification Checklist`,
    ``,
    `- [x] ACK marker present`,
    `- [x] Multi-line body`,
    `- [x] Code fence below`,
    ``,
    `\`\`\`json`,
    `{`,
    `  "test": true,`,
    `  "run_id": "${RUN_ID}",`,
    `  "source": "l5b2-obs-mcp-write-back.cjs",`,
    `  "timestamp": "${TEST_START_TIME}"`,
    `}`,
    `\`\`\``,
    ``,
    `> Line count: 20+ lines — tests multi-line comment body handling.`,
    `> Author: Opus 4.7 via MCP-SuperAssistant → committee-bridge → GitHub API`,
].join('\n');

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
    `## L5B-2 Pre-Observation Test`,
    ``,
    `**Run ID:** \`${RUN_ID}\``,
    `**ACK:** L5B2-OBS-MCP-001`,
    `**Reviewer:** @opu-47 (neutralized — actual mention suppressed)`,
    ``,
    `### Verification Checklist`,
    ``,
    `- [x] ACK marker present`,
    `- [x] Multi-line body`,
    `- [x] Code fence below`,
    ``,
    `\`\`\`json`,
    `{`,
    `  "test": true,`,
    `  "run_id": "${RUN_ID}",`,
    `  "source": "l5b2-obs-mcp-write-back.cjs",`,
    `  "timestamp": "${TEST_START_TIME}"`,
    `}`,
    `\`\`\``,
    ``,
    `> Line count: 20+ lines — tests multi-line comment body handling.`,
    `> Author: Opus 4.7 via MCP-SuperAssistant → committee-bridge → GitHub API`,
].join('\n');

// ─── Observation log collector ──────────────────────────────────────────────

const evidence = {
    runId: RUN_ID,
    testStartTime: TEST_START_TIME,
    timestamp: new Date().toISOString(),
    phase1: {},
    phase2: null,
    consoleLogs: [],
    verdict: null,
};

function log(phase, msg) {
    const line = `[${phase}] ${msg}`;
    console.log(line);
}

// ─── P1-2: Execution Context Enumeration ────────────────────────────────────
// Enumerate CDP execution contexts to distinguish main world / isolated world / extension context.

async function enumerateContexts(ws) {
    log('CTX', 'Enumerating CDP execution contexts...');

    // Enable runtime to receive context events
    await cdpSend(ws, 'Runtime.enable');

    // Collect executionContextCreated events
    const contexts = [];
    const contextHandler = (raw) => {
        const msg = JSON.parse(raw);
        if (msg.method === 'Runtime.executionContextCreated') {
            contexts.push(msg.params.context);
        }
    };
    ws.on('message', contextHandler);

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
    const classified = {
        main: [],
        isolated: [],
        extension: [],
        other: [],
    };

    for (const ctx of contexts) {
        const origin = ctx.origin || '';
        const aux = ctx.auxData || {};

        if (origin.startsWith('chrome-extension://')) {
            classified.extension.push({
                id: ctx.id,
                origin,
                name: aux.name || 'unknown',
                frameId: aux.frameId,
            });
        } else if (aux.isDefault) {
            classified.main.push({
                id: ctx.id,
                origin,
                frameId: aux.frameId,
            });
        } else if (origin === '' && aux.frameId) {
            classified.isolated.push({
                id: ctx.id,
                origin: '(isolated)',
                frameId: aux.frameId,
            });
        } else {
            classified.other.push({
                id: ctx.id,
                origin,
                frameId: aux.frameId,
            });
        }
    }

    log('CTX', `Main world contexts: ${classified.main.length}`);
    log('CTX', `Isolated world contexts: ${classified.isolated.length}`);
    log('CTX', `Extension contexts: ${classified.extension.length}`);
    for (const ext of classified.extension) {
        log('CTX', `  Extension: ${ext.name} (${ext.origin}) contextId=${ext.id}`);
    }
    log('CTX', `Other contexts: ${classified.other.length}`);

    return classified;
}

// ─── P1-3: Write Gate Pre-checks ────────────────────────────────────────────
// Before Phase 2, verify all prerequisites for write operations.

async function checkWriteGate() {
    log('GATE', '=== Write Gate Pre-checks ===');
    const results = {
        ghAuth: false,
        bridgeWriteGate: false,
        commentOnPrAvailable: false,
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
        // gh auth status exits non-zero when not logged in
        const output = err.stdout || err.stderr || err.message;
        if (output.includes('Logged in') || output.includes('github.com')) {
            results.ghAuth = true;
            log('GATE', '  ✅ gh CLI authenticated');
        } else {
            log('GATE', `  ❌ gh CLI auth failed: ${output.substring(0, 200)}`);
        }
    }

    // Check 2: Bridge write gate (check config/mcp-servers.json)
    log('GATE', 'Check 2: Bridge write gate config...');
    try {
        const fs = require('fs');
        const configRaw = fs.readFileSync('config/mcp-servers.json', 'utf-8');
        const config = JSON.parse(configRaw);
        const bridgeEnv = config?.mcpServers?.committee?.bridge?.env
            || config?.mcpServers?.['committee-bridge']?.env;
        if (bridgeEnv) {
            const writesEnabled = bridgeEnv.BRIDGE_ENABLE_WRITES;
            if (writesEnabled === 'true') {
                results.bridgeWriteGate = true;
                log('GATE', '  ✅ BRIDGE_ENABLE_WRITES=true');
            } else {
                log('GATE', `  ⚠️  BRIDGE_ENABLE_WRITES=${writesEnabled || 'not set'} (need "true" for Phase 2)`);
            }
        } else {
            log('GATE', '  ⚠️  committee-bridge env not found in config');
        }
    } catch (err) {
        log('GATE', `  ⚠️  Cannot read mcp-servers.json: ${err.message}`);
    }

    // Check 3: comment_on_pr tool availability via MCP proxy
    log('GATE', 'Check 3: MCP proxy health (comment_on_pr)...');
    try {
        const { URL } = require('url');
        const healthUrl = new URL('http://localhost:3006/health');
        const healthBody = await new Promise((resolve, reject) => {
            const req = http.get(healthUrl, (res) => {
                let d = '';
                res.on('data', c => d += c);
                res.on('end', () => resolve(d));
            });
            req.on('error', reject);
            req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
        });
        log('GATE', `  ✅ MCP proxy responding: ${healthBody.substring(0, 100)}`);
        results.commentOnPrAvailable = true;
    } catch (err) {
        log('GATE', `  ❌ MCP proxy not accessible: ${err.message}`);
        log('GATE', '     (comment_on_pr availability unconfirmed — may still work via extension)');
    }

    // Summary
    log('GATE', '');
    log('GATE', '--- Write Gate Summary ---');
    log('GATE', `  gh auth:          ${results.ghAuth ? '✅' : '❌ BLOCKER'}`);
    log('GATE', `  bridge writes:    ${results.bridgeWriteGate ? '✅' : '⚠️  NEEDED for Phase 2'}`);
    log('GATE', `  comment_on_pr:    ${results.commentOnPrAvailable ? '✅' : '⚠️  unconfirmed'}`);

    const canProceed = results.ghAuth;
    if (!canProceed) {
        log('GATE', '');
        log('GATE', '❌ BLOCKER: gh CLI not authenticated — cannot verify PR comments');
    }

    return { ...results, canProceed };
}

// ─── Phase 1: Preflight (enhanced with P1-2 and P1-3) ──────────────────────

async function phase1Preflight(ws, tab) {
    // Wait for SPA to fully render after reload
    await sleep(3000);

    log('PHASE-1', '=== Extension & DOM Injection Check (extension-aware) ===');

    // P1-2: Enumerate execution contexts
    const contexts = await enumerateContexts(ws);
    evidence.phase1.contexts = {
        mainCount: contexts.main.length,
        isolatedCount: contexts.isolated.length,
        extensionCount: contexts.extension.length,
        extensionContexts: contexts.extension.map(e => ({
            name: e.name,
            origin: e.origin,
            id: e.id,
        })),
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

    // Check 4: Notion AI composer/input presence
    const composerCheck = await cdpSend(ws, 'Runtime.evaluate', {
        expression: `(function() {
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]')
                || document.querySelector('[class*="notion-ai"] [contenteditable="true"]');
            // /chat page may use different submit button selectors
            const submitSelectors = [
                '[aria-label="\u53d1\u9001"]',
                '[aria-label="Send"]',
                'button[type="submit"]',
                '[data-testid="chat-send-button"]',
                '[class*="send-button"]',
                '[class*="submit"]',
                'button[aria-label*="send" i]',
                'button[aria-label*="\u53d1\u9001"]',
            ];
            let submitBtn = null;
            for (const sel of submitSelectors) {
                submitBtn = document.querySelector(sel);
                if (submitBtn) break;
            }
            return JSON.stringify({
                hasInput: !!input,
                inputTag: input ? input.tagName : null,
                inputContentLen: input ? input.textContent.length : 0,
                hasSubmitButton: !!submitBtn,
                submitButtonLabel: submitBtn ? (submitBtn.getAttribute('aria-label') || submitBtn.textContent.substring(0, 30)) : null,
                // Also check for Enter-key-to-submit pattern (many chat UIs)
                inputRole: input ? input.getAttribute('role') : null,
            });
        })()`,
        returnByValue: true,
    });
    const composer = JSON.parse(composerCheck.result.value);
    log('PHASE-1', `Composer: hasInput=${composer.hasInput} hasSubmitButton=${composer.hasSubmitButton}`);
    evidence.phase1.composer = composer;

    // Check 5: URL and page context
    evidence.phase1.pageUrl = tab.url;
    evidence.phase1.isOnChatPage = tab.url.includes('/chat') || tab.url.includes('/ai');

    // Verdict
    const extActivated = dom.mcpPopover || dom.dataMcpSuperassistant || dom.mcpElements > 0;
    const canSubmit = composer.hasInput && composer.hasSubmitButton;

    log('PHASE-1', '');
    log('PHASE-1', '--- Phase 1 Verdict ---');
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
        log('PHASE-1', '✅ Composer: input and submit button found');
    } else {
        log('PHASE-1', '❌ Composer: input or submit button missing — navigate to Notion AI chat page');
    }
    if (evidence.phase1.isOnChatPage) {
        log('PHASE-1', '✅ Page context: on Notion AI /chat or /ai page');
    } else {
        log('PHASE-1', '⚠️  Page context: NOT on /chat or /ai — may need navigation');
    }

    return { extActivated, canSubmit, contexts };
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
    let functionCallDetected = false;
    let interceptionDetected = false;

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

                if (logEntry.text.includes('function_call') && !functionCallDetected) {
                    functionCallDetected = true;
                    log('PHASE-2', '✅ function_call detected in console');
                }
                if (logEntry.text.includes('callTool') && !interceptionDetected) {
                    interceptionDetected = true;
                    log('PHASE-2', '✅ callTool() detected — MCP interception confirmed');
                }
            }
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

        // Look for our test comment by RUN_ID (unique per run)
        const matchingComments = comments.filter(c =>
            c.body && c.body.includes(RUN_ID)
        );
        log('PHASE-2', `Comments matching RUN_ID ${RUN_ID}: ${matchingComments.length}`);

        if (matchingComments.length === 0) {
            log('PHASE-2', '❌ No test comment found on PR #97');
            evidence.phase2.prComment = { found: false, totalComments: comments.length };
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
                exactMatch,
                bodyLength: testComment.body.length,
                // P1-4: verify multi-line body
                lineCount: testComment.body.split('\n').length,
                hasAckMarker: testComment.body.includes('L5B2-OBS-MCP-001'),
                hasRunId: testComment.body.includes(RUN_ID),
                hasCodeFence: testComment.body.includes('```json'),
                hasNeutralizedMention: testComment.body.includes('@opu-47'),
            };
        }

        evidence.phase2.prCommentsRaw = comments.length;
        evidence.phase2.testStartTime = TEST_START_TIME;
        evidence.phase2.postTestComments = postTestComments.length;
    } catch (err) {
        log('PHASE-2', `❌ gh CLI error: ${err.message}`);
        evidence.phase2.ghError = err.message;
    }

    // Step 7: Collect all console messages
    ws.removeListener('message', consoleHandler);
    evidence.phase2.consoleMessages = consoleMessages;

    log('PHASE-2', '');
    log('PHASE-2', `--- Console messages captured: ${consoleMessages.length} ---`);
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

    if (evidence.phase2.prComment?.found && evidence.phase2.prComment?.exactMatch) {
        log('PHASE-2', '✅ PASS: End-to-end write-back verified (exact body match)');
        log('PHASE-2', '   Notion AI → MCP-SuperAssistant → committee-bridge → GitHub API');
        log('PHASE-2', `   Comment ID: ${evidence.phase2.prComment.id}`);
        log('PHASE-2', `   RUN_ID: ${RUN_ID}`);
        evidence.verdict = 'PASS';
    } else if (evidence.phase2.prComment?.found && !evidence.phase2.prComment?.exactMatch) {
        log('PHASE-2', '⚠️  PARTIAL: Comment found but body mismatch');
        log('PHASE-2', '   Possible: MCP connector modified the body');
        evidence.verdict = 'PARTIAL';
    } else if (functionCallDetected && !evidence.phase2.prComment?.found) {
        log('PHASE-2', '⚠️  PARTIAL: function_call detected but comment not on PR');
        log('PHASE-2', '   Possible: WRITES_DISABLED, gh auth issue, or wrong PR number');
        evidence.verdict = 'PARTIAL';
    } else {
        log('PHASE-2', '❌ FAIL: No function_call interception detected');
        log('PHASE-2', '   Possible causes:');
        log('PHASE-2', '   1. Notion AI did not generate function_call');
        log('PHASE-2', '   2. MCP-SuperAssistant stream interceptor not active');
        log('PHASE-2', '   3. committee-bridge tools not injected via bridge prompt');
        evidence.verdict = 'FAIL';
    }

    return evidence.verdict === 'PASS';
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
    console.log(`✅ Extension: ${extensionName} (${extensionId})`);
    console.log(`✅ Page: ${tab.url.substring(0, 80)}`);
    console.log('');

    // Connect to Notion tab
    const WebSocket = require('ws');
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

    try {
        // Phase 1: Preflight
        const { extActivated, canSubmit, contexts } = await phase1Preflight(ws, tab);

        if (!FULL_MODE) {
            log('PHASE-1', '');
            log('PHASE-1', 'Phase 1 complete. Run with --full for Phase 2 (requires BRIDGE_ENABLE_WRITES=true).');
            evidence.verdict = extActivated ? 'PREFLIGHT_OK' : 'PREFLIGHT_EXTENSION_NOT_ACTIVE';
        } else {
            // Phase 2: Full smoke test
            if (!canSubmit) {
                console.error('❌ Cannot proceed to Phase 2: Notion AI composer not found');
                console.error('   Navigate to a Notion AI chat page first');
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
    const evidencePath = `l5b2-obs-mcp-write-back-${RUN_ID}.json`;
    const fs = require('fs');
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
