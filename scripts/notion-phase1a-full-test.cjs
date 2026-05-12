// notion-phase1a-full-test.cjs
// Complete Phase 1A test: paste content → submit → monitor for autoInsert
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
                text.includes('tool-execution') || text.includes('[AutomationService]') ||
                text.includes('insertText') || text.includes(NONCE) ||
                text.includes('mcp:tool-execution-complete') || text.includes('Tool execution') ||
                text.includes('BatchAware') || text.includes('adapter') ||
                text.includes('ToolLoop') || text.includes('result')) {
                const ts = new Date().toISOString().substring(11, 23);
                automationLogs.push(`[${ts}] ${text.substring(0, 300)}`);
                console.log(`  [LOG] ${text.substring(0, 200)}`);
            }
        }
    });

    // Step 1: Check page state — is there already a conversation?
    const pageState = await send('Runtime.evaluate', {
        expression: `(function() {
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            const messages = document.querySelectorAll('[data-testid*="message"], [class*="message-content"]');
            const url = window.location.href;
            return JSON.stringify({
                url,
                hasInput: !!input,
                inputText: input?.textContent?.substring(0, 50) || '',
                messageCount: messages.length,
                // Check if we're on a new/fresh chat vs existing
                hasChatHistory: document.body.textContent.includes('echo') || document.body.textContent.includes('"${NONCE}"')
            });
        })()`,
        returnByValue: true,
    });
    console.log('Page state:', val(pageState));

    const page = JSON.parse(val(pageState));
    
    if (page.hasChatHistory) {
        console.log('Found existing chat with our nonce or echo — checking if tool already executed...');
        // Check if the echo result is already visible
        const existingResult = await send('Runtime.evaluate', {
            expression: `(function() {
                const body = document.body.textContent;
                const hasToolResult = body.includes('function_result') || body.includes('Echo response');
                const hasNonceResult = body.includes('${NONCE}');
                const sidebarCards = document.querySelectorAll('[class*="tool-loop"], [class*="tool-card"]').length;
                return JSON.stringify({ hasToolResult, hasNonceResult, sidebarCards });
            })()`,
            returnByValue: true,
        });
        console.log('Existing result check:', val(existingResult));
    }

    // Step 2: Start a new conversation
    console.log('\nStarting new conversation...');
    // Press Escape first to dismiss any overlays
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27 });
    await new Promise(r => setTimeout(r, 500));

    // Use Ctrl+O to start new conversation (the keyboard shortcut shown in the UI)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'o', code: 'KeyO', modifiers: 2, windowsVirtualKeyCode: 79 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'o', code: 'KeyO', modifiers: 2, windowsVirtualKeyCode: 79 });
    await new Promise(r => setTimeout(r, 3000));

    // Verify we're on a new chat
    const newChatCheck = await send('Runtime.evaluate', {
        expression: `(function() {
            const url = window.location.href;
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            return JSON.stringify({
                url,
                hasInput: !!input,
                inputEmpty: (input?.textContent || '').trim() === ''
            });
        })()`,
        returnByValue: true,
    });
    console.log('New chat:', val(newChatCheck));

    // Step 3: Focus input and paste the test content
    console.log('\nInserting test content...');
    
    // Read and encode the test file content for safe injection
    const fs = require('fs');
    const path = require('path');
    const testFile = path.resolve(__dirname, '..', '..', 'tmp', 'notion-echo-test-phase1a.md');
    const testContent = fs.readFileSync(testFile, 'utf8');
    const encodedContent = Buffer.from(testContent).toString('base64');
    
    const insertResult = await send('Runtime.evaluate', {
        expression: `(function() {
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            if (!input) return 'NO_INPUT';
            input.focus();
            // Use execCommand for React-compatible insertion
            const content = atob('${encodedContent}');
            document.execCommand('selectAll');
            document.execCommand('insertText', false, content);
            return 'INSERTED_' + content.length;
        })()`,
        returnByValue: true,
    });
    console.log('Insert result:', val(insertResult));
    await new Promise(r => setTimeout(r, 1000));

    // Step 4: Submit the message
    console.log('Submitting...');
    const submitResult = await send('Runtime.evaluate', {
        expression: `(function() {
            const btn = document.querySelector('[data-testid="agent-send-message-button"]');
            if (!btn) return 'NO_SUBMIT_BTN';
            btn.click();
            return 'SUBMITTED';
        })()`,
        returnByValue: true,
    });
    console.log('Submit:', val(submitResult));

    // Step 5: Wait for input to clear (confirms message was sent)
    console.log('Waiting for message to be sent...');
    let messageSent = false;
    for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const check = await send('Runtime.evaluate', {
            expression: `(document.querySelector('div[role="textbox"][contenteditable="true"]')?.textContent || '').length`,
            returnByValue: true,
        });
        const len = val(check);
        if (parseInt(len) < 100) {
            messageSent = true;
            console.log(`Message sent! (inputLength=${len})`);
            break;
        }
        console.log(`  Waiting... inputLength=${len}`);
    }

    if (!messageSent) {
        console.log('ERROR: Message may not have been sent');
        ws.close();
        process.exit(1);
    }

    // Step 6: Monitor for tool execution and auto-insert
    // Timeline: AI thinks (10-30s) → outputs jsonl → scanner detects (1-5s) → 
    //          tool executes (1-3s) → result dispatched → 2s autoInsertDelay → insertText
    console.log('\n=== MONITORING FOR AUTO-INSERT (120 seconds) ===');
    console.log(`Target nonce: ${NONCE}`);
    console.log('Expected in result as: Echo response: ' + NONCE + '\n');
    
    let autoInsertDetected = false;
    let toolResultSeen = false;
    
    for (let i = 0; i < 24; i++) {
        await new Promise(r => setTimeout(r, 5000));
        
        const check = await send('Runtime.evaluate', {
            expression: `(function() {
                const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
                const inputText = input?.textContent || '';
                
                // Check page body for evidence of tool execution
                const pageText = document.body.textContent;
                const hasEchoResponse = pageText.includes('Echo response') || pageText.includes('echo');
                const hasJsonl = pageText.includes('function_call_start');
                
                // Check for tool result cards in sidebar
                const cards = document.querySelectorAll('[class*="tool-loop"], [class*="tool-card"], [class*="mcp-"]');
                
                return JSON.stringify({
                    inputLength: inputText.length,
                    inputHasNonce: inputText.includes('${NONCE}'),
                    inputHasFunctionResult: inputText.includes('function_result'),
                    inputPreview: inputText.substring(0, 150),
                    pageHasEchoResponse: hasEchoResponse,
                    pageHasJsonl: hasJsonl,
                    cardCount: cards.length
                });
            })()`,
            returnByValue: true,
        });
        const result = JSON.parse(val(check));
        
        const elapsed = (i + 1) * 5;
        console.log(`[${elapsed}s] input=${result.inputLength}, nonce=${result.inputHasNonce}, fnResult=${result.inputHasFunctionResult}, echo=${result.pageHasEchoResponse}, jsonl=${result.pageHasJsonl}, cards=${result.cardCount}`);
        
        if (result.inputLength > 0) {
            console.log(`  input: "${result.inputPreview.substring(0, 100)}"`);
        }
        
        if (!toolResultSeen && (result.pageHasEchoResponse || result.cardCount > 0)) {
            toolResultSeen = true;
            console.log('  → Tool execution detected! Waiting for auto-insert...');
        }
        
        // Auto-insert detection: nonce in input OR function_result wrapper in input
        if (result.inputHasNonce || result.inputHasFunctionResult) {
            autoInsertDetected = true;
            console.log(`\n✅ AUTO-INSERT DETECTED!`);
            console.log(`Input preview: ${result.inputPreview}`);
            break;
        }
    }

    if (!autoInsertDetected) {
        console.log('\n❌ AUTO-INSERT NOT DETECTED after 120 seconds');
        
        // Diagnostic
        const diag = await send('Runtime.evaluate', {
            expression: `(function() {
                const pageText = document.body.textContent;
                return JSON.stringify({
                    pageContainsNonce: pageText.includes('${NONCE}'),
                    pageContainsEchoResponse: pageText.includes('Echo response'),
                    pageContainsFunctionResult: pageText.includes('function_result'),
                    inputText: (document.querySelector('div[role="textbox"][contenteditable="true"]')?.textContent || '').substring(0, 200)
                });
            })()`,
            returnByValue: true,
        });
        console.log('Final diagnostic:', val(diag));
    }

    // Print all captured logs
    console.log('\n=== ALL CAPTURED AUTOMATION LOGS ===');
    if (automationLogs.length === 0) {
        console.log('(No automation-related logs captured via CDP)');
        console.log('NOTE: Content script logs may not be visible via CDP Runtime.consoleAPICalled');
        console.log('Check chrome://extensions for content script errors');
    } else {
        automationLogs.forEach(l => console.log(l));
    }
    
    ws.close();
    process.exit(autoInsertDetected ? 0 : 1);
})();
