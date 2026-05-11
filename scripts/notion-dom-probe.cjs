/**
 * Notion DOM observation probe for Lane B assessment.
 * Checks if MCP-SuperAssistant's function_result_selector matches Notion AI chat DOM.
 */
const http = require('http');
const WebSocket = require('ws');

const CDP_PORT = process.env.CDP_PORT || 9222;

function getTargets() {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${CDP_PORT}/json`, res => {
            let d = '';
            res.on('data', c => (d += c));
            res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
    });
}

function cdpSend(ws, method, params = {}) {
    const id = cdpSend._counter = (cdpSend._counter || 0) + 1;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000);
        const handler = (raw) => {
            const msg = JSON.parse(raw);
            if (msg.id === id) {
                ws.removeListener('message', handler);
                clearTimeout(timer);
                if (msg.error) reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`));
                else resolve(msg.result);
            }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
    });
}

const PROBE_EXPRESSION = `(function() {
    // Check if MCP extension injected its content script
    var mcpElements = document.querySelectorAll('[class*="function-"]');
    
    // Check Notion selectors from config
    var s1 = document.querySelectorAll('div[data-content-editable-root] .whenContentEditable');
    var s2 = document.querySelectorAll('div[data-content-editable-root]');
    var s3 = document.querySelectorAll('div[class*="message"] div[class*="content"]');
    
    // Check for common Notion AI chat containers
    var notionApp = document.querySelector('.notion-app-inner');
    var notionFrame = document.querySelector('.notion-frame');
    var notionOverlay = document.querySelector('.notion-overlay-container');
    
    // Look for AI chat specific elements
    var aiPanels = document.querySelectorAll('[class*="ai"]');
    function safeClass(el) {
        var cn = el.className;
        if (typeof cn === 'string') return cn.substring(0, 80);
        if (cn && cn.baseVal) return cn.baseVal.substring(0, 80);
        return el.getAttribute('class') || '';
    }
    var aiPanelClasses = Array.from(aiPanels).slice(0, 10).map(function(el) {
        return safeClass(el);
    });
    
    // Look for chat message containers
    var chatMsgs = document.querySelectorAll('[class*="chat"]');
    var chatMsgClasses = Array.from(chatMsgs).slice(0, 10).map(function(el) {
        return el.tagName + '.' + safeClass(el).substring(0, 60);
    });
    
    // Check for user message elements
    var userEls = document.querySelectorAll('[class*="user"]');
    var userClasses = Array.from(userEls).slice(0, 10).map(function(el) {
        return el.tagName + '.' + safeClass(el).substring(0, 60);
    });
    
    // Check for function_result text anywhere
    var bodyText = document.body.textContent || '';
    var hasFunctionResult = bodyText.includes('function_result');
    var hasFunctionResults = bodyText.includes('function_results');
    
    return JSON.stringify({
        url: location.href.substring(0, 80),
        mcpElements: mcpElements.length,
        configSelectors: {
            s1_whenContentEditable: s1.length,
            s2_contentEditableRoot: s2.length,
            s3_messageContent: s3.length,
        },
        notionApp: !!notionApp,
        notionFrame: !!notionFrame,
        notionOverlay: !!notionOverlay,
        aiPanelClasses: aiPanelClasses,
        chatMsgClasses: chatMsgClasses,
        userClasses: userClasses,
        hasFunctionResultText: hasFunctionResult,
        hasFunctionResultsText: hasFunctionResults,
    });
})()`;

async function main() {
    console.log('🔍 Notion Lane B — DOM Observation Probe');
    console.log();

    const targets = await getTargets();
    const notion = targets.find(t => t.type === 'page' && t.url.includes('notion.so'));
    if (!notion) {
        console.error('❌ No Notion tab found.');
        process.exit(1);
    }
    console.log('Notion URL:', notion.url.substring(0, 80));

    const ws = new WebSocket(notion.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    try {
        await cdpSend(ws, 'Runtime.enable');

        const result = await cdpSend(ws, 'Runtime.evaluate', {
            expression: PROBE_EXPRESSION,
            returnByValue: true,
        });

        console.log('Raw result:', JSON.stringify(result, null, 2).substring(0, 500));
        if (result.result && result.result.value) {
            const data = JSON.parse(result.result.value);
            console.log(JSON.stringify(data, null, 2));
        } else {
            console.log('No value returned. Trying simpler probe...');
            const simple = await cdpSend(ws, 'Runtime.evaluate', {
                expression: 'JSON.stringify({url: location.href, title: document.title, bodyLen: document.body.innerHTML.length})',
                returnByValue: true,
            });
            console.log('Simple:', JSON.stringify(simple, null, 2).substring(0, 500));
        }
    } finally {
        ws.close();
    }
}

main().catch(err => {
    console.error('❌ Fatal:', err.message);
    process.exit(1);
});
