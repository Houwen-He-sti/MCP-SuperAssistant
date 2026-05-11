/**
 * Just reload extension + wait + check. No page reload needed if
 * the extension auto-injects after reload.
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
    console.log('=== Step 1: Reload extension ===');
    const targets = await getTargets();
    const sw = targets.find(t => t.type === 'service_worker' && t.url.includes('hkjclekhnaffnhldgpmjnohihjmblbpj'));
    if (sw) {
        const wsSW = new WebSocket(sw.webSocketDebuggerUrl);
        await new Promise((r, e) => { wsSW.on('open', r); wsSW.on('error', e); });
        await cdpSend(wsSW, 'Runtime.enable');
        await cdpSend(wsSW, 'Runtime.evaluate', { expression: 'chrome.runtime.reload()' }).catch(() => {});
        wsSW.close();
        console.log('Extension reload triggered');
    }
    
    console.log('Waiting 5s...');
    await new Promise(r => setTimeout(r, 5000));
    
    console.log('\n=== Step 2: Reload Notion page ===');
    const targets2 = await getTargets();
    const notion = targets2.find(t => t.type === 'page' && t.url.includes('notion.so'));
    if (!notion) { console.error('No Notion page found'); return; }
    
    const ws = new WebSocket(notion.webSocketDebuggerUrl);
    await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
    
    const allConsole = [];
    ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.method === 'Runtime.consoleAPICalled') {
            const args = msg.params.args.map(a => a.value || a.description || '').join(' ');
            allConsole.push(args.substring(0, 300));
        }
    });
    
    await cdpSend(ws, 'Runtime.enable');
    await cdpSend(ws, 'Page.enable');
    await cdpSend(ws, 'Page.reload', { ignoreCache: true });
    console.log('Page reloading...');
    
    // Wait longer
    console.log('Waiting 25s for SPA to load...');
    await new Promise(r => setTimeout(r, 25000));
    
    // Check container
    const containerCheck = await cdpSend(ws, 'Runtime.evaluate', {
        expression: `document.querySelectorAll('.notion-selectable-container').length`,
        returnByValue: true,
    });
    console.log('Containers:', containerCheck.result.value);
    
    // Check for PIPELINE-TRACE (should be absent after cleanup)
    const hasPipelineTrace = allConsole.some(m => m.includes('PIPELINE-TRACE'));
    console.log('Has PIPELINE-TRACE logs:', hasPipelineTrace);
    
    if (containerCheck.result.value > 0) {
        // Find ext context
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
                if (r.result.value.startsWith('/chat')) { chatCtx = ctx; break; }
            } catch(e) {}
        }
        
        if (chatCtx) {
            // Inject with proper format
            const content = `<function_results>\\n  <result call_id="call_final" name="list_files" status="success">\\n    <content type="application/json"><![CDATA[\\n{"files": ["README.md", "package.json"]}\\n    ]]></content>\\n  </result>\\n</function_results>`;
            const clearIdx = allConsole.length;
            
            const inject = await cdpSend(ws, 'Runtime.evaluate', {
                contextId: chatCtx.id,
                expression: `(function() {
                    var c = document.querySelector('.notion-selectable-container');
                    var divs = c.querySelectorAll('div');
                    var lane = null;
                    for (var i = 0; i < divs.length; i++) {
                        if (divs[i].children.length >= 8) { lane = divs[i]; break; }
                    }
                    if (!lane) return JSON.stringify({error:'no lane'});
                    var s = document.createElement('div');
                    s.id = 'mcp-clean-verify';
                    s.textContent = '${content}';
                    lane.insertBefore(s, lane.children[1] || null);
                    return JSON.stringify({ok: true});
                })()`,
                returnByValue: true,
            });
            console.log('\nInject:', JSON.parse(inject.result.value));
            
            await new Promise(r => setTimeout(r, 3000));
            
            // Check PIPELINE-TRACE in post-inject (should be absent)
            const postTrace = allConsole.slice(clearIdx).filter(m => m.includes('PIPELINE-TRACE'));
            console.log('Post-inject PIPELINE-TRACE count:', postTrace.length, '(should be 0 after cleanup)');
            
            const result = await cdpSend(ws, 'Runtime.evaluate', {
                contextId: chatCtx.id,
                expression: `JSON.stringify({
                    cards: document.querySelectorAll('.function-result-container').length,
                    rendered: (document.getElementById('mcp-clean-verify')?.innerHTML || '').includes('function-result-container'),
                })`,
                returnByValue: true,
            });
            const r = JSON.parse(result.result.value);
            console.log('Result:', r);
            
            if (r.cards > 0 && r.rendered) {
                console.log('\n✅ CLEAN BUILD E2E PASS');
            } else {
                console.log('\n❌ CLEAN BUILD E2E FAIL');
            }
            
            // Cleanup
            await cdpSend(ws, 'Runtime.evaluate', {
                contextId: chatCtx.id,
                expression: `(function(){var e=document.getElementById('mcp-clean-verify');if(e)e.remove()})()`,
            });
        }
    } else {
        console.log('No containers found after 25s. Chat thread may not have loaded.');
    }
    
    ws.close();
}

main().catch(e => console.error(e.message));
