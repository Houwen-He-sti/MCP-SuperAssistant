/**
 * Notion Extension Runtime Observation — Gate 6 OO
 * 
 * Observes the actual behavior of the MCP-SuperAssistant extension
 * on the live Notion page:
 * 1. Is the content script loaded?
 * 2. Is the MutationObserver active?
 * 3. Are there any console errors/warnings?
 * 4. What does the extension detect?
 * 5. What DOM state exists?
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
    console.log('🔬 Notion Extension Runtime Observation — Gate 6 OO');
    console.log('='.repeat(60));

    const targets = await getTargets();
    const notion = targets.find(t => t.type === 'page' && t.url.includes('notion.so'));
    if (!notion) { console.error('❌ No Notion tab found'); process.exit(1); }
    console.log('📍 Target:', notion.url.substring(0, 80));

    const ws = new WebSocket(notion.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

    try {
        await cdpSend(ws, 'Runtime.enable');
        await cdpSend(ws, 'Log.enable');

        // 1. Check if MCP extension content script globals exist
        console.log('\n--- 1. Extension Content Script Presence ---');
        const scriptCheck = await cdpSend(ws, 'Runtime.evaluate', {
            expression: `(function() {
                var checks = {};
                // Check for extension-injected elements
                checks.mcpElements = document.querySelectorAll('[class*="mcp-"]').length;
                checks.functionResultContainers = document.querySelectorAll('.function-result-container, .function-result-batch-container').length;
                
                // Check for extension script tags or injected scripts
                var scripts = document.querySelectorAll('script');
                checks.totalScripts = scripts.length;
                
                // Check if our CSS is injected
                var styles = document.querySelectorAll('style');
                var mcpStyles = 0;
                for (var i = 0; i < styles.length; i++) {
                    var text = styles[i].textContent || '';
                    if (text.includes('function-result') || text.includes('mcp-')) mcpStyles++;
                }
                checks.mcpStyleSheets = mcpStyles;
                
                // Check for shadow DOMs from extension
                var allElements = document.querySelectorAll('*');
                var shadowHosts = 0;
                for (var j = 0; j < allElements.length; j++) {
                    if (allElements[j].shadowRoot) shadowHosts++;
                }
                checks.shadowHosts = shadowHosts;
                
                return JSON.stringify(checks);
            })()`,
            returnByValue: true,
        });
        console.log(JSON.parse(scriptCheck.result.value));

        // 2. Check for console messages from extension
        console.log('\n--- 2. Recent Console Messages ---');
        // Collect console messages for a short period
        const consoleMessages = [];
        const consoleHandler = (raw) => {
            const msg = JSON.parse(raw);
            if (msg.method === 'Runtime.consoleAPICalled') {
                const args = msg.params.args.map(a => a.value || a.description || '').join(' ');
                if (args.includes('MCP') || args.includes('mcp') || args.includes('function') ||
                    args.includes('observer') || args.includes('notion') || args.includes('Notion') ||
                    args.includes('render') || args.includes('config') || args.includes('error') ||
                    args.includes('Error') || args.includes('ERROR')) {
                    consoleMessages.push({
                        type: msg.params.type,
                        text: args.substring(0, 200),
                    });
                }
            }
        };
        ws.on('message', consoleHandler);

        // 3. Trigger a page refresh to see extension load sequence
        console.log('\n--- 3. Extension Config Detection ---');
        const configCheck = await cdpSend(ws, 'Runtime.evaluate', {
            expression: `(function() {
                // Try to find what the extension injects
                var result = {};
                
                // Check all iframes (extension might use content world)
                var iframes = document.querySelectorAll('iframe');
                result.iframeCount = iframes.length;
                result.iframeSrcs = [];
                for (var i = 0; i < iframes.length && i < 5; i++) {
                    result.iframeSrcs.push((iframes[i].src || '').substring(0, 80));
                }
                
                // Check for data attributes that extension might set
                var root = document.documentElement;
                result.htmlAttrs = {};
                for (var j = 0; j < root.attributes.length; j++) {
                    var attr = root.attributes[j];
                    if (attr.name.includes('mcp') || attr.name.includes('extension')) {
                        result.htmlAttrs[attr.name] = attr.value;
                    }
                }
                
                // Check for Notion-specific DOM structure
                result.notionSelectable = document.querySelectorAll('.notion-selectable-container').length;
                result.contentEditableRoots = document.querySelectorAll('[data-content-editable-root]').length;
                result.whenContentEditable = document.querySelectorAll('.whenContentEditable').length;
                
                // Check page title/type
                result.title = document.title.substring(0, 50);
                result.pathname = window.location.pathname;
                
                return JSON.stringify(result);
            })()`,
            returnByValue: true,
        });
        console.log(JSON.parse(configCheck.result.value));

        // 4. Check extension execution context
        console.log('\n--- 4. Extension Execution Contexts ---');
        const contexts = await cdpSend(ws, 'Runtime.evaluate', {
            expression: `(function() {
                // Check for window properties that the extension might set
                var extensionProps = [];
                for (var key in window) {
                    try {
                        if (typeof key === 'string' && (key.toLowerCase().includes('mcp') || key.toLowerCase().includes('superassistant'))) {
                            extensionProps.push(key);
                        }
                    } catch(e) {}
                }
                return JSON.stringify({
                    extensionWindowProps: extensionProps,
                    chromeRuntime: typeof chrome !== 'undefined' && typeof chrome.runtime !== 'undefined',
                });
            })()`,
            returnByValue: true,
        });
        console.log(JSON.parse(contexts.result.value));

        // 5. Check the DOM structure at turn-lane level
        console.log('\n--- 5. Turn Lane DOM Structure ---');
        const turnStructure = await cdpSend(ws, 'Runtime.evaluate', {
            expression: `(function() {
                var container = document.querySelector('.notion-selectable-container');
                if (!container) return JSON.stringify({error: 'no container'});
                
                // Find turn lane
                var allDivs = container.querySelectorAll('div');
                var turnLane = null;
                for (var i = 0; i < allDivs.length; i++) {
                    if (allDivs[i].children.length >= 8) { turnLane = allDivs[i]; break; }
                }
                if (!turnLane) return JSON.stringify({error: 'no turn lane'});
                
                var turns = [];
                for (var j = 0; j < turnLane.children.length && j < 20; j++) {
                    var child = turnLane.children[j];
                    if (!(child instanceof HTMLElement)) continue;
                    var hasAIRoot = !!child.querySelector('[data-content-editable-root]');
                    var hasFR = (child.textContent || '').includes('<function_results') || 
                                (child.textContent || '').includes('<function_result ');
                    turns.push({
                        index: j,
                        tag: child.tagName,
                        classes: child.className.substring(0, 40),
                        childCount: child.children.length,
                        textLen: (child.textContent || '').length,
                        hasAIContentRoot: hasAIRoot,
                        hasFunctionResults: hasFR,
                        role: hasAIRoot ? 'AI' : 'USER',
                        textPreview: (child.textContent || '').substring(0, 60).replace(/\\n/g, ' '),
                    });
                }
                
                return JSON.stringify({
                    containerChildren: container.children.length,
                    turnLaneChildren: turnLane.children.length,
                    turnLaneClasses: turnLane.className.substring(0, 60),
                    turns: turns,
                });
            })()`,
            returnByValue: true,
        });
        const turnData = JSON.parse(turnStructure.result.value);
        console.log('Turn lane:', turnData.turnLaneChildren, 'children');
        console.log('Classes:', turnData.turnLaneClasses);
        if (turnData.turns) {
            console.log('\nTurn breakdown:');
            for (const turn of turnData.turns) {
                const marker = turn.hasFunctionResults ? '🔧' : (turn.role === 'AI' ? '🤖' : '👤');
                console.log(`  ${marker} [${turn.index}] ${turn.role} | children=${turn.childCount} textLen=${turn.textLen} | ${turn.textPreview}`);
            }
        }

        // Wait a moment for any console messages
        await new Promise(r => setTimeout(r, 2000));
        ws.removeListener('message', consoleHandler);

        if (consoleMessages.length > 0) {
            console.log('\n--- Captured Console Messages ---');
            for (const msg of consoleMessages) {
                console.log(`  [${msg.type}] ${msg.text}`);
            }
        } else {
            console.log('\n--- No relevant console messages captured ---');
        }

    } finally {
        ws.close();
    }
}

main().catch(err => {
    console.error('❌ Fatal:', err.message);
    process.exit(1);
});
