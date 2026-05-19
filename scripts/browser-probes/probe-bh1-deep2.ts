/**
 * BH-1 CDP Probe Part 3: Find actual AI conversation container
 *
 * Observation-only. No click, no inject, no submit.
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
    if (!tab) { console.error('No tab for:', urlFilter); process.exit(1); }

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

    const script = /* js */ `
    (function() {
      const inner = document.querySelector('.notion-app-inner');
      if (!inner) return { error: 'no .notion-app-inner' };

      // Find conversation area: elements with substantial text (AI responses are typically longer)
      const allEls = Array.from(inner.querySelectorAll('*'));
      
      const textCandidates = allEls
        .filter(el => {
          const txt = (el.textContent || '').trim();
          return txt.length > 50 && txt.length < 2000 && el.children.length < 20;
        })
        .slice(0, 10)
        .map(el => {
          let depth = 0;
          let ancestor = el.parentElement;
          while (ancestor && ancestor !== inner) { depth++; ancestor = ancestor.parentElement; }
          return {
            tag: el.tagName,
            testId: el.getAttribute('data-testid'),
            role: el.getAttribute('role'),
            ariaLabel: el.getAttribute('aria-label'),
            cls: Array.from(el.classList).slice(0, 4).join(' '),
            depth,
            textLen: (el.textContent || '').trim().length,
            textSnippet: (el.textContent || '').trim().slice(0, 100)
          };
        });

      // All elements with role or aria-label
      const ariaEls = Array.from(inner.querySelectorAll('[role],[aria-label],[data-testid]'))
        .map(el => ({
          tag: el.tagName,
          role: el.getAttribute('role'),
          ariaLabel: el.getAttribute('aria-label'),
          testId: el.getAttribute('data-testid'),
          cls: Array.from(el.classList).slice(0, 3).join(' ')
        }));

      // Find the main content area (typically a large scrollable div)
      const scrollableDivs = Array.from(inner.querySelectorAll('div'))
        .filter(el => {
          const style = window.getComputedStyle(el);
          return (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
                 el.scrollHeight > 200;
        })
        .map(el => ({
          tag: el.tagName,
          testId: el.getAttribute('data-testid'),
          role: el.getAttribute('role'),
          cls: Array.from(el.classList).slice(0, 4).join(' '),
          scrollHeight: el.scrollHeight,
          childCount: el.children.length
        }));

      return {
        textCandidates,
        ariaEls: ariaEls.slice(0, 30),
        scrollableDivs: scrollableDivs.slice(0, 10),
        docTitle: document.title,
        bodyDataTestIds: Array.from(document.querySelectorAll('[data-testid]')).map(el => el.getAttribute('data-testid')).slice(0, 30)
      };
    })()
  `;

    const res = (await call('Runtime.evaluate', { expression: script, returnByValue: true, awaitPromise: false })) as {
        result?: { value?: unknown };
        exceptionDetails?: { text: string };
    };

    ws.close();
    if (res.exceptionDetails) { console.error(JSON.stringify({ error: res.exceptionDetails })); process.exit(1); }
    console.log(JSON.stringify(res.result?.value, null, 2));
}

main().catch(err => { console.error(String(err)); process.exit(1); });
