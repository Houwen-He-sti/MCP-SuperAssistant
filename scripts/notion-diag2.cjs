#!/usr/bin/env node
// Check the WORKING extension context (2586) in detail
const WebSocket = require('ws');
const http = require('http');

http.get('http://127.0.0.1:9222/json', res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
        const targets = JSON.parse(d);
        const tab = targets.find(t => t.url.includes('notion.so') && t.url.includes('/chat'));
        if (!tab) { console.log('no notion chat tab'); process.exit(1); }
        const ws = new WebSocket(tab.webSocketDebuggerUrl);
        let id = 0;
        const contexts = [];
        const send = (method, params) => new Promise(resolve => {
            const myId = ++id;
            const handler = msg => {
                const obj = JSON.parse(msg);
                if (obj.id === myId) { ws.off('message', handler); resolve(obj); }
            };
            ws.on('message', handler);
            ws.send(JSON.stringify({id: myId, method, params: params || {}}));
        });
        const val = r => r.result?.result?.value;
        
        ws.on('message', raw => {
            const obj = JSON.parse(raw);
            if (obj.method === 'Runtime.executionContextCreated') {
                contexts.push(obj.params.context);
            }
        });
        
        ws.on('open', async () => {
            await send('Runtime.enable');
            await new Promise(r => setTimeout(r, 500));
            
            // Find ALL MCP SuperAssistant contexts on www.notion.so
            const extContexts = contexts
                .filter(c => c.origin && c.origin.includes('hkjclekhnaffnhldgpmjnohihjmblbpj'))
                .filter(c => {
                    // Only those on the main frame (check url inside)
                    return true; // will check url inside
                });
            
            console.log(`Found ${extContexts.length} extension contexts`);
            
            for (const ctx of extContexts) {
                const r = await send('Runtime.evaluate', {
                    contextId: ctx.id,
                    expression: `JSON.stringify({
                        url: window.location.href,
                        hasMcpClient: typeof window.mcpClient !== 'undefined',
                        mcpClientReady: window.mcpClient?.isReady?.() || false,
                        mcpClientConnected: window.mcpClient?.connected || false,
                        hasPluginRegistry: typeof window.pluginRegistry !== 'undefined',
                        hasAppInit: typeof window.appInitUtils !== 'undefined'
                    })`,
                    returnByValue: true
                });
                const state = val(r);
                const parsed = JSON.parse(state || '{}');
                
                console.log(`\n--- Context ${ctx.id} (${parsed.url?.substring(0, 50) || '?'}) ---`);
                console.log(`  mcpClient: ${parsed.hasMcpClient}, ready: ${parsed.mcpClientReady}, connected: ${parsed.mcpClientConnected}`);
                console.log(`  pluginRegistry: ${parsed.hasPluginRegistry}, appInit: ${parsed.hasAppInit}`);
                
                // If this context has mcpClient, dig deeper
                if (parsed.hasMcpClient) {
                    console.log('  >>> THIS IS THE WORKING CONTEXT <<<');
                    
                    // Check mcpClient details
                    const r2 = await send('Runtime.evaluate', {
                        contextId: ctx.id,
                        expression: `(function(){
                            const mc = window.mcpClient;
                            return JSON.stringify({
                                type: typeof mc,
                                keys: Object.getOwnPropertyNames(Object.getPrototypeOf(mc) || mc).slice(0, 20),
                                hasToolList: typeof mc.getToolList === 'function',
                                hasSseUrl: !!mc.sseUrl,
                                sseUrl: mc.sseUrl || mc._sseUrl || 'unknown'
                            });
                        })()`,
                        returnByValue: true
                    });
                    console.log('  mcpClient details:', val(r2));
                    
                    // Check if there's an automation service
                    const r3 = await send('Runtime.evaluate', {
                        contextId: ctx.id,
                        expression: `(function(){
                            // Check common patterns for automation service access
                            const keys = Object.keys(window).filter(k => 
                                k.includes('auto') || k.includes('Auto') || 
                                k.includes('sidebar') || k.includes('Sidebar') ||
                                k.includes('service') || k.includes('Service')
                            );
                            return JSON.stringify({
                                relevantKeys: keys.slice(0, 15),
                                hasPluginRegistry: typeof window.pluginRegistry !== 'undefined',
                                pluginRegistryKeys: window.pluginRegistry ? Object.getOwnPropertyNames(Object.getPrototypeOf(window.pluginRegistry) || window.pluginRegistry).slice(0, 15) : []
                            });
                        })()`,
                        returnByValue: true
                    });
                    console.log('  services:', val(r3));
                    
                    // Check UI store state
                    const r4 = await send('Runtime.evaluate', {
                        contextId: ctx.id,
                        expression: `(function(){
                            try {
                                const raw = localStorage.getItem('mcp-super-assistant-ui-store');
                                if (!raw) return 'no ui store';
                                const store = JSON.parse(raw);
                                return JSON.stringify({
                                    autoInsert: store?.state?.autoInsert,
                                    autoSubmit: store?.state?.autoSubmit,
                                    mcpEnabled: store?.state?.mcpEnabled,
                                    keys: Object.keys(store?.state || {}).slice(0, 15)
                                });
                            } catch(e) { return 'error: ' + e.message; }
                        })()`,
                        returnByValue: true
                    });
                    console.log('  UI store:', val(r4));
                    
                    // Check chrome.runtime connectivity
                    const r5 = await send('Runtime.evaluate', {
                        contextId: ctx.id,
                        expression: `new Promise((resolve) => {
                            try {
                                chrome.runtime.sendMessage({command: 'ping'}, (response) => {
                                    if (chrome.runtime.lastError) {
                                        resolve('runtime error: ' + chrome.runtime.lastError.message);
                                    } else {
                                        resolve('OK: ' + JSON.stringify(response));
                                    }
                                });
                                setTimeout(() => resolve('timeout'), 3000);
                            } catch(e) {
                                resolve('exception: ' + e.message);
                            }
                        })`,
                        returnByValue: true,
                        awaitPromise: true
                    });
                    console.log('  chrome.runtime:', val(r5));
                }
            }
            
            await send('Runtime.disable');
            ws.close();
        });
    });
});
