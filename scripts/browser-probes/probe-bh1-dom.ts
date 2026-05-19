/**
 * BH-1 CDP Probe: Stop-button selector + message identity observation
 *
 * Purpose: Observe Notion AI DOM structure to confirm:
 *   Gap 1: stop-button selector for isStreaming()
 *   Gap 3: NATIVE_CHAT_CONTENT selector validity
 *   Gap 2: message identity structure (childList / node structure)
 *
 * Observation-only. No click, no inject, no submit.
 *
 * Usage:
 *   node --experimental-strip-types scripts/browser-probes/probe-bh1-dom.ts [--port 9222] [--url-filter notion.so/ai]
 */

interface CdpTab {
    id: string;
    url: string;
    title: string;
    webSocketDebuggerUrl: string;
    type: string;
}

interface DomProbeResult {
    stopButton: {
        selector: string;
        found: boolean;
        visible: boolean | null;
        checkVisibilitySupported: boolean;
    };
    submitButton: {
        selector: string;
        found: boolean;
        disabled: boolean | null;
    };
    chatContent: {
        selectors: string[];
        results: Array<{
            selector: string;
            count: number;
        }>;
        firstMatchSelector: string | null;
    };
    messageStructure: {
        parentSelector: string | null;
        childCount: number;
        sampleChildren: Array<{
            tagName: string;
            classList: string[];
            textLength: number;
            textSnippet: string;
        }>;
        mutationObservable: boolean;
    };
    routeInfo: {
        pathname: string;
        hostname: string;
    };
    timestamp: string;
}

// Parse CLI args
const args = process.argv.slice(2);
let port = 9222;
let urlFilter = 'notion.so/ai';

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) port = parseInt(args[++i], 10);
    else if (args[i] === '--url-filter' && args[i + 1]) urlFilter = args[++i];
}

async function getJson(url: string): Promise<unknown> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
}

function sendCdp(
    ws: WebSocket,
    method: string,
    params: Record<string, unknown>,
    id: number,
): void {
    ws.send(JSON.stringify({ id, method, params }));
}

async function runProbe(): Promise<void> {
    // 1. Find the target tab
    const tabs = (await getJson(`http://127.0.0.1:${port}/json/list`)) as CdpTab[];
    const tab = tabs.find((t) => t.url && t.url.includes(urlFilter) && t.type === 'page');

    if (!tab) {
        const available = tabs
            .filter((t) => t.type === 'page')
            .map((t) => t.url)
            .slice(0, 5);
        console.error(
            JSON.stringify(
                {
                    error: `No page tab matching filter: ${urlFilter}`,
                    availablePageUrls: available,
                },
                null,
                2,
            ),
        );
        process.exit(1);
    }

    console.error(`[probe] Target: ${tab.url}`);

    // 2. Connect via WebSocket
    const ws = new WebSocket(tab.webSocketDebuggerUrl);

    await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve());
        ws.addEventListener('error', (e) => reject(new Error(`WS error: ${String(e)}`)));
        setTimeout(() => reject(new Error('WS connect timeout')), 5000);
    });

    // 3. Prepare message dispatch
    let nextId = 1;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

    ws.addEventListener('message', (event) => {
        try {
            const msg = JSON.parse(event.data as string) as {
                id?: number;
                result?: unknown;
                error?: { message: string };
            };
            if (msg.id !== undefined) {
                const handler = pending.get(msg.id);
                if (handler) {
                    pending.delete(msg.id);
                    if (msg.error) {
                        handler.reject(new Error(msg.error.message));
                    } else {
                        handler.resolve(msg.result);
                    }
                }
            }
        } catch {
            // ignore parse errors
        }
    });

    function cdpCall(method: string, params: Record<string, unknown>): Promise<unknown> {
        const id = nextId++;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            sendCdp(ws, method, params, id);
            setTimeout(() => {
                if (pending.has(id)) {
                    pending.delete(id);
                    reject(new Error(`Timeout for ${method}`));
                }
            }, 8000);
        });
    }

    // 4. Run the DOM probe in the page context
    const probeScript = `
    (function() {
      const STOP_BUTTON_SEL = '[data-testid="stop-button"]';
      const SUBMIT_BUTTON_SEL = '[data-testid="agent-send-message-button"]';
      const CHAT_CONTENT_SELS = [
        '.notion-ai-chat-content',
        '[data-testid="ai-chat-content"]',
        '.notion-app-inner'
      ];

      // Stop button
      const stopBtn = document.querySelector(STOP_BUTTON_SEL);
      let stopVisible = null;
      let checkVisibilitySupported = false;
      if (stopBtn) {
        checkVisibilitySupported = typeof stopBtn.checkVisibility === 'function';
        try {
          stopVisible = checkVisibilitySupported
            ? stopBtn.checkVisibility({ visibilityProperty: true, opacityProperty: true })
            : (stopBtn.style.display !== 'none' && stopBtn.style.visibility !== 'hidden');
        } catch (e) {
          stopVisible = null;
        }
      }

      // Submit button
      const submitBtn = document.querySelector(SUBMIT_BUTTON_SEL);
      let submitDisabled = null;
      if (submitBtn) {
        submitDisabled = submitBtn.hasAttribute('disabled') || submitBtn.getAttribute('aria-disabled') === 'true';
      }

      // Chat content selectors
      const chatContentResults = CHAT_CONTENT_SELS.map(sel => ({
        selector: sel,
        count: document.querySelectorAll(sel).length
      }));
      const firstMatchSel = CHAT_CONTENT_SELS.find(sel => document.querySelector(sel) !== null) || null;

      // Message structure
      let messageStructure = {
        parentSelector: null,
        childCount: 0,
        sampleChildren: [],
        mutationObservable: false
      };
      if (firstMatchSel) {
        const chatEl = document.querySelector(firstMatchSel);
        if (chatEl) {
          const children = Array.from(chatEl.children).slice(0, 5);
          messageStructure = {
            parentSelector: firstMatchSel,
            childCount: chatEl.children.length,
            sampleChildren: children.map(el => ({
              tagName: el.tagName,
              classList: Array.from(el.classList).slice(0, 5),
              textLength: (el.textContent || '').trim().length,
              textSnippet: (el.textContent || '').trim().slice(0, 60)
            })),
            mutationObservable: true
          };
        }
      }

      return {
        stopButton: {
          selector: STOP_BUTTON_SEL,
          found: stopBtn !== null,
          visible: stopVisible,
          checkVisibilitySupported
        },
        submitButton: {
          selector: SUBMIT_BUTTON_SEL,
          found: submitBtn !== null,
          disabled: submitDisabled
        },
        chatContent: {
          selectors: CHAT_CONTENT_SELS,
          results: chatContentResults,
          firstMatchSelector: firstMatchSel
        },
        messageStructure,
        routeInfo: {
          pathname: window.location.pathname,
          hostname: window.location.hostname
        },
        timestamp: new Date().toISOString()
      };
    })()
  `;

    const evalResult = (await cdpCall('Runtime.evaluate', {
        expression: probeScript,
        returnByValue: true,
        awaitPromise: false,
    })) as { result?: { value?: unknown; type?: string }; exceptionDetails?: { text: string } };

    ws.close();

    if (evalResult.exceptionDetails) {
        console.error(
            JSON.stringify({ error: 'eval exception', details: evalResult.exceptionDetails }, null, 2),
        );
        process.exit(1);
    }

    const probeData = evalResult.result?.value as DomProbeResult;
    console.log(JSON.stringify(probeData, null, 2));
}

runProbe().catch((err) => {
    console.error(JSON.stringify({ error: String(err) }, null, 2));
    process.exit(1);
});
