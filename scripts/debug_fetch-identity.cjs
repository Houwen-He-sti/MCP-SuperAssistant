/**
 * Debug probe: what does window.fetch look like in the top frame?
 * Identify who overwrote our interceptor's fetch wrapper.
 */
const WebSocket = require('ws');
const http = require('http');

(async () => {
    const targets = await new Promise((res, rej) => {
        http.get('http://127.0.0.1:9222/json', r => {
            let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
        }).on('error', rej);
    });
    const tab = targets.find(t => t.url.includes('notion.so'));
    if (!tab) { console.log('No Notion tab'); process.exit(1); }

    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));

    let msgId = 0;
    const send = (method, params) => new Promise((resolve, reject) => {
        const myId = ++msgId;
        const timeout = setTimeout(() => reject(new Error('timeout')), 10000);
        const handler = raw => {
            const obj = JSON.parse(raw);
            if (obj.id === myId) { clearTimeout(timeout); ws.off('message', handler); resolve(obj); }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
    });

    const contexts = [];
    ws.on('message', raw => {
        const obj = JSON.parse(raw);
        if (obj.method === 'Runtime.executionContextCreated') contexts.push(obj.params.context);
    });
    await send('Runtime.enable');
    await new Promise(r => setTimeout(r, 1000));

    // Find top frame MAIN context
    const topMain = contexts.find(c => {
        var aux = c.auxData || {};
        return c.origin === 'https://www.notion.so' && aux.isDefault === true;
    });

    if (!topMain) { console.log('No top MAIN context'); ws.close(); return; }
    console.log('Using context', topMain.id, topMain.origin);

    // Expression to evaluate
    const expr = `
    (function() {
      var result = {};
      result.fetchStr = window.fetch.toString().substring(0, 500);
      result.fetchName = window.fetch.name;
      result.fetchKeys = Object.getOwnPropertyNames(window.fetch);
      
      var desc = Object.getOwnPropertyDescriptor(window.fetch, '__mcpSaWrapped');
      result.hasMcpSaWrapped = desc ? JSON.parse(JSON.stringify(desc)) : null;
      
      result.installKey = !!window['__MCP_SA_NOTION_STREAM_INTERCEPTOR_INSTALLED_V1__'];
      
      var ikDesc = Object.getOwnPropertyDescriptor(window, '__MCP_SA_NOTION_STREAM_INTERCEPTOR_INSTALLED_V1__');
      result.installKeyDescriptor = ikDesc ? JSON.parse(JSON.stringify(ikDesc)) : null;
      
      // Check console for MCP-SA logs
      result.consoleLogs = 'cannot access from CDP eval';
      
      // Check if there's a __mcpSaOriginalFetch or similar saved reference
      var mcpKeys = Object.getOwnPropertyNames(window).filter(function(k) {
        return k.indexOf('mcp') !== -1 || k.indexOf('MCP') !== -1 || k.indexOf('Mcp') !== -1;
      });
      result.mcpWindowKeys = mcpKeys;
      
      // Check fetch prototype
      result.fetchProto = Object.getPrototypeOf(window.fetch).constructor.name;
      
      return JSON.stringify(result);
    })()
  `;

    var r = await send('Runtime.evaluate', {
        contextId: topMain.id,
        expression: expr,
        returnByValue: true,
    });

    var val = r.result && r.result.result && r.result.result.value;
    if (val) {
        console.log(JSON.stringify(JSON.parse(val), null, 2));
    } else {
        console.log('No result:', JSON.stringify(r.result, null, 2));
    }

    // Also check console logs for [MCP-SA/MAIN]
    console.log('\n=== Searching for MCP-SA console logs ===');
    var logExpr = `
    (function() {
      // We can't access past console.log output from CDP eval.
      // But we can check if the install log marker exists as evidence.
      // The interceptor logs: '[MCP-SA/MAIN] Stream interceptor installed'
      // If this ran, installKey would be true. Let's verify the current fetch identity more deeply.
      
      var f = window.fetch;
      var result = {};
      result.fetchIdentity = f.toString().substring(0, 200);
      result.isAsync = f.constructor.name === 'AsyncFunction';
      result.hasApply = typeof f.apply === 'function';
      result.hasBind = typeof f.bind === 'function';
      
      // Try to see if the wrapped fetch's closure can be inspected
      // (it can't from eval, but we can check for side effects)
      result.fetchLength = f.length;
      
      return JSON.stringify(result);
    })()
  `;

    var r2 = await send('Runtime.evaluate', {
        contextId: topMain.id,
        expression: logExpr,
        returnByValue: true,
    });

    var val2 = r2.result && r2.result.result && r2.result.result.value;
    if (val2) {
        console.log(JSON.stringify(JSON.parse(val2), null, 2));
    }

    await send('Runtime.disable');
    ws.close();
})();
