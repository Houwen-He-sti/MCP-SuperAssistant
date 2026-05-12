// Quick CDP script to send a message to ChatGPT tab
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const msgFile = process.argv[2];
if (!msgFile) { console.log('Usage: node tmp-chatgpt-send.cjs <message-file>'); process.exit(1); }
const message = fs.readFileSync(path.resolve(msgFile), 'utf8');

async function getTargets() {
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
    const chatgptTab = targets.find(t => t.url && t.url.includes('chatgpt.com'));
    if (!chatgptTab) {
        console.log('ERROR: No ChatGPT tab found');
        process.exit(1);
    }
    console.log('Found ChatGPT tab:', chatgptTab.url.substring(0, 80));

    const ws = new WebSocket(chatgptTab.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));
    console.log('CDP connected');

    let msgId = 0;
    function send(method, params) {
        return new Promise((resolve, reject) => {
            const id = ++msgId;
            const handler = msg => {
                const obj = JSON.parse(msg);
                if (obj.id === id) { ws.off('message', handler); resolve(obj); }
            };
            ws.on('message', handler);
            ws.send(JSON.stringify({ id, method, params: params || {} }));
            setTimeout(() => { ws.off('message', handler); reject(new Error('timeout')); }, 30000);
        });
    }
    function val(r) { return r.result?.result?.value; }

    await send('Runtime.enable');

    // Find input textbox
    const inputCheck = val(await send('Runtime.evaluate', {
        expression: `(function() {
            var input = document.querySelector('#prompt-textarea');
            if (!input) return 'NO_INPUT';
            var rect = input.getBoundingClientRect();
            return JSON.stringify({ tag: input.tagName, x: Math.round(rect.x + rect.width/2), y: Math.round(rect.y + rect.height/2) });
        })()`,
        returnByValue: true,
    }));
    console.log('Input:', inputCheck);
    if (inputCheck === 'NO_INPUT') {
        console.log('ERROR: ChatGPT input not found');
        ws.close(); process.exit(1);
    }
    const inputRect = JSON.parse(inputCheck);

    // Click to focus
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: inputRect.x, y: inputRect.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: inputRect.x, y: inputRect.y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 500));

    // Clear existing content (select all + delete)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await new Promise(r => setTimeout(r, 200));
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await new Promise(r => setTimeout(r, 300));

    // Paste the message via clipboard
    // Use Input.insertText which works well with ChatGPT's textarea
    console.log(`Inserting message (${message.length} chars)...`);
    await send('Input.insertText', { text: message });
    await new Promise(r => setTimeout(r, 1000));

    // Verify text was inserted
    const verifyText = val(await send('Runtime.evaluate', {
        expression: `(function() {
            var input = document.querySelector('#prompt-textarea');
            var text = input?.textContent || input?.value || '';
            return JSON.stringify({ length: text.length, preview: text.substring(0, 60) });
        })()`,
        returnByValue: true,
    }));
    console.log('Verify:', verifyText);

    // Find and click send button
    const sendResult = val(await send('Runtime.evaluate', {
        expression: `(function() {
            var btn = document.querySelector('[data-testid="send-button"]');
            if (!btn) {
                // Try aria label
                var btns = document.querySelectorAll('button');
                for (var i = 0; i < btns.length; i++) {
                    var label = btns[i].getAttribute('aria-label') || '';
                    if (label.includes('Send') || label.includes('发送')) {
                        btn = btns[i];
                        break;
                    }
                }
            }
            if (!btn) return 'NO_SEND_BTN';
            btn.click();
            return 'clicked';
        })()`,
        returnByValue: true,
    }));
    console.log('Send:', sendResult);

    if (sendResult === 'clicked') {
        console.log('✅ Message sent to ChatGPT!');
        // Wait for response (poll for streaming to start and stop)
        console.log('Waiting for GPT response...');
        for (let i = 0; i < 120; i++) {
            await new Promise(r => setTimeout(r, 5000));
            const status = val(await send('Runtime.evaluate', {
                expression: `(function() {
                    var stopBtn = document.querySelector('[data-testid="stop-button"]');
                    if (stopBtn) return 'streaming';
                    // Check last assistant message
                    var msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
                    if (msgs.length === 0) return 'waiting';
                    var last = msgs[msgs.length - 1];
                    return JSON.stringify({ done: true, length: last.textContent.length, preview: last.textContent.substring(0, 200) });
                })()`,
                returnByValue: true,
            }));
            if (status === 'streaming') {
                process.stdout.write('.');
                continue;
            }
            if (status === 'waiting') {
                process.stdout.write('w');
                continue;
            }
            // Got response
            console.log('\n\nGPT Response preview:');
            try {
                const resp = JSON.parse(status);
                console.log(`Length: ${resp.length}`);
                console.log(resp.preview + '...');
            } catch (e) {
                console.log(status);
            }
            break;
        }
    } else {
        console.log('❌ Could not find send button');
    }

    ws.close();
})();
