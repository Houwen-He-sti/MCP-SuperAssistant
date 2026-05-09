/**
 * CDP test: verify tools discovery via ISOLATED world (content script context)
 * Uses chrome.runtime.sendMessage from content script ISOLATED world
 * to communicate with background service worker.
 */
const http = require('http');
const WebSocket = require('ws');

const EXT_ID = 'hkjclekhnaffnhldgpmjnohihjmblbpj';
const CDP_PORT = 9222;

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 1; this.pending = {}; this.listeners = {}; }
  
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.on('message', m => {
      const msg = JSON.parse(m.toString());
      if (msg.id && this.pending[msg.id]) this.pending[msg.id](msg);
      if (msg.method && this.listeners[msg.method]) {
        this.listeners[msg.method].forEach(fn => fn(msg.params));
      }
    });
    await new Promise(r => this.ws.on('open', r));
  }

  send(method, params = {}) {
    return new Promise(r => {
      const myId = this.id++;
      this.pending[myId] = r;
      this.ws.send(JSON.stringify({ id: myId, method, params }));
    });
  }

  on(method, fn) {
    if (!this.listeners[method]) this.listeners[method] = [];
    this.listeners[method].push(fn);
  }

  close() { this.ws.close(); }
}

async function findIsolatedContextId(cdp) {
  const contexts = [];
  cdp.on('Runtime.executionContextCreated', p => contexts.push(p.context));
  await cdp.send('Runtime.enable');
  // Wait a bit for contexts to arrive
  await new Promise(r => setTimeout(r, 1000));
  
  const extCtx = contexts.find(c => c.origin && c.origin.includes(EXT_ID));
  if (extCtx) return extCtx.id;

  console.log('Available contexts:', contexts.map(c => ({ id: c.id, origin: c.origin?.substring(0, 60) })));
  return null;
}

async function evalInIsolated(cdp, contextId, code) {
  const result = await cdp.send('Runtime.evaluate', {
    expression: code,
    contextId,
    awaitPromise: true,
    returnByValue: true
  });
  return result.result?.result?.value;
}

async function main() {
  // Get targets - find a Notion page tab
  const targets = await new Promise((res, rej) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json`, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });

  const notionTab = targets.find(t => t.type === 'page' && t.url?.includes('notion.so'));
  if (!notionTab) {
    console.log('FAIL: No Notion tab found. Open a Notion page in the browser first.');
    process.exit(1);
  }
  console.log('Found Notion tab:', notionTab.url.substring(0, 60));

  const cdp = new CDP(notionTab.webSocketDebuggerUrl);
  await cdp.connect();

  // Find extension ISOLATED world context
  const contextId = await findIsolatedContextId(cdp);
  if (!contextId) {
    console.log('FAIL: Extension ISOLATED world context not found on this tab.');
    cdp.close();
    process.exit(1);
  }
  console.log('Found ISOLATED context:', contextId);

  // Step 1: Check connection status
  console.log('\n--- Step 1: Connection status ---');
  const statusResult = await evalInIsolated(cdp, contextId, `
    new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'mcp:get-connection-status' }, response => {
        resolve(JSON.stringify(response));
      });
    })
  `);
  const status = JSON.parse(statusResult);
  console.log('Connected:', status?.payload?.isConnected ?? status?.isConnected ?? 'unknown');

  // Step 2: Get tools (forceRefresh=true)
  console.log('\n--- Step 2: Get tools (forceRefresh) ---');
  const toolsResult = await evalInIsolated(cdp, contextId, `
    new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'mcp:get-tools', payload: { forceRefresh: true } }, response => {
        resolve(JSON.stringify(response));
      });
    })
  `);
  const toolsData = JSON.parse(toolsResult);
  
  if (toolsData?.payload) {
    const tools = Array.isArray(toolsData.payload) ? toolsData.payload : (toolsData.payload.tools || []);
    console.log(`Tool count: ${tools.length}`);
    if (tools.length > 0) {
      console.log('Sample tools:', tools.slice(0, 5).map(t => t.name || t.function?.name || 'unknown'));
      console.log('\nSUCCESS: Tools discovery working!');
    } else {
      console.log('FAIL: 0 tools returned');
      console.log('Full response:', JSON.stringify(toolsData, null, 2).substring(0, 500));
    }
  } else {
    console.log('FAIL: Unexpected response format');
    console.log('Response:', JSON.stringify(toolsData, null, 2).substring(0, 500));
  }

  // Step 3: Try calling a tool
  const toolCount = Array.isArray(toolsData?.payload) ? toolsData.payload.length : 0;
  if (toolCount > 0) {
    console.log('\n--- Step 3: Call tool ---');
    const callResult = await evalInIsolated(cdp, contextId, `
      new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: 'mcp:call-tool',
          payload: { toolName: 'committee-bridge.echo', args: { message: 'hello from CDP test' } }
        }, response => {
          resolve(JSON.stringify(response));
        });
      })
    `);
    const callData = JSON.parse(callResult);
    if (callData?.success !== false) {
      console.log('Tool call result (first 200 chars):', JSON.stringify(callData).substring(0, 200));
      console.log('\nSUCCESS: Tool call working!');
    } else {
      console.log('Tool call failed:', callData?.payload?.error || callData?.error || 'unknown');
    }
  }

  cdp.close();
}

main().catch(e => { console.error(e); process.exit(1); });
