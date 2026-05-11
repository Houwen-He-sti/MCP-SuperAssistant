/**
 * Phase A: ChatGPT Provider DOM Contract Probe
 *
 * Validates the DOM assumptions made by batchScan.ts (Phase 2):
 *   1. `[data-message-author-role="assistant"]` elements exist
 *   2. `data-message-id` attribute exists and is stable
 *   3. Different assistant messages have distinct IDs
 *   4. Codeblocks can be traced to their parent assistant message
 *   5. Identity is stable across two consecutive scans (500ms apart)
 *
 * Usage:
 *   # Ensure Chrome is running with --remote-debugging-port=9222
 *   # and a ChatGPT conversation with assistant messages is open.
 *   node scripts/e2e-chatgpt-dom-contract.cjs
 *
 * Output: Structured JSON evidence to stdout + human-readable summary.
 * Sanitized: no conversation text, no tokens, no account info.
 */

const http = require('http');
const WebSocket = require('ws');

const CDP_PORT = process.env.CDP_PORT || 9222;
const SCAN_DELAY_MS = 500; // delay between dual scans

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

/**
 * Send a CDP command over WebSocket and wait for the response.
 */
function cdpSend(ws, method, params = {}) {
    const id = cdpSend._counter = (cdpSend._counter || 0) + 1;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 10000);
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

// ─── DOM probe expression ───────────────────────────────────────────────────

/**
 * This expression runs inside the ChatGPT page and collects structural
 * information about assistant messages — no conversation text is collected.
 */
const PROBE_EXPRESSION = `
(function() {
  const SELECTOR = '[data-message-author-role="assistant"]';
  const msgs = document.querySelectorAll(SELECTOR);

  const assistantMessages = [];
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    const dataMessageId = msg.getAttribute('data-message-id') || null;
    const dataTestId = msg.getAttribute('data-testid') || null;

    // Determine identity source following batchScan.ts fallback chain
    let identitySource = 'none';
    let identityValue = null;
    if (dataMessageId) {
      identitySource = 'data-message-id';
      identityValue = dataMessageId;
    } else if (dataTestId) {
      identitySource = 'data-testid';
      identityValue = dataTestId;
    }

    // Count descendant codeblocks (pre elements containing code)
    const preBlocks = msg.querySelectorAll('pre');
    const codeBlocks = [];
    for (const pre of preBlocks) {
      const code = pre.querySelector('code');
      if (code) {
        // Check if this codeblock's closest assistant message is THIS message
        const tracedParent = pre.closest(SELECTOR);
        codeBlocks.push({
          tracedToCorrectParent: tracedParent === msg,
          hasLanguageClass: !!(code.className && code.className.match(/language-/)),
        });
      }
    }

    // Check for tool-call-like markers (data-block-id from extension)
    const markedBlocks = msg.querySelectorAll('[data-block-id]');

    assistantMessages.push({
      index: i,
      hasDataMessageId: !!dataMessageId,
      hasDataTestId: !!dataTestId,
      identitySource,
      // Sanitize: only include first 8 chars of ID to prove uniqueness without leaking
      identityValuePrefix: identityValue ? identityValue.substring(0, 8) : null,
      identityValueLength: identityValue ? identityValue.length : 0,
      descendantCodeBlockCount: codeBlocks.length,
      descendantMarkedBlockCount: markedBlocks.length,
      codeBlockTracing: codeBlocks,
      tagName: msg.tagName,
      // Check some structural properties
      hasDataMessageAuthorRole: msg.getAttribute('data-message-author-role') === 'assistant',
    });
  }

  // Also check for user messages (for function_result_selector validation)
  const userMsgs = document.querySelectorAll('[data-message-author-role="user"]');

  // Check input selector
  const inputField = document.querySelector('#prompt-textarea') ||
                     document.querySelector('textarea[data-id="root"]') ||
                     document.querySelector('[contenteditable="true"][id="prompt-textarea"]') ||
                     document.querySelector('div[contenteditable="true"]#prompt-textarea');

  // Submit button: check empty-input state (voice mode expected)
  // Note: the button has no explicit type="submit" attribute, so we use data-testid
  const form = inputField ? inputField.closest('form') : null;
  const submitBtn = form ? (
    form.querySelector('button[data-testid="send-button"]') ||
    form.querySelector('button[data-testid="composer-speech-button"]')
  ) : null;
  const emptyStateSubmit = submitBtn ? {
    dataTestId: submitBtn.getAttribute('data-testid'),
    ariaLabel: submitBtn.getAttribute('aria-label'),
    type: submitBtn.type,
    mode: submitBtn.getAttribute('data-testid') === 'send-button' ? 'send' : 'voice_or_idle',
  } : null;

  return JSON.stringify({
    provider: 'chatgpt',
    url: window.location.hostname,
    timestamp: new Date().toISOString(),
    assistantMessageCount: msgs.length,
    userMessageCount: userMsgs.length,
    assistantMessages,
    inputFieldFound: !!inputField,
    inputFieldTag: inputField ? inputField.tagName : null,
    emptyStateSubmit,
  });
})()
`;

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
    console.log('🔍 ChatGPT DOM Contract Probe — Phase A\n');

    // 1. Find ChatGPT tab
    console.log(`Connecting to CDP on port ${CDP_PORT}...`);
    const targets = await getTargets();
    const chatgptTab = targets.find(
        t => t.type === 'page' && t.url && t.url.includes('chatgpt.com'),
    );

    if (!chatgptTab) {
        console.error('❌ No ChatGPT tab found. Open chatgpt.com in Chrome with --remote-debugging-port=9222');
        process.exit(1);
    }

    console.log(`✅ Found ChatGPT tab: ${chatgptTab.url.substring(0, 60)}...`);

    // 2. Connect via WebSocket
    const ws = new WebSocket(chatgptTab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    try {
        // Enable Runtime domain
        await cdpSend(ws, 'Runtime.enable');

        // 3. Scan A
        console.log('\n📋 Scan A...');
        const resultA = await cdpSend(ws, 'Runtime.evaluate', {
            expression: PROBE_EXPRESSION,
            returnByValue: true,
        });
        const scanA = JSON.parse(resultA.result.value);

        // 4. Wait, then Scan B (stability check)
        console.log(`⏱️  Waiting ${SCAN_DELAY_MS}ms...`);
        await sleep(SCAN_DELAY_MS);

        console.log('📋 Scan B (stability rescan)...');
        const resultB = await cdpSend(ws, 'Runtime.evaluate', {
            expression: PROBE_EXPRESSION,
            returnByValue: true,
        });
        const scanB = JSON.parse(resultB.result.value);

        // 5. Compare scans for stability
        const stabilityReport = analyzeStability(scanA, scanB);

        // 5b. Stateful submit button probe
        console.log('\n📋 Submit button state probe...');
        const submitProbe = await probeSubmitButton(ws);

        // 6. Build final evidence
        const evidence = buildEvidence(scanA, scanB, stabilityReport, submitProbe);

        // 7. Output
        console.log('\n' + '='.repeat(60));
        console.log('EVIDENCE (JSON):');
        console.log('='.repeat(60));
        console.log(JSON.stringify(evidence, null, 2));

        console.log('\n' + '='.repeat(60));
        console.log('SUMMARY:');
        console.log('='.repeat(60));
        printSummary(evidence);

        // Exit with appropriate code
        process.exit(evidence.contractPass ? 0 : 1);
    } finally {
        ws.close();
    }
}

