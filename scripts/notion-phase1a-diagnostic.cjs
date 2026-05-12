// notion-phase1a-diagnostic.cjs — Check what happened during the test
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
    const chatTab = targets.find(t => t.url.includes('notion.so/ai') || t.url.includes('notion.so/chat'));
    if (!chatTab) { console.log('ERROR: No tab'); process.exit(1); }

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

    // 1. Check the current page content — what did Notion AI respond with?
    const aiResponse = await send('Runtime.evaluate', {
        expression: `(function() {
            // Get all text from the chat area
            const chatArea = document.querySelector('[class*="chat-messages"], [class*="conversation"]') || document.body;
            
            // Look for code blocks specifically
            const codeBlocks = chatArea.querySelectorAll('pre, code, [class*="code"]');
            const blocks = [];
            codeBlocks.forEach(b => {
                const text = b.textContent || '';
                if (text.length > 10) {
                    blocks.push(text.substring(0, 200));
                }
            });
            
            // Get the last few sections of text (likely AI response)
            const allText = chatArea.textContent || '';
            const lastSection = allText.substring(Math.max(0, allText.length - 2000));
            
            return JSON.stringify({
                codeBlockCount: blocks.length,
                codeBlocks: blocks.slice(0, 5),
                lastPageText: lastSection.substring(0, 1000),
                hasJsonl: allText.includes('function_call_start'),
                hasEcho: allText.includes('echo'),
                hasNonce: allText.includes('AUTOINSERT_PHASE1A_20250714'),
                url: window.location.href
            }, null, 2);
        })()`,
        returnByValue: true,
    });
    console.log('AI Response diagnostic:', val(aiResponse));

    // 2. Check the sidebar/extension panel state
    const sidebarState = await send('Runtime.evaluate', {
        expression: `(function() {
            // Look for MCP Super Assistant sidebar elements
            const sidebar = document.querySelector('#mcp-sidebar, [class*="mcp-sidebar"], [id*="super-assistant"]');
            const cards = document.querySelectorAll('[class*="tool-loop"], [class*="tool-card"], [class*="mcp-"]');
            const insertBtns = document.querySelectorAll('[class*="insert-result"], button[title*="Insert"]');
            
            const cardInfo = [];
            cards.forEach(c => {
                cardInfo.push({
                    class: (c.className || '').substring(0, 40),
                    text: (c.textContent || '').substring(0, 100)
                });
            });
            
            return JSON.stringify({
                sidebarFound: !!sidebar,
                cardCount: cards.length,
                insertBtnCount: insertBtns.length,
                cards: cardInfo.slice(0, 6)
            }, null, 2);
        })()`,
        returnByValue: true,
    });
    console.log('Sidebar state:', val(sidebarState));

    // 3. Check if Notion AI is still responding (streaming)
    const streamState = await send('Runtime.evaluate', {
        expression: `(function() {
            // Look for streaming indicator
            const stopBtn = document.querySelector('[aria-label="停止"], [aria-label="Stop"], [data-testid*="stop"]');
            const loading = document.querySelector('[class*="loading"], [class*="streaming"], [class*="thinking"]');
            return JSON.stringify({
                hasStopButton: !!stopBtn,
                hasLoading: !!loading,
                stopBtnText: stopBtn?.textContent?.substring(0, 20) || 'none'
            });
        })()`,
        returnByValue: true,
    });
    console.log('Stream state:', val(streamState));

    ws.close();
    process.exit(0);
})();
