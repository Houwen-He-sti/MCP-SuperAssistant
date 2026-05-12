// Diagnostic helper for Phase 1B investigation. Not part of the canonical regression path.
// notion-click-insert.cjs — Click the Insert button to re-inject MCP result into conversation
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

    // Step 1: Check current state — is insert button still there?
    const state = await send('Runtime.evaluate', {
        expression: `(function() {
            const btn = document.querySelector('.insert-result-button[data-result-id]');
            if (!btn) return 'No insert button found';
            return JSON.stringify({
                resultId: btn.getAttribute('data-result-id'),
                text: btn.textContent,
                disabled: btn.disabled,
                visible: btn.offsetHeight > 0
            });
        })()`,
        returnByValue: true,
    });
    console.log('Insert button state:', val(state));

    // Step 2: Click the Insert button
    const clickResult = await send('Runtime.evaluate', {
        expression: `(function() {
            const btn = document.querySelector('.insert-result-button[data-result-id]');
            if (!btn) return 'No insert button';
            btn.click();
            return 'Clicked insert button: ' + btn.getAttribute('data-result-id');
        })()`,
        returnByValue: true,
    });
    console.log('Click result:', val(clickResult));

    // Wait for result to be inserted
    await new Promise(r => setTimeout(r, 3000));

    // Step 3: Check if result was inserted into chat input
    const inputCheck = await send('Runtime.evaluate', {
        expression: `(function() {
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            if (!input) return 'No input found';
            return JSON.stringify({
                content: input.textContent.substring(0, 500),
                hasContent: input.textContent.length > 0
            });
        })()`,
        returnByValue: true,
    });
    console.log('Input after insert:', val(inputCheck));

    // Step 4: Check if the result was auto-submitted (look for new messages)
    const msgCheck = await send('Runtime.evaluate', {
        expression: `(function() {
            // Count messages
            const allMsgs = document.querySelectorAll('[class*="message"]');
            const textContents = [];
            allMsgs.forEach(m => {
                const t = m.textContent.trim();
                if (t.length > 5 && t.length < 500 && (t.includes('echo') || t.includes('hello') || t.includes('结果') || t.includes('result'))) {
                    textContents.push(t.substring(0, 100));
                }
            });
            return JSON.stringify({
                totalMsgElements: allMsgs.length,
                relevantContent: textContents.slice(0, 5)
            });
        })()`,
        returnByValue: true,
    });
    console.log('Messages after insert:', val(msgCheck));

    ws.close();
    process.exit(0);
})();
