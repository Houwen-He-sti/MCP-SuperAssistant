// Observe workspace switcher on current Notion page
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

    // 1. Check current workspace indicator
    const wsInfo = await send('Runtime.evaluate', {
        expression: `(function() {
            // Check sidebar switcher
            const switcher = document.querySelector('.notion-sidebar-switcher');
            
            // Also look for workspace name in sidebar header
            const sidebarHeader = document.querySelector('[class*="sidebar"] [class*="header"]');
            
            // Look for the "S" icon or workspace initial
            const bodyText = document.body.innerText;
            
            // Current URL to determine workspace
            const url = window.location.href;
            
            return JSON.stringify({
                url,
                hasSwitcher: !!switcher,
                switcherText: switcher ? switcher.textContent.substring(0, 50) : null,
                switcherRect: switcher ? {
                    x: Math.round(switcher.getBoundingClientRect().x),
                    y: Math.round(switcher.getBoundingClientRect().y),
                    w: Math.round(switcher.getBoundingClientRect().width),
                    h: Math.round(switcher.getBoundingClientRect().height),
                } : null,
                // Get first few lines of body to see workspace name
                firstLines: bodyText.split('\\n').slice(0, 10).join(' | '),
            });
        })()`,
        returnByValue: true,
    });
    console.log('Workspace info:', val(wsInfo));

    // 2. Try clicking the workspace switcher to see the menu
    console.log('\n--- Clicking workspace switcher ---');
    const switcherClick = await send('Runtime.evaluate', {
        expression: `(function() {
            var sw = document.querySelector('.notion-sidebar-switcher');
            if (sw) { sw.click(); return 'clicked'; }
            return 'not_found';
        })()`,
        returnByValue: true,
    });
    console.log('Switcher click:', val(switcherClick));

    // Wait for menu to appear
    await new Promise(r => setTimeout(r, 1500));

    // 3. Check menu items
    const menuItems = await send('Runtime.evaluate', {
        expression: `(function() {
            var items = document.querySelectorAll('[role="menuitem"]');
            var result = [];
            for (var i = 0; i < items.length; i++) {
                var text = items[i].textContent.trim().substring(0, 80);
                result.push({
                    text: text,
                    hasHouwen: text.includes('houwen'),
                    hasSjzj030: text.includes('sjzj030'),
                });
            }
            return JSON.stringify(result);
        })()`,
        returnByValue: true,
    });

    const items = JSON.parse(val(menuItems));
    console.log(`\nMenu items (${items.length}):`);
    items.forEach(item => {
        let marker = '';
        if (item.hasSjzj030) marker = ' ← TARGET';
        if (item.hasHouwen) marker = ' ← CURRENT (wrong)';
        console.log(`  "${item.text}"${marker}`);
    });

    // 4. Close menu (press Escape)
    await send('Runtime.evaluate', {
        expression: `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))`,
        returnByValue: true,
    });

    ws.close();
})();
