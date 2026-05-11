/**
 * Notion Pipeline Diagnosis — checks the exact state in the correct extension context
 */
const http = require('http');
const WebSocket = require('ws');

function getTargets() {
    return new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:9222/json', res => {
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
    console.log('🔬 Pipeline Diagnosis');
    
    const targets = await getTargets();
    const notion = targets.find(t => t.type === 'page' && t.url.includes('notion.so/chat'));
    if (!notion) { console.error('No chat page'); return; }
    
    const ws = new WebSocket(notion.webSocketDebuggerUrl);
    await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
    
    // Collect console messages
    const consoleMessages = [];
    ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.method === 'Runtime.consoleAPICalled') {
            const args = msg.params.args.map(a => a.value || a.description || '').join(' ');
            consoleMessages.push({
                type: msg.params.type,
                text: args.substring(0, 400),
                ctx: msg.params.executionContextId,
            });
        }
    });
    
    // Get contexts
    const contexts = [];
    ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.method === 'Runtime.executionContextCreated') {
            contexts.push(msg.params.context);
        }
    });
    
    await cdpSend(ws, 'Runtime.enable');
    await new Promise(r => setTimeout(r, 1000));
    
    // Find all extension contexts that are on the chat page
    const extContexts = contexts.filter(c =>
        (c.origin || '').includes('hkjclekhnaffnhldgpmjnohihjmblbpj')
    );
    
    console.log(`\nTesting ${extContexts.length} extension contexts...`);
    
    for (const ctx of extContexts) {
        // Check if this context is on the chat page
        let url;
        try {
            const urlResult = await cdpSend(ws, 'Runtime.evaluate', {
                contextId: ctx.id,
                expression: 'window.location.href',
                returnByValue: true,
            });
            url = urlResult.result.value;
        } catch(e) { continue; }
        
        if (!url.includes('/chat')) continue;
        
        console.log(`\n=== Context ${ctx.id} (${url.substring(0, 60)}) ===`);
        
        // Step A: Add temporary console.log interceptor to trace the pipeline
        // We can't access module internals directly, but we can add a MutationObserver
        // alongside the extension's to see if mutations fire
        const diagResult = await cdpSend(ws, 'Runtime.evaluate', {
            contextId: ctx.id,
            expression: `(function() {
                // Add a diagnostic MutationObserver alongside the extension's
                var diagLog = [];
                
                var diagObserver = new MutationObserver(function(mutations) {
                    for (var i = 0; i < mutations.length; i++) {
                        var m = mutations[i];
                        if (m.type === 'childList') {
                            for (var j = 0; j < m.addedNodes.length; j++) {
                                var node = m.addedNodes[j];
                                if (node.nodeType === 1) {
                                    var text = (node.textContent || '').substring(0, 60);
                                    if (text.includes('<function_result') || text.includes('</function_result')) {
                                        diagLog.push('MUTATION: added node with FR text: ' + text);
                                    }
                                }
                            }
                        }
                    }
                });
                
                if (document.body) {
                    diagObserver.observe(document.body, {
                        childList: true,
                        subtree: true,
                        characterData: true,
                    });
                }
                
                // Store for later retrieval
                window.__diagObserver = diagObserver;
                window.__diagLog = diagLog;
                
                // Check containers
                var containers = document.querySelectorAll('.notion-selectable-container');
                
                return JSON.stringify({
                    observerAttached: !!document.body,
                    containerCount: containers.length,
                });
            })()`,
            returnByValue: true,
        });
        console.log('Diag setup:', JSON.parse(diagResult.result.value));
        
        // Step B: Inject from the extension context (same world as observer)
        const injectResult = await cdpSend(ws, 'Runtime.evaluate', {
            contextId: ctx.id,
            expression: `(function() {
                console.log('[DIAG] Injecting test function_results from extension context');
                
                var container = document.querySelector('.notion-selectable-container');
                if (!container) return JSON.stringify({error: 'no container'});
                
                var allDivs = container.querySelectorAll('div');
                var turnLane = null;
                for (var i = 0; i < allDivs.length; i++) {
                    if (allDivs[i].children.length >= 8) { turnLane = allDivs[i]; break; }
                }
                if (!turnLane) return JSON.stringify({error: 'no turn lane'});
                
                // Create synthetic user turn with function_results
                var synth = document.createElement('div');
                synth.id = 'mcp-diag-test';
                synth.style.border = '2px solid red'; // Visible marker
                synth.textContent = '<function_results>\\n<result>\\n<tool_name>read_file</tool_name>\\n<stdout>\\nDiagnostic test output\\n</stdout>\\n</result>\\n</function_results>';
                
                // Insert as second child (after first user turn)
                if (turnLane.children.length >= 2) {
                    turnLane.insertBefore(synth, turnLane.children[1]);
                } else {
                    turnLane.appendChild(synth);
                }
                
                console.log('[DIAG] Injected. Turn lane now has', turnLane.children.length, 'children');
                
                return JSON.stringify({
                    injected: true,
                    childCount: turnLane.children.length,
                    synthId: synth.id,
                });
            })()`,
            returnByValue: true,
        });
        console.log('Inject:', JSON.parse(injectResult.result.value));
        
        // Step C: Wait for processing
        console.log('Waiting 5s for observer...');
        await new Promise(r => setTimeout(r, 5000));
        
        // Step D: Check results
        const checkResult = await cdpSend(ws, 'Runtime.evaluate', {
            contextId: ctx.id,
            expression: `(function() {
                var testEl = document.getElementById('mcp-diag-test');
                var diagLog = window.__diagLog || [];
                
                // Clean up diagnostic observer
                if (window.__diagObserver) {
                    window.__diagObserver.disconnect();
                    delete window.__diagObserver;
                }
                
                var result = {
                    testExists: !!testEl,
                    testChildren: testEl ? testEl.children.length : -1,
                    testInnerHTML: testEl ? testEl.innerHTML.substring(0, 400) : null,
                    diagMutations: diagLog,
                    cards: document.querySelectorAll('.function-result-container').length,
                    batch: document.querySelectorAll('.function-result-batch-container').length,
                };
                
                // Try to detect if the extension's observer is running
                // by checking for known side effects
                
                // Clean up test element
                if (testEl) testEl.remove();
                delete window.__diagLog;
                
                return JSON.stringify(result);
            })()`,
            returnByValue: true,
        });
        
        const checkData = JSON.parse(checkResult.result.value);
        console.log('Results:', JSON.stringify(checkData, null, 2));
        
        if (checkData.diagMutations.length > 0) {
            console.log('\n✅ MutationObserver DID fire for function_results content');
        } else {
            console.log('\n❌ Diagnostic MutationObserver did NOT detect function_results mutations');
        }
        
        if (checkData.cards > 0 || checkData.batch > 0) {
            console.log('✅ Cards rendered!');
        } else {
            console.log('❌ No cards rendered');
            if (checkData.testChildren > 0) {
                console.log('   Element was modified but no cards — check innerHTML above');
            }
        }
    }
    
    // Print console messages
    console.log('\n--- Console Messages ---');
    for (const msg of consoleMessages) {
        console.log(`  [ctx=${msg.ctx}][${msg.type}] ${msg.text}`);
    }
    
    ws.close();
}

main().catch(e => console.error(e.message));
