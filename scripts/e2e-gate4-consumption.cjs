/**
 * Gate 4 P0-2/P0-3: Consumption Proof E2E (Semi-automated, superseded)
 * Classification: SEMI-AUTOMATED PROBE — superseded by auto-submit-v2.cjs and error-submit.cjs.
 *
 * Original semi-automated version. Kept for reference.
 * Validates tool-result consumption via direct injection + manual/auto submit.
 *
 * P0-2: Success consumption — sentinel value referenced in AI reply
 * P0-3: Error consumption — AI acknowledges tool error
 *
 * This is a semi-automated test:
 *   1. Script configures bridge with autoInsert=true, autoSubmit=false
 *   2. AI outputs function_call → interceptor detects → bridge executes → injects result
 *   3. Human reviews injected result in input box
 *   4. Human clicks Submit
 *   5. Script captures AI's next response and checks for sentinel
 *
 * Prerequisites:
 *   - Chrome running with: --remote-debugging-port=9222
 *   - MCP-SuperAssistant extension loaded with latest build
 *   - Notion AI agent page open with MCP tools (echo) available
 *   - MCP server running with echo tool
 *   - `ws` package available
 *
 * Usage:
 *   node scripts/e2e-gate4-consumption.cjs [--error]
 *
 *   --error: Test error consumption (P0-3) instead of success (P0-2)
 *
 * Exit codes:
 *   0 = consumption verified
 *   1 = consumption failed or not detected
 *   2 = infrastructure error
 */

const WebSocket = require('ws');

const CDP_PORT = 9222;
const CDP_URL = `http://localhost:${CDP_PORT}/json`;
const TIMEOUT_MS = 10_000;
const WAIT_FOR_AI_MS = 60_000; // Wait up to 60s for AI response

// ============================================================================
// CDP Session
// ============================================================================

class CDPSession {
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
        this.ws = null;
        this.msgId = 0;
        this.listeners = new Map();
        this.contexts = [];
        this.isolatedCtxId = null;
    }

    async connect() {
        this.ws = new WebSocket(this.wsUrl);
        await new Promise((resolve, reject) => {
            this.ws.on('open', resolve);
            this.ws.on('error', reject);
        });
        this.ws.on('message', (data) => {
            const msg = JSON.parse(data);
            if (msg.id && this.listeners.has(msg.id)) {
                this.listeners.get(msg.id)(msg);
                this.listeners.delete(msg.id);
            }
            if (msg.method === 'Runtime.executionContextCreated') {
                this.contexts.push(msg.params.context);
            }
        });
    }

    async findIsolatedContext() {
        await new Promise(r => setTimeout(r, 1000));
        for (const ctx of this.contexts) {
            if (ctx.name === 'MCP SuperAssistant') {
                const check = await this.send('Runtime.evaluate', {
                    contextId: ctx.id,
                    expression: `typeof window.pluginRegistry !== 'undefined'`,
                    returnByValue: true,
                });
                if (check.result?.result?.value === true) {
                    this.isolatedCtxId = ctx.id;
                    return ctx.id;
                }
            }
        }
        return null;
    }

    send(method, params = {}) {
        return new Promise((resolve) => {
            const id = ++this.msgId;
            this.listeners.set(id, resolve);
            this.ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
                if (this.listeners.has(id)) {
                    this.listeners.delete(id);
                    resolve({ error: { message: 'CDP timeout' } });
                }
            }, TIMEOUT_MS);
        });
    }

    async evaluate(expression, opts = {}) {
        const params = {
            expression,
            returnByValue: true,
            awaitPromise: opts.awaitPromise || false,
            ...opts,
        };
        if (this.isolatedCtxId && !opts.contextId) {
            params.contextId = this.isolatedCtxId;
        }
        const result = await this.send('Runtime.evaluate', params);
        if (result.result?.exceptionDetails) {
            const exc = result.result.exceptionDetails;
            return { __exception: true, text: exc.text, description: exc.exception?.description };
        }
        return result.result?.result;
    }

    close() {
        if (this.ws) this.ws.close();
    }
}

// ============================================================================
// Helpers
// ============================================================================

function log(level, ...args) {
    const prefix = { info: '●', pass: '✅', fail: '❌', warn: '⚠', step: '→', probe: '🔬' };
    console.log(`  ${prefix[level] || '·'} ${args.join(' ')}`);
}

