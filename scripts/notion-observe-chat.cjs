// OO: Observe the full Notion AI chat state post-Phase1A test
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
    const chatTab = targets.find(t => t.url.includes('notion.so/chat') || t.url.includes('notion.so/ai'));
    if (!chatTab) { console.log('No tab'); process.exit(1); }
    console.log('Tab:', chatTab.url);

    const ws = new WebSocket(chatTab.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));

    let id = 0;
    function send(method, params) {
        return new Promise(resolve => {
            const i = ++id;
            const h = msg => { const o = JSON.parse(msg); if (o.id === i) { ws.off('message', h); resolve(o); } };
            ws.on('message', h);
            ws.send(JSON.stringify({ id: i, method, params: params || {} }));
        });
    }
    function val(r) { return r.result?.result?.value; }

    // 1. Full chat messages
    const chatState = await send('Runtime.evaluate', {
        expression: `(function() {
            // Find all message bubbles in the conversation
            const allBlocks = document.querySelectorAll('[data-block-id]');
            const messages = [];
            
            // Get conversation area text blocks
            const conversationArea = document.querySelector('[class*="scroller"]') || document.querySelector('main') || document.body;
            
            // Get all text content sections
            const textNodes = conversationArea.querySelectorAll('p, pre, code, h1, h2, h3, li, span[data-content-editable-leaf]');
            const seenText = new Set();
            const texts = [];
            textNodes.forEach(n => {
                const t = n.textContent?.trim();
                if (t && t.length > 5 && !seenText.has(t)) {
                    seenText.add(t);
                    texts.push(t.substring(0, 200));
                }
            });
            
            // Check for jsonl code blocks specifically
            const codeBlocks = conversationArea.querySelectorAll('pre code, code[class*="language"]');
            const codes = [];
            codeBlocks.forEach(c => {
                const t = c.textContent?.trim();
                if (t && t.length > 10) codes.push(t.substring(0, 300));
            });
            
            // Check for MCP extension elements
            const mcpElements = conversationArea.querySelectorAll('[class*="mcp-"], [class*="tool-result"], [class*="function-result"]');
            const mcpInfo = [];
            mcpElements.forEach(e => {
                mcpInfo.push({ class: (e.className || '').substring(0, 50), text: (e.textContent || '').substring(0, 100) });
            });
            
            return JSON.stringify({
                url: window.location.href,
                textCount: texts.length,
                texts: texts.slice(-20),  // last 20 text blocks (most recent)
                codeBlockCount: codes.length,
                codeBlocks: codes,
                mcpElements: mcpInfo.slice(0, 10),
                totalBlocks: allBlocks.length
            }, null, 2);
        })()`,
        returnByValue: true,
    });
    console.log(val(chatState));

    ws.close();
})();
