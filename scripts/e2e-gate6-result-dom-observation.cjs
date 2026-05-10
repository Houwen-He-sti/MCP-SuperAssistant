/**
 * Gate 6 Observation: Tool Result Message DOM Structure
 *
 * OO-PL-TDD Phase 1 — Observe how submitted function_result appears
 * in Notion AI conversation DOM.
 *
 * Observes:
 * O1: User message DOM structure after autoSubmit
 * O2: ToolResultRenderer v1 card survival after submit
 * O3: function_results XML detection feasibility in message DOM
 *
 * Prerequisites:
 * - Chrome/Comet with --remote-debugging-port=9222
 * - Notion agent page open (with MCP tools available)
 * - Extension built: npx turbo build
 * - MCP proxy server running
 *
 * Run: node scripts/e2e-gate6-result-dom-observation.cjs
 */

const WebSocket = require('ws');
const { preflight } = require('./lib/cdp-preflight.cjs');

// ── Config ──

const OBSERVATION_WAIT_MS = 10000; // Wait for DOM to settle after observation
const MAX_MESSAGES_TO_SCAN = 20;

// ── Helpers ──

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function timestamp() { return new Date().toISOString(); }

class CDP {
    constructor(wsUrl) {
        this.ws = new WebSocket(wsUrl);
        this.nextId = 1;
        this.pending = new Map();
    }
    async connect() {
        await new Promise((resolve, reject) => {
            this.ws.on('open', resolve);
            this.ws.on('error', reject);
        });
        this.ws.on('message', (raw) => {
            const msg = JSON.parse(raw);
            if (msg.id && this.pending.has(msg.id)) {
                this.pending.get(msg.id)(msg);
                this.pending.delete(msg.id);
            }
        });
    }
    send(method, params = {}) {
        return new Promise((resolve) => {
            const id = this.nextId++;
            this.pending.set(id, resolve);
            this.ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    resolve({ error: { message: 'timeout' } });
                }
            }, 20000);
        });
    }
    async evaluate(expression, opts = {}) {
        const result = await this.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: !!opts.awaitPromise,
        });
        if (result.error) throw new Error(`CDP error: ${JSON.stringify(result.error)}`);
        return result.result?.result;
    }
    close() { try { this.ws.close(); } catch { } }
}

// ── Observation Functions ──

/**
 * O1: Scan conversation messages and collect DOM structure info.
 * Focus on messages that contain function_results XML.
 */
const O1_SCAN_MESSAGES = `
(() => {
    const results = [];

    // Strategy 1: Look for message containers in Notion AI chat
    // Notion AI chat messages are typically rendered in a scrollable container
    
    // Find the chat content area
    const chatContent = document.querySelector('.notion-chat-content, [class*="chat"], [class*="conversation"]');
    
    // Collect all text blocks / message blocks
    const allBlocks = document.querySelectorAll('[data-block-id], [class*="message"], [class*="notion-ai"]');
    
    // Scan all significant text-containing elements
    const candidates = document.querySelectorAll('div, p, pre, code, span');
    let functionResultMessages = [];
    
    for (let i = 0; i < candidates.length && functionResultMessages.length < ${MAX_MESSAGES_TO_SCAN}; i++) {
        const el = candidates[i];
        const text = el.textContent || '';
        
        // Check if this element contains function_results XML
        if (text.includes('<function_results>') || text.includes('function_results')) {
            // Avoid duplicates (parent contains child)
            const isDuplicate = functionResultMessages.some(m => m.element.contains(el) || el.contains(m.element));
            if (isDuplicate) continue;
            
            functionResultMessages.push({
                element: el,
                info: {
                    tag: el.tagName.toLowerCase(),
                    className: el.className ? el.className.substring(0, 200) : '',
                    id: el.id || '',
                    textLength: text.length,
                    textPreview: text.substring(0, 300),
                    parentTag: el.parentElement?.tagName?.toLowerCase() || null,
                    parentClass: el.parentElement?.className ? el.parentElement.className.substring(0, 200) : '',
                    rect: el.getBoundingClientRect(),
                    childCount: el.children.length,
                    hasDataBlockId: !!el.closest('[data-block-id]'),
                    dataBlockId: el.closest('[data-block-id]')?.getAttribute('data-block-id') || null,
                    // Check nesting depth
                    depth: (() => {
                        let d = 0;
                        let p = el;
                        while (p.parentElement) { d++; p = p.parentElement; }
                        return d;
                    })(),
                    // Check computed styles
                    display: getComputedStyle(el).display,
                    overflow: getComputedStyle(el).overflow,
                    whiteSpace: getComputedStyle(el).whiteSpace,
                }
            });
        }
    }
    
    // Also check for existing v1 tool result cards
    const v1Cards = document.querySelectorAll('[data-mcp-tool-result-card="true"]');
    
    // Check for result_nonce and instruction tags
    const nonceElements = [];
    for (const el of candidates) {
        const text = el.textContent || '';
        if (text.includes('result_nonce') || text.includes('mcp_ack')) {
            nonceElements.push({
                tag: el.tagName.toLowerCase(),
                className: el.className ? el.className.substring(0, 100) : '',
                textPreview: text.substring(0, 200),
            });
            if (nonceElements.length >= 5) break;
        }
    }
    
    return {
        timestamp: Date.now(),
        observation: 'O1_message_dom_structure',
        chatContentFound: !!chatContent,
        chatContentSelector: chatContent ? chatContent.tagName + '.' + (chatContent.className || '').split(' ')[0] : null,
        totalBlocksFound: allBlocks.length,
        functionResultMessageCount: functionResultMessages.length,
        functionResultMessages: functionResultMessages.map(m => m.info),
        v1CardCount: v1Cards.length,
        v1CardCallIds: Array.from(v1Cards).map(c => c.getAttribute('data-mcp-call-id')),
        nonceElements: nonceElements,
        pageUrl: window.location.href,
        title: document.title,
    };
})()
`;

