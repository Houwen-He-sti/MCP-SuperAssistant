#!/usr/bin/env node
/**
 * Phase 1B — Notion Pipeline Activation Preflight
 *
 * Structured CDP diagnostic that checks every layer of the MCP-SuperAssistant
 * Notion pipeline, reports pass/fail/unknown per layer, and identifies the
 * first confirmed failing layer.
 *
 * Layers checked (bottom to top):
 *   L-2  Extension manifest / content script injection
 *   L-1  Isolated world context presence
 *   L0   applicationInit observable side effects
 *   L1   MAIN world fetch interceptor activation
 *   L2   MAIN ↔ ISOLATED bridge observability
 *   L6   MCP client presence / readiness
 *   L9   Automation service activation
 *   L10  Notion adapter DOM readiness
 *   L14  False-positive guard (protocol prompt text vs real tool call)
 *   ERR  Console / runtime errors
 *
 * Usage:
 *   node scripts/e2e-notion-pipeline-preflight.cjs
 *
 * Requires: Chrome / Comet with CDP on port 9222, Notion page open.
 * Does NOT modify any production code.
 *
 * @see plans/notion-ai-all-tools-test.md
 * @see docs/engineering/browser-runtime-observation-first.md
 */

const { preflight, getTargets, sleep } = require('./lib/cdp-preflight.cjs');
const {
    getTopFrameId,
    selectNotionMainContext,
    selectExtensionIsolatedContext,
    assessFetchInterceptor,
} = require('./lib/context-selection.cjs');
const WebSocket = require('ws');

// ============================================================================
// Helpers
// ============================================================================

function status(pass, detail) {
    if (pass === true) return { status: 'PASS', detail };
    if (pass === false) return { status: 'FAIL', detail };
    return { status: 'UNKNOWN', detail };
}

let msgId = 0;
function createCdpSession(ws) {
    const send = (method, params) => new Promise((resolve, reject) => {
        const myId = ++msgId;
        const timeout = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 10000);
        const handler = raw => {
            const obj = JSON.parse(raw);
            if (obj.id === myId) {
                clearTimeout(timeout);
                ws.off('message', handler);
                resolve(obj);
            }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
    });
    const evalIn = async (contextId, expression) => {
        const r = await send('Runtime.evaluate', { contextId, expression, returnByValue: true });
        return r.result?.result?.value;
    };
    return { send, evalIn };
}

// ============================================================================
// Main
// ============================================================================

