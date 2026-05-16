#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const {
    ACK_PATTERN,
    INSTRUCTION_FILE_ANSWER_TASK,
    REVIEW_FILE_CONTEXT_MAX_BYTES,
    REVIEW_FILE_CONTEXT_PATH,
    REVIEW_PR_FILE_CONTEXT_MAX_BYTES,
    REVIEW_PR_FILE_CONTEXT_PATH,
    SAFE_FINAL_PREFERENCES,
    buildEchoClosedLoopPrompt,
    buildInstructionFileAnswerPrompt,
    buildMultiRoundEchoCountPrompt,
    buildReviewModuleContextPrompt,
    buildReviewModuleFileContextPrompt,
    buildReviewModulePrFileContextPrompt,
    extractFinalResponseTextFromStreamEvents,
    extractJsonBlocks,
    isRuntimeCompleteBeforeFinalRestore,
    isNotionAiRouteUrl,
    isFreshNotionChatUrl,
    validateEchoClosedLoopEvidence,
    validateInstructionFileAnswerEvidence,
    validateMultiRoundEchoCountEvidence,
    validateReviewModuleContextEvidence,
    validateReviewModuleFileContextEvidence,
    validateReviewModulePrFileContextEvidence,
} = require('./notion-echo-smoke-contract.cjs');

const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const STORE_KEY = 'mcp-super-assistant-ui-store';
const SMOKE_KIND = process.env.NOTION_SMOKE_KIND || 'echo';
const FILE_CONTEXT_SMOKE_KINDS = ['review_file_context', 'review_pr_file_context', 'instruction_file_answer'];
const IS_MULTI_ROUND_SMOKE = SMOKE_KIND === 'multi_round_count';
const IS_INSTRUCTION_FILE_ANSWER_SMOKE = SMOKE_KIND === 'instruction_file_answer';
const MULTI_ROUND_TARGET_COUNT = Math.max(1, Number(process.env.NOTION_MULTI_ROUND_TARGET_COUNT || 3));
const RUN_PREFIX = SMOKE_KIND === 'review_context' ? 'RM_CONTEXT' : SMOKE_KIND === 'review_file_context' ? 'RM_FILE_CONTEXT' : SMOKE_KIND === 'review_pr_file_context' ? 'RM_PR_FILE_CONTEXT' : IS_INSTRUCTION_FILE_ANSWER_SMOKE ? 'INSTRUCTION_FILE_ANSWER' : IS_MULTI_ROUND_SMOKE ? 'MULTI_ROUND_COUNT' : 'ECHO_SMOKE';
const EXPECTED_TOOL = SMOKE_KIND === 'review_context' ? 'get_bridge_info' : FILE_CONTEXT_SMOKE_KINDS.includes(SMOKE_KIND) ? 'read_workspace_file' : 'echo';
const RUN_STAMP = Date.now();
const RUN_ID = `${RUN_PREFIX}_${RUN_STAMP}`;
const NONCE = `${RUN_ID}_NONCE`;
const EXPECTED_CALL_IDS = IS_MULTI_ROUND_SMOKE
  ? Array.from({ length: MULTI_ROUND_TARGET_COUNT }, (_, index) => `call_echo_count_${index + 1}_${RUN_STAMP}`)
  : [`call_${EXPECTED_TOOL}_${RUN_STAMP}`];
const CALL_ID = EXPECTED_CALL_IDS[0];
const EXPECTED_ACK = `ACK_${RUN_ID}`;
const EXPECTED_FILE_PATH = IS_INSTRUCTION_FILE_ANSWER_SMOKE ? INSTRUCTION_FILE_ANSWER_TASK.allowedPaths[0] : SMOKE_KIND === 'review_pr_file_context' ? REVIEW_PR_FILE_CONTEXT_PATH : REVIEW_FILE_CONTEXT_PATH;
const EXPECTED_MAX_BYTES = IS_INSTRUCTION_FILE_ANSWER_SMOKE ? INSTRUCTION_FILE_ANSWER_TASK.maxBytes : SMOKE_KIND === 'review_pr_file_context' ? REVIEW_PR_FILE_CONTEXT_MAX_BYTES : REVIEW_FILE_CONTEXT_MAX_BYTES;
const LIMITS = {
  maxDurationMs: Number(process.env.ECHO_SMOKE_TIMEOUT_MS || (IS_INSTRUCTION_FILE_ANSWER_SMOKE ? 60000 : 180000)),
    pollMs: 2500,
};
const DEFAULT_AUTO_SUBMIT_DELAY_MS = IS_MULTI_ROUND_SMOKE ? 3000 : 1500;
const AUTO_SUBMIT_DELAY_MS = Number(process.env.ECHO_SMOKE_AUTO_SUBMIT_DELAY_MS || DEFAULT_AUTO_SUBMIT_DELAY_MS);
const MANUAL_SUBMIT_FALLBACK_DELAY_MS = Number(process.env.ECHO_SMOKE_MANUAL_SUBMIT_FALLBACK_DELAY_MS || 5000);
const POST_SUBMIT_FALLBACK_DELAY_MS = Number(process.env.ECHO_SMOKE_POST_SUBMIT_FALLBACK_DELAY_MS || 10000);
const STREAM_BRIDGE_ENABLED = process.env.ECHO_SMOKE_STREAM_BRIDGE_ENABLED
  ? process.env.ECHO_SMOKE_STREAM_BRIDGE_ENABLED === 'true'
  : true;
const DIRECT_MONITORING_ENABLED = process.env.ECHO_SMOKE_DIRECT_MONITORING_ENABLED
  ? process.env.ECHO_SMOKE_DIRECT_MONITORING_ENABLED === 'true'
  : !(FILE_CONTEXT_SMOKE_KINDS.includes(SMOKE_KIND) || IS_MULTI_ROUND_SMOKE);

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTargets() {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
    });
}

class Cdp {
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
        this.nextId = 1;
        this.pending = new Map();
        this.contexts = [];
    }

    async open() {
        this.ws = new WebSocket(this.wsUrl);
        this.ws.on('message', (raw) => {
            const msg = JSON.parse(String(raw));
            if (msg.method === 'Runtime.executionContextCreated') this.contexts.push(msg.params.context);
            if (msg.id && this.pending.has(msg.id)) {
                const item = this.pending.get(msg.id);
                clearTimeout(item.timer);
                this.pending.delete(msg.id);
                if (msg.error) item.reject(new Error(JSON.stringify(msg.error)));
                else item.resolve(msg.result);
            }
        });
        await new Promise((resolve, reject) => {
            this.ws.once('open', resolve);
            this.ws.once('error', reject);
        });
    }

    send(method, params = {}, timeoutMs = 15000) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`CDP timeout for ${method}`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    async evalMain(expression, options = {}) {
        const result = await this.send('Runtime.evaluate', {
            expression,
            awaitPromise: !!options.awaitPromise,
            returnByValue: true,
        }, options.timeoutMs || 15000);
        return result.result?.value;
    }

    async evalIso(contextId, expression, options = {}) {
        const result = await this.send('Runtime.evaluate', {
            expression,
            contextId,
            awaitPromise: !!options.awaitPromise,
            returnByValue: true,
        }, options.timeoutMs || 15000);
        return result.result?.value;
    }

    close() {
        try { this.ws.close(); } catch { }
    }
}

