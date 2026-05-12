// notion-read-store.cjs — Read the full MCP Super Assistant UI store from localStorage
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

    // Read UI store
    const uiStore = await send('Runtime.evaluate', {
        expression: `(function() {
            const raw = localStorage.getItem('mcp-super-assistant-ui-store');
            if (!raw) return 'NOT FOUND';
            const parsed = JSON.parse(raw);
            // Only return preferences section (relevant for autoInsert/autoSubmit)
            return JSON.stringify({
                preferences: parsed.state?.preferences,
                version: parsed.version,
            }, null, 2);
        })()`,
        returnByValue: true,
    });
    console.log('UI Store preferences:', val(uiStore));

    // Also read app store
    const appStore = await send('Runtime.evaluate', {
        expression: `(function() {
            const raw = localStorage.getItem('mcp-super-assistant-app-store');
            if (!raw) return 'NOT FOUND';
            const parsed = JSON.parse(raw);
            return JSON.stringify({
                globalSettings: parsed.state?.globalSettings,
                version: parsed.version,
            }, null, 2);
        })()`,
        returnByValue: true,
    });
    console.log('App Store globalSettings:', val(appStore));

    // Read delay settings
    const delaySettings = await send('Runtime.evaluate', {
        expression: `localStorage.getItem('mcpDelaySettings')`,
        returnByValue: true,
    });
    console.log('Delay settings:', val(delaySettings));

    ws.close();
    process.exit(0);
})();
