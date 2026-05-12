// Diagnostic helper for Phase 1B investigation. Not part of the canonical regression path.
// notion-check-extension.cjs — Check if MCP-SuperAssistant extension detected the jsonl tool call
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

    // Check 1: Look for tool loop card or any extension-rendered UI
    const toolCards = await send('Runtime.evaluate', {
        expression: `(function() {
            // Look for extension-rendered elements
            const cards = document.querySelectorAll('[data-tool-loop], [data-mcp], [class*="tool-loop"], [class*="mcp-card"]');
            
            // Check for shadow roots that might contain tool cards
            const shadowHosts = document.querySelectorAll('[data-shadow-host], [class*="shadow"]');
            
            // Check for any injected result elements
            const injected = document.querySelectorAll('[data-injected], [class*="injected"], [class*="bridge-result"]');
            
            // Look for any element with "echo" or "hello-from-notion" in data attributes
            const allElements = document.querySelectorAll('*');
            const echoElements = [];
            allElements.forEach(el => {
                const attrs = el.attributes;
                for (let i = 0; i < attrs.length; i++) {
                    if (attrs[i].value.includes('echo') || attrs[i].value.includes('hello')) {
                        echoElements.push(el.tagName + '.' + el.className.substring(0, 30) + ' | ' + attrs[i].name + '=' + attrs[i].value.substring(0, 50));
                    }
                }
            });
            
            return JSON.stringify({
                toolCards: cards.length,
                shadowHosts: shadowHosts.length,
                injected: injected.length,
                echoElements: echoElements.slice(0, 10)
            }, null, 2);
        })()`,
        returnByValue: true,
    });
    console.log('Extension UI check:', val(toolCards));

    // Check 2: Console logs from extension (get recent console messages)
    // Enable console domain first
    await send('Console.enable');
    await send('Runtime.enable');
    
    // Get extension state from window.__MCP_SUPERASSISTANT__ or similar globals
    const extState = await send('Runtime.evaluate', {
        expression: `(function() {
            const globals = {};
            // Check common extension globals
            ['__MCP_SUPERASSISTANT__', '__TOOL_LOOP__', '__BRIDGE__', 
             '__functionCallExtractor', 'mcpSuperAssistant', 'toolLoopState'].forEach(key => {
                if (window[key]) globals[key] = typeof window[key];
            });
            
            // Check for any global with 'mcp' or 'tool' or 'bridge' in name
            const mcpKeys = [];
            for (const key of Object.keys(window)) {
                if (key.toLowerCase().includes('mcp') || 
                    key.toLowerCase().includes('toolloop') ||
                    key.toLowerCase().includes('bridge') ||
                    key.toLowerCase().includes('superassistant')) {
                    mcpKeys.push(key);
                }
            }
            
            return JSON.stringify({
                globals,
                mcpKeys: mcpKeys.slice(0, 20)
            }, null, 2);
        })()`,
        returnByValue: true,
    });
    console.log('Extension state:', val(extState));

    // Check 3: Look at MCP proxy for recent requests
    const proxyCheck = await send('Runtime.evaluate', {
        expression: `(async function() {
            try {
                const resp = await fetch('http://localhost:3006/health', {method: 'GET'});
                const text = await resp.text();
                return 'MCP Proxy health: ' + text;
            } catch(e) {
                return 'MCP Proxy error: ' + e.message;
            }
        })()`,
        awaitPromise: true,
        returnByValue: true,
    });
    console.log('MCP Proxy:', val(proxyCheck));

    ws.close();
    process.exit(0);
})();
