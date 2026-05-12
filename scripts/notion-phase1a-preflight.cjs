// notion-phase1a-preflight.cjs — Pre-flight check before echo test
// Verifies: correct tab, input clear, submit button, MCP active
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
    
    // Find the Notion AI chat tab specifically
    const chatTab = targets.find(t => t.url.includes('notion.so/ai') || t.url.includes('notion.so/chat'));
    if (!chatTab) {
        console.log('ERROR: No Notion AI chat tab found');
        console.log('Available Notion tabs:');
        targets.filter(t => t.url.includes('notion.so')).forEach(t => console.log(`  ${t.url}`));
        process.exit(1);
    }
    
    console.log('=== PREFLIGHT CHECK ===');
    console.log(`Tab URL: ${chatTab.url}`);
    console.log(`Tab ID: ${chatTab.id}`);

    const ws = new WebSocket(chatTab.webSocketDebuggerUrl);
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

    // Check 1: Input box exists and is empty
    const inputCheck = await send('Runtime.evaluate', {
        expression: `(function() {
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            if (!input) return JSON.stringify({ status: 'NO_INPUT' });
            return JSON.stringify({
                status: 'OK',
                text: input.textContent?.substring(0, 100) || '',
                isEmpty: (input.textContent || '').trim() === '',
                placeholder: input.getAttribute('placeholder') || input.getAttribute('data-placeholder') || 'none'
            });
        })()`,
        returnByValue: true,
    });
    console.log('Input:', val(inputCheck));

    // Check 2: Submit button exists
    const submitCheck = await send('Runtime.evaluate', {
        expression: `(function() {
            const btn = document.querySelector('[data-testid="agent-send-message-button"]');
            if (!btn) return 'NOT_FOUND';
            return JSON.stringify({
                status: 'OK',
                ariaLabel: btn.getAttribute('aria-label'),
                visible: btn.offsetHeight > 0
            });
        })()`,
        returnByValue: true,
    });
    console.log('Submit button:', val(submitCheck));

    // Check 3: MCP button status
    const mcpCheck = await send('Runtime.evaluate', {
        expression: `(function() {
            const mcpBtn = document.querySelector('button[aria-label*="MCP"]');
            if (!mcpBtn) return 'NOT_FOUND';
            return JSON.stringify({
                status: 'OK',
                label: mcpBtn.getAttribute('aria-label'),
                text: mcpBtn.textContent?.trim()
            });
        })()`,
        returnByValue: true,
    });
    console.log('MCP button:', val(mcpCheck));

    // Check 4: Extension service worker is active
    const extTab = targets.find(t => t.url.includes('hkjclekhnaffnhldgpmjnohihjmblbpj'));
    console.log('Extension SW:', extTab ? 'ACTIVE' : 'NOT FOUND');

    // Check 5: Current model
    const modelCheck = await send('Runtime.evaluate', {
        expression: `(function() {
            const modelBtn = document.querySelector('[data-testid="unified-chat-model-button"]');
            return modelBtn ? modelBtn.textContent?.trim() : 'NOT_FOUND';
        })()`,
        returnByValue: true,
    });
    console.log('Model:', val(modelCheck));

    console.log('=== PREFLIGHT COMPLETE ===');
    
    ws.close();
    process.exit(0);
})();
