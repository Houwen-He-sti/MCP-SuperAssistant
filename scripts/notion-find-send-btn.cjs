// notion-find-send-btn.cjs — Find the actual send button selector in Notion AI
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

    // First: type something in the input to make send button appear
    console.log('Step 1: Insert some text to make send button appear...');
    await send('Runtime.evaluate', {
        expression: `(function() {
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            if (input) {
                input.focus();
                input.textContent = 'test';
                // Dispatch input event to trigger UI update
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
            return input ? 'done' : 'no input';
        })()`,
        returnByValue: true,
    });
    await new Promise(r => setTimeout(r, 1000));

    // Search for send-like buttons
    const btnSearch = await send('Runtime.evaluate', {
        expression: `(function() {
            const results = [];
            
            // 1. Check data-testid attributes
            const testIds = document.querySelectorAll('[data-testid]');
            testIds.forEach(el => {
                const id = el.getAttribute('data-testid');
                if (id.includes('send') || id.includes('submit') || id.includes('arrow') || id.includes('button')) {
                    results.push({
                        type: 'data-testid',
                        testId: id,
                        tag: el.tagName,
                        visible: el.offsetHeight > 0,
                        text: el.textContent?.substring(0, 30)
                    });
                }
            });
            
            // 2. Check aria-labels
            const ariaLabels = document.querySelectorAll('[aria-label]');
            ariaLabels.forEach(el => {
                const label = el.getAttribute('aria-label');
                if (label.includes('发送') || label.includes('Send') || label.includes('send') || label.includes('提交') || label.includes('submit')) {
                    results.push({
                        type: 'aria-label',
                        label,
                        tag: el.tagName,
                        visible: el.offsetHeight > 0,
                        text: el.textContent?.substring(0, 30)
                    });
                }
            });
            
            // 3. Check SVG icons near the input that look like send buttons
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            if (input) {
                const parent = input.closest('[class*="chat"], [class*="input"], form') || input.parentElement?.parentElement;
                if (parent) {
                    const svgs = parent.querySelectorAll('svg');
                    svgs.forEach(svg => {
                        const parentEl = svg.parentElement;
                        results.push({
                            type: 'svg-near-input',
                            parentTag: parentEl?.tagName,
                            parentRole: parentEl?.getAttribute('role'),
                            parentAriaLabel: parentEl?.getAttribute('aria-label'),
                            parentClass: parentEl?.className?.substring(0, 40),
                            clickable: parentEl?.tagName === 'BUTTON' || parentEl?.getAttribute('role') === 'button',
                            visible: parentEl?.offsetHeight > 0
                        });
                    });
                }
            }
            
            // 4. Check for any button/clickable near input
            if (input) {
                const container = input.parentElement?.parentElement?.parentElement;
                if (container) {
                    const buttons = container.querySelectorAll('button, [role="button"]');
                    buttons.forEach(b => {
                        results.push({
                            type: 'button-near-input',
                            tag: b.tagName,
                            ariaLabel: b.getAttribute('aria-label'),
                            testId: b.getAttribute('data-testid'),
                            text: b.textContent?.substring(0, 30),
                            visible: b.offsetHeight > 0,
                            class: b.className?.substring(0, 40)
                        });
                    });
                }
            }
            
            return JSON.stringify(results, null, 2);
        })()`,
        returnByValue: true,
    });
    console.log('Button search:', val(btnSearch));

    // Clean up the test text
    await send('Runtime.evaluate', {
        expression: `(function() {
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            if (input) {
                input.textContent = '';
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        })()`,
        returnByValue: true,
    });

    ws.close();
    process.exit(0);
})();
