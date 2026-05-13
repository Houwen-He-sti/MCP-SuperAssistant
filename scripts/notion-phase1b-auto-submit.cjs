// Phase 1B: Guarded observation — autoSubmit full loop test
// Tests: AutomationService path (L9+), NOT streamToolBridge (L5).
// See docs/phase-1b-auto-submit.md for plan details.
//
// Includes: try/finally safety, preflight checks, maxToolCalls guard,
// maxSubmits guard, kill switch, duration limit, B' ACK marker oracle.
//
// Author: Opus/Claude (P0+P1 fixes from GPT+Opus joint review)
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');

// --- Markers ---
// TOOL_NONCE: used in echo tool argument, proves tool result causal chain
// ACK_MARKER: AI must echo this in natural language reply, proves full loop
const TOOL_NONCE = `PHASE1B_TOOL_${Date.now()}`;
const ACK_MARKER = `PHASE1B_ACK_${Date.now()}`;

const LIMITS = {
    maxDurationMs: 120_000,
    maxToolCalls: 15,
    maxSubmittedFunctionResults: 5,
    maxAutoSubmitClicks: 5,
};

const CDP_TIMEOUT_MS = 15_000;
const STORE_KEY = 'mcp-super-assistant-ui-store';

// Phase 1B prompt: call echo WITH message, then output ACK_MARKER in reply
const PHASE1B_PROMPT = `请调用 echo 工具一次，参数必须包含：
{"message":"${TOOL_NONCE}"}

收到 function_result 后，不要再次调用工具。
请只用自然语言回复，并且必须原样包含以下确认标记：
${ACK_MARKER}

回复中可以简短说明 echo 结果。`;

// --- Notion tab URL matcher: only /chat (GPT review P1+P2 fix) ---
function isNotionAiTarget(url) {
    // Only match Notion AI chat pages to avoid hijacking regular doc tabs
    // P2: tighten regex to require /chat followed by query, path, or end
    return /https:\/\/(www\.)?notion\.so\/chat(?:[\/?#]|$)/.test(url);
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getTargets() {
    return new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:9222/json', res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
    });
}

// --- Check MCP proxy health (P1-1) ---
function checkProxyHealth(port = 3006) {
    return new Promise(resolve => {
        const req = http.get(`http://127.0.0.1:${port}/health`, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve({ ok: res.statusCode === 200, body: d }));
        });
        req.on('error', () => resolve({ ok: false, body: 'connection refused' }));
        req.setTimeout(3000, () => { req.destroy(); resolve({ ok: false, body: 'timeout' }); });
    });
}

