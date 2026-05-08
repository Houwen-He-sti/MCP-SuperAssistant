// Reload MCP-SuperAssistant extension and verify fix.
// Uses cdp-preflight to discover extension by name (P23/P24).
const WebSocket = require('ws');
const { resolveExtensionId, ensureAgentPage, getTargets, sleep } = require('./lib/cdp-preflight.cjs');

(async () => {
    // --- Step 1: Discover extension by name (not hardcoded ID) ---
    console.log('🔍 Discovering MCP-SuperAssistant...');
    const ext = await resolveExtensionId('MCP SuperAssistant');
    console.log(`✅ Found: ${ext.name} (${ext.extensionId})`);

    // --- Step 2: Check interceptor file content ---
    const ws1 = new WebSocket(ext.wsUrl);
    await new Promise(r => ws1.on('open', r));

    let id1 = 0;
    function send1(m, p) {
        return new Promise(r => {
            const i = ++id1;
            const h = msg => { const o = JSON.parse(msg); if (o.id === i) { ws1.off('message', h); r(o); } };
            ws1.on('message', h);
            ws1.send(JSON.stringify({ id: i, method: m, params: p || {} }));
        });
    }

    const fileCheck = await send1('Runtime.evaluate', {
        expression: `(async () => {
      try {
        const url = chrome.runtime.getURL('content/stream-interceptor-main.iife.js');
        const resp = await fetch(url);
        const text = await resp.text();
        const hasAFix = text.includes('"a"===');
        return JSON.stringify({ hasAFix, length: text.length, snippet200: text.substring(0, 200) });
      } catch(e) { return JSON.stringify({ error: e.message }); }
    })()`,
        awaitPromise: true
    });
    console.log('Interceptor file:', fileCheck.result?.result?.value);

    // --- Step 3: Reload extension ---
    console.log('\nReloading MCP-SuperAssistant...');
    ws1.send(JSON.stringify({
        id: ++id1,
        method: 'Runtime.evaluate',
        params: { expression: 'chrome.runtime.reload()' }
    }));
    await sleep(3000);
    try { ws1.close(); } catch { }

    console.log('Waiting 5s...');
    await sleep(5000);

    // --- Step 4: Re-verify after reload ---
    const ext2 = await resolveExtensionId('MCP SuperAssistant');
    console.log('MCP-SA SW after reload:', ext2.extensionId);

    const ws2 = new WebSocket(ext2.wsUrl);
    await new Promise(r => ws2.on('open', r));

    let id2 = 0;
    function send2(m, p) {
        return new Promise(r => {
            const i = ++id2;
            const h = msg => { const o = JSON.parse(msg); if (o.id === i) { ws2.off('message', h); r(o); } };
            ws2.on('message', h);
            ws2.send(JSON.stringify({ id: i, method: m, params: p || {} }));
        });
    }

    const fileCheck2 = await send2('Runtime.evaluate', {
        expression: `(async () => {
      try {
        const url = chrome.runtime.getURL('content/stream-interceptor-main.iife.js');
        const resp = await fetch(url);
        const text = await resp.text();
        const hasAFix = text.includes('"a"===');
        return JSON.stringify({ hasAFix, length: text.length });
      } catch(e) { return JSON.stringify({ error: e.message }); }
    })()`,
        awaitPromise: true
    });
    console.log('After reload:', fileCheck2.result?.result?.value);
    ws2.close();

    // --- Step 5: Ensure agent page (P25) ---
    const page = await ensureAgentPage();
    console.log(`Page: ${page.url.slice(0, 80)}${page.navigated ? ' (navigated)' : ' (already on agent page)'}`);

    console.log('Done. Run the E2E test now.');
    process.exit();
})().catch(e => { console.error(e); process.exit(1); });