function parseMaybeJson(value) {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return value; }
}

function parseToolNames(value) {
  const parsed = parseMaybeJson(value);
  if (Array.isArray(parsed)) return parsed.filter(Boolean);
  const tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
  return tools.map((tool) => tool && (tool.name || tool.value && tool.value.name)).filter(Boolean);
}

function quote(value) {
    return JSON.stringify(value);
}

function findNotionTab(targets) {
  const tabs = targets.filter((target) => target.type === 'page' && isNotionAiRouteUrl(target.url));
    return tabs.find((target) => /notion-tab-0/.test(target.title || '')) || tabs[0] || null;
}

async function findIsoContext(cdp) {
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable').catch(() => { });
    await wait(1200);
    for (const context of cdp.contexts.filter((ctx) => ctx.name === 'MCP SuperAssistant')) {
        try {
            const raw = await cdp.evalIso(context.id, `JSON.stringify({
        href: location.href,
        hasMcpClient: !!window.mcpClient,
        mcpReady: typeof window.mcpClient?.isReady === 'function' ? window.mcpClient.isReady() : null,
        hasPluginRegistry: !!window.pluginRegistry,
        hasBridgeConfig: typeof window.configureStreamToolBridge === 'function',
        hasBridgeInfo: typeof window.getStreamToolBridgeInfo === 'function'
      })`);
            const value = JSON.parse(raw || '{}');
            if (isNotionAiRouteUrl(value.href) && value.hasMcpClient && value.mcpReady) {
                return { id: context.id, name: context.name, origin: context.origin, value };
            }
        } catch { }
    }
    throw new Error('No ready MCP SuperAssistant context found on Notion AI route');
}

function preferencesExpression() {
    return `(function() {
    const stored = JSON.parse(localStorage.getItem(${quote(STORE_KEY)}) || '{}');
    const prefs = stored && stored.state && stored.state.preferences ? stored.state.preferences : null;
    return JSON.stringify(prefs ? {
      autoSubmit: !!prefs.autoSubmit,
      autoInsert: !!prefs.autoInsert,
      autoExecute: !!prefs.autoExecute
    } : null);
  })()`;
}

function setPreferencesExpression(preferences) {
    return `(function() {
    const key = ${quote(STORE_KEY)};
    const stored = JSON.parse(localStorage.getItem(key) || '{}');
    if (!stored.state) stored.state = {};
    if (!stored.state.preferences) stored.state.preferences = {};
    stored.state.preferences.autoSubmit = ${preferences.autoSubmit ? 'true' : 'false'};
    stored.state.preferences.autoInsert = ${preferences.autoInsert ? 'true' : 'false'};
    stored.state.preferences.autoExecute = ${preferences.autoExecute ? 'true' : 'false'};
    localStorage.setItem(key, JSON.stringify(stored));
    return JSON.stringify({
      autoSubmit: !!stored.state.preferences.autoSubmit,
      autoInsert: !!stored.state.preferences.autoInsert,
      autoExecute: !!stored.state.preferences.autoExecute
    });
  })()`;
}

