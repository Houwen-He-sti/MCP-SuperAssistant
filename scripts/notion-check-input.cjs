// Check what was auto-inserted into the Notion AI input
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

    // Read full input content
    const result = await send('Runtime.evaluate', {
        expression: `(function() {
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            const text = input?.textContent || '';
            return JSON.stringify({
                fullLength: text.length,
                first500: text.substring(0, 500),
                last500: text.substring(Math.max(0, text.length - 500)),
                hasNonce: text.includes('AUTOINSERT_PHASE1A_20250714'),
                hasFunctionResult: text.includes('function_result'),
                hasEchoResponse: text.includes('Echo response'),
                hasTimestamp: text.includes('timestamp'),
                url: window.location.href
            }, null, 2);
        })()`,
        returnByValue: true,
    });
    console.log(val(result));

    ws.close();
})();
