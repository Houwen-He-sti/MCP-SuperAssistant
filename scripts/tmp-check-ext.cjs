// Quick CDP check: extension store state on Notion tab
const http = require('http');
const WebSocket = require('ws');

const STORE_KEY = 'mcp-super-assistant-ui-store';

(async () => {
    // 1. Check proxy
    try {
        await new Promise((resolve, reject) => {
            const req = http.get('http://127.0.0.1:3006/sse', res => {
                console.log(`Proxy SSE: ${res.statusCode}`);
                res.destroy();
                resolve();
            });
            req.on('error', e => { console.log(`Proxy: ${e.message}`); resolve(); });
            req.setTimeout(3000, () => { req.destroy(); console.log('Proxy: timeout'); resolve(); });
        });
    } catch { }

    // 2. Get Notion tab
    const targets = await new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:9222/json', res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
    });

    const tab = targets.find(t => /notion\.so\/(agent|ai|chat)/.test(t.url));
    if (!tab) { console.log('No Notion tab'); process.exit(1); }
    console.log(`Notion tab: ${tab.url}`);

    // 3. CDP connect
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));

    let msgId = 0;
    function send(method, params) {
        return new Promise((resolve, reject) => {
            const id = ++msgId;
            const timer = setTimeout(() => { ws.off('message', handler); reject(new Error('timeout')); }, 10000);
            function handler(msg) {
                const obj = JSON.parse(msg);
                if (obj.id === id) { clearTimeout(timer); ws.off('message', handler); resolve(obj); }
            }
            ws.on('message', handler);
            ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
    }

    await send('Runtime.enable');

    const r = await send('Runtime.evaluate', {
        expression: `(function() {
            const key = '${STORE_KEY}';
            const stored = JSON.parse(localStorage.getItem(key) || 'null');
            if (!stored || !stored.state) return JSON.stringify({ error: 'NO_STORE' });
            const s = stored.state;
            return JSON.stringify({
                connectionStatus: s.connectionStatus || 'unknown',
                mcpToolCount: (s.mcpToolNames || []).length,
                hasEcho: (s.mcpToolNames || []).includes('echo'),
                autoInsert: s.preferences ? s.preferences.autoInsert : undefined,
                autoSubmit: s.preferences ? s.preferences.autoSubmit : undefined,
                serverUrl: s.serverUrl || 'unknown',
            });
        })()`,
        returnByValue: true,
    });

    console.log('Extension state:', r.result?.result?.value);
    ws.close();
})();
