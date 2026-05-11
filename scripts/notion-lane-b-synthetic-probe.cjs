/**
 * Notion Lane B Synthetic Probe — Gate 6
 * 
 * Injects synthetic function_results text into an existing user turn
 * in the Notion DOM, then runs notionTurnDiscovery logic to verify
 * the discovery works against real Notion structure.
 * 
 * Non-destructive: the injection is only in-memory and will be gone on refresh.
 */
const http = require('http');
const WebSocket = require('ws');

const CDP_PORT = 9222;

function getTargets() {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${CDP_PORT}/json`, res => {
            let d = '';
            res.on('data', c => (d += c));
            res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
    });
}

let _counter = 0;
function cdpSend(ws, method, params = {}) {
    const id = ++_counter;
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

const SYNTHETIC_PROBE = `(function() {
    var report = {
        hostname: window.location.hostname,
        phase: 'synthetic-injection',
        steps: [],
    };
    
    // Step 1: Find the turn lane (div with 14 children under .notion-selectable-container)
    var container = document.querySelector('.notion-selectable-container');
    if (!container) {
        report.error = 'No container found';
        return JSON.stringify(report);
    }
    report.steps.push('Container found');
    
    // Find the turn lane — the div with many direct children
    var allDivs = container.querySelectorAll('div');
    var turnLane = null;
    for (var i = 0; i < allDivs.length; i++) {
        var d = allDivs[i];
        var htmlChildCount = 0;
        for (var j = 0; j < d.children.length; j++) {
            if (d.children[j] instanceof HTMLElement) htmlChildCount++;
        }
        if (htmlChildCount >= 8) { // Turn lanes have many children
            turnLane = d;
            break;
        }
    }
    
    if (!turnLane) {
        report.error = 'No turn lane found';
        return JSON.stringify(report);
    }
    
    report.turnLaneChildCount = turnLane.children.length;
    report.steps.push('Turn lane found with ' + turnLane.children.length + ' children');
    
    // Step 2: Find a user turn (no [data-content-editable-root])
    var userTurnIndex = -1;
    var aiTurnIndex = -1;
    for (var k = 0; k < turnLane.children.length; k++) {
        var child = turnLane.children[k];
        if (!(child instanceof HTMLElement)) continue;
        var hasAIRoot = !!child.querySelector('[data-content-editable-root]');
        if (!hasAIRoot && userTurnIndex === -1) userTurnIndex = k;
        if (hasAIRoot && aiTurnIndex === -1) aiTurnIndex = k;
    }
    
    report.userTurnIndex = userTurnIndex;
    report.aiTurnIndex = aiTurnIndex;
    
    if (userTurnIndex === -1) {
        report.error = 'No user turn found';
        return JSON.stringify(report);
    }
    report.steps.push('User turn at index ' + userTurnIndex);
    
    // Step 3: Inject synthetic function_results text into a new child of the user turn
    var userTurn = turnLane.children[userTurnIndex];
    var syntheticDiv = document.createElement('div');
    syntheticDiv.setAttribute('data-synthetic-test', 'true');
    syntheticDiv.textContent = '<function_results>\\n<result>\\n<tool_name>read_file</tool_name>\\n<stdout>\\nHello from test\\n</stdout>\\n</result>\\n</function_results>';
    userTurn.appendChild(syntheticDiv);
    report.steps.push('Synthetic FR text injected into user turn');
    
    // Step 4: Now run the discovery logic
    function containsFunctionResultLikeText(text) {
        return text.includes('<function_results') || text.includes('<function_result ');
    }
    
    function findPossibleTurnLanes(cont) {
        var lanes = [];
        var nodes = [cont];
        var divs = cont.querySelectorAll('div');
        for (var i = 0; i < divs.length; i++) nodes.push(divs[i]);
        
        for (var j = 0; j < nodes.length; j++) {
            var node = nodes[j];
            if (!(node instanceof HTMLElement)) continue;
            var directChildren = [];
            for (var k = 0; k < node.children.length; k++) {
                if (node.children[k] instanceof HTMLElement) directChildren.push(node.children[k]);
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
    
    // Run on container
    var lanes = findPossibleTurnLanes(container);
    report.discoveredLaneCount = lanes.length;
    report.steps.push('Discovery found ' + lanes.length + ' turn lanes');
    
    // Find candidates
    var candidates = [];
    for (var li = 0; li < lanes.length; li++) {
        var lane = lanes[li];
        for (var ci = 0; ci < lane.children.length; ci++) {
            var ch = lane.children[ci];
            if (!(ch instanceof HTMLElement)) continue;
            var text = ch.textContent || '';
            var hasFR = containsFunctionResultLikeText(text);
            var hasAI = !!ch.querySelector('[data-content-editable-root]');
            if (hasFR) {
                candidates.push({
                    index: ci,
                    isUserTurn: hasFR && !hasAI,
                    hasAIRoot: hasAI,
                    textLen: text.length,
                    textPreview: text.substring(0, 60),
                });
            }
        }
    }
    
    report.allFRCandidates = candidates;
    report.userTurnCandidates = candidates.filter(function(c) { return c.isUserTurn; }).length;
    report.aiTurnsExcluded = candidates.filter(function(c) { return !c.isUserTurn; }).length;
    report.steps.push('User FR candidates: ' + report.userTurnCandidates + ', AI excluded: ' + report.aiTurnsExcluded);
    
    // Step 5: Cleanup — remove the synthetic element
    syntheticDiv.remove();
    report.steps.push('Synthetic element removed');
    
    // Final verdict
    report.status = report.userTurnCandidates > 0 ? 'PASS' : 'FAIL';
    report.steps.push('Verdict: ' + report.status);
    
    return JSON.stringify(report);
})()`;

async function main() {
    console.log('🧪 Notion Lane B — Synthetic Injection Probe (Gate 6)');

    const targets = await getTargets();
    const notion = targets.find(t => t.type === 'page' && t.url.includes('notion.so'));
    if (!notion) { console.error('❌ No Notion tab found'); process.exit(1); }
    console.log('📍 Target:', notion.url.substring(0, 60));

    const ws = new WebSocket(notion.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

    try {
        await cdpSend(ws, 'Runtime.enable');

        const res = await cdpSend(ws, 'Runtime.evaluate', {
            expression: SYNTHETIC_PROBE,
            returnByValue: true,
        });

        if (res.result && res.result.value) {
            const data = JSON.parse(res.result.value);
            console.log(JSON.stringify(data, null, 2));

            console.log('\n--- Steps ---');
            for (const step of data.steps || []) {
                console.log('  ✓', step);
            }
            console.log('\n🏁 Status:', data.status);
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
