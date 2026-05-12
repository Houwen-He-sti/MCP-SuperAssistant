const http = require('http');
const WebSocket = require('ws');

function getJSON(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
    });
}

// Parse CLI args
const args = process.argv.slice(2);
let port = 9222;
let urlFilter = 'notion.so';
let timeoutMs = 5000;
let shouldReload = false;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) port = parseInt(args[++i], 10);
    else if (args[i] === '--url-filter' && args[i + 1]) urlFilter = args[++i];
    else if (args[i] === '--timeout-ms' && args[i + 1]) timeoutMs = parseInt(args[++i], 10);
    else if (args[i] === '--reload') shouldReload = true;
}

/**
 * Observation-only CDP probe for Notion adapter debug hook.
 *
 * Probes ALL execution contexts (page + extension isolated worlds)
 * to find __MCP_SUPERASSISTANT_DEBUG__ and getCurrentNotionContext().
 *
 * Does NOT: click, type, submit, inject UI, execute MCP tools.
 * Returns structured diagnostic matrix.
 *
 * CLI options:
 *   --port <number>       CDP remote debugging port (default: 9222)
 *   --url-filter <string> Substring to match tab URL (default: "notion.so")
 *   --timeout-ms <number> Per-context eval timeout (default: 5000)
 *   --reload              Opt-in: reload the page before probing (default: off)
 */
