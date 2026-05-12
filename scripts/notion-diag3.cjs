#!/usr/bin/env node
// Check WHY newer extension contexts failed to initialize
const WebSocket = require('ws');
const http = require('http');

http.get('http://127.0.0.1:9222/json', res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
        const targets = JSON.parse(d);
        const tab = targets.find(t => t.url.includes('notion.so') && t.url.includes('/chat'));
        if (!tab) { console.log('no tab'); process.exit(1); }
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
            
            // Check context 2600 (newest on www.notion.so)
            const ctx2600 = contexts.find(c => c.id === 2600);
            if (ctx2600) {
                console.log('=== Context 2600 (newest www.notion.so) ===');
                
                // Check chrome.runtime
                const r1 = await send('Runtime.evaluate', {
                    contextId: 2600,
                    expression: `JSON.stringify({
                        chromeId: chrome?.runtime?.id || 'none',
                        hasError: !!chrome?.runtime?.lastError,
                        error: chrome?.runtime?.lastError?.message || 'none'
                    })`,
                    returnByValue: true
                });
                console.log('chrome.runtime:', val(r1));
                
                // Try sending message to background
                const r2 = await send('Runtime.evaluate', {
                    contextId: 2600,
                    expression: `new Promise((resolve) => {
                        try {
                            chrome.runtime.sendMessage({command: 'ping'}, (response) => {
                                if (chrome.runtime.lastError) {
                                    resolve('error: ' + chrome.runtime.lastError.message);
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
                console.log('sendMessage test:', val(r2));
                
                // Check what globals exist — is the content script even loaded?
                const r3 = await send('Runtime.evaluate', {
                    contextId: 2600,
                    expression: `JSON.stringify({
                        windowKeys: Object.keys(window).filter(k => 
                            !k.startsWith('__') && 
                            typeof window[k] !== 'function' &&
                            !['location','document','navigator','performance','chrome','console','sessionStorage','localStorage','indexedDB','crypto','fetch','caches','cookieStore','scheduler','crossOriginIsolated','isSecureContext','origin','trustedTypes','Window','window','self','name','customElements','history','navigation','locationbar','menubar','personalbar','scrollbars','statusbar','toolbar','status','closed','frames','length','opener','parent','frameElement','external','screen','innerWidth','innerHeight','scrollX','pageXOffset','scrollY','pageYOffset','visualViewport','screenX','screenY','outerWidth','outerHeight','devicePixelRatio','clientInformation','screenLeft','screenTop','styleMedia','onsearch','oncontentvisibilityautostatechange'].includes(k)
                        ).slice(0, 30)
                    })`,
                    returnByValue: true
                });
                console.log('custom globals:', val(r3));
            }
            
            // Also check context 2586 (working one) for automation state
            console.log('\n=== Context 2586 (working, stale) ===');
            const r4 = await send('Runtime.evaluate', {
                contextId: 2586,
                expression: `JSON.stringify({
                    automationState: window.__mcpAutomationState,
                    sidebarMgr: typeof window.activeSidebarManager,
                    sidebarMgrType: window.activeSidebarManager?.constructor?.name || 'unknown',
                    mcpClientStatus: window.mcpClient?.getConnectionStatus?.() || 'unknown'
                })`,
                returnByValue: true
            });
            console.log('automation state:', val(r4));
            
            // Check if we can get tool list from the working context
            const r5 = await send('Runtime.evaluate', {
                contextId: 2586,
                expression: `(async function(){
                    try {
                        const tools = window.mcpClient?.getAvailableTools?.();
                        return JSON.stringify({
                            toolCount: tools?.length || 0,
                            toolNames: (tools || []).map(t => t.name).slice(0, 10),
                            connectionStatus: window.mcpClient?.getConnectionStatus?.() || 'unknown'
                        });
                    } catch(e) {
                        return 'error: ' + e.message;
                    }
                })()`,
                returnByValue: true,
                awaitPromise: true
            });
            console.log('tools:', val(r5));
            
            await send('Runtime.disable');
            ws.close();
        });
    });
});
