// Diagnostic helper for Phase 1B investigation. Not part of the canonical regression path.
// notion-start-new-chat.cjs — Start new conversation in Notion AI, dismiss overlays
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

    // Step 1: Dismiss overlay by pressing Escape multiple times
    console.log('Step 1: Dismissing overlays...');
    for (let i = 0; i < 3; i++) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await new Promise(r => setTimeout(r, 500));
    }

    // Step 2: Click "开始新对话" button
    console.log('Step 2: Clicking "开始新对话" or "新对话" button...');
    const clickResult = await send('Runtime.evaluate', {
        expression: `(function() {
            // Try "开始新对话" first (seems more specific)
            let btn = document.querySelector('[aria-label="开始新对话"]');
            if (btn) { btn.click(); return 'clicked 开始新对话'; }
            
            // Then try "新对话"
            btn = document.querySelector('[aria-label="新对话"]');
            if (btn) { btn.click(); return 'clicked 新对话'; }
            
            // Fallback: Ctrl+O shortcut
            return 'no button found, try Ctrl+O';
        })()`,
        returnByValue: true,
    });
    console.log('Click result:', val(clickResult));

    // If no button found, try Ctrl+O shortcut
    if (val(clickResult) === 'no button found, try Ctrl+O') {
        await send('Input.dispatchKeyEvent', {
            type: 'keyDown', key: 'o', code: 'KeyO',
            modifiers: 2, // Ctrl
            windowsVirtualKeyCode: 79,
        });
        await send('Input.dispatchKeyEvent', {
            type: 'keyUp', key: 'o', code: 'KeyO',
            modifiers: 2,
            windowsVirtualKeyCode: 79,
        });
        console.log('Sent Ctrl+O');
    }

    // Wait for new conversation to load
    console.log('Waiting for new conversation to load...');
    await new Promise(r => setTimeout(r, 5000));

    // Step 3: Verify state
    const verify = await send('Runtime.evaluate', {
        expression: `(function() {
            const url = window.location.href;
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            const inputContent = input ? (input.textContent || '').substring(0, 100) : 'NONE';
            const overlay = document.querySelector('.notion-overlay-container');
            const overlayVisible = overlay ? overlay.offsetHeight > 0 : false;
            return JSON.stringify({ url, inputContent, overlayVisible });
        })()`,
        returnByValue: true,
    });
    console.log('Final state:', val(verify));

    ws.close();
    process.exit(0);
})();
