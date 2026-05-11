/**
 * Notion AI Chat — Probe user vs AI message structure.
 * We found the content root, now need to understand message boundaries.
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

// Probe the structure: look for turn markers, user/AI separation
const PROBE_EXPR = `(function() {
    function safeClass(el) {
        var cn = el.className;
        if (typeof cn === 'string') return cn;
        if (cn && cn.baseVal) return cn.baseVal;
        return el.getAttribute('class') || '';
    }
    
    // Find the content root
    var root = document.querySelector('[data-content-editable-root]');
    if (!root) return JSON.stringify({ error: 'no content root' });
    
    // Examine all direct children of content root
    var children = root.children;
    var childInfo = [];
    for (var i = 0; i < children.length && i < 50; i++) {
        var ch = children[i];
        var cls = safeClass(ch);
        var blockId = ch.getAttribute('data-block-id');
        var text = (ch.textContent || '').substring(0, 100);
        
        // Check for turn/role markers
        var hasTurnMarker = false;
        var turnRole = null;
        
        // Check all inner elements for role indicators
        var innerEls = ch.querySelectorAll('[data-turn-role], [data-role], [data-author], [class*="user"], [class*="assistant"], [class*="human"]');
        var innerInfo = Array.from(innerEls).map(function(el) {
            return {
                tag: el.tagName,
                attrs: Object.fromEntries(Array.from(el.attributes).filter(function(a) { return a.name.startsWith('data-') || a.name === 'role'; }).map(function(a) { return [a.name, a.value]; })),
            };
        });
        
        // Check for separator/divider elements
        var isSeparator = cls.includes('divider') || cls.includes('separator') || cls.includes('hr') || ch.tagName === 'HR';
        
        // Check for chat turn containers
        var isTurn = cls.includes('turn') || cls.includes('message') || cls.includes('chat');
        
        childInfo.push({
            index: i,
            tag: ch.tagName,
            classPrefix: cls.substring(0, 80),
            blockId: blockId ? blockId.substring(0, 36) : null,
            textPreview: text,
            childCount: ch.children.length,
            isSeparator: isSeparator,
            isTurn: isTurn,
            innerRoles: innerInfo.length > 0 ? innerInfo : undefined,
            // Check if this looks like a user message (typically shorter, has specific styling)
            hasNotionText: cls.includes('notion-text-block'),
            hasNotionBullet: cls.includes('notion-bulleted'),
            hasNotionNumbered: cls.includes('notion-numbered'),
            hasNotionCode: cls.includes('notion-code'),
            hasNotionToggle: cls.includes('notion-toggle'),
            hasNotionDivider: cls.includes('notion-divider') || cls.includes('notion-hr'),
        });
    }
    
    // Also look for the parent structure above content root
    var parent = root.parentElement;
    var grandparent = parent ? parent.parentElement : null;
    
    var parentInfo = parent ? {
        tag: parent.tagName,
        classPrefix: safeClass(parent).substring(0, 80),
        childCount: parent.children.length,
    } : null;
    
    var gpInfo = grandparent ? {
        tag: grandparent.tagName,
        classPrefix: safeClass(grandparent).substring(0, 80),
        childCount: grandparent.children.length,
    } : null;
    
    // Look for turn containers above or around content root
    var turnContainers = document.querySelectorAll('[class*="turn"], [class*="Turn"], [data-turn], [data-message-author]');
    var turnInfo = Array.from(turnContainers).slice(0, 10).map(function(el) {
        return {
            tag: el.tagName,
            classPrefix: safeClass(el).substring(0, 60),
            textPreview: (el.textContent || '').substring(0, 60),
        };
    });
    
    // Check for user avatar/icon elements that mark message boundaries
    var avatars = document.querySelectorAll('[class*="avatar"], [class*="Avatar"], img[alt*="user"], img[alt*="User"]');
    var avatarInfo = Array.from(avatars).slice(0, 10).map(function(el) {
        return {
            tag: el.tagName,
            classPrefix: safeClass(el).substring(0, 60),
            alt: el.getAttribute('alt'),
        };
    });
    
    return JSON.stringify({
        rootClass: safeClass(root).substring(0, 80),
        rootChildCount: children.length,
        parentInfo: parentInfo,
        grandparentInfo: gpInfo,
        children: childInfo,
        turnContainers: turnInfo,
        avatars: avatarInfo,
    });
})()`;

async function main() {
    console.log('🔍 Notion — User vs AI message structure probe');

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
