// notion-navigate-to-chat.cjs — Navigate to Notion AI chat and inspect send button
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
    console.log('All tabs:');
    targets.forEach((t, i) => console.log(`  ${i}: ${t.url.substring(0, 80)}`));
    
    // Look for a tab that's already on the chat page
    let notionTab = targets.find(t => t.url.includes('notion.so/chat') || t.url.includes('notion.so/ai'));
    if (!notionTab) {
        // Use the main Notion tab and navigate
        notionTab = targets.find(t => t.url.includes('notion.so'));
    }
    if (!notionTab) { console.log('ERROR: No Notion tab'); process.exit(1); }
    console.log('Using tab:', notionTab.url);

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

    // Navigate to AI chat
    console.log('Navigating to Notion AI chat...');
    await send('Page.navigate', { url: 'https://www.notion.so/chat' });
    await new Promise(r => setTimeout(r, 5000));

    console.log('Step 2: Check current URL...');
    const urlCheck = await send('Runtime.evaluate', {
        expression: 'window.location.href',
        returnByValue: true,
    });
    console.log('Current URL:', val(urlCheck));

    // Wait for chat UI to load
    await new Promise(r => setTimeout(r, 3000));

    // Now type text and look for send button
    console.log('Step 3: Find input and type...');
    const inputCheck = await send('Runtime.evaluate', {
        expression: `(function() {
            const inputs = document.querySelectorAll('div[role="textbox"][contenteditable="true"]');
            const textareas = document.querySelectorAll('textarea');
            return JSON.stringify({
                textboxCount: inputs.length,
                textareaCount: textareas.length,
                firstTextbox: inputs[0] ? {
                    text: inputs[0].textContent?.substring(0, 50),
                    placeholder: inputs[0].getAttribute('placeholder') || inputs[0].getAttribute('data-placeholder') || 'none',
                    class: (inputs[0].className || '').substring(0, 40)
                } : null,
                firstTextarea: textareas[0] ? {
                    text: textareas[0].value?.substring(0, 50),
                    placeholder: textareas[0].placeholder || 'none'
                } : null,
            });
        })()`,
        returnByValue: true,
    });
    console.log('Input check:', val(inputCheck));

    // Type text via CDP Input events  
    const focusResult = await send('Runtime.evaluate', {
        expression: `(function() {
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            if (input) { input.focus(); return 'focused'; }
            const ta = document.querySelector('textarea');
            if (ta) { ta.focus(); return 'focused textarea'; }
            return 'no input found';
        })()`,
        returnByValue: true,
    });
    console.log('Focus:', val(focusResult));

    // Use execCommand to insert text
    await send('Runtime.evaluate', {
        expression: `document.execCommand('insertText', false, 'test message')`,
        returnByValue: true,
    });
    await new Promise(r => setTimeout(r, 2000));

    // NOW search for send button (should appear after text input)
    const finalSearch = await send('Runtime.evaluate', {
        expression: `(function() {
            const results = {};
            
            // All data-testid
            const testIds = [];
            document.querySelectorAll('[data-testid]').forEach(el => {
                testIds.push({ id: el.getAttribute('data-testid'), tag: el.tagName, visible: el.offsetHeight > 0 });
            });
            results.testIds = testIds;
            
            // All visible buttons at bottom of page
            const btns = [];
            document.querySelectorAll('[role="button"], button').forEach(b => {
                const rect = b.getBoundingClientRect();
                if (rect.y > window.innerHeight * 0.6 && rect.width > 0) {
                    btns.push({
                        tag: b.tagName,
                        ariaLabel: b.getAttribute('aria-label') || '',
                        testId: b.getAttribute('data-testid') || '',
                        class: (b.className || '').substring(0, 50),
                        text: (b.textContent || '').trim().substring(0, 30),
                        x: rect.x|0, y: rect.y|0, w: rect.width|0, h: rect.height|0,
                        hasSvg: !!b.querySelector('svg')
                    });
                }
            });
            results.bottomButtons = btns;
            
            // Check for SVG path with "M4 12l1.41..." (common send/arrow icon pattern)
            const allSvgPaths = document.querySelectorAll('svg path');
            const pathInfo = [];
            allSvgPaths.forEach(p => {
                const d = p.getAttribute('d') || '';
                const rect = p.getBoundingClientRect();
                if (rect.y > window.innerHeight * 0.6 && rect.width > 0) {
                    pathInfo.push({ d: d.substring(0, 30), x: rect.x|0, y: rect.y|0 });
                }
            });
            results.bottomSvgPaths = pathInfo;
            
            // Verify input has text
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            results.inputText = input?.textContent?.substring(0, 50) || 'NONE';
            
            return JSON.stringify(results, null, 2);
        })()`,
        returnByValue: true,
    });
    console.log('Final search:', val(finalSearch));

    // Clean up text
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
