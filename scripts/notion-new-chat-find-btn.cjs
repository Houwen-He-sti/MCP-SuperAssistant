// notion-new-chat-find-btn.cjs — Start new chat and find send button
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
    const notionTab = targets.find(t => t.url.includes('notion.so/chat'));
    if (!notionTab) { console.log('ERROR: No Notion chat tab'); process.exit(1); }
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

    // Click "新对话" button
    console.log('Clicking 新对话...');
    await send('Runtime.evaluate', {
        expression: `(function() {
            const btn = document.querySelector('[aria-label="新对话"]');
            if (btn) { btn.click(); return 'clicked'; }
            // Try alternative: Ctrl+O
            return 'button not found';
        })()`,
        returnByValue: true,
    });
    await new Promise(r => setTimeout(r, 3000));

    // Check URL and input
    console.log('Checking after 新对话...');
    const afterNav = await send('Runtime.evaluate', {
        expression: `(function() {
            const url = window.location.href;
            const inputs = document.querySelectorAll('div[role="textbox"][contenteditable="true"]');
            const textareas = document.querySelectorAll('textarea');
            const placeholders = document.querySelectorAll('[data-placeholder]');
            return JSON.stringify({
                url,
                textboxCount: inputs.length,
                textareaCount: textareas.length,
                placeholderCount: placeholders.length,
                firstPlaceholder: placeholders[0]?.getAttribute('data-placeholder'),
                firstTextbox: inputs[0] ? {
                    html: inputs[0].outerHTML.substring(0, 200),
                    parent: inputs[0].parentElement?.className?.substring(0, 40),
                } : null
            });
        })()`,
        returnByValue: true,
    });
    console.log('After nav:', val(afterNav));

    // Focus and type
    const focus = await send('Runtime.evaluate', {
        expression: `(function() {
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            if (input) {
                input.focus();
                document.execCommand('insertText', false, 'hello');
                return 'typed in textbox';
            }
            // Try textarea
            const ta = document.querySelector('textarea');
            if (ta) {
                ta.focus();
                ta.value = 'hello';
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                return 'typed in textarea';
            }
            return 'no input found';
        })()`,
        returnByValue: true,
    });
    console.log('Focus:', val(focus));
    await new Promise(r => setTimeout(r, 2000));

    // Search for send button
    const btnSearch = await send('Runtime.evaluate', {
        expression: `(function() {
            const results = {};
            
            // ALL data-testid
            const testIds = [];
            document.querySelectorAll('[data-testid]').forEach(el => {
                const rect = el.getBoundingClientRect();
                testIds.push({
                    id: el.getAttribute('data-testid'),
                    tag: el.tagName,
                    visible: rect.width > 0 && rect.height > 0,
                    x: rect.x|0, y: rect.y|0
                });
            });
            results.testIds = testIds;
            
            // ALL visible role=button and button elements
            const btns = [];
            document.querySelectorAll('[role="button"], button').forEach(b => {
                const rect = b.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    btns.push({
                        tag: b.tagName,
                        ariaLabel: b.getAttribute('aria-label') || '',
                        testId: b.getAttribute('data-testid') || '',
                        text: (b.textContent || '').trim().substring(0, 30),
                        x: rect.x|0, y: rect.y|0, w: rect.width|0, h: rect.height|0,
                    });
                }
            });
            results.allButtons = btns;
            
            // Check input content
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            results.inputText = input?.textContent?.substring(0, 30) || 'NONE';
            
            return JSON.stringify(results, null, 2);
        })()`,
        returnByValue: true,
    });
    console.log('Button search:', val(btnSearch));

    // Clean up
    await send('Runtime.evaluate', {
        expression: `(function() {
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            if (input) { input.focus(); document.execCommand('selectAll'); document.execCommand('delete'); }
        })()`,
        returnByValue: true,
    });

    ws.close();
    process.exit(0);
})();
