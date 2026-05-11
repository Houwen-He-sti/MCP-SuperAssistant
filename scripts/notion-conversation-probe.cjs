/**
 * Navigate to an existing Notion conversation and probe message DOM.
 */
const http = require('http');
const WebSocket = require('ws');

const CDP_PORT = process.env.CDP_PORT || 9222;

function getTargets() {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${CDP_PORT}/json`, res => {
            let d = '';
            res.on('data', c => (d += c));
            res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
    });
}

function cdpSend(ws, method, params = {}) {
    const id = cdpSend._counter = (cdpSend._counter || 0) + 1;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000);
        const handler = (raw) => {
            const msg = JSON.parse(raw);
            if (msg.id === id) {
                ws.removeListener('message', handler);
                clearTimeout(timer);
                if (msg.error) reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`));
                else resolve(msg.result);
            }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Click first conversation in sidebar, then probe message DOM
const CLICK_CONVERSATION = `(function() {
    // Find conversation items in sidebar menu
    var menuItems = document.querySelectorAll('[role="menuitem"]');
    if (menuItems.length === 0) return JSON.stringify({ error: 'no menu items' });
    
    // Click the first one (should be a conversation)
    var target = menuItems[0];
    var text = target.textContent || '';
    target.click();
    return JSON.stringify({ ok: true, clicked: text.substring(0, 60), totalItems: menuItems.length });
})()`;

const PROBE_MESSAGES = `(function() {
    function safeClass(el) {
        var cn = el.className;
        if (typeof cn === 'string') return cn;
        if (cn && cn.baseVal) return cn.baseVal;
        return el.getAttribute('class') || '';
    }
    
    function safeAttrs(el) {
        var attrs = {};
        for (var i = 0; i < el.attributes.length; i++) {
            var a = el.attributes[i];
            if (a.name !== 'class' && a.name !== 'style') {
                attrs[a.name] = a.value.substring(0, 100);
            }
        }
        return attrs;
    }
    
    // Find all elements that might be messages
    // Look for data-testid, data-message, data-role patterns
    var dataTestIds = document.querySelectorAll('[data-testid]');
    var testIdInfo = Array.from(dataTestIds).map(function(el) {
        return {
            tag: el.tagName,
            testId: el.getAttribute('data-testid'),
            classPrefix: safeClass(el).substring(0, 60),
            textLen: (el.textContent || '').length,
            childCount: el.children.length,
        };
    });
    
    // Look for the main content area (large div with many children)
    var mainArea = null;
    var allDivs = document.querySelectorAll('div');
    for (var i = 0; i < allDivs.length; i++) {
        var d = allDivs[i];
        var s = d.scrollHeight;
        var c = d.clientHeight;
        if (s > 500 && d.children.length > 5) {
            var cls = safeClass(d);
            if (!cls.includes('notion-sidebar') && !cls.includes('notion-app')) {
                if (!mainArea || d.children.length > mainArea.childCount) {
                    mainArea = {
                        tag: 'DIV',
                        classPrefix: cls.substring(0, 80),
                        attrs: safeAttrs(d),
                        childCount: d.children.length,
                        scrollHeight: s,
                        clientHeight: c,
                    };
                }
            }
        }
    }
    
    // Find elements with specific data attributes that suggest messages
    var dataBlocks = document.querySelectorAll('[data-block-id], [data-message-id], [data-turn-id], [data-content-editable-root]');
    var blockInfo = Array.from(dataBlocks).slice(0, 20).map(function(el) {
        return {
            tag: el.tagName,
            attrs: safeAttrs(el),
            classPrefix: safeClass(el).substring(0, 60),
            textPreview: (el.textContent || '').substring(0, 100),
            childCount: el.children.length,
        };
    });
    
    // Try to find message-like divs by looking at text content patterns
    var msgCandidates = [];
    for (var j = 0; j < allDivs.length && msgCandidates.length < 15; j++) {
        var div = allDivs[j];
        var text = div.textContent || '';
        // Skip if too short or too long
        if (text.length < 20 || text.length > 5000) continue;
        // Skip sidebar
        if (safeClass(div).includes('sidebar')) continue;
        var at = safeAttrs(div);
        // Look for divs with data attributes that suggest role/message
        if (at['data-block-id'] || at['data-message-id'] || at['data-testid'] || at['data-turn-id'] || at['role'] === 'article') {
            msgCandidates.push({
                tag: 'DIV',
                attrs: at,
                classPrefix: safeClass(div).substring(0, 60),
                textPreview: text.substring(0, 120),
                childCount: div.children.length,
            });
        }
    }
    
    return JSON.stringify({
        testIds: testIdInfo,
        mainArea: mainArea,
        dataBlocks: blockInfo,
        msgCandidates: msgCandidates,
    });
})()`;

async function main() {
    console.log('🔍 Notion — Navigate to conversation + probe messages');

    const targets = await getTargets();
    const notion = targets.find(t => t.type === 'page' && t.url.includes('notion.so'));
    if (!notion) { console.error('❌ No Notion tab'); process.exit(1); }

    const ws = new WebSocket(notion.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

    try {
        await cdpSend(ws, 'Runtime.enable');

        // Click first conversation
        console.log('\n=== Clicking first conversation ===');
        const clickRes = await cdpSend(ws, 'Runtime.evaluate', {
            expression: CLICK_CONVERSATION,
            returnByValue: true,
        });
        console.log(JSON.parse(clickRes.result.value));

        // Wait for navigation
        await sleep(3000);

        // Probe messages
        console.log('\n=== Probing message DOM ===');
        const probeRes = await cdpSend(ws, 'Runtime.evaluate', {
            expression: PROBE_MESSAGES,
            returnByValue: true,
        });

        if (probeRes.result && probeRes.result.value) {
            const data = JSON.parse(probeRes.result.value);
            console.log(JSON.stringify(data, null, 2));
        } else {
            console.log('Error:', JSON.stringify(probeRes, null, 2).substring(0, 500));
        }

    } finally {
        ws.close();
    }
}

main().catch(err => {
    console.error('❌ Fatal:', err.message);
    process.exit(1);
});
