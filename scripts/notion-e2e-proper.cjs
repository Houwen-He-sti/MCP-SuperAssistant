/**
 * Notion E2E Trace v2 — uses properly formatted function_results content
 * that matches what the formatter actually produces.
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

// Properly formatted function_results matching formatter output
const PROPER_FUNCTION_RESULTS = `<function_results>
  <result call_id="call_123" name="read_file" status="success">
    <content type="application/json"><![CDATA[
{"path": "README.md", "content": "Hello World"}
    ]]></content>
  </result>
</function_results>`;

async function main() {
    console.log('=== Notion E2E Trace v2 (proper format) ===\n');
    
    const targets = await getTargets();
    const notion = targets.find(t => t.type === 'page' && t.url.includes('notion.so/chat'));
    if (!notion) { console.error('No Notion chat page'); return; }
    
    const ws = new WebSocket(notion.webSocketDebuggerUrl);
    await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
    
    const allConsole = [];
    ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.method === 'Runtime.consoleAPICalled') {
            const args = msg.params.args.map(a => a.value || a.description || '').join(' ');
            allConsole.push({ ctx: msg.params.executionContextId, type: msg.params.type, text: args.substring(0, 500) });
        }
    });
    
    await cdpSend(ws, 'Runtime.enable');
    
    // Find extension contexts
    const contexts = [];
    ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.method === 'Runtime.executionContextCreated') contexts.push(msg.params.context);
    });
    await cdpSend(ws, 'Runtime.disable');
    await cdpSend(ws, 'Runtime.enable');
    await new Promise(r => setTimeout(r, 1000));
    
    const extContexts = contexts.filter(c => (c.origin || '').includes('hkjclekhnaffnhldgpmjnohihjmblbpj'));
    let chatCtx = null;
    for (const ctx of extContexts) {
        try {
            const r = await cdpSend(ws, 'Runtime.evaluate', { contextId: ctx.id, expression: 'window.location.pathname', returnByValue: true });
            if (r.result.value === '/chat') { chatCtx = ctx; break; }
        } catch(e) {}
    }
    
    if (!chatCtx) { console.error('No extension context on /chat'); ws.close(); return; }
    console.log('Extension context:', chatCtx.id);
    
    // Check container
    const containerCheck = await cdpSend(ws, 'Runtime.evaluate', {
        contextId: chatCtx.id,
        expression: `document.querySelectorAll('.notion-selectable-container').length`,
        returnByValue: true,
    });
    console.log('Containers:', containerCheck.result.value);
    
    // Clear console buffer
    const clearIdx = allConsole.length;
    
    // Inject properly formatted content
    const escaped = PROPER_FUNCTION_RESULTS.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
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
            synth.id = 'mcp-e2e-proper';
            synth.textContent = '${escaped}';
            turnLane.insertBefore(synth, turnLane.children[1] || null);
            return JSON.stringify({injected: true, children: turnLane.children.length, textLen: synth.textContent.length});
        })()`,
        returnByValue: true,
    });
    console.log('Inject:', JSON.parse(injectResult.result.value));
    
    // Wait for observer to process
    await new Promise(r => setTimeout(r, 5000));
    
    // Collect trace messages
    console.log('\n--- PIPELINE-TRACE messages ---');
    const traceMessages = allConsole.slice(clearIdx).filter(m => m.text.includes('PIPELINE-TRACE'));
    for (const m of traceMessages) {
        console.log(`  [${m.type}] ${m.text.substring(0, 300)}`);
    }
    
    // Check DOMLock warnings
    const domlockWarnings = allConsole.slice(clearIdx).filter(m => m.text.includes('Reverting mutation'));
    console.log(`\nDOMLock warnings: ${domlockWarnings.length}`);
    
    // Check rendering result
    const renderCheck = await cdpSend(ws, 'Runtime.evaluate', {
        contextId: chatCtx.id,
        expression: `JSON.stringify({
            cards: document.querySelectorAll('.function-result-container').length,
            testExists: !!document.getElementById('mcp-e2e-proper'),
            testChildren: document.getElementById('mcp-e2e-proper')?.children?.length || 0,
            testInnerHTML: (document.getElementById('mcp-e2e-proper')?.innerHTML || '').substring(0, 200),
            testText: (document.getElementById('mcp-e2e-proper')?.textContent || '').substring(0, 100),
            shadowHosts: document.querySelectorAll('.mcp-function-result-shadow-host').length,
        })`,
        returnByValue: true,
    });
    console.log('\nRendering check:', JSON.parse(renderCheck.result.value));
    
    // Cleanup
    await cdpSend(ws, 'Runtime.evaluate', {
        contextId: chatCtx.id,
        expression: `(function(){var e=document.getElementById('mcp-e2e-proper');if(e)e.remove()})()`,
    });
    
    ws.close();
}

main().catch(e => console.error(e.message));
