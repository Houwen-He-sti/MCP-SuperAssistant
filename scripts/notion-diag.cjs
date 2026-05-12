#!/usr/bin/env node
// Diagnostic: check extension state on Notion page (both MAIN and ISOLATED worlds)
const WebSocket = require('ws');
const http = require('http');

http.get('http://127.0.0.1:9222/json', res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
        const targets = JSON.parse(d);
        const tab = targets.find(t => t.url.includes('notion.so') && t.url.includes('/chat'));
        if (!tab) { console.log('no notion chat tab'); process.exit(1); }
        console.log('Tab:', tab.url);
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
            // Enable Runtime to discover execution contexts
            await send('Runtime.enable');
            // Give it a moment to enumerate contexts
            await new Promise(r => setTimeout(r, 500));
            
            console.log('\n=== EXECUTION CONTEXTS ===');
            for (const ctx of contexts) {
                const aux = ctx.auxData || {};
                console.log(`  id=${ctx.id} name="${ctx.name}" origin="${ctx.origin}" frameId=${aux.frameId || '?'} type=${aux.type || '?'}`);
            }
            
            // Find ALL extension contexts
            const extContexts = contexts.filter(c => c.origin && c.origin.includes('hkjclekhnaffnhldgpmjnohihjmblbpj'));
            console.log(`\n=== ALL EXTENSION CONTEXTS (${extContexts.length}) ===`);
            for (const ctx of extContexts) {
                const aux = ctx.auxData || {};
                console.log(`  id=${ctx.id} frameId=${aux.frameId || '?'} type=${aux.type || '?'}`);
                
                // Check each one for mcp elements
                const r = await send('Runtime.evaluate', {
                    contextId: ctx.id,
                    expression: `JSON.stringify({
                        url: window.location.href,
                        hasMcpClient: typeof window.mcpClient !== 'undefined',
                        mcpEls: [...document.querySelectorAll('[id*="mcp"]')].map(e => e.id).slice(0, 5),
                        bodyLen: document.body?.children?.length || 0
                    })`,
                    returnByValue: true
                });
                console.log(`    state:`, val(r));
            }
            
            if (extCtx) {
                // Evaluate in extension's isolated world
                const r1 = await send('Runtime.evaluate', {
                    contextId: extCtx.id,
                    expression: `JSON.stringify({
                        hasMcpClient: typeof window.mcpClient !== 'undefined',
                        mcpClientReady: window.mcpClient?.isReady?.() || false,
                        hasPluginRegistry: typeof window.pluginRegistry !== 'undefined',
                        windowKeys: Object.keys(window).filter(k => k.toLowerCase().includes('mcp')).slice(0, 15),
                        allCustomKeys: Object.keys(window).filter(k => !k.startsWith('__') && k !== k.toUpperCase() && typeof window[k] !== 'function' && k.length > 3).filter(k => !['location','document','navigator','performance','chrome','console','sessionStorage','localStorage','indexedDB','crypto','fetch','caches','cookieStore','scheduler','crossOriginIsolated','isSecureContext','origin','trustedTypes','Window'].includes(k)).slice(0, 30)
                    })`,
                    returnByValue: true
                });
                console.log('Extension world state:', val(r1));
                
                // Check what chrome.runtime.id shows
                const r1b = await send('Runtime.evaluate', {
                    contextId: extCtx.id,
                    expression: `JSON.stringify({
                        extId: chrome?.runtime?.id || 'none',
                        chromeAvailable: typeof chrome !== 'undefined',
                        runtimeAvailable: typeof chrome?.runtime !== 'undefined'
                    })`,
                    returnByValue: true
                });
                console.log('Chrome API:', val(r1b));
                
                // Check errors via console
                const r2 = await send('Runtime.evaluate', {
                    contextId: extCtx.id,
                    expression: `(function(){
                        return JSON.stringify({
                            hasAutomation: typeof window.automationService !== 'undefined',
                            hasAppInit: typeof window.appInitUtils !== 'undefined',
                            docReady: document.readyState,
                            bodyExists: !!document.body,
                            sidebarHost: !!document.getElementById('mcp-sidebar-shadow-host'),
                            rootEl: !!document.getElementById('mcp-superassistant-root'),
                            allMcpEls: [...document.querySelectorAll('[id*="mcp"]')].map(e => e.id)
                        });
                    })()`,
                    returnByValue: true
                });
                console.log('DOM from isolated:', val(r2));
                
                // Try to access the stores from isolated world
                const r3 = await send('Runtime.evaluate', {
                    contextId: extCtx.id,
                    expression: `(function(){
                        try {
                            const uiStore = JSON.parse(localStorage.getItem('mcp-super-assistant-ui-store') || '{}');
                            return JSON.stringify({
                                uiAutoInsert: uiStore?.state?.autoInsert,
                                uiAutoSubmit: uiStore?.state?.autoSubmit,
                                uiMcpEnabled: uiStore?.state?.mcpEnabled
                            });
                        } catch(e) {
                            return 'error: ' + e.message;
                        }
                    })()`,
                    returnByValue: true
                });
                console.log('UI Store:', val(r3));
            }
            
            // Check MAIN world for stream interceptor
            const mainCtx = contexts.find(c => c.origin && c.origin.includes('notion.so') && !c.name);
            if (mainCtx) {
                const r3 = await send('Runtime.evaluate', {
                    contextId: mainCtx.id,
                    expression: `JSON.stringify({
                        hasFetchIntercepted: typeof window.__mcpOriginalFetch !== 'undefined',
                        hasStreamBridge: typeof window.__mcpStreamBridge !== 'undefined',
                        mcpMainKeys: Object.keys(window).filter(k => k.toLowerCase().includes('mcp')).slice(0, 15)
                    })`,
                    returnByValue: true
                });
                console.log('\nMAIN world stream interceptor:', val(r3));
            }
            
            // Check DOM for sidebar (accessible from any world)
            const r4 = await send('Runtime.evaluate', {
                expression: `(function(){
                    const root = document.getElementById('mcp-superassistant-root');
                    const allMcp = document.querySelectorAll('[id*="mcp"]');
                    return JSON.stringify({
                        hasRoot: !!root,
                        allMcpIds: [...allMcp].map(e => e.id).slice(0, 10),
                        bodyChildCount: document.body.children.length,
                        chatArea: !!document.querySelector('[data-testid="chat-messages"], .notion-chat, [class*="chat"]')
                    });
                })()`,
                returnByValue: true
            });
            console.log('\nDOM state:', val(r4));
            
            // Check page text around "function_call_start" (is it from our prompt or from AI?)
            const r5 = await send('Runtime.evaluate', {
                expression: `(function(){
                    const all = document.body.innerText;
                    const indices = [];
                    let pos = 0;
                    while ((pos = all.indexOf('function_call_start', pos)) !== -1) {
                        indices.push(pos);
                        pos += 20;
                    }
                    // Show context around each occurrence
                    return JSON.stringify(indices.map(i => ({
                        pos: i,
                        before30: all.substring(Math.max(0, i - 30), i),
                        after80: all.substring(i, i + 80)
                    })));
                })()`,
                returnByValue: true
            });
            console.log('\nAll FC occurrences:', val(r5));
            
            await send('Runtime.disable');
            ws.close();
        });
    });
});
