// Observe page state after navigation — what's the actual DOM?
const http = require('http');
const WebSocket = require('ws');

(async () => {
    const targets = await new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:9222/json', res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
    });

    const tab = targets.find(t => /notion\.so/.test(t.url));
    if (!tab) { console.log('No Notion tab'); process.exit(1); }
    console.log('Tab URL:', tab.url);

    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));

    let msgId = 0;
    function send(method, params, timeoutMs = 15000) {
        return new Promise((resolve, reject) => {
            const id = ++msgId;
            const timer = setTimeout(() => { ws.off('message', handler); reject(new Error('timeout')); }, timeoutMs);
            function handler(msg) {
                const obj = JSON.parse(msg);
                if (obj.id === id) { clearTimeout(timer); ws.off('message', handler); resolve(obj); }
            }
            ws.on('message', handler);
            ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
    }
    function val(r) { return r.result?.result?.value; }

    await send('Runtime.enable');

    // Check current URL
    const urlCheck = await send('Runtime.evaluate', {
        expression: 'window.location.href',
        returnByValue: true,
    });
    console.log('Current URL:', val(urlCheck));

    // Check for textbox
    const textboxCheck = await send('Runtime.evaluate', {
        expression: `(function() {
            const textbox = document.querySelector('div[role="textbox"][contenteditable="true"]');
            const allTextboxes = document.querySelectorAll('[role="textbox"]');
            const allContentEditable = document.querySelectorAll('[contenteditable="true"]');
            const sendBtn = document.querySelector('[data-testid="agent-send-message-button"]');
            const allBtns = Array.from(document.querySelectorAll('button')).map(b => ({
                text: b.textContent.substring(0, 50),
                ariaLabel: b.getAttribute('aria-label'),
                testid: b.getAttribute('data-testid')
            })).filter(b => b.text || b.ariaLabel || b.testid);
            return JSON.stringify({
                hasTextbox: !!textbox,
                textboxCount: allTextboxes.length,
                contentEditableCount: allContentEditable.length,
                hasSendBtn: !!sendBtn,
                buttons: allBtns.slice(0, 15),
                bodyTextLength: document.body.innerText.length,
                bodyPreview: document.body.innerText.substring(0, 300),
            });
        })()`,
        returnByValue: true,
    });
    const state = JSON.parse(val(textboxCheck));
    console.log('Page state:', JSON.stringify(state, null, 2));

    ws.close();
})();
