/**
 * Gate 6 — Lane A Regression Probe: Batch Function Result Rendering
 *
 * Validates that the updated functionResult.ts + functionResultParser.ts correctly:
 *   1. Renders a 2-result merged payload as a batch card
 *   2. Both result call_ids are visible
 *   3. Content areas are non-empty
 *   4. Raw XML is not visually exposed
 *   5. Extension renders the card (not raw XML)
 *
 * Prerequisites:
 *   - Chrome with --remote-debugging-port=9222
 *   - ChatGPT conversation open (scratch tab)
 *   - MCP-SuperAssistant extension loaded (with latest build containing Gate 6 fix)
 *
 * Usage:
 *   node scripts/e2e-gate6-regression-probe.cjs          # A0 only (draft, safe)
 *   node scripts/e2e-gate6-regression-probe.cjs --submit  # A0 + A1 (submits message)
 *
 * Output: Structured JSON evidence to stdout + human-readable summary.
 */

const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const CDP_PORT = process.env.CDP_PORT || 9222;
const RUN_SUBMIT = process.argv.includes('--submit');

// ─── CDP helpers ────────────────────────────────────────────────────────────

function getTargets() {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${CDP_PORT}/json`, res => {
            let d = '';
            res.on('data', c => (d += c));
            res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
    });
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
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

// ─── Synthetic payload (matches mergeResults + formatFunctionResult format) ─

function buildSyntheticPayload() {
    const block1 = `<function_results>
  <result call_id="regr_g6_001" name="read_file" status="success">
    <content type="application/json"><![CDATA[
{"file":"test.txt","content":"Hello World from Gate 6 regression probe"}
    ]]></content>
  </result>
</function_results>`;

    const block2 = `<function_results>
  <result call_id="regr_g6_002" name="list_dir" status="success">
    <content type="application/json"><![CDATA[
{"entries":["src/","tests/","package.json","tsconfig.json"]}
    ]]></content>
  </result>
</function_results>`;

    const merged = `Tool execution results (2 calls):\n\n${block1}\n\n${block2}`;
    return {
        text: merged,
        payloadKind: 'merged-2-json-regression',
        sha256: crypto.createHash('sha256').update(merged).digest('hex').substring(0, 16),
        markerCallIds: ['regr_g6_001', 'regr_g6_002'],
    };
}

// ─── Probe expressions ─────────────────────────────────────────────────────

function makeInsertExpression(text) {
    const escaped = text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    return `(function() {
      const input = document.querySelector('#prompt-textarea');
      if (!input) return JSON.stringify({ error: 'input not found' });
      input.focus();
      input.innerHTML = '';
      const p = document.createElement('p');
      p.textContent = \`${escaped}\`;
      input.appendChild(p);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const form = input.closest('form');
      const submitBtn = form ? (
        form.querySelector('button[data-testid="send-button"]') ||
        form.querySelector('button[data-testid="composer-speech-button"]')
      ) : null;
      return JSON.stringify({
        ok: true,
        composerTextLength: input.textContent.length,
        submitButtonTestId: submitBtn ? submitBtn.getAttribute('data-testid') : null,
      });
    })()`;
}

const CLEAR_INPUT = `(function() {
    const input = document.querySelector('#prompt-textarea');
    if (!input) return JSON.stringify({ error: 'input not found' });
    input.focus();
    input.innerHTML = '<p><br></p>';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return JSON.stringify({ ok: true });
})()`;

const COUNT_USER_MESSAGES = `(function() {
    const msgs = document.querySelectorAll('[data-message-author-role="user"]');
    return JSON.stringify({ count: msgs.length });
})()`;

const CLICK_SUBMIT = `(function() {
    const form = document.querySelector('#prompt-textarea')?.closest('form');
    if (!form) return JSON.stringify({ error: 'form not found' });
    const btn = form.querySelector('button[data-testid="send-button"]');
    if (!btn) return JSON.stringify({ error: 'send-button not found' });
    if (btn.disabled) return JSON.stringify({ error: 'send-button disabled' });
    btn.click();
    return JSON.stringify({ ok: true, clicked: true });
})()`;

// Gate 6 regression-specific: check for batch card rendering
function makeRegressionSnapshotExpression(markerCallIds) {
    const markers = JSON.stringify(markerCallIds);
    return `(function() {
      const userMsgs = document.querySelectorAll('[data-message-author-role="user"]');
      const results = [];
      
      for (let i = 0; i < userMsgs.length; i++) {
        const msg = userMsgs[i];
        const text = msg.textContent || '';
        const markerIds = ${markers};
        
        // Check if any marker call_id appears in text OR in data attributes
        const hasMarkerInText = markerIds.some(m => text.includes(m));
        const hasMarkerInAttrs = msg.innerHTML.includes(markerIds[0]);
        
        if (hasMarkerInText || hasMarkerInAttrs) {
          // Check for batch container (Gate 6 fix: multiple results in one container)
          const batchContainer = msg.querySelector('.function-result-batch-container');
          const singleContainer = msg.querySelector('.function-result-container');
          
          // Count result containers (sub-cards)
          const allResultContainers = msg.querySelectorAll('.function-result-container');
          const subCards = msg.querySelectorAll('.function-result-sub');
          
          // Check for batch header
          const batchHeader = msg.querySelector('.batch-header');
          
          // Check call_ids visibility
          const callIdElements = msg.querySelectorAll('.call-id');
          const visibleCallIds = Array.from(callIdElements).map(el => el.textContent);
          
          // Check content areas
          const contentAreas = msg.querySelectorAll('.function-result-content');
          const contentStates = Array.from(contentAreas).map(area => ({
            hasChildren: area.children.length > 0,
            textLength: area.textContent.length,
            isEmpty: area.textContent.trim() === '',
          }));
          
          // Check expand buttons
          const expandButtons = msg.querySelectorAll('.expand-button');
          
          // Check for raw XML exposure
          const rawXmlVisible = text.includes('<function_results>') || text.includes('<![CDATA[');
          
          // Check theme class
          const themed = msg.querySelector('.theme-dark') || msg.querySelector('.theme-light');
          
          // Check function-name-text content
          const nameTexts = msg.querySelectorAll('.function-name-text');
          const headerTexts = Array.from(nameTexts).map(n => n.textContent);
          
          results.push({
            msgIndex: i,
            textLength: text.length,
            // Batch rendering checks (Gate 6 fix)
            hasBatchContainer: !!batchContainer,
            hasSingleContainer: !!singleContainer,
            totalResultContainers: allResultContainers.length,
            subCardCount: subCards.length,
            hasBatchHeader: !!batchHeader,
            batchHeaderText: batchHeader ? batchHeader.textContent : null,
            // Call ID visibility
            visibleCallIds: visibleCallIds,
            hasAllCallIds: markerIds.every(m => visibleCallIds.some(v => v.includes(m))),
            // Content area checks
            contentAreaCount: contentAreas.length,
            contentStates: contentStates,
            allContentNonEmpty: contentStates.every(s => !s.isEmpty),
            // Expand/collapse
            expandButtonCount: expandButtons.length,
            // Raw XML check
            rawXmlVisible: rawXmlVisible,
            // Theme
            hasThemeClass: !!themed,
            // Headers
            headerTexts: headerTexts,
          });
        }
      }
      
      return JSON.stringify({
        totalUserMessages: userMsgs.length,
        matchingMessages: results,
      });
    })()`;
}

// React stability check: verify card is still rendered after a delay
function makeStabilityCheckExpression(markerCallIds) {
    return `(function() {
      const msg = document.querySelector('[data-message-author-role="user"]');
      if (!msg) return JSON.stringify({ error: 'no user message' });
      const batch = msg.querySelector('.function-result-batch-container') || msg.querySelector('.function-result-container');
      return JSON.stringify({
        cardStillPresent: !!batch,
        containerClass: batch ? batch.className.substring(0, 60) : null,
      });
    })()`;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
    const payload = buildSyntheticPayload();
    console.log(`🔍 Gate 6 — Lane A Regression Probe (Batch Function Result Rendering)`);
    console.log(`   Mode: ${RUN_SUBMIT ? 'A0 + A1 (with submit)' : 'A0 only (draft, safe)'}`);
    console.log(`   Payload: ${payload.payloadKind}, ${payload.text.length} chars`);
    console.log();

    // 1. Connect
    console.log(`Connecting to CDP on port ${CDP_PORT}...`);
    const targets = await getTargets();
    const chatgptTab = targets.find(
        t => t.type === 'page' && t.url && t.url.includes('chatgpt.com'),
    );
    if (!chatgptTab) {
        console.error('❌ No ChatGPT tab found.');
        process.exit(1);
    }
    console.log(`✅ Found ChatGPT tab.`);

    const ws = new WebSocket(chatgptTab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    try {
        await cdpSend(ws, 'Runtime.enable');

        // ── A0: Draft-only ──────────────────────────────────────────
        console.log('\n📋 A0: Draft-only probe...');

        const baselineRes = await cdpSend(ws, 'Runtime.evaluate', {
            expression: COUNT_USER_MESSAGES, returnByValue: true,
        });
        const baseline = JSON.parse(baselineRes.result.value);
        console.log(`   Baseline user messages: ${baseline.count}`);

        const insertRes = await cdpSend(ws, 'Runtime.evaluate', {
            expression: makeInsertExpression(payload.text), returnByValue: true,
        });
        const insertResult = JSON.parse(insertRes.result.value);

        if (insertResult.error) {
            console.error(`❌ Insert failed: ${insertResult.error}`);
            process.exit(1);
        }

        await sleep(500);

        const a0Evidence = {
            composerHoldsPayload: insertResult.ok,
            composerTextLength: insertResult.composerTextLength,
            sendButtonAppeared: insertResult.submitButtonTestId === 'send-button',
        };

        console.log(`   ✅ A0: Composer text: ${a0Evidence.composerTextLength} chars, send button: ${a0Evidence.sendButtonAppeared}`);

        let a1Evidence = null;
        let verdict = 'A0_ONLY';

        if (RUN_SUBMIT) {
            // ── A1: Submit + observe ─────────────────────────────────
            console.log('\n📋 A1: Submit + observe batch rendering...');

            const submitRes = await cdpSend(ws, 'Runtime.evaluate', {
                expression: CLICK_SUBMIT, returnByValue: true,
            });
            const submitResult = JSON.parse(submitRes.result.value);

            if (submitResult.error) {
                console.error(`❌ Submit failed: ${submitResult.error}`);
                a1Evidence = { error: submitResult.error };
                verdict = 'SUBMIT_FAILED';
            } else {
                console.log('   Submit clicked. Polling for rendered card...');

                // Bounded polling: wait for extension to render the card
                const maxWait = 15000;
                const pollInterval = 500;
                const startTime = Date.now();
                let snapshot = null;

                while (Date.now() - startTime < maxWait) {
                    await sleep(pollInterval);
                    const snapRes = await cdpSend(ws, 'Runtime.evaluate', {
                        expression: makeRegressionSnapshotExpression(payload.markerCallIds),
                        returnByValue: true,
                    });
                    const snap = JSON.parse(snapRes.result.value);

                    if (snap.matchingMessages && snap.matchingMessages.length > 0) {
                        snapshot = snap;
                        const m = snap.matchingMessages[0];
                        // Wait until rendering is done (look for batch or single container)
                        if (m.hasBatchContainer || m.hasSingleContainer) {
                            console.log(`   Card rendered after ${Date.now() - startTime}ms`);
                            break;
                        }
                    }
                }

                if (!snapshot || snapshot.matchingMessages.length === 0) {
                    console.error('❌ User message not found after submission');
                    a1Evidence = { error: 'message_not_found' };
                    verdict = 'MESSAGE_NOT_FOUND';
                } else {
                    const m = snapshot.matchingMessages[0];

                    // React stability check: wait 2s and verify card persists
                    await sleep(2000);
                    const stabilityRes = await cdpSend(ws, 'Runtime.evaluate', {
                        expression: makeStabilityCheckExpression(payload.markerCallIds),
                        returnByValue: true,
                    });
                    const stability = JSON.parse(stabilityRes.result.value);

                    a1Evidence = {
                        renderTime: Date.now() - startTime,
                        snapshot: m,
                        reactStability: stability,
                    };

                    // Determine verdict
                    const checks = {
                        batchOrSingleContainer: m.hasBatchContainer || m.hasSingleContainer,
                        multipleResultsRendered: m.totalResultContainers >= 2 || m.subCardCount >= 2,
                        bothCallIdsVisible: m.hasAllCallIds,
                        contentNonEmpty: m.allContentNonEmpty,
                        noRawXml: !m.rawXmlVisible,
                        expandButtonsPresent: m.expandButtonCount >= 2,
                        reactStable: stability.cardStillPresent,
                    };

                    const allPass = Object.values(checks).every(v => v);
                    verdict = allPass ? 'PASS' : 'PARTIAL';

                    console.log('\n   === Regression Check Results ===');
                    for (const [k, v] of Object.entries(checks)) {
                        console.log(`   ${v ? '✅' : '❌'} ${k}: ${v}`);
                    }
                    console.log(`\n   Batch header: ${m.batchHeaderText || 'none'}`);
                    console.log(`   Sub-cards: ${m.subCardCount}`);
                    console.log(`   Call IDs: ${JSON.stringify(m.visibleCallIds)}`);
                    console.log(`   Content areas: ${m.contentAreaCount} (all non-empty: ${m.allContentNonEmpty})`);
                    console.log(`   Header texts: ${JSON.stringify(m.headerTexts)}`);
                    console.log(`   React stable after 2s: ${stability.cardStillPresent}`);
                }
            }
        } else {
            // Clear input after A0
            await cdpSend(ws, 'Runtime.evaluate', {
                expression: CLEAR_INPUT, returnByValue: true,
            });
        }

        // ── Final evidence output ───────────────────────────────────
        const evidence = {
            probe: 'gate6-regression-batch-rendering',
            provider: 'chatgpt',
            lane: 'A',
            timestamp: new Date().toISOString(),
            payloadKind: payload.payloadKind,
            payloadSha256: payload.sha256,
            payloadChars: payload.text.length,
            a0: a0Evidence,
            a1: a1Evidence,
            verdict,
        };

        console.log(`\n\n🏁 Verdict: ${verdict}`);
        console.log('\n=== Structured Evidence (JSON) ===');
        console.log(JSON.stringify(evidence, null, 2));

    } finally {
        ws.close();
    }
}

main().catch(err => {
    console.error('❌ Fatal:', err.message);
    process.exit(1);
});
