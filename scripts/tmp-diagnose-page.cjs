// Diagnose Notion page state after Phase 1B test
const http = require('http');
const WebSocket = require('ws');

(async () => {
    const targets = JSON.parse(await new Promise(r => {
        http.get('http://127.0.0.1:9222/json', res => {
            let d = ''; res.on('data', c => d += c); res.on('end', () => r(d));
        });
    }));
    const tab = targets.find(t => /notion\.so\//.test(t.url) && !/sw\.js|_assets/.test(t.url));
    if (!tab) { console.log('No Notion tab'); process.exit(1); }
    console.log('Tab:', tab.url);

    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));
    let id = 0;
    function send(method, params) {
        return new Promise((resolve, reject) => {
            const mid = ++id;
            const timer = setTimeout(() => reject(new Error('timeout')), 10000);
            ws.on('message', function h(m) {
                const o = JSON.parse(m);
                if (o.id === mid) { clearTimeout(timer); ws.off('message', h); resolve(o); }
            });
            ws.send(JSON.stringify({ id: mid, method, params }));
        });
    }
    function val(r) { return r.result?.result?.value; }

    // 1. Store state
    const store = val(await send('Runtime.evaluate', {
        expression: `(function() {
            var raw = localStorage.getItem('mcp-super-assistant-ui-store');
            if (!raw) return 'NO_STORE';
            var s = JSON.parse(raw);
            var p = s.state && s.state.preferences || {};
            return JSON.stringify({
                connectionStatus: s.state && s.state.connectionStatus,
                mcpToolCount: (s.state && s.state.mcpToolNames || []).length,
                mcpToolNames: (s.state && s.state.mcpToolNames || []).slice(0, 10),
                hasEcho: (s.state && s.state.mcpToolNames || []).some(function(n) { return n.indexOf('echo') >= 0; }),
                autoInsert: p.autoInsert,
                autoSubmit: p.autoSubmit,
            });
        })()`,
        returnByValue: true,
    }));
    console.log('\n=== STORE STATE ===');
    console.log(store);

    // 2. Page content analysis
    const page = val(await send('Runtime.evaluate', {
        expression: `(function() {
            var text = document.body.innerText;
            var toolCalls = (text.match(/function_call_start/g) || []).length;
            var results = (text.match(/function_result/g) || []).length;
            var phase1b = (text.match(/PHASE1B/g) || []).length;
            var ack = (text.match(/PHASE1B_ACK/g) || []).length;

            // Find conversation messages
            var chatMsgs = document.querySelectorAll('[data-block-id]');
            var lastFew = [];
            for (var i = Math.max(0, chatMsgs.length - 5); i < chatMsgs.length; i++) {
                lastFew.push(chatMsgs[i].textContent.substring(0, 200));
            }

            return JSON.stringify({
                url: location.href,
                toolCalls: toolCalls,
                results: results,
                phase1bMentions: phase1b,
                ackMentions: ack,
                totalMsgBlocks: chatMsgs.length,
                lastMessages: lastFew,
            });
        })()`,
        returnByValue: true,
    }));
    console.log('\n=== PAGE CONTENT ===');
    try { console.log(JSON.stringify(JSON.parse(page), null, 2)); } catch (e) { console.log(page); }

    // 3. Check input box
    const input = val(await send('Runtime.evaluate', {
        expression: `(function() {
            var inp = document.querySelector('div[role="textbox"][contenteditable="true"]');
            var btn = document.querySelector('[data-testid="agent-send-message-button"]');
            return JSON.stringify({
                hasInput: !!inp,
                inputLen: inp ? inp.textContent.length : -1,
                hasSendBtn: !!btn,
                btnDisabled: btn ? (btn.disabled || btn.getAttribute('aria-disabled') === 'true') : null,
            });
        })()`,
        returnByValue: true,
    }));
    console.log('\n=== INPUT STATE ===');
    console.log(input);

    // 4. Find "New Chat" or compose button
    const newChat = val(await send('Runtime.evaluate', {
        expression: `(function() {
            // Search buttons/links for new chat
            var candidates = [];
            var all = document.querySelectorAll('button, a, [role="button"], [role="menuitem"]');
            for (var i = 0; i < all.length; i++) {
                var el = all[i];
                var text = (el.textContent || '').trim();
                var label = el.getAttribute('aria-label') || '';
                var testid = el.getAttribute('data-testid') || '';
                if (text.length < 30 || label || testid) {
                    if (/new|chat|新|compose|create/i.test(text + label + testid)) {
                        candidates.push({ text: text.substring(0, 30), label: label, testid: testid, tag: el.tagName });
                    }
                }
            }
            // Also look for edit/compose icons near the top
            var sidebar = document.querySelector('.notion-sidebar');
            var sidebarBtns = sidebar ? sidebar.querySelectorAll('button, a, [role="button"]') : [];
            for (var j = 0; j < sidebarBtns.length; j++) {
                var btn = sidebarBtns[j];
                candidates.push({ sidebarBtn: true, text: (btn.textContent||'').substring(0,30), label: btn.getAttribute('aria-label')||'', testid: btn.getAttribute('data-testid')||'' });
            }
            return JSON.stringify(candidates.slice(0, 15));
        })()`,
        returnByValue: true,
    }));
    console.log('\n=== NEW CHAT CANDIDATES ===');
    try { console.log(JSON.stringify(JSON.parse(newChat), null, 2)); } catch (e) { console.log(newChat); }

    ws.close();
    console.log('\nDone.');
})().catch(e => console.error(e));
