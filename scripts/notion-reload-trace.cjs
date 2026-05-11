/**
 * Extension reload + Notion trace — simplified approach
 * 
 * 1. Uses chrome.management.setEnabled to reload extension
 * 2. Navigates to notion.so/chat
 * 3. Waits for content script
 * 4. Injects test content
 * 5. Captures PIPELINE-TRACE logs
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
    console.log('=== Extension Reload + Notion Trace ===');
    
    const targets = await getTargets();
    
    // Step 1: Connect to Notion chat page
    const notion = targets.find(t => t.type === 'page' && t.url.includes('notion.so/chat'));
    if (!notion) { console.error('No Notion chat page found'); return; }
    
    const ws = new WebSocket(notion.webSocketDebuggerUrl);
    await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
    
    // Step 2: First, check what version of the extension is running
    // by looking at whether PIPELINE-TRACE logs appear in current content scripts
    const allConsole = [];
    ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.method === 'Runtime.consoleAPICalled') {
            const args = msg.params.args.map(a => a.value || a.description || '').join(' ');
            allConsole.push({ ctx: msg.params.executionContextId, type: msg.params.type, text: args.substring(0, 500) });
        }
    });
    
    await cdpSend(ws, 'Runtime.enable');
    
    // Step 3: Navigate to the page again (force full reload with cache disabled)
    await cdpSend(ws, 'Network.enable');
    await cdpSend(ws, 'Network.setCacheDisabled', { cacheDisabled: true });
    await cdpSend(ws, 'Page.enable');
    await cdpSend(ws, 'Page.reload', { ignoreCache: true });
    
    console.log('Page reloading (cache disabled)...');
    await new Promise(r => setTimeout(r, 10000));
    
    // Step 4: Check what we got during page load
    console.log('\n--- Console messages with PIPELINE-TRACE or MCP-SA ---');
    const pipelineMessages = allConsole.filter(m => 
        m.text.includes('PIPELINE-TRACE') || 
        m.text.includes('MCP-SA') ||
        m.text.includes('Function call renderer') ||
        m.text.includes('initializeFunctionResultObserver') ||
        m.text.includes('startFunctionResultMonitoring')
    );
    for (const m of pipelineMessages) {
        console.log(`  [ctx=${m.ctx}][${m.type}] ${m.text}`);
    }
    
    if (pipelineMessages.length === 0) {
        console.log('  (NONE — instrumented code NOT running)');
        console.log('  Checking if OLD extension is loaded...');
        
        // Check all error messages
        const errorMsgs = allConsole.filter(m => m.type === 'error');
        console.log(`  Total error messages: ${errorMsgs.length}`);
        for (const m of errorMsgs.slice(0, 5)) {
            console.log(`    [ctx=${m.ctx}] ${m.text.substring(0, 200)}`);
        }
    }
    
    // Step 5: Check if extension context exists and try injection
    const contexts = [];
    ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.method === 'Runtime.executionContextCreated') contexts.push(msg.params.context);
    });
    await cdpSend(ws, 'Runtime.disable');
    await cdpSend(ws, 'Runtime.enable');
    await new Promise(r => setTimeout(r, 1000));
    
    const extContexts = contexts.filter(c => (c.origin || '').includes('hkjclekhnaffnhldgpmjnohihjmblbpj'));
    console.log(`\n--- Extension contexts found: ${extContexts.length} ---`);
    
    for (const ctx of extContexts) {
        try {
            const r = await cdpSend(ws, 'Runtime.evaluate', { 
                contextId: ctx.id, 
                expression: `JSON.stringify({path: window.location.pathname, href: window.location.href.substring(0, 80)})`, 
                returnByValue: true 
            });
            console.log(`  ctx=${ctx.id}: ${r.result.value}`);
        } catch (e) {
            console.log(`  ctx=${ctx.id}: error - ${e.message.substring(0, 80)}`);
        }
    }
    
    // Find the /chat context and inject
    let chatCtx = null;
    for (const ctx of extContexts) {
        try {
            const r = await cdpSend(ws, 'Runtime.evaluate', { contextId: ctx.id, expression: 'window.location.pathname', returnByValue: true });
            if (r.result.value === '/chat') { chatCtx = ctx; break; }
        } catch(e) {}
    }
    
    if (chatCtx) {
        console.log(`\nInjecting from extension context ${chatCtx.id}...`);
        
        const clearPrev = allConsole.length;
        
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
                synth.id = 'mcp-e2e-trace2';
                synth.textContent = '<function_results>\\n<result>\\n<tool_name>read_file</tool_name>\\n<stdout>\\nE2E trace test v2\\n</stdout>\\n</result>\\n</function_results>';
                turnLane.insertBefore(synth, turnLane.children[1] || null);
                return JSON.stringify({injected: true, children: turnLane.children.length});
            })()`,
            returnByValue: true,
        });
        console.log('Inject result:', JSON.parse(injectResult.result.value));
        
        // Wait for observer
        await new Promise(r => setTimeout(r, 3000));
        
        // Check for trace messages
        console.log('\n--- Post-injection PIPELINE-TRACE messages ---');
        const postInject = allConsole.slice(clearPrev).filter(m => m.text.includes('PIPELINE-TRACE'));
        for (const m of postInject) {
            console.log(`  [ctx=${m.ctx}][${m.type}] ${m.text.substring(0, 300)}`);
        }
        if (postInject.length === 0) {
            console.log('  (NONE)');
        }
        
        // Check rendering result
        const check = await cdpSend(ws, 'Runtime.evaluate', {
            contextId: chatCtx.id,
            expression: `JSON.stringify({ cards: document.querySelectorAll('.function-result-container').length, testEl: !!document.getElementById('mcp-e2e-trace2') })`,
            returnByValue: true,
        });
        console.log('Rendering check:', JSON.parse(check.result.value));
        
        // Cleanup
        await cdpSend(ws, 'Runtime.evaluate', {
            contextId: chatCtx.id,
            expression: `(function(){var e=document.getElementById('mcp-e2e-trace2');if(e)e.remove()})()`,
        });
    }
    
    await cdpSend(ws, 'Network.setCacheDisabled', { cacheDisabled: false });
    ws.close();
}

main().catch(e => console.error(e.message));
