// Observe current Notion page — what URL is it on, what kind of chat
const http = require('http');
const WebSocket = require('ws');

(async () => {
    const targets = await new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:9222/json', res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
    });

    const tab = targets.find(t => /notion\.so/.test(t.url) && t.type === 'page' && !/sw\.js|_assets/.test(t.url));
    if (!tab) { console.log('No Notion tab'); process.exit(1); }
    console.log('Tab URL:', tab.url);

    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));

    let msgId = 0;
    function send(method, params) {
        return new Promise((resolve, reject) => {
            const id = ++msgId;
            const timer = setTimeout(() => reject(new Error('timeout')), 15000);
            function handler(msg) {
                const obj = JSON.parse(msg);
                if (obj.id === id) { clearTimeout(timer); ws.off('message', handler); resolve(obj); }
            }
            ws.on('message', handler);
            ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
    }
    function val(r) { return r.result?.result?.value; }

    await send('Runtime.enable');

    // 1. Current URL
    const url = val(await send('Runtime.evaluate', { expression: 'window.location.href', returnByValue: true }));
    console.log('Current URL:', url);

    // 2. Check if we're on a chat page or agent page
    const pageType = await send('Runtime.evaluate', {
        expression: `(function() {
            const imgs = Array.from(document.querySelectorAll('img'));
            const hasAiFace = imgs.some(img => img.alt === 'Notion AI face');
            const hasPlugIcon = imgs.some(img => img.src?.includes('customAgentAvatars'));
            
            // Check the active chat header
            const headerText = document.querySelector('[class*="header"]')?.textContent?.substring(0, 100) || '';
            
            // Check for MCP badge/indicator
            const mcpButton = document.querySelector('[aria-label*="MCP"]');
            
            // Check the sidebar active item
            const bodyText = document.body.innerText;
            const hasSuperAssistant = bodyText.includes('SuperAssistant');
            
            return JSON.stringify({
                url: window.location.href,
                hasAiFace,
                hasPlugIcon,
                hasMcpButton: !!mcpButton,
                mcpButtonText: mcpButton?.getAttribute('aria-label'),
                hasSuperAssistant,
                headerText,
            });
        })()`,
        returnByValue: true,
    });
    console.log('Page type:', val(pageType));

    // 3. Check the send button status
    const sendBtn = await send('Runtime.evaluate', {
        expression: `(function() {
            const btn = document.querySelector('[data-testid="agent-send-message-button"]');
            if (!btn) return JSON.stringify({ exists: false });
            const rect = btn.getBoundingClientRect();
            return JSON.stringify({
                exists: true,
                disabled: btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true',
                visible: rect.width > 0 && rect.height > 0,
                ariaLabel: btn.getAttribute('aria-label'),
                opacity: getComputedStyle(btn).opacity,
                pointerEvents: getComputedStyle(btn).pointerEvents,
                cursor: getComputedStyle(btn).cursor,
                rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
            });
        })()`,
        returnByValue: true,
    });
    console.log('Send button:', val(sendBtn));

    // 4. Check input
    const input = await send('Runtime.evaluate', {
        expression: `(function() {
            const inp = document.querySelector('div[role="textbox"][contenteditable="true"]');
            if (!inp) return JSON.stringify({ exists: false });
            return JSON.stringify({
                exists: true,
                textLength: inp.textContent?.length || 0,
                isEmpty: inp.textContent?.trim() === '' || inp.innerHTML?.includes('placeholder'),
            });
        })()`,
        returnByValue: true,
    });
    console.log('Input:', val(input));

    ws.close();
})();
