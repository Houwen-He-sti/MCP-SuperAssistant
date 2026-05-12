// Check extension's MCP connection status via ISOLATED world (like gate5c)
const http = require('http');
const WebSocket = require('ws');

(async () => {
    const targets = JSON.parse(await new Promise(r => {
        http.get('http://127.0.0.1:9222/json', res => {
            let d = ''; res.on('data', c => d += c); res.on('end', () => r(d));
        });
    }));
    const tab = targets.find(t => /notion\.so\//.test(t.url) && !/sw\.js|_assets/.test(t.url));
    if (!tab) { console.log('No Notion tab'); process.exit(1); }
    console.log('Tab:', tab.url);

    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    const contexts = [];
    const listeners = new Map();
    let msgId = 0;

    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.id && listeners.has(msg.id)) {
            listeners.get(msg.id)(msg);
            listeners.delete(msg.id);
        }
        if (msg.method === 'Runtime.executionContextCreated') {
            contexts.push(msg.params.context);
        }
    });

    await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });

    function send(method, params = {}) {
        return new Promise(resolve => {
            const id = ++msgId;
            listeners.set(id, resolve);
            ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
                if (listeners.has(id)) { listeners.delete(id); resolve({ error: 'timeout' }); }
            }, 10000);
        });
    }

    await send('Runtime.enable');
    await new Promise(r => setTimeout(r, 1500));

    console.log('\n=== EXECUTION CONTEXTS ===');
    for (const ctx of contexts) {
        console.log(`  [${ctx.id}] name="${ctx.name}" origin="${ctx.origin}" auxData=${JSON.stringify(ctx.auxData)}`);
    }

    // Find ISOLATED world
    let isoCtx = null;
    for (const ctx of contexts) {
        if (ctx.name === 'MCP SuperAssistant') {
            const check = await send('Runtime.evaluate', {
                contextId: ctx.id,
                expression: "typeof window.pluginRegistry !== 'undefined'",
                returnByValue: true,
            });
            if (check.result?.result?.value === true) { isoCtx = ctx.id; break; }
        }
    }

    if (!isoCtx) {
        console.log('\n❌ No ISOLATED world found for MCP SuperAssistant');
        ws.close();
        process.exit(1);
    }
    console.log('\n✅ ISOLATED world:', isoCtx);

    async function evalIso(expression, opts = {}) {
        const params = { expression, returnByValue: true, contextId: isoCtx, ...opts };
        const result = await send('Runtime.evaluate', params);
        return result.result?.result;
    }

    // Check mcpClient
    const surface = await evalIso(`(function() {
        var mc = window.mcpClient;
        if (!mc) return { hasMcpClient: false };
        return {
            hasMcpClient: true,
            isReady: typeof mc.isReady === 'function' ? mc.isReady() : 'N/A',
            hasCallTool: typeof mc.callTool === 'function',
            hasGetAvailableTools: typeof mc.getAvailableTools === 'function',
        };
    })()`);
    console.log('\n=== mcpClient ===');
    console.log(JSON.stringify(surface?.value, null, 2));

    // Check connection store
    const conn = await evalIso(`(function() {
        try {
            var stores = window.__zustandStores || {};
            var keys = Object.keys(stores);
            // Try useConnectionStore
            if (typeof window.useConnectionStore === 'function') {
                var s = window.useConnectionStore.getState();
                return { source: 'useConnectionStore', status: s.status, uri: s.serverConfig?.uri, error: s.error };
            }
            // Try finding it in zustand stores
            return { source: 'none', storeKeys: keys };
        } catch(e) { return { error: e.message }; }
    })()`);
    console.log('\n=== Connection Store ===');
    console.log(JSON.stringify(conn?.value, null, 2));

    // Check tool store
    const tools = await evalIso(`(async function() {
        try {
            var mc = window.mcpClient;
            if (!mc) return { error: 'no mcpClient' };
            if (typeof mc.getAvailableTools === 'function') {
                var t = await mc.getAvailableTools();
                return { method: 'getAvailableTools', count: Array.isArray(t) ? t.length : 'not array', sample: Array.isArray(t) ? t.slice(0, 5).map(function(x) { return typeof x === 'string' ? x : x.name || JSON.stringify(x).substring(0,50); }) : null };
            }
            if (typeof mc.listTools === 'function') {
                var t2 = await mc.listTools();
                return { method: 'listTools', count: Array.isArray(t2) ? t2.length : 'not array' };
            }
            return { error: 'no tool listing method' };
        } catch(e) { return { error: e.message }; }
    })()`, { awaitPromise: true });
    console.log('\n=== Tools ===');
    console.log(JSON.stringify(tools?.value, null, 2));

    // Try echo probe
    const echo = await evalIso(`(async function() {
        try {
            var mc = window.mcpClient;
            if (!mc || typeof mc.callTool !== 'function') return { error: 'no callTool' };
            var r = await mc.callTool('echo', { message: 'diagnostic_probe' });
            return { ok: true, result: JSON.stringify(r).substring(0, 200) };
        } catch(e) { return { error: e.message }; }
    })()`, { awaitPromise: true });
    console.log('\n=== Echo Probe ===');
    console.log(JSON.stringify(echo?.value, null, 2));

    ws.close();
    console.log('\nDone.');
})().catch(e => console.error(e));
