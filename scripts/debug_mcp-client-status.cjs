/** Check mcpClient connection status, tools, server config */
const WebSocket = require('ws');
const { preflight, sleep } = require('./lib/cdp-preflight.cjs');
const { getTopFrameId, selectExtensionIsolatedContext } = require('./lib/context-selection.cjs');

(async () => {
    const pf = await preflight();
    const ws = new WebSocket(pf.tab.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));
    let mid = 0;
    const send = (m, p) => new Promise((res, rej) => {
        const id = ++mid;
        const t = setTimeout(() => rej(new Error('to')), 10000);
        const h = raw => { const o = JSON.parse(raw); if (o.id === id) { clearTimeout(t); ws.off('message', h); res(o); } };
        ws.on('message', h);
        ws.send(JSON.stringify({ id, method: m, params: p || {} }));
    });
    const ev = async (cid, expr) => {
        const r = await send('Runtime.evaluate', { contextId: cid, expression: expr, returnByValue: true });
        return r.result?.result?.value;
    };
    const ctxs = [];
    ws.on('message', raw => { const o = JSON.parse(raw); if (o.method === 'Runtime.executionContextCreated') ctxs.push(o.params.context); });
    await send('Runtime.enable');
    await send('Page.enable');
    let tf = null;
    try { const ft = await send('Page.getFrameTree'); tf = getTopFrameId(ft); } catch { }
    await sleep(1000);
    const ctx = selectExtensionIsolatedContext(ctxs, pf.extensionId, tf);
    if (!ctx) { console.log('No ctx'); ws.close(); return; }

    const expr = `(function() {
    try {
      var c = window.mcpClient;
      var tools = typeof c.getAvailableTools === 'function' ? c.getAvailableTools() : 'no method';
      var connStatus = typeof c.getConnectionStatus === 'function' ? c.getConnectionStatus() : 'no method';
      var curConnStatus = typeof c.getCurrentConnectionStatus === 'function' ? c.getCurrentConnectionStatus() : 'no method';
      var serverCfg = typeof c.getServerConfig === 'function' ? c.getServerConfig() : 'no method';

      return JSON.stringify({
        tools_type: typeof tools,
        tools_isArray: Array.isArray(tools),
        tools_length: Array.isArray(tools) ? tools.length : null,
        tools_sample: Array.isArray(tools) ? tools.slice(0, 3).map(function(t) {
          return typeof t === 'object' ? JSON.stringify(t).substring(0, 200) : String(t);
        }) : String(tools).substring(0, 200),
        connectionStatus: typeof connStatus === 'object' ? JSON.stringify(connStatus) : String(connStatus),
        currentConnectionStatus: typeof curConnStatus === 'object' ? JSON.stringify(curConnStatus) : String(curConnStatus),
        serverConfig: typeof serverCfg === 'object' ? JSON.stringify(serverCfg).substring(0, 500) : String(serverCfg),
        isInitialized: c.isInitialized,
        isReady_result: c.isReady(),
      });
    } catch(e) { return JSON.stringify({ error: e.message, stack: e.stack }); }
  })()`;

    const r = await ev(ctx.id, expr);
    console.log('\\n=== MCP CLIENT STATUS ===');
    console.log(JSON.stringify(JSON.parse(r || '{}'), null, 2));
    ws.close();
})().catch(e => { console.error(e); process.exit(1); });
