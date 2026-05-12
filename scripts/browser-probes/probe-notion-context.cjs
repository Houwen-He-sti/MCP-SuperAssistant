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

function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
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
        const probeResults = [];
        let domDivResult = null;
        let loadFired = false;
        let resolved = false;
        let responsesReceived = 0;
        let probesStarted = false;

        function finish() {
            if (resolved) return;
            resolved = true;
            ws.close();

            const successfulContexts = probeResults.filter(r => r.value && r.value.result && r.value.result.ok === true);
            const debugRootFound = probeResults.some(r => r.value && r.value.hasDebugRoot);
            const contextFunctionFound = probeResults.some(r => r.value && r.value.hasGetCurrentNotionContext);

            const failureKinds = new Set();
            probeResults.forEach(r => {
                if (r.value && r.value.result && r.value.result.error) {
                    failureKinds.add(r.value.result.error);
                }
            });

            // Check for timeouts
            const respondedContextIds = new Set(probeResults.map(r => r.contextId));
            contexts.forEach(c => {
                if (!respondedContextIds.has(c.id)) {
                    failureKinds.add(`timeout_in_context_${c.id}`);
                    probeResults.push({
                        contextId: c.id,
                        value: { error: "timeout" }
                    });
                }
            });

            let targetInfo = { tabTitlePresent: false, urlRedacted: true, origin: "", pathnamePreview: "" };
            const validResult = probeResults.find(r => r.value && r.value.target);
            if (validResult) {
                targetInfo = validResult.value.target;
            }

            console.log(JSON.stringify({
                probe: "notion-context-observation",
                source: "real-browser-cdp",
                timestamp: Date.now(),
                target: targetInfo,
                domDivObservation: domDivResult ? {
                    found: true,
                    textPresent: !!domDivResult.context || !!domDivResult.error,
                    textLength: JSON.stringify(domDivResult).length
                } : { found: false },
                executionContexts: contexts.map(c => ({
                    id: c.id,
                    name: c.name,
                    origin: c.origin,
                    isDefault: c.auxData && c.auxData.isDefault,
                    type: c.origin && c.origin.startsWith('chrome-extension://') ? 'isolated' : (c.auxData && c.auxData.isDefault ? 'default' : 'other')
                })),
                probeResults: probeResults.map(r => ({
                    contextId: r.contextId,
                    hasDebugRoot: r.value ? !!r.value.hasDebugRoot : false,
                    hasGetCurrentNotionContext: r.value ? !!r.value.hasGetCurrentNotionContext : false,
                    result: r.value ? r.value.result : { ok: false, error: "no_value" },
                    error: r.value && r.value.error ? r.value.error : undefined
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

            // Probe 1: Check DOM div (visible from any context that can access document)
            ws.send(JSON.stringify({
                id: 1000,
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
            res.result = { ok: false, error: "debug root missing" };
          } else if (!res.hasGetCurrentNotionContext) {
            res.result = { ok: false, error: "getCurrentNotionContext missing" };
          } else {
            try {
              const raw = root.getCurrentNotionContext();
              if (raw === undefined || raw === null) {
                res.result = { ok: false, error: 'getCurrentNotionContext returned ' + String(raw) };
              } else {
                if (raw && raw.context && raw.context.page) {
                  const urlObj = new URL(raw.context.page.url);
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
                ws.send(JSON.stringify({
                    id: 2000 + ctx.id,
                    method: 'Runtime.evaluate',
                    params: {
                        expression: probeExpression,
                        returnByValue: true,
                        contextId: ctx.id
                    }
                }));
            }

            // Fallback timeout in case some contexts don't respond
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
            if (resp.id === 1000 && resp.result && resp.result.result) {
                domDivResult = resp.result.result.value || null;
            }

            // Collect per-context probe results
            if (resp.id >= 2000) {
                responsesReceived++;
                if (resp.result && resp.result.result) {
                    const contextId = resp.id - 2000;
                    const val = resp.result.result.value;
                    if (val) {
                        probeResults.push({ contextId, value: val });
                    }
                }

                // Check if all contexts have responded
                if (responsesReceived >= contexts.length) {
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