async function findNotionTab() {
    const resp = await fetch(CDP_URL);
    const tabs = await resp.json();
    const notionTabs = tabs.filter(t =>
        t.type === 'page' && t.url && t.url.includes('notion.so')
    );
    return notionTabs.find(t => t.url && t.url.includes('/agent/')) || notionTabs[0];
}

/**
 * Get the last AI message text from the page.
 * Uses DOM inspection to find the most recent assistant message.
 */
async function getLastAIMessage(cdp) {
    const result = await cdp.evaluate(`
    (function() {
      // Notion AI assistant messages — try common selectors
      const messages = document.querySelectorAll('[data-block-id]');
      if (messages.length === 0) return null;
      const last = messages[messages.length - 1];
      return last.textContent || '';
    })()
  `, { contextId: undefined }); // MAIN world for DOM access
    return result?.value || null;
}

/**
 * Wait for AI to generate a new response after the previous message count.
 * Polls the DOM for new content.
 */
async function waitForNewAIResponse(cdp, previousMessageText, timeoutMs = WAIT_FOR_AI_MS) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const current = await getLastAIMessage(cdp);
        if (current && current !== previousMessageText && current.length > 10) {
            return current;
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    return null;
}

// ============================================================================
// P0-2: Success Consumption Proof
// ============================================================================

