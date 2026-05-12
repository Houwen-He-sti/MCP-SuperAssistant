// Reset preferences to safe baseline before Phase 1B test
const http = require('http');
const WebSocket = require('ws');

const STORE_KEY = 'mcp-super-assistant-ui-store';

(async () => {
    const targets = await new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:9222/json', res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
    });

    const tab = targets.find(t => /notion\.so/i.test(t.url) && t.type === 'page' && !t.url.includes('sw.js') && !t.url.includes('_assets'));
    if (!tab) { console.log('No Notion tab'); process.exit(1); }

    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));

    let msgId = 0;
    function send(method, params, timeoutMs = 15000) {
        return new Promise((resolve, reject) => {
            const id = ++msgId;
            const timer = setTimeout(() => { ws.off('message', handler); reject(new Error('timeout')); }, timeoutMs);
            function handler(msg) {
                const obj = JSON.parse(msg);
                if (obj.id === id) { clearTimeout(timer); ws.off('message', handler); resolve(obj); }
            }
            ws.on('message', handler);
            ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
    }
    function val(r) { return r.result?.result?.value; }

    await send('Runtime.enable');

    // Read current state
    const before = await send('Runtime.evaluate', {
        expression: `(function() {
            const stored = JSON.parse(localStorage.getItem('${STORE_KEY}') || '{}');
            if (!stored.state || !stored.state.preferences) return 'NO_STORE';
            const p = stored.state.preferences;
            return JSON.stringify({ autoSubmit: p.autoSubmit, autoInsert: p.autoInsert, autoExecute: p.autoExecute });
        })()`,
        returnByValue: true,
    });
    console.log('BEFORE:', val(before));

    // Reset to safe baseline
    const reset = await send('Runtime.evaluate', {
        expression: `(function() {
            const stored = JSON.parse(localStorage.getItem('${STORE_KEY}') || '{}');
            if (!stored.state || !stored.state.preferences) return 'NO_STORE';
            stored.state.preferences.autoSubmit = false;
            stored.state.preferences.autoInsert = false;
            stored.state.preferences.autoExecute = false;
            localStorage.setItem('${STORE_KEY}', JSON.stringify(stored));
            const verify = JSON.parse(localStorage.getItem('${STORE_KEY}'));
            const p = verify.state.preferences;
            return JSON.stringify({ autoSubmit: p.autoSubmit, autoInsert: p.autoInsert, autoExecute: p.autoExecute });
        })()`,
        returnByValue: true,
    });
    console.log('AFTER RESET:', val(reset));

    // Reload to hydrate
    console.log('Reloading page to hydrate...');
    await send('Page.enable');
    await send('Page.reload', {}, 30000);
    await new Promise(resolve => {
        const handler = msg => {
            try {
                const obj = JSON.parse(msg);
                if (obj.method === 'Page.loadEventFired') { ws.off('message', handler); resolve(); }
            } catch { }
        };
        ws.on('message', handler);
        setTimeout(() => { ws.off('message', handler); resolve(); }, 30000);
    });
    await new Promise(r => setTimeout(r, 5000));

    // Verify after reload
    const afterReload = await send('Runtime.evaluate', {
        expression: `(function() {
            const stored = JSON.parse(localStorage.getItem('${STORE_KEY}') || '{}');
            if (!stored.state || !stored.state.preferences) return 'NO_STORE';
            const p = stored.state.preferences;
            return JSON.stringify({ autoSubmit: p.autoSubmit, autoInsert: p.autoInsert, autoExecute: p.autoExecute, url: window.location.href });
        })()`,
        returnByValue: true,
    });
    console.log('AFTER RELOAD:', val(afterReload));

    ws.close();
    console.log('Done. Safe baseline confirmed.');
})();
