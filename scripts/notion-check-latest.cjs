// Diagnostic helper for Phase 1B investigation. Not part of the canonical regression path.
// notion-check-latest.cjs — Check Notion AI's latest response after result injection
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

    // Get the full conversation thread — all user and assistant messages
    const thread = await send('Runtime.evaluate', {
        expression: `(function() {
            // Notion AI uses a chat thread structure
            // Look for the main content area
            const mainArea = document.querySelector('[class*="chat-thread"], [class*="conversation"], main, [role="main"]');
            
            // Get all text blocks in order
            const blocks = [];
            const textNodes = document.querySelectorAll('p, h1, h2, h3, pre, li, div[data-block-id]');
            textNodes.forEach(n => {
                const text = n.textContent.trim();
                if (text && text.length > 3 && text.length < 2000) {
                    // Avoid duplicates from nested elements
                    if (n.querySelector('p, pre, li')) return;
                    blocks.push({
                        tag: n.tagName,
                        class: (n.className || '').substring(0, 30),
                        text: text.substring(0, 300)
                    });
                }
            });
            
            // Get the last 20 blocks (most recent content)
            return JSON.stringify(blocks.slice(-20), null, 2);
        })()`,
        returnByValue: true,
    });
    console.log('Recent blocks:', val(thread));

    // Also check if Notion AI is still generating (loading state)
    const loading = await send('Runtime.evaluate', {
        expression: `(function() {
            const stopBtn = document.querySelector('[aria-label="停止"], [aria-label="Stop"]');
            const spinner = document.querySelector('[class*="loading"], [class*="spinner"], [class*="generating"]');
            const thinkingDots = document.querySelector('[class*="thinking"], [class*="dots"]');
            return JSON.stringify({
                hasStopBtn: !!stopBtn,
                hasSpinner: !!spinner,
                hasThinking: !!thinkingDots,
                isGenerating: !!(stopBtn || spinner || thinkingDots)
            });
        })()`,
        returnByValue: true,
    });
    console.log('Loading state:', val(loading));

    ws.close();
    process.exit(0);
})();
