/**
 * Notion Deep Observer Diagnosis — Gate 6 OO
 * 
 * Probes the extension's content script execution context to check:
 * 1. Is the MutationObserver actually connected?
 * 2. Does getTargetElements() work when called manually?
 * 3. Where does the pipeline break?
 * 
 * Uses Runtime.evaluate with contextId to access the extension's isolated world.
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

async function main() {
    console.log('🔬 Notion Deep Observer Diagnosis — Gate 6 OO');
    console.log('='.repeat(60));
    
    const targets = await getTargets();
    const notion = targets.find(t => t.type === 'page' && t.url.includes('notion.so/chat'))
        || targets.find(t => t.type === 'page' && t.url.includes('notion.so'));
    if (!notion) { console.error('❌ No Notion tab found'); process.exit(1); }
    console.log('📍 Target:', notion.url.substring(0, 80));
    
    const ws = new WebSocket(notion.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    
    // Collect ALL console messages
    const consoleMessages = [];
    const consoleHandler = (raw) => {
        const msg = JSON.parse(raw);
        if (msg.method === 'Runtime.consoleAPICalled') {
            const args = msg.params.args.map(a => a.value || a.description || a.type || '').join(' ');
            consoleMessages.push({
                type: msg.params.type,
                text: args.substring(0, 400),
                contextId: msg.params.executionContextId,
            });
        }
    };
    
    // Track execution contexts
    const contexts = [];
    const contextHandler = (raw) => {
        const msg = JSON.parse(raw);
        if (msg.method === 'Runtime.executionContextCreated') {
            contexts.push(msg.params.context);
        }
    };
    
    try {
        ws.on('message', contextHandler);
        await cdpSend(ws, 'Runtime.enable');
        
        // Wait for context events to settle
        await new Promise(r => setTimeout(r, 1000));
        ws.removeListener('message', contextHandler);
        
        // Step 1: List all execution contexts
        console.log('\n--- Step 1: Execution Contexts ---');
        for (const ctx of contexts) {
            const isExtension = (ctx.origin || '').includes('chrome-extension://');
            const marker = isExtension ? '🔌' : '🌐';
            console.log(`  ${marker} ID=${ctx.id} | ${ctx.origin || 'no-origin'} | name=${ctx.name || 'none'}`);
        }
        
        // Find extension context
        const extContext = contexts.find(c => (c.origin || '').includes('chrome-extension://hkjclekhnaffnhldgpmjnohihjmblbpj'));
        
        if (!extContext) {
            console.log('\n❌ No extension execution context found!');
            console.log('This means the content script may not be running on this page.');
            
            // Check if extension is in manifest for this URL
            console.log('\n--- Checking extension manifest matches ---');
            const urlCheck = await cdpSend(ws, 'Runtime.evaluate', {
                expression: `JSON.stringify({
                    url: window.location.href,
                    hostname: window.location.hostname,
                    pathname: window.location.pathname,
                })`,
                returnByValue: true,
            });
            console.log('Page:', JSON.parse(urlCheck.result.value));
            
            ws.close();
            return;
        }
        
        console.log(`\n✅ Extension context found: ID=${extContext.id}`);
        
        // Step 2: Evaluate in extension context
        console.log('\n--- Step 2: Extension State Check ---');
        ws.on('message', consoleHandler);
        
        const extState = await cdpSend(ws, 'Runtime.evaluate', {
            contextId: extContext.id,
            expression: `(function() {
                // Log to console so we can see it
                console.log('[OO-PROBE] Checking extension state in isolated world');
                
                var report = {};
                
                // Check if CONFIG is accessible
                try {
                    // These are module-scoped, not accessible from eval in isolated world
                    // But let's try to detect what we can
                    report.windowKeys = Object.keys(window).filter(function(k) {
                        return k.includes('mcp') || k.includes('function') || k.includes('configure') || k.includes('MCP');
                    });
                } catch(e) {
                    report.windowKeysError = e.message;
                }
                
                // Check for MCP extension CSS
                var styles = document.querySelectorAll('style');
                var mcpStyles = [];
                for (var i = 0; i < styles.length; i++) {
                    var text = styles[i].textContent || '';
                    if (text.includes('function-result') || text.includes('mcp-')) {
                        mcpStyles.push({
                            len: text.length,
                            sample: text.substring(0, 100),
                        });
                    }
                }
                report.mcpStyles = mcpStyles;
                
                // Check for notion-selectable-container  
                report.containers = document.querySelectorAll('.notion-selectable-container').length;
                report.aiRoots = document.querySelectorAll('[data-content-editable-root]').length;
                
                return JSON.stringify(report);
            })()`,
            returnByValue: true,
        });
        
        if (extState.result && extState.result.value) {
            console.log(JSON.parse(extState.result.value));
        } else if (extState.exceptionDetails) {
            console.log('Error:', extState.exceptionDetails.text || JSON.stringify(extState.exceptionDetails).substring(0, 200));
        }
        
        // Step 3: Inject function_results and observe from extension context  
        console.log('\n--- Step 3: Inject + Observe from Extension Context ---');
        
        // First inject from main world
        const injectResult = await cdpSend(ws, 'Runtime.evaluate', {
            expression: `(function() {
                var container = document.querySelector('.notion-selectable-container');
                if (!container) return JSON.stringify({error: 'no container'});
                var allDivs = container.querySelectorAll('div');
                var turnLane = null;
                for (var i = 0; i < allDivs.length; i++) {
                    if (allDivs[i].children.length >= 8) { turnLane = allDivs[i]; break; }
                }
                if (!turnLane) return JSON.stringify({error: 'no turn lane'});
                
                var syntheticTurn = document.createElement('div');
                syntheticTurn.id = 'mcp-e2e-test-turn-v2';
                syntheticTurn.textContent = '<function_results>\\n<result>\\n<tool_name>read_file</tool_name>\\n<stdout>\\nGate 6 OO test content\\n</stdout>\\n</result>\\n</function_results>';
                
                var userIdx = -1;
                for (var k = 0; k < turnLane.children.length; k++) {
                    if (!turnLane.children[k].querySelector || !turnLane.children[k].querySelector('[data-content-editable-root]')) {
                        userIdx = k; break;
                    }
                }
                
                turnLane.insertBefore(syntheticTurn, turnLane.children[userIdx + 1] || null);
                console.log('[OO-PROBE] Synthetic turn injected at index', userIdx + 1);
                return JSON.stringify({injected: true, index: userIdx + 1});
            })()`,
            returnByValue: true,
        });
        console.log('Inject:', JSON.parse(injectResult.result.value));
        
        // Wait for observer to fire
        console.log('Waiting 4s for observer...');
        await new Promise(r => setTimeout(r, 4000));
        
        // Check state from extension context
        const postCheck = await cdpSend(ws, 'Runtime.evaluate', {
            contextId: extContext.id,
            expression: `(function() {
                console.log('[OO-PROBE] Post-injection check from extension context');
                var testEl = document.getElementById('mcp-e2e-test-turn-v2');
                return JSON.stringify({
                    testElementExists: !!testEl,
                    testElementText: testEl ? testEl.textContent.substring(0, 80) : null,
                    testElementChildren: testEl ? testEl.children.length : 0,
                    testElementInnerHTML: testEl ? testEl.innerHTML.substring(0, 300) : null,
                    functionResultContainers: document.querySelectorAll('.function-result-container').length,
                    batchContainers: document.querySelectorAll('.function-result-batch-container').length,
                    dataBlockIds: document.querySelectorAll('[data-block-id]').length,
                });
            })()`,
            returnByValue: true,
        });
        
        if (postCheck.result && postCheck.result.value) {
            const postData = JSON.parse(postCheck.result.value);
            console.log('\nPost-injection state:');
            console.log(JSON.stringify(postData, null, 2));
        }
        
        // Cleanup
        await cdpSend(ws, 'Runtime.evaluate', {
            expression: `(function() {
                var el = document.getElementById('mcp-e2e-test-turn-v2');
                if (el) el.remove();
            })()`,
        });
        
        // Print all console messages
        ws.removeListener('message', consoleHandler);
        await new Promise(r => setTimeout(r, 500));
        
        console.log('\n--- All Console Messages ---');
        if (consoleMessages.length > 0) {
            for (const msg of consoleMessages) {
                console.log(`  [ctx=${msg.contextId}][${msg.type}] ${msg.text}`);
            }
        } else {
            console.log('  (no messages)');
        }
        
    } finally {
        ws.close();
    }
}

main().catch(err => {
    console.error('❌ Fatal:', err.message);
    process.exit(1);
});