/**
 * O2: Observe the overall conversation structure.
 * Find the conversation container, message boundaries, user vs AI messages.
 */
const O2_CONVERSATION_STRUCTURE = `
(() => {
    // Notion AI conversation typically has a specific structure
    // Let's find it by looking for the scroll container
    
    const appInner = document.querySelector('.notion-app-inner');
    if (!appInner) return { error: 'notion-app-inner not found' };
    
    // Find scroll containers
    const scrollContainers = [];
    const allDivs = appInner.querySelectorAll('div');
    for (const div of allDivs) {
        const style = getComputedStyle(div);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
            const rect = div.getBoundingClientRect();
            if (rect.width > 400 && rect.height > 200) {
                scrollContainers.push({
                    tag: div.tagName,
                    className: (div.className || '').substring(0, 150),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                    childCount: div.children.length,
                    scrollHeight: div.scrollHeight,
                    scrollTop: div.scrollTop,
                });
            }
        }
        if (scrollContainers.length >= 5) break;
    }
    
    // Find input area
    const inputSelectors = [
        '[contenteditable="true"]',
        'textarea',
        '[role="textbox"]',
        '.notion-ai-input',
    ];
    const inputs = [];
    for (const sel of inputSelectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 200) {
                inputs.push({
                    selector: sel,
                    tag: el.tagName,
                    className: (el.className || '').substring(0, 100),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                    contentLength: (el.textContent || '').length,
                });
            }
        }
    }
    
    // Find message-like blocks by looking for alternating content patterns
    // In Notion AI chat, messages are typically in blocks with data-block-id
    const blocks = document.querySelectorAll('[data-block-id]');
    const blockInfo = Array.from(blocks).slice(-10).map(b => ({
        blockId: b.getAttribute('data-block-id'),
        tag: b.tagName,
        className: (b.className || '').substring(0, 100),
        textPreview: (b.textContent || '').substring(0, 100),
        rect: {
            width: Math.round(b.getBoundingClientRect().width),
            height: Math.round(b.getBoundingClientRect().height),
        },
    }));
    
    return {
        timestamp: Date.now(),
        observation: 'O2_conversation_structure',
        scrollContainers,
        inputs,
        recentBlocks: blockInfo,
        totalBlocks: blocks.length,
        v1Cards: document.querySelectorAll('[data-mcp-tool-result-card]').length,
        styleTagPresent: !!document.getElementById('mcp-tool-result-renderer-styles'),
    };
})()
`;

/**
 * O3: Set up a MutationObserver to watch for new messages.
 * Returns immediately; results collected via subsequent evaluation.
 */
const O3_SETUP_OBSERVER = `
(() => {
    // Clean up previous observer if exists
    if (window.__gate6Observer) {
        window.__gate6Observer.disconnect();
    }
    window.__gate6Mutations = [];
    
    const target = document.querySelector('.notion-app-inner') || document.body;
    
    window.__gate6Observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== 1) continue; // Element nodes only
                    const text = node.textContent || '';
                    
                    // Only record interesting additions
                    if (text.includes('function_results') || 
                        text.includes('result_nonce') ||
                        text.includes('mcp_ack') ||
                        text.includes('Tool:') ||
                        node.hasAttribute?.('data-mcp-tool-result-card') ||
                        node.hasAttribute?.('data-block-id')) {
                        
                        window.__gate6Mutations.push({
                            timestamp: Date.now(),
                            type: 'childList',
                            tag: node.tagName?.toLowerCase(),
                            className: (node.className || '').substring(0, 150),
                            textPreview: text.substring(0, 200),
                            hasFunctionResults: text.includes('function_results'),
                            hasNonce: text.includes('result_nonce'),
                            isMcpCard: !!node.getAttribute?.('data-mcp-tool-result-card'),
                            parentTag: mutation.target.tagName?.toLowerCase(),
                            parentClass: (mutation.target.className || '').substring(0, 100),
                        });
                    }
                }
            }
        }
        
        // Keep only last 50 entries
        if (window.__gate6Mutations.length > 50) {
            window.__gate6Mutations = window.__gate6Mutations.slice(-50);
        }
    });
    
    window.__gate6Observer.observe(target, {
        childList: true,
        subtree: true,
    });
    
    return { 
        status: 'observer_installed',
        target: target.tagName + '.' + (target.className || '').split(' ')[0],
        timestamp: Date.now(),
    };
})()
`;

