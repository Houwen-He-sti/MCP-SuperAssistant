// Reload MCP-SuperAssistant extension, then reload Notion page
const WebSocket = require('ws');
const http = require('http');

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json', res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

function findExtensionTarget(targets, extensionIdCandidates) {
  for (const id of extensionIdCandidates.filter(Boolean)) {
    const serviceWorker = targets.find(t => t.type === 'service_worker' && t.url.includes(id));
    if (serviceWorker) return serviceWorker;
    const anyTarget = targets.find(t => t.url.includes(id));
    if (anyTarget) return anyTarget;
  }
  return targets.find(t => t.type === 'service_worker' && /service-worker-loader\.js$/.test(t.url));
}

async function main() {
  const targets = await getTargets();

  const extensionIdCandidates = [
    process.env.MCP_SUPERASSISTANT_EXTENSION_ID,
    'hkjclekhnaffnhldgpmjnohihjmblbpj',
    'mcjlamohcooanphmebaiigheeeoplihb',
  ].filter(Boolean);

  // Find MCP-SA service worker, respecting explicit ID priority.
  const sw = findExtensionTarget(targets, extensionIdCandidates);
  if (!sw) {
    console.log('No SW found. Extension targets:');
    targets.filter(t => t.url.includes('chrome-extension://')).forEach(t => console.log('  ', t.type, t.url.substring(0, 80)));
    process.exit(1);
  }
  console.log('Found SW:', sw.url);

  // Connect to SW and reload
  const ws1 = new WebSocket(sw.webSocketDebuggerUrl);
  await new Promise(r => ws1.on('open', r));

  ws1.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression: 'chrome.runtime.reload()' }
  }));

  console.log('Reload command sent');
  await new Promise(r => setTimeout(r, 3000));
  try { ws1.close(); } catch { }

  console.log('Waiting 5s for extension restart...');
  await new Promise(r => setTimeout(r, 5000));

  // Get fresh targets
  const targets2 = await getTargets();
  const notionTab = targets2.find(t => t.url.includes('notion.so'));
  if (!notionTab) { console.log('No Notion tab'); process.exit(1); }
  console.log('Notion tab:', notionTab.url);

  // Navigate to agent page
  const ws2 = new WebSocket(notionTab.webSocketDebuggerUrl);
  await new Promise(r => ws2.on('open', r));

  let id2 = 0;
  function send(m, p) {
    return new Promise(r => {
      const i = ++id2;
      const h = msg => { const o = JSON.parse(msg); if (o.id === i) { ws2.off('message', h); r(o); } };
      ws2.on('message', h);
      ws2.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    });
  }

  console.log('Reloading page...');
  await send('Page.reload', {});

  console.log('Waiting 8s for page load...');
  await new Promise(r => setTimeout(r, 8000));

  // Check URL
  const urlCheck = await send('Runtime.evaluate', { expression: 'location.href' });
  console.log('URL:', urlCheck.result?.result?.value);

  // Check interceptor
  const check = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
    interceptor: !!window.__MCP_SA_NOTION_STREAM_INTERCEPTOR_INSTALLED_V1__,
    fetchName: window.fetch.name,
    fetchLen: window.fetch.toString().length
  })` });
  console.log('Interceptor:', check.result?.result?.value);

  ws2.close();
  process.exit();
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { findExtensionTarget };
