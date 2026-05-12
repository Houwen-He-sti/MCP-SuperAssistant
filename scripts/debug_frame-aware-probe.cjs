/**
 * Frame-aware CDP probe — enumerates frame tree, all execution contexts,
 * and checks markers/DOM per MAIN context and isolated context.
 * 
 * This is a one-off OO observation script, not a persistent test.
 */

const WebSocket = require('ws');
const http = require('http');

(async () => {
    // Get targets
    const targets = await new Promise((res, rej) => {
        http.get('http://127.0.0.1:9222/json', r => {
            let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
        }).on('error', rej);
    });

    const notionTab = targets.find(t => t.url.includes('notion.so'));
    if (!notionTab) { console.log('No Notion tab found'); process.exit(1); }
    console.log('Tab URL:', notionTab.url);

    const ws = new WebSocket(notionTab.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));

    let msgId = 0;
    const send = (method, params) => new Promise((resolve, reject) => {
        const myId = ++msgId;
        const timeout = setTimeout(() => reject(new Error('timeout: ' + method)), 10000);
        const handler = raw => {
            const obj = JSON.parse(raw);
            if (obj.id === myId) { clearTimeout(timeout); ws.off('message', handler); resolve(obj); }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
    });

    // ── Frame Tree ──
    console.log('\n=== FRAME TREE ===');
    const frameTreeResult = await send('Page.getFrameTree');
    const printFrame = (node, indent) => {
        indent = indent || 0;
        const f = node.frame;
        console.log(' '.repeat(indent) + 'Frame: id=' + f.id + ', url=' + f.url.slice(0, 120));
        console.log(' '.repeat(indent) + '  name=' + (f.name || '(none)') + ', securityOrigin=' + f.securityOrigin);
        if (node.childFrames) {
            for (const child of node.childFrames) { printFrame(child, indent + 4); }
        }
    };
    printFrame(frameTreeResult.result.frameTree);

    // ── Execution Contexts ──
    console.log('\n=== EXECUTION CONTEXTS ===');
    const contexts = [];
    ws.on('message', raw => {
        const obj = JSON.parse(raw);
        if (obj.method === 'Runtime.executionContextCreated') {
            contexts.push(obj.params.context);
        }
    });
    await send('Runtime.enable');
    await new Promise(r => setTimeout(r, 1500));

    for (const ctx of contexts) {
        var ctxName = ctx.name || '';
        var ctxOrigin = ctx.origin || '';
        var auxData = ctx.auxData || {};
        console.log('Context id=' + ctx.id + ', name="' + ctxName + '", origin=' + ctxOrigin);
        console.log('  auxData:', JSON.stringify(auxData));
    }

    // ── Per-context MAIN world markers ──
    console.log('\n=== PER-CONTEXT MARKERS (MAIN world, notion.so) ===');
    for (const ctx of contexts) {
        if (!ctx.origin) continue;
        if (ctx.origin.indexOf('notion.so') === -1) continue;
        var aux = ctx.auxData || {};
        if (aux.type === 'isolated') continue;

        try {
            var r = await send('Runtime.evaluate', {
                contextId: ctx.id,
                expression: [
                    'JSON.stringify({',
                    '  href: location.href,',
                    '  pathname: location.pathname,',
                    '  isTop: window.top === window,',
                    '  installKey: !!window["__MCP_SA_NOTION_STREAM_INTERCEPTOR_INSTALLED_V1__"],',
                    '  fetchWrapped: !!window.fetch && !!window.fetch.__mcpSaWrapped,',
                    '  fetchIsNative: window.fetch && window.fetch.toString().indexOf("[native code]") !== -1,',
                    '  chatInput: !!document.querySelector("div[role=textbox][contenteditable=true]"),',
                    '  submitBtn: !!document.querySelector("[data-testid=agent-send-message-button]"),',
                    '  notionAppInner: !!document.querySelector(".notion-app-inner"),',
                    '  readyState: document.readyState',
                    '})',
                ].join('\n'),
                returnByValue: true
            });
            var val = r.result && r.result.result && r.result.result.value;
            if (val) {
                console.log('Context ' + ctx.id + ':', JSON.stringify(JSON.parse(val), null, 2));
            }
        } catch (e) {
            console.log('Context ' + ctx.id + ': eval error -', e.message);
        }
    }

    // ── Isolated contexts ──
    console.log('\n=== ISOLATED CONTEXT CHECK ===');
    for (const ctx of contexts) {
        var aux2 = ctx.auxData || {};
        if (aux2.type !== 'isolated') continue;
        try {
            var r2 = await send('Runtime.evaluate', {
                contextId: ctx.id,
                expression: [
                    'JSON.stringify({',
                    '  href: location.href,',
                    '  mcpClient: typeof window.mcpClient !== "undefined",',
                    '  mcpClientReady: (window.mcpClient && typeof window.mcpClient.isReady === "function") ? window.mcpClient.isReady() : false,',
                    '  rootEl: !!document.getElementById("mcp-superassistant-root"),',
                    '  sidebarHost: !!document.getElementById("mcp-sidebar-shadow-host")',
                    '})',
                ].join('\n'),
                returnByValue: true
            });
            var val2 = r2.result && r2.result.result && r2.result.result.value;
            if (val2) {
                console.log('Isolated Context ' + ctx.id + ':', JSON.stringify(JSON.parse(val2), null, 2));
            }
        } catch (e) {
            console.log('Isolated Context ' + ctx.id + ': eval error -', e.message);
        }
    }

    await send('Runtime.disable');
    ws.close();
})();
