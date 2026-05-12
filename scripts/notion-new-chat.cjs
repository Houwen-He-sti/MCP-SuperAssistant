// Diagnostic helper for Phase 1B investigation. Not part of the canonical regression path.
// notion-new-chat.cjs — Click "New Page" button in Notion AI to start a fresh conversation
// Uses CDP to interact with Notion browser tab
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
    if (!notionTab) {
        console.log('ERROR: No Notion tab found');
        process.exit(1);
    }
    console.log('Found Notion tab:', notionTab.url);

    const ws = new WebSocket(notionTab.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));

    let msgId = 0;
    function send(method, params) {
        return new Promise(resolve => {
            const id = ++msgId;
            const handler = msg => {
                const obj = JSON.parse(msg);
                if (obj.id === id) {
                    ws.off('message', handler);
                    resolve(obj);
                }
            };
            ws.on('message', handler);
            ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
    }

    // Click the "New Page" (compose) button
    const result = await send('Runtime.evaluate', {
        expression: `(function() {
            // Strategy 1: Find by aria-label
            let btn = document.querySelector('[aria-label="新页面"]');
            if (btn) { btn.click(); return 'clicked via aria-label 新页面'; }

            btn = document.querySelector('[aria-label="New page"]');
            if (btn) { btn.click(); return 'clicked via aria-label New page'; }

            // Strategy 2: Find SVG with compose class
            const svg = document.querySelector('svg.compose');
            if (svg) {
                const parent = svg.closest('[role="button"]');
                if (parent) { parent.click(); return 'clicked via SVG.compose parent'; }
                return 'SVG.compose found but no parent button';
            }

            // Strategy 3: Debug — list all role=button elements
            const buttons = document.querySelectorAll('[role="button"][aria-label]');
            const labels = Array.from(buttons).slice(0, 10).map(b => b.getAttribute('aria-label'));
            return 'No compose button. Available buttons: ' + JSON.stringify(labels);
        })()`,
        returnByValue: true,
    });

    console.log('New Page click result:', result.result?.result?.value);

    // Wait for new page to load
    await new Promise(r => setTimeout(r, 3000));

    // Get current URL
    const urlResult = await send('Runtime.evaluate', {
        expression: 'window.location.href',
        returnByValue: true,
    });
    console.log('Current URL:', urlResult.result?.result?.value);

    // Check if chat input exists
    const inputResult = await send('Runtime.evaluate', {
        expression: `(function() {
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            if (!input) return 'No chat input found';
            return 'Chat input found: ' + (input.textContent || '').substring(0, 50);
        })()`,
        returnByValue: true,
    });
    console.log('Chat input:', inputResult.result?.result?.value);

    ws.close();
    process.exit(0);
})();
