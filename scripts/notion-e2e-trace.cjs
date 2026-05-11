/**
 * Notion E2E Trace — reload extension, inject test content, capture pipeline trace logs
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
    console.log('=== Notion E2E Trace ===');
    
    const targets = await getTargets();
    
    // Step 1: Reload extension via chrome://extensions
    const extPage = targets.find(t => t.url.includes('chrome://extensions'));
    if (extPage) {
        console.log('Reloading extension...');
        const ws1 = new WebSocket(extPage.webSocketDebuggerUrl);
        await new Promise((r, e) => { ws1.on('open', r); ws1.on('error', e); });
        await cdpSend(ws1, 'Runtime.enable');
        
        // Click the reload button for MCP SuperAssistant
        await cdpSend(ws1, 'Runtime.evaluate', {
            expression: `(async function() {
                // Find the extension manager
                const manager = document.querySelector('extensions-manager');
                if (!manager || !manager.shadowRoot) return 'no manager';
                
                // Find the extension item list
                const itemList = manager.shadowRoot.querySelector('extensions-item-list');
                if (!itemList || !itemList.shadowRoot) return 'no item list';
                
                // Find all extension items
                const items = itemList.shadowRoot.querySelectorAll('extensions-item');
                for (const item of items) {
                    if (!item.shadowRoot) continue;
                    const name = item.shadowRoot.querySelector('#name');
                    if (name && name.textContent.includes('MCP SuperAssistant')) {
                        const reloadBtn = item.shadowRoot.querySelector('#dev-reload-button');
                        if (reloadBtn) { reloadBtn.click(); return 'reloaded'; }
                        return 'no reload button';
                    }
                }
                return 'extension not found';
            })()`,
            returnByValue: true,
            awaitPromise: true,
        });
        ws1.close();
        
        // Wait for extension to reload
        await new Promise(r => setTimeout(r, 3000));
        console.log('Extension reloaded, waiting for re-init...');
    }
    
    // Step 2: Reload Notion chat page
    const notion = targets.find(t => t.type === 'page' && t.url.includes('notion.so/chat'));
    if (!notion) { console.error('No Notion chat page'); return; }
    
    const ws = new WebSocket(notion.webSocketDebuggerUrl);
    await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
    
    // Collect ALL console messages
    const consoleMessages = [];
    ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.method === 'Runtime.consoleAPICalled') {
            const args = msg.params.args.map(a => a.value || a.description || '').join(' ');
            if (args.includes('PIPELINE-TRACE') || args.includes('DIAG')) {
                consoleMessages.push({ ctx: msg.params.executionContextId, type: msg.params.type, text: args });
            }
        }
    });
    
    await cdpSend(ws, 'Runtime.enable');
    
    // Reload the Notion page to trigger fresh content script injection
    await cdpSend(ws, 'Page.enable');
    await cdpSend(ws, 'Page.reload');
    
    console.log('Notion page reloading...');
    
    // Wait for page to finish loading
    await new Promise(r => setTimeout(r, 8000));
    
    // Print trace messages from page load
    console.log('\n--- Init trace messages ---');
    for (const m of consoleMessages) {
        console.log(`  [ctx=${m.ctx}][${m.type}] ${m.text.substring(0, 300)}`);
    }
    
    // Clear for next phase
    const initMsgCount = consoleMessages.length;
    
    // Step 3: Find the extension context and inject test content
    console.log('\n--- Injecting test content ---');
    
    // We need to find the new extension contexts after reload
    const contexts = [];
    ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.method === 'Runtime.executionContextCreated') contexts.push(msg.params.context);
    });
    
    // Re-enable to get existing contexts
    await cdpSend(ws, 'Runtime.disable');
    await cdpSend(ws, 'Runtime.enable');
    await new Promise(r => setTimeout(r, 1000));
    
    // Find extension context
    let chatCtx = null;
    for (const ctx of contexts) {
        if (!(ctx.origin || '').includes('hkjclekhnaffnhldgpmjnohihjmblbpj')) continue;
        try {
            const r = await cdpSend(ws, 'Runtime.evaluate', { contextId: ctx.id, expression: 'window.location.pathname', returnByValue: true });
            if (r.result.value === '/chat') { chatCtx = ctx; break; }
        } catch(e) {}
    }
    
    if (!chatCtx) {
        console.error('No extension context found. Trying main world injection...');
        // Inject from main page context
        const injectResult = await cdpSend(ws, 'Runtime.evaluate', {
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
                synth.id = 'mcp-e2e-trace';
                synth.textContent = '<function_results>\\n<result>\\n<tool_name>read_file</tool_name>\\n<stdout>\\nE2E trace test\\n</stdout>\\n</result>\\n</function_results>';
                turnLane.insertBefore(synth, turnLane.children[1] || null);
                return JSON.stringify({injected: true, turnChildren: turnLane.children.length});
            })()`,
            returnByValue: true,
        });
        console.log('Main world inject:', JSON.parse(injectResult.result.value));
    } else {
        console.log('Extension context found:', chatCtx.id);
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
                synth.id = 'mcp-e2e-trace';
                synth.textContent = '<function_results>\\n<result>\\n<tool_name>read_file</tool_name>\\n<stdout>\\nE2E trace test\\n</stdout>\\n</result>\\n</function_results>';
                turnLane.insertBefore(synth, turnLane.children[1] || null);
                return JSON.stringify({injected: true, turnChildren: turnLane.children.length});
            })()`,
            returnByValue: true,
        });
        console.log('Injected:', JSON.parse(injectResult.result.value));
    }
    
    // Wait for observer to fire
    await new Promise(r => setTimeout(r, 3000));
    
    // Step 4: Print all trace messages
    console.log('\n--- ALL PIPELINE-TRACE messages ---');
    for (let i = initMsgCount; i < consoleMessages.length; i++) {
        const m = consoleMessages[i];
        console.log(`  [ctx=${m.ctx}][${m.type}] ${m.text.substring(0, 300)}`);
    }
    
    // Check for cards
    const checkExpr = chatCtx ? 
        { contextId: chatCtx.id, expression: `JSON.stringify({ cards: document.querySelectorAll('.function-result-container').length, testEl: !!document.getElementById('mcp-e2e-trace'), testChildren: document.getElementById('mcp-e2e-trace')?.children.length || 0 })`, returnByValue: true } :
        { expression: `JSON.stringify({ cards: document.querySelectorAll('.function-result-container').length, testEl: !!document.getElementById('mcp-e2e-trace'), testChildren: document.getElementById('mcp-e2e-trace')?.children.length || 0 })`, returnByValue: true };
    
    const check = await cdpSend(ws, 'Runtime.evaluate', checkExpr);
    console.log('\nRendering check:', JSON.parse(check.result.value));
    
    // Cleanup
    const cleanExpr = chatCtx ?
        { contextId: chatCtx.id, expression: `(function(){var e=document.getElementById('mcp-e2e-trace');if(e)e.remove()})()` } :
        { expression: `(function(){var e=document.getElementById('mcp-e2e-trace');if(e)e.remove()})()` };
    await cdpSend(ws, 'Runtime.evaluate', cleanExpr);
    
    ws.close();
}

main().catch(e => console.error(e.message));