function installObserversExpression() {
    return `(function() {
  var autoSubmitDelayMs = ${AUTO_SUBMIT_DELAY_MS};
  var expectedCallIds = ${JSON.stringify(EXPECTED_CALL_IDS)};
  function findExpectedCallId(text) {
    for (var i = 0; i < expectedCallIds.length; i++) {
      if (String(text || '').includes(expectedCallIds[i])) return expectedCallIds[i];
    }
    return null;
  }
  function hasExpectedCallId(text) {
    return !!findExpectedCallId(text);
  }
  function resolveAdapter() {
    var win = window;
    var adapter = null;
    var reg = win.pluginRegistry;
    var plugin = reg && typeof reg.getActivePlugin === 'function' ? reg.getActivePlugin() : null;
    if (plugin && plugin.adapter && typeof plugin.adapter.insertText === 'function') adapter = plugin.adapter;
    if (!adapter && plugin && typeof plugin.insertText === 'function') adapter = plugin;
    if (!adapter && win.mcpAdapter && typeof win.mcpAdapter.insertText === 'function') adapter = win.mcpAdapter;
    if (!adapter && typeof win.getCurrentAdapter === 'function') adapter = win.getCurrentAdapter();
    return adapter;
  }

  function getComposerText() {
    var input = document.querySelector('div[role="textbox"][contenteditable="true"]');
    return input ? String(input.textContent || '') : '';
  }

  function hasCurrentFunctionResult(text) {
    return hasExpectedCallId(text)
      && (String(text || '').includes('<function_result') || String(text || '').includes('<function_results>'));
  }

  function cacheKeyForTool(name, params) {
    var normalized = Object.assign({}, params || {});
    if (name === ${quote(EXPECTED_TOOL)} && Object.prototype.hasOwnProperty.call(normalized, 'max_bytes')) {
      normalized.max_bytes = String(normalized.max_bytes);
    }
    return String(name) + ':' + JSON.stringify(normalized);
  }

  function clickSendButton() {
    var textbox = document.querySelector('div[role="textbox"][contenteditable="true"]');
    if (!textbox) return { ok: false, error: 'no textbox' };
    var textboxText = String(textbox.textContent || '');
    var textboxRect = textbox.getBoundingClientRect();
    var buttons = Array.from(document.querySelectorAll('[data-testid="agent-send-message-button"], [aria-label="提交 AI 消息"], [aria-label="Send"], button[type="submit"]'));
    var candidates = buttons
      .filter(function(button) {
        var rect = button.getBoundingClientRect();
        var className = String(button.className || '');
        return rect.width > 0
          && rect.height > 0
          && button.getAttribute('aria-disabled') !== 'true'
          && !button.disabled
          && !className.includes('expand-button')
          && !button.closest('.function-result-container, .function-block');
      })
      .map(function(button) {
        var rect = button.getBoundingClientRect();
        var dx = (rect.left + rect.width / 2) - (textboxRect.left + textboxRect.width / 2);
        var dy = (rect.top + rect.height / 2) - (textboxRect.top + textboxRect.height / 2);
        return { button: button, score: Math.abs(dx) + Math.abs(dy), html: button.outerHTML.slice(0, 300) };
      })
      .sort(function(a, b) { return a.score - b.score; });
    var selected = candidates[0];
    if (!selected) {
      return {
        ok: false,
        error: 'no submit candidate',
        buttonCount: buttons.length,
        inputLen: textboxText.length,
        hasCallId: hasExpectedCallId(textboxText),
        hasFunctionResult: hasCurrentFunctionResult(textboxText)
      };
    }
    selected.button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    selected.button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    selected.button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    selected.button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    selected.button.click();
    return {
      ok: true,
      method: 'send-button-click',
      score: selected.score,
      inputLen: textboxText.length,
      hasCallId: hasExpectedCallId(textboxText),
      hasFunctionResult: hasCurrentFunctionResult(textboxText),
      html: selected.html
    };
  }

  if (window.__echoSmokeOriginals) {
    try {
      if (window.__echoSmokeOriginals.callTool && window.mcpClient) window.mcpClient.callTool = window.__echoSmokeOriginals.callTool;
      var oldAdapter = resolveAdapter();
      if (oldAdapter && window.__echoSmokeOriginals.insertText) oldAdapter.insertText = window.__echoSmokeOriginals.insertText;
      if (oldAdapter && window.__echoSmokeOriginals.submitForm) oldAdapter.submitForm = window.__echoSmokeOriginals.submitForm;
    } catch (e) {}
  }

  window.__echoSmokeEvents = [];
  window.__echoSmokeStream = [];
  window.__echoSmokeOriginals = {};
  window.__echoSmokeCallResultCache = {};
  window.__echoSmokeLastResultByName = {};
  window.__echoSmokeCanonicalInsertedCallIds = {};
  window.__echoSmokeSuppressDuplicateRenderer = false;

  window.__echoSmokeToolLoopHandler = function(event) {
    window.__echoSmokeEvents.push({ type: 'toolLoopEvent', detail: event.detail, ts: Date.now() });
  };
  window.addEventListener('mcp-superassistant:tool-loop-event', window.__echoSmokeToolLoopHandler);

  var mc = window.mcpClient;
  if (mc && typeof mc.callTool === 'function') {
    window.__echoSmokeOriginals.callTool = mc.callTool;
    mc.callTool = async function(name, params) {
      var cacheKey = cacheKeyForTool(name, params);
      if (window.__echoSmokeSuppressDuplicateRenderer && name === ${quote(EXPECTED_TOOL)} && window.__echoSmokeCallResultCache[cacheKey]) {
        window.__echoSmokeEvents.push({ type: 'duplicateCallToolSuppressed', name: name, params: params, ts: Date.now() });
        return window.__echoSmokeCallResultCache[cacheKey];
      }
      window.__echoSmokeEvents.push({ type: 'callTool', name: name, params: params, ts: Date.now() });
      try {
        var result = await window.__echoSmokeOriginals.callTool.call(this, name, params);
        window.__echoSmokeCallResultCache[cacheKey] = result;
        window.__echoSmokeLastResultByName[name] = result;
        window.__echoSmokeEvents.push({ type: 'callToolResult', name: name, resultPreview: JSON.stringify(result).slice(0, 1000), result: result, ts: Date.now() });
        return result;
      } catch (e) {
        window.__echoSmokeEvents.push({ type: 'callToolError', name: name, error: String(e && e.message || e), ts: Date.now() });
        throw e;
      }
    };
  }

  var adapter = resolveAdapter();
  if (adapter && typeof adapter.insertText === 'function') {
    window.__echoSmokeOriginals.insertText = adapter.insertText;
    adapter.insertText = async function(text) {
      var textValue = String(text);
      var callIdInText = findExpectedCallId(textValue);
      var hasFunctionResultEnvelope = textValue.includes('<function_result') || textValue.includes('<function_results>');
      if (hasFunctionResultEnvelope && !callIdInText) {
        window.__echoSmokeSuppressNextDuplicateSubmit = true;
        window.__echoSmokeEvents.push({ type: 'staleInsertSuppressed', textLen: textValue.length, ts: Date.now() });
        return true;
      }
      if (textValue.includes('<function_results>') && callIdInText) {
        window.__echoSmokeSuppressDuplicateRenderer = true;
        window.__echoSmokeCanonicalInsertedCallIds[callIdInText] = true;
      }
      if (window.__echoSmokeSuppressDuplicateRenderer
          && textValue.includes('<function_result')
          && !textValue.includes('<function_results>')
          && callIdInText
          && window.__echoSmokeCanonicalInsertedCallIds[callIdInText]) {
        window.__echoSmokeSuppressNextDuplicateSubmit = true;
        window.__echoSmokeEvents.push({ type: 'duplicateInsertSuppressed', textLen: textValue.length, ts: Date.now() });
        return true;
      }
      window.__echoSmokeEvents.push({ type: 'insertText', text: textValue, textLen: textValue.length, ts: Date.now() });
      return await window.__echoSmokeOriginals.insertText.call(this, textValue);
    };
  }
  if (adapter && typeof adapter.submitForm === 'function') {
    window.__echoSmokeOriginals.submitForm = adapter.submitForm;
    adapter.submitForm = async function() {
      if (window.__echoSmokeSuppressNextSubmitLog) {
        window.__echoSmokeSuppressNextSubmitLog = false;
        return await window.__echoSmokeOriginals.submitForm.call(this);
      }
      if (window.__echoSmokeSuppressNextDuplicateSubmit) {
        window.__echoSmokeSuppressNextDuplicateSubmit = false;
        window.__echoSmokeEvents.push({ type: 'duplicateSubmitSuppressed', ts: Date.now() });
        return true;
      }
      var composerTextBeforeSubmit = getComposerText();
      var shouldClickSendButton = hasCurrentFunctionResult(composerTextBeforeSubmit);
      window.__echoSmokeEvents.push({
        type: 'submitForm',
        method: shouldClickSendButton ? 'send-button' : 'adapter',
        autoSubmitDelayMs: autoSubmitDelayMs,
        inputLen: composerTextBeforeSubmit.length,
        hasCallId: hasExpectedCallId(composerTextBeforeSubmit),
        hasFunctionResult: hasCurrentFunctionResult(composerTextBeforeSubmit),
        ts: Date.now()
      });
      if (autoSubmitDelayMs > 0) {
        await new Promise(function(resolve) { setTimeout(resolve, autoSubmitDelayMs); });
      }
      if (shouldClickSendButton) {
        var clickResult = clickSendButton();
        window.__echoSmokeEvents.push({ type: 'submitButtonClickResult', result: clickResult, ts: Date.now() });
        if (clickResult && clickResult.ok) {
          window.__echoSmokeEvents.push({ type: 'submitFormResult', result: true, method: 'send-button', ts: Date.now() });
          return true;
        }
        window.__echoSmokeEvents.push({ type: 'submitFormResult', result: false, method: 'send-button', error: 'send-button-click-failed', clickResult: clickResult, ts: Date.now() });
        return false;
      }
      var result = await window.__echoSmokeOriginals.submitForm.call(this);
      window.__echoSmokeEvents.push({ type: 'submitFormResult', result: result, method: 'adapter', ts: Date.now() });
      return result;
    };
  }

  if (!window.__echoSmokeMainMessageHandler) {
    window.__echoSmokeMainMessageHandler = function(e) {
      var d = e.data;
      if (d && d.channel === 'mcp-superassistant.stream' && d.direction === 'main-to-isolated' && d.event) {
        window.__echoSmokeStream.push({
          type: d.event.type || 'unknown',
          streamId: d.event.streamId || null,
          text: typeof d.event.text === 'string' ? d.event.text.slice(0, 2000) : '',
          detail: JSON.stringify(d.event).slice(0, 2000),
          ts: Date.now()
        });
      }
    };
    window.addEventListener('message', window.__echoSmokeMainMessageHandler);
  }

  return { ok: true, adapterFound: !!adapter, hasCallTool: !!(mc && typeof mc.callTool === 'function') };
})()`;
}

