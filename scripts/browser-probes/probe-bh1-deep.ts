/**
 * BH-1 CDP Probe Part 2: Deep DOM excavation for AI chat container
 *
 * Observation-only. No click, no inject, no submit.
 * Probes deeper into .notion-app-inner to find the actual chat
 * conversation container.
 */

const args = process.argv.slice(2);
let port = 9222;
let urlFilter = 'notion.so/ai';

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) port = parseInt(args[++i], 10);
    else if (args[i] === '--url-filter' && args[i + 1]) urlFilter = args[++i];
}

interface CdpTab {
    id: string;
    url: string;
    title: string;
    webSocketDebuggerUrl: string;
    type: string;
}

async function main(): Promise<void> {
    const tabs = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) =>
        r.json(),
    )) as CdpTab[];
    const tab = tabs.find((t) => t.url?.includes(urlFilter) && t.type === 'page');

    if (!tab) {
        console.error('No tab found for:', urlFilter);
        process.exit(1);
    }

    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => {
        ws.addEventListener('open', () => res());
        ws.addEventListener('error', (e) => rej(new Error(String(e))));
        setTimeout(() => rej(new Error('connect timeout')), 5000);
    });

    let nextId = 1;
    const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
    ws.addEventListener('message', (ev) => {
        try {
            const m = JSON.parse(ev.data as string) as {
                id?: number;
                result?: unknown;
                error?: { message: string };
            };
            if (m.id !== undefined) {
                const h = pending.get(m.id);
                if (h) {
                    pending.delete(m.id);
                    m.error ? h.rej(new Error(m.error.message)) : h.res(m.result);
                }
            }
        } catch { }
    });

    function call(method: string, params: Record<string, unknown>): Promise<unknown> {
        const id = nextId++;
        return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
                if (pending.has(id)) {
                    pending.delete(id);
                    rej(new Error(`timeout: ${method}`));
                }
            }, 10000);
        });
    }

    // Deep excavation probe
    const script = `
    (function() {
      // Strategy: try data-testid selectors related to Notion AI
      const candidateSelectors = [
        // Notion AI chat conversation
        '[data-testid="ai-chat"]',
        '[data-testid="notion-ai-chat"]',
        '[data-testid="chat-messages"]',
        '[data-testid="ai-chat-messages"]',
        '[data-testid="conversation"]',
        '[data-testid="conversation-list"]',
        '[data-testid="messages"]',
        '[data-testid="agent-chat"]',
        '[data-testid="agent-conversation"]',
        // Class-based
        '.notion-ai-chat',
        '.notion-chat-content',
        '.notion-ai-conversation',
        // Role-based
        '[role="log"]',
        '[role="feed"]',
        // aria-label
        '[aria-label*="conversation"]',
        '[aria-label*="chat"]',
        '[aria-label*="messages"]',
        // Stop button variants
        '[data-testid="stop-button"]',
        '[data-testid="stop-generating"]',
        '[data-testid="cancel-button"]',
        '[aria-label*="Stop"]',
        '[aria-label*="stop"]',
        '[aria-label*="Cancel"]',
        'button[title*="Stop"]',
        'button[title*="stop"]',
      ];

      const selectorResults = candidateSelectors.map(sel => ({
        selector: sel,
        count: document.querySelectorAll(sel).length,
        firstTagName: document.querySelector(sel)?.tagName || null
      }));

      // Also probe: find all data-testid values in the document
      const allTestIds = new Set();
      document.querySelectorAll('[data-testid]').forEach(el => {
        allTestIds.add(el.getAttribute('data-testid'));
      });
      const allTestIdsList = Array.from(allTestIds).sort();

      // Probe .notion-app-inner subtree for chat-like structure
      const appInner = document.querySelector('.notion-app-inner');
      let subtreeProbe = null;
      if (appInner) {
        // Find deepest text container in the chat area
        // Try to walk into the structure
        const allDivs = Array.from(appInner.querySelectorAll('div'))
          .filter(el => {
            const tid = el.getAttribute('data-testid');
            return tid || el.className.includes('notion-ai') || el.className.includes('chat') || el.className.includes('conversation');
          })
          .slice(0, 20)
          .map(el => ({
            tagName: el.tagName,
            testId: el.getAttribute('data-testid'),
            classList: Array.from(el.classList).slice(0,3),
            childCount: el.children.length,
            textLen: (el.textContent || '').trim().length
          }));

        subtreeProbe = {
          appInnerChildCount: appInner.children.length,
          aiRelatedDivs: allDivs
        };
      }

      return {
        selectorResults: selectorResults.filter(r => r.count > 0),
        allTestIds: allTestIdsList.slice(0, 50),
        subtreeProbe,
        url: window.location.href,
        timestamp: new Date().toISOString()
      };
    })()
  `;

    const res = (await call('Runtime.evaluate', {
        expression: script,
        returnByValue: true,
        awaitPromise: false,
    })) as { result?: { value?: unknown }; exceptionDetails?: { text: string } };

    ws.close();

    if (res.exceptionDetails) {
        console.error(JSON.stringify({ error: res.exceptionDetails }, null, 2));
        process.exit(1);
    }

    console.log(JSON.stringify(res.result?.value, null, 2));
}

main().catch((err) => {
    console.error(JSON.stringify({ error: String(err) }, null, 2));
    process.exit(1);
});
