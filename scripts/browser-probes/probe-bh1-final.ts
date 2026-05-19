/**
 * BH-1 Final Probe: Find all messages in current conversation and try another conversation
 */

interface CdpTab { url: string; type: string; webSocketDebuggerUrl: string; }

async function main(): Promise<void> {
    const tabs = (await fetch('http://127.0.0.1:9222/json/list').then(r => r.json())) as CdpTab[];
    const tab = tabs.find(t => t.url?.includes('notion.so') && t.type === 'page' &&
        (t.url.includes('/chat') || t.url.includes('/ai')));
    if (!tab) { console.error('No Notion tab'); process.exit(1); }
    console.error('[probe] Target:', tab.url);

    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise<void>(r => ws.addEventListener('open', () => r()));
    let id = 1;
    const p = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
    ws.addEventListener('message', ev => {
        try {
            const m = JSON.parse(ev.data as string) as { id?: number; result?: unknown; error?: { message: string } };
            if (m.id !== undefined) { const h = p.get(m.id); if (h) { p.delete(m.id); m.error ? h.rej(new Error(m.error.message)) : h.res(m.result); } }
        } catch { }
    });
    const call = (method: string, params: object): Promise<unknown> => new Promise((res, rej) => {
        const i = id++; p.set(i, { res, rej });
        ws.send(JSON.stringify({ id: i, method, params }));
        setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error(`timeout: ${method}`)); } }, 10000);
    });

    // Click on the 2nd conversation item (skip the first one we already visited)
    await call('Page.enable', {});
    const navProm = new Promise<void>(res => {
        const h = (ev: MessageEvent) => {
            try {
                const m = JSON.parse(ev.data as string) as { method?: string };
                if (m.method === 'Page.loadEventFired' || m.method === 'Page.frameNavigated') {
                    ws.removeEventListener('message', h); res();
                }
            } catch { }
        };
        ws.addEventListener('message', h);
        setTimeout(() => res(), 5000);
    });

    const clickR = (await call('Runtime.evaluate', {
        expression: `JSON.stringify((function() {
      const items = document.querySelectorAll('.notion-sidebar-chat-item');
      if (items.length < 2) return { error: 'not enough items', count: items.length };
      // Click a conversation from "yesterday" (has AI responses)
      // Find any item with longer text (probably has AI response)
      let targetIdx = 1;
      for (let i = 0; i < items.length; i++) {
        const txt = (items[i].textContent || '').trim();
        // Look for a "yesterday" or "昨天" conversation
        if (txt.includes('小时') && i > 2) { targetIdx = i; break; }
      }
      items[targetIdx].click();
      return { clicked: true, idx: targetIdx, txt: (items[targetIdx].textContent || '').trim().slice(0, 50) };
    })())`,
        returnByValue: true,
    })) as { result?: { value?: string } };

    console.error('[click]', clickR.result?.value);
    await navProm;
    await new Promise(r => setTimeout(r, 2500));

    // Now probe the conversation structure
    const r = (await call('Runtime.evaluate', {
        expression: `JSON.stringify((function() {
      const lc = document.querySelector('.layout-content');
      if (!lc) return { error: 'no .layout-content', url: window.location.href };
      
      // Get ALL direct children of .autolayout-col (the messages container)
      const autolayoutCol = lc.querySelector('.autolayout-col.autolayout-fill-width');
      if (!autolayoutCol) return { error: 'no .autolayout-col', lcChildren: lc.children.length };
      
      // The second child of autolayoutCol should be the messages scroller
      const children = Array.from(autolayoutCol.children);
      const msgContainer = children[children.length - 1]; // last child is messages
      
      let messages = [];
      if (msgContainer) {
        // Each message is a child
        const msgChildren = Array.from(msgContainer.children);
        messages = msgChildren.slice(0, 10).map(c => {
          const txt = (c.textContent || '').trim();
          return {
            tag: c.tagName,
            cls: Array.from(c.classList).slice(0, 5).join(' '),
            testId: c.getAttribute('data-testid'),
            role: c.getAttribute('role'),
            ariaLabel: c.getAttribute('aria-label'),
            textLen: txt.length,
            textSnippet: txt.slice(0, 100),
            childCount: c.children.length
          };
        });
      }
      
      // Also check: can we find individual message blocks by scanning all divs
      // with specific text patterns (user messages start with >50 chars, AI with >100)
      const allDivs = Array.from(lc.querySelectorAll('div'));
      const msgDivs = allDivs.filter(d => {
        const txt = (d.textContent || '').trim();
        // Each top-level message div should be a direct child of some container
        return txt.length > 20 && txt.length < 10000 && d.children.length > 0 && d.children.length < 20;
      }).slice(0, 5).map(d => ({
        tag: d.tagName,
        cls: Array.from(d.classList).join(' '),
        childCount: d.children.length,
        textLen: (d.textContent || '').trim().length,
        textSnippet: (d.textContent || '').trim().slice(0, 80),
        parentCls: d.parentElement ? Array.from(d.parentElement.classList).join(' ') : ''
      }));

      // Look for stop button during any loading state
      const stopBtn = document.querySelector('[data-testid="stop-button"]');
      const loadingBtn = document.querySelector('[aria-label*="停止"],[aria-label*="Stop"],[aria-label*="stop"]');
      
      return {
        url: window.location.href,
        autolayoutColChildCount: autolayoutCol.children.length,
        msgContainerCls: msgContainer ? Array.from(msgContainer.classList).join(' ') : null,
        msgContainerChildCount: msgContainer ? msgContainer.children.length : 0,
        messages,
        msgDivs,
        stopButton: { found: !!stopBtn },
        loadingButton: { found: !!loadingBtn, label: loadingBtn?.getAttribute('aria-label') },
        timestamp: new Date().toISOString()
      };
    })())`,
        returnByValue: true,
    })) as { result?: { value?: string }; exceptionDetails?: unknown };

    ws.close();
    if (!r.result?.value) { console.error(JSON.stringify(r.exceptionDetails)); process.exit(1); }
    console.log(JSON.stringify(JSON.parse(r.result.value), null, 2));
}

main().catch(e => { console.error(String(e)); process.exit(1); });