async function testSuccessConsumption(cdp) {
    console.log('\n━━━ P0-2: Success Consumption Proof ━━━');

    const SENTINEL = `sentinel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    log('info', `Sentinel value: ${SENTINEL}`);

    // 1. Configure bridge
    log('step', 'Configuring bridge: enabled=true, autoInsert=true, autoSubmit=false...');
    const configResult = await cdp.evaluate(`
    (function() {
      if (typeof window.configureStreamToolBridge !== 'function') {
        return { error: 'configureStreamToolBridge not available' };
      }
      window.configureStreamToolBridge({
        enabled: true,
        autoInsert: true,
        autoSubmit: false,
        toolAllowlist: ['echo']
      });
      return window.getStreamToolBridgeInfo();
    })()
  `);
    log('info', `Bridge config: ${JSON.stringify(configResult?.value?.config || configResult?.value, null, 2).slice(0, 200)}`);

    // 2. Set up mock mcpClient that returns sentinel
    log('step', `Setting up mcpClient mock (returns sentinel: ${SENTINEL})...`);
    const mockSetup = await cdp.evaluate(`
    (function() {
      const sentinel = ${JSON.stringify(SENTINEL)};
      window.mcpClient = {
        callTool: async function(name, params) {
          console.log('[MOCK] callTool:', name, JSON.stringify(params));
          return { message: sentinel };
        },
        isReady: function() { return true; }
      };
      return { mockInstalled: true, sentinel: sentinel };
    })()
  `);
    log('info', `Mock setup: ${JSON.stringify(mockSetup?.value)}`);

    // 3. Record current last AI message (to detect new response later)
    const beforeMsg = await getLastAIMessage(cdp);
    log('info', `Last AI message (before): ${(beforeMsg || '').slice(0, 80)}...`);

    // 4. Instruct user
    log('probe', 'MANUAL STEPS:');
    log('probe', '1. Type a message in Notion AI that will trigger echo tool call');
    log('probe', '   Example: "Please call the echo tool with message: hello"');
    log('probe', '2. Submit the message');
    log('probe', '3. Wait for interceptor to detect function_call → bridge executes → result injected');
    log('probe', '4. Review the injected result in the input box');
    log('probe', `5. The result should contain sentinel: ${SENTINEL}`);
    log('probe', '6. Click Submit to send the result to AI');
    log('probe', '7. Wait for AI to respond');
    log('probe', '');
    log('probe', 'This script will monitor for the AI response...');

    // 5. Wait for AI response containing sentinel
    log('step', 'Polling for AI response (up to 60s)...');
    const aiResponse = await waitForNewAIResponse(cdp, beforeMsg);

    if (!aiResponse) {
        log('warn', 'No new AI response detected within timeout.');
        log('warn', 'Check browser manually for AI response.');
        return { success: false, sentinel: SENTINEL, reason: 'timeout' };
    }

    log('info', `AI response (last 200 chars): ...${aiResponse.slice(-200)}`);

    const consumed = aiResponse.includes(SENTINEL);
    if (consumed) {
        log('pass', `SUCCESS: AI referenced sentinel "${SENTINEL}" in response`);
    } else {
        log('warn', `AI response does not contain sentinel "${SENTINEL}"`);
        log('info', 'This may be acceptable if AI paraphrased the result.');
        log('info', 'Manual verification needed: did AI acknowledge the echo result?');
    }

    return { success: consumed, sentinel: SENTINEL, aiResponse: aiResponse.slice(-300) };
}

// ============================================================================
// P0-3: Error Consumption Proof
// ============================================================================

async function testErrorConsumption(cdp) {
    console.log('\n━━━ P0-3: Error Consumption Proof ━━━');

    const ERROR_MSG = `error_${Date.now().toString(36)}: Connection refused to MCP server`;

    // 1. Configure bridge
    log('step', 'Configuring bridge: enabled=true, autoInsert=true, autoSubmit=false...');
    await cdp.evaluate(`
    (function() {
      window.configureStreamToolBridge({
        enabled: true,
        autoInsert: true,
        autoSubmit: false,
        toolAllowlist: ['echo']
      });
    })()
  `);

    // 2. Set up mock mcpClient that throws error
    log('step', `Setting up error mcpClient mock...`);
    const errorMsg = JSON.stringify(ERROR_MSG);
    await cdp.evaluate(`
    (function() {
      window.mcpClient = {
        callTool: async function(name, params) {
          throw new Error(${errorMsg});
        },
        isReady: function() { return true; }
      };
    })()
  `);

    // 3. Record current state
    const beforeMsg = await getLastAIMessage(cdp);

    // 4. Instruct user
    log('probe', 'MANUAL STEPS:');
    log('probe', '1. Trigger a function_call in Notion AI (e.g., "call echo")');
    log('probe', '2. Bridge will execute → tool errors → error result injected');
    log('probe', '3. Review error result in input box');
    log('probe', '4. Submit to AI');
    log('probe', '5. Observe AI response — should acknowledge the error');

    // 5. Wait for response
    log('step', 'Polling for AI response (up to 60s)...');
    const aiResponse = await waitForNewAIResponse(cdp, beforeMsg);

    if (!aiResponse) {
        log('warn', 'No new AI response detected. Check browser manually.');
        return { success: false, errorMsg: ERROR_MSG, reason: 'timeout' };
    }

    log('info', `AI response (last 200 chars): ...${aiResponse.slice(-200)}`);

    // Check if AI mentions error-related keywords
    const errorKeywords = ['error', 'failed', 'failure', '失败', '错误', 'issue', 'problem', 'unable', 'could not'];
    const mentioned = errorKeywords.some(kw => aiResponse.toLowerCase().includes(kw));

    if (mentioned) {
        log('pass', 'AI acknowledged the error in its response');
    } else {
        log('warn', 'AI response may not explicitly mention the error.');
        log('info', 'Manual verification needed.');
    }

    return { success: mentioned, errorMsg: ERROR_MSG, aiResponse: aiResponse.slice(-300) };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    const isError = process.argv.includes('--error');

    console.log('━━━ Gate 4: Consumption Proof E2E ━━━');
    console.log(`  Mode: ${isError ? 'P0-3 Error consumption' : 'P0-2 Success consumption'}`);

    let cdp;
    try {
        const tab = await findNotionTab();
        if (!tab) {
            log('fail', 'No Notion tab found.');
            process.exit(2);
        }
        log('info', `Found Notion tab: ${tab.url.slice(0, 60)}...`);

        cdp = new CDPSession(tab.webSocketDebuggerUrl);
        await cdp.connect();
        await cdp.send('Runtime.enable');
        await cdp.findIsolatedContext();

        if (!cdp.isolatedCtxId) {
            log('fail', 'No ISOLATED world found. Extension may not be loaded.');
            process.exit(2);
        }
        log('pass', `ISOLATED world found: contextId=${cdp.isolatedCtxId}`);

        let result;
        if (isError) {
            result = await testErrorConsumption(cdp);
        } else {
            result = await testSuccessConsumption(cdp);
        }

        // Output result for transcript
        console.log('\n━━━ RESULT ━━━');
        console.log(JSON.stringify(result, null, 2));

        process.exit(result.success ? 0 : 1);

    } catch (err) {
        log('fail', `Infrastructure error: ${err.message}`);
        console.error(err);
        process.exit(2);
    } finally {
        if (cdp) cdp.close();
    }
}

main();
