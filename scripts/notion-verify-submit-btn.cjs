// notion-verify-submit-btn.cjs — Verify the submit button selector used by the Notion adapter
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

    // Check 1: Does the submit button exist?
    const submitCheck = await send('Runtime.evaluate', {
        expression: `(function() {
            const btn = document.querySelector('[data-testid="agent-send-message-button"]');
            if (!btn) return 'NOT FOUND';
            const rect = btn.getBoundingClientRect();
            const disabled = btn.getAttribute('aria-disabled');
            const pointerEvents = window.getComputedStyle(btn).pointerEvents;
            return JSON.stringify({
                found: true,
                tag: btn.tagName,
                text: btn.textContent?.substring(0, 50),
                width: rect.width,
                height: rect.height,
                ariaDisabled: disabled,
                pointerEvents,
                visible: rect.width > 0 && rect.height > 0
            });
        })()`,
        returnByValue: true,
    });
    console.log('Submit button:', val(submitCheck));

    // Check 2: Verify the store mechanism — how to set autoInsert via CDP
    const storeCheck = await send('Runtime.evaluate', {
        expression: `(function() {
            // Check if Zustand stores are accessible
            const stores = {};
            if (window.__ZUSTAND_STORES__) stores.zustand = Object.keys(window.__ZUSTAND_STORES__);
            if (window.__MCP_UI_STORE__) stores.mcpUiStore = true;
            
            // Check for exposed automation state
            if (window.__MCP_AUTOMATION_STATE__) stores.automationState = window.__MCP_AUTOMATION_STATE__;
            
            // Check localStorage for any MCP-related settings
            const lsKeys = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && (key.includes('mcp') || key.includes('autoInsert') || key.includes('autoSubmit') || key.includes('superassistant'))) {
                    lsKeys.push(key + ': ' + (localStorage.getItem(key) || '').substring(0, 100));
                }
            }
            
            return JSON.stringify({ stores, localStorage: lsKeys }, null, 2);
        })()`,
        returnByValue: true,
    });
    console.log('Store check:', val(storeCheck));

    // Check 3: Look for the AutomationService event listener
    const automationCheck = await send('Runtime.evaluate', {
        expression: `(function() {
            // Check if AutomationService exposes state on window
            const keys = [];
            for (const key of Object.getOwnPropertyNames(window)) {
                if (key.includes('automation') || key.includes('Automation') || 
                    key.includes('MCP') || key.includes('mcp') || 
                    key.includes('superassistant') || key.includes('SuperAssistant')) {
                    const val = window[key];
                    keys.push(key + ': ' + typeof val);
                }
            }
            return JSON.stringify(keys, null, 2);
        })()`,
        returnByValue: true,
    });
    console.log('Automation globals:', val(automationCheck));

    ws.close();
    process.exit(0);
})();
