/**
 * Debug probe: Deep isolated world inspection
 * 
 * The first preflight said mcpClient=true, but frame-aware probe says mcpClient=false.
 * Need to resolve this contradiction by:
 * 1. Checking ALL isolated world contexts more carefully
 * 2. Looking at what variables ARE available in the MCP SA isolated world
 * 3. Checking for initialization errors or partial state
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
    console.log('Tab URL:', tab.url);

    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));

    let msgId = 0;
    const send = (method, params) => new Promise((resolve, reject) => {
        const myId = ++msgId;
        const timeout = setTimeout(() => reject(new Error('timeout: ' + method)), 10000);
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
    await new Promise(r => setTimeout(r, 1500));

    // Find MCP SuperAssistant isolated contexts in top frame
    const mcpContexts = contexts.filter(c => {
        return c.name === 'MCP SuperAssistant';
    });

    console.log('\n=== MCP SuperAssistant isolated contexts ===');
    console.log('Found:', mcpContexts.length);
    for (const ctx of mcpContexts) {
        console.log('  id=' + ctx.id + ', origin=' + ctx.origin + ', frameId=' + (ctx.auxData || {}).frameId);
    }

    // For each MCP SA context, do deep inspection
    for (const ctx of mcpContexts) {
        console.log('\n=== Deep inspection: context ' + ctx.id + ' (frame ' + (ctx.auxData || {}).frameId + ') ===');

        const expr = `
      (function() {
        var result = {};
        
        // Basic window state
        result.href = location.href;
        result.readyState = document.readyState;
        
        // MCP client checks (multiple possible locations)
        result.windowMcpClient = typeof window.mcpClient;
        result.windowMcpClientVal = window.mcpClient ? 'exists' : 'undefined';
        
        // Check if there's a global store/state manager
        result.hasZustandStore = typeof window.__zustand !== 'undefined';
        
        // Check chrome.runtime
        result.chromeRuntimeId = (typeof chrome !== 'undefined' && chrome.runtime) ? chrome.runtime.id : 'no chrome.runtime';
        result.chromeRuntimeError = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) ? chrome.runtime.lastError.message : 'none';
        
        // DOM elements
        result.sidebarHost = !!document.getElementById('mcp-sidebar-shadow-host');
        result.rootEl = !!document.getElementById('mcp-superassistant-root');
        result.allMcpIds = Array.from(document.querySelectorAll('[id*="mcp"]')).map(function(e) { return e.id; });
        
        // Check shadow DOM inside sidebarHost
        var host = document.getElementById('mcp-sidebar-shadow-host');
        if (host) {
          var shadow = host.shadowRoot;
          result.shadowRootExists = !!shadow;
          if (shadow) {
            result.shadowChildCount = shadow.childNodes.length;
            result.shadowInnerHTML = shadow.innerHTML.substring(0, 300);
          }
        }
        
        // Window keys that might be relevant (filter for app-related ones)
        var appKeys = Object.keys(window).filter(function(k) {
          return k.indexOf('mcp') !== -1 || 
                 k.indexOf('MCP') !== -1 || 
                 k.indexOf('Mcp') !== -1 ||
                 k.indexOf('plugin') !== -1 ||
                 k.indexOf('Plugin') !== -1 ||
                 k.indexOf('automation') !== -1 ||
                 k.indexOf('Automation') !== -1 ||
                 k.indexOf('eventBus') !== -1 ||
                 k.indexOf('bridge') !== -1 ||
                 k.indexOf('Bridge') !== -1 ||
                 k.indexOf('sidebar') !== -1 ||
                 k.indexOf('Sidebar') !== -1 ||
                 k.indexOf('_appDebug') !== -1 ||
                 k.indexOf('streamTool') !== -1 ||
                 k.indexOf('configureStream') !== -1;
        });
        result.appKeys = appKeys;
        
        // Check each app key's type
        result.appKeyTypes = {};
        for (var i = 0; i < appKeys.length; i++) {
          try {
            result.appKeyTypes[appKeys[i]] = typeof window[appKeys[i]];
          } catch(e) {
            result.appKeyTypes[appKeys[i]] = 'error: ' + e.message;
          }
        }
        
        // localStorage check
        try {
          var uiStore = localStorage.getItem('mcp-super-assistant-ui-store');
          if (uiStore) {
            var parsed = JSON.parse(uiStore);
            result.uiStoreState = {
              autoInsert: parsed.state && parsed.state.autoInsert,
              autoSubmit: parsed.state && parsed.state.autoSubmit,
              mcpEnabled: parsed.state && parsed.state.mcpEnabled,
              selectedProvider: parsed.state && parsed.state.selectedProvider,
            };
          } else {
            result.uiStoreState = 'not found';
          }
        } catch(e) {
          result.uiStoreState = 'error: ' + e.message;
        }
        
        // Check for any error indicators
        result.documentTitle = document.title;
        
        return JSON.stringify(result);
      })()
    `;

        try {
            var r = await send('Runtime.evaluate', {
                contextId: ctx.id,
                expression: expr,
                returnByValue: true,
            });
            var val = r.result && r.result.result && r.result.result.value;
            if (val) {
                console.log(JSON.stringify(JSON.parse(val), null, 2));
            } else {
                console.log('No result:', JSON.stringify(r.result, null, 2));
            }
        } catch (e) {
            console.log('Error:', e.message);
        }
    }

    // Also collect console messages from the page (past messages via Runtime.getExceptionDetails won't work,
    // but we can check if any MCP-SA related console messages are being output NOW)
    console.log('\n=== Checking for console messages (2 second window) ===');
    var consoleMsgs = [];
    var consoleHandler = function (raw) {
        var obj = JSON.parse(raw);
        if (obj.method === 'Runtime.consoleAPICalled') {
            var args = (obj.params.args || []).map(function (a) {
                return (a.value || a.description || '').toString().substring(0, 200);
            });
            var text = args.join(' ');
            if (text.indexOf('MCP') !== -1 || text.indexOf('mcp') !== -1 || text.indexOf('superassistant') !== -1) {
                consoleMsgs.push({ type: obj.params.type, text: text });
            }
        }
        if (obj.method === 'Runtime.exceptionThrown') {
            var ex = obj.params.exceptionDetails || {};
            consoleMsgs.push({
                type: 'exception',
                text: (ex.text || '') + ' ' + ((ex.exception || {}).description || '').substring(0, 200)
            });
        }
    };
    ws.on('message', consoleHandler);
    await new Promise(r => setTimeout(r, 2000));
    ws.off('message', consoleHandler);

    if (consoleMsgs.length > 0) {
        console.log('Found', consoleMsgs.length, 'MCP-related messages:');
        for (var m of consoleMsgs) {
            console.log('  [' + m.type + ']', m.text);
        }
    } else {
        console.log('No MCP-related console messages in 2s window');
    }

    await send('Runtime.disable');
    ws.close();
})();
