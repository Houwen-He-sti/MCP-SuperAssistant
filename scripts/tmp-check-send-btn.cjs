// Check send button on native Notion AI page
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

    const tab = targets.find(t => /notion\.so\/chat/.test(t.url) && t.type === 'page');
    if (!tab) { console.log('No Notion chat tab'); process.exit(1); }

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

    // Check send buttons
    const r = await send('Runtime.evaluate', {
        expression: `(function() {
            // Find all data-testid elements related to send/submit
            const allTestIds = Array.from(document.querySelectorAll('[data-testid]'))
                .map(el => ({
                    testId: el.getAttribute('data-testid'),
                    tag: el.tagName,
                    text: el.textContent?.trim()?.substring(0, 30),
                    visible: el.offsetParent !== null || el.getBoundingClientRect().width > 0,
                }))
                .filter(el => /send|submit|message|chat|input/i.test(el.testId));

            // Also find aria-labels related to send
            const sendAria = Array.from(document.querySelectorAll('[aria-label]'))
                .filter(el => /send|发送|submit|提交/i.test(el.getAttribute('aria-label')))
                .map(el => ({
                    ariaLabel: el.getAttribute('aria-label'),
                    tag: el.tagName,
                    testId: el.getAttribute('data-testid'),
                    role: el.getAttribute('role'),
                    visible: el.offsetParent !== null,
                }));

            // Check the specific agent-send-message-button
            const agentBtn = document.querySelector('[data-testid="agent-send-message-button"]');
            // Also check unified-chat variants
            const unifiedSend = document.querySelector('[data-testid="unified-chat-send-button"]');
            
            return JSON.stringify({
                testIdElements: allTestIds,
                sendAriaElements: sendAria,
                hasAgentSendBtn: !!agentBtn,
                hasUnifiedSendBtn: !!unifiedSend,
            });
        })()`,
        returnByValue: true,
    });

    const info = JSON.parse(val(r));
    console.log('Has agent-send-message-button:', info.hasAgentSendBtn);
    console.log('Has unified-chat-send-button:', info.hasUnifiedSendBtn);
    console.log('\nTestId elements:');
    info.testIdElements.forEach(el => console.log(`  ${el.testId} (${el.tag}) visible=${el.visible} text="${el.text}"`));
    console.log('\nSend aria elements:');
    info.sendAriaElements.forEach(el => console.log(`  ${el.ariaLabel} (${el.tag}) testId=${el.testId} role=${el.role}`));

    ws.close();
})();
