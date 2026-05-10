/**
 * E2E test: ToolResultRenderer initialization, rendering, and interaction on Notion.
 *
 * Covers:
 * 1. Extension reload (ensures latest build is loaded)
 * 2. Page reload
 * 3. ToolResultRenderer styles injected into DOM
 * 4. Event listener responds to mcp:tool-execution-complete
 * 5. Card element created with correct structure and text
 * 6. Card title shows tool name in "Tool: xxx" format
 * 7. Card status badge shows correct emoji
 * 8. Card width constrained (≤820px, not full viewport width)
 * 9. Card toggle (expand/collapse) works with correct content
 * 10. Event alias support (toolName instead of functionName)
 * 11. Card idempotency (same callId doesn't create duplicate)
 *
 * Prerequisites:
 * - Comet/Chrome with --remote-debugging-port=9222
 * - A Notion tab open (any page)
 * - Extension built: npx turbo build
 *
 * Run: node scripts/e2e-tool-result-renderer.cjs
 */

const WebSocket = require('ws');

// ── Config ──

const CDP_PORT = 9222;
const CDP_URL = `http://localhost:${CDP_PORT}`;
const EXT_ID = 'hkjclekhnaffnhldgpmjnohihjmblbpj';
const PAGE_LOAD_WAIT_S = 15;
const STYLE_TAG_ID = 'mcp-tool-result-renderer-styles';

// ── Helpers ──

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
            }, 15000);
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

async function getTargets() {
    const resp = await fetch(`${CDP_URL}/json/list`);
    return resp.json();
}

function assert(condition, message) {
    if (!condition) {
        console.error(`  ✗ FAIL: ${message}`);
        process.exitCode = 1;
        return false;
    }
    console.log(`  ✓ PASS: ${message}`);
    return true;
}

// ── Main ──

