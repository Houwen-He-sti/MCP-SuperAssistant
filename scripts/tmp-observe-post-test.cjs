// Observe current Notion page state after Phase 1B test
const http = require('http');
const WebSocket = require('ws');

(async () => {
    const targets = await new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:9222/json', res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
    });

    // Find all notion tabs
    const notionTabs = targets.filter(t => /notion\.so/.test(t.url));
    console.log(`Notion tabs (${notionTabs.length}):`);
    notionTabs.forEach(t => console.log(`  ${t.url}`));

    const tab = notionTabs.find(t => /notion\.so\/(agent|chat)/.test(t.url));
    if (!tab) { console.log('No Notion agent/chat tab'); process.exit(1); }

    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));

    let msgId = 0;
    function send(method, params, timeoutMs = 15000) {
        return new Promise((resolve, reject) => {
            const id = ++msgId;
            const timer = setTimeout(() => { ws.off('message', handler); reject(new Error('timeout')); }, timeoutMs);
            function handler(msg) {
                const obj = JSON.parse(msg);
                if (obj.id === id) { clearTimeout(timer); ws.off('message', handler); resolve(obj); }
            }
            ws.on('message', handler);
            ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
    }
    function val(r) { return r.result?.result?.value; }

    await send('Runtime.enable');

    const url = val(await send('Runtime.evaluate', { expression: 'window.location.href', returnByValue: true }));
    console.log('\nCurrent URL:', url);

    // Check for tool calls in page text
    const pageAnalysis = await send('Runtime.evaluate', {
        expression: `(function() {
            const text = document.body.innerText;
            const functionCallCount = (text.match(/function_call/g) || []).length;
            const functionResultCount = (text.match(/function_result/g) || []).length;
            const echoCount = (text.match(/echo/gi) || []).length;
            const jsonlCount = (text.match(/jsonl/g) || []).length;
            const toolNonce = text.includes('PHASE1B_TOOL_');
            const ackMarker = text.includes('PHASE1B_ACK_');
            
            // Get the assistant messages
            const assistantMsgs = document.querySelectorAll('[data-testid="assistant-message"], .notion-agent-chat-message');
            
            // Get a sample of the page text around function_call
            let sampleText = '';
            const idx = text.indexOf('function_call');
            if (idx >= 0) {
                sampleText = text.substring(Math.max(0, idx - 200), Math.min(text.length, idx + 500));
            }
            
            // Check input
            const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
            const inputText = input ? input.textContent : '';
            
            return JSON.stringify({
                url: window.location.href,
                functionCallCount,
                functionResultCount,
                echoCount,
                jsonlCount,
                toolNonce,
                ackMarker,
                inputLength: inputText.length,
                inputPreview: inputText.substring(0, 100),
                sampleAroundFunctionCall: sampleText.substring(0, 500),
                bodyTextLength: text.length,
                bodyLast500: text.substring(text.length - 500),
            });
        })()`,
        returnByValue: true,
    });

    const analysis = JSON.parse(val(pageAnalysis));
    console.log('\n=== PAGE ANALYSIS ===');
    console.log('URL:', analysis.url);
    console.log('function_call count:', analysis.functionCallCount);
    console.log('function_result count:', analysis.functionResultCount);
    console.log('echo mentions:', analysis.echoCount);
    console.log('jsonl mentions:', analysis.jsonlCount);
    console.log('TOOL_NONCE found:', analysis.toolNonce);
    console.log('ACK_MARKER found:', analysis.ackMarker);
    console.log('Input length:', analysis.inputLength);
    console.log('Input preview:', analysis.inputPreview);
    console.log('\n--- Sample around function_call ---');
    console.log(analysis.sampleAroundFunctionCall);
    console.log('\n--- Last 500 chars of body ---');
    console.log(analysis.bodyLast500);

    ws.close();
})();
