#!/usr/bin/env node
/**
 * Fix MCP connection after R2 hardening.
 *
 * 1. Find MCP-SuperAssistant extension service worker via CDP
 * 2. Clear stored config (mcpServerUrl, mcpConnectionType) from chrome.storage.local
 * 3. Reload extension (so defaults take effect)
 * 4. Verify the fix
 */

const WebSocket = require('ws');
const { resolveExtensionId, getTargets, sleep } = require('./lib/cdp-preflight.cjs');

(async () => {
  // --- Step 1: Discover MCP-SuperAssistant ---
  console.log('🔍 Discovering MCP-SuperAssistant extension...');
  const ext = await resolveExtensionId('MCP SuperAssistant');
  console.log(`✅ Found: ${ext.name} (${ext.extensionId})`);

  // --- Step 2: Connect to service worker ---
  const ws = new WebSocket(ext.wsUrl);
  await new Promise(r => ws.on('open', r));

  let id = 0;
  function send(m, p) {
    return new Promise(r => {
      const i = ++id;
      const h = msg => {
        const o = JSON.parse(msg);
        if (o.id === i) {
          ws.off('message', h);
          r(o);
        }
      };
      ws.on('message', h);
      ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    });
  }

  // --- Step 3: Check current stored config ---
  const checkResult = await send('Runtime.evaluate', {
    expression: `(async () => {
            try {
                const result = await chrome.storage.local.get(['mcpServerUrl', 'mcpConnectionType']);
                return JSON.stringify(result);
            } catch(e) {
                return JSON.stringify({ error: e.message });
            }
        })()`,
    awaitPromise: true,
  });
  const oldConfig = JSON.parse(checkResult.result?.result?.value || '{}');
  console.log('📋 Current stored config:', oldConfig);

  // --- Step 4: Clear stored config ---
  console.log('🧹 Clearing stored MCP config...');
  const clearResult = await send('Runtime.evaluate', {
    expression: `(async () => {
            try {
                await chrome.storage.local.remove(['mcpServerUrl', 'mcpConnectionType']);
                const verify = await chrome.storage.local.get(['mcpServerUrl', 'mcpConnectionType']);
                return JSON.stringify({ cleared: true, remaining: verify });
            } catch(e) {
                return JSON.stringify({ error: e.message });
            }
        })()`,
    awaitPromise: true,
  });
  console.log('🧹 Clear result:', JSON.parse(clearResult.result?.result?.value || '{}'));

  // --- Step 5: Reload extension ---
  console.log('🔄 Reloading extension...');
  await send('Runtime.evaluate', {
    expression: 'chrome.runtime.reload()',
  });
  console.log('✅ Reload command sent');

  ws.close();
  console.log('⏳ Waiting 5s for extension to restart...');
  await sleep(5000);

  // --- Step 6: Re-connect and verify ---
  console.log('🔍 Re-connecting to verify...');
  const ext2 = await resolveExtensionId('MCP SuperAssistant');
  console.log(`✅ Extension restarted: ${ext2.extensionId}`);

  const ws2 = new WebSocket(ext2.wsUrl);
  await new Promise(r => ws2.on('open', r));

  let id2 = 0;
  function send2(m, p) {
    return new Promise(r => {
      const i = ++id2;
      const h = msg => {
        const o = JSON.parse(msg);
        if (o.id === i) {
          ws2.off('message', h);
          r(o);
        }
      };
      ws2.on('message', h);
      ws2.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    });
  }

  // --- Step 7: Verify stored config is now defaults ---
  const verifyResult = await send2('Runtime.evaluate', {
    expression: `(async () => {
            try {
                const result = await chrome.storage.local.get(['mcpServerUrl', 'mcpConnectionType']);
                return JSON.stringify(result);
            } catch(e) {
                return JSON.stringify({ error: e.message });
            }
        })()`,
    awaitPromise: true,
  });
  console.log('📋 After fix, stored config:', JSON.parse(verifyResult.result?.result?.value || '{}'));

  // --- Step 8: Check serverUrl from background state ---
  const stateResult = await send2('Runtime.evaluate', {
    expression: `(async () => {
            try {
                // Try to read the background's serverUrl and connectionType
                // These are module-scoped in background/index.ts, not directly accessible.
                // Instead check via the get-server-config message
                return new Promise((resolve) => {
                    chrome.runtime.sendMessage({
                        type: 'mcp:get-server-config',
                        source: 'mcpclient'
                    }, (response) => {
                        resolve(JSON.stringify(response || { error: 'no response' }));
                    });
                });
            } catch(e) {
                return JSON.stringify({ error: e.message });
            }
        })()`,
    awaitPromise: true,
  });
  console.log('📋 Server config after fix:', JSON.parse(stateResult.result?.result?.value || '{}'));

  ws2.close();
  console.log('\n✅ 完成！MCP 连接配置已清除默认值应生效。');
  console.log('   请刷新 Notion 页面检查扩展状态栏是否显示 Streamable HTTP。');
})().catch(e => {
  console.error('❌ Error:', e);
  process.exit(1);
});
