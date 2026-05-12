// notion-find-send-btn2.cjs — Broader search for send button in Notion AI
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

    // Type text using keyboard to trigger React state change
    console.log('Step 1: Focus input and type via keyboard...');
    await send('Runtime.evaluate', {
        expression: `(function() {
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            if (input) { input.focus(); return 'focused'; }
            return 'no input';
        })()`,
        returnByValue: true,
    });
    
    // Type a character to trigger the send button
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'h', text: 'h', windowsVirtualKeyCode: 72 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'h', windowsVirtualKeyCode: 72 });
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'i', text: 'i', windowsVirtualKeyCode: 73 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'i', windowsVirtualKeyCode: 73 });
    await new Promise(r => setTimeout(r, 1500));

    // Now search broadly
    const search = await send('Runtime.evaluate', {
        expression: `(function() {
            const results = [];
            
            // Search ALL data-testid elements  
            const testIds = document.querySelectorAll('[data-testid]');
            const testIdList = [];
            testIds.forEach(el => {
                const id = el.getAttribute('data-testid');
                testIdList.push(id);
            });
            
            // Search for ALL buttons and roles
            const allBtns = document.querySelectorAll('button, [role="button"]');
            const btnInfo = [];
            allBtns.forEach(b => {
                const rect = b.getBoundingClientRect();
                // Only visible buttons
                if (rect.width > 0 && rect.height > 0) {
                    const label = b.getAttribute('aria-label') || '';
                    const testId = b.getAttribute('data-testid') || '';
                    const text = (b.textContent || '').trim().substring(0, 30);
                    // Filter for potentially send-related
                    if (label || testId || !text) {
                        btnInfo.push({ label, testId, text, tag: b.tagName, w: rect.width|0, h: rect.height|0 });
                    }
                }
            });
            
            // Find elements with arrow/send SVG near input
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            let nearInputElements = [];
            if (input) {
                // Walk up to find container, then look for siblings
                let container = input;
                for (let i = 0; i < 5; i++) {
                    container = container.parentElement;
                    if (!container) break;
                }
                if (container) {
                    const allEls = container.querySelectorAll('*');
                    allEls.forEach(el => {
                        const rect = el.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && rect.width < 60) {
                            const hasSvg = el.querySelector('svg') || el.tagName === 'SVG';
                            if (hasSvg) {
                                nearInputElements.push({
                                    tag: el.tagName,
                                    class: (el.className || '').substring(0, 40),
                                    role: el.getAttribute('role'),
                                    ariaLabel: el.getAttribute('aria-label'),
                                    testId: el.getAttribute('data-testid'),
                                    w: rect.width|0,
                                    h: rect.height|0,
                                    x: rect.x|0,
                                    y: rect.y|0
                                });
                            }
                        }
                    });
                }
            }
            
            return JSON.stringify({
                testIds: testIdList.filter(id => id.includes('send') || id.includes('submit') || id.includes('chat') || id.includes('message') || id.includes('button')),
                allTestIds: testIdList,
                visibleButtons: btnInfo.slice(0, 20),
                svgNearInput: nearInputElements.slice(0, 10),
                inputContent: input?.textContent?.substring(0, 50) || 'NONE'
            }, null, 2);
        })()`,
        returnByValue: true,
    });
    console.log('Search result:', val(search));

    // Clear the typed text
    await send('Runtime.evaluate', {
        expression: `(function() {
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            if (input) {
                input.focus();
                document.execCommand('selectAll');
                document.execCommand('delete');
            }
        })()`,
        returnByValue: true,
    });

    ws.close();
    process.exit(0);
})();
