// notion-check-active-page.cjs — Check current page state and find send button
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
    console.log('Tab URL:', notionTab.url);

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

    // Navigate to the echo test conversation (last active chat)
    console.log('Step 1: Navigate to chat page...');
    const navResult = await send('Runtime.evaluate', {
        expression: `(function() {
            // Click on the most recent chat in the sidebar
            const historyItems = document.querySelectorAll('[aria-label="history"]');
            if (historyItems.length > 0) {
                // Click the first (most recent) history item
                historyItems[0].click();
                return 'clicked first history item: ' + historyItems[0].textContent?.substring(0, 50);
            }
            return 'no history items found, current URL: ' + window.location.href;
        })()`,
        returnByValue: true,
    });
    console.log('Nav:', val(navResult));
    await new Promise(r => setTimeout(r, 3000));

    // Now check for input and send button
    const check = await send('Runtime.evaluate', {
        expression: `(function() {
            const url = window.location.href;
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            const inputContent = input ? input.textContent?.substring(0, 50) : 'NOT FOUND';
            
            // Try to type in input
            if (input) {
                input.focus();
                // Use execCommand to insert text (more likely to trigger React)
                document.execCommand('insertText', false, 'test');
            }
            
            return JSON.stringify({ url, inputContent });
        })()`,
        returnByValue: true,
    });
    console.log('Input check:', val(check));
    await new Promise(r => setTimeout(r, 1500));

    // Search for send button after text is in input
    const btnSearch = await send('Runtime.evaluate', {
        expression: `(function() {
            // Check ALL elements with data-testid
            const allTestIds = [];
            document.querySelectorAll('[data-testid]').forEach(el => {
                allTestIds.push(el.getAttribute('data-testid'));
            });
            
            // Check for send-like icons/buttons near bottom of chat
            const allButtons = document.querySelectorAll('[role="button"], button');
            const sendCandidates = [];
            allButtons.forEach(b => {
                const rect = b.getBoundingClientRect();
                // Send button is usually at bottom-right, near the input
                if (rect.y > 500 && rect.width > 0) {
                    sendCandidates.push({
                        tag: b.tagName,
                        ariaLabel: b.getAttribute('aria-label') || '',
                        testId: b.getAttribute('data-testid') || '',
                        text: (b.textContent || '').trim().substring(0, 20),
                        class: (b.className || '').substring(0, 40),
                        x: rect.x|0, y: rect.y|0, w: rect.width|0, h: rect.height|0,
                        hasSvg: !!b.querySelector('svg')
                    });
                }
            });
            
            // Also check for arrow-up SVGs (common send icon)
            const svgs = document.querySelectorAll('svg');
            const arrowSvgs = [];
            svgs.forEach(svg => {
                const rect = svg.getBoundingClientRect();
                if (rect.y > 500 && rect.width > 0) {
                    const parent = svg.parentElement;
                    arrowSvgs.push({
                        parentTag: parent?.tagName,
                        parentClass: (parent?.className || '').substring(0, 30),
                        parentRole: parent?.getAttribute('role'),
                        parentAriaLabel: parent?.getAttribute('aria-label'),
                        x: rect.x|0, y: rect.y|0, w: rect.width|0, h: rect.height|0
                    });
                }
            });
            
            return JSON.stringify({
                allTestIds,
                sendCandidates: sendCandidates.slice(0, 10),
                arrowSvgs: arrowSvgs.slice(0, 10)
            }, null, 2);
        })()`,
        returnByValue: true,
    });
    console.log('Button search:', val(btnSearch));

    // Clean up
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
