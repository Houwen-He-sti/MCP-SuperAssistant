/**
 * BH-1 CDP Probe Part 4: Navigate into a conversation to probe message DOM
 *
 * Observation-only. Read-only navigation to existing conversation.
 * No submit, no inject, no tool execution.
 */

const args = process.argv.slice(2);
let port = 9222;
let urlFilter = 'notion.so/ai';

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) port = parseInt(args[++i], 10);
    else if (args[i] === '--url-filter' && args[i + 1]) urlFilter = args[++i];
}

interface CdpTab {
    id: string; url: string; title: string; webSocketDebuggerUrl: string; type: string;
}

async function main(): Promise<void> {
    const tabs = (await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json())) as CdpTab[];
    const tab = tabs.find(t => t.url?.includes(urlFilter) && t.type === 'page');
    if (!tab) { console.error('No tab for:', urlFilter); process.exit(1); }

    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => {
        ws.addEventListener('open', () => res());
        ws.addEventListener('error', e => rej(new Error(String(e))));
        setTimeout(() => rej(new Error('connect timeout')), 5000);
    });

    let nextId = 1;
    const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
    ws.addEventListener('message', (ev) => {
        try {
            const m = JSON.parse(ev.data as string) as { id?: number; result?: unknown; error?: { message: string } };
            if (m.id !== undefined) {
                const h = pending.get(m.id);
                if (h) { pending.delete(m.id); m.error ? h.rej(new Error(m.error.message)) : h.res(m.result); }
            }
        } catch { }
    });

    function call(method: string, params: Record<string, unknown>): Promise<unknown> {
        const id = nextId++;
        return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`timeout: ${method}`)); } }, 10000);
        });
    }

    // Step 1: Get conversation URLs from sidebar
    const linksScript = /* js */ `
    (function() {
      // Find all conversation links in the sidebar
      const links = Array.from(document.querySelectorAll('a[href*="/ai/"]'))
        .map(a => ({ href: a.href, text: (a.textContent || '').trim().slice(0, 50) }))
        .slice(0, 5);
      
      // Also find listitem anchors
      const listAnchors = Array.from(document.querySelectorAll('[role="listitem"] a, a[role="listitem"]'))
        .map(a => ({ href: a.href, text: (a.textContent || '').trim().slice(0, 50) }))
        .slice(0, 5);

      return { aiLinks: links, listAnchors };
    })()
  `;

    const linksRes = (await call('Runtime.evaluate', { expression: linksScript, returnByValue: true })) as {
        result?: { value?: unknown };
    };
    console.error('[step1] links:', JSON.stringify(linksRes.result?.value));

    const linksData = linksRes.result?.value as { aiLinks: Array<{ href: string; text: string }>; listAnchors: Array<{ href: string; text: string }> };
    const conversationUrl = linksData?.aiLinks?.[0]?.href || linksData?.listAnchors?.[0]?.href;

    if (!conversationUrl) {
        console.error('[step1] No conversation links found in sidebar. Current page may already be a conversation.');
        // Still probe current DOM
    } else {
        console.error(`[step2] Navigating to conversation: ${conversationUrl}`);
        // Enable Page domain for events
        await call('Page.enable', {});

        // Navigate to the conversation
        await call('Page.navigate', { url: conversationUrl });

        // Wait for load
        await new Promise<void>((res) => {
            const onMsg = (ev: MessageEvent) => {
                try {
                    const m = JSON.parse(ev.data as string) as { method?: string };
                    if (m.method === 'Page.loadEventFired') {
                        ws.removeEventListener('message', onMsg);
                        res();
                    }
                } catch { }
            };
            ws.addEventListener('message', onMsg);
            setTimeout(() => res(), 5000); // timeout fallback
        });

        // Extra wait for React render
        await new Promise(r => setTimeout(r, 2000));
        console.error('[step2] Navigation complete');
    }

    // Step 3: Probe the conversation DOM
    const probeScript = /* js */ `
    (function() {
      const STOP_BUTTON_SEL = '[data-testid="stop-button"]';
      const SUBMIT_BUTTON_SEL = '[data-testid="agent-send-message-button"]';
      
      // All data-testid values on page
      const allTestIds = Array.from(document.querySelectorAll('[data-testid]'))
        .map(el => el.getAttribute('data-testid'))
        .filter(Boolean);
      
      // Stop button check  
      const stopBtn = document.querySelector(STOP_BUTTON_SEL);
      
      // Submit button
      const submitBtn = document.querySelector(SUBMIT_BUTTON_SEL);
      
      // Find all scrollable containers
      const scrollableEls = Array.from(document.querySelectorAll('*'))
        .filter(el => {
          const s = window.getComputedStyle(el);
          return (s.overflowY === 'auto' || s.overflowY === 'scroll');
        })
        .map(el => ({
          tag: el.tagName,
          testId: el.getAttribute('data-testid'),
          role: el.getAttribute('role'),
          ariaLabel: el.getAttribute('aria-label'),
          cls: Array.from(el.classList).slice(0,5).join(' '),
          scrollH: el.scrollHeight,
          children: el.children.length
        }))
        .filter(e => e.scrollH > 100)
        .slice(0, 10);
      
      // Look for message-like elements: aria-label containing message/response
      const messageEls = Array.from(document.querySelectorAll('[aria-label],[role]'))
        .filter(el => {
          const lbl = (el.getAttribute('aria-label') || '').toLowerCase();
          const role = (el.getAttribute('role') || '').toLowerCase();
          return lbl.includes('message') || lbl.includes('response') || lbl.includes('assistant') || role === 'article' || role === 'region';
        })
        .map(el => ({
          tag: el.tagName,
          role: el.getAttribute('role'),
          ariaLabel: el.getAttribute('aria-label'),
          testId: el.getAttribute('data-testid'),
          cls: Array.from(el.classList).slice(0,4).join(' '),
          textLen: (el.textContent || '').trim().length
        }))
        .slice(0, 15);

      // Deep dive: elements with long text (potential AI responses)
      const longTextEls = Array.from(document.querySelectorAll('div, article, section, p'))
        .filter(el => {
          const txt = (el.textContent || '').trim();
          return txt.length > 100 && txt.length < 3000 && el.children.length > 0 && el.children.length < 30;
        })
        .slice(0, 8)
        .map(el => {
          const txt = (el.textContent || '').trim();
          return {
            tag: el.tagName,
            testId: el.getAttribute('data-testid'),
            role: el.getAttribute('role'),
            ariaLabel: el.getAttribute('aria-label'),
            cls: Array.from(el.classList).slice(0,4).join(' '),
            textLen: txt.length,
            textSnippet: txt.slice(0, 120),
            children: el.children.length
          };
        });
      
      return {
        url: window.location.href,
        pathname: window.location.pathname,
        stopButton: { found: stopBtn !== null, selector: STOP_BUTTON_SEL },
        submitButton: { found: submitBtn !== null, disabled: submitBtn?.hasAttribute('disabled') },
        allTestIds: [...new Set(allTestIds)].sort(),
        scrollableEls,
        messageEls,
        longTextEls,
        timestamp: new Date().toISOString()
      };
    })()
  `;

    const res = (await call('Runtime.evaluate', { expression: probeScript, returnByValue: true, awaitPromise: false })) as {
        result?: { value?: unknown };
        exceptionDetails?: unknown;
    };

    ws.close();

    if (res.exceptionDetails) {
        console.error(JSON.stringify({ error: res.exceptionDetails }));
        process.exit(1);
    }
    console.log(JSON.stringify(res.result?.value, null, 2));
}

main().catch(err => { console.error(String(err)); process.exit(1); });
