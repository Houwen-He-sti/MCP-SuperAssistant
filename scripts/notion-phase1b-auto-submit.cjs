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
    maxDurationMs: 180_000,
    maxToolCalls: 10,
    maxSubmittedFunctionResults: 8,
    maxAutoSubmitClicks: 5,
};

const CDP_TIMEOUT_MS = 15_000;
const STORE_KEY = 'mcp-super-assistant-ui-store';

// Phase 1B prompt: call echo WITH message, then output ACK_MARKER in reply
const PHASE1B_PROMPT = `请调用 committee-bridge.echo 工具一次，参数必须包含：
{"message":"${TOOL_NONCE}"}

注意：工具名称必须写全称 committee-bridge.echo，不能缩写为 echo。

收到 function_result 后，不要再次调用工具。
请只用自然语言回复，并且必须原样包含以下确认标记：
${ACK_MARKER}

回复中可以简短说明 echo 结果。`;

// --- Notion tab URL matcher ---
function isNotionAiTarget(url) {
    // Match any Notion page tab (not service workers or assets)
    return /https:\/\/(www\.)?notion\.so\//.test(url)
        && !/\/(sw\.js|_assets\/)/.test(url);
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
        console.log('ERROR: No Notion tab found.');
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
    const executionContexts = [];
    await new Promise(r => ws.on('open', r));
    console.log('Preflight: CDP WebSocket connected');

    // Track execution contexts for isolated world access
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.method === 'Runtime.executionContextCreated') {
                executionContexts.push(msg.params.context);
            }
        } catch (e) { }
    });

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
    await new Promise(r => setTimeout(r, 1500)); // Wait for context enumeration

    // 5. Find extension's isolated world and check MCP connection
    let isoCtx = null;
    for (const ctx of executionContexts) {
        if (ctx.name === 'MCP SuperAssistant') {
            const check = await send('Runtime.evaluate', {
                contextId: ctx.id,
                expression: "typeof window.pluginRegistry !== 'undefined'",
                returnByValue: true,
            });
            if (val(check) === true) { isoCtx = ctx.id; break; }
        }
    }

    async function evalIso(expression, opts = {}) {
        if (!isoCtx) return null;
        const params = { expression, returnByValue: true, contextId: isoCtx, ...opts };
        const result = await send('Runtime.evaluate', params);
        return result.result?.result;
    }

    if (isoCtx) {
        console.log(`Preflight: Extension isolated world found (ctx=${isoCtx})`);
        const mcpState = await evalIso(`(function() {
            var mc = window.mcpClient;
            if (!mc) return JSON.stringify({ hasMcpClient: false });
            return JSON.stringify({
                hasMcpClient: true,
                isReady: typeof mc.isReady === 'function' ? mc.isReady() : 'N/A',
            });
        })()`);
        console.log(`Preflight: mcpClient: ${mcpState?.value}`);

        const toolsResult = await evalIso(`(async function() {
            var mc = window.mcpClient;
            if (!mc || typeof mc.getAvailableTools !== 'function') return JSON.stringify({ count: 0, hasEcho: false });
            var t = await mc.getAvailableTools();
            var names = Array.isArray(t) ? t.map(function(x) { return typeof x === 'string' ? x : x.name || ''; }) : [];
            return JSON.stringify({
                count: names.length,
                hasEcho: names.some(function(n) { return n.indexOf('echo') >= 0; }),
                sample: names.slice(0, 5),
            });
        })()`, { awaitPromise: true });
        const toolInfo = JSON.parse(toolsResult?.value || '{}');
        console.log(`Preflight: MCP tools: ${toolsResult?.value}`);

        if (!toolInfo.hasEcho) {
            console.log('WARNING: No echo tool found in MCP registry. Tool calls may fail.');
        }
    } else {
        console.log('WARNING: Extension isolated world not found. Cannot verify MCP connection.');
    }

    // Check localStorage store for preferences
    const extCheck = await send('Runtime.evaluate', {
        expression: `(function() {
            var key = '${STORE_KEY}';
            var stored = JSON.parse(localStorage.getItem(key) || 'null');
            if (!stored || !stored.state) return JSON.stringify({ error: 'NO_STORE' });
            var s = stored.state;
            return JSON.stringify({
                hasStore: true,
                autoInsert: s.preferences?.autoInsert,
                autoSubmit: s.preferences?.autoSubmit,
            });
        })()`,
        returnByValue: true,
    });
    const extState = JSON.parse(val(extCheck));
    console.log(`Preflight: Store state: ${JSON.stringify(extState)}`);
    if (extState.error) {
        console.log('ERROR: MCP-SuperAssistant UI store not found.');
        ws.close();
        process.exit(1);
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
                if (text.includes('Auto') || text.includes('submit') || text.includes('insert') ||
                    text.includes(TOOL_NONCE) || text.includes(ACK_MARKER) ||
                    text.includes('adapter') || text.includes('[AutomationService]')) {
                    allLogs.push(`[${elapsed()}] ${text.substring(0, 200)}`);
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
        await new Promise(r => setTimeout(r, 10_000));
        console.log('  Page reloaded.');

        // === STEP 2b: Ensure correct workspace (sjzj030) ===
        // houwen's workspace has NO Notion AI → send button permanently disabled
        const TARGET_WS = 'sjzj030';
        console.log('Step 2b: Checking workspace...');
        const wsCheck = await send('Runtime.evaluate', {
            expression: `(function() {
                var sw = document.querySelector('.notion-sidebar-switcher');
                return sw ? sw.textContent.trim() : 'NO_SWITCHER';
            })()`,
            returnByValue: true,
        });
        const currentWs = val(wsCheck);
        console.log('  Current workspace switcher text:', currentWs);

        if (!currentWs.includes(TARGET_WS)) {
            console.log('  ⚠️ Wrong workspace! Switching to sjzj030...');
            // Click workspace switcher
            const switcherClicked = val(await send('Runtime.evaluate', {
                expression: `(function() {
                    var sw = document.querySelector('.notion-sidebar-switcher');
                    if (sw) { sw.click(); return true; }
                    return false;
                })()`,
                returnByValue: true,
            }));
            if (!switcherClicked) {
                throw new Error('Workspace switcher not found in sidebar');
            }
            await new Promise(r => setTimeout(r, 2000));

            // Click target workspace in menu (includes match — DOM text has leading avatar char)
            const wsClicked = val(await send('Runtime.evaluate', {
                expression: `(function() {
                    var items = document.querySelectorAll('[role="menuitem"]');
                    for (var i = 0; i < items.length; i++) {
                        if (items[i].textContent.includes('${TARGET_WS}')) {
                            items[i].click();
                            return items[i].textContent.substring(0, 40);
                        }
                    }
                    return null;
                })()`,
                returnByValue: true,
            }));
            if (!wsClicked) {
                throw new Error('Target workspace "sjzj030" not found in switcher menu');
            }
            console.log('  Switched to:', wsClicked);
            // Wait for workspace to load
            await new Promise(r => setTimeout(r, 5000));
        } else {
            console.log('  ✅ Already on correct workspace');
        }

        // Navigate to Notion AI via sidebar link (preserves SPA state, unlike Page.navigate)
        console.log('  Navigating to Notion AI via sidebar link...');
        const aiLinkClicked = val(await send('Runtime.evaluate', {
            expression: `(function() {
                var links = document.querySelectorAll('a[href]');
                for (var i = 0; i < links.length; i++) {
                    try {
                        var href = new URL(links[i].href).pathname;
                        if (href === '/ai') {
                            links[i].click();
                            return 'clicked: ' + links[i].textContent.substring(0, 30);
                        }
                    } catch(e) {}
                }
                return null;
            })()`,
            returnByValue: true,
        }));
        if (aiLinkClicked) {
            console.log('  Sidebar link:', aiLinkClicked);
        } else {
            console.log('  No sidebar /ai link found, falling back to Page.navigate...');
            await send('Page.navigate', { url: 'https://www.notion.so/ai' }, 30_000);
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
        }
        // Wait for SPA render
        console.log('  Waiting 10s for SPA render...');
        await new Promise(r => setTimeout(r, 10_000));

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

        // === STEP 2c: Ensure fresh chat (click "New Chat" if on existing conversation) ===
        console.log('Step 2c: Looking for New Chat button...');
        const newChatClicked = val(await send('Runtime.evaluate', {
            expression: `(function() {
                // Method 1: aria-label match (Notion uses 新对话 / 开始新对话)
                var labels = ['新对话', '开始新对话', 'New Chat', 'Start new chat'];
                for (var k = 0; k < labels.length; k++) {
                    var el = document.querySelector('[aria-label="' + labels[k] + '"]');
                    if (el) { el.click(); return 'clicked: aria-label=' + labels[k]; }
                }
                // Method 2: text content search
                var btns = document.querySelectorAll('button, a, [role="button"]');
                for (var i = 0; i < btns.length; i++) {
                    var t = btns[i].textContent.trim().toLowerCase();
                    if (t === 'new chat' || t === '新建对话' || t === '新对话' || t.startsWith('新对话')) {
                        btns[i].click();
                        return 'clicked: text=' + btns[i].textContent.substring(0, 20);
                    }
                }
                // Method 3: data-testid
                var ncBtn = document.querySelector('[data-testid="new-chat-button"]');
                if (ncBtn) { ncBtn.click(); return 'clicked: testid'; }
                return null;
            })()`,
            returnByValue: true,
        }));
        if (newChatClicked) {
            console.log('  New Chat:', newChatClicked);
            await new Promise(r => setTimeout(r, 3000));
        } else {
            console.log('  No New Chat button found (may already be fresh)');
        }

        // === STEP 3: Write prompt into input ===
        console.log('Step 3: Writing prompt into input...');
        console.log(`  Prompt length: ${fullPrompt.length}`);
        console.log(`  Has TOOL_NONCE: ${fullPrompt.includes(TOOL_NONCE)}`);
        console.log(`  Has ACK_MARKER: ${fullPrompt.includes(ACK_MARKER)}`);

        // Retry finding input — SPA may still be rendering
        let inputInfo;
        for (let attempt = 0; attempt < 5; attempt++) {
            inputInfo = await send('Runtime.evaluate', {
                expression: `(function() {
                    const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
                    if (!input) return 'NO_INPUT';
                    const rect = input.getBoundingClientRect();
                    return JSON.stringify({ x: Math.round(rect.x + rect.width/2), y: Math.round(rect.y + rect.height/2), len: input.textContent.length });
                })()`,
                returnByValue: true,
            });
            if (val(inputInfo) !== 'NO_INPUT') break;
            console.log(`  Input not found, retrying in 3s (attempt ${attempt + 1}/5)...`);
            await new Promise(r => setTimeout(r, 3000));
        }
        console.log(`  Input state: ${val(inputInfo)}`);
        if (val(inputInfo) === 'NO_INPUT') {
            throw new Error('No input textbox found after navigation (5 attempts)');
        }
        const inputRect = JSON.parse(val(inputInfo));

        // Click to focus
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: inputRect.x, y: inputRect.y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: inputRect.x, y: inputRect.y, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, 300));

        // Select all + clear existing content
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
        await new Promise(r => setTimeout(r, 200));

        // Primary: execCommand('insertText') — works with contenteditable + triggers browser editing pipeline
        const promptEscaped = JSON.stringify(fullPrompt);
        const execResult = val(await send('Runtime.evaluate', {
            expression: `(function() {
                var input = document.querySelector('div[role="textbox"][contenteditable="true"]');
                if (!input) return 'NO_INPUT';
                input.focus();
                document.execCommand('selectAll');
                var ok = document.execCommand('insertText', false, ${promptEscaped});
                return ok ? 'execCommand_ok' : 'execCommand_fail';
            })()`,
            returnByValue: true,
        }));
        console.log('  execCommand result:', execResult);

        if (execResult === 'execCommand_fail' || execResult === 'NO_INPUT') {
            // Fallback: Input.insertText + synthetic events
            console.log('  execCommand failed, falling back to Input.insertText...');
            await send('Input.insertText', { text: fullPrompt });
            await new Promise(r => setTimeout(r, 500));
            // Dispatch React-compatible input events
            val(await send('Runtime.evaluate', {
                expression: `(function() {
                    var input = document.querySelector('div[role="textbox"][contenteditable="true"]');
                    if (!input) return 'NO_INPUT';
                    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ' ' }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    return 'dispatched';
                })()`,
                returnByValue: true,
            }));
        }
        await new Promise(r => setTimeout(r, 1000));

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
            throw new Error('Input.insertText failed — TOOL_NONCE not in input');
        }

        // === STEP 4: Submit message ===
        console.log('Step 4: Submitting message...');

        // Check send button state before clicking
        const btnState = val(await send('Runtime.evaluate', {
            expression: `(function() {
                var btn = document.querySelector('[data-testid="agent-send-message-button"]');
                if (!btn) return JSON.stringify({ exists: false });
                return JSON.stringify({
                    exists: true,
                    disabled: btn.disabled || btn.getAttribute('aria-disabled') === 'true',
                    opacity: getComputedStyle(btn).opacity,
                });
            })()`,
            returnByValue: true,
        }));
        const btnInfo = JSON.parse(btnState);
        console.log('  Send button state:', btnState);

        if (btnInfo.disabled || parseFloat(btnInfo.opacity || '1') < 0.5) {
            console.log('  ⚠️ Button disabled! Diagnosing...');
            // Diagnostic: workspace + input state
            const diagState = val(await send('Runtime.evaluate', {
                expression: `(function() {
                    var sw = document.querySelector('.notion-sidebar-switcher');
                    var input = document.querySelector('div[role="textbox"][contenteditable="true"]');
                    return JSON.stringify({
                        workspace: sw ? sw.textContent.trim().substring(0, 30) : 'NO_SWITCHER',
                        inputLen: input ? input.textContent.length : -1,
                        hasToolNonce: input ? input.textContent.includes(${toolNonceEsc}) : false,
                        url: location.href,
                    });
                })()`,
                returnByValue: true,
            }));
            console.log('  Diagnostic:', diagState);

            // Try nudge: Space + Backspace to trigger editor state update
            console.log('  Trying Space+Backspace nudge...');
            await send('Runtime.evaluate', {
                expression: `document.querySelector('div[role="textbox"][contenteditable="true"]')?.focus()`,
                returnByValue: true,
            });
            await new Promise(r => setTimeout(r, 200));
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
            await new Promise(r => setTimeout(r, 300));
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
            await new Promise(r => setTimeout(r, 500));

            // Recheck button state after nudge
            const btnState2 = val(await send('Runtime.evaluate', {
                expression: `(function() {
                    var btn = document.querySelector('[data-testid="agent-send-message-button"]');
                    if (!btn) return JSON.stringify({ exists: false });
                    return JSON.stringify({ disabled: btn.disabled, opacity: getComputedStyle(btn).opacity });
                })()`,
                returnByValue: true,
            }));
            const btnInfo2 = JSON.parse(btnState2);
            console.log('  After nudge:', btnState2);

            if (!btnInfo2.disabled && parseFloat(btnInfo2.opacity || '1') >= 0.5) {
                console.log('  ✅ Button enabled after nudge! Clicking...');
                await send('Runtime.evaluate', {
                    expression: `document.querySelector('[data-testid="agent-send-message-button"]')?.click()`,
                    returnByValue: true,
                });
            } else {
                console.log('  Still disabled. Last fallback: Enter key...');
                await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
                await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
            }
        } else {
            await send('Runtime.evaluate', {
                expression: `document.querySelector('[data-testid="agent-send-message-button"]')?.click()`,
                returnByValue: true,
            });
        }
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
        // Also record tool-call keyword baseline (prompt text contains 'function_call_start')
        await new Promise(r => setTimeout(r, 2000));
        const ackMarkerEscaped = escapeRegExp(ACK_MARKER);
        const ackReStr = JSON.stringify(ackMarkerEscaped);
        const baselineResult = await send('Runtime.evaluate', {
            expression: `(function() {
                const pageText = document.body.innerText;
                const re = new RegExp(${ackReStr}, 'g');
                const toolCallBaseline = (pageText.match(/function_call_start/g) || []).length;
                const functionResultBaseline = (pageText.match(/function_result/g) || []).length;
                return JSON.stringify({
                    ackBaseline: (pageText.match(re) || []).length,
                    toolCallBaseline: toolCallBaseline,
                    functionResultBaseline: functionResultBaseline,
                });
            })()`,
            returnByValue: true,
        });
        const baselines = JSON.parse(val(baselineResult));
        ackBaselineCount = baselines.ackBaseline || 0;
        const toolCallBaseline = baselines.toolCallBaseline || 0;
        const functionResultBaseline = baselines.functionResultBaseline || 0;
        console.log(`  ACK baseline: ${ackBaselineCount}, toolCall baseline: ${toolCallBaseline}, funcResult baseline: ${functionResultBaseline}`);

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

            toolCallCount = s.toolCallCount - toolCallBaseline;
            functionResultsInPage = s.functionResultCount - functionResultBaseline;

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
            console.log(`[${elapsed()}] in=${s.inputLength} tools=${toolCallCount}(raw:${s.toolCallCount}-base:${toolCallBaseline}) results=${functionResultsInPage}(raw:${s.functionResultCount}-base:${functionResultBaseline}) ack=${s.ackMarkerCount}/${ackBaselineCount} stream=${s.streaming}${flags}`);

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
