// notion-check-adapter-state.cjs — Check if Notion adapter is active and ready via localStorage
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
    console.log('Tab:', notionTab.url);

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

    // Check for exposed __MCP_AUTOMATION_STATE__ on window
    const automationState = await send('Runtime.evaluate', {
        expression: `JSON.stringify(window.__MCP_AUTOMATION_STATE__ || 'NOT SET')`,
        returnByValue: true,
    });
    console.log('Automation state:', val(automationState));

    // Check for adapter info via window globals
    const globals = await send('Runtime.evaluate', {
        expression: `(function() {
            const info = {};
            // Check pluginRegistry
            if (window.pluginRegistry) {
                info.pluginRegistry = {
                    exists: true,
                    plugins: typeof window.pluginRegistry.getRegisteredPlugins === 'function' 
                        ? Object.keys(window.pluginRegistry.getRegisteredPlugins() || {})
                        : 'no getRegisteredPlugins method',
                    activeAdapter: typeof window.pluginRegistry.getActiveAdapter === 'function'
                        ? (window.pluginRegistry.getActiveAdapter()?.name || 'none')
                        : 'no getActiveAdapter method'
                };
            } else {
                info.pluginRegistry = 'NOT FOUND on window';
            }
            
            // Check for any adapter-related globals
            const adapterKeys = [];
            for (const key of Object.getOwnPropertyNames(window)) {
                if (key.toLowerCase().includes('adapter') || key.toLowerCase().includes('plugin') || key.toLowerCase().includes('notion')) {
                    adapterKeys.push(key);
                }
            }
            info.adapterGlobals = adapterKeys;
            
            // Check extension console logs (if exposed)
            if (window.__MCP_DEBUG__) info.debug = window.__MCP_DEBUG__;
            
            return JSON.stringify(info, null, 2);
        })()`,
        returnByValue: true,
    });
    console.log('Adapter check:', val(globals));

    // Check console messages for AutomationService logs
    // Enable Runtime if not already
    await send('Runtime.enable');
    
    // Check for any exposed content script globals  
    const contentScript = await send('Runtime.evaluate', {
        expression: `(function() {
            const keys = [];
            for (const key of Object.getOwnPropertyNames(window)) {
                if (key.startsWith('__MCP') || key.startsWith('__mcp') || key.startsWith('__automation')) {
                    keys.push(key + ': ' + typeof window[key]);
                }
            }
            return JSON.stringify(keys);
        })()`,
        returnByValue: true,
    });
    console.log('MCP globals:', val(contentScript));

    ws.close();
    process.exit(0);
})();
