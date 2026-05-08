/**
 * Gate 4: Auto-submit format B via DOM click and verify AI consumption.
 * 
 * Uses DOM click on Notion's send button instead of adapter.submitForm()
 * to avoid the emitExecutionFailed binding issue.
 */

const WebSocket = require('ws');

const CDP_PORT = 9222;
const TIMEOUT_MS = 10000;

async function main() {
    const resp = await fetch(`http://localhost:${CDP_PORT}/json`);
    const tabs = await resp.json();
    const notionTab = tabs.find(t => t.type === 'page' && t.url && t.url.includes('notion.so'));
    if (!notionTab) { console.log('No Notion tab'); process.exit(2); }
    console.log('Tab:', notionTab.url.slice(0, 60));

    const ws = new WebSocket(notionTab.webSocketDebuggerUrl);
    let msgId = 0;
    const listeners = new Map();
    const contexts = [];

    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.id && listeners.has(msg.id)) {
            listeners.get(msg.id)(msg);
            listeners.delete(msg.id);
        }
        if (msg.method === 'Runtime.executionContextCreated') {
            contexts.push(msg.params.context);
        }
    });

    await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });

    function send(method, params = {}) {
        return new Promise(resolve => {
            const id = ++msgId;
            listeners.set(id, resolve);
            ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
                if (listeners.has(id)) { listeners.delete(id); resolve({ error: 'timeout' }); }
            }, TIMEOUT_MS);
        });
    }

    async function evalMain(expression, opts = {}) {
        const params = { expression, returnByValue: true, awaitPromise: opts.awaitPromise || false, ...opts };
        const result = await send('Runtime.evaluate', params);
        return result.result?.result;
    }

    async function evalIso(expression, opts = {}) {
        const params = { expression, returnByValue: true, awaitPromise: opts.awaitPromise || false, contextId: isoCtx, ...opts };
        const result = await send('Runtime.evaluate', params);
        return result.result?.result;
    }

    await send('Runtime.enable');
    await new Promise(r => setTimeout(r, 1500));

    // Find ISOLATED world
    let isoCtx = null;
    for (const ctx of contexts) {
        if (ctx.name === 'MCP SuperAssistant') {
            const check = await send('Runtime.evaluate', {
                contextId: ctx.id,
                expression: "typeof window.pluginRegistry !== 'undefined'",
                returnByValue: true,
            });
            if (check.result?.result?.value === true) { isoCtx = ctx.id; break; }
        }
    }
    if (!isoCtx) { console.log('No ISOLATED world'); ws.close(); process.exit(2); }
    console.log('ISOLATED world:', isoCtx);

    const sentinel = 'sentinel_g4_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    console.log('Sentinel:', sentinel);

    // Step 1: Clear input (MAIN world)
    console.log('1. Clearing input...');
    await evalMain(`(async function() {
    const sel = 'div[role="textbox"][contenteditable="true"]';
    const el = document.querySelector(sel);
    if (el) {
      el.focus();
      const s = window.getSelection();
      if (s) { const r = document.createRange(); r.selectNodeContents(el); s.removeAllRanges(); s.addRange(r); }
      document.execCommand('delete', false);
    }
  })()`, { awaitPromise: true });
    await new Promise(r => setTimeout(r, 500));

    // Step 2: Insert Format B via ISOLATED world
    console.log('2. Inserting Format B...');
    const formatB = `<function_results>\n  <result call_id="probe_b" name="echo" status="success">\n    <content type="application/json"><![CDATA[\n{"message":"${sentinel}"}\n    ]]></content>\n  </result>\n</function_results>`;

    const insertRes = await evalIso(`(async function() {
    const text = ${JSON.stringify(formatB)};
    let adapter = null;
    const reg = window.pluginRegistry;
    if (reg && reg.getActivePlugin) { const p = reg.getActivePlugin(); if (p && p.adapter) adapter = p.adapter; }
    if (!adapter && window.mcpAdapter) adapter = window.mcpAdapter;
    if (adapter && typeof adapter.insertText === 'function') {
      try { await adapter.insertText(text); return { ok: true }; }
      catch (e) { return { ok: true, threw: e.message }; }
    }
    return { ok: false, error: 'no adapter' };
  })()`, { awaitPromise: true });
    console.log('   Insert:', JSON.stringify(insertRes?.value));

    await new Promise(r => setTimeout(r, 300));
    const content = await evalMain(`(function() {
    const el = document.querySelector('div[role="textbox"][contenteditable="true"]');
    return el ? el.textContent.slice(0, 100) : null;
  })()`);
    console.log('   Input preview:', content?.value);

    // Step 3: Submit via DOM click (MAIN world)
    console.log('3. Submitting via DOM click...');
    const submitRes = await evalMain(`(function() {
    // Use Notion's actual send button selector
    const btn = document.querySelector('[data-testid="agent-send-message-button"]');
    if (btn) {
      btn.click();
      return { method: 'sendButton', ok: true };
    }
    // Fallback: Enter key
    const textbox = document.querySelector('div[role="textbox"][contenteditable="true"]');
    if (textbox) {
      textbox.focus();
      textbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      return { method: 'enter', ok: true };
    }
    return { method: 'none', error: 'No submit method found' };
  })()`, { awaitPromise: false });
    console.log('   Submit:', JSON.stringify(submitRes?.value));

    // Step 4: Wait for AI response
    console.log('4. Waiting for AI response (up to 45s)...');
    let consumed = false;
    for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 3000));

        // Check sentinel count in page
        const check = await evalMain(`(function() {
      const text = document.body.innerText;
      const count = (text.match(/${sentinel}/g) || []).length;
      return { count };
    })()`);

        const count = check?.value?.count || 0;
        if (i % 3 === 0) console.log(`   Poll ${i + 1}: sentinel count = ${count}`);

        // If sentinel appears more than once, AI has referenced it
        if (count >= 2) {
            consumed = true;
            console.log('   ✅ AI consumed the result! Sentinel count:', count);
            break;
        }
    }

    if (!consumed) {
        // Final: grab last visible text from page
        const lastText = await evalMain(`(function() {
      const text = document.body.innerText;
      return text.slice(-500);
    })()`);
        console.log('   Last 500 chars of page:', (lastText?.value || '').slice(-300));

        // Check if sentinel is anywhere
        const finalCheck = await evalMain(`(function() {
      const text = document.body.innerText;
      const count = (text.match(/${sentinel}/g) || []).length;
      const idx = text.lastIndexOf('${sentinel}');
      let context = '';
      if (idx > -1) context = text.slice(Math.max(0, idx - 100), idx + 100);
      return { count, context };
    })()`);
        console.log('   Final check:', JSON.stringify(finalCheck?.value));

        if (finalCheck?.value?.count === 1) {
            console.log('   ⚠ Sentinel appears once (only user message, AI did not echo it)');
            console.log('   This may mean AI processed it without echoing the exact sentinel.');
        }
    }

    console.log(consumed ? '\n✅ PASS: Format B consumed by AI' : '\n❌ INCONCLUSIVE: Need manual verification');
    ws.close();
    process.exit(consumed ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
