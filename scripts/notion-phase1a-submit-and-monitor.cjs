// notion-phase1a-submit-and-monitor.cjs
// Step 1: Submit the current input content (pasted by notion-send but not submitted)
// Step 2: Monitor for AI response + tool execution + auto-insert of RESULT
const WebSocket = require('ws');
const http = require('http');

const NONCE = 'AUTOINSERT_PHASE1A_20250714';

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

    // Enable console capturing
    await send('Runtime.enable');
    await send('Log.enable');

    // Capture automation-related console messages
    const automationLogs = [];
    ws.on('message', msg => {
        const obj = JSON.parse(msg);
        if (obj.method === 'Runtime.consoleAPICalled') {
            const text = (obj.params.args || []).map(a => a.value || a.description || '').join(' ');
            if (text.includes('Automation') || text.includes('automation') || 
                text.includes('auto insert') || text.includes('Auto Insert') ||
                text.includes('tool-execution') || text.includes('adapter') ||
                text.includes('insertText') || text.includes(NONCE) ||
                text.includes('[AutomationService]') || text.includes('BatchAware') ||
                text.includes('mcp:tool-execution-complete') || text.includes('Tool execution')) {
                const ts = new Date().toISOString().substring(11, 23);
                automationLogs.push(`[${ts}] ${text.substring(0, 300)}`);
                console.log(`  [LOG] ${text.substring(0, 200)}`);
            }
        }
    });

    // Step 1: Check current input state
    const inputState = await send('Runtime.evaluate', {
        expression: `(function() {
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            if (!input) return JSON.stringify({ status: 'NO_INPUT' });
            const text = input.textContent || '';
            return JSON.stringify({
                length: text.length,
                hasNonce: text.includes('${NONCE}'),
                preview: text.substring(0, 80)
            });
        })()`,
        returnByValue: true,
    });
    console.log('Current input:', val(inputState));
    const state = JSON.parse(val(inputState));

    if (!state.hasNonce) {
        console.log('ERROR: Nonce not in input. Need to re-paste the test file.');
        ws.close();
        process.exit(1);
    }

    // Step 2: Submit the message by clicking the send button
    console.log('\nSubmitting message...');
    const submitResult = await send('Runtime.evaluate', {
        expression: `(function() {
            const btn = document.querySelector('[data-testid="agent-send-message-button"]');
            if (!btn) return 'SUBMIT_BTN_NOT_FOUND';
            btn.click();
            return 'CLICKED';
        })()`,
        returnByValue: true,
    });
    console.log('Submit result:', val(submitResult));

    if (val(submitResult) !== 'CLICKED') {
        console.log('ERROR: Could not submit');
        ws.close();
        process.exit(1);
    }

    // Step 3: Wait for input to clear (message sent)
    console.log('Waiting for input to clear...');
    let cleared = false;
    for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const check = await send('Runtime.evaluate', {
            expression: `(document.querySelector('div[role="textbox"][contenteditable="true"]')?.textContent || '').length`,
            returnByValue: true,
        });
        const len = val(check);
        if (len === 0 || len < 100) {
            cleared = true;
            console.log(`Input cleared (length=${len})`);
            break;
        }
        console.log(`  Still waiting... inputLength=${len}`);
    }

    if (!cleared) {
        console.log('WARNING: Input may not have cleared, continuing anyway...');
    }

    // Step 4: Wait for AI response + tool execution + auto-insert
    // Expected timeline: AI thinks (10-30s) → outputs jsonl → scanner detects → executes tool → 
    //                    result dispatched → AutomationService waits 2s → insertText
    // Total expected: 20-60 seconds
    console.log('\nWaiting for AI response, tool execution, and auto-insert (checking for 120 seconds)...');
    console.log(`Looking for nonce: ${NONCE}`);
    
    let autoInsertDetected = false;
    for (let i = 0; i < 24; i++) {
        await new Promise(r => setTimeout(r, 5000));
        
        const check = await send('Runtime.evaluate', {
            expression: `(function() {
                const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
                const text = input?.textContent || '';
                return JSON.stringify({
                    hasNonce: text.includes('${NONCE}'),
                    inputLength: text.length,
                    inputPreview: text.substring(0, 150),
                    // Also check for function_result wrapper (means result was formatted)
                    hasFunctionResult: text.includes('function_result'),
                    // Check for the sidebar panel showing result
                    sidebarCards: document.querySelectorAll('.mcp-tool-card, [class*="tool-result"], [class*="tool-loop"]').length
                });
            })()`,
            returnByValue: true,
        });
        const result = JSON.parse(val(check));
        
        const elapsed = (i + 1) * 5;
        console.log(`[${elapsed}s] input=${result.inputLength}, hasNonce=${result.hasNonce}, hasFnResult=${result.hasFunctionResult}, cards=${result.sidebarCards}`);
        if (result.inputLength > 0 && result.inputLength < 1900) {
            console.log(`  preview: "${result.inputPreview}"`);
        }
        
        if (result.hasNonce && result.inputLength < 1000) {
            // Nonce found in input BUT length < 1000 means it's the result, not the original paste
            autoInsertDetected = true;
            console.log(`\n✅ AUTO-INSERT DETECTED! Nonce found in input with length ${result.inputLength}`);
            console.log(`Preview: ${result.inputPreview}`);
            break;
        }
        
        if (result.hasFunctionResult) {
            autoInsertDetected = true;
            console.log(`\n✅ AUTO-INSERT DETECTED! function_result wrapper found in input`);
            console.log(`Preview: ${result.inputPreview}`);
            break;
        }
    }

    if (!autoInsertDetected) {
        console.log('\n❌ AUTO-INSERT NOT DETECTED after 120 seconds');
        
        // Final diagnostic: check sidebar for tool result
        const diagnostic = await send('Runtime.evaluate', {
            expression: `(function() {
                const cards = document.querySelectorAll('.mcp-tool-card, [class*="tool-result"], [class*="tool-loop"]');
                const sidebar = document.querySelector('.mcp-sidebar, [class*="sidebar"]');
                return JSON.stringify({
                    cardCount: cards.length,
                    sidebarExists: !!sidebar,
                    // Check if there's any mention of the nonce in the page
                    pageHasNonce: document.body.textContent.includes('${NONCE}')
                });
            })()`,
            returnByValue: true,
        });
        console.log('Diagnostic:', val(diagnostic));
    }

    // Print all captured logs
    console.log('\n=== ALL CAPTURED AUTOMATION LOGS ===');
    if (automationLogs.length === 0) {
        console.log('(No automation-related logs captured)');
    } else {
        automationLogs.forEach(l => console.log(l));
    }
    
    ws.close();
    process.exit(autoInsertDetected ? 0 : 1);
})();