(async () => {
    const report = {};
    let firstFail = null;

    function record(layer, result) {
        report[layer] = result;
        if (result.status === 'FAIL' && !firstFail) {
            firstFail = layer;
        }
    }

    // ── L-2: Extension & page preflight ────────────────────────────────────
    let ext, tab;
    try {
        const pf = await preflight();
        ext = { id: pf.extensionId, name: pf.extensionName };
        tab = pf.tab;
        record('L-2 Extension/Manifest', status(true, `${ext.name} (${ext.id}), page: ${tab.url.slice(0, 80)}`));
    } catch (e) {
        record('L-2 Extension/Manifest', status(false, e.message));
        printReport(report, firstFail);
        process.exit(1);
    }

    // Connect to Notion tab
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));
    const cdp = createCdpSession(ws);

    // Enumerate all execution contexts
    const contexts = [];
    ws.on('message', raw => {
        const obj = JSON.parse(raw);
        if (obj.method === 'Runtime.executionContextCreated') {
            contexts.push(obj.params.context);
        }
    });
    await cdp.send('Runtime.enable');

    // Get frame tree to identify top frame
    let topFrameId = null;
    try {
        const frameTreeResult = await cdp.send('Page.enable');
        const ftResult = await cdp.send('Page.getFrameTree');
        topFrameId = getTopFrameId(ftResult);
        console.log(`📐 Top frame ID: ${topFrameId || 'unknown'}`);
    } catch (e) {
        console.log(`⚠️  Frame tree unavailable: ${e.message} — using fallback context selection`);
    }

    await sleep(1000); // let contexts arrive

    // ── L-1: Isolated world context ────────────────────────────────────────
    const isolatedCtx = selectExtensionIsolatedContext(contexts, ext.id, topFrameId);

    if (isolatedCtx) {
        record('L-1 Isolated World', status(true, `contextId=${isolatedCtx.id}, name="${isolatedCtx.name}", frameId=${isolatedCtx.auxData?.frameId || 'unknown'}`));
    } else {
        // Fallback: try by extension origin without frame filtering
        const byOrigin = contexts.filter(c => c.origin && c.origin.includes(ext.id));
        if (byOrigin.length > 0) {
            record('L-1 Isolated World', status(true, `Found ${byOrigin.length} contexts by extension ID (no frame match). First: id=${byOrigin[0].id}`));
        } else {
            record('L-1 Isolated World', status(false, `No extension context found. Total contexts: ${contexts.length}`));
        }
    }

    // Get the extension context ID for further checks (frame-aware)
    const extContextId = isolatedCtx?.id;

    // ── L0: applicationInit side effects ───────────────────────────────────
    if (extContextId) {
        try {
            const initState = await cdp.evalIn(extContextId, `
        (function() {
          try {
            return JSON.stringify({
              // DOM evidence of successful init
              sidebarHost: !!document.getElementById('mcp-sidebar-shadow-host'),
              rootEl: !!document.getElementById('mcp-superassistant-root'),
              allMcpEls: [...document.querySelectorAll('[id*="mcp"]')].map(e => e.id).slice(0, 10),
              // Window-level evidence
              hasMcpClient: typeof window.mcpClient !== 'undefined',
              mcpClientReady: window.mcpClient?.isReady?.() || false,
              hasPluginRegistry: typeof window.pluginRegistry !== 'undefined',
              hasAutomationService: typeof window.automationService !== 'undefined',
              // Chrome runtime health
              chromeRuntimeId: chrome?.runtime?.id || 'none',
              chromeRuntimeError: chrome?.runtime?.lastError?.message || 'none',
              // MCP-related window keys
              mcpKeys: Object.keys(window).filter(k => k.toLowerCase().includes('mcp')).slice(0, 20),
              // localStorage UI store
              uiStore: (() => {
                try {
                  const s = JSON.parse(localStorage.getItem('mcp-super-assistant-ui-store') || '{}');
                  return {
                    autoInsert: s?.state?.autoInsert,
                    autoSubmit: s?.state?.autoSubmit,
                    mcpEnabled: s?.state?.mcpEnabled,
                  };
                } catch { return 'parse_error'; }
              })(),
            });
          } catch(e) { return JSON.stringify({ error: e.message }); }
        })()
      `);

            const state = JSON.parse(initState || '{}');
            const initSucceeded = state.rootEl && state.hasMcpClient && state.chromeRuntimeId !== 'none';
            const initPartial = state.sidebarHost && !state.rootEl;

            if (initSucceeded) {
                record('L0 applicationInit', status(true, `rootEl=true, mcpClient=${state.mcpClientReady ? 'ready' : 'exists'}, chromeId=${state.chromeRuntimeId.slice(0, 8)}...`));
            } else if (initPartial) {
                record('L0 applicationInit', status(false, `PARTIAL: sidebarHost=true but rootEl=false. chromeId=${state.chromeRuntimeId}, mcpClient=${state.hasMcpClient}, pluginRegistry=${state.hasPluginRegistry}`));
            } else if (state.error) {
                record('L0 applicationInit', status(false, `ERROR: ${state.error}`));
            } else {
                record('L0 applicationInit', status(false, `FAILED: rootEl=${state.rootEl}, sidebarHost=${state.sidebarHost}, mcpClient=${state.hasMcpClient}, chromeId=${state.chromeRuntimeId}`));
            }

            // Store for later layers
            report._initState = state;
        } catch (e) {
            record('L0 applicationInit', status(false, `CDP eval error: ${e.message}`));
        }
    } else {
        record('L0 applicationInit', status(null, 'Skipped — no extension context found'));
    }

    // ── L1: MAIN world fetch interceptor ───────────────────────────────────
    // Use frame-aware selection — must pick top frame, not iframe
    const mainCtx = selectNotionMainContext(contexts, topFrameId);

    if (mainCtx) {
        try {
            const fetchState = await cdp.evalIn(mainCtx.id, `
        (function() {
          try {
            return JSON.stringify({
              // Install marker
              installKey: !!window['__MCP_SA_NOTION_STREAM_INTERCEPTOR_INSTALLED_V1__'],
              // Fetch wrapped marker
              fetchWrapped: !!window.fetch?.__mcpSaWrapped,
              // Fetch identity
              fetchName: window.fetch?.name || 'unknown',
              fetchIsNative: window.fetch?.toString()?.includes('[native code]') || false,
              // Any MCP-related keys
              mcpMainKeys: Object.keys(window).filter(k => k.toLowerCase().includes('mcp')).slice(0, 15),
              // Legacy marker (old diag scripts checked this)
              legacyOriginalFetch: typeof window.__mcpOriginalFetch !== 'undefined',
            });
          } catch(e) { return JSON.stringify({ error: e.message }); }
        })()
      `);

            const fs = JSON.parse(fetchState || '{}');

            // Use Sentry-aware assessment
            const assessment = assessFetchInterceptor(fs);
            record('L1 MAIN Fetch Interceptor', status(
                assessment.status === 'PASS',
                `[${assessment.tier}] ${assessment.detail}. fetchName="${fs.fetchName}"`
            ));

            report._fetchState = fs;
        } catch (e) {
            record('L1 MAIN Fetch Interceptor', status(false, `CDP eval error: ${e.message}`));
        }
    } else {
        record('L1 MAIN Fetch Interceptor', status(null, `No MAIN world context found for notion.so. Total contexts: ${contexts.length}`));
    }

    // ── L2: Bridge observability ───────────────────────────────────────────
    // Check if the bridge is listening (isolated side)
    if (extContextId) {
        try {
            const bridgeState = await cdp.evalIn(extContextId, `
        (function() {
          try {
            // The bridge registers a message listener. Check for any evidence.
            // We can't directly enumerate listeners, but we can check:
            // 1. Whether the bridge module's variables are accessible
            // 2. Whether config was sent to MAIN world
            return JSON.stringify({
              // Look for bridge-related indicators in window
              hasBridgeKeys: Object.keys(window).filter(k => k.includes('bridge') || k.includes('Bridge')).slice(0, 10),
              // Check if stream events module has listeners registered
              hasStreamKeys: Object.keys(window).filter(k => k.includes('stream') || k.includes('Stream')).slice(0, 10),
            });
          } catch(e) { return JSON.stringify({ error: e.message }); }
        })()
      `);
            const bs = JSON.parse(bridgeState || '{}');
            // Bridge is hard to observe directly. Mark as UNKNOWN unless we have evidence
            record('L2 Bridge (MAIN↔ISOLATED)', status(null, `Indirect check only. Bridge keys: ${JSON.stringify(bs.hasBridgeKeys)}, Stream keys: ${JSON.stringify(bs.hasStreamKeys)}`));
        } catch (e) {
            record('L2 Bridge (MAIN↔ISOLATED)', status(null, `Cannot verify: ${e.message}`));
        }
    } else {
        record('L2 Bridge (MAIN↔ISOLATED)', status(null, 'Skipped — no extension context'));
    }

    // ── L6: MCP Client ─────────────────────────────────────────────────────
    const initState = report._initState || {};
    if (initState.hasMcpClient) {
        record('L6 MCP Client', status(initState.mcpClientReady,
            initState.mcpClientReady
                ? 'mcpClient exists and isReady()=true'
                : 'mcpClient exists but isReady()=false'));
    } else if (extContextId) {
        record('L6 MCP Client', status(false, 'window.mcpClient is undefined'));
    } else {
        record('L6 MCP Client', status(null, 'Skipped — no extension context'));
    }

    // ── L9: Automation Service ─────────────────────────────────────────────
    if (extContextId) {
        try {
            const autoState = await cdp.evalIn(extContextId, `
        (function() {
          try {
            // Check UI store for automation preferences
            const uiStore = JSON.parse(localStorage.getItem('mcp-super-assistant-ui-store') || '{}');
            return JSON.stringify({
              autoInsert: uiStore?.state?.autoInsert ?? 'not_set',
              autoSubmit: uiStore?.state?.autoSubmit ?? 'not_set',
              autoExecute: uiStore?.state?.autoExecute ?? 'not_set',
              mcpEnabled: uiStore?.state?.mcpEnabled ?? 'not_set',
              // Check window-level evidence
              hasAutomationService: typeof window.automationService !== 'undefined',
              // The automation service subscribes to eventBus. Check event bus presence.
              hasEventBus: typeof window._appDebug?.eventBus !== 'undefined',
            });
          } catch(e) { return JSON.stringify({ error: e.message }); }
        })()
      `);
            const auto = JSON.parse(autoState || '{}');

            // Automation service doesn't expose itself on window by default,
            // so we rely on: (1) event bus presence (from _appDebug), (2) store config
            const serviceEvidence = auto.hasAutomationService || auto.hasEventBus;
            if (serviceEvidence) {
                record('L9 Automation Service', status(true, `eventBus=${auto.hasEventBus}, autoInsert=${auto.autoInsert}, autoSubmit=${auto.autoSubmit}`));
            } else {
                // Check if preferences at least exist in store
                const hasPrefs = auto.autoInsert !== 'not_set';
                record('L9 Automation Service', status(null,
                    `No direct service evidence. Store: autoInsert=${auto.autoInsert}, autoSubmit=${auto.autoSubmit}, mcpEnabled=${auto.mcpEnabled}. eventBus=${auto.hasEventBus}. ${hasPrefs ? 'Preferences exist but service activation unconfirmed.' : 'No preferences found.'}`));
            }
        } catch (e) {
            record('L9 Automation Service', status(null, `Cannot verify: ${e.message}`));
        }
    } else {
        record('L9 Automation Service', status(null, 'Skipped — no extension context'));
    }

    // ── L10: Notion Adapter DOM ────────────────────────────────────────────
    if (mainCtx) {
        try {
            const domState = await cdp.evalIn(mainCtx.id, `
        (function() {
          try {
            return JSON.stringify({
              // Native agent selectors
              chatInput: !!document.querySelector('div[role="textbox"][contenteditable="true"]'),
              submitButton: !!document.querySelector('[data-testid="agent-send-message-button"]'),
              chatContent: !!document.querySelector('.notion-app-inner'),
              // General page state
              bodyChildCount: document.body?.children?.length || 0,
              chatArea: !!document.querySelector('[class*="chat"], [data-testid*="chat"]'),
              // Is it an agent page?
              isAgentPage: window.location.pathname.includes('/agent/'),
              currentPath: window.location.pathname,
            });
          } catch(e) { return JSON.stringify({ error: e.message }); }
        })()
      `);
            const dom = JSON.parse(domState || '{}');

            const domReady = dom.chatInput && dom.chatContent;
            record('L10 Notion Adapter DOM', status(domReady,
                `chatInput=${dom.chatInput}, submitBtn=${dom.submitButton}, chatContent=${dom.chatContent}, isAgent=${dom.isAgentPage}, path=${dom.currentPath}`));
        } catch (e) {
            record('L10 Notion Adapter DOM', status(false, `CDP eval error: ${e.message}`));
        }
    } else {
        record('L10 Notion Adapter DOM', status(null, 'Skipped — no MAIN context'));
    }

    // ── L14: False-Positive Guard ──────────────────────────────────────────
    if (mainCtx) {
        try {
            const fpState = await cdp.evalIn(mainCtx.id, `
        (function() {
          try {
            const text = document.body?.innerText || '';
            const indices = [];
            let pos = 0;
            while ((pos = text.indexOf('function_call_start', pos)) !== -1) {
              indices.push(pos);
              pos += 20;
            }
            return JSON.stringify({
              totalOccurrences: indices.length,
              contexts: indices.slice(0, 5).map(i => ({
                before30: text.substring(Math.max(0, i - 30), i).replace(/\\n/g, ' '),
                match: text.substring(i, i + 50).replace(/\\n/g, ' '),
              })),
            });
          } catch(e) { return JSON.stringify({ error: e.message }); }
        })()
      `);
            const fp = JSON.parse(fpState || '{}');
            const hasFP = fp.totalOccurrences > 0;
            record('L14 False-Positive Guard', status(!hasFP,
                hasFP
                    ? `${fp.totalOccurrences} occurrences of "function_call_start" in page text — likely from bridge prompt, NOT real tool calls. Contexts: ${JSON.stringify(fp.contexts)}`
                    : 'No "function_call_start" text found on page — clean baseline'));
        } catch (e) {
            record('L14 False-Positive Guard', status(null, `Cannot verify: ${e.message}`));
        }
    } else {
        record('L14 False-Positive Guard', status(null, 'Skipped'));
    }

    // ── Console Errors ─────────────────────────────────────────────────────
    // Enable console log collection briefly
    try {
        const consoleErrors = [];
        const consoleHandler = raw => {
            const obj = JSON.parse(raw);
            if (obj.method === 'Runtime.exceptionThrown') {
                const ex = obj.params.exceptionDetails;
                consoleErrors.push({
                    text: ex.text || '',
                    description: ex.exception?.description?.slice(0, 200) || '',
                    url: ex.url || '',
                    line: ex.lineNumber,
                });
            }
        };
        ws.on('message', consoleHandler);
        // Wait a moment for any queued errors
        await sleep(500);
        ws.off('message', consoleHandler);

        if (consoleErrors.length > 0) {
            record('ERR Console Errors', status(false,
                `${consoleErrors.length} runtime exceptions. First: ${consoleErrors[0].text} — ${consoleErrors[0].description.slice(0, 100)}`));
        } else {
            record('ERR Console Errors', status(true, 'No runtime exceptions observed'));
        }
    } catch (e) {
        record('ERR Console Errors', status(null, `Cannot check: ${e.message}`));
    }

    // ── Cleanup & Report ───────────────────────────────────────────────────
    await cdp.send('Runtime.disable');
    ws.close();

    printReport(report, firstFail);
})().catch(e => {
    console.error('❌ Preflight crashed:', e.message);
    process.exit(2);
});

