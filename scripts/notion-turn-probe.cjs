/**
 * Notion AI Chat — Probe turn/thread structure and user message location.
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

const PROBE_EXPR = `(function() {
    function safeClass(el) {
        var cn = el.className;
        if (typeof cn === 'string') return cn;
        if (cn && cn.baseVal) return cn.baseVal;
        return el.getAttribute('class') || '';
    }
    
    // Find ALL data-content-editable-root elements
    var roots = document.querySelectorAll('[data-content-editable-root]');
    var rootInfo = Array.from(roots).map(function(el) {
        var text = el.textContent || '';
        return {
            tag: el.tagName,
            classPrefix: safeClass(el).substring(0, 40),
            childCount: el.children.length,
            textPreview: text.substring(0, 120),
            textLen: text.length,
        };
    });
    
    // Traverse UP from content root to find the thread/turn container
    var root = document.querySelector('[data-content-editable-root]');
    if (!root) return JSON.stringify({ error: 'no root' });
    
    var ancestors = [];
    var current = root;
    for (var i = 0; i < 15 && current.parentElement; i++) {
        current = current.parentElement;
        var cls = safeClass(current);
        
        // Examine siblings at each level
        var siblingCount = current.parentElement ? current.parentElement.children.length : 0;
        var siblingTags = [];
        if (current.parentElement && siblingCount <= 20) {
            var sibs = current.parentElement.children;
            for (var j = 0; j < sibs.length; j++) {
                var sib = sibs[j];
                var sibCls = safeClass(sib).substring(0, 40);
                var sibText = (sib.textContent || '').substring(0, 60);
                siblingTags.push({
                    index: j,
                    tag: sib.tagName,
                    classPrefix: sibCls,
                    textLen: (sib.textContent || '').length,
                    textPreview: sibText,
                    childCount: sib.children.length,
                    isSelf: sib === current,
                });
            }
        }
        
        ancestors.push({
            level: i + 1,
            tag: current.tagName,
            id: current.id || null,
            classPrefix: cls.substring(0, 60),
            siblingCount: siblingCount,
            siblings: siblingTags,
        });
        
        // Stop at body or recognizable container
        if (current.tagName === 'BODY' || current.id === 'notion-app') break;
    }
    
    // Look for elements with text "You" or user-sent content markers
    // In Notion AI chat, user messages might have a "You" label
    var bodyHTML = document.body.innerHTML;
    var hasYouLabel = bodyHTML.includes('>You<') || bodyHTML.includes('>你<');
    
    // Look for specific Notion AI chat structure
    var chatThreads = document.querySelectorAll('[class*="thread"], [class*="Thread"]');
    var threadInfo = Array.from(chatThreads).slice(0, 5).map(function(el) {
        return {
            tag: el.tagName,
            classPrefix: safeClass(el).substring(0, 60),
            textLen: (el.textContent || '').length,
        };
    });
    
    // Look for "autolayout" elements (Notion's layout system)
    var autolayouts = document.querySelectorAll('[class*="autolayout"]');
    var alInfo = Array.from(autolayouts).slice(0, 10).map(function(el) {
        var text = el.textContent || '';
        return {
            tag: el.tagName,
            classPrefix: safeClass(el).substring(0, 80),
            textLen: text.length,
            childCount: el.children.length,
            textPreview: text.substring(0, 80),
        };
    });
    
    return JSON.stringify({
        contentEditableRoots: rootInfo,
        ancestorChain: ancestors,
        hasYouLabel: hasYouLabel,
        threadContainers: threadInfo,
        autolayouts: alInfo,
    });
})()`;

async function main() {
    console.log('🔍 Notion — Turn/thread structure probe');

    const targets = await getTargets();
    const notion = targets.find(t => t.type === 'page' && t.url.includes('notion.so'));
    if (!notion) { console.error('❌ No Notion tab'); process.exit(1); }

    const ws = new WebSocket(notion.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

    try {
        await cdpSend(ws, 'Runtime.enable');

        const res = await cdpSend(ws, 'Runtime.evaluate', {
            expression: PROBE_EXPR,
            returnByValue: true,
        });

        if (res.result && res.result.value) {
            const data = JSON.parse(res.result.value);
            console.log(JSON.stringify(data, null, 2));
        } else {
            console.log('Error:', JSON.stringify(res, null, 2).substring(0, 500));
        }
    } finally {
        ws.close();
    }
}

main().catch(err => {
    console.error('❌ Fatal:', err.message);
    process.exit(1);
});
