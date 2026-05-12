// Find correct localStorage key for MCP-SuperAssistant UI store
const WebSocket = require('ws');
const http = require('http');
http.get('http://127.0.0.1:9222/json', res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
        const targets = JSON.parse(d);
        const tab = targets.find(t => t.url.includes('notion.so'));
        if (!tab) { console.log('no tab'); process.exit(1); }
        const ws = new WebSocket(tab.webSocketDebuggerUrl);
        ws.on('open', () => {
            ws.send(JSON.stringify({id:1, method:'Runtime.evaluate', params:{
                expression: `(function() {
                    const keys = Object.keys(localStorage);
                    const relevant = keys.filter(k => 
                        k.includes('mcp') || k.includes('super') || 
                        k.includes('ui') || k.includes('preference') || 
                        k.includes('adapter') || k.includes('store')
                    );
                    // Also check for any key containing autoSubmit
                    const allValues = {};
                    for (const k of keys) {
                        const v = localStorage.getItem(k);
                        if (v && v.includes('autoSubmit')) {
                            allValues[k] = v.substring(0, 200);
                        }
                    }
                    return JSON.stringify({ relevant, keysWithAutoSubmit: allValues, totalKeys: keys.length }, null, 2);
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
