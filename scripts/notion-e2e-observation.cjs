/**
 * Notion E2E Rendering Observation — Gate 6 OO
 * 
 * Injects realistic function_results content into the Notion DOM,
 * waits for the MutationObserver to detect it, and checks if the
 * extension's rendering pipeline processes it end-to-end.
 * 
 * This is a non-destructive test — injected content is cleaned up.
 * 
 * Observation targets:
 * 1. Does the MutationObserver fire?
 * 2. Does getTargetElements() return the injected element?
 * 3. Does renderFunctionResult() produce a card?
 * 4. What DOM changes appear after processing?
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

// Realistic function_results XML that should trigger parsing
const FUNCTION_RESULTS_XML = `<function_results>
<result>
<tool_name>read_file</tool_name>
<stdout>
# README.md

This is a test file for E2E verification.
Gate 6 Lane B — Notion rendering pipeline.
</stdout>
</result>
</function_results>`;

async function main() {
    console.log('🔬 Notion E2E Rendering Observation — Gate 6 OO');
    console.log('='.repeat(60));

    const targets = await getTargets();
    // Prefer the chat page (has turn lanes) over the AI landing page
    const notion = targets.find(t => t.type === 'page' && t.url.includes('notion.so/chat'))
        || targets.find(t => t.type === 'page' && t.url.includes('notion.so'));
    if (!notion) { console.error('❌ No Notion tab found'); process.exit(1); }
    console.log('📍 Target:', notion.url.substring(0, 80));

    const ws = new WebSocket(notion.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

    // Collect console messages
    const consoleMessages = [];
    const consoleHandler = (raw) => {
        const msg = JSON.parse(raw);
        if (msg.method === 'Runtime.consoleAPICalled') {
            const args = msg.params.args.map(a => a.value || a.description || '').join(' ');
            consoleMessages.push({
                type: msg.params.type,
                text: args.substring(0, 300),
                timestamp: Date.now(),
            });
        }
    };

    try {
        await cdpSend(ws, 'Runtime.enable');
        await cdpSend(ws, 'Log.enable');
        ws.on('message', consoleHandler);

        // Step 1: Check pre-injection state
        console.log('\n--- Step 1: Pre-injection State ---');
        const preState = await cdpSend(ws, 'Runtime.evaluate', {
            expression: `(function() {
                return JSON.stringify({
                    functionResultContainers: document.querySelectorAll('.function-result-container, .function-result-batch-container').length,
                    mcpElements: document.querySelectorAll('[class*="mcp-"]').length,
                    processedElements: document.querySelectorAll('[data-mcp-processed]').length,
                });
            })()`,
            returnByValue: true,
        });
        console.log('Pre-state:', JSON.parse(preState.result.value));

        // Step 2: Inject function_results into a user turn
        console.log('\n--- Step 2: Injecting function_results ---');
        const injectResult = await cdpSend(ws, 'Runtime.evaluate', {
            expression: `(function() {
                var container = document.querySelector('.notion-selectable-container');
                if (!container) return JSON.stringify({error: 'no container'});
                
                // Find the turn lane
                var allDivs = container.querySelectorAll('div');
                var turnLane = null;
                for (var i = 0; i < allDivs.length; i++) {
                    if (allDivs[i].children.length >= 8) { turnLane = allDivs[i]; break; }
                }
                if (!turnLane) return JSON.stringify({error: 'no turn lane'});
                
                // Find a user turn (no data-content-editable-root)
                var userTurnIdx = -1;
                for (var k = 0; k < turnLane.children.length; k++) {
                    var child = turnLane.children[k];
                    if (child instanceof HTMLElement && !child.querySelector('[data-content-editable-root]')) {
                        userTurnIdx = k;
                        break;
                    }
                }
                if (userTurnIdx === -1) return JSON.stringify({error: 'no user turn'});
                
                // Create a new div that simulates a user turn with function_results
                var syntheticTurn = document.createElement('div');
                syntheticTurn.id = 'mcp-e2e-test-turn';
                syntheticTurn.textContent = ${JSON.stringify(FUNCTION_RESULTS_XML)};
                
                // Insert after the first user turn
                var refNode = turnLane.children[userTurnIdx + 1] || null;
                turnLane.insertBefore(syntheticTurn, refNode);
                
                return JSON.stringify({
                    injected: true,
                    turnLaneChildren: turnLane.children.length,
                    insertedAtIndex: userTurnIdx + 1,
                    syntheticTextLen: syntheticTurn.textContent.length,
                    syntheticText: syntheticTurn.textContent.substring(0, 100),
                });
            })()`,
            returnByValue: true,
        });
        const injectData = JSON.parse(injectResult.result.value);
        console.log('Injection:', injectData);

        if (!injectData.injected) {
            console.error('❌ Injection failed:', injectData.error);
            ws.close();
            return;
        }

        // Step 3: Wait for MutationObserver to fire + processing
        console.log('\n--- Step 3: Waiting for observer processing (3s) ---');
        await new Promise(r => setTimeout(r, 3000));

        // Step 4: Check post-injection state
        console.log('\n--- Step 4: Post-injection State ---');
        const postState = await cdpSend(ws, 'Runtime.evaluate', {
            expression: `(function() {
                var testTurn = document.getElementById('mcp-e2e-test-turn');
                if (!testTurn) return JSON.stringify({error: 'test turn disappeared'});
                
                return JSON.stringify({
                    // Extension-rendered elements
                    functionResultContainers: document.querySelectorAll('.function-result-container, .function-result-batch-container').length,
                    mcpElements: document.querySelectorAll('[class*="mcp-"]').length,
                    processedElements: document.querySelectorAll('[data-mcp-processed]').length,
                    
                    // The test turn state
                    testTurnExists: true,
                    testTurnChildCount: testTurn.children.length,
                    testTurnInnerHTML: testTurn.innerHTML.substring(0, 500),
                    testTurnTextContent: testTurn.textContent.substring(0, 200),
                    
                    // Check if any function-result cards appeared inside the test turn
                    testTurnHasCards: testTurn.querySelectorAll('.function-result-container, .function-result-batch-container, [class*="function-result"]').length,
                    
                    // Check for any new elements in the whole document  
                    allFunctionResultCards: document.querySelectorAll('.function-result-container').length,
                    allBatchContainers: document.querySelectorAll('.function-result-batch-container').length,
                });
            })()`,
            returnByValue: true,
        });
        const postData = JSON.parse(postState.result.value);
        console.log('Post-state:', JSON.stringify(postData, null, 2));

        // Step 5: Cleanup
        console.log('\n--- Step 5: Cleanup ---');
        await cdpSend(ws, 'Runtime.evaluate', {
            expression: `(function() {
                var el = document.getElementById('mcp-e2e-test-turn');
                if (el) el.remove();
                return JSON.stringify({cleaned: true});
            })()`,
            returnByValue: true,
        });
        console.log('Cleaned up synthetic test element');

        // Step 6: Console messages captured
        ws.removeListener('message', consoleHandler);

        console.log('\n--- Console Messages During Test ---');
        if (consoleMessages.length > 0) {
            for (const msg of consoleMessages) {
                console.log(`  [${msg.type}] ${msg.text}`);
            }
        } else {
            console.log('  (no console messages captured)');
        }

        // Step 7: Verdict
        console.log('\n--- Verdict ---');
        if (postData.testTurnHasCards > 0 || postData.allFunctionResultCards > 0) {
            console.log('✅ PASS: Function result cards rendered');
        } else if (postData.testTurnChildCount > 0) {
            console.log('⚠️ PARTIAL: Test turn has children but no function result cards');
            console.log('   innerHTML:', postData.testTurnInnerHTML);
        } else {
            console.log('❌ NO RENDERING: Observer did not process the injected content');
            console.log('   Possible causes:');
            console.log('   - Observer not running on Notion');
            console.log('   - getTargetElements() not returning injected element');
            console.log('   - renderFunctionResult() not recognizing content format');
        }

    } finally {
        ws.close();
    }
}

main().catch(err => {
    console.error('❌ Fatal:', err.message);
    process.exit(1);
});
