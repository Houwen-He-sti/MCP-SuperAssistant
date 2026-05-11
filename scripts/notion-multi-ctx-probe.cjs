/**
 * Probe all extension execution contexts to find which ones are active
 * on the Notion chat page.
 */
const http = require('http');
const WebSocket = require('ws');

function getTargets() {
    return new Promise((resolve, reject) => {
        const http2 = require('http');
        http2.get('http://127.0.0.1:9222/json', res => {
            let d = '';
            res.on('data', c => (d += c));
            res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
    });
}

let _counter = 0;
function cdpSend(ws, method, params = {}) {
    const id = ++_counter;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000);
        const handler = (raw) => {
            const msg = JSON.parse(raw);
            if (msg.id === id) {
                ws.removeListener('message', handler);
                clearTimeout(timer);
                if (msg.error) reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`));
                else resolve(msg.result);
            }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
    });
}

async function main() {
    console.log('🔍 Multi-Context Extension Probe');
    
    const targets = await getTargets();
    const notion = targets.find(t => t.type === 'page' && t.url.includes('notion.so/chat'));
    if (!notion) { console.error('No chat page'); return; }
    console.log('Target:', notion.url.substring(0, 80));
    
    const ws = new WebSocket(notion.webSocketDebuggerUrl);
    await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
    
    const contexts = [];
    const contextHandler = (raw) => {
        const msg = JSON.parse(raw);
        if (msg.method === 'Runtime.executionContextCreated') {
            contexts.push(msg.params.context);
        }
    };
    ws.on('message', contextHandler);
    await cdpSend(ws, 'Runtime.enable');
    await new Promise(r => setTimeout(r, 1000));
    ws.removeListener('message', contextHandler);
    
    // Find all MCP SuperAssistant contexts
    const extContexts = contexts.filter(c => 
        (c.origin || '').includes('hkjclekhnaffnhldgpmjnohihjmblbpj')
    );
    
    console.log(`\nFound ${extContexts.length} MCP SuperAssistant contexts:`);
    
    for (const ctx of extContexts) {
        console.log(`\n--- Context ID=${ctx.id} ---`);
        try {
            const result = await cdpSend(ws, 'Runtime.evaluate', {
                contextId: ctx.id,
                expression: `(function() {
                    return JSON.stringify({
                        url: window.location.href.substring(0, 80),
                        hostname: window.location.hostname,
                        pathname: window.location.pathname.substring(0, 40),
                        containers: document.querySelectorAll('.notion-selectable-container').length,
                        aiRoots: document.querySelectorAll('[data-content-editable-root]').length,
                        bodyLen: (document.body ? document.body.textContent.length : 0),
                    });
                })()`,
                returnByValue: true,
            });
            if (result.result && result.result.value) {
                const data = JSON.parse(result.result.value);
                console.log('  URL:', data.url);
                console.log('  Containers:', data.containers, '| AI roots:', data.aiRoots);
                console.log('  Body text length:', data.bodyLen);
                
                if (data.containers > 0) {
                    console.log('  ✅ THIS IS THE CHAT PAGE CONTEXT');
                    
                    // Now check observer state
                    const obsResult = await cdpSend(ws, 'Runtime.evaluate', {
                        contextId: ctx.id,
                        expression: `(function() {
                            // Try to access module-level variables through the window
                            // Content scripts bundle into IIFE, so we can't access modules directly
                            // But we can check side effects
                            
                            // Check for mutation observers on body
                            // Unfortunately we can't list active MutationObservers from JS
                            
                            // Instead, inject test content and add a temporary observer
                            var container = document.querySelector('.notion-selectable-container');
                            var allDivs = container.querySelectorAll('div');
                            var turnLane = null;
                            for (var i = 0; i < allDivs.length; i++) {
                                if (allDivs[i].children.length >= 8) { turnLane = allDivs[i]; break; }
                            }
                            if (!turnLane) return JSON.stringify({error: 'no turn lane in ext context'});
                            
                            // Inject from the extension context
                            var synth = document.createElement('div');
                            synth.id = 'mcp-ext-ctx-test';
                            synth.textContent = '<function_results>\\n<result>\\n<tool_name>test</tool_name>\\n<stdout>\\ntest output\\n</stdout>\\n</result>\\n</function_results>';
                            turnLane.insertBefore(synth, turnLane.children[1] || null);
                            
                            return JSON.stringify({
                                injected: true,
                                turnLaneChildren: turnLane.children.length,
                                synthText: synth.textContent.substring(0, 60),
                            });
                        })()`,
                        returnByValue: true,
                    });
                    
                    if (obsResult.result && obsResult.result.value) {
                        console.log('  Ext-context injection:', JSON.parse(obsResult.result.value));
                    }
                    
                    // Wait for observer
                    console.log('  Waiting 4s for observer to process...');
                    await new Promise(r => setTimeout(r, 4000));
                    
                    // Check if rendering happened
                    const renderCheck = await cdpSend(ws, 'Runtime.evaluate', {
                        contextId: ctx.id,
                        expression: `(function() {
                            var testEl = document.getElementById('mcp-ext-ctx-test');
                            var result = {
                                testExists: !!testEl,
                                testChildren: testEl ? testEl.children.length : 0,
                                testInnerHTML: testEl ? testEl.innerHTML.substring(0, 400) : null,
                                testText: testEl ? testEl.textContent.substring(0, 100) : null,
                                cards: document.querySelectorAll('.function-result-container').length,
                                batch: document.querySelectorAll('.function-result-batch-container').length,
                                blockIds: document.querySelectorAll('[data-block-id]').length,
                            };
                            
                            // Cleanup
                            if (testEl) testEl.remove();
                            
                            return JSON.stringify(result);
                        })()`,
                        returnByValue: true,
                    });
                    
                    if (renderCheck.result && renderCheck.result.value) {
                        const rd = JSON.parse(renderCheck.result.value);
                        console.log('  Render check:', JSON.stringify(rd, null, 4));
                        
                        if (rd.cards > 0 || rd.blockIds > 0) {
                            console.log('  🎉 RENDERING WORKS!');
                        } else if (rd.testChildren > 0) {
                            console.log('  ⚠️ Element modified but no cards');
                        } else {
                            console.log('  ❌ No rendering happened');
                        }
                    }
                }
            }
        } catch (err) {
            console.log('  Error:', err.message);
        }
    }
    
    ws.close();
}

main().catch(e => console.error(e.message));
