/**
 * Quick check: does current Notion conversation contain function_results?
 */
const http = require('http');
const WebSocket = require('ws');

async function main() {
    const targets = await new Promise((r, e) => http.get('http://127.0.0.1:9222/json', res => { let d = ''; res.on('data', c => d += c); res.on('end', () => r(JSON.parse(d))); }).on('error', e));
    const notion = targets.find(t => t.type === 'page' && t.url.includes('notion.so'));
    if (!notion) { console.log('No Notion tab'); return; }

    const ws = new WebSocket(notion.webSocketDebuggerUrl);
    await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });

    function cdpSend(id, method, params) {
        return new Promise((r, e) => {
            const timer = setTimeout(() => e(new Error('timeout')), 10000);
            const handler = raw => {
                const msg = JSON.parse(raw);
                if (msg.id === id) { ws.removeListener('message', handler); clearTimeout(timer); r(msg.result); }
            };
            ws.on('message', handler);
            ws.send(JSON.stringify({ id, method, params }));
        });
    }

    await cdpSend(1, 'Runtime.enable', {});

    const expr = `(function(){
        var bodyText = document.body.textContent || '';
        var hasFR = bodyText.includes('<function_results') || bodyText.includes('<function_result ');
        var c = document.querySelector('.notion-selectable-container');
        var containerInfo = null;
        if (c) {
            containerInfo = {
                childCount: c.children.length,
                firstChildTag: c.children[0] ? c.children[0].tagName : null,
                firstChildChildCount: c.children[0] ? c.children[0].children.length : 0,
            };
            // Check deeper for turn lanes
            var allDivs = c.querySelectorAll('div');
            var multiChildDivs = [];
            for (var i = 0; i < allDivs.length; i++) {
                var d = allDivs[i];
                if (d.children.length >= 4) {
                    multiChildDivs.push({
                        childCount: d.children.length,
                        classes: d.className.substring(0, 50),
                    });
                }
            }
            containerInfo.multiChildDivs = multiChildDivs.slice(0, 5);
        }
        return JSON.stringify({
            hasFunctionResults: hasFR,
            bodyTextLen: bodyText.length,
            containerInfo: containerInfo,
            url: window.location.href.substring(0, 80),
        });
    })()`;

    const res = await cdpSend(2, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    if (res.result && res.result.value) {
        const data = JSON.parse(res.result.value);
        console.log(JSON.stringify(data, null, 2));
    }
    ws.close();
}

main().catch(e => console.error(e.message));
