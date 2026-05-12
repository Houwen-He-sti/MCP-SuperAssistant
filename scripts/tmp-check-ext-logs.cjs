// tmp-check-ext-logs.cjs — Check extension console logs and autoSubmit state
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
    await new Promise(r => ws.on('open', r));
    let id = 0;
    function send(method, params) {
        return new Promise((resolve) => {
            const mid = ++id;
            const timer = setTimeout(() => resolve({ error: 'timeout' }), 10000);
            ws.on('message', function h(m) {
                const o = JSON.parse(m);
                if (o.id === mid) { clearTimeout(timer); ws.off('message', h); resolve(o); }
            });
            ws.send(JSON.stringify({ id: mid, method, params }));
        });
    }
    function val(r) { return r.result?.result?.value; }

    // Enable Runtime to find isolated world — set up listener BEFORE enable
    const contexts = [];
    ws.on('message', d => {
        const msg = JSON.parse(d);
        if (msg.method === 'Runtime.executionContextCreated') {
            contexts.push(msg.params.context);
        }
    });
    await send('Runtime.enable');
    await new Promise(r => setTimeout(r, 2000));

    // Find extension isolated world
    const extCtx = contexts.find(c =>
        c.origin?.includes('chrome-extension://') ||
        c.name?.includes('MCP') ||
        c.name?.includes('SuperAssistant')
    );
    if (!extCtx) {
        console.log('No extension context found');
        console.log('Contexts:', contexts.map(c => ({ id: c.id, name: c.name, origin: c.origin?.substring(0, 50) })));
        ws.close();
        return;
    }
    console.log('Extension context:', extCtx.id, extCtx.name);

    // Check extension state - pluginRegistry, recent tool call processing
    const stateCheck = val(await send('Runtime.evaluate', {
        expression: `(function() {
      var info = {};
      // Check if pluginRegistry exists
      info.hasPluginRegistry = !!window.pluginRegistry;
      // Check autoSubmit/autoInsert settings
      if (window.pluginRegistry) {
        var plugins = window.pluginRegistry;
        info.registryKeys = Object.keys(plugins).slice(0, 10);
      }
      // Check if there's a zustand store in the extension context
      var storeKey = 'mcp-super-assistant-ui-store';
      var stored = localStorage.getItem(storeKey);
      if (stored) {
        var parsed = JSON.parse(stored);
        info.autoInsert = parsed.state?.preferences?.autoInsert;
        info.autoSubmit = parsed.state?.preferences?.autoSubmit;
      }
      // Check for any global state about recent tool processing
      info.windowKeys = Object.keys(window).filter(k => 
        k.toLowerCase().includes('mcp') || 
        k.toLowerCase().includes('tool') ||
        k.toLowerCase().includes('submit') ||
        k.toLowerCase().includes('plugin') ||
        k.toLowerCase().includes('bridge')
      );
      return JSON.stringify(info);
    })()`,
        contextId: extCtx.id,
        returnByValue: true,
    }));
    console.log('\nExtension state:', stateCheck);

    // Check the main world for Notion's internal state
    // Look for any error messages or failed submission indicators
    const mainCheck = val(await send('Runtime.evaluate', {
        expression: `(function() {
      // Check if there's a visible error message
      var errors = document.querySelectorAll('[class*="error"], [class*="Error"], [role="alert"]');
      var errorTexts = [];
      for (var i = 0; i < errors.length; i++) {
        var t = errors[i].textContent?.trim();
        if (t) errorTexts.push(t.substring(0, 100));
      }
      // Check the input area state
      var input = document.querySelector('[contenteditable="true"]');
      var inputInfo = null;
      if (input) {
        inputInfo = {
          text: input.textContent?.substring(0, 100),
          len: input.textContent?.length || 0,
          html: input.innerHTML?.substring(0, 200),
        };
      }
      // Check send button
      var sendBtns = document.querySelectorAll('[data-testid*="send"], [aria-label*="send"], [aria-label*="发送"], [aria-label*="提交"]');
      var btnInfo = [];
      for (var j = 0; j < sendBtns.length; j++) {
        btnInfo.push({
          label: sendBtns[j].getAttribute('aria-label'),
          testid: sendBtns[j].getAttribute('data-testid'),
          disabled: sendBtns[j].disabled || sendBtns[j].getAttribute('aria-disabled'),
        });
      }
      // Check if there's any pending/loading state
      var loading = document.querySelectorAll('[class*="loading"], [class*="Loading"], [class*="spinner"], [class*="Spinner"]');
      
      return JSON.stringify({
        errors: errorTexts,
        input: inputInfo,
        sendBtns: btnInfo,
        loadingElements: loading.length,
      });
    })()`,
        returnByValue: true,
    }));
    console.log('\nMain world state:', mainCheck);

    ws.close();
})();