// ─── Submit Button State Probe ──────────────────────────────────────────────

const INSERT_SENTINEL = `
(function() {
  const input = document.querySelector('#prompt-textarea');
  if (!input) return JSON.stringify({ error: 'input not found' });
  input.focus();
  input.innerHTML = '';
  const p = document.createElement('p');
  p.textContent = 'probe-sentinel-text';
  input.appendChild(p);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return JSON.stringify({ ok: true });
})()
`;

const CHECK_SEND_BUTTON = `
(function() {
  const form = document.querySelector('#prompt-textarea')?.closest('form');
  if (!form) return JSON.stringify({ error: 'form not found' });
  const btn = form.querySelector('button[data-testid="send-button"]') ||
              form.querySelector('button[data-testid="composer-speech-button"]');
  if (!btn) return JSON.stringify({ found: false });
  return JSON.stringify({
    found: true,
    dataTestId: btn.getAttribute('data-testid'),
    ariaLabel: btn.getAttribute('aria-label'),
    disabled: btn.disabled,
    visible: btn.getBoundingClientRect().width > 0,
  });
})()
`;

const CLEAR_INPUT = `
(function() {
  const input = document.querySelector('#prompt-textarea');
  if (!input) return JSON.stringify({ error: 'input not found' });
  input.focus();
  input.innerHTML = '<p><br></p>';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return JSON.stringify({ ok: true });
})()
`;

