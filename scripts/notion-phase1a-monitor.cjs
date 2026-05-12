// notion-phase1a-monitor.cjs — Monitor console logs during Phase 1A echo test
// Captures AutomationService logs and checks for nonce in input
const WebSocket = require('ws');
const http = require('http');

const NONCE = 'AUTOINSERT_PHASE1A_20250714';

function getTargets() {
    return new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:9222/json', res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
    });
}

(async () => {
    const targets = await getTargets();
    const chatTab = targets.find(t => t.url.includes('notion.so/ai') || t.url.includes('notion.so/chat'));
    if (!chatTab) { console.log('ERROR: No Notion AI chat tab'); process.exit(1); }
    console.log('Monitoring tab:', chatTab.url);

    const ws = new WebSocket(chatTab.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));

    let msgId = 0;
    function send(method, params) {
        return new Promise(resolve => {
            const id = ++msgId;
            const handler = msg => {
                const obj = JSON.parse(msg);
                if (obj.id === id) { ws.off('message', handler); resolve(obj); }
            };
            ws.on('message', handler);
            ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
    }
    function val(r) { return r.result?.result?.value; }

    // Enable console and Runtime
    await send('Runtime.enable');
    await send('Log.enable');

    // Listen for console messages
    const automationLogs = [];
    const consoleListener = msg => {
        const obj = JSON.parse(msg);
        if (obj.method === 'Runtime.consoleAPICalled') {
            const text = (obj.params.args || []).map(a => a.value || a.description || '').join(' ');
            if (text.includes('AutomationService') || text.includes('automation') || 
                text.includes('auto insert') || text.includes('Auto Insert') ||
                text.includes('tool-execution-complete') || text.includes('adapter') ||
                text.includes('insertText') || text.includes('insert') ||
                text.includes(NONCE)) {
                const ts = new Date().toISOString().substring(11, 23);
                automationLogs.push(`[${ts}] ${text.substring(0, 200)}`);
                console.log(`[LOG] ${text.substring(0, 200)}`);
            }
        }
        if (obj.method === 'Log.entryAdded') {
            const text = obj.params.entry?.text || '';
            if (text.includes('AutomationService') || text.includes('auto') || text.includes(NONCE)) {
                automationLogs.push(`[LOG] ${text.substring(0, 200)}`);
                console.log(`[LOG-ENTRY] ${text.substring(0, 200)}`);
            }
        }
    };
    ws.on('message', consoleListener);

    console.log(`\nMonitoring for ${NONCE}...`);
    console.log('Waiting for echo test to complete (checking every 5 seconds for 60 seconds)...\n');

    // Poll for nonce in input every 5 seconds for up to 60 seconds
    let found = false;
    for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 5000));
        
        const check = await send('Runtime.evaluate', {
            expression: `(function() {
                const input = document.querySelector('div[role="textbox"][contenteditable="true"]');
                const text = input?.textContent || '';
                const hasNonce = text.includes('${NONCE}');
                return JSON.stringify({
                    hasNonce,
                    inputLength: text.length,
                    inputPreview: text.substring(0, 100),
                    timestamp: Date.now()
                });
            })()`,
            returnByValue: true,
        });
        const result = JSON.parse(val(check));
        
        console.log(`[Check ${i+1}/12] hasNonce=${result.hasNonce}, inputLength=${result.inputLength}`);
        if (result.inputLength > 0) {
            console.log(`  preview: "${result.inputPreview}"`);
        }
        
        if (result.hasNonce) {
            found = true;
            console.log(`\n✅ NONCE FOUND IN INPUT! autoInsert is WORKING!`);
            break;
        }
    }

    if (!found) {
        console.log(`\n❌ NONCE NOT FOUND after 60 seconds. autoInsert may not be working.`);
    }

    // Print captured logs
    console.log('\n=== CAPTURED AUTOMATION LOGS ===');
    if (automationLogs.length === 0) {
        console.log('No automation-related logs captured');
    } else {
        automationLogs.forEach(l => console.log(l));
    }
    
    ws.off('message', consoleListener);
    ws.close();
    process.exit(found ? 0 : 1);
})();
