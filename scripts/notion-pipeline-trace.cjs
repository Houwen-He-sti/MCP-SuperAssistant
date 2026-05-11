/**
 * Notion Targeted Pipeline Trace — Gate 6 OO
 * 
 * Patches the extension's functions from the correct isolated-world context
 * to trace exactly where the pipeline breaks.
 * 
 * Since we can't access module internals from CDP eval, we use a different approach:
 * We directly replicate the extension's processing logic step-by-step in the
 * extension context and check each step.
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
    console.log('🔬 Targeted Pipeline Trace — Gate 6 OO');
    console.log('='.repeat(60));
    
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
            consoleMessages.push({ ctx: msg.params.executionContextId, type: msg.params.type, text: args.substring(0, 400) });
        }
    });
    
    const contexts = [];
    ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.method === 'Runtime.executionContextCreated') contexts.push(msg.params.context);
    });
    
    await cdpSend(ws, 'Runtime.enable');
    await new Promise(r => setTimeout(r, 1000));
    
    // Find extension context on the chat page
    const extContexts = contexts.filter(c => (c.origin || '').includes('hkjclekhnaffnhldgpmjnohihjmblbpj'));
    
    let chatCtx = null;
    for (const ctx of extContexts) {
        try {
            const r = await cdpSend(ws, 'Runtime.evaluate', { contextId: ctx.id, expression: 'window.location.pathname', returnByValue: true });
            if (r.result.value === '/chat') { chatCtx = ctx; break; }
        } catch(e) {}
    }
    
    if (!chatCtx) { console.error('No extension context on /chat'); ws.close(); return; }
    console.log('Using extension context:', chatCtx.id);
    
    // Step 1: Inject test content
    console.log('\n--- Step 1: Inject test content ---');
    const injectResult = await cdpSend(ws, 'Runtime.evaluate', {
        contextId: chatCtx.id,
        expression: `(function() {
            var container = document.querySelector('.notion-selectable-container');
            if (!container) return JSON.stringify({error: 'no container'});
            var allDivs = container.querySelectorAll('div');
            var turnLane = null;
            for (var i = 0; i < allDivs.length; i++) {
                if (allDivs[i].children.length >= 8) { turnLane = allDivs[i]; break; }
            }
            if (!turnLane) return JSON.stringify({error: 'no turn lane'});
            
            var synth = document.createElement('div');
            synth.id = 'mcp-trace-test';
            synth.textContent = '<function_results>\\n<result>\\n<tool_name>read_file</tool_name>\\n<stdout>\\nTrace test\\n</stdout>\\n</result>\\n</function_results>';
            turnLane.insertBefore(synth, turnLane.children[1] || null);
            return JSON.stringify({injected: true, turnChildren: turnLane.children.length});
        })()`,
        returnByValue: true,
    });
    console.log(JSON.parse(injectResult.result.value));
    
    // Wait for observer
    await new Promise(r => setTimeout(r, 2000));
    
    // Step 2: Manually trace the pipeline step by step
    console.log('\n--- Step 2: Manual pipeline trace ---');
    const traceResult = await cdpSend(ws, 'Runtime.evaluate', {
        contextId: chatCtx.id,
        expression: `(function() {
            var trace = [];
            
            // Step A: Check isNotionHost
            var hostname = window.location.hostname;
            var isNotion = hostname === 'notion.so' || hostname.endsWith('.notion.so');
            trace.push('A. isNotionHost(' + hostname + ') = ' + isNotion);
            
            // Step B: getNotionFunctionResultCandidates equivalent
            var containers = document.querySelectorAll('.notion-selectable-container');
            trace.push('B. Containers found: ' + containers.length);
            
            if (containers.length === 0) {
                trace.push('   STOP: no containers');
                return JSON.stringify({trace: trace});
            }
            
            // Step C: findPossibleTurnLanes
            var allCandidates = [];
            for (var ci = 0; ci < containers.length; ci++) {
                var c = containers[ci];
                if (!(c instanceof HTMLElement)) { trace.push('   Container ' + ci + ' not HTMLElement'); continue; }
                
                var nodes = [c];
                var divs = c.querySelectorAll('div');
                for (var d = 0; d < divs.length; d++) nodes.push(divs[d]);
                
                trace.push('C. Checking ' + nodes.length + ' candidate nodes for turn lanes');
                
                var lanes = [];
                for (var n = 0; n < nodes.length; n++) {
                    var node = nodes[n];
                    if (!(node instanceof HTMLElement)) continue;
                    var htmlChildren = [];
                    for (var k = 0; k < node.children.length; k++) {
                        if (node.children[k] instanceof HTMLElement) htmlChildren.push(node.children[k]);
                    }
                    if (htmlChildren.length < 2) continue;
                    
                    var hasFR = htmlChildren.some(function(child) {
                        var t = child.textContent || '';
                        return t.includes('<function_results') || t.includes('<function_result ');
                    });
                    if (hasFR) {
                        lanes.push({node: node, children: htmlChildren.length});
                    }
                }
                
                trace.push('   Turn lanes found: ' + lanes.length);
                
                // Step D: Enumerate candidates
                for (var li = 0; li < lanes.length; li++) {
                    var lane = lanes[li];
                    trace.push('   Lane ' + li + ': ' + lane.children + ' children');
                    
                    for (var ti = 0; ti < lane.node.children.length; ti++) {
                        var child = lane.node.children[ti];
                        if (!(child instanceof HTMLElement)) continue;
                        var text = child.textContent || '';
                        var hasFRText = text.includes('<function_results') || text.includes('<function_result ');
                        var hasAIRoot = !!child.querySelector('[data-content-editable-root]');
                        
                        if (hasFRText) {
                            allCandidates.push(child);
                            trace.push('     [' + ti + '] FR=true, AI=' + hasAIRoot + ', SELECTED=' + (hasFRText && !hasAIRoot));
                            trace.push('     text preview: ' + text.substring(0, 60));
                        }
                    }
                }
            }
            
            trace.push('D. Total candidates: ' + allCandidates.length);
            
            if (allCandidates.length === 0) {
                trace.push('   STOP: no candidates');
                return JSON.stringify({trace: trace});
            }
            
            // Step E: Try to call containsFunctionResult on the content
            // This replicates what functionResultParser does
            for (var pi = 0; pi < allCandidates.length; pi++) {
                var el = allCandidates[pi];
                var content = el.textContent || '';
                var hasOpen = /<function_result[\\s>]/i.test(content);
                var hasClose = /<\\/function_result/i.test(content);
                trace.push('E. Candidate ' + pi + ':');
                trace.push('   content length: ' + content.length);
                trace.push('   containsFunctionResult open: ' + hasOpen);
                trace.push('   containsFunctionResult close: ' + hasClose);
                trace.push('   content[0..100]: ' + content.substring(0, 100));
                
                // Check what renderFunctionResult would do:
                // 1. Check for SYSTEM tags
                var hasSystem = content.includes('<SYSTEM>') || content.includes('</SYSTEM>') || content.includes('<system>') || content.includes('</system>');
                trace.push('   hasSystemTags: ' + hasSystem);
                
                // 2. Check containsFunctionResult from parser
                // The parser checks for /<function_result[\\s>]/ and /<\\/function_result/
                if (!hasOpen || !hasClose) {
                    trace.push('   ⚠ containsFunctionResult would return FALSE');
                    trace.push('   This means renderFunctionResult will bail out before parsing');
                }
            }
            
            // Step F: Check the test element specifically
            var testEl = document.getElementById('mcp-trace-test');
            if (testEl) {
                var tc = testEl.textContent || '';
                trace.push('');
                trace.push('F. Test element:');
                trace.push('   exists: true');
                trace.push('   textContent: ' + tc.substring(0, 200));
                trace.push('   has <function_results: ' + tc.includes('<function_results'));
                trace.push('   has </function_results>: ' + tc.includes('</function_results>'));
                trace.push('   regex open test: ' + (/<function_result[\\s>]/i.test(tc)));
                trace.push('   regex close test: ' + (/<\\/function_result/i.test(tc)));
            }
            
            return JSON.stringify({trace: trace, candidateCount: allCandidates.length});
        })()`,
        returnByValue: true,
    });
    
    const traceData = JSON.parse(traceResult.result.value);
    for (const line of traceData.trace) {
        console.log(line);
    }
    
    // Cleanup
    await cdpSend(ws, 'Runtime.evaluate', {
        contextId: chatCtx.id,
        expression: `(function() { var el = document.getElementById('mcp-trace-test'); if(el) el.remove(); })()`,
    });
    
    // Print console messages
    if (consoleMessages.length > 0) {
        console.log('\n--- Console ---');
        for (const m of consoleMessages.slice(-10)) {
            console.log(`  [${m.ctx}][${m.type}] ${m.text.substring(0, 120)}`);
        }
    }
    
    ws.close();
}

main().catch(e => console.error(e.message));