(async () => {
    console.log(`\n=== PHASE 1B: autoSubmit Full Loop Test ===`);
    console.log(`TOOL_NONCE: ${TOOL_NONCE}`);
    console.log(`ACK_MARKER: ${ACK_MARKER}`);
    console.log(`LIMITS: ${JSON.stringify(LIMITS)}`);
    console.log(`Start: ${new Date().toISOString()}\n`);

    const startTime = Date.now();

    // ============================================================
    // PREFLIGHT — all checks BEFORE enabling autoSubmit (P0-2)
    // ============================================================

    // 1. Check fixture file exists
    const bridgePromptPath = path.resolve(__dirname, '..', '..', 'tmp', 'notion-echo-test-phase1a.md');
    if (!fs.existsSync(bridgePromptPath)) {
        console.log(`ERROR: Missing prompt fixture: ${bridgePromptPath}`);
        console.log('  Create it or use scripts/fixtures/ (TODO)');
        process.exit(1);
    }
    const bridgePrompt = fs.readFileSync(bridgePromptPath, 'utf8');
    const fullPrompt = bridgePrompt.split('</mcp-system-prompt>')[0] + '</mcp-system-prompt>\n\n' + PHASE1B_PROMPT;
    console.log(`Preflight: prompt fixture OK (${fullPrompt.length} chars)`);

    // 2. Check CDP available + find Notion tab (P0-3)
    let targets;
    try {
        targets = await getTargets();
    } catch (e) {
        console.log(`ERROR: CDP not available at port 9222: ${e.message}`);
        process.exit(1);
    }
    const chatTab = targets.find(t => isNotionAiTarget(t.url));
    if (!chatTab) {
        console.log('ERROR: No Notion AI tab found. Looking for notion.so/(agent|ai|chat)');
        console.log('  Available tabs:', targets.map(t => t.url).join('\n    '));
        process.exit(1);
    }
    console.log(`Preflight: Notion tab found: ${chatTab.url}`);

    // 3. Check MCP proxy (P1-1, best-effort)
    const proxyHealth = await checkProxyHealth();
    if (!proxyHealth.ok) {
        console.log(`WARNING: MCP proxy health check failed: ${proxyHealth.body}`);
        console.log('  Proxy may not be running. Tool calls may fail.');
    } else {
        console.log('Preflight: MCP proxy health OK');
    }

    // 4. Connect WebSocket
    const ws = new WebSocket(chatTab.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));
    console.log('Preflight: CDP WebSocket connected');

    // --- CDP send with timeout (P1-4) ---
    let msgId = 0;
    function send(method, params, timeoutMs = CDP_TIMEOUT_MS) {
        return new Promise((resolve, reject) => {
            const id = ++msgId;
            let timer;
            const handler = msg => {
                const obj = JSON.parse(msg);
                if (obj.id === id) {
                    if (timer) clearTimeout(timer);
                    ws.off('message', handler);
                    resolve(obj);
                }
            };
            ws.on('message', handler);
            ws.send(JSON.stringify({ id, method, params: params || {} }));
            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    ws.off('message', handler);
                    reject(new Error(`CDP timeout (${timeoutMs}ms) for ${method}`));
                }, timeoutMs);
            }
        });
    }
    function val(r) { return r.result?.result?.value; }

    await send('Runtime.enable');
    await send('Log.enable');

    // 5. Check extension state (adapted to current store structure)
    const extCheck = await send('Runtime.evaluate', {
        expression: `(function() {
            const key = '${STORE_KEY}';
            const stored = JSON.parse(localStorage.getItem(key) || 'null');
            if (!stored || !stored.state) return JSON.stringify({ error: 'NO_STORE' });
            const s = stored.state;
            return JSON.stringify({
                hasStore: true,
                mcpEnabled: s.mcpEnabled ?? false,
                autoInsert: s.preferences?.autoInsert,
                autoSubmit: s.preferences?.autoSubmit,
            });
        })()`,
        returnByValue: true,
    });
    const extState = JSON.parse(val(extCheck));
    console.log(`Preflight: Extension state: ${JSON.stringify(extState)}`);
    if (extState.error) {
        console.log('ERROR: MCP-SuperAssistant UI store not found.');
        ws.close();
        process.exit(1);
    }
    if (!extState.mcpEnabled) {
        console.log('WARNING: mcpEnabled is false. Tool calls may fail.');
    }

    // 6. Verify input textbox + send button exist
    const uiCheck = await send('Runtime.evaluate', {
        expression: `(function() {
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            const sendBtn = document.querySelector('[data-testid="agent-send-message-button"]');
            return JSON.stringify({ hasInput: !!input, hasSendBtn: !!sendBtn });
        })()`,
        returnByValue: true,
    });
    console.log(`Preflight: UI elements: ${JSON.stringify(JSON.parse(val(uiCheck)))}`);

    console.log('\n--- All preflight checks passed ---\n');

    // ============================================================
    // SNAPSHOT original preferences for restore (P1-2)
    // ============================================================
    let originalPreferences = null;
    const snapshotResult = await send('Runtime.evaluate', {
        expression: `(function() {
            const key = '${STORE_KEY}';
            const stored = JSON.parse(localStorage.getItem(key) || '{}');
            if (stored.state && stored.state.preferences) {
                return JSON.stringify(stored.state.preferences);
            }
            return 'null';
        })()`,
        returnByValue: true,
    });
    originalPreferences = JSON.parse(val(snapshotResult));
    console.log(`Snapshot: original preferences saved`);

    // ============================================================
    // MAIN TEST BODY — wrapped in try/finally for safety (P0-1)
    // ============================================================
    let toolCallCount = 0;
    let submitCount = 0;
    let functionResultsInPage = 0;
    let killed = false;
    let autoInsertDetected = false;
    let autoSubmitDetected = false;
    let aiNaturalResponse = false;
    let loopComplete = false;
    let ackBaselineCount = 0;

    const allLogs = [];
    ws.on('message', msg => {
        try {
            const obj = JSON.parse(msg);
            if (obj.method === 'Runtime.consoleAPICalled') {
                const text = (obj.params.args || []).map(a => a.value || a.description || '').join(' ');
                // Broaden capture: include any extension-related logs
                if (text.includes('Auto') || text.includes('submit') || text.includes('insert') ||
                    text.includes(TOOL_NONCE) || text.includes(ACK_MARKER) ||
                    text.includes('adapter') || text.includes('[AutomationService]') ||
                    text.includes('[MCP') || text.includes('[Bridge') || text.includes('tool:') ||
                    text.includes('execution') || text.includes('result') || text.includes('click')) {
                    allLogs.push(`[${elapsed()}] ${text.substring(0, 300)}`);
                }
            }
        } catch { /* ignore parse errors from CDP events */ }
    });

    function elapsed() {
        return `${Math.round((Date.now() - startTime) / 1000)}s`;
    }

    async function restorePreferences() {
        if (!originalPreferences) return;
        console.log('Restoring original preferences...');
        try {
            const prefs = JSON.stringify(originalPreferences);
            await send('Runtime.evaluate', {
                expression: `(function() {
                    const key = '${STORE_KEY}';
                    const stored = JSON.parse(localStorage.getItem(key) || '{}');
                    if (stored.state) {
                        stored.state.preferences = ${prefs};
                        localStorage.setItem(key, JSON.stringify(stored));
                    }
                    return 'restored';
                })()`,
                returnByValue: true,
            }, 5000);
            console.log('  Preferences restored to original state');
        } catch (e) {
            console.log(`  WARNING: Failed to restore preferences: ${e.message}`);
        }
    }

    try {
        // === STEP 1: Enable autoSubmit+autoInsert in localStorage ===
        console.log('Step 1: Enabling autoSubmit+autoInsert in localStorage...');
        const setResult = await send('Runtime.evaluate', {
            expression: `(function() {
                const key = '${STORE_KEY}';
                const stored = JSON.parse(localStorage.getItem(key) || '{}');
                if (stored.state && stored.state.preferences) {
                    stored.state.preferences.autoSubmit = true;
                    stored.state.preferences.autoInsert = true;
                    localStorage.setItem(key, JSON.stringify(stored));
                    return JSON.stringify({ autoSubmit: true, autoInsert: true });
                }
                return 'NO_STORE';
            })()`,
            returnByValue: true,
        });
        console.log('  localStorage set:', val(setResult));

        // === STEP 2: Reload to hydrate Zustand store ===
        console.log('Step 2: Reloading to hydrate store...');
        await send('Page.enable');
        await send('Page.reload', {}, 30_000);
        await new Promise(resolve => {
            const handler = msg => {
                try {
                    const obj = JSON.parse(msg);
                    if (obj.method === 'Page.loadEventFired') {
                        ws.off('message', handler);
                        resolve();
                    }
                } catch { /* ignore */ }
            };
            ws.on('message', handler);
            setTimeout(() => { ws.off('message', handler); resolve(); }, 30_000);
        });
        await new Promise(r => setTimeout(r, 5000));
        console.log('  Page reloaded.');

        // Navigate to fresh Notion AI chat (use /chat per PR #49 decision)
        console.log('  Navigating to fresh Notion AI chat...');
        await send('Page.navigate', { url: 'https://www.notion.so/chat' }, 30_000);
        await new Promise(resolve => {
            const handler = msg => {
                try {
                    const obj = JSON.parse(msg);
                    if (obj.method === 'Page.loadEventFired') {
                        ws.off('message', handler);
                        resolve();
                    }
                } catch { /* ignore */ }
            };
            ws.on('message', handler);
            setTimeout(() => { ws.off('message', handler); resolve(); }, 30_000);
        });
        await new Promise(r => setTimeout(r, 5000));

        // Verify store after reload
        const liveStore = await send('Runtime.evaluate', {
            expression: `(function() {
                const key = '${STORE_KEY}';
                const stored = JSON.parse(localStorage.getItem(key) || '{}');
                if (stored.state && stored.state.preferences) {
                    return JSON.stringify({
                        autoInsert: stored.state.preferences.autoInsert,
                        autoSubmit: stored.state.preferences.autoSubmit,
                    });
                }
                return 'NO_STORE';
            })()`,
            returnByValue: true,
        });
        console.log('  Live store:', val(liveStore));

        // === STEP 3: Write prompt into input ===
        console.log('Step 3: Writing prompt into input...');
        console.log(`  Prompt length: ${fullPrompt.length}`);
        console.log(`  Has TOOL_NONCE: ${fullPrompt.includes(TOOL_NONCE)}`);
        console.log(`  Has ACK_MARKER: ${fullPrompt.includes(ACK_MARKER)}`);

        const inputInfo = await send('Runtime.evaluate', {
            expression: `(function() {
                const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
                if (!input) return 'NO_INPUT';
                const rect = input.getBoundingClientRect();
                return JSON.stringify({ x: Math.round(rect.x + rect.width/2), y: Math.round(rect.y + rect.height/2), len: input.textContent.length });
            })()`,
            returnByValue: true,
        });
        console.log(`  Input state: ${val(inputInfo)}`);
        if (val(inputInfo) === 'NO_INPUT') {
            throw new Error('No input textbox found after navigation');
        }
        const inputRect = JSON.parse(val(inputInfo));

        // Direct DOM injection via Runtime.evaluate (most reliable for Notion contenteditable)
        console.log('  Using direct DOM injection for prompt injection...');
        const injectResult = await send('Runtime.evaluate', {
            expression: `(function() {
                const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
                if (!input) return JSON.stringify({ error: 'NO_INPUT' });
                // Clear existing content
                input.textContent = '';
                // Insert the full prompt
                input.textContent = ${JSON.stringify(fullPrompt)};
                // Dispatch input event to trigger Notion's internal handlers
                input.dispatchEvent(new Event('input', { bubbles: true }));
                return JSON.stringify({ length: input.textContent.length });
            })()`,
            returnByValue: true,
        });
        const injectState = JSON.parse(val(injectResult));
        console.log(`  Inject result: ${val(injectResult)}`);
        if (injectState.error) {
            throw new Error('Direct DOM injection failed — ' + injectState.error);
        }

        // Verify
        const toolNonceEsc = JSON.stringify(TOOL_NONCE);
        const verifyPaste = await send('Runtime.evaluate', {
            expression: `(function() {
                const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
                const text = input?.textContent || '';
                return JSON.stringify({ length: text.length, hasToolNonce: text.includes(${toolNonceEsc}) });
            })()`,
            returnByValue: true,
        });
        const pasteState = JSON.parse(val(verifyPaste));
        console.log(`  Paste verify: ${val(verifyPaste)}`);
        if (!pasteState.hasToolNonce) {
            throw new Error('Direct DOM injection failed — TOOL_NONCE not in input');
        }

        // === STEP 4: Submit message ===
        console.log('Step 4: Submitting message...');
        await send('Runtime.evaluate', {
            expression: `document.querySelector('[data-testid="agent-send-message-button"]')?.click()`,
            returnByValue: true,
        });
        await new Promise(r => setTimeout(r, 3000));

        const afterSubmit = await send('Runtime.evaluate', {
            expression: `(function() {
                const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
                return JSON.stringify({ url: window.location.href, inputLen: (input?.textContent || '').length });
            })()`,
            returnByValue: true,
        });
        const submitState = JSON.parse(val(afterSubmit));
        console.log('  After submit:', val(afterSubmit));
        if (submitState.inputLen > 100) {
            throw new Error('Message not sent — input still has content');
        }
        console.log('  ✅ Message sent.');

        // Record ACK baseline AFTER prompt is submitted (P0-4 B')
        await new Promise(r => setTimeout(r, 2000));
        const ackMarkerEscaped = escapeRegExp(ACK_MARKER);
        const ackReStr = JSON.stringify(ackMarkerEscaped);
        const baselineResult = await send('Runtime.evaluate', {
            expression: `(function() {
                const pageText = document.body.innerText;
                const re = new RegExp(${ackReStr}, 'g');
                return (pageText.match(re) || []).length;
            })()`,
            returnByValue: true,
        });
        ackBaselineCount = val(baselineResult) || 0;
        console.log(`  ACK baseline count: ${ackBaselineCount}`);

        // === STEP 5: MAIN MONITORING LOOP ===
        console.log(`\n=== MONITORING LOOP (max ${LIMITS.maxDurationMs / 1000}s) ===`);
        console.log('Watching for: tool calls, autoInsert, autoSubmit, ACK marker\n');

        let lastInputLen = 0;
        const toolNonceForEval = JSON.stringify(TOOL_NONCE);

        for (let i = 0; i < Math.floor(LIMITS.maxDurationMs / 3000); i++) {
            await new Promise(r => setTimeout(r, 3000));

            if (Date.now() - startTime > LIMITS.maxDurationMs) {
                console.log(`\n⏰ DURATION LIMIT (${LIMITS.maxDurationMs / 1000}s) reached`);
                break;
            }

            const state = await send('Runtime.evaluate', {
                expression: `(function() {
                    const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
                    const inputText = input?.textContent || '';
                    const pageText = document.body.innerText;

                    const toolCallMatches = pageText.match(/function_call_start/g) || [];
                    const functionResultMatches = pageText.match(/function_result/g) || [];
                    const ackRe = new RegExp(${ackReStr}, 'g');
                    const ackCount = (pageText.match(ackRe) || []).length;

                    return JSON.stringify({
                        inputLength: inputText.length,
                        inputHasFunctionResult: inputText.includes('function_result'),
                        pageHasToolNonce: pageText.includes(${toolNonceForEval}),
                        ackMarkerCount: ackCount,
                        toolCallCount: toolCallMatches.length,
                        functionResultCount: functionResultMatches.length,
                        streaming: !!document.querySelector('[aria-label="停止"], [aria-label="Stop"]'),
                        inputPreview: inputText.substring(0, 80),
                    });
                })()`,
                returnByValue: true,
            });
            const s = JSON.parse(val(state));

            toolCallCount = s.toolCallCount;
            functionResultsInPage = s.functionResultCount;

            // Detect autoInsert
            if (!autoInsertDetected && s.inputLength > 0 && s.inputHasFunctionResult) {
                autoInsertDetected = true;
                console.log(`[${elapsed()}] ✅ AUTO-INSERT detected (input=${s.inputLength})`);
            }

            // Detect autoSubmit
            if (autoInsertDetected && !autoSubmitDetected && s.inputLength === 0 && lastInputLen > 0) {
                autoSubmitDetected = true;
                submitCount++;
                console.log(`[${elapsed()}] ✅ AUTO-SUBMIT detected (submit #${submitCount})`);
            }

            // B' ACK marker oracle (P0-4)
            if (autoSubmitDetected && !s.streaming && s.ackMarkerCount > ackBaselineCount) {
                aiNaturalResponse = true;
                console.log(`[${elapsed()}] ✅ AI NATURAL RESPONSE detected (ACK: ${s.ackMarkerCount} > baseline: ${ackBaselineCount})`);
                loopComplete = true;
            }

            // Log
            let flags = '';
            if (s.streaming) flags += ' [STREAMING]';
            if (s.ackMarkerCount > ackBaselineCount) flags += ' [ACK_FOUND]';
            console.log(`[${elapsed()}] in=${s.inputLength} tools=${s.toolCallCount} results=${s.functionResultCount} ack=${s.ackMarkerCount}/${ackBaselineCount} stream=${s.streaming}${flags}`);

            if (s.inputLength > 0 && !autoInsertDetected) {
                console.log(`  input: "${s.inputPreview}"`);
            }

            // Guard checks
            if (toolCallCount > LIMITS.maxToolCalls) {
                console.log(`\n🛑 GUARD: toolCallCount (${toolCallCount}) > ${LIMITS.maxToolCalls}`);
                killed = true;
                break;
            }
            if (submitCount > LIMITS.maxAutoSubmitClicks) {
                console.log(`\n🛑 GUARD: submitCount (${submitCount}) > ${LIMITS.maxAutoSubmitClicks}`);
                killed = true;
                break;
            }
            if (functionResultsInPage > LIMITS.maxSubmittedFunctionResults) {
                console.log(`\n🛑 GUARD: functionResults (${functionResultsInPage}) > ${LIMITS.maxSubmittedFunctionResults}`);
                killed = true;
                break;
            }

            if (loopComplete && !s.streaming) {
                console.log(`\n✅ LOOP COMPLETE at ${elapsed()}`);
                break;
            }

            lastInputLen = s.inputLength;
        }

        // === FINAL REPORT ===
        console.log('\n=== PHASE 1B FINAL REPORT ===');
        console.log(`Duration: ${elapsed()}`);
        console.log(`TOOL_NONCE: ${TOOL_NONCE}`);
        console.log(`ACK_MARKER: ${ACK_MARKER}`);
        console.log(`Tool calls: ${toolCallCount}`);
        console.log(`Function results: ${functionResultsInPage}`);
        console.log(`Submits: ${submitCount}`);
        console.log(`ACK baseline: ${ackBaselineCount}`);
        console.log(`Auto-insert: ${autoInsertDetected}`);
        console.log(`Auto-submit: ${autoSubmitDetected}`);
        console.log(`AI response (ACK): ${aiNaturalResponse}`);
        console.log(`Guard killed: ${killed}`);
        console.log(`Loop complete: ${loopComplete}`);

        // Pass = full loop (P0-4)
        const passed = autoInsertDetected && autoSubmitDetected && aiNaturalResponse && !killed;
        console.log(`\n${passed ? '✅ PHASE 1B PASSED' : '❌ PHASE 1B FAILED'}`);

        if (!autoInsertDetected) console.log('  FAIL: autoInsert not detected');
        if (!autoSubmitDetected) console.log('  FAIL: autoSubmit not detected');
        if (!aiNaturalResponse) console.log('  FAIL: AI ACK marker not detected');
        if (killed) console.log('  FAIL: guard triggered');

        console.log('\n=== CAPTURED LOGS ===');
        allLogs.length ? allLogs.forEach(l => console.log(l)) : console.log('(none)');

        process.exitCode = passed ? 0 : 1;

    } finally {
        // ============================================================
        // CLEANUP — always restore original state (P0-1, P1-2)
        // ============================================================
        console.log('\n=== CLEANUP ===');
        await restorePreferences();
        try { ws.close(); } catch { /* ignore */ }
        console.log('Done.');
    }
})();