const restoreObserversExpression = `(function() {
  function resolveAdapter() {
    var win = window;
    var adapter = null;
    var reg = win.pluginRegistry;
    var plugin = reg && typeof reg.getActivePlugin === 'function' ? reg.getActivePlugin() : null;
    if (plugin && plugin.adapter && typeof plugin.adapter.insertText === 'function') adapter = plugin.adapter;
    if (!adapter && plugin && typeof plugin.insertText === 'function') adapter = plugin;
    if (!adapter && win.mcpAdapter && typeof win.mcpAdapter.insertText === 'function') adapter = win.mcpAdapter;
    if (!adapter && typeof win.getCurrentAdapter === 'function') adapter = win.getCurrentAdapter();
    return adapter;
  }
  var restored = { callTool: false, insertText: false, submitForm: false, listener: false };
  if (window.__echoSmokeOriginals) {
    if (window.__echoSmokeOriginals.callTool && window.mcpClient) { window.mcpClient.callTool = window.__echoSmokeOriginals.callTool; restored.callTool = true; }
    var adapter = resolveAdapter();
    if (adapter && window.__echoSmokeOriginals.insertText) { adapter.insertText = window.__echoSmokeOriginals.insertText; restored.insertText = true; }
    if (adapter && window.__echoSmokeOriginals.submitForm) { adapter.submitForm = window.__echoSmokeOriginals.submitForm; restored.submitForm = true; }
  }
  if (window.__echoSmokeToolLoopHandler) {
    window.removeEventListener('mcp-superassistant:tool-loop-event', window.__echoSmokeToolLoopHandler);
    window.__echoSmokeToolLoopHandler = null;
    restored.listener = true;
  }
  window.__echoSmokeOriginals = null;
  return restored;
})()`;

function getToolsExpression() {
    return `(async function() {
    if (window.mcpClient && typeof window.mcpClient.getAvailableTools === 'function') {
      const tools = await window.mcpClient.getAvailableTools(true);
      return JSON.stringify(tools.map(function(tool) { return tool && tool.name; }).filter(Boolean));
    }
    return await new Promise(function(resolve) {
      chrome.runtime.sendMessage({ type: 'mcp:get-tools', payload: { forceRefresh: true } }, function(response) {
        const payload = response && (response.payload || response);
        const tools = Array.isArray(payload) ? payload : (Array.isArray(payload && payload.tools) ? payload.tools : []);
        resolve(JSON.stringify(tools.map(function(tool) { return tool && (tool.name || tool.value && tool.value.name); }).filter(Boolean)));
      });
    });
  })()`;
}

function forceReconnectExpression() {
    return `(async function() {
    return await new Promise(function(resolve) {
      chrome.runtime.sendMessage({ type: 'mcp:force-reconnect' }, function(response) {
        resolve(JSON.stringify(response || null));
      });
    });
  })()`;
}

function bridgeConfigExpression(config) {
    return `(function() {
    if (typeof window.configureStreamToolBridge !== 'function') return { ok: false, error: 'configureStreamToolBridge missing' };
    window.configureStreamToolBridge(${JSON.stringify(config)});
    return { ok: true, info: typeof window.getStreamToolBridgeInfo === 'function' ? window.getStreamToolBridgeInfo() : null };
  })()`;
}

function adapterInsertTextExpression(text) {
    return `(async function() {
    function resolveAdapter() {
      var win = window;
      var adapter = null;
      var reg = win.pluginRegistry;
      var plugin = reg && typeof reg.getActivePlugin === 'function' ? reg.getActivePlugin() : null;
      if (plugin && plugin.adapter && typeof plugin.adapter.insertText === 'function') adapter = plugin.adapter;
      if (!adapter && plugin && typeof plugin.insertText === 'function') adapter = plugin;
      if (!adapter && win.mcpAdapter && typeof win.mcpAdapter.insertText === 'function') adapter = win.mcpAdapter;
      if (!adapter && typeof win.getCurrentAdapter === 'function') adapter = win.getCurrentAdapter();
      return adapter;
    }
    var adapter = resolveAdapter();
    if (!adapter || typeof adapter.insertText !== 'function') return { ok: false, error: 'adapter.insertText missing' };
    await adapter.insertText(${quote(text)});
    return { ok: true };
  })()`;
}

function adapterSubmitFormExpression(options = {}) {
  const suppressLog = options.suppressLog !== false;
    return `(async function() {
    function resolveAdapter() {
      var win = window;
      var adapter = null;
      var reg = win.pluginRegistry;
      var plugin = reg && typeof reg.getActivePlugin === 'function' ? reg.getActivePlugin() : null;
      if (plugin && plugin.adapter && typeof plugin.adapter.submitForm === 'function') adapter = plugin.adapter;
      if (!adapter && plugin && typeof plugin.submitForm === 'function') adapter = plugin;
      if (!adapter && win.mcpAdapter && typeof win.mcpAdapter.submitForm === 'function') adapter = win.mcpAdapter;
      if (!adapter && typeof win.getCurrentAdapter === 'function') adapter = win.getCurrentAdapter();
      return adapter;
    }
    var adapter = resolveAdapter();
    if (!adapter || typeof adapter.submitForm !== 'function') return { ok: false, error: 'adapter.submitForm missing' };
    if (${suppressLog ? 'true' : 'false'}) window.__echoSmokeSuppressNextSubmitLog = true;
    var result = await adapter.submitForm();
    return { ok: true, result: result };
  })()`;
}

function composerStateExpression() {
    return `JSON.stringify((function() {
    var expectedCallIds = ${JSON.stringify(EXPECTED_CALL_IDS)};
    function hasExpectedCallId(text) {
      return expectedCallIds.some(function(callId) { return String(text || '').includes(callId); });
    }
    const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
    const text = input ? String(input.textContent || '') : '';
    return {
      hasTextbox: !!input,
      inputLen: text.length,
      hasCallId: hasExpectedCallId(text),
      hasFunctionResult: text.includes('<function_result') || text.includes('<function_results>'),
      preview: text.slice(0, 300)
    };
  })())`;
}

