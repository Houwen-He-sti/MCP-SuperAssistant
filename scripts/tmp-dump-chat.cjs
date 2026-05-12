// tmp-dump-chat.cjs — Dump all chat text from Notion AI page
const http = require('http');
const WebSocket = require('ws');

(async () => {
    const targets = JSON.parse(await new Promise(r => {
        http.get('http://127.0.0.1:9222/json', res => {
            let d = ''; res.on('data', c => d += c); res.on('end', () => r(d));
        });
    }));
    const t = targets.find(t => /notion\.so\//.test(t.url) && !/sw\.js|_assets/.test(t.url));
    if (!t) { console.log('No Notion tab'); process.exit(1); }
    console.log('Tab:', t.url);
    const cdp = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise(r => cdp.on('open', r));
    let id = 1;
    const send = (m, p = {}) => new Promise(r => {
        const mid = id++;
        cdp.on('message', function h(d) {
            const msg = JSON.parse(d);
            if (msg.id === mid) { cdp.removeListener('message', h); r(msg); }
        });
        cdp.send(JSON.stringify({ id: mid, method: m, params: p }));
    });
    {
        // Dump the full inner text of the main content area
        const r = await send('Runtime.evaluate', {
            expression: `(function() {
        // Get ALL text blocks that look like chat messages (Notion uses specific structure)
        // The chat area in Notion AI typically has a scrollable container
        var fullPage = document.body.innerText;
        
        // Find all elements that might be message content
        // Notion renders messages in blocks with specific data attributes
        var allDivs = document.querySelectorAll('div');
        var chatContent = '';
        var maxWidth = 0;
        var chatContainer = null;
        
        // Strategy: find the widest container that's NOT the sidebar
        // Sidebar is typically narrower; chat area is wider
        for (var i = 0; i < allDivs.length; i++) {
          var rect = allDivs[i].getBoundingClientRect();
          if (rect.width > 500 && rect.height > 300 && rect.left > 200) {
            // This is likely the chat area (right side, wide, tall)
            if (rect.width > maxWidth) {
              maxWidth = rect.width;
              chatContainer = allDivs[i];
            }
          }
        }
        
        if (chatContainer) {
          chatContent = chatContainer.innerText;
        }
        
        // Also try to find specific message elements
        var msgElements = document.querySelectorAll('[data-content-editable-leaf], [data-block-id]');
        var blockTexts = [];
        for (var j = 0; j < Math.min(msgElements.length, 30); j++) {
          var txt = msgElements[j].innerText?.trim();
          if (txt && txt.length > 10) blockTexts.push(txt.substring(0, 200));
        }
        
        return JSON.stringify({
          chatLen: chatContent.length,
          chatTail: chatContent.substring(Math.max(0, chatContent.length - 4000)),
          blockCount: msgElements.length,
          blocks: blockTexts,
        });
      })()`,
            returnByValue: true,
        });
        const val = r.result?.result?.value || r.result?.value;
        if (val) {
            const d = JSON.parse(val);
            console.log('chatLen:', d.chatLen, 'blocks:', d.blockCount);
            console.log('\n--- Chat area text (tail) ---');
            console.log(d.chatTail);
            if (d.blocks?.length) {
                console.log('\n--- Block texts ---');
                d.blocks.forEach((b, i) => console.log(`[${i}]`, b));
            }
        } else {
            console.log('No value:', JSON.stringify(r.result));
        }
        cdp.close();
    }
})();
