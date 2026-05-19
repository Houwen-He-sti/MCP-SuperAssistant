/**
 * BH-1 Probe: Navigate to a conversation and probe message DOM structure
 * Read-only navigation only (click sidebar conversation link).
 * No tool execution, no text injection, no form submission.
 */

interface CdpTab { url: string; type: string; webSocketDebuggerUrl: string; }

async function main(): Promise<void> {
    const tabs = (await fetch('http://127.0.0.1:9222/json/list').then(r => r.json())) as CdpTab[];
    const tab = tabs.find(t => t.url?.includes('notion.so/ai') && t.type === 'page');
    if (!tab) { console.error('No Notion AI tab'); process.exit(1); }

    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise<void>(r => ws.addEventListener('open', () => r()));
    let id = 1;
    const p = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
    ws.addEventListener('message', ev => {
        try {
            const m = JSON.parse(ev.data as string) as { id?: number; result?: unknown; error?: { message: string }; method?: string };
            if (m.id !== undefined) { const h = p.get(m.id); if (h) { p.delete(m.id); m.error ? h.rej(new Error(m.error.message)) : h.res(m.result); } }
        } catch { }
    });
    const call = (method: string, params: object): Promise<unknown> => new Promise((res, rej) => {
        const i = id++; p.set(i, { res, rej });
        ws.send(JSON.stringify({ id: i, method, params }));
        setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error(`timeout: ${method}`)); } }, 10000);
    });

    // Step 1: Enable Page domain events
    await call('Page.enable', {});

    // Step 2: Click on the first conversation item and wait for navigation
    console.error('[step1] Clicking first sidebar conversation item...');

    // Set up navigation event listener BEFORE click
    let navigated = false;
    const navPromise = new Promise<void>((res) => {
        const onMsg = (ev: MessageEvent) => {
            try {
                const m = JSON.parse(ev.data as string) as { method?: string; params?: { url?: string } };
                if (m.method === 'Page.frameNavigated' || m.method === 'Page.loadEventFired') {
                    ws.removeEventListener('message', onMsg);
                    navigated = true;
                    console.error('[nav] Navigation detected:', m.method, m.params?.url || '');
                    res();
                }
            } catch { }
        };
        ws.addEventListener('message', onMsg);
        setTimeout(() => { ws.removeEventListener('message', onMsg); res(); }, 5000);
    });

    // Click the first conversation item
    const clickResult = (await call('Runtime.evaluate', {
        expression: `JSON.stringify((function() {
      const items = document.querySelectorAll('.notion-sidebar-chat-item');
      if (items.length === 0) return { error: 'no chat items', count: 0 };
      items[0].click();
      return { clicked: true, count: items.length, txt: (items[0].textContent || '').trim().slice(0, 50) };
    })())`,
        returnByValue: true,
    })) as { result?: { value?: string } };

    const clickData = JSON.parse(clickResult.result?.value || '{}');
    console.error('[step1] click result:', JSON.stringify(clickData));

    // Wait for navigation (up to 5s)
    await navPromise;

    // Extra wait for React render
    await new Promise(r => setTimeout(r, 2000));
    console.error('[step2] Navigation complete, navigated:', navigated);

    // Step 3: Probe the conversation DOM
    const probeResult = (await call('Runtime.evaluate', {
        expression: `JSON.stringify((function() {
      const url = window.location.href;
      const pathname = window.location.pathname;
      
      // Stop button (should NOT appear when idle)
      const stopBtn = document.querySelector('[data-testid="stop-button"]');
      
      // Submit button
      const submitBtn = document.querySelector('[data-testid="agent-send-message-button"]');
      
      // All data-testids
      const allTestIds = Array.from(new Set(
        Array.from(document.querySelectorAll('[data-testid]'))
          .map(el => el.getAttribute('data-testid'))
      )).sort();
      
      // All elements with role = article, region, feed, log (message containers)
      const semanticEls = Array.from(document.querySelectorAll('[role="article"],[role="region"],[role="feed"],[role="log"],[role="listitem"]'))
        .filter(el => (el.textContent || '').trim().length > 10)
        .map(el => ({
          tag: el.tagName,
          role: el.getAttribute('role'),
          ariaLabel: el.getAttribute('aria-label'),
          testId: el.getAttribute('data-testid'),
          cls: Array.from(el.classList).slice(0, 4).join(' '),
          textLen: (el.textContent || '').trim().length,
          textSnippet: (el.textContent || '').trim().slice(0, 100),
          children: el.children.length
        }))
        .slice(0, 20);
      
      // Find parent of message content: look for container with many children of similar structure
      const allDivs = Array.from(document.querySelectorAll('div'));
      const messageCandidates = allDivs
        .filter(div => {
          const kids = div.children;
          if (kids.length < 2) return false;
          // Check if children have similar structure (message list pattern)
          const firstTwo = [kids[0], kids[1]];
          const sameTag = firstTwo.every(k => k.tagName === 'DIV');
          const hasText = Array.from(kids).some(k => (k.textContent || '').trim().length > 30);
          return sameTag && hasText && kids.length >= 2 && kids.length <= 50;
        })
        .slice(0, 10)
        .map(div => ({
          tag: div.tagName,
          testId: div.getAttribute('data-testid'),
          role: div.getAttribute('role'),
          ariaLabel: div.getAttribute('aria-label'),
          cls: Array.from(div.classList).slice(0, 5).join(' '),
          childCount: div.children.length,
          firstChildCls: Array.from((div.children[0] || div).classList).slice(0, 4).join(' '),
          textLen: (div.textContent || '').trim().length,
          textSnippet: (div.textContent || '').trim().slice(0, 100)
        }));
      
      // NATIVE_CHAT_CONTENT selector tests
      const chatSelectors = [
        '.notion-ai-chat-content',
        '[data-testid="ai-chat-content"]',
        '.notion-app-inner'
      ];
      const selectorTests = chatSelectors.map(sel => ({
        selector: sel,
        count: document.querySelectorAll(sel).length
      }));
      
      // Check for streaming state indicators
      const streamIndicators = {
        stopButton: document.querySelector('[data-testid="stop-button"]') !== null,
        loadingSpinner: document.querySelector('[role="status"],[aria-live="polite"],[aria-busy="true"]') !== null,
        anyAnimated: document.querySelectorAll('[class*="loading"],[class*="spinner"],[class*="animate"]').length
      };
      
      return {
        url, pathname, allTestIds, semanticEls, messageCandidates,
        selectorTests, streamIndicators,
        stopButton: { found: stopBtn !== null },
        submitButton: { found: submitBtn !== null, disabled: submitBtn ? submitBtn.hasAttribute('disabled') : null },
        timestamp: new Date().toISOString()
      };
    })())`,
        returnByValue: true,
    })) as { result?: { value?: string }; exceptionDetails?: unknown };

    ws.close();

    if (!probeResult.result?.value) {
        console.error('[error] No result:', JSON.stringify(probeResult.exceptionDetails));
        process.exit(1);
    }

    console.log(probeResult.result.value);
}

main().catch(e => { console.error(String(e)); process.exit(1); });