async function probeSubmitButton(ws) {
    // Insert text
    const insertRes = await cdpSend(ws, 'Runtime.evaluate', {
        expression: INSERT_SENTINEL, returnByValue: true,
    });
    const insertOk = JSON.parse(insertRes.result.value);
    if (insertOk.error) return { error: insertOk.error };

    await sleep(400);

    // Check button state with text
    const btnRes = await cdpSend(ws, 'Runtime.evaluate', {
        expression: CHECK_SEND_BUTTON, returnByValue: true,
    });
    const withText = JSON.parse(btnRes.result.value);

    // Clear
    await cdpSend(ws, 'Runtime.evaluate', {
        expression: CLEAR_INPUT, returnByValue: true,
    });
    await sleep(300);

    // Check button state without text
    const btnRes2 = await cdpSend(ws, 'Runtime.evaluate', {
        expression: CHECK_SEND_BUTTON, returnByValue: true,
    });
    const withoutText = JSON.parse(btnRes2.result.value);

    return {
        afterInsert: withText,
        afterClear: withoutText,
        sendButtonAppearsAfterInsert: withText.found && withText.dataTestId === 'send-button',
        sendButtonDisappearsAfterClear: withoutText.found && withoutText.dataTestId !== 'send-button',
    };
}

// ─── Analysis ───────────────────────────────────────────────────────────────

function analyzeStability(scanA, scanB) {
    const report = {
        messageCountStable: scanA.assistantMessageCount === scanB.assistantMessageCount,
        identityListMatch: true,
        identityChangedDuringRescan: false,
        changedIndices: [],
    };

    // Compare identity values for each message present in both scans
    const minCount = Math.min(scanA.assistantMessages.length, scanB.assistantMessages.length);
    for (let i = 0; i < minCount; i++) {
        const a = scanA.assistantMessages[i];
        const b = scanB.assistantMessages[i];
        if (
            a.identitySource !== b.identitySource ||
            a.identityValuePrefix !== b.identityValuePrefix ||
            a.identityValueLength !== b.identityValueLength
        ) {
            report.identityListMatch = false;
            report.identityChangedDuringRescan = true;
            report.changedIndices.push(i);
        }
    }

    if (scanA.assistantMessages.length !== scanB.assistantMessages.length) {
        report.identityListMatch = false;
    }

    return report;
}

function buildEvidence(scanA, scanB, stability, submitProbe) {
    const scan = scanA; // use first scan as primary

    // Check uniqueness of identities
    const identityPrefixes = scan.assistantMessages
        .map(m => m.identityValuePrefix)
        .filter(v => v !== null);
    const uniquePrefixes = new Set(identityPrefixes);
    const hasDuplicateIdentity = uniquePrefixes.size < identityPrefixes.length;

    // Check all have data-message-id (vs fallback)
    const withDataMessageId = scan.assistantMessages.filter(m => m.hasDataMessageId).length;
    const withDataTestId = scan.assistantMessages.filter(m => m.hasDataTestId).length;
    const withNoIdentity = scan.assistantMessages.filter(m => m.identitySource === 'none').length;

    // Check codeblock tracing
    let codeblockTracingCorrect = true;
    let totalCodeblocks = 0;
    for (const msg of scan.assistantMessages) {
        for (const cb of msg.codeBlockTracing) {
            totalCodeblocks++;
            if (!cb.tracedToCorrectParent) codeblockTracingCorrect = false;
        }
    }

    // Streaming detection heuristic: if message count changed between scans
    // or identities changed, page might be streaming
    const streamingLikely = !stability.messageCountStable || stability.identityChangedDuringRescan;

    // Determine pass level
    let passLevel = 'full';
    const failures = [];

    if (scan.assistantMessageCount < 2) {
        passLevel = 'insufficient_data';
        failures.push('Need at least 2 assistant messages for uniqueness validation');
    }
    if (hasDuplicateIdentity) {
        passLevel = 'fail';
        failures.push('Duplicate identity values found across different assistant messages');
    }
    if (withNoIdentity > 0) {
        passLevel = 'degraded';
        failures.push(`${withNoIdentity} message(s) have no identity — would use synthetic fallback`);
    }
    if (withDataMessageId === 0 && scan.assistantMessageCount > 0) {
        if (withDataTestId > 0) {
            if (passLevel === 'full') passLevel = 'degraded';
            failures.push('No data-message-id found, falling back to data-testid');
        } else {
            passLevel = 'fail';
            failures.push('No data-message-id or data-testid found — all identities would be synthetic');
        }
    }
    if (!stability.identityListMatch) {
        passLevel = 'fail';
        failures.push(`Identity changed between scans at indices: ${stability.changedIndices.join(', ')}`);
    }
    if (!codeblockTracingCorrect && totalCodeblocks > 0) {
        passLevel = 'fail';
        failures.push('Codeblock-to-parent tracing is incorrect');
    }

    const contractPass = passLevel === 'full' || passLevel === 'degraded';

    return {
        provider: 'chatgpt',
        probeVersion: '1.1.0',
        timestamp: scan.timestamp,
        urlDomain: scan.url,

        // Core metrics
        assistantMessageCount: scan.assistantMessageCount,
        userMessageCount: scan.userMessageCount,

        // Identity analysis
        identitySummary: {
            withDataMessageId,
            withDataTestId,
            withNoIdentity,
            uniqueIdentityCount: uniquePrefixes.size,
            duplicateIdentityCount: identityPrefixes.length - uniquePrefixes.size,
        },

        // Detailed messages (sanitized)
        assistantMessages: scan.assistantMessages.map(m => ({
            index: m.index,
            hasDataMessageId: m.hasDataMessageId,
            hasDataTestId: m.hasDataTestId,
            identitySource: m.identitySource,
            identityStableAfterRescan: !stability.changedIndices.includes(m.index),
            descendantCodeBlockCount: m.descendantCodeBlockCount,
            descendantMarkedBlockCount: m.descendantMarkedBlockCount,
            codeBlockTracingCorrect: m.codeBlockTracing.every(cb => cb.tracedToCorrectParent),
        })),

        // Codeblock tracing
        codeblockTracing: {
            totalCodeblocks,
            allTracedCorrectly: codeblockTracingCorrect,
        },

        // Stability
        stability: {
            messageCountStable: stability.messageCountStable,
            identityStableAcrossScans: stability.identityListMatch,
            streamingLikely,
            scanDelayMs: SCAN_DELAY_MS,
        },

        // Input/submit selectors
        inputFieldFound: scan.inputFieldFound,
        submitControl: submitProbe.error ? { error: submitProbe.error } : {
            emptyState: scan.emptyStateSubmit,
            afterInsert: submitProbe.afterInsert,
            afterClear: submitProbe.afterClear,
            sendButtonAppearsAfterInsert: submitProbe.sendButtonAppearsAfterInsert,
            sendButtonDisappearsAfterClear: submitProbe.sendButtonDisappearsAfterClear,
        },

        // Verdict
        passLevel,
        failures,
        contractPass,
    };
}

