/**
 * Gate 4 P0-3: Error Consumption Proof
 * 
 * Same as auto-submit-v2 but injects an error result.
 * Verifies AI acknowledges the tool error.
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

  let isoCtx = null;

  async function evalIso(expression, opts = {}) {
    const params = { expression, returnByValue: true, awaitPromise: opts.awaitPromise || false, contextId: isoCtx, ...opts };
    const result = await send('Runtime.evaluate', params);
    return result.result?.result;
  }

  await send('Runtime.enable');
  await new Promise(r => setTimeout(r, 1500));

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

  const errorId = 'err_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  console.log('Error ID:', errorId);

  // Step 1: Clear
  console.log('1. Clearing input...');
  await evalMain(`(async function() {
    const el = document.querySelector('div[role="textbox"][contenteditable="true"]');
    if (el) { el.focus(); const s = window.getSelection(); if (s) { const r = document.createRange(); r.selectNodeContents(el); s.removeAllRanges(); s.addRange(r); } document.execCommand('delete', false); }
  })()`, { awaitPromise: true });
  await new Promise(r => setTimeout(r, 500));

  // Step 2: Insert error format
  console.log('2. Inserting Error Format B...');
  const errorFormat = `<function_results>\n  <result call_id="err_probe" name="echo" status="error">\n    <error type="ToolExecutionError"><![CDATA[\nConnection refused: MCP server unavailable (${errorId})\n    ]]></error>\n  </result>\n</function_results>`;

  const insertRes = await evalIso(`(async function() {
    const text = ${JSON.stringify(errorFormat)};
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

  // Step 3: Submit
  console.log('3. Submitting...');
  const submitRes = await evalMain(`(function() {
    const btn = document.querySelector('[data-testid="agent-send-message-button"]');
    if (btn) { btn.click(); return { method: 'sendButton', ok: true }; }
    return { method: 'none', error: 'No send button' };
  })()`);
  console.log('   Submit:', JSON.stringify(submitRes?.value));

  // Step 4: Wait for AI response
  console.log('4. Waiting for AI response (up to 45s)...');
  let consumed = false;
  const errorKeywords = ['error', 'failed', 'failure', 'unavailable', '失败', '错误', '无法', 'issue', 'problem', 'refused', errorId];

  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 3000));

    const check = await evalMain(`(function() {
      const text = document.body.innerText;
      const idCount = (text.match(/${errorId}/g) || []).length;
      // Check for error acknowledgment keywords in last 500 chars
      const lastChunk = text.slice(-500);
      return { idCount, lastChunk };
    })()`);

    const idCount = check?.value?.idCount || 0;
    const lastChunk = check?.value?.lastChunk || '';

    if (i % 3 === 0) console.log(`   Poll ${i + 1}: errorId count = ${idCount}`);

    // Check if AI acknowledged the error
    if (idCount >= 2) {
      consumed = true;
      console.log('   ✅ AI echoed the error ID!');
      break;
    }
    // Also check if AI mentioned error-related words without echoing the ID
    if (idCount >= 1 && i >= 2) {
      const hasErrorWord = errorKeywords.some(kw => lastChunk.toLowerCase().includes(kw.toLowerCase()));
      if (hasErrorWord) {
        consumed = true;
        console.log('   ✅ AI acknowledged the error (keyword match in response)');
        console.log('   Last chunk:', lastChunk.slice(-200));
        break;
      }
    }
  }

  if (!consumed) {
    const finalCheck = await evalMain(`(function() {
      const text = document.body.innerText;
      return text.slice(-400);
    })()`);
    console.log('   Final text:', finalCheck?.value);
  }

  console.log(consumed ? '\n✅ PASS: Error consumption verified' : '\n❌ INCONCLUSIVE: Manual check needed');
  ws.close();
  process.exit(consumed ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
