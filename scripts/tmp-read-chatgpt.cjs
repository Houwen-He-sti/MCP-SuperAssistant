// Read last ChatGPT assistant message
const WebSocket = require('ws');
const http = require('http');
(async () => {
    const targets = JSON.parse(await new Promise((res, rej) => {
        http.get('http://127.0.0.1:9222/json', r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej);
    }));
    const tab = targets.find(t => t.url && t.url.includes('chatgpt.com'));
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));
    let id = 0;
    function send(m, p) {
        return new Promise((res) => {
            const myId = ++id;
            const h = msg => { const o = JSON.parse(msg); if (o.id === myId) { ws.off('message', h); res(o); } };
            ws.on('message', h);
            ws.send(JSON.stringify({ id: myId, method: m, params: p || {} }));
            setTimeout(() => { ws.off('message', h); res({ error: 'timeout' }); }, 15000);
        });
    }
    const r = await send('Runtime.evaluate', {
        expression: `(function() {
            var msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
            if (msgs.length === 0) return 'no messages';
            var last = msgs[msgs.length - 1];
            return last.textContent;
        })()`,
        returnByValue: true,
    });
    console.log(r.result?.result?.value || 'NO_VALUE');
    ws.close();
})().catch(e => { console.error(e); process.exit(1); });