async function main() {
    let passed = 0;
    let failed = 0;

    function check(condition, message) {
        if (assert(condition, message)) passed++;
        else failed++;
    }

    console.log('=== E2E: ToolResultRenderer on Notion ===\n');

    // ─── Step 1: Reload Extension ───
    console.log('Step 1: Reload extension via service worker...');
    const targets = await getTargets();
    const sw = targets.find(t =>
        t.url && t.url.includes(EXT_ID) && t.type === 'service_worker'
    );

    if (!sw) {
        console.error('  Extension service worker not found!');
        console.error('  Available targets with extension ID:');
        for (const t of targets) {
            if (t.url && t.url.includes(EXT_ID)) {
                console.error(`    type=${t.type} url=${t.url.substring(0, 80)}`);
            }
        }
        process.exit(1);
    }

    const swCdp = new CDP(sw.webSocketDebuggerUrl);
    await swCdp.connect();
    await swCdp.send('Runtime.enable');
    await swCdp.evaluate('chrome.runtime.reload()');
    swCdp.close();
    console.log('  Extension reload triggered');
    await sleep(4000);

    // ─── Step 2: Find and reload Notion tab ───
    console.log('\nStep 2: Find and reload Notion tab...');
    const updatedTargets = await getTargets();
    const notionTab = updatedTargets.find(t =>
        t.type === 'page' && t.url && t.url.includes('notion.so')
    );

    if (!notionTab) {
        console.error('  No Notion tab found!');
        process.exit(1);
    }
    console.log(`  Found: ${notionTab.url.substring(0, 60)}...`);

    const cdp = new CDP(notionTab.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    // Reload page
    await cdp.send('Page.reload');
    console.log(`  Page reloading, waiting ${PAGE_LOAD_WAIT_S}s...`);
    await sleep(PAGE_LOAD_WAIT_S * 1000);

    // ─── Step 3: Verify ToolResultRenderer styles ───
    console.log('\nStep 3: Verify ToolResultRenderer styles...');

    const stylesPresent = await cdp.evaluate(
        `!!document.getElementById('${STYLE_TAG_ID}')`
    );
    check(stylesPresent?.value === true, `Style tag #${STYLE_TAG_ID} exists in DOM`);

    const styleContent = await cdp.evaluate(
        `document.getElementById('${STYLE_TAG_ID}')?.textContent?.includes('.mcp-tool-result-card')`
    );
    check(styleContent?.value === true, 'Style tag contains .mcp-tool-result-card rules');

    // ─── Step 4: Verify no pre-existing cards ───
    console.log('\nStep 4: Verify clean state (no pre-existing cards)...');
    const preExisting = await cdp.evaluate(
        `document.querySelectorAll('.mcp-tool-result-card').length`
    );
    check(preExisting?.value === 0, 'No pre-existing tool result cards');

    // ─── Step 5: Fire test event ───
    console.log('\nStep 5: Fire mcp:tool-execution-complete event...');
    const testToolName = 'e2e_test_tool';
    const testCallId = `e2e-${Date.now()}`;
    const testResultText = 'Search results:\\n1. Result A\\n2. Result B';

    await cdp.evaluate(`
        document.dispatchEvent(new CustomEvent('mcp:tool-execution-complete', {
            detail: {
                functionName: '${testToolName}',
                callId: '${testCallId}',
                result: '${testResultText}',
                timestamp: Date.now(),
            },
            bubbles: true,
        }));
    `);
    console.log('  Event dispatched');
    await sleep(2000);

    // ─── Step 6: Verify card creation + structure + text ───
    console.log('\nStep 6: Verify card creation, structure, and content...');

    const cardState = await cdp.evaluate(`
        (function() {
            var cards = document.querySelectorAll('.mcp-tool-result-card');
            if (cards.length === 0) return JSON.stringify({ found: false });
            var card = cards[cards.length - 1];
            var rect = card.getBoundingClientRect();
            var title = card.querySelector('.mcp-tool-result-title');
            var status = card.querySelector('.mcp-tool-result-status');
            var chevron = card.querySelector('.mcp-tool-result-chevron');
            return JSON.stringify({
                found: true,
                count: cards.length,
                inBody: document.body.contains(card),
                visible: rect.width > 0 && rect.height > 0,
                display: getComputedStyle(card).display,
                cardWidth: Math.round(rect.width),
                viewportWidth: window.innerWidth,
                hasHeader: !!card.querySelector('.mcp-tool-result-header'),
                hasPreview: !!card.querySelector('.mcp-tool-result-preview'),
                hasChevron: !!chevron,
                titleText: title ? title.textContent : null,
                statusText: status ? status.textContent : null,
                chevronText: chevron ? chevron.textContent : null,
                eventType: card.getAttribute('data-mcp-event-type'),
                callIdAttr: card.getAttribute('data-mcp-call-id'),
            });
        })()
    `);

    const state = JSON.parse(cardState?.value || '{}');

    check(state.found === true, 'Tool result card created');
    check(state.inBody === true, 'Card is attached to document.body');
    check(state.visible === true, 'Card has non-zero dimensions (visible)');
    check(state.hasHeader === true, 'Card has .mcp-tool-result-header');
    check(state.hasPreview === true, 'Card has .mcp-tool-result-preview');
    check(state.hasChevron === true, 'Card has .mcp-tool-result-chevron');
    check(state.eventType === 'tool_execution_completed', 'Card data-mcp-event-type is correct');
    check(state.callIdAttr === testCallId, 'Card data-mcp-call-id matches dispatched callId');

    // ── Text content verification ──
    check(
        state.titleText === `Tool: ${testToolName}`,
        `Card title shows "Tool: ${testToolName}" (got: "${state.titleText}")`
    );
    check(
        state.statusText === '✅',
        `Card status shows ✅ for success (got: "${state.statusText}")`
    );

    // ── Width constraint ──
    check(
        state.cardWidth <= 820,
        `Card width ≤ 820px (got: ${state.cardWidth}px)`
    );
    check(
        state.cardWidth < state.viewportWidth,
        `Card width (${state.cardWidth}px) < viewport width (${state.viewportWidth}px) — not full-width`
    );

    // ─── Step 7: Verify toggle ───
    console.log('\nStep 7: Verify card toggle (expand/collapse)...');

    // Initially collapsed
    const initialState = await cdp.evaluate(`
        (function() {
            var card = document.querySelector('.mcp-tool-result-card');
            var chevron = card.querySelector('.mcp-tool-result-chevron');
            var preview = card.querySelector('.mcp-tool-result-preview');
            return JSON.stringify({
                chevronExpanded: chevron.getAttribute('data-expanded'),
                previewVisible: preview.getAttribute('data-visible'),
            });
        })()
    `);
    const init = JSON.parse(initialState?.value || '{}');
    check(init.chevronExpanded === 'false', 'Initially collapsed: chevron data-expanded=false');
    check(init.previewVisible === 'false', 'Initially collapsed: preview data-visible=false');

    // Click to expand
    await cdp.evaluate(`document.querySelector('.mcp-tool-result-header').click()`);
    await sleep(500);

    const expandedState = await cdp.evaluate(`
        (function() {
            var card = document.querySelector('.mcp-tool-result-card');
            var chevron = card.querySelector('.mcp-tool-result-chevron');
            var preview = card.querySelector('.mcp-tool-result-preview');
            return JSON.stringify({
                chevronExpanded: chevron.getAttribute('data-expanded'),
                previewVisible: preview.getAttribute('data-visible'),
                previewDisplay: getComputedStyle(preview).display,
                previewContent: preview.textContent.substring(0, 200),
            });
        })()
    `);
    const expanded = JSON.parse(expandedState?.value || '{}');
    check(expanded.chevronExpanded === 'true', 'After click: chevron data-expanded=true');
    check(expanded.previewVisible === 'true', 'After click: preview data-visible=true');
    check(expanded.previewDisplay === 'block', 'After click: preview display=block');
    check(
        expanded.previewContent && expanded.previewContent.includes('Result A'),
        'Expanded preview contains expected result text'
    );

    // Click to collapse
    await cdp.evaluate(`document.querySelector('.mcp-tool-result-header').click()`);
    await sleep(500);

    const collapsedState = await cdp.evaluate(`
        (function() {
            var chevron = document.querySelector('.mcp-tool-result-chevron');
            var preview = document.querySelector('.mcp-tool-result-preview');
            return JSON.stringify({
                chevronExpanded: chevron.getAttribute('data-expanded'),
                previewVisible: preview.getAttribute('data-visible'),
            });
        })()
    `);
    const collapsed = JSON.parse(collapsedState?.value || '{}');
    check(collapsed.chevronExpanded === 'false', 'After second click: collapsed again');
    check(collapsed.previewVisible === 'false', 'After second click: preview hidden again');

    // ─── Step 8: Event alias test (toolName instead of functionName) ───
    console.log('\nStep 8: Verify event alias (toolName instead of functionName)...');
    const aliasCallId = `e2e-alias-${Date.now()}`;
    const aliasToolName = 'aliased_web_search';

    await cdp.evaluate(`
        document.dispatchEvent(new CustomEvent('mcp:tool-execution-complete', {
            detail: {
                toolName: '${aliasToolName}',
                toolCallId: '${aliasCallId}',
                result: 'alias test result',
                timestamp: Date.now(),
            },
            bubbles: true,
        }));
    `);
    await sleep(1000);

    const aliasState = await cdp.evaluate(`
        (function() {
            var card = document.querySelector('[data-mcp-call-id="${aliasCallId}"]');
            if (!card) return JSON.stringify({ found: false });
            var title = card.querySelector('.mcp-tool-result-title');
            return JSON.stringify({
                found: true,
                titleText: title ? title.textContent : null,
            });
        })()
    `.replace('${aliasCallId}', aliasCallId));

    const alias = JSON.parse(aliasState?.value || '{}');
    check(alias.found === true, 'Alias event created a card');
    check(
        alias.titleText === `Tool: ${aliasToolName}`,
        `Alias card title shows "Tool: ${aliasToolName}" (got: "${alias.titleText}")`
    );

    // ─── Step 9: Idempotency test (same callId doesn't create duplicate) ───
    console.log('\nStep 9: Verify idempotency (same callId = no duplicate)...');
    const beforeCount = await cdp.evaluate(
        `document.querySelectorAll('.mcp-tool-result-card').length`
    );

    await cdp.evaluate(`
        document.dispatchEvent(new CustomEvent('mcp:tool-execution-complete', {
            detail: {
                functionName: '${testToolName}',
                callId: '${testCallId}',
                result: 'duplicate attempt',
                timestamp: Date.now(),
            },
            bubbles: true,
        }));
    `);
    await sleep(1000);

    const afterCount = await cdp.evaluate(
        `document.querySelectorAll('.mcp-tool-result-card').length`
    );
    check(
        afterCount?.value === beforeCount?.value,
        `Duplicate callId did not create new card (before: ${beforeCount?.value}, after: ${afterCount?.value})`
    );

    // ─── Step 10: Error status card ───
    console.log('\nStep 10: Verify error card (no result)...');
    const errorCallId = `e2e-error-${Date.now()}`;

    await cdp.evaluate(`
        document.dispatchEvent(new CustomEvent('mcp:tool-execution-complete', {
            detail: {
                functionName: 'failing_tool',
                callId: '${errorCallId}',
                timestamp: Date.now(),
            },
            bubbles: true,
        }));
    `);
    await sleep(1000);

    const errorState = await cdp.evaluate(`
        (function() {
            var card = document.querySelector('[data-mcp-call-id="${errorCallId}"]');
            if (!card) return JSON.stringify({ found: false });
            var status = card.querySelector('.mcp-tool-result-status');
            var title = card.querySelector('.mcp-tool-result-title');
            return JSON.stringify({
                found: true,
                statusText: status ? status.textContent : null,
                titleText: title ? title.textContent : null,
            });
        })()
    `.replace('${errorCallId}', errorCallId));

    const errState = JSON.parse(errorState?.value || '{}');
    check(errState.found === true, 'Error card created');
    check(errState.statusText === '❌', `Error card shows ❌ (got: "${errState.statusText}")`);
    check(
        errState.titleText === 'Tool: failing_tool',
        `Error card title shows "Tool: failing_tool" (got: "${errState.titleText}")`
    );

    // ─── Step 11: Cleanup ───
    console.log('\nStep 11: Cleanup test cards...');
    await cdp.evaluate(`
        document.querySelectorAll('.mcp-tool-result-card').forEach(c => c.remove());
    `);
    const afterCleanup = await cdp.evaluate(
        `document.querySelectorAll('.mcp-tool-result-card').length`
    );
    check(afterCleanup?.value === 0, 'Test cards removed');

    // ─── Summary ───
    console.log(`\n${'='.repeat(40)}`);
    console.log(`  Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`);
    console.log(`${'='.repeat(40)}`);

    if (failed > 0) {
        console.log('\n  Some tests FAILED. See details above.');
    } else {
        console.log('\n  All tests PASSED! ToolResultRenderer works correctly on Notion.');
    }

    cdp.close();
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
    console.error('Fatal:', e.message);
    process.exit(1);
});
