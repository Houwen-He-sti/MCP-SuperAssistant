// Find the correct URL for a new Notion AI chat (NOT custom agent)
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

    // 1. Find all links/buttons in sidebar that could be "new chat" for Notion AI
    const sidebarInfo = await send('Runtime.evaluate', {
        expression: `(function() {
            // Look for sidebar nav links
            const allLinks = Array.from(document.querySelectorAll('a[href]'));
            const relevantLinks = allLinks
                .filter(a => /chat|agent|ai/i.test(a.href) || /chat|agent|ai|notion/i.test(a.textContent))
                .map(a => ({
                    href: a.href,
                    text: a.textContent.trim().substring(0, 50),
                    ariaLabel: a.getAttribute('aria-label'),
                    testId: a.getAttribute('data-testid'),
                }));

            // Look for buttons that say "new" or "Notion AI"
            const allButtons = Array.from(document.querySelectorAll('button, [role="button"], [class*="button"]'));
            const relevantButtons = allButtons
                .filter(b => /new|新|notion ai|对话/i.test(b.textContent) || /new|create|chat/i.test(b.getAttribute('data-testid') || ''))
                .map(b => ({
                    text: b.textContent.trim().substring(0, 50),
                    testId: b.getAttribute('data-testid'),
                    ariaLabel: b.getAttribute('aria-label'),
                    tag: b.tagName,
                    rect: JSON.parse(JSON.stringify(b.getBoundingClientRect())),
                }));

            // Check for Notion AI image/icon
            const aiIcons = Array.from(document.querySelectorAll('img[alt*="Notion AI"], img[src*="160f5613"]'));
            const aiIconInfo = aiIcons.map(img => ({
                src: img.src,
                alt: img.alt,
                parentTag: img.parentElement?.tagName,
                parentHref: img.closest('a')?.href,
                parentTestId: img.closest('[data-testid]')?.getAttribute('data-testid'),
            }));

            // Check sidebar structure  
            const sidebar = document.querySelector('[class*="sidebar"], nav, [role="navigation"]');
            
            return JSON.stringify({
                relevantLinks: relevantLinks.slice(0, 20),
                relevantButtons: relevantButtons.slice(0, 10),
                aiIcons: aiIconInfo,
                hasSidebar: !!sidebar,
                currentUrl: window.location.href,
            });
        })()`,
        returnByValue: true,
    });

    const info = JSON.parse(val(sidebarInfo));
    console.log('Current URL:', info.currentUrl);
    console.log('\n=== RELEVANT LINKS ===');
    info.relevantLinks.forEach(l => console.log(`  href: ${l.href}\n  text: "${l.text}"\n  testId: ${l.testId}\n  ariaLabel: ${l.ariaLabel}\n`));
    console.log('\n=== RELEVANT BUTTONS ===');
    info.relevantButtons.forEach(b => console.log(`  text: "${b.text}"\n  testId: ${b.testId}\n  ariaLabel: ${b.ariaLabel}\n  tag: ${b.tag}\n`));
    console.log('\n=== AI ICONS ===');
    info.aiIcons.forEach(i => console.log(`  src: ${i.src}\n  alt: ${i.alt}\n  parentHref: ${i.parentHref}\n  parentTestId: ${i.parentTestId}\n`));

    // 2. Also check if there's a "Notion AI" button in the sidebar specifically
    const sidebarNotionAI = await send('Runtime.evaluate', {
        expression: `(function() {
            // Find any clickable element containing "Notion AI" text
            const els = Array.from(document.querySelectorAll('*'));
            const matches = els.filter(el => {
                const text = el.textContent?.trim();
                return text === 'Notion AI' && el.children.length < 3;
            });
            return JSON.stringify(matches.map(el => ({
                tag: el.tagName,
                text: el.textContent.trim(),
                className: el.className?.substring?.(0, 80),
                href: el.href || el.closest('a')?.href,
                testId: el.getAttribute('data-testid') || el.closest('[data-testid]')?.getAttribute('data-testid'),
                clickable: el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button',
                rect: el.getBoundingClientRect() ? {x: Math.round(el.getBoundingClientRect().x), y: Math.round(el.getBoundingClientRect().y), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height)} : null,
            })).slice(0, 10));
        })()`,
        returnByValue: true,
    });

    console.log('\n=== Elements with text "Notion AI" ===');
    JSON.parse(val(sidebarNotionAI)).forEach(el => console.log(JSON.stringify(el, null, 2)));

    ws.close();
})();
