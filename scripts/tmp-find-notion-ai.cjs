// Observe ALL Notion tabs in detail to find the correct Notion AI page
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

    // All page-type targets
    const pages = targets.filter(t => t.type === 'page');
    console.log(`=== ALL PAGE TARGETS (${pages.length}) ===`);
    pages.forEach((t, i) => {
        console.log(`\n[${i}] title: ${t.title}`);
        console.log(`    url: ${t.url}`);
        console.log(`    type: ${t.type}`);
    });

    // Find ALL notion tabs
    const notionTabs = pages.filter(t => /notion\.so/.test(t.url) && !/sw\.js|_assets|wasm/.test(t.url));
    console.log(`\n\n=== NOTION PAGE TABS (${notionTabs.length}) ===`);

    for (const tab of notionTabs) {
        console.log(`\n--- Tab: ${tab.url} ---`);
        console.log(`Title: ${tab.title}`);

        try {
            const ws = new WebSocket(tab.webSocketDebuggerUrl);
            await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });

            let msgId = 0;
            function send(method, params) {
                return new Promise((resolve, reject) => {
                    const id = ++msgId;
                    const timer = setTimeout(() => reject(new Error('timeout')), 10000);
                    function handler(msg) {
                        const obj = JSON.parse(msg);
                        if (obj.id === id) { clearTimeout(timer); ws.off('message', handler); resolve(obj); }
                    }
                    ws.on('message', handler);
                    ws.send(JSON.stringify({ id, method, params: params || {} }));
                });
            }

            await send('Runtime.enable');

            // Get page details
            const r = await send('Runtime.evaluate', {
                expression: `(function() {
                    // Check for AI face icon
                    const aiGif = document.querySelector('img[alt="Notion AI face"]');
                    const plugIcon = document.querySelector('img[src*="customAgentAvatars"]');
                    
                    // Check for input
                    const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
                    
                    // Check title / heading
                    const heading = document.querySelector('h1, h2, [class*="title"]');
                    
                    // Check agent selector / list
                    const agentButtons = document.querySelectorAll('[data-testid*="agent"], [class*="agent"]');
                    
                    return JSON.stringify({
                        url: window.location.href,
                        title: document.title,
                        hasAiFace: !!aiGif,
                        hasPlugIcon: !!plugIcon,
                        plugIconSrc: plugIcon ? plugIcon.src : null,
                        hasInput: !!input,
                        headingText: heading ? heading.textContent : null,
                        bodyPreview: document.body.innerText.substring(0, 300),
                    });
                })()`,
                returnByValue: true,
            });

            const info = JSON.parse(r.result?.result?.value || '{}');
            console.log('Has Notion AI face:', info.hasAiFace);
            console.log('Has plug icon:', info.hasPlugIcon);
            if (info.plugIconSrc) console.log('Plug icon src:', info.plugIconSrc);
            console.log('Has input:', info.hasInput);
            console.log('Heading:', info.headingText);
            console.log('Body preview:', info.bodyPreview?.substring(0, 200));

            ws.close();
        } catch (e) {
            console.log('Error connecting:', e.message);
        }
    }
})();
