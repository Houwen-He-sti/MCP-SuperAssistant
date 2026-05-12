// Diagnostic helper for Phase 1B investigation. Not part of the canonical regression path.
// notion-new-conversation.cjs — Start a new Notion AI conversation
// The compose button might open an overlay; we need to handle that
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
    console.log('Found Notion tab:', notionTab.url);

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

    // Step 0: Dismiss any overlay by pressing Escape
    console.log('Step 0: Pressing Escape to dismiss any overlay...');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
    await new Promise(r => setTimeout(r, 1000));

    // Step 1: Diagnose — what page are we on and what buttons exist?
    const diag = await send('Runtime.evaluate', {
        expression: `(function() {
            const url = window.location.href;
            const overlay = document.querySelector('.notion-overlay-container');
            const overlayVisible = overlay && overlay.offsetHeight > 0;
            
            // Find all clickable elements that might start a new chat
            const buttons = document.querySelectorAll('[role="button"]');
            const relevantBtns = [];
            buttons.forEach(b => {
                const label = b.getAttribute('aria-label') || '';
                const text = (b.textContent || '').trim().substring(0, 30);
                if (label || text) {
                    relevantBtns.push({ label, text });
                }
            });
            
            // Check for chat-specific UI elements
            const chatInput = document.querySelector('div[role="textbox"][contenteditable="true"]');
            const chatInputContent = chatInput ? (chatInput.textContent || '').substring(0, 80) : 'NONE';
            
            return JSON.stringify({
                url,
                overlayVisible,
                chatInputContent,
                buttonCount: buttons.length,
                relevantButtons: relevantBtns.slice(0, 15)
            }, null, 2);
        })()`,
        returnByValue: true,
    });
    console.log('Diagnostic:', val(diag));

    ws.close();
    process.exit(0);
})();