// ============================================================================
// Report Printer
// ============================================================================

function printReport(report, firstFail) {
    console.log('\n' + '='.repeat(70));
    console.log('  NOTION PIPELINE ACTIVATION PREFLIGHT REPORT');
    console.log('  ' + new Date().toISOString());
    console.log('='.repeat(70));

    const icons = { PASS: '✅', FAIL: '❌', UNKNOWN: '❓' };

    for (const [layer, result] of Object.entries(report)) {
        if (layer.startsWith('_')) continue; // skip internal state
        const icon = icons[result.status] || '?';
        console.log(`\n${icon} ${layer}: ${result.status}`);
        console.log(`   ${result.detail}`);
    }

    console.log('\n' + '-'.repeat(70));
    if (firstFail) {
        console.log(`\n🔴 FIRST CONFIRMED FAILING LAYER: ${firstFail}`);
        console.log('   Fix this layer before testing upper layers.');
    } else {
        const unknowns = Object.entries(report).filter(([k, v]) => !k.startsWith('_') && v.status === 'UNKNOWN');
        if (unknowns.length > 0) {
            console.log(`\n🟡 No confirmed failures, but ${unknowns.length} layer(s) could not be verified:`);
            unknowns.forEach(([k]) => console.log(`   - ${k}`));
        } else {
            console.log('\n🟢 ALL LAYERS PASSED');
        }
    }
    console.log('');
}
