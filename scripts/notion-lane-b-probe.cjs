/**
 * Notion Lane B Regression Probe — Gate 6
 * Verifies that notionTurnDiscovery can find function result candidates
 * in the real Notion AI Chat DOM.
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

const PROBE_EXPR = `(function() {
    // Replicate notionTurnDiscovery.ts logic
    function containsFunctionResultLikeText(text) {
        return text.includes('<function_results') || text.includes('<function_result ');
    }
    
    function isNotionHost(hostname) {
        return hostname === 'notion.so' || hostname.endsWith('.notion.so');
    }
    
    function findPossibleTurnLanes(container) {
        var lanes = [];
        var nodes = [container];
        var divs = container.querySelectorAll('div');
        for (var i = 0; i < divs.length; i++) nodes.push(divs[i]);
        
        for (var j = 0; j < nodes.length; j++) {
            var node = nodes[j];
            if (!(node instanceof HTMLElement)) continue;
            
            var directChildren = [];
            for (var k = 0; k < node.children.length; k++) {
                if (node.children[k] instanceof HTMLElement) {
                    directChildren.push(node.children[k]);
                }
            }
            
            if (directChildren.length < 2) continue;
            
            var hasFR = directChildren.some(function(child) {
                return containsFunctionResultLikeText(child.textContent || '');
            });
            
            if (!hasFR) continue;
            lanes.push(node);
        }
        return lanes;
    }
    
    var report = {
        hostname: window.location.hostname,
        isNotionHost: isNotionHost(window.location.hostname),
        url: window.location.href.substring(0, 80),
    };
    
    // Check containers
    var containers = document.querySelectorAll('.notion-selectable-container');
    report.containerCount = containers.length;
    
    if (containers.length === 0) {
        report.status = 'NO_CONTAINERS';
        return JSON.stringify(report);
    }
    
    // Find turn lanes
    var allLanes = [];
    var allCandidates = [];
    
    for (var ci = 0; ci < containers.length; ci++) {
        var container = containers[ci];
        var lanes = findPossibleTurnLanes(container);
        
        for (var li = 0; li < lanes.length; li++) {
            var lane = lanes[li];
            var laneInfo = {
                childCount: lane.children.length,
                textLen: (lane.textContent || '').length,
            };
            allLanes.push(laneInfo);
            
            for (var ti = 0; ti < lane.children.length; ti++) {
                var child = lane.children[ti];
                if (!(child instanceof HTMLElement)) continue;
                
                var text = child.textContent || '';
                var hasFR = containsFunctionResultLikeText(text);
                var hasAIRoot = !!child.querySelector('[data-content-editable-root]');
                
                if (hasFR) {
                    allCandidates.push({
                        index: ti,
                        textLen: text.length,
                        textPreview: text.substring(0, 80),
                        containsFR: true,
                        hasAIContentRoot: hasAIRoot,
                        isUserTurn: hasFR && !hasAIRoot,
                    });
                }
            }
        }
    }
    
    report.turnLanes = allLanes;
    report.candidatesWithFR = allCandidates;
    report.userTurnCandidates = allCandidates.filter(function(c) { return c.isUserTurn; }).length;
    report.aiTurnsExcluded = allCandidates.filter(function(c) { return !c.isUserTurn; }).length;
    report.status = report.userTurnCandidates > 0 ? 'CANDIDATES_FOUND' : 'NO_USER_CANDIDATES';
    
    // Also check if MCP extension content script detected Notion correctly
    var mcpButton = document.querySelector('.mcp-notion-button-base, [class*="mcp-button"]');
    report.mcpButtonPresent = !!mcpButton;
    
    // Check for rendered function result cards (sign of successful rendering)
    var renderedCards = document.querySelectorAll('.function-result-container, .function-result-batch-container');
    report.renderedCardCount = renderedCards.length;
    
    return JSON.stringify(report);
})()`;

async function main() {
    console.log('🔍 Notion Lane B — Regression Probe (Gate 6)');

    const targets = await getTargets();
    const notion = targets.find(t => t.type === 'page' && t.url.includes('notion.so'));
    if (!notion) { console.error('❌ No Notion tab found'); process.exit(1); }
    console.log('📍 Target:', notion.url.substring(0, 60));

    const ws = new WebSocket(notion.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

    try {
        await cdpSend(ws, 'Runtime.enable');

        const res = await cdpSend(ws, 'Runtime.evaluate', {
            expression: PROBE_EXPR,
            returnByValue: true,
        });

        if (res.result && res.result.value) {
            const data = JSON.parse(res.result.value);
            console.log(JSON.stringify(data, null, 2));

            // Summary
            console.log('\n--- Summary ---');
            console.log('Status:', data.status);
            console.log('Containers:', data.containerCount);
            console.log('Turn lanes:', data.turnLanes?.length || 0);
            console.log('FR candidates:', data.candidatesWithFR?.length || 0);
            console.log('User turns (selected):', data.userTurnCandidates);
            console.log('AI turns (excluded):', data.aiTurnsExcluded);
            console.log('Rendered cards:', data.renderedCardCount);
            console.log('MCP button:', data.mcpButtonPresent);
        } else {
            console.log('Error:', JSON.stringify(res, null, 2).substring(0, 500));
        }
    } finally {
        ws.close();
    }
}

main().catch(err => {
    console.error('❌ Fatal:', err.message);
    process.exit(1);
});
