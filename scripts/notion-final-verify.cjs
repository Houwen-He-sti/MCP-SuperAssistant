/**
 * Final E2E verification — reload extension, inject proper format, verify rendering
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

const PROPER_FUNCTION_RESULTS = `<function_results>
  <result call_id="call_verify" name="list_files" status="success">
    <content type="application/json"><![CDATA[
{"files": ["README.md", "package.json", "src/index.ts"]}
    ]]></content>
  </result>
</function_results>`;

async function main() {
    console.log('=== Final E2E Verification ===\n');
    
    const targets = await getTargets();
    
    // Step 1: Reload extension
    const sw = targets.find(t => t.type === 'service_worker' && t.url.includes('hkjclekhnaffnhldgpmjnohihjmblbpj'));
    if (sw) {
        const wsSW = new WebSocket(sw.webSocketDebuggerUrl);
        await new Promise((r, e) => { wsSW.on('open', r); wsSW.on('error', e); });
        await cdpSend(wsSW, 'Runtime.enable');
        await cdpSend(wsSW, 'Runtime.evaluate', {
            expression: 'chrome.runtime.reload()',
            returnByValue: true,
            awaitPromise: true,
        }).catch(() => {});
        wsSW.close();
        console.log('Extension reloaded');
    }
    
    await new Promise(r => setTimeout(r, 5000));
    
    // Step 2: Connect to Notion page
    const newTargets = await getTargets();
    const notion = newTargets.find(t => t.type === 'page' && t.url.includes('notion.so/chat'));
    if (!notion) { console.error('No Notion chat page'); return; }
    
    const ws = new WebSocket(notion.webSocketDebuggerUrl);
    await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
    
    await cdpSend(ws, 'Runtime.enable');
    await cdpSend(ws, 'Page.enable');
    
    // Reload page
    await cdpSend(ws, 'Page.reload', { ignoreCache: true });
    console.log('Page reloading...');
    await new Promise(r => setTimeout(r, 15000));
    
    // Find extension context
    const contexts = [];
    ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.method === 'Runtime.executionContextCreated') contexts.push(msg.params.context);
    });
    await cdpSend(ws, 'Runtime.disable');
    await cdpSend(ws, 'Runtime.enable');
    await new Promise(r => setTimeout(r, 1000));
    
    let chatCtx = null;
    for (const ctx of contexts.filter(c => (c.origin || '').includes('hkjclekhnaffnhldgpmjnohihjmblbpj'))) {
        try {
            const r = await cdpSend(ws, 'Runtime.evaluate', { contextId: ctx.id, expression: 'window.location.pathname', returnByValue: true });
            if (r.result.value === '/chat') { chatCtx = ctx; break; }
        } catch(e) {}
    }
    
    if (!chatCtx) { console.error('No extension context'); ws.close(); return; }
    console.log('Extension context:', chatCtx.id);
    
    // Step 3: Inject proper content
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
            synth.id = 'mcp-final-verify';
            synth.textContent = '${escaped}';
            turnLane.insertBefore(synth, turnLane.children[1] || null);
            return JSON.stringify({injected: true});
        })()`,
        returnByValue: true,
    });
    console.log('Inject:', JSON.parse(injectResult.result.value));
    
    // Wait for rendering
    await new Promise(r => setTimeout(r, 5000));
    
    // Step 4: Verify
    const check = await cdpSend(ws, 'Runtime.evaluate', {
        contextId: chatCtx.id,
        expression: `JSON.stringify({
            cards: document.querySelectorAll('.function-result-container').length,
            testExists: !!document.getElementById('mcp-final-verify'),
            testChildren: document.getElementById('mcp-final-verify')?.children?.length || 0,
            hasCardDOM: (document.getElementById('mcp-final-verify')?.innerHTML || '').includes('function-result-container'),
            hasFunctionName: (document.getElementById('mcp-final-verify')?.textContent || '').includes('Function Result'),
            hasContent: (document.getElementById('mcp-final-verify')?.textContent || '').includes('README.md'),
        })`,
        returnByValue: true,
    });
    
    const result = JSON.parse(check.result.value);
    console.log('\n=== RESULTS ===');
    console.log(result);
    
    if (result.cards > 0 && result.hasCardDOM && result.hasFunctionName) {
        console.log('\n✅ E2E PASS — Rendering pipeline works on Notion!');
    } else {
        console.log('\n❌ E2E FAIL — Check results above');
    }
    
    // Cleanup
    await cdpSend(ws, 'Runtime.evaluate', {
        contextId: chatCtx.id,
        expression: `(function(){var e=document.getElementById('mcp-final-verify');if(e)e.remove()})()`,
    });
    
    ws.close();
}

main().catch(e => console.error(e.message));
