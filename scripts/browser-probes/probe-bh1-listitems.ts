/**
 * BH-1 Probe: Find conversation items and their data/href attributes
 */

interface CdpTab { url: string; type: string; webSocketDebuggerUrl: string; }

async function main(): Promise<void> {
    const tabs = (await fetch('http://127.0.0.1:9222/json/list').then(r => r.json())) as CdpTab[];
    const tab = tabs.find(t => t.url?.includes('notion.so/ai') && t.type === 'page');
    if (!tab) { process.exit(1); }

    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise<void>(r => ws.addEventListener('open', () => r()));
    let id = 1;
    const p = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
    ws.addEventListener('message', ev => {
        try {
            const m = JSON.parse(ev.data as string) as { id?: number; result?: unknown; error?: unknown };
            if (m.id !== undefined) { const h = p.get(m.id); if (h) { p.delete(m.id); (m.error ? h.rej : h.res)(m.error as Error || m.result); } }
        } catch { }
    });
    const call = (method: string, params: object) => new Promise((res, rej) => {
        const i = id++; p.set(i, { res, rej });
        ws.send(JSON.stringify({ id: i, method, params }));
        setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('timeout')); } }, 8000);
    });

    const r = (await call('Runtime.evaluate', {
        expression: `JSON.stringify(
      Array.from(document.querySelectorAll('[role="listitem"],[role="menuitem"]'))
        .map(el => {
          // Collect all attributes
          const attrs = {};
          for (const attr of el.attributes) {
            attrs[attr.name] = attr.value;
          }
          return {
            tag: el.tagName,
            attrs,
            txt: (el.textContent || '').trim().slice(0, 60),
            childCount: el.children.length
          };
        })
        .slice(0, 20)
    )`,
        returnByValue: true,
    })) as { result?: { value?: string } };

    ws.close();
    const items = JSON.parse(r.result?.value || '[]');
    console.log(JSON.stringify(items, null, 2));
}

main().catch(e => { console.error(String(e)); process.exit(1); });
