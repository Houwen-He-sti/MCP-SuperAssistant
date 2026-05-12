// notion-phase1a-real-paste.cjs
// Use actual clipboard API + Ctrl+V to paste (same as notion-send)
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

    // Enable
    await send('Runtime.enable');
    await send('Log.enable');

    // Capture logs
    const automationLogs = [];
    ws.on('message', msg => {
        const obj = JSON.parse(msg);
        if (obj.method === 'Runtime.consoleAPICalled') {
            const text = (obj.params.args || []).map(a => a.value || a.description || '').join(' ');
            if (text.includes('Automation') || text.includes('[AutomationService]') || 
                text.includes('auto insert') || text.includes('Auto Insert') ||
                text.includes('tool-execution') || text.includes(NONCE) ||
                text.includes('insertText') || text.includes('adapter')) {
                automationLogs.push(`${text.substring(0, 300)}`);
                console.log(`  [LOG] ${text.substring(0, 150)}`);
            }
        }
    });

    // Step 1: Start new conversation
    console.log('New chat (Ctrl+O)...');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27 });
    await new Promise(r => setTimeout(r, 300));
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'o', code: 'KeyO', modifiers: 2, windowsVirtualKeyCode: 79 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'o', code: 'KeyO', modifiers: 2, windowsVirtualKeyCode: 79 });
    await new Promise(r => setTimeout(r, 3000));

    // Step 2: Focus input
    const focus = await send('Runtime.evaluate', {
        expression: `(function() {
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            if (!input) return 'NO_INPUT';
            input.focus();
            return 'OK';
        })()`,
        returnByValue: true,
    });
    if (val(focus) !== 'OK') { console.log('No input found'); ws.close(); process.exit(1); }
    await new Promise(r => setTimeout(r, 500));

    // Step 3: Write to clipboard and paste
    const testFile = path.resolve(__dirname, '..', '..', 'tmp', 'notion-echo-test-phase1a.md');
    const testContent = fs.readFileSync(testFile, 'utf8');
    // Escape for JS string injection
    const escaped = JSON.stringify(testContent);
    
    console.log(`Writing ${testContent.length} chars to clipboard...`);
    const clipResult = await send('Runtime.evaluate', {
        expression: `navigator.clipboard.writeText(${escaped}).then(() => 'OK').catch(e => 'ERR: ' + e.message)`,
        awaitPromise: true,
        returnByValue: true,
    });
    console.log('Clipboard write:', val(clipResult));
    
    if (val(clipResult) !== 'OK') {
        console.log('Clipboard write failed. Trying alternative approach...');
        // Alternative: use DOM clipboard event
        await send('Runtime.evaluate', {
            expression: `(function() {
                const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
                input.focus();
                // Create and dispatch paste event with our text
                const clipboardData = new DataTransfer();
                clipboardData.setData('text/plain', ${escaped});
                const pasteEvent = new ClipboardEvent('paste', {
                    bubbles: true,
                    cancelable: true,
                    clipboardData: clipboardData
                });
                input.dispatchEvent(pasteEvent);
                return 'dispatched';
            })()`,
            returnByValue: true,
        });
        await new Promise(r => setTimeout(r, 1000));
    } else {
        // Ctrl+A then Ctrl+V
        console.log('Pasting (Ctrl+A → Ctrl+V)...');
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
        await new Promise(r => setTimeout(r, 200));
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86 });
        await new Promise(r => setTimeout(r, 1500));
    }

    // Verify paste
    const verifyPaste = await send('Runtime.evaluate', {
        expression: `(function() {
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            const text = input?.textContent || '';
            return JSON.stringify({ length: text.length, hasNonce: text.includes('${NONCE}'), preview: text.substring(0, 80) });
        })()`,
        returnByValue: true,
    });
    console.log('Verify paste:', val(verifyPaste));
    
    const pasteVerify = JSON.parse(val(verifyPaste));
    if (!pasteVerify.hasNonce) {
        console.log('PASTE FAILED! Trying notion-send style direct approach...');
        // Last resort: directly set via clipboard paste event 
        ws.close();
        process.exit(1);
    }

    // Step 4: Submit
    console.log('Submitting (button click)...');
    await send('Runtime.evaluate', {
        expression: `document.querySelector('[data-testid="agent-send-message-button"]')?.click()`,
        returnByValue: true,
    });
    await new Promise(r => setTimeout(r, 3000));

    // Verify submission
    const afterSubmit = await send('Runtime.evaluate', {
        expression: `(function() {
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            const url = window.location.href;
            return JSON.stringify({ url, inputLen: (input?.textContent || '').length });
        })()`,
        returnByValue: true,
    });
    console.log('After submit:', val(afterSubmit));
    
    const submitState = JSON.parse(val(afterSubmit));
    if (submitState.inputLen > 100) {
        console.log('Message not sent! Input still has content.');
        ws.close();
        process.exit(1);
    }
    console.log('Message sent successfully!');

    // Step 5: Wait for AI response + tool execution + auto-insert
    console.log('\n=== MONITORING (180s: AI response → tool exec → autoInsert) ===');
    let aiResponded = false;
    let toolDetected = false;
    let autoInsertDetected = false;
    
    for (let i = 0; i < 36; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const check = await send('Runtime.evaluate', {
            expression: `(function() {
                const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
                const inputText = input?.textContent || '';
                const pageText = document.body.textContent;
                const url = window.location.href;
                return JSON.stringify({
                    url,
                    inputLength: inputText.length,
                    inputHasNonce: inputText.includes('${NONCE}'),
                    inputHasFunctionResult: inputText.includes('function_result'),
                    inputPreview: inputText.substring(0, 100),
                    pageHasJsonl: pageText.includes('function_call_start'),
                    pageHasNonce: pageText.includes('${NONCE}'),
                    pageHasEchoResponse: pageText.includes('Echo response'),
                    streaming: !!document.querySelector('[aria-label="停止"], [aria-label="Stop"]')
                });
            })()`,
            returnByValue: true,
        });
        const r = JSON.parse(val(check));
        const elapsed = (i + 1) * 5;
        
        let status = '';
        if (r.streaming) status += ' [STREAMING]';
        if (r.pageHasJsonl && !toolDetected) { toolDetected = true; status += ' [JSONL!]'; }
        if (r.pageHasNonce && !aiResponded) { aiResponded = true; status += ' [NONCE_IN_PAGE!]'; }
        if (r.pageHasEchoResponse) status += ' [ECHO_RESP]';
        
        console.log(`[${elapsed}s] in=${r.inputLength} jsonl=${r.pageHasJsonl} nonce_page=${r.pageHasNonce} nonce_input=${r.inputHasNonce}${status}`);
        
        if (r.inputLength > 0) {
            console.log(`  input: "${r.inputPreview}"`);
        }
        
        if (r.inputHasNonce || r.inputHasFunctionResult) {
            autoInsertDetected = true;
            console.log(`\n✅ AUTO-INSERT WORKING! Input has tool result.`);
            break;
        }
    }

    if (!autoInsertDetected) {
        console.log('\n❌ AUTO-INSERT NOT DETECTED after 180 seconds');
        console.log(`AI responded: ${aiResponded}, Tool detected: ${toolDetected}`);
    }

    console.log('\n=== AUTOMATION LOGS ===');
    automationLogs.length ? automationLogs.forEach(l => console.log(l)) : console.log('(none)');
    
    ws.close();
    process.exit(autoInsertDetected ? 0 : 1);
})();
