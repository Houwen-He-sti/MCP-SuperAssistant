// notion-submit-result.cjs — Submit the injected MCP result to Notion AI
const WebSocket = require('ws');
const http = require('http');

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
    const notionTab = targets.find(t => t.url.includes('notion.so'));
    if (!notionTab) { console.log('ERROR: No Notion tab'); process.exit(1); }

    const ws = new WebSocket(notionTab.webSocketDebuggerUrl);
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

    // Step 1: Verify content in input
    const inputContent = await send('Runtime.evaluate', {
        expression: `(function() {
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            return input ? input.textContent.substring(0, 300) : 'NO INPUT';
        })()`,
        returnByValue: true,
    });
    console.log('Input content before submit:', val(inputContent));

    // Step 2: Focus the input and press Enter to submit
    console.log('Submitting...');
    
    // Focus the input first
    await send('Runtime.evaluate', {
        expression: `(function() {
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            if (input) input.focus();
            return 'focused';
        })()`,
        returnByValue: true,
    });
    
    // Try clicking the send button
    const sendResult = await send('Runtime.evaluate', {
        expression: `(function() {
            // Look for send button
            const sendBtn = document.querySelector('[aria-label="发送"], [aria-label="Send"], button[type="submit"]');
            if (sendBtn) {
                sendBtn.click();
                return 'Clicked send button: ' + (sendBtn.getAttribute('aria-label') || sendBtn.textContent);
            }
            
            // Try the form submit approach
            const form = document.querySelector('form');
            if (form) {
                form.requestSubmit();
                return 'Form submitted';
            }
            
            return 'No send button or form found';
        })()`,
        returnByValue: true,
    });
    console.log('Send result:', val(sendResult));

    // If no button found, try Enter key
    if (val(sendResult).includes('No send')) {
        console.log('Trying Enter key...');
        await send('Input.dispatchKeyEvent', {
            type: 'keyDown', key: 'Enter', code: 'Enter',
            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
        });
        await send('Input.dispatchKeyEvent', {
            type: 'keyUp', key: 'Enter', code: 'Enter',
            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
        });
    }

    // Wait for response
    console.log('Waiting for Notion AI response...');
    await new Promise(r => setTimeout(r, 15000));

    // Step 3: Check for new response
    const response = await send('Runtime.evaluate', {
        expression: `(function() {
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            const inputText = input ? input.textContent.substring(0, 100) : 'NO INPUT';
            
            // Look for code blocks (potential new tool calls or responses)
            const pres = document.querySelectorAll('pre');
            const codeBlocks = [];
            pres.forEach(p => {
                codeBlocks.push(p.textContent.substring(0, 300));
            });
            
            // Get all visible text that might be response
            const allText = document.body.innerText;
            // Find text containing "echo" or "hello" or bridge-related
            const lines = allText.split('\\n').filter(l => 
                l.includes('echo') || l.includes('hello') || 
                l.includes('桥接') || l.includes('成功') || 
                l.includes('连通') || l.includes('result')
            );
            
            return JSON.stringify({
                inputNowEmpty: inputText.length < 5,
                inputText,
                codeBlocks: codeBlocks.slice(0, 5),
                relevantLines: lines.slice(0, 10)
            }, null, 2);
        })()`,
        returnByValue: true,
    });
    console.log('Response check:', val(response));

    ws.close();
    process.exit(0);
})();
