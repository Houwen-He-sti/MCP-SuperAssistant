/**
 * Gate 6 — ChatGPT Lane A Observation Probe
 *
 * Two-phase probe for observing user message DOM after function_result submission:
 *
 * A0 (draft-only): Insert synthetic payload into composer, verify it holds, do NOT submit.
 * A1 (submitted):  Insert + submit, bounded-polling until user message appears, snapshot DOM.
 *
 * Usage:
 *   # Chrome with --remote-debugging-port=9222, ChatGPT scratch conversation open
 *   node scripts/e2e-gate6-chatgpt-observation.cjs          # runs A0 only (safe)
 *   node scripts/e2e-gate6-chatgpt-observation.cjs --submit  # runs A0 + A1
 *
 * Output: Structured JSON evidence to stdout + human-readable summary.
 * Sanitized: no conversation text, no tokens, no account info.
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
    // Two function_results blocks with CDATA containing code
    const block1 = `<function_results>
  <result call_id="probe_g6_001" name="read_file" status="success">
    <content type="application/json"><![CDATA[
def hello():
    print("world")

class Example:
    def __init__(self):
        self.value = 42
    ]]></content>
  </result>
</function_results>`;

    const block2 = `<function_results>
  <result call_id="probe_g6_002" name="list_dir" status="success">
    <content type="application/json"><![CDATA[
["src/", "tests/", "package.json", "tsconfig.json"]
    ]]></content>
  </result>
</function_results>`;

    const merged = `Tool execution results (2 calls):\n\n${block1}\n\n${block2}`;
    return {
        text: merged,
        payloadKind: 'merged-2-cdata-code',
        sha256: crypto.createHash('sha256').update(merged).digest('hex').substring(0, 16),
        markerCallIds: ['probe_g6_001', 'probe_g6_002'],
    };
}

// ─── Probe expressions ─────────────────────────────────────────────────────

// Insert payload into ChatGPT composer (mimics chatgpt.adapter.ts insertText)
function makeInsertExpression(text) {
    // Escape for embedding in JS string
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
      
      // Check what composer state looks like after insert
      const form = input.closest('form');
      const submitBtn = form ? (
        form.querySelector('button[data-testid="send-button"]') ||
        form.querySelector('button[data-testid="composer-speech-button"]')
      ) : null;
      
      return JSON.stringify({
        ok: true,
        composerTextLength: input.textContent.length,
        composerInnerHTMLLength: input.innerHTML.length,
        submitButtonTestId: submitBtn ? submitBtn.getAttribute('data-testid') : null,
        submitButtonDisabled: submitBtn ? submitBtn.disabled : null,
        submitButtonVisible: submitBtn ? submitBtn.getBoundingClientRect().width > 0 : null,
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

// Click submit button
const CLICK_SUBMIT = `(function() {
    const form = document.querySelector('#prompt-textarea')?.closest('form');
    if (!form) return JSON.stringify({ error: 'form not found' });
    const btn = form.querySelector('button[data-testid="send-button"]');
    if (!btn) return JSON.stringify({ error: 'send-button not found' });
    if (btn.disabled) return JSON.stringify({ error: 'send-button disabled' });
    btn.click();
    return JSON.stringify({ ok: true, clicked: true });
})()`;

// Snapshot new user message DOM (the one containing our payload marker)
function makeSnapshotExpression(markerCallIds) {
    const markers = JSON.stringify(markerCallIds);
    return `(function() {
      const userMsgs = document.querySelectorAll('[data-message-author-role="user"]');
      const results = [];
      
      for (let i = 0; i < userMsgs.length; i++) {
        const msg = userMsgs[i];
        const text = msg.textContent || '';
        const markers = ${markers};
        const hasMarker = markers.some(m => text.includes(m));
        
        if (hasMarker) {
          // Collect DOM structure info
          const children = Array.from(msg.children).map(c => ({
            tag: c.tagName,
            className: (c.className || '').substring(0, 60),
            childCount: c.children.length,
          }));
          
          // Check if function_results XML is preserved
          const hasFunctionResults = text.includes('<function_results>');
          const hasCDATA = text.includes('CDATA');
          const hasCallId1 = text.includes(markers[0]);
          const hasCallId2 = markers.length > 1 ? text.includes(markers[1]) : true;
          
          // Count code/pre elements inside
          const preCount = msg.querySelectorAll('pre').length;
          const codeCount = msg.querySelectorAll('code').length;
          
          results.push({
            msgIndex: i,
            rootTag: msg.tagName,
            rootTestId: msg.getAttribute('data-testid'),
            rootMessageId: msg.getAttribute('data-message-id') ? msg.getAttribute('data-message-id').substring(0, 8) : null,
            textLength: text.length,
            hasFunctionResults,
            hasCDATA,
            hasAllCallIds: hasCallId1 && hasCallId2,
            preCount,
            codeCount,
            childStructure: children.slice(0, 10),
            // Mount candidates: does the user message have a clear wrapper we can target?
            hasDataMessageId: !!msg.getAttribute('data-message-id'),
          });
        }
      }
      
      return JSON.stringify({
        totalUserMessages: userMsgs.length,
        matchingMessages: results,
      });
    })()`;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
    const payload = buildSyntheticPayload();
    console.log(`🔍 Gate 6 — ChatGPT Lane A Observation Probe`);
    console.log(`   Mode: ${RUN_SUBMIT ? 'A0 + A1 (with submit)' : 'A0 only (draft, no submit)'}`);
    console.log(`   Payload: ${payload.payloadKind}, ${payload.text.length} chars, sha256: ${payload.sha256}`);
    console.log();

    // 1. Find ChatGPT tab
    console.log(`Connecting to CDP on port ${CDP_PORT}...`);
    const targets = await getTargets();
    const chatgptTab = targets.find(
        t => t.type === 'page' && t.url && t.url.includes('chatgpt.com'),
    );
    if (!chatgptTab) {
        console.error('❌ No ChatGPT tab found.');
        process.exit(1);
    }
    console.log(`✅ Found ChatGPT tab: ${chatgptTab.url.substring(0, 60)}...`);

    const ws = new WebSocket(chatgptTab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    try {
        await cdpSend(ws, 'Runtime.enable');

        // ── A0: Draft-only probe ──────────────────────────────────────
        console.log('\n📋 A0: Draft-only probe...');

        // Baseline user message count
        const baselineRes = await cdpSend(ws, 'Runtime.evaluate', {
            expression: COUNT_USER_MESSAGES, returnByValue: true,
        });
        const baseline = JSON.parse(baselineRes.result.value);
        console.log(`   Baseline user messages: ${baseline.count}`);

        // Insert payload
        console.log('   Inserting synthetic payload...');
        const insertRes = await cdpSend(ws, 'Runtime.evaluate', {
            expression: makeInsertExpression(payload.text), returnByValue: true,
        });
        const insertResult = JSON.parse(insertRes.result.value);

        if (insertResult.error) {
            console.error(`❌ Insert failed: ${insertResult.error}`);
            process.exit(1);
        }

        await sleep(500); // let button transform

        // Re-check submit button state
        const btnCheckRes = await cdpSend(ws, 'Runtime.evaluate', {
            expression: `(function() {
                const form = document.querySelector('#prompt-textarea')?.closest('form');
                const btn = form ? (form.querySelector('button[data-testid="send-button"]') || form.querySelector('button[data-testid="composer-speech-button"]')) : null;
                return JSON.stringify({
                    testId: btn ? btn.getAttribute('data-testid') : null,
                    disabled: btn ? btn.disabled : null,
                    visible: btn ? btn.getBoundingClientRect().width > 0 : null,
                });
            })()`,
            returnByValue: true,
        });
        const btnState = JSON.parse(btnCheckRes.result.value);

        const a0Evidence = {
            composerHoldsPayload: insertResult.ok && insertResult.composerTextLength > 0,
            composerTextLength: insertResult.composerTextLength,
            composerInnerHTMLLength: insertResult.composerInnerHTMLLength,
            payloadPreserved: insertResult.composerTextLength >= payload.text.length * 0.9, // allow small variance
            submitButtonAfterInsert: btnState.testId,
            submitButtonEnabled: !btnState.disabled,
            submitButtonVisible: btnState.visible,
            sendButtonAppeared: btnState.testId === 'send-button',
        };

        console.log(`   Composer text length: ${a0Evidence.composerTextLength}`);
        console.log(`   Payload preserved: ${a0Evidence.payloadPreserved}`);
        console.log(`   Send button appeared: ${a0Evidence.sendButtonAppeared}`);

        let a1Evidence = null;

        if (RUN_SUBMIT) {
            // ── A1: Submitted probe ───────────────────────────────────
            console.log('\n📋 A1: Submit + observe user message DOM...');

            // Click submit
            const submitRes = await cdpSend(ws, 'Runtime.evaluate', {
                expression: CLICK_SUBMIT, returnByValue: true,
            });
            const submitResult = JSON.parse(submitRes.result.value);

            if (submitResult.error) {
                console.error(`❌ Submit failed: ${submitResult.error}`);
                a1Evidence = { error: submitResult.error };
            } else {
                console.log('   Submit clicked. Bounded polling for new user message...');

                // Bounded polling: check every 300ms, up to 10 seconds
                const maxWait = 10000;
                const pollInterval = 300;
                const startTime = Date.now();
                let newMessageFound = false;
                let snapshot = null;

                while (Date.now() - startTime < maxWait) {
                    await sleep(pollInterval);
                    const countRes = await cdpSend(ws, 'Runtime.evaluate', {
                        expression: COUNT_USER_MESSAGES, returnByValue: true,
                    });
                    const current = JSON.parse(countRes.result.value);

                    if (current.count > baseline.count) {
                        // New user message appeared! Wait a bit more for DOM to settle
                        await sleep(500);

                        // Snapshot
                        const snapRes = await cdpSend(ws, 'Runtime.evaluate', {
                            expression: makeSnapshotExpression(payload.markerCallIds),
                            returnByValue: true,
                        });
                        snapshot = JSON.parse(snapRes.result.value);
                        newMessageFound = true;

                        console.log(`   New user message found after ${Date.now() - startTime}ms`);
                        console.log(`   Total user messages: ${current.count} (was ${baseline.count})`);
                        console.log(`   Matching messages with our marker: ${snapshot.matchingMessages.length}`);
                        break;
                    }
                }

                if (!newMessageFound) {
                    console.log(`   ⚠️ No new user message found within ${maxWait}ms`);
                }

                a1Evidence = {
                    submitted: true,
                    newMessageFoundMs: newMessageFound ? Date.now() - startTime : null,
                    baselineMessageCount: baseline.count,
                    snapshot,
                };

                // Phase 4 smoke verdict (embedded in A1)
                if (snapshot && snapshot.matchingMessages.length > 0) {
                    const match = snapshot.matchingMessages[0];
                    a1Evidence.phase4SmokeVerdict = {
                        insertedLength: payload.text.length,
                        sendButtonAfterInsert: a0Evidence.sendButtonAppeared,
                        submitClicked: true,
                        newUserMessageCount: snapshot.matchingMessages.length,
                        containsFunctionResults: match.hasFunctionResults,
                        containsAllCallIds: match.hasAllCallIds,
                        pass: match.hasFunctionResults && match.hasAllCallIds && snapshot.matchingMessages.length === 1,
                    };

                    // Gate 6 observation data
                    a1Evidence.gate6Observation = {
                        userMessageRootTag: match.rootTag,
                        userMessageHasDataMessageId: match.hasDataMessageId,
                        textContentComplete: match.hasFunctionResults && match.hasAllCallIds,
                        functionResultsPreserved: match.hasFunctionResults,
                        cdataPreserved: match.hasCDATA,
                        preCount: match.preCount,
                        codeCount: match.codeCount,
                        childStructure: match.childStructure,
                        xmlRenderedAsPlaintext: match.preCount === 0 && match.codeCount === 0 && match.hasFunctionResults,
                        mountCandidates: match.hasDataMessageId
                            ? [`[data-message-author-role="user"][data-message-id]`]
                            : ['[data-message-author-role="user"]'],
                    };
                }
            }
        } else {
            // A0 only — clear input
            console.log('\n   Clearing composer (A0 draft-only mode)...');
            await cdpSend(ws, 'Runtime.evaluate', {
                expression: CLEAR_INPUT, returnByValue: true,
            });
        }

        // ── Build final evidence ──────────────────────────────────────
        const evidence = {
            provider: 'chatgpt',
            probeVersion: '1.0.0',
            timestamp: new Date().toISOString(),
            lane: RUN_SUBMIT ? 'A0+A1' : 'A0',
            payload: {
                kind: payload.payloadKind,
                sha256: payload.sha256,
                length: payload.text.length,
                callIds: payload.markerCallIds,
            },
            a0: a0Evidence,
            a1: a1Evidence,
        };

        // ── Output ────────────────────────────────────────────────────
        console.log('\n' + '='.repeat(60));
        console.log('EVIDENCE (JSON):');
        console.log('='.repeat(60));
        console.log(JSON.stringify(evidence, null, 2));

        console.log('\n' + '='.repeat(60));
        console.log('SUMMARY:');
        console.log('='.repeat(60));
        printSummary(evidence);

    } finally {
        ws.close();
    }
}

function printSummary(evidence) {
    const check = (pass) => (pass ? '✅ PASS' : '❌ FAIL');

    console.log(`\nGate 6 ChatGPT Lane A — ${evidence.lane}`);
    console.log(`Payload: ${evidence.payload.kind} (${evidence.payload.length} chars)`);

    console.log('\nA0 (Draft-only):');
    console.log(`  Composer holds payload:  ${check(evidence.a0.composerHoldsPayload)}`);
    console.log(`  Payload preserved:       ${check(evidence.a0.payloadPreserved)}`);
    console.log(`  Send button appeared:    ${check(evidence.a0.sendButtonAppeared)}`);

    if (evidence.a1) {
        if (evidence.a1.error) {
            console.log(`\nA1 (Submitted): ❌ ${evidence.a1.error}`);
        } else {
            console.log('\nA1 (Submitted):');
            console.log(`  New user message found:  ${check(!!evidence.a1.snapshot?.matchingMessages?.length)}`);
            console.log(`  Found after:             ${evidence.a1.newMessageFoundMs}ms`);

            if (evidence.a1.phase4SmokeVerdict) {
                const v = evidence.a1.phase4SmokeVerdict;
                console.log('\n  Phase 4 Smoke Verdict:');
                console.log(`    Submit path OK:        ${check(v.sendButtonAfterInsert && v.submitClicked)}`);
                console.log(`    Single user message:   ${check(v.newUserMessageCount === 1)}`);
                console.log(`    Contains XML:          ${check(v.containsFunctionResults)}`);
                console.log(`    Contains all call_ids: ${check(v.containsAllCallIds)}`);
                console.log(`    Overall:               ${check(v.pass)}`);
            }

            if (evidence.a1.gate6Observation) {
                const g = evidence.a1.gate6Observation;
                console.log('\n  Gate 6 Observation:');
                console.log(`    XML rendered as text:  ${check(g.xmlRenderedAsPlaintext)}`);
                console.log(`    function_results OK:   ${check(g.functionResultsPreserved)}`);
                console.log(`    CDATA preserved:       ${check(g.cdataPreserved)}`);
                console.log(`    code/pre elements:     ${g.codeCount} code, ${g.preCount} pre`);
                console.log(`    Has data-message-id:   ${check(g.userMessageHasDataMessageId)}`);
                console.log(`    Mount candidates:      ${g.mountCandidates.join(', ')}`);
            }
        }
    }
}

main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