async function probeNotionContext() {
    try {
        const tabs = await getJSON(`http://127.0.0.1:${port}/json/list`);
        const notionTab = tabs.find(t => t.url && t.url.includes(urlFilter));

        if (!notionTab) {
            console.log(JSON.stringify({ error: `No tab found matching filter: ${urlFilter}` }, null, 2));
            process.exit(0);
        }

        const wsUrl = notionTab.webSocketDebuggerUrl;
        const ws = new WebSocket(wsUrl);
        let msgId = 1;
        const contexts = [];

        // pending: requestId -> { contextId, origin, name }
        const pending = new Map();

        // probeResults: every context gets exactly one entry
        const probeResults = [];
        // Track which contextIds have been resolved (success, error, or no_value)
        const resolvedContextIds = new Set();

        let domDivResult = null;
        let domDivRequestId = null;
        let loadFired = false;
        let resolved = false;
        let probesStarted = false;

        function finish() {
            if (resolved) return;
            resolved = true;
            ws.close();

            // Ensure every context has a probe result entry
            for (const ctx of contexts) {
                if (!resolvedContextIds.has(ctx.id)) {
                    // This context never responded — mark as timeout
                    probeResults.push({
                        contextId: ctx.id,
                        origin: ctx.origin,
                        name: ctx.name,
                        status: 'timeout',
                        hasDebugRoot: false,
                        hasGetCurrentNotionContext: false,
                        result: { ok: false, error: 'timeout' }
                    });
                }
            }

            const successfulContexts = probeResults.filter(
                r => r.status === 'success' && r.result && r.result.ok === true
            );
            const debugRootFound = probeResults.some(r => r.hasDebugRoot);
            const contextFunctionFound = probeResults.some(r => r.hasGetCurrentNotionContext);

            const failureKinds = new Set();
            probeResults.forEach(r => {
                if (r.status !== 'success') {
                    failureKinds.add(r.status);
                } else if (r.result && r.result.error) {
                    failureKinds.add(r.result.error);
                }
            });

            // Build domDivObservation summary (no raw content)
            // Defensive: don't assume specific nested payload shape since
            // the debug hook writer may change independently.
            const domDivSummary = (() => {
                if (!domDivResult) {
                    return { found: false, textPresent: false, textLength: 0, topLevelKeys: [], hasAnyId: false };
                }
                const found = !!domDivResult.domDivFound;
                const textPresent = !!(domDivResult.context || domDivResult.error);
                const textLength = found ? JSON.stringify(domDivResult).length : 0;
                const ctx = domDivResult.context;
                const topLevelKeys = ctx ? Object.keys(ctx) : [];
                // Check for any ID-like field (defensive: don't assume .page.id vs .page.pageId)
                const hasAnyId = ctx
                    ? JSON.stringify(ctx).includes('"id"') || JSON.stringify(ctx).includes('"pageId"') || JSON.stringify(ctx).includes('"uuid"')
                    : false;
                return { found, textPresent, textLength, topLevelKeys, hasAnyId };
            })();

            // Redacted target info from first successful result
            let targetInfo = { tabTitlePresent: false, urlRedacted: true, origin: '', pathnamePreview: '' };
            const validResult = probeResults.find(r => r.status === 'success' && r.target);
            if (validResult) {
                targetInfo = validResult.target;
            }

            console.log(JSON.stringify({
                probe: 'notion-context-observation',
                source: 'real-browser-cdp',
                timestamp: Date.now(),
                reloadPerformed: shouldReload,
                target: targetInfo,
                domDivObservation: domDivSummary,
                executionContexts: contexts.map(c => ({
                    id: c.id,
                    name: c.name,
                    origin: c.origin,
                    isDefault: c.auxData && c.auxData.isDefault,
                    type: c.origin && c.origin.startsWith('chrome-extension://')
                        ? 'isolated'
                        : (c.auxData && c.auxData.isDefault ? 'default' : 'other')
                })),
                probeResults: probeResults.map(r => ({
                    contextId: r.contextId,
                    origin: r.origin || undefined,
                    status: r.status,
                    hasDebugRoot: r.hasDebugRoot,
                    hasGetCurrentNotionContext: r.hasGetCurrentNotionContext,
                    result: r.result
                })),
                summary: {
                    contextsChecked: contexts.length,
                    debugRootFound,
                    contextFunctionFound,
                    successfulContextIds: successfulContexts.map(r => r.contextId),
                    failureKinds: Array.from(failureKinds)
                }
            }, null, 2));
        }

        function runProbes() {
            if (probesStarted) return;
            probesStarted = true;

            // Probe 1: Check DOM div (runs in default context)
            domDivRequestId = msgId++;
            ws.send(JSON.stringify({
                id: domDivRequestId,
                method: 'Runtime.evaluate',
                params: {
                    expression: `(() => {
              const el = document.getElementById('mcp-debug-observation');
              if (el) {
                try { return JSON.parse(el.innerText); }
                catch(e) { return { domDivFound: true, parseError: e.message }; }
              }
              return { domDivFound: false };
            })()`,
                    returnByValue: true
                }
            }));

            // Probe 2: Evaluate in EACH execution context
            const probeExpression = `(() => {
          const root = globalThis.__MCP_SUPERASSISTANT_DEBUG__;

          let redactedHref = location.href;
          let redactedPathname = location.pathname;
          let origin = location.origin;
          try {
            const urlObj = new URL(location.href);
            urlObj.pathname = urlObj.pathname.slice(0, 10) + '...';
            redactedHref = urlObj.toString();
            redactedPathname = location.pathname.slice(0, 10) + '...';
            origin = urlObj.origin;
          } catch(e) {}

          const res = {
            target: {
              tabTitlePresent: !!document.title,
              urlRedacted: true,
              origin: origin,
              pathnamePreview: redactedPathname
            },
            hasDebugRoot: !!root,
            debugKeys: root ? Object.keys(root) : [],
            hasGetCurrentNotionContext: typeof root?.getCurrentNotionContext === 'function',
            result: null
          };

          if (!res.hasDebugRoot) {
            res.result = { ok: false, error: 'debug root missing' };
          } else if (!res.hasGetCurrentNotionContext) {
            res.result = { ok: false, error: 'getCurrentNotionContext missing' };
          } else {
            try {
              const raw = root.getCurrentNotionContext();
              if (raw === undefined || raw === null) {
                res.result = { ok: false, error: 'getCurrentNotionContext returned ' + String(raw) };
              } else {
                if (raw && raw.context && raw.context.page) {
                  const urlObj = new URL(raw.context.page.url || location.href);
                  urlObj.pathname = urlObj.pathname.slice(0, 10) + '...';
                  raw.context.page.urlRedacted = urlObj.toString();
                  delete raw.context.page.url;
                }
                res.result = raw;
              }
            } catch (e) {
              res.result = { ok: false, error: e instanceof Error ? e.message : String(e) };
            }
          }
          return res;
        })()`;

            if (contexts.length === 0) {
                finish();
                return;
            }

            for (const ctx of contexts) {
                const requestId = msgId++;
                pending.set(requestId, {
                    contextId: ctx.id,
                    origin: ctx.origin,
                    name: ctx.name
                });
                ws.send(JSON.stringify({
                    id: requestId,
                    method: 'Runtime.evaluate',
                    params: {
                        expression: probeExpression,
                        returnByValue: true,
                        contextId: ctx.id
                    }
                }));
            }

            // Fallback timeout for contexts that never respond
            setTimeout(() => finish(), timeoutMs);
        }

        ws.on('open', async () => {
            ws.send(JSON.stringify({ id: msgId++, method: 'Page.enable' }));
            ws.send(JSON.stringify({ id: msgId++, method: 'Runtime.enable' }));
            if (shouldReload) {
                ws.send(JSON.stringify({ id: msgId++, method: 'Page.reload' }));
            } else {
                // Wait a bit for contexts to be reported
                setTimeout(runProbes, 1000);
            }
        });

        ws.on('message', async (data) => {
            const resp = JSON.parse(data);

            // Track execution contexts
            if (resp.method === 'Runtime.executionContextCreated') {
                const ctx = resp.params.context;
                contexts.push({
                    id: ctx.id,
                    origin: ctx.origin || 'unknown',
                    name: ctx.name || '',
                    auxData: ctx.auxData || null
                });
            }

            // After page load + extension injection delay, run probes
            if (resp.method === 'Page.loadEventFired' && shouldReload && !loadFired) {
                loadFired = true;
                setTimeout(runProbes, 3000);
            }

            // Collect DOM div result
            if (resp.id === domDivRequestId && resp.result && resp.result.result) {
                domDivResult = resp.result.result.value || null;
            }

            // Collect per-context probe results via pending map
            if (pending.has(resp.id)) {
                const meta = pending.get(resp.id);
                pending.delete(resp.id);

                if (!resolvedContextIds.has(meta.contextId)) {
                    resolvedContextIds.add(meta.contextId);

                    if (resp.result && resp.result.result && resp.result.result.value) {
                        const val = resp.result.result.value;
                        const isSuccess = val.result && val.result.ok === true;
                        probeResults.push({
                            contextId: meta.contextId,
                            origin: meta.origin,
                            name: meta.name,
                            status: isSuccess ? 'success' : 'eval_error',
                            hasDebugRoot: !!val.hasDebugRoot,
                            hasGetCurrentNotionContext: !!val.hasGetCurrentNotionContext,
                            target: val.target || undefined,
                            result: val.result || { ok: false, error: 'no_result_field' }
                        });
                    } else {
                        // CDP returned but no value (eval threw, or result.exceptionDetails)
                        const exceptionDetail = (resp.result && resp.result.exceptionDetails)
                            ? resp.result.exceptionDetails.text || 'cdp_exception'
                            : 'no_value';
                        probeResults.push({
                            contextId: meta.contextId,
                            origin: meta.origin,
                            name: meta.name,
                            status: 'no_value',
                            hasDebugRoot: false,
                            hasGetCurrentNotionContext: false,
                            result: { ok: false, error: exceptionDetail }
                        });
                    }
                }

                // Check if all pending requests have been resolved
                if (resolvedContextIds.size >= contexts.length) {
                    finish();
                }
            }
        });

        ws.on('error', (err) => {
            console.log(JSON.stringify({ error: err.message }, null, 2));
            process.exit(1);
        });

    } catch (err) {
        console.log(JSON.stringify({ error: err.message }, null, 2));
    }
}

probeNotionContext();