// ─── Human-readable summary ─────────────────────────────────────────────────

function printSummary(evidence) {
    const check = (pass) => (pass ? '✅ PASS' : '❌ FAIL');
    const warn = (pass) => (pass ? '✅ PASS' : '⚠️  DEGRADED');

    console.log(`\nChatGPT DOM Contract — ${evidence.passLevel.toUpperCase()}`);
    console.log(`Provider: ${evidence.provider}`);
    console.log(`Messages: ${evidence.assistantMessageCount} assistant, ${evidence.userMessageCount} user\n`);

    console.log('Contract Checks:');
    console.log(`  1. Assistant message selector:    ${check(evidence.assistantMessageCount > 0)}`);
    console.log(`  2. data-message-id present:       ${warn(evidence.identitySummary.withDataMessageId > 0)}`);
    console.log(`  3. Identity uniqueness:           ${check(evidence.identitySummary.duplicateIdentityCount === 0)}`);
    console.log(`  4. Identity stable across scans:  ${check(evidence.stability.identityStableAcrossScans)}`);
    console.log(`  5. Codeblock parent tracing:      ${check(evidence.codeblockTracing.allTracedCorrectly)}`);
    console.log(`  6. Input field selector:          ${check(evidence.inputFieldFound)}`);
    const submitPass = evidence.submitControl.sendButtonAppearsAfterInsert;
    console.log(`  7. Submit button (after insert):  ${check(submitPass)}`);
    console.log(`     Empty state: ${evidence.submitControl.emptyState?.dataTestId || 'N/A'}`);
    console.log(`     After text:  ${evidence.submitControl.afterInsert?.dataTestId || 'N/A'}`);
    console.log(`     After clear: ${evidence.submitControl.afterClear?.dataTestId || 'N/A'}`);
    console.log(`  8. Streaming stability:           ${evidence.stability.streamingLikely ? '⚠️  STREAMING DETECTED' : '✅ STABLE'}`);

    if (evidence.failures.length > 0) {
        console.log('\nIssues:');
        for (const f of evidence.failures) {
            console.log(`  - ${f}`);
        }
    }

    console.log(`\nVerdict: ${evidence.contractPass ? '✅ CONTRACT PASS' : '❌ CONTRACT FAIL'} (${evidence.passLevel})`);
}

main().catch(err => {
    console.error('❌ Probe failed:', err.message);
    process.exit(2);
});
