// notion-phase1a-clipboard-test.cjs
// Use clipboard paste (like notion-send does) to properly insert content
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');

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

    // Enable console + log
    await send('Runtime.enable');
    await send('Log.enable');

    // Capture automation logs
    const automationLogs = [];
    ws.on('message', msg => {
        const obj = JSON.parse(msg);
        if (obj.method === 'Runtime.consoleAPICalled') {
            const text = (obj.params.args || []).map(a => a.value || a.description || '').join(' ');
            if (text.includes('Automation') || text.includes('[AutomationService]') || 
                text.includes('auto insert') || text.includes('Auto Insert') ||
                text.includes('tool-execution') || text.includes(NONCE) ||
                text.includes('insertText') || text.includes('adapter')) {
                const ts = new Date().toISOString().substring(11, 23);
                automationLogs.push(`[${ts}] ${text.substring(0, 300)}`);
                console.log(`  [LOG] ${text.substring(0, 200)}`);
            }
        }
    });

    // Step 1: Start new conversation with Ctrl+O
    console.log('Starting new chat (Ctrl+O)...');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27 });
    await new Promise(r => setTimeout(r, 500));
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'o', code: 'KeyO', modifiers: 2, windowsVirtualKeyCode: 79 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'o', code: 'KeyO', modifiers: 2, windowsVirtualKeyCode: 79 });
    await new Promise(r => setTimeout(r, 3000));

    // Step 2: Focus the input
    console.log('Focusing input...');
    const focusResult = await send('Runtime.evaluate', {
        expression: `(function() {
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            if (!input) return 'NO_INPUT';
            input.focus();
            return 'FOCUSED';
        })()`,
        returnByValue: true,
    });
    console.log('Focus:', val(focusResult));
    if (val(focusResult) !== 'FOCUSED') { ws.close(); process.exit(1); }
    await new Promise(r => setTimeout(r, 500));

    // Step 3: Use CDP clipboard + paste to insert content (exactly like notion-send)
    const testFile = path.resolve(__dirname, '..', '..', 'tmp', 'notion-echo-test-phase1a.md');
    const testContent = fs.readFileSync(testFile, 'utf8');
    console.log(`Pasting content (${testContent.length} chars)...`);
    
    // Select all first (in case there's existing content)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await new Promise(r => setTimeout(r, 200));
    
    // Use Input.insertText to simulate paste-like behavior
    await send('Input.insertText', { text: testContent });
    await new Promise(r => setTimeout(r, 1000));

    // Verify content was inserted
    const verifyInsert = await send('Runtime.evaluate', {
        expression: `(function() {
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            const text = input?.textContent || '';
            return JSON.stringify({ length: text.length, hasNonce: text.includes('${NONCE}') });
        })()`,
        returnByValue: true,
    });
    console.log('Verify insert:', val(verifyInsert));
    
    const insertVerify = JSON.parse(val(verifyInsert));
    if (!insertVerify.hasNonce) {
        console.log('ERROR: Content not properly inserted');
        ws.close();
        process.exit(1);
    }

    // Step 4: Wait a moment for Notion to register the content, then submit
    await new Promise(r => setTimeout(r, 1000));
    console.log('Submitting via Enter key...');
    
    // Use Enter to submit (Notion AI uses Enter to send in the chat input)
    // But first check if Enter submits or creates newline — Notion uses Enter to submit
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    
    await new Promise(r => setTimeout(r, 3000));

    // Check if URL changed (indicates message was sent)
    const afterSubmit = await send('Runtime.evaluate', {
        expression: `(function() {
            const url = window.location.href;
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            const text = input?.textContent || '';
            return JSON.stringify({ url, inputLength: text.length, inputEmpty: text.trim() === '' });
        })()`,
        returnByValue: true,
    });
    console.log('After submit:', val(afterSubmit));
    
    const submitState = JSON.parse(val(afterSubmit));
    
    if (submitState.inputLength > 100) {
        // Enter might have just created a newline. Try clicking submit button
        console.log('Enter did not submit. Trying button click...');
        await send('Runtime.evaluate', {
            expression: `document.querySelector('[data-testid="agent-send-message-button"]')?.click()`,
            returnByValue: true,
        });
        await new Promise(r => setTimeout(r, 3000));
        
        const afterClick = await send('Runtime.evaluate', {
            expression: `(function() {
                const url = window.location.href;
                const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
                return JSON.stringify({ url, inputLength: (input?.textContent || '').length });
            })()`,
            returnByValue: true,
        });
        console.log('After button click:', val(afterClick));
    }

    // Step 5: Wait for message to be processed
    console.log('\nWaiting for AI to process message...');
    let aiResponding = false;
    for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const check = await send('Runtime.evaluate', {
            expression: `(function() {
                const url = window.location.href;
                const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
                const inputLen = (input?.textContent || '').length;
                const hasStop = !!document.querySelector('[aria-label="停止"], [aria-label="Stop"]');
                const pageText = document.body.textContent;
                const hasJsonl = pageText.includes('function_call_start');
                const hasNonce = pageText.includes('${NONCE}');
                return JSON.stringify({ url, inputLen, hasStop, hasJsonl, hasNonce });
            })()`,
            returnByValue: true,
        });
        const state = JSON.parse(val(check));
        console.log(`  [${(i+1)*3}s] url_changed=${state.url !== 'https://www.notion.so/ai'}, input=${state.inputLen}, streaming=${state.hasStop}, jsonl=${state.hasJsonl}, nonce=${state.hasNonce}`);
        
        if (state.url !== 'https://www.notion.so/ai') {
            aiResponding = true;
            console.log('  → URL changed! AI is processing.');
        }
        
        if (state.hasJsonl) {
            console.log('  → JSONL detected in page! Tool call output detected.');
            break;
        }
        
        if (state.hasNonce) {
            console.log('  → Nonce detected in page! Echo result visible.');
            break;
        }
    }

    if (!aiResponding) {
        console.log('\nWARNING: URL never changed. Message may not have been sent properly.');
    }

    // Step 6: Now monitor for auto-insert (60 seconds from tool execution)
    console.log('\n=== MONITORING FOR AUTO-INSERT (90 seconds) ===');
    let autoInsertDetected = false;
    for (let i = 0; i < 18; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const check = await send('Runtime.evaluate', {
            expression: `(function() {
                const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
                const inputText = input?.textContent || '';
                return JSON.stringify({
                    inputLength: inputText.length,
                    inputHasNonce: inputText.includes('${NONCE}'),
                    inputHasFunctionResult: inputText.includes('function_result'),
                    inputPreview: inputText.substring(0, 150)
                });
            })()`,
            returnByValue: true,
        });
        const result = JSON.parse(val(check));
        const elapsed = (i + 1) * 5;
        console.log(`[${elapsed}s] input=${result.inputLength}, nonce=${result.inputHasNonce}, fnResult=${result.inputHasFunctionResult}`);
        
        if (result.inputLength > 0) {
            console.log(`  preview: "${result.inputPreview.substring(0, 100)}"`);
        }
        
        if (result.inputHasNonce || result.inputHasFunctionResult) {
            autoInsertDetected = true;
            console.log(`\n✅ AUTO-INSERT DETECTED!`);
            break;
        }
    }

    if (!autoInsertDetected) {
        console.log('\n❌ AUTO-INSERT NOT DETECTED');
    }

    // Print logs
    console.log('\n=== AUTOMATION LOGS ===');
    if (automationLogs.length === 0) {
        console.log('(None captured — content script logs not visible via CDP MAIN world)');
    } else {
        automationLogs.forEach(l => console.log(l));
    }
    
    ws.close();
    process.exit(autoInsertDetected ? 0 : 1);
})();
