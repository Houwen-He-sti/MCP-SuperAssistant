/**
 * Quick MCP state observation in isolated world.
 * One-off diagnostic — check MCP tools, client, bridge status.
 */
const WebSocket = require('ws');
const { preflight, sleep } = require('./lib/cdp-preflight.cjs');
const { getTopFrameId, selectExtensionIsolatedContext } = require('./lib/context-selection.cjs');

(async () => {
    const pf = await preflight();
    const ws = new WebSocket(pf.tab.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));
    let msgId = 0;
    const send = (method, params) => new Promise((resolve, reject) => {
        const myId = ++msgId;
        const timeout = setTimeout(() => reject(new Error('timeout: ' + method)), 10000);
        const handler = raw => { const obj = JSON.parse(raw); if (obj.id === myId) { clearTimeout(timeout); ws.off('message', handler); resolve(obj); } };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
    });
    const evalIn = async (contextId, expression) => {
        const r = await send('Runtime.evaluate', { contextId, expression, returnByValue: true });
        return r.result?.result?.value;
    };

    const contexts = [];
    ws.on('message', raw => { const obj = JSON.parse(raw); if (obj.method === 'Runtime.executionContextCreated') contexts.push(obj.params.context); });
    await send('Runtime.enable');
    await send('Page.enable');
    let topFrameId = null;
    try { const ft = await send('Page.getFrameTree'); topFrameId = getTopFrameId(ft); } catch { }
    await sleep(1000);

    const extCtx = selectExtensionIsolatedContext(contexts, pf.extensionId, topFrameId);
    if (!extCtx) { console.log('No isolated context found'); ws.close(); return; }
    console.log('Isolated context:', extCtx.id, 'frameId:', extCtx.auxData?.frameId);

    // Deep MCP state inspection
    const expr = `(function() {
    try {
      var tools = window.__mcpToolNames;
      var availTools = window.__mcpAvailableTools;
      var client = window.mcpClient;
      var autoState = window.__mcpAutomationState;
      
      var clientInfo = {};
      if (client && typeof client === 'object') {
        clientInfo.type = typeof client;
        clientInfo.isReady = typeof client.isReady === 'function' ? client.isReady() : 'no method';
        clientInfo.keys = Object.keys(client).slice(0, 20);
        // Try to get connected server info
        if (typeof client.getServerNames === 'function') clientInfo.serverNames = client.getServerNames();
        if (typeof client.getConnectedServers === 'function') clientInfo.connectedServers = client.getConnectedServers();
        if (client.servers) clientInfo.servers = typeof client.servers;
        if (client._servers) clientInfo._servers = typeof client._servers;
        // Try listing tools
        if (typeof client.listTools === 'function') {
          try { clientInfo.listToolsType = typeof client.listTools; } catch(e) { clientInfo.listToolsError = e.message; }
        }
      }
      
      return JSON.stringify({
        mcpToolNames: tools || 'undefined',
        mcpAvailableTools: availTools !== undefined
          ? (Array.isArray(availTools) ? availTools.slice(0, 30) : typeof availTools)
          : 'undefined',
        mcpClientInfo: clientInfo,
        mcpAutomationState: autoState || 'undefined',
        configureStreamToolBridge: typeof window.configureStreamToolBridge,
        streamToolBridgeInfo: typeof window.getStreamToolBridgeInfo === 'function'
          ? JSON.stringify(window.getStreamToolBridgeInfo())
          : 'no getStreamToolBridgeInfo',
        mcpAdapterType: typeof window.mcpAdapter,
        pluginRegistryType: typeof window.pluginRegistry,
        windowMcpKeys: Object.keys(window).filter(function(k) { return k.toLowerCase().indexOf('mcp') !== -1; }).slice(0, 30),
        windowBridgeKeys: Object.keys(window).filter(function(k) { return k.toLowerCase().indexOf('bridge') !== -1; }).slice(0, 10),
        windowToolKeys: Object.keys(window).filter(function(k) { return k.toLowerCase().indexOf('tool') !== -1; }).slice(0, 10),
        windowStreamKeys: Object.keys(window).filter(function(k) { return k.toLowerCase().indexOf('stream') !== -1; }).slice(0, 10),
      });
    } catch(e) { return JSON.stringify({ error: e.message, stack: e.stack }); }
  })()`;

    const state = await evalIn(extCtx.id, expr);
    console.log('\n=== MCP STATE IN ISOLATED WORLD ===');
    console.log(JSON.stringify(JSON.parse(state || '{}'), null, 2));

    ws.close();
})().catch(e => { console.error(e); process.exit(1); });