const O3_COLLECT_MUTATIONS = `
(() => {
    const mutations = window.__gate6Mutations || [];
    return {
        observation: 'O3_mutations_collected',
        count: mutations.length,
        mutations: mutations,
        timestamp: Date.now(),
    };
})()
`;

// ── Main ──

async function main() {
    console.log(`\n${'='.repeat(60)}`);
    console.log('Gate 6 Observation: Tool Result Message DOM Structure');
    console.log(`${'='.repeat(60)}\n`);

    // Preflight
    let preflightResult;
    try {
        preflightResult = await preflight();
        console.log(`✅ Preflight passed — Extension: ${preflightResult.extensionName}`);
        console.log(`   Tab: ${preflightResult.tab.url}`);
    } catch (e) {
        console.error('❌ Preflight failed:', e.message);
        process.exit(1);
    }

    // Connect to Notion tab
    const cdp = new CDP(preflightResult.tab.webSocketDebuggerUrl);
    await cdp.connect();
    console.log('✅ CDP connected to Notion tab\n');

    try {
        // ── O2: Conversation structure ──
        console.log('─── O2: Conversation Structure ───');
        const o2 = await cdp.evaluate(O2_CONVERSATION_STRUCTURE);
        console.log(JSON.stringify(o2.value, null, 2));
        console.log();

        // ── O1: Scan for existing function_result messages ──
        console.log('─── O1: Function Result Messages in DOM ───');
        const o1 = await cdp.evaluate(O1_SCAN_MESSAGES);
        console.log(JSON.stringify(o1.value, null, 2));
        console.log();

        // ── O3: Set up mutation observer ──
        console.log('─── O3: Setting up MutationObserver ───');
        const o3setup = await cdp.evaluate(O3_SETUP_OBSERVER);
        console.log(JSON.stringify(o3setup.value, null, 2));
        console.log();

        console.log(`⏳ Waiting ${OBSERVATION_WAIT_MS / 1000}s for mutations...`);
        console.log('   (Trigger a tool call in Notion AI chat now if you want live observation)');
        await sleep(OBSERVATION_WAIT_MS);

        // Collect mutations
        console.log('─── O3: Collected Mutations ───');
        const o3result = await cdp.evaluate(O3_COLLECT_MUTATIONS);
        console.log(JSON.stringify(o3result.value, null, 2));
        console.log();

        // ── Final scan after wait ──
        console.log('─── O1 (post-wait): Re-scan for function_result messages ───');
        const o1post = await cdp.evaluate(O1_SCAN_MESSAGES);
        console.log(JSON.stringify(o1post.value, null, 2));

        // ── Summary ──
        console.log(`\n${'='.repeat(60)}`);
        console.log('Observation Summary');
        console.log(`${'='.repeat(60)}`);
        console.log(`Chat content found: ${o2.value?.scrollContainers?.length > 0 ? 'YES' : 'NO'}`);
        console.log(`Scroll containers: ${o2.value?.scrollContainers?.length || 0}`);
        console.log(`Input areas: ${o2.value?.inputs?.length || 0}`);
        console.log(`function_result messages (initial): ${o1.value?.functionResultMessageCount || 0}`);
        console.log(`function_result messages (post-wait): ${o1post.value?.functionResultMessageCount || 0}`);
        console.log(`v1 cards: ${o1.value?.v1CardCount || 0}`);
        console.log(`Mutations observed: ${o3result.value?.count || 0}`);
        console.log(`Style tag present: ${o2.value?.styleTagPresent ? 'YES' : 'NO'}`);

    } finally {
        // Cleanup observer
        try {
            await cdp.evaluate('if (window.__gate6Observer) { window.__gate6Observer.disconnect(); delete window.__gate6Observer; delete window.__gate6Mutations; }');
        } catch { }
        cdp.close();
    }

    console.log('\n✅ Observation complete');
    process.exit(0);
}

main().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
});
