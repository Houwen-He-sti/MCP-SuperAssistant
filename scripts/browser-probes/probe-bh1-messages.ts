/**
 * BH-1 Probe: Find individual message elements within .layout-content
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

    const r = (await call('Runtime.evaluate', {
        expression: `JSON.stringify((function() {
      const layoutContent = document.querySelector('.layout-content');
      if (!layoutContent) return { error: 'no .layout-content' };
      
      // Walk into the message area
      // .layout-content > div > div > ... 
      // Find the direct children structure
      function describeEl(el, depth) {
        if (depth > 5) return null;
        const txt = (el.textContent || '').trim();
        return {
          tag: el.tagName,
          testId: el.getAttribute('data-testid'),
          role: el.getAttribute('role'),
          ariaLabel: el.getAttribute('aria-label'),
          cls: Array.from(el.classList).join(' '),
          textLen: txt.length,
          textSnippet: txt.slice(0, 80),
          childCount: el.children.length,
          children: el.children.length <= 5 ? Array.from(el.children).map(c => describeEl(c, depth + 1)).filter(Boolean) : null
        };
      }
      
      const tree = describeEl(layoutContent, 0);
      
      // Also: what is the deepest element containing the actual message text?
      // (the one with > 2000 chars of text)
      let bigTextEl = null;
      function findBigText(el, depth) {
        if (depth > 10) return;
        const txt = (el.textContent || '').trim();
        if (txt.length > 2000 && el.children.length > 0) {
          // go deeper
          for (const child of el.children) {
            findBigText(child, depth + 1);
          }
          if (!bigTextEl || txt.length < ((bigTextEl.textContent || '').trim().length)) {
            // if this is the smallest container with > 2000 chars
            if (!bigTextEl) bigTextEl = el;
          }
        }
      }
      findBigText(layoutContent, 0);
      
      // Find the scroller element (where new message nodes would be appended)
      let scrollerEl = null;
      function findScroller(el) {
        const style = window.getComputedStyle(el);
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > 300) {
          scrollerEl = el;
          // Keep going deeper to find the innermost scroller
          for (const child of el.children) {
            findScroller(child);
          }
        }
      }
      findScroller(layoutContent);
      
      // Check the scroller's direct children (candidate message nodes)
      let scrollerInfo = null;
      if (scrollerEl) {
        const children = Array.from(scrollerEl.children);
        scrollerInfo = {
          cls: Array.from(scrollerEl.classList).join(' '),
          testId: scrollerEl.getAttribute('data-testid'),
          scrollHeight: scrollerEl.scrollHeight,
          childCount: children.length,
          sampleChildren: children.slice(0, 5).map(c => {
            const txt = (c.textContent || '').trim();
            return {
              tag: c.tagName,
              cls: Array.from(c.classList).slice(0, 4).join(' '),
              testId: c.getAttribute('data-testid'),
              role: c.getAttribute('role'),
              textLen: txt.length,
              textSnippet: txt.slice(0, 100)
            };
          })
        };
      }
      
      return {
        url: window.location.href,
        layoutContentFound: true,
        layoutContentCls: Array.from(layoutContent.classList).join(' '),
        tree: tree ? {
          cls: tree.cls, childCount: tree.childCount,
          firstChild: tree.children ? tree.children[0] : null
        } : null,
        scrollerInfo,
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