function submitInitialPromptExpression() {
    return `(function() {
    const textbox = document.querySelector('div[role="textbox"][contenteditable="true"]');
    if (!textbox) return { ok: false, error: 'no textbox' };
    const textboxRect = textbox.getBoundingClientRect();
    const buttons = Array.from(document.querySelectorAll('[data-testid="agent-send-message-button"], [aria-label="提交 AI 消息"], [aria-label="Send"], button[type="submit"]'));
    const candidates = buttons
      .filter(function(button) {
        const rect = button.getBoundingClientRect();
        const className = String(button.className || '');
        return rect.width > 0
          && rect.height > 0
          && button.getAttribute('aria-disabled') !== 'true'
          && !button.disabled
          && !className.includes('expand-button')
          && !button.closest('.function-result-container, .function-block');
      })
      .map(function(button) {
        const rect = button.getBoundingClientRect();
        const dx = (rect.left + rect.width / 2) - (textboxRect.left + textboxRect.width / 2);
        const dy = (rect.top + rect.height / 2) - (textboxRect.top + textboxRect.height / 2);
        return { button: button, score: Math.abs(dx) + Math.abs(dy), html: button.outerHTML.slice(0, 300) };
      })
      .sort(function(a, b) { return a.score - b.score; });
    const selected = candidates[0];
    if (!selected) return { ok: false, error: 'no submit candidate', buttonCount: buttons.length };
    selected.button.click();
    return { ok: true, score: selected.score, html: selected.html };
  })()`;
}

function sendButtonClickTargetExpression() {
    return `(function() {
    var expectedCallIds = ${JSON.stringify(EXPECTED_CALL_IDS)};
    function hasExpectedCallId(text) {
      return expectedCallIds.some(function(callId) { return String(text || '').includes(callId); });
    }
    const textbox = document.querySelector('div[role="textbox"][contenteditable="true"]');
    if (!textbox) return { ok: false, error: 'no textbox' };
    const text = String(textbox.textContent || '');
    const textboxRect = textbox.getBoundingClientRect();
    const buttons = Array.from(document.querySelectorAll('[data-testid="agent-send-message-button"], [aria-label="提交 AI 消息"], [aria-label="Send"], button[type="submit"]'));
    const candidates = buttons
      .filter(function(button) {
        const rect = button.getBoundingClientRect();
        const className = String(button.className || '');
        return rect.width > 0
          && rect.height > 0
          && button.getAttribute('aria-disabled') !== 'true'
          && !button.disabled
          && !className.includes('expand-button')
          && !button.closest('.function-result-container, .function-block');
      })
      .map(function(button) {
        const rect = button.getBoundingClientRect();
        const dx = (rect.left + rect.width / 2) - (textboxRect.left + textboxRect.width / 2);
        const dy = (rect.top + rect.height / 2) - (textboxRect.top + textboxRect.height / 2);
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          score: Math.abs(dx) + Math.abs(dy),
          html: button.outerHTML.slice(0, 300),
          inputLen: text.length,
          hasCallId: hasExpectedCallId(text),
          hasFunctionResult: text.includes('<function_result') || text.includes('<function_results>')
        };
      })
      .sort(function(a, b) { return a.score - b.score; });
    const selected = candidates[0];
    if (!selected) return { ok: false, error: 'no submit candidate', buttonCount: buttons.length, inputLen: text.length };
    return { ok: true, method: 'send-button-cdp', ...selected };
  })()`;
}

async function clickSendButtonViaCdp(cdp) {
    const target = await cdp.evalMain(sendButtonClickTargetExpression(), { timeoutMs: 15000 });
    if (!target || target.ok !== true) return target || { ok: false, error: 'no target result' };
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y }, 10000);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 }, 10000);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 }, 10000);
    return target;
}

