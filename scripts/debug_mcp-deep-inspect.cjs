/** Quick deep inspection of mcpClient prototype + pluginRegistry */
const WebSocket = require('ws');
const { preflight, sleep } = require('./lib/cdp-preflight.cjs');
const { getTopFrameId, selectExtensionIsolatedContext } = require('./lib/context-selection.cjs');

(async () => {
    const pf = await preflight();
    const ws = new WebSocket(pf.tab.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));
    let msgId = 0;
    const send = (m, p) => new Promise((res, rej) => {
        const id = ++msgId;
        const t = setTimeout(() => rej(new Error('timeout')), 10000);
        const h = raw => { const o = JSON.parse(raw); if (o.id === id) { clearTimeout(t); ws.off('message', h); res(o); } };
        ws.on('message', h);
        ws.send(JSON.stringify({ id, method: m, params: p || {} }));
    });
    const evalIn = async (cid, expr) => {
        const r = await send('Runtime.evaluate', { contextId: cid, expression: expr, returnByValue: true });
        return r.result?.result?.value;
    };
    const contexts = [];
    ws.on('message', raw => { const o = JSON.parse(raw); if (o.method === 'Runtime.executionContextCreated') contexts.push(o.params.context); });
    await send('Runtime.enable');
    await send('Page.enable');
    let topFrameId = null;
    try { const ft = await send('Page.getFrameTree'); topFrameId = getTopFrameId(ft); } catch { }
    await sleep(1000);
    const ctx = selectExtensionIsolatedContext(contexts, pf.extensionId, topFrameId);
    if (!ctx) { console.log('No ctx'); ws.close(); return; }

    const expr = `(function() {
    try {
      var c = window.mcpClient;
      var protoKeys = c ? Object.getOwnPropertyNames(Object.getPrototypeOf(c)) : [];
      var protoProtoKeys = [];
      if (c) {
        var p2 = Object.getPrototypeOf(Object.getPrototypeOf(c));
        if (p2 && p2 !== Object.prototype) protoProtoKeys = Object.getOwnPropertyNames(p2);
      }

      var pr = window.pluginRegistry;
      var prKeys = pr ? Object.keys(pr).slice(0, 20) : [];
      var prProtoKeys = pr ? Object.getOwnPropertyNames(Object.getPrototypeOf(pr)).slice(0, 30) : [];
      var activePlugin = pr && typeof pr.getActivePlugin === 'function' ? pr.getActivePlugin() : null;
      var apKeys = activePlugin ? Object.keys(activePlugin).slice(0, 30) : [];
      var apProtoKeys = activePlugin ? Object.getOwnPropertyNames(Object.getPrototypeOf(activePlugin)).slice(0, 30) : [];

      var availTools = window.availableTools;
      var atType = typeof availTools;
      var atLen = Array.isArray(availTools) ? availTools.length : null;
      var atSample = Array.isArray(availTools) && availTools.length > 0 ? availTools.slice(0, 5).map(function(t) { return typeof t === 'object' ? JSON.stringify(t).substring(0, 100) : String(t); }) : null;

      return JSON.stringify({
        mcpClient_ownKeys: c ? Object.keys(c) : 'null',
        mcpClient_protoKeys: protoKeys.slice(0, 30),
        mcpClient_protoProtoKeys: protoProtoKeys.slice(0, 20),
        hasCallTool: c && typeof c.callTool === 'function',
        hasIsReady: c && typeof c.isReady === 'function',
        hasListTools: c && typeof c.listTools === 'function',
        hasConnect: c && typeof c.connect === 'function',
        hasGetTools: c && typeof c.getTools === 'function',
        isInitialized: c ? c.isInitialized : undefined,

        pluginRegistry_ownKeys: prKeys,
        pluginRegistry_protoKeys: prProtoKeys,
        activePlugin: activePlugin ? {
          ownKeys: apKeys,
          protoKeys: apProtoKeys,
          name: activePlugin.name || activePlugin.id || 'unknown',
        } : null,

        availableTools_type: atType,
        availableTools_length: atLen,
        availableTools_sample: atSample,
      });
    } catch(e) { return JSON.stringify({ error: e.message, stack: e.stack }); }
  })()`;

    const r = await evalIn(ctx.id, expr);
    console.log('\\n=== DEEP MCP / PLUGIN INSPECTION ===');
    console.log(JSON.stringify(JSON.parse(r || '{}'), null, 2));
    ws.close();
})().catch(e => { console.error(e); process.exit(1); });
