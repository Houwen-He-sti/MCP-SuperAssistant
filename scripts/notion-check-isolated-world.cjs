// notion-check-isolated-world.cjs — Check adapter state in extension's isolated world
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
    // Target the AI chat tab specifically
    const notionTab = targets.find(t => t.url.includes('notion.so/ai') || t.url.includes('notion.so/chat'));
    if (!notionTab) { console.log('ERROR: No Notion AI tab'); process.exit(1); }
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

    // Enable Runtime to get execution contexts
    await send('Runtime.enable');
    
    // Collect execution contexts
    const executionContexts = [];
    const contextListener = msg => {
        const obj = JSON.parse(msg);
        if (obj.method === 'Runtime.executionContextCreated') {
            executionContexts.push(obj.params.context);
        }
    };
    ws.on('message', contextListener);
    await new Promise(r => setTimeout(r, 1000));
    ws.off('message', contextListener);

    console.log('Execution contexts:');
    executionContexts.forEach(ctx => {
        console.log(`  id=${ctx.id}, name="${ctx.name}", origin="${ctx.origin}"`);
    });

    // Find the extension's isolated world context
    const extensionCtx = executionContexts.find(ctx => 
        ctx.origin.includes('chrome-extension://hkjclekhnaffnhldgpmjnohihjmblbpj')
    );

    if (!extensionCtx) {
        console.log('Extension context NOT FOUND in execution contexts');
        console.log('Trying alternative: check all contexts for MCP globals...');
        
        // Try each context
        for (const ctx of executionContexts) {
            const check = await send('Runtime.evaluate', {
                expression: `(function() {
                    try {
                        const keys = [];
                        for (const key of Object.getOwnPropertyNames(window)) {
                            if (key.includes('pluginRegistry') || key.includes('mcpClient') || key.includes('__automation')) {
                                keys.push(key);
                            }
                        }
                        return keys.length > 0 ? JSON.stringify(keys) : 'none';
                    } catch(e) { return 'error: ' + e.message; }
                })()`,
                contextId: ctx.id,
                returnByValue: true,
            });
            const result = val(check);
            if (result && result !== 'none') {
                console.log(`  Context ${ctx.id} (${ctx.name}): ${result}`);
            }
        }
    } else {
        console.log(`Found extension context: id=${extensionCtx.id}`);
        
        // Check adapter state in extension context
        const adapterCheck = await send('Runtime.evaluate', {
            expression: `(function() {
                try {
                    const info = {};
                    if (window.pluginRegistry) {
                        const plugins = window.pluginRegistry.getRegisteredPlugins?.() || {};
                        info.plugins = Object.keys(plugins);
                        const active = window.pluginRegistry.getActiveAdapter?.();
                        info.activeAdapter = active ? { name: active.name, status: active.status } : null;
                    }
                    if (window.__automationService) {
                        info.automation = {
                            exists: true,
                            state: window.__automationService.getState?.() || 'no getState'
                        };
                    }
                    if (window.mcpClient) {
                        info.mcpClient = { exists: true };
                    }
                    return JSON.stringify(info, null, 2);
                } catch(e) { return 'error: ' + e.message; }
            })()`,
            contextId: extensionCtx.id,
            returnByValue: true,
        });
        console.log('Adapter state:', val(adapterCheck));
    }

    ws.close();
    process.exit(0);
})();