async function writeEvidence(evidence) {
    const outputPath = path.join(__dirname, `notion-${SMOKE_KIND}-closed-loop-smoke-${RUN_ID}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(evidence, null, 2));
    console.log(`Evidence: ${outputPath}`);
    return outputPath;
}

function ensureInstructionFileAnswerFixture() {
  if (!IS_INSTRUCTION_FILE_ANSWER_SMOKE) return;
  const fixturePath = path.resolve(__dirname, '..', '..', '..', EXPECTED_FILE_PATH);
  const content = [
    INSTRUCTION_FILE_ANSWER_TASK.marker,
    'The maintenance condition named for this task is: capacitor drift.',
    'This file is a local scratch fixture for the generic instruction smoke.',
    '',
  ].join('\n');
  fs.writeFileSync(fixturePath, content, 'utf8');
}

function extractControlStatesFromStreamEvents(streamEvents, events) {
  const text = extractFinalResponseTextFromStreamEvents(streamEvents || []);
  const callIds = (events || [])
    .filter((event) => event.type === 'toolLoopEvent' && event.detail?.type === 'tool_call_detected' && event.detail?.callId)
    .map((event) => event.detail.callId);
  return extractJsonBlocks(text)
    .map((block) => {
      try { return JSON.parse(block); } catch { return null; }
    })
    .filter((payload) => payload && typeof payload.status === 'string')
    .map((payload) => ({
      status: payload.status,
      callIds: payload.status === 'continue' ? callIds : [],
    }));
}

function normalizeExecutionCalls(events, toolLoopEvents) {
    const toolCallEvents = events.filter((event) => event.type === 'callTool');
  const succeeded = toolLoopEvents.filter((event) => ['tool_execution_succeeded', 'tool_result_inserted', 'tool_result_submitted', 'bridge_handoff_ack'].includes(event.detail?.type) && event.detail?.callId);
  const usedSucceeded = new Set();
    return toolCallEvents.map((event) => {
    const matchingIndex = succeeded.findIndex((loopEvent, index) => {
      return !usedSucceeded.has(index)
        && loopEvent.detail?.toolName === event.name
        && Number(loopEvent.ts || 0) >= Number(event.ts || 0);
    });
    const matchingLoop = matchingIndex >= 0 ? succeeded[matchingIndex] : null;
    if (matchingIndex >= 0) usedSucceeded.add(matchingIndex);
        const result = events.find((candidate) => candidate.type === 'callToolResult' && candidate.name === event.name && candidate.ts >= event.ts);
        return {
            name: event.name,
            callId: matchingLoop?.detail?.callId || null,
            args: event.params,
            resultText: result ? JSON.stringify(result.result || result.resultPreview || '') : '',
      result: result?.result,
        };
    });
}

async function main() {
  const prompt = SMOKE_KIND === 'review_pr_file_context'
    ? buildReviewModulePrFileContextPrompt({ ack: EXPECTED_ACK, nonce: NONCE, callId: CALL_ID })
    : SMOKE_KIND === 'review_file_context'
    ? buildReviewModuleFileContextPrompt({ ack: EXPECTED_ACK, nonce: NONCE, callId: CALL_ID })
    : SMOKE_KIND === 'review_context'
    ? buildReviewModuleContextPrompt({ ack: EXPECTED_ACK, nonce: NONCE, callId: CALL_ID })
    : IS_INSTRUCTION_FILE_ANSWER_SMOKE
    ? buildInstructionFileAnswerPrompt({ nonce: NONCE, callId: CALL_ID })
    : IS_MULTI_ROUND_SMOKE
    ? buildMultiRoundEchoCountPrompt({ nonce: NONCE, callIds: EXPECTED_CALL_IDS, targetCount: MULTI_ROUND_TARGET_COUNT })
    : buildEchoClosedLoopPrompt({ nonce: NONCE, callId: CALL_ID });
  const validateEvidence = SMOKE_KIND === 'review_pr_file_context'
    ? validateReviewModulePrFileContextEvidence
    : SMOKE_KIND === 'review_file_context'
    ? validateReviewModuleFileContextEvidence
    : SMOKE_KIND === 'review_context'
    ? validateReviewModuleContextEvidence
    : IS_INSTRUCTION_FILE_ANSWER_SMOKE
    ? validateInstructionFileAnswerEvidence
    : IS_MULTI_ROUND_SMOKE
    ? validateMultiRoundEchoCountEvidence
    : validateEchoClosedLoopEvidence;
    const evidence = {
    kind: SMOKE_KIND,
    taskKind: IS_INSTRUCTION_FILE_ANSWER_SMOKE ? INSTRUCTION_FILE_ANSWER_TASK.kind : undefined,
        runId: RUN_ID,
        nonce: NONCE,
        callId: CALL_ID,
      expectedCallIds: EXPECTED_CALL_IDS,
      targetCount: IS_MULTI_ROUND_SMOKE ? MULTI_ROUND_TARGET_COUNT : undefined,
    expectedTool: EXPECTED_TOOL,
    expectedAck: EXPECTED_ACK,
        timestamp: new Date().toISOString(),
        autoSubmitDelayMs: AUTO_SUBMIT_DELAY_MS,
    freshChatBefore: false,
        target: null,
        context: null,
        preferencesBefore: null,
        preferencesAfter: null,
        finallyRestoreAttempted: false,
        exposedToolNames: [],
        executedToolCalls: [],
        insertedResults: [],
        finalResponseText: '',
        oracleSource: 'turn-scoped',
        autoSubmitCount: 0,
        events: [],
        streamEvents: [],
        controlStates: [],
        validation: null,
        result: 'PENDING',
        diagnostics: {},
    };

    let cdp = null;
    let isoContextId = null;
    let promptSubmitted = false;

    try {
        console.log(`Notion ${SMOKE_KIND} closed-loop smoke`);
        console.log(`RUN_ID: ${RUN_ID}`);
        console.log(`NONCE: ${NONCE}`);
        console.log(`CALL_ID: ${CALL_ID}`);
        if (IS_MULTI_ROUND_SMOKE) console.log(`EXPECTED_CALL_IDS: ${EXPECTED_CALL_IDS.join(', ')}`);
        if (IS_MULTI_ROUND_SMOKE) console.log(`TARGET_COUNT: ${MULTI_ROUND_TARGET_COUNT}`);
        console.log(`EXPECTED_TOOL: ${EXPECTED_TOOL}`);
        console.log(`AUTO_SUBMIT_DELAY_MS: ${AUTO_SUBMIT_DELAY_MS}`);

        const targets = await getTargets();
        const tab = findNotionTab(targets);
        if (!tab) throw new Error('No Notion AI tab found');
        evidence.freshChatBefore = isFreshNotionChatUrl(tab.url);
        if (!evidence.freshChatBefore) throw new Error('Refusing to reuse existing Notion chat; start a fresh chat first');
        evidence.target = { title: tab.title, url: tab.url };
        console.log(`Target: ${tab.title}`);

        cdp = new Cdp(tab.webSocketDebuggerUrl);
        await cdp.open();
        const iso = await findIsoContext(cdp);
        isoContextId = iso.id;
        evidence.context = iso;
        console.log(`MCP SuperAssistant context: ${iso.id}`);

        const inputState = JSON.parse(await cdp.evalMain(`JSON.stringify({
      inputLen: (document.querySelector('div[role="textbox"][contenteditable="true"]')?.textContent || '').length,
      hasTextbox: !!document.querySelector('div[role="textbox"][contenteditable="true"]')
    })`));
        if (inputState.inputLen !== 0) throw new Error(`Refusing to overwrite non-empty Notion composer: inputLen=${inputState.inputLen}`);
        if (!inputState.hasTextbox) throw new Error('No Notion composer found');

        evidence.preferencesBefore = JSON.parse(await cdp.evalMain(preferencesExpression()) || 'null');
        console.log(`preferencesBefore: ${JSON.stringify(evidence.preferencesBefore)}`);

        evidence.exposedToolNames = parseToolNames(await cdp.evalIso(isoContextId, getToolsExpression(), { awaitPromise: true, timeoutMs: 30000 }));
        if (!evidence.exposedToolNames.includes(EXPECTED_TOOL)) {
          evidence.diagnostics.forceReconnect = parseMaybeJson(await cdp.evalIso(isoContextId, forceReconnectExpression(), { awaitPromise: true, timeoutMs: 30000 }));
          await wait(1500);
          evidence.exposedToolNames = parseToolNames(await cdp.evalIso(isoContextId, getToolsExpression(), { awaitPromise: true, timeoutMs: 30000 }));
        }
        console.log(`tools: ${evidence.exposedToolNames.join(', ')}`);

        ensureInstructionFileAnswerFixture();

        const preflightToolArgs = EXPECTED_TOOL === 'echo'
            ? `{ message: ${quote(NONCE)} }`
            : EXPECTED_TOOL === 'read_workspace_file'
            ? `{ path: ${quote(EXPECTED_FILE_PATH)}, max_bytes: ${EXPECTED_MAX_BYTES} }`
                : '{}';
        const preflightTool = await cdp.evalIso(isoContextId, `(async function() {
      const result = await window.mcpClient.callTool(${quote(EXPECTED_TOOL)}, ${preflightToolArgs});
      return JSON.stringify(result);
    })()`, { awaitPromise: true, timeoutMs: 30000 });
        if (EXPECTED_TOOL === 'echo' && !String(preflightTool).includes(NONCE)) throw new Error('Direct echo preflight did not return current nonce');
        if (EXPECTED_TOOL === 'read_workspace_file' && !String(preflightTool).includes(EXPECTED_FILE_PATH)) throw new Error('Direct read_workspace_file preflight did not return requested path');
        if (IS_INSTRUCTION_FILE_ANSWER_SMOKE && !String(preflightTool).includes(INSTRUCTION_FILE_ANSWER_TASK.marker)) throw new Error('Direct read_workspace_file preflight did not return instruction fixture marker');
        if (!String(preflightTool || '').trim()) throw new Error(`Direct ${EXPECTED_TOOL} preflight returned empty result`);
        evidence.diagnostics.directToolPreflight = parseMaybeJson(preflightTool);

        await cdp.evalMain(setPreferencesExpression({ autoSubmit: true, autoInsert: true, autoExecute: false }));
        const configure = parseMaybeJson(await cdp.evalIso(isoContextId, bridgeConfigExpression({
          enabled: STREAM_BRIDGE_ENABLED,
          cutoffEnabled: STREAM_BRIDGE_ENABLED,
            autoInsert: true,
            autoSubmit: true,
            enableDirectMonitoring: DIRECT_MONITORING_ENABLED,
            toolTimeoutMs: 30000,
            circuitBreaker: { maxToolCallsPerStream: 1 },
            toolAllowlist: [EXPECTED_TOOL],
        }), { timeoutMs: 10000 }));
        if (!configure || configure.ok !== true) throw new Error(`Bridge configure failed: ${JSON.stringify(configure)}`);
        evidence.diagnostics.bridgeConfigBeforeRun = configure.info?.config || null;

        const focusInput = await cdp.evalMain(`(function() {
      const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
      if (!input) return { ok: false, error: 'no textbox' };
      input.focus();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const rect = input.getBoundingClientRect();
      return { ok: true, inputLen: input.textContent.length, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`, { timeoutMs: 15000 });
        if (!focusInput || focusInput.ok !== true) throw new Error(`Prompt focus failed: ${JSON.stringify(focusInput)}`);
        let typeVerify = JSON.parse(await cdp.evalMain(`JSON.stringify({
      inputLen: (document.querySelector('div[role="textbox"][contenteditable="true"]')?.textContent || '').length,
      hasNonce: (document.querySelector('div[role="textbox"][contenteditable="true"]')?.textContent || '').includes(${quote(NONCE)}),
      hasCallId: (document.querySelector('div[role="textbox"][contenteditable="true"]')?.textContent || '').includes(${quote(CALL_ID)})
    })`));
        if (!typeVerify.hasNonce || !typeVerify.hasCallId) {
            evidence.diagnostics.cdpInsertBefore = typeVerify;
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: focusInput.x, y: focusInput.y }, 10000);
            await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: focusInput.x, y: focusInput.y, button: 'left', clickCount: 1 }, 10000);
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: focusInput.x, y: focusInput.y, button: 'left', clickCount: 1 }, 10000);
            await cdp.send('Input.insertText', { text: prompt }, 30000);
            typeVerify = JSON.parse(await cdp.evalMain(`JSON.stringify({
      inputLen: (document.querySelector('div[role="textbox"][contenteditable="true"]')?.textContent || '').length,
      hasNonce: (document.querySelector('div[role="textbox"][contenteditable="true"]')?.textContent || '').includes(${quote(NONCE)}),
      hasCallId: (document.querySelector('div[role="textbox"][contenteditable="true"]')?.textContent || '').includes(${quote(CALL_ID)})
    })`));
            evidence.diagnostics.cdpInsertAfter = typeVerify;
        }
        if (!typeVerify.hasNonce || !typeVerify.hasCallId) {
            evidence.diagnostics.promptAdapterInsert = parseMaybeJson(await cdp.evalIso(isoContextId, adapterInsertTextExpression(prompt), { awaitPromise: true, timeoutMs: 30000 }));
            typeVerify = JSON.parse(await cdp.evalMain(`JSON.stringify({
      inputLen: (document.querySelector('div[role="textbox"][contenteditable="true"]')?.textContent || '').length,
      hasNonce: (document.querySelector('div[role="textbox"][contenteditable="true"]')?.textContent || '').includes(${quote(NONCE)}),
      hasCallId: (document.querySelector('div[role="textbox"][contenteditable="true"]')?.textContent || '').includes(${quote(CALL_ID)})
    })`));
        }
        if (!typeVerify.hasNonce || !typeVerify.hasCallId) {
            evidence.diagnostics.inputInsertFallbackBefore = typeVerify;
            await cdp.evalMain(`(function() {
      const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
      if (!input) return { ok: false, error: 'no textbox' };
      input.focus();
      input.textContent = ${quote(prompt)};
      input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: ${quote(prompt)} }));
      input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: ${quote(prompt)} }));
      return { ok: true, inputLen: input.textContent.length };
    })()`, { timeoutMs: 15000 });
            typeVerify = JSON.parse(await cdp.evalMain(`JSON.stringify({
      inputLen: (document.querySelector('div[role="textbox"][contenteditable="true"]')?.textContent || '').length,
      hasNonce: (document.querySelector('div[role="textbox"][contenteditable="true"]')?.textContent || '').includes(${quote(NONCE)}),
      hasCallId: (document.querySelector('div[role="textbox"][contenteditable="true"]')?.textContent || '').includes(${quote(CALL_ID)})
    })`));
            evidence.diagnostics.inputInsertFallbackAfter = typeVerify;
        }
        if (!typeVerify.hasNonce || !typeVerify.hasCallId) throw new Error(`Prompt injection verification failed: ${JSON.stringify(typeVerify)}`);

        const observerInstall = await cdp.evalIso(isoContextId, installObserversExpression(), { timeoutMs: 10000 });
        evidence.diagnostics.observerInstall = observerInstall;

        const submit = parseMaybeJson(await cdp.evalIso(isoContextId, adapterSubmitFormExpression(), { awaitPromise: true, timeoutMs: 30000 }));
        if (!submit || submit.ok !== true) throw new Error(`Initial prompt submit failed: ${JSON.stringify(submit)}`);
        evidence.diagnostics.initialSubmitMethod = 'adapter-original';
        evidence.diagnostics.initialSubmit = submit;
        promptSubmitted = true;
        console.log('Initial prompt submitted; waiting for bridge events...');

        const start = Date.now();
        let autoSubmitTs = null;
        let firstInsertTs = null;
        let manualLegacySubmitAttempted = false;
        let manualPostSubmitFallbackAttempted = false;
        while (Date.now() - start < LIMITS.maxDurationMs) {
            await wait(LIMITS.pollMs);
            const events = JSON.parse(await cdp.evalIso(isoContextId, 'JSON.stringify(window.__echoSmokeEvents || [])') || '[]');
            const streamEvents = JSON.parse(await cdp.evalIso(isoContextId, 'JSON.stringify(window.__echoSmokeStream || [])') || '[]');
            evidence.events = events;
            evidence.streamEvents = streamEvents;
            evidence.controlStates = extractControlStatesFromStreamEvents(streamEvents, events);

            const toolLoopEvents = events.filter((event) => event.type === 'toolLoopEvent');
            evidence.autoSubmitCount = events.filter((event) => event.type === 'submitForm').length;
            evidence.executedToolCalls = normalizeExecutionCalls(events, toolLoopEvents);
            evidence.insertedResults = events
                .filter((event) => event.type === 'insertText')
                .map((event) => ({
                  name: EXPECTED_TOOL,
                  callId: EXPECTED_CALL_IDS.find((id) => String(event.text || '').includes(id)) || null,
                  text: event.text,
                }));
            const insertEvent = events.find((event) => event.type === 'insertText' && EXPECTED_CALL_IDS.some((id) => String(event.text || '').includes(id)));
            if (insertEvent && !firstInsertTs) firstInsertTs = insertEvent.ts;

              if (FILE_CONTEXT_SMOKE_KINDS.includes(SMOKE_KIND)
                && !manualLegacySubmitAttempted
                && evidence.executedToolCalls.length === 1
                && evidence.insertedResults.length === 1
                && evidence.autoSubmitCount === 0
                && firstInsertTs
                && Date.now() - firstInsertTs >= MANUAL_SUBMIT_FALLBACK_DELAY_MS) {
                manualLegacySubmitAttempted = true;
                const composerState = JSON.parse(await cdp.evalMain(composerStateExpression()) || 'null');
                await cdp.evalIso(isoContextId, `window.__echoSmokeEvents.push({
                  type: "submitForm",
                  method: "send-button",
                  source: "runner-cdp",
                  autoSubmitDelayMs: 0,
                  inputLen: ${Number(composerState?.inputLen || 0)},
                  hasCallId: ${composerState?.hasCallId ? 'true' : 'false'},
                  hasFunctionResult: ${composerState?.hasFunctionResult ? 'true' : 'false'},
                  ts: Date.now()
                }); true`, { timeoutMs: 10000 });
                const clickResult = await clickSendButtonViaCdp(cdp);
                evidence.diagnostics.manualSendButtonSubmit = clickResult;
                await cdp.evalIso(isoContextId, `window.__echoSmokeEvents.push({ type: "submitButtonClickResult", result: ${quote(clickResult)}, ts: Date.now() }); true`, { timeoutMs: 10000 });
                await cdp.evalIso(isoContextId, `window.__echoSmokeEvents.push({ type: "submitFormResult", result: ${clickResult && clickResult.ok ? 'true' : 'false'}, method: "send-button", source: "runner-cdp", ts: Date.now() }); true`, { timeoutMs: 10000 });
              }

            const submitEvent = events.find((event) => event.type === 'submitForm');
            if (submitEvent && !autoSubmitTs) autoSubmitTs = submitEvent.ts;
            const submitResultEvent = events.find((event) => event.type === 'submitFormResult');
            const postSubmitStreamStarted = !!(submitResultEvent && streamEvents.some((event) => event.type === 'stream_start' && event.ts > submitResultEvent.ts));
            if (FILE_CONTEXT_SMOKE_KINDS.includes(SMOKE_KIND)
              && !manualPostSubmitFallbackAttempted
              && submitResultEvent
              && !postSubmitStreamStarted
              && Date.now() - submitResultEvent.ts >= POST_SUBMIT_FALLBACK_DELAY_MS) {
              const composerState = JSON.parse(await cdp.evalMain(composerStateExpression()) || 'null');
              evidence.diagnostics.postSubmitFallbackBefore = composerState;
              if (composerState && composerState.hasCallId && composerState.hasFunctionResult) {
                manualPostSubmitFallbackAttempted = true;
                await cdp.evalIso(isoContextId, 'window.__echoSmokeEvents.push({ type: "manualPostSubmitFallback", ts: Date.now() }); true', { timeoutMs: 10000 });
                evidence.diagnostics.postSubmitFallbackSubmit = await cdp.evalMain(submitInitialPromptExpression(), { timeoutMs: 15000 });
              }
            }
            const postSubmitText = extractFinalResponseTextFromStreamEvents(streamEvents, { afterTs: autoSubmitTs });
            evidence.finalResponseText = postSubmitText;
            evidence.validation = validateEvidence(evidence);
            const runtimeCompleteBeforeFinalRestore = isRuntimeCompleteBeforeFinalRestore(evidence.validation);

            console.log(`[${Math.round((Date.now() - start) / 1000)}s] calls=${evidence.executedToolCalls.length} inserts=${evidence.insertedResults.length} autoSubmits=${evidence.autoSubmitCount} ack=${ACK_PATTERN.test(postSubmitText) && postSubmitText.includes(NONCE)} valid=${evidence.validation.ok} runtimeComplete=${runtimeCompleteBeforeFinalRestore}`);

            const maxExpectedResultSubmits = IS_MULTI_ROUND_SMOKE ? MULTI_ROUND_TARGET_COUNT : 1;
            if (evidence.autoSubmitCount > maxExpectedResultSubmits) break;
            if (runtimeCompleteBeforeFinalRestore) {
              evidence.diagnostics.runtimeCompleteBeforeFinalRestore = true;
              break;
            }
            if (evidence.validation.ok) break;
        }

        evidence.validation = validateEvidence(evidence);
        evidence.result = evidence.validation.ok ? 'PASS' : 'FAIL';
    } catch (error) {
        evidence.result = 'ERROR';
        evidence.diagnostics.error = error && error.stack ? error.stack : String(error);
        console.error(evidence.diagnostics.error);
    } finally {
        if (cdp && isoContextId) {
            evidence.finallyRestoreAttempted = true;
            try {
                await cdp.evalMain(setPreferencesExpression(SAFE_FINAL_PREFERENCES));
                const bridgeAfter = await cdp.evalIso(isoContextId, bridgeConfigExpression({
                    enabled: false,
                    cutoffEnabled: true,
                    autoInsert: true,
                    autoSubmit: false,
                    enableDirectMonitoring: true,
                    toolTimeoutMs: 30000,
                    circuitBreaker: { maxToolCallsPerStream: 1 },
                    toolAllowlist: [EXPECTED_TOOL],
                }), { timeoutMs: 10000 });
                evidence.diagnostics.bridgeConfigAfterRestore = parseMaybeJson(bridgeAfter)?.info?.config || null;
            } catch (restoreError) {
                evidence.diagnostics.restoreError = restoreError && restoreError.stack ? restoreError.stack : String(restoreError);
            }
            try {
                evidence.diagnostics.observerRestore = await cdp.evalIso(isoContextId, restoreObserversExpression, { timeoutMs: 10000 });
            } catch (restoreObserverError) {
                evidence.diagnostics.observerRestoreError = String(restoreObserverError && restoreObserverError.message || restoreObserverError);
            }
            try {
                evidence.preferencesAfter = JSON.parse(await cdp.evalMain(preferencesExpression()) || 'null');
            } catch (afterError) {
                evidence.diagnostics.preferencesAfterError = String(afterError && afterError.message || afterError);
            }
            evidence.validation = validateEvidence(evidence);
            if (evidence.result !== 'PASS') evidence.result = evidence.validation.ok ? 'PASS' : evidence.result;
        }
        const outputPath = await writeEvidence(evidence);
        console.log(JSON.stringify({ result: evidence.result, validation: evidence.validation, outputPath, promptSubmitted }, null, 2));
        if (cdp) cdp.close();
    }

    if (evidence.result !== 'PASS') process.exit(1);
}

main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
});
