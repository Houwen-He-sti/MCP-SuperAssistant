// OO: Get page body text to see AI response
const WebSocket = require('ws');
const http = require('http');

http.get('http://127.0.0.1:9222/json', res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
        const targets = JSON.parse(d);
        const tab = targets.find(t => t.url.includes('notion.so/chat'));
        if (!tab) { console.log('no tab'); process.exit(1); }
        const ws = new WebSocket(tab.webSocketDebuggerUrl);
        ws.on('open', () => {
            ws.send(JSON.stringify({id:1, method:'Runtime.evaluate', params:{
                expression: `(function(){
                    const body = document.body.innerText;
                    const totalLen = body.length;
                    return JSON.stringify({
                        totalLen,
                        hasJsonl: body.includes('function_call_start'),
                        hasNonce: body.includes('AUTOINSERT_PHASE1A_20250714'),
                        hasEchoError: body.includes('Field required'),
                        hasFunctionResult: body.includes('function_result'),
                        last2000: body.substring(Math.max(0, totalLen - 2000))
                    }, null, 2);
                })()`,
                returnByValue: true
            }}));
            ws.on('message', msg => {
                const r = JSON.parse(msg);
                if (r.id === 1) { console.log(r.result?.result?.value); ws.close(); }
            });
        });
    });
});
