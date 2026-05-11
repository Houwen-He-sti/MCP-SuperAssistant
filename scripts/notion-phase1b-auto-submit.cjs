// Phase 1B: Guarded observation — autoSubmit full loop test
// Includes: maxToolCalls guard, maxSubmits guard, kill switch, duration limit
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');

const NONCE = `PHASE1B_${Date.now()}`;
const LIMITS = {
    maxDurationMs: 90_000,
    maxToolCalls: 3,       // AI should call echo once, maybe retry once
    maxSubmittedFunctionResults: 2,  // At most 2 function_result submissions
    maxAutoSubmitClicks: 2,
};

// Phase 1B prompt: explicitly tell AI to call echo WITH message, and stop after
const PHASE1B_PROMPT = `请调用 echo 工具一次，参数必须包含：
{"message":"${NONCE}"}

收到 function_result 后，不要再次调用工具，只用自然语言总结 echo 结果。`;

function getTargets() {
    return new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:9222/json', res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
    });
}

(async () => {
    console.log(`\n=== PHASE 1B: autoSubmit Full Loop Test ===`);
    console.log(`NONCE: ${NONCE}`);
    console.log(`LIMITS: ${JSON.stringify(LIMITS)}`);
    console.log(`Start: ${new Date().toISOString()}\n`);
    
    const startTime = Date.now();
    const targets = await getTargets();
    const chatTab = targets.find(t => t.url.includes('notion.so/ai') || t.url.includes('notion.so/chat'));
    if (!chatTab) { console.log('ERROR: No Notion AI chat tab'); process.exit(1); }
    console.log('Tab:', chatTab.url);

    const ws = new WebSocket(chatTab.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));

    let msgId = 0;
    function send(method, params) {
        return new Promise(resolve => {
            const id = ++msgId;
            const handler = msg => {
                const obj = JSON.parse(msg);
                if (obj.id === id) { ws.off('message', handler); resolve(obj); }
            };
            ws.on('message', handler);
            ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
    }
    function val(r) { return r.result?.result?.value; }

    await send('Runtime.enable');
    await send('Log.enable');

    // === COUNTERS ===
    let toolCallCount = 0;
    let submitCount = 0;
    let functionResultsInPage = 0;
    let killed = false;
    
    // Capture logs
    const allLogs = [];
    ws.on('message', msg => {
        const obj = JSON.parse(msg);
        if (obj.method === 'Runtime.consoleAPICalled') {
            const text = (obj.params.args || []).map(a => a.value || a.description || '').join(' ');
            if (text.includes('Auto') || text.includes('submit') || text.includes('insert') || 
                text.includes(NONCE) || text.includes('adapter') || text.includes('[AutomationService]')) {
                allLogs.push(`[${elapsed()}] ${text.substring(0, 200)}`);
            }
        }
    });
    
    function elapsed() {
        return `${Math.round((Date.now() - startTime) / 1000)}s`;
    }
    
    // === KILL SWITCH ===
    async function killAutoSubmit() {
        if (killed) return;
        killed = true;
        console.log(`\n🛑 KILL SWITCH ACTIVATED at ${elapsed()}`);
        // Update localStorage to disable autoSubmit
        await send('Runtime.evaluate', {
            expression: `(function() {
                const key = 'mcp-superassistant-ui-store';
                const stored = JSON.parse(localStorage.getItem(key) || '{}');
                if (stored.state && stored.state.preferences) {
                    stored.state.preferences.autoSubmit = false;
                    localStorage.setItem(key, JSON.stringify(stored));
                }
                return 'killed';
            })()`,
            returnByValue: true,
        });
    }

    // === STEP 1: Verify and set autoSubmit=true in localStorage ===
    console.log('Step 1: Setting autoSubmit=true in localStorage...');
    const setResult = await send('Runtime.evaluate', {
        expression: `(function() {
            const key = 'mcp-superassistant-ui-store';
            const stored = JSON.parse(localStorage.getItem(key) || '{}');
            if (stored.state && stored.state.preferences) {
                stored.state.preferences.autoSubmit = true;
                localStorage.setItem(key, JSON.stringify(stored));
                return JSON.stringify(stored.state.preferences);
            }
            return 'NO_STORE';
        })()`,
        returnByValue: true,
    });
    console.log('  localStorage updated:', val(setResult));

    // === STEP 2: Reload page to re-hydrate Zustand store ===
    console.log('Step 2: Reloading page to hydrate store...');
    await send('Page.enable');
    await send('Page.reload');
    
    // Wait for page to fully load
    await new Promise(resolve => {
        const handler = msg => {
            const obj = JSON.parse(msg);
            if (obj.method === 'Page.loadEventFired') {
                ws.off('message', handler);
                resolve();
            }
        };
        ws.on('message', handler);
    });
    await new Promise(r => setTimeout(r, 5000)); // Extra wait for extension to initialize
    console.log('  Page reloaded.');

    // === STEP 3: Verify live store has autoSubmit=true ===
    console.log('Step 3: Verifying live store...');
    const liveStore = await send('Runtime.evaluate', {
        expression: `(function() {
            const key = 'mcp-superassistant-ui-store';
            const stored = JSON.parse(localStorage.getItem(key) || '{}');
            if (stored.state && stored.state.preferences) {
                return JSON.stringify({
                    autoInsert: stored.state.preferences.autoInsert,
                    autoSubmit: stored.state.preferences.autoSubmit,
                    autoInsertDelay: stored.state.preferences.autoInsertDelay,
                    autoSubmitDelay: stored.state.preferences.autoSubmitDelay,
                });
            }
            return 'NO_STORE';
        })()`,
        returnByValue: true,
    });
    console.log('  Live preferences:', val(liveStore));
    
    const prefs = JSON.parse(val(liveStore));
    if (!prefs.autoSubmit) {
        console.log('ERROR: autoSubmit not enabled!');
        ws.close();
        process.exit(1);
    }

    // === STEP 4: Open new chat ===
    console.log('Step 4: Opening new chat (Ctrl+O)...');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27 });
    await new Promise(r => setTimeout(r, 300));
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'o', code: 'KeyO', modifiers: 2, windowsVirtualKeyCode: 79 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'o', code: 'KeyO', modifiers: 2, windowsVirtualKeyCode: 79 });
    await new Promise(r => setTimeout(r, 3000));

    // === STEP 5: Focus input, paste bridge prompt + test prompt ===
    console.log('Step 5: Pasting prompt...');
    const focus = await send('Runtime.evaluate', {
        expression: `(function() {
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            if (!input) return 'NO_INPUT';
            input.focus();
            return 'OK';
        })()`,
        returnByValue: true,
    });
    if (val(focus) !== 'OK') { console.log('No input!'); ws.close(); process.exit(1); }
    await new Promise(r => setTimeout(r, 500));
    
    // Read bridge prompt and combine with test prompt
    const bridgePromptPath = path.resolve(__dirname, '..', '..', 'tmp', 'notion-echo-test-phase1a.md');
    let bridgePrompt = fs.readFileSync(bridgePromptPath, 'utf8');
    // Replace the old test instructions with Phase 1B prompt
    const fullPrompt = bridgePrompt.split('</mcp-system-prompt>')[0] + '</mcp-system-prompt>\n\n' + PHASE1B_PROMPT;
    
    const escaped = JSON.stringify(fullPrompt);
    await send('Runtime.evaluate', {
        expression: `navigator.clipboard.writeText(${escaped}).then(() => 'OK').catch(e => 'ERR:'+e.message)`,
        awaitPromise: true,
        returnByValue: true,
    });
    
    // Ctrl+V paste
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86 });
    await new Promise(r => setTimeout(r, 1500));
    
    // Verify paste
    const verifyPaste = await send('Runtime.evaluate', {
        expression: `(function() {
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            const text = input?.textContent || '';
            return JSON.stringify({ length: text.length, hasNonce: text.includes('${NONCE}') });
        })()`,
        returnByValue: true,
    });
    const pasteState = JSON.parse(val(verifyPaste));
    console.log('  Paste verify:', val(verifyPaste));
    if (!pasteState.hasNonce) { console.log('Paste failed!'); ws.close(); process.exit(1); }

    // === STEP 6: Submit message ===
    console.log('Step 6: Submitting message...');
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
    console.log('  After initial submit:', val(afterSubmit));
    if (submitState.inputLen > 100) {
        console.log('Message not sent!');
        await killAutoSubmit();
        ws.close();
        process.exit(1);
    }
    console.log('  ✅ Message sent.');

    // === STEP 7: MAIN MONITORING LOOP ===
    console.log(`\n=== MONITORING LOOP (max ${LIMITS.maxDurationMs/1000}s) ===`);
    console.log('Watching for: tool calls, autoInsert, autoSubmit, AI response\n');
    
    let lastInputLen = 0;
    let autoInsertDetected = false;
    let autoSubmitDetected = false;
    let aiNaturalResponse = false;
    let loopComplete = false;
    
    for (let i = 0; i < Math.floor(LIMITS.maxDurationMs / 3000); i++) {
        await new Promise(r => setTimeout(r, 3000));
        
        // Check duration limit
        if (Date.now() - startTime > LIMITS.maxDurationMs) {
            console.log(`\n⏰ DURATION LIMIT (${LIMITS.maxDurationMs/1000}s) reached`);
            await killAutoSubmit();
            break;
        }
        
        const state = await send('Runtime.evaluate', {
            expression: `(function() {
                const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
                const inputText = input?.textContent || '';
                const pageText = document.body.innerText;
                const url = window.location.href;
                
                // Count function_call_start occurrences (tool calls by AI)
                const toolCallMatches = pageText.match(/function_call_start/g) || [];
                
                // Count function_result occurrences (submitted results)
                const functionResultMatches = pageText.match(/function_result/g) || [];
                
                return JSON.stringify({
                    url,
                    inputLength: inputText.length,
                    inputHasNonce: inputText.includes('${NONCE}'),
                    inputHasFunctionResult: inputText.includes('function_result'),
                    pageHasJsonl: pageText.includes('function_call_start'),
                    pageHasNonce: pageText.includes('${NONCE}'),
                    pageHasEchoResponse: pageText.includes('Echo response'),
                    toolCallCount: toolCallMatches.length,
                    functionResultCount: functionResultMatches.length,
                    streaming: !!document.querySelector('[aria-label="停止"], [aria-label="Stop"]'),
                    inputPreview: inputText.substring(0, 80)
                });
            })()`,
            returnByValue: true,
        });
        const s = JSON.parse(val(state));
        
        // Update counters
        toolCallCount = s.toolCallCount;
        functionResultsInPage = s.functionResultCount;
        
        // Detect autoInsert (input goes from 0 to >0 with function_result)
        if (!autoInsertDetected && s.inputLength > 0 && s.inputHasFunctionResult) {
            autoInsertDetected = true;
            console.log(`[${elapsed()}] ✅ AUTO-INSERT detected (input=${s.inputLength})`);
        }
        
        // Detect autoSubmit (input was >0 with function_result, now back to 0)
        if (autoInsertDetected && !autoSubmitDetected && s.inputLength === 0 && lastInputLen > 0) {
            autoSubmitDetected = true;
            submitCount++;
            console.log(`[${elapsed()}] ✅ AUTO-SUBMIT detected (input cleared, submit #${submitCount})`);
        }
        
        // Detect natural language response (nonce in page without streaming, after submit)
        if (autoSubmitDetected && s.pageHasEchoResponse && !s.streaming) {
            aiNaturalResponse = true;
            console.log(`[${elapsed()}] ✅ AI NATURAL RESPONSE detected`);
            loopComplete = true;
        }
        
        // Log state
        let flags = '';
        if (s.streaming) flags += ' [STREAMING]';
        if (s.pageHasJsonl) flags += ' [JSONL]';
        if (s.pageHasEchoResponse) flags += ' [ECHO_RESP]';
        console.log(`[${elapsed()}] in=${s.inputLength} tools=${s.toolCallCount} results=${s.functionResultCount} stream=${s.streaming}${flags}`);
        
        if (s.inputLength > 0 && !autoInsertDetected) {
            console.log(`  input: "${s.inputPreview}"`);
        }
        
        // === GUARD CHECKS ===
        if (toolCallCount > LIMITS.maxToolCalls) {
            console.log(`\n🛑 GUARD: toolCallCount (${toolCallCount}) > limit (${LIMITS.maxToolCalls})`);
            await killAutoSubmit();
            break;
        }
        if (submitCount > LIMITS.maxAutoSubmitClicks) {
            console.log(`\n🛑 GUARD: submitCount (${submitCount}) > limit (${LIMITS.maxAutoSubmitClicks})`);
            await killAutoSubmit();
            break;
        }
        if (functionResultsInPage > LIMITS.maxSubmittedFunctionResults) {
            console.log(`\n🛑 GUARD: functionResults (${functionResultsInPage}) > limit (${LIMITS.maxSubmittedFunctionResults})`);
            await killAutoSubmit();
            break;
        }
        
        // Loop complete — AI responded naturally, no more streaming
        if (loopComplete && !s.streaming) {
            console.log(`\n✅ LOOP COMPLETE at ${elapsed()}`);
            break;
        }
        
        lastInputLen = s.inputLength;
    }

    // === FINAL REPORT ===
    console.log('\n=== PHASE 1B FINAL REPORT ===');
    console.log(`Duration: ${elapsed()}`);
    console.log(`NONCE: ${NONCE}`);
    console.log(`Tool calls detected: ${toolCallCount}`);
    console.log(`Function results in page: ${functionResultsInPage}`);
    console.log(`Submit count: ${submitCount}`);
    console.log(`Auto-insert detected: ${autoInsertDetected}`);
    console.log(`Auto-submit detected: ${autoSubmitDetected}`);
    console.log(`AI natural response: ${aiNaturalResponse}`);
    console.log(`Kill switch activated: ${killed}`);
    console.log(`Loop complete: ${loopComplete}`);
    
    // Assertions
    const passed = autoInsertDetected && autoSubmitDetected && !killed;
    console.log(`\n${passed ? '✅ PHASE 1B PASSED' : '❌ PHASE 1B FAILED'}`);
    
    if (!autoInsertDetected) console.log('  FAIL: autoInsert not detected');
    if (!autoSubmitDetected) console.log('  FAIL: autoSubmit not detected');
    if (killed) console.log('  FAIL: kill switch was activated (guard triggered)');
    if (!aiNaturalResponse) console.log('  NOTE: AI natural response not confirmed (may need more time)');
    
    console.log('\n=== LOGS ===');
    allLogs.length ? allLogs.forEach(l => console.log(l)) : console.log('(none from MAIN world)');
    
    // Cleanup: disable autoSubmit
    console.log('\nCleanup: disabling autoSubmit...');
    await killAutoSubmit();
    
    ws.close();
    process.exit(passed ? 0 : 1);
})();
