// Diagnostic helper for Phase 1B investigation. Not part of the canonical regression path.
// notion-check-response.cjs — Check the actual DOM content of Notion AI response
const WebSocket = require('ws');
const http = require('http');

function getTargets() {
    return new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:9222/json', res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
    });
}

(async () => {
    const targets = await getTargets();
    const notionTab = targets.find(t => t.url.includes('notion.so'));
    if (!notionTab) { console.log('ERROR: No Notion tab'); process.exit(1); }

    const ws = new WebSocket(notionTab.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));

    let msgId = 0;
    function send(method, params) {
        return new Promise(resolve => {
            const id = ++msgId;
            const handler = msg => {
                const obj = JSON.parse(msg);
                if (obj.id === id) { ws.off('message', handler); resolve(obj); }
            };
            ws.on('message', handler);
            ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
    }
    function val(r) { return r.result?.result?.value; }

    // Get the last assistant message content including code blocks
    const result = await send('Runtime.evaluate', {
        expression: `(function() {
            // Find all assistant messages
            const msgs = document.querySelectorAll('[data-testid="chat-message-assistant"], [data-message-role="assistant"]');
            
            // If specific selectors don't work, try generic approach
            if (msgs.length === 0) {
                // Look for code blocks in the page
                const codeBlocks = document.querySelectorAll('pre, code');
                const allText = [];
                codeBlocks.forEach(cb => {
                    allText.push('CODE_BLOCK: ' + (cb.className || '') + ' | ' + cb.textContent.substring(0, 500));
                });
                
                // Also get all message-like containers
                const containers = document.querySelectorAll('[class*="message"], [class*="chat"], [class*="response"]');
                const containerInfo = [];
                containers.forEach(c => {
                    if (c.textContent.length > 10 && c.textContent.length < 5000) {
                        containerInfo.push('CONTAINER: ' + c.className.substring(0, 50) + ' | ' + c.textContent.substring(0, 200));
                    }
                });
                
                return JSON.stringify({
                    assistantMsgs: 0,
                    codeBlocks: allText.slice(0, 10),
                    containers: containerInfo.slice(0, 10)
                }, null, 2);
            }
            
            const lastMsg = msgs[msgs.length - 1];
            return JSON.stringify({
                assistantMsgs: msgs.length,
                lastMsgHtml: lastMsg.innerHTML.substring(0, 2000),
                lastMsgText: lastMsg.textContent.substring(0, 1000)
            }, null, 2);
        })()`,
        returnByValue: true,
    });
    console.log('Response content:', val(result));

    // Also check for jsonl specifically
    const jsonlCheck = await send('Runtime.evaluate', {
        expression: `(function() {
            const html = document.body.innerHTML;
            const hasJsonl = html.includes('jsonl') || html.includes('function_call_start');
            const hasEcho = html.includes('echo');
            const hasHelloFromNotion = html.includes('hello-from-notion');
            
            // Find any pre/code that contains jsonl
            const pres = document.querySelectorAll('pre');
            const jsonlBlocks = [];
            pres.forEach(p => {
                const text = p.textContent;
                if (text.includes('function_call') || text.includes('jsonl')) {
                    jsonlBlocks.push(text.substring(0, 500));
                }
            });
            
            return JSON.stringify({
                hasJsonl, hasEcho, hasHelloFromNotion,
                jsonlBlocks,
                totalPres: pres.length
            }, null, 2);
        })()`,
        returnByValue: true,
    });
    console.log('JSONL check:', val(jsonlCheck));

    ws.close();
    process.exit(0);
})();
