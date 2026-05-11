/**
 * Reload extension via service worker, then reload page, then trace.
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
        const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 30000);
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
    console.log('=== Extension Reload via Service Worker ===\n');
    
    const targets = await getTargets();
    
    // Step 1: Find and reload extension via service worker
    const sw = targets.find(t => 
        t.type === 'service_worker' && 
        t.url.includes('hkjclekhnaffnhldgpmjnohihjmblbpj')
    );
    
    if (sw) {
        console.log('Found service worker:', sw.url.substring(0, 80));
        const wsSW = new WebSocket(sw.webSocketDebuggerUrl);
        await new Promise((r, e) => { wsSW.on('open', r); wsSW.on('error', e); });
        await cdpSend(wsSW, 'Runtime.enable');
        
        // Call chrome.runtime.reload() from the service worker
        const reloadResult = await cdpSend(wsSW, 'Runtime.evaluate', {
            expression: `chrome.runtime.reload()`,
            returnByValue: true,
            awaitPromise: true,
        }).catch(e => ({ error: e.message }));
        
        console.log('Extension reload triggered:', reloadResult.error ? reloadResult.error : 'ok');
        wsSW.close();
    } else {
        console.log('No service worker found. Extension targets:');
        targets.filter(t => t.url.includes('hkjclek')).forEach(t => 
            console.log(`  type=${t.type} url=${t.url.substring(0, 80)}`)
        );
        
        // Try background page
        const bg = targets.find(t => t.url.includes('hkjclekhnaffnhldgpmjnohihjmblbpj'));
        if (bg) {
            console.log('Using background target:', bg.type);
            const wsBG = new WebSocket(bg.webSocketDebuggerUrl);
            await new Promise((r, e) => { wsBG.on('open', r); wsBG.on('error', e); });
            await cdpSend(wsBG, 'Runtime.enable');
            await cdpSend(wsBG, 'Runtime.evaluate', {
                expression: `chrome.runtime.reload()`,
                returnByValue: true,
            }).catch(e => console.log('Reload error:', e.message));
            wsBG.close();
        }
    }
    
    // Wait for extension to fully reload
    console.log('Waiting 5s for extension reload...');
    await new Promise(r => setTimeout(r, 5000));
    
    // Step 2: Re-fetch targets (they change after extension reload)
    const newTargets = await getTargets();
    
    // Step 3: Find Notion page
    const notion = newTargets.find(t => t.type === 'page' && t.url.includes('notion.so/chat'));
    if (!notion) { console.error('No Notion chat page'); return; }
    
    const ws = new WebSocket(notion.webSocketDebuggerUrl);
    await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
    
    // Collect console messages
    const allConsole = [];
    ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.method === 'Runtime.consoleAPICalled') {
            const args = msg.params.args.map(a => a.value || a.description || '').join(' ');
            allConsole.push({ ctx: msg.params.executionContextId, type: msg.params.type, text: args.substring(0, 500) });
        }
    });
    
    await cdpSend(ws, 'Runtime.enable');
    await cdpSend(ws, 'Page.enable');
    
    // Reload page
    await cdpSend(ws, 'Page.reload', { ignoreCache: true });
    console.log('Notion page reloading...');
    
    // Wait for page to fully load (longer this time)
    await new Promise(r => setTimeout(r, 15000));
    
    // Check PIPELINE-TRACE messages
    console.log('\n--- ALL PIPELINE-TRACE messages from page load ---');
    const pipelineMessages = allConsole.filter(m => m.text.includes('PIPELINE-TRACE'));
    for (const m of pipelineMessages) {
        console.log(`  [ctx=${m.ctx}][${m.type}] ${m.text.substring(0, 300)}`);
    }
    if (pipelineMessages.length === 0) {
        console.log('  (NONE)');
        // Show ALL error messages
        console.log('\n--- ALL error-level messages ---');
        const errors = allConsole.filter(m => m.type === 'error');
        for (const m of errors.slice(0, 10)) {
            console.log(`  [ctx=${m.ctx}] ${m.text.substring(0, 200)}`);
        }
    }
    
    // Check MCP-SA messages
    console.log('\n--- MCP-SA messages ---');
    const mcpMessages = allConsole.filter(m => m.text.includes('MCP-SA'));
    for (const m of mcpMessages) {
        console.log(`  [ctx=${m.ctx}][${m.type}] ${m.text.substring(0, 200)}`);
    }
    
    // Find extension context and check container
    const contexts = [];
    ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.method === 'Runtime.executionContextCreated') contexts.push(msg.params.context);
    });
    await cdpSend(ws, 'Runtime.disable');
    await cdpSend(ws, 'Runtime.enable');
    await new Promise(r => setTimeout(r, 1000));
    
    const extContexts = contexts.filter(c => (c.origin || '').includes('hkjclekhnaffnhldgpmjnohihjmblbpj'));
    console.log(`\n--- Extension contexts: ${extContexts.length} ---`);
    
    let chatCtx = null;
    for (const ctx of extContexts) {
        try {
            const r = await cdpSend(ws, 'Runtime.evaluate', { contextId: ctx.id, expression: 'window.location.pathname', returnByValue: true });
            console.log(`  ctx=${ctx.id}: ${r.result.value}`);
            if (r.result.value === '/chat') chatCtx = ctx;
        } catch(e) {
            console.log(`  ctx=${ctx.id}: error`);
        }
    }
    
    if (chatCtx) {
        // Check if container exists now
        const containerCheck = await cdpSend(ws, 'Runtime.evaluate', {
            contextId: chatCtx.id,
            expression: `JSON.stringify({
                containers: document.querySelectorAll('.notion-selectable-container').length,
                body: document.body ? document.body.children.length : 0,
                url: window.location.href.substring(0, 80)
            })`,
            returnByValue: true,
        });
        console.log('Container check:', JSON.parse(containerCheck.result.value));
        
        // If container exists, inject
        const check = JSON.parse(containerCheck.result.value);
        if (check.containers > 0) {
            console.log('\nInjecting test content...');
            const clearMsgs = allConsole.length;
            
            const injectResult = await cdpSend(ws, 'Runtime.evaluate', {
                contextId: chatCtx.id,
                expression: `(function() {
                    var container = document.querySelector('.notion-selectable-container');
                    var allDivs = container.querySelectorAll('div');
                    var turnLane = null;
                    for (var i = 0; i < allDivs.length; i++) {
                        if (allDivs[i].children.length >= 8) { turnLane = allDivs[i]; break; }
                    }
                    if (!turnLane) return JSON.stringify({error: 'no turn lane'});
                    var synth = document.createElement('div');
                    synth.id = 'mcp-e2e-trace3';
                    synth.textContent = '<function_results>\\n<result>\\n<tool_name>read_file</tool_name>\\n<stdout>\\nE2E trace test v3\\n</stdout>\\n</result>\\n</function_results>';
                    turnLane.insertBefore(synth, turnLane.children[1] || null);
                    return JSON.stringify({injected: true, children: turnLane.children.length});
                })()`,
                returnByValue: true,
            });
            console.log('Inject:', JSON.parse(injectResult.result.value));
            
            await new Promise(r => setTimeout(r, 3000));
            
            console.log('\n--- Post-injection PIPELINE-TRACE ---');
            const post = allConsole.slice(clearMsgs).filter(m => m.text.includes('PIPELINE-TRACE'));
            for (const m of post) {
                console.log(`  [ctx=${m.ctx}][${m.type}] ${m.text.substring(0, 300)}`);
            }
            if (post.length === 0) console.log('  (NONE)');
            
            // Cleanup
            await cdpSend(ws, 'Runtime.evaluate', {
                contextId: chatCtx.id,
                expression: `(function(){var e=document.getElementById('mcp-e2e-trace3');if(e)e.remove()})()`,
            });
        }
    }
    
    ws.close();
}

main().catch(e => console.error(e.message));
