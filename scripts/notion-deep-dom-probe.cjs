/**
 * Deep Notion AI Chat DOM observation probe.
 * Explores the actual DOM structure to find stable selectors for user messages.
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

// Phase 1: Explore overall structure
const PHASE1_EXPRESSION = `(function() {
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
            if (a.name.startsWith('data-') || a.name === 'role' || a.name === 'aria-label' || a.name === 'contenteditable') {
                attrs[a.name] = a.value.substring(0, 80);
            }
        }
        return attrs;
    }
    
    // Find all elements with data- attributes (stable selectors)
    var dataEls = document.querySelectorAll('[data-testid], [data-type], [data-role], [data-message-id], [data-block-id], [role="listbox"], [role="list"], [role="listitem"], [role="log"], [role="dialog"]');
    var dataInfo = Array.from(dataEls).slice(0, 30).map(function(el) {
        return {
            tag: el.tagName,
            attrs: safeAttrs(el),
            childCount: el.children.length,
            textLen: (el.textContent || '').length,
        };
    });
    
    // Find elements with role attribute
    var roleEls = document.querySelectorAll('[role]');
    var roles = Array.from(roleEls).slice(0, 30).map(function(el) {
        return {
            tag: el.tagName,
            role: el.getAttribute('role'),
            classPrefix: safeClass(el).substring(0, 40),
            childCount: el.children.length,
        };
    });
    
    // Find contenteditable areas (chat input)
    var editables = document.querySelectorAll('[contenteditable]');
    var editableInfo = Array.from(editables).slice(0, 10).map(function(el) {
        return {
            tag: el.tagName,
            editable: el.getAttribute('contenteditable'),
            classPrefix: safeClass(el).substring(0, 60),
            attrs: safeAttrs(el),
            textLen: (el.textContent || '').length,
        };
    });
    
    // Find elements with aria-label (semantic markers)
    var ariaEls = document.querySelectorAll('[aria-label]');
    var ariaInfo = Array.from(ariaEls).slice(0, 20).map(function(el) {
        return {
            tag: el.tagName,
            label: el.getAttribute('aria-label'),
            role: el.getAttribute('role'),
            classPrefix: safeClass(el).substring(0, 40),
        };
    });
    
    return JSON.stringify({
        url: location.href,
        title: document.title,
        dataElements: dataInfo,
        roles: roles,
        editables: editableInfo,
        ariaLabels: ariaInfo,
    });
})()`;

// Phase 2: Look specifically at chat bubble structure
const PHASE2_EXPRESSION = `(function() {
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
                attrs[a.name] = a.value.substring(0, 80);
            }
        }
        return attrs;
    }
    
    // Find divs containing "chatBubble" SVGs (found in Phase 1)
    var chatBubbles = document.querySelectorAll('svg');
    var bubbleParents = [];
    for (var i = 0; i < chatBubbles.length; i++) {
        var svg = chatBubbles[i];
        var cls = svg.getAttribute('class') || '';
        if (cls.includes('chatBubble')) {
            var parent = svg.parentElement;
            var grandparent = parent ? parent.parentElement : null;
            var greatGrandparent = grandparent ? grandparent.parentElement : null;
            bubbleParents.push({
                svgClass: cls.substring(0, 40),
                parent: parent ? {
                    tag: parent.tagName,
                    attrs: safeAttrs(parent),
                    classPrefix: safeClass(parent).substring(0, 60),
                } : null,
                grandparent: grandparent ? {
                    tag: grandparent.tagName,
                    attrs: safeAttrs(grandparent),
                    classPrefix: safeClass(grandparent).substring(0, 60),
                    childCount: grandparent.children.length,
                } : null,
                greatGrandparent: greatGrandparent ? {
                    tag: greatGrandparent.tagName,
                    attrs: safeAttrs(greatGrandparent),
                    classPrefix: safeClass(greatGrandparent).substring(0, 60),
                } : null,
            });
        }
    }
    
    // Look for the main chat container (scrollable area with messages)
    var scrollables = document.querySelectorAll('[style*="overflow"]');
    var scrollInfo = Array.from(scrollables).slice(0, 10).map(function(el) {
        return {
            tag: el.tagName,
            attrs: safeAttrs(el),
            classPrefix: safeClass(el).substring(0, 60),
            childCount: el.children.length,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
        };
    });
    
    // Look for message-like containers with text content
    var allDivs = document.querySelectorAll('div');
    var textContainers = [];
    for (var j = 0; j < allDivs.length && textContainers.length < 20; j++) {
        var div = allDivs[j];
        var text = div.textContent || '';
        // Find divs that look like chat messages (have text, not too many children)
        if (text.length > 50 && text.length < 2000 && div.children.length < 20) {
            var cls2 = safeClass(div);
            // Skip obvious non-message containers
            if (cls2.includes('notion-app') || cls2.includes('notion-sidebar') || cls2.includes('notion-overlay')) continue;
            var attrs2 = safeAttrs(div);
            if (Object.keys(attrs2).length > 0) {
                textContainers.push({
                    tag: 'DIV',
                    attrs: attrs2,
                    classPrefix: cls2.substring(0, 60),
                    textPreview: text.substring(0, 80),
                    childCount: div.children.length,
                });
            }
        }
    }
    
    return JSON.stringify({
        chatBubbleParents: bubbleParents.slice(0, 5),
        scrollableAreas: scrollInfo,
        textContainers: textContainers,
    });
})()`;

async function main() {
    console.log('🔍 Notion AI Chat — Deep DOM Observation');
    console.log();

    const targets = await getTargets();
    const notion = targets.find(t => t.type === 'page' && t.url.includes('notion.so'));
    if (!notion) {
        console.error('❌ No Notion tab found.');
        process.exit(1);
    }
    console.log('Notion URL:', notion.url.substring(0, 80));

    const ws = new WebSocket(notion.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    try {
        await cdpSend(ws, 'Runtime.enable');

        // Phase 1
        console.log('\n=== Phase 1: Overall Structure ===\n');
        const r1 = await cdpSend(ws, 'Runtime.evaluate', {
            expression: PHASE1_EXPRESSION,
            returnByValue: true,
        });
        if (r1.result && r1.result.value) {
            const d1 = JSON.parse(r1.result.value);
            console.log(JSON.stringify(d1, null, 2));
        } else {
            console.log('Phase 1 error:', JSON.stringify(r1, null, 2).substring(0, 500));
        }

        // Phase 2
        console.log('\n=== Phase 2: Chat Bubble Structure ===\n');
        const r2 = await cdpSend(ws, 'Runtime.evaluate', {
            expression: PHASE2_EXPRESSION,
            returnByValue: true,
        });
        if (r2.result && r2.result.value) {
            const d2 = JSON.parse(r2.result.value);
            console.log(JSON.stringify(d2, null, 2));
        } else {
            console.log('Phase 2 error:', JSON.stringify(r2, null, 2).substring(0, 500));
        }

    } finally {
        ws.close();
    }
}

main().catch(err => {
    console.error('❌ Fatal:', err.message);
    process.exit(1);
});
