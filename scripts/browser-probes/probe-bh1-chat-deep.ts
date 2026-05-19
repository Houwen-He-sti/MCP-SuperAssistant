/**
 * BH-1 Probe: Deep probe of open conversation DOM structure
 * Probes .layout-chat and message containers while a conversation is open.
 */

interface CdpTab { url: string; type: string; webSocketDebuggerUrl: string; }

async function main(): Promise<void> {
    const tabs = (await fetch('http://127.0.0.1:9222/json/list').then(r => r.json())) as CdpTab[];
    // Find the tab that's now on /chat (conversation page)
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
      // 1. layout-chat: is there a specific class for the chat content area?
      const layoutChat = document.querySelector('.layout-chat');
      const layoutContent = document.querySelector('.layout-content');
      
      // 2. Find the conversation messages container
      // The messages might be in a virtual scrolled list or a direct list
      const chatContainer = layoutChat || layoutContent;
      
      let messageStructure = null;
      if (chatContainer) {
        // Find the actual messages: elements that contain assistant/user message content
        const allChildren = Array.from(chatContainer.querySelectorAll('*'));
        
        // Look for message blocks: typically have aria attributes or text content
        const messageBlocks = allChildren
          .filter(el => {
            const txt = (el.textContent || '').trim();
            return txt.length > 20 && txt.length < 5000 &&
                   el.children.length > 0 && el.children.length < 50;
          })
          .slice(0, 10)
          .map(el => ({
            tag: el.tagName,
            testId: el.getAttribute('data-testid'),
            role: el.getAttribute('role'),
            ariaLabel: el.getAttribute('aria-label'),
            cls: Array.from(el.classList).slice(0, 6).join(' '),
            textLen: (el.textContent || '').trim().length,
            textSnippet: (el.textContent || '').trim().slice(0, 100),
            childCount: el.children.length
          }));
        
        messageStructure = {
          containerFound: true,
          containerTag: chatContainer.tagName,
          containerCls: Array.from(chatContainer.classList).slice(0, 6).join(' '),
          containerChildren: chatContainer.children.length,
          messageBlocks: messageBlocks.slice(0, 8)
        };
      }
      
      // 3. Identify aria-live regions (for streaming detection)
      const ariaLiveEls = Array.from(document.querySelectorAll('[aria-live],[aria-busy],[aria-atomic]'))
        .map(el => ({
          tag: el.tagName,
          ariaLive: el.getAttribute('aria-live'),
          ariaBusy: el.getAttribute('aria-busy'),
          ariaAtomic: el.getAttribute('aria-atomic'),
          testId: el.getAttribute('data-testid'),
          cls: Array.from(el.classList).slice(0, 4).join(' '),
          textLen: (el.textContent || '').trim().length
        }));
      
      // 4. Probe specific selectors for message content
      const MESSAGE_CANDIDATE_SELS = [
        '[data-testid="message"]',
        '[data-testid="chat-message"]',
        '[data-testid="assistant-message"]',
        '[data-testid="user-message"]',
        '.notion-ai-message',
        '.chat-message',
        '.message-content',
        '[class*="message"]',
        '[class*="Message"]'
      ];
      const msgSelResults = MESSAGE_CANDIDATE_SELS.map(sel => ({
        selector: sel,
        count: document.querySelectorAll(sel).length
      })).filter(r => r.count > 0);
      
      // 5. Find the chat-scroller / message list parent
      // Look for a parent that has multiple similar children with text > 20 chars
      const allDivs = Array.from(document.querySelectorAll('[class*="chat"],[class*="message"],[class*="conversation"],[class*="dialogue"]'));
      const chatClassEls = allDivs.slice(0, 20).map(el => ({
        tag: el.tagName,
        cls: Array.from(el.classList).join(' '),
        testId: el.getAttribute('data-testid'),
        textLen: (el.textContent || '').trim().length,
        childCount: el.children.length
      }));
      
      // 6. Look for the streaming state: 'stop' or 'cancel' button variants
      const STOP_VARIANTS = [
        '[data-testid="stop-button"]',
        '[data-testid="stop-generating"]',
        '[aria-label*="Stop"]',
        '[aria-label*="stop"]',
        'button[title*="Stop"]',
        '[aria-label*="Cancel"]',
        '[aria-label*="生成"]',
        '[aria-label*="停止"]'
      ];
      const stopResults = STOP_VARIANTS.map(sel => ({
        selector: sel,
        found: document.querySelector(sel) !== null,
        count: document.querySelectorAll(sel).length
      })).filter(r => r.found);
      
      return {
        url: window.location.href,
        layoutChatFound: !!layoutChat,
        layoutContentFound: !!layoutContent,
        messageStructure,
        ariaLiveEls,
        msgSelResults,
        chatClassEls,
        stopResults,
        allTestIds: Array.from(new Set(
          Array.from(document.querySelectorAll('[data-testid]'))
            .map(el => el.getAttribute('data-testid'))
        )).sort(),
        timestamp: new Date().toISOString()
      };
    })())`,
        returnByValue: true,
    })) as { result?: { value?: string }; exceptionDetails?: unknown };

    ws.close();
    if (!r.result?.value) { console.error(JSON.stringify(r.exceptionDetails)); process.exit(1); }
    const data = JSON.parse(r.result.value);
    console.log(JSON.stringify(data, null, 2));
}

main().catch(e => { console.error(String(e)); process.exit(1); });
