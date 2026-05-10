/**
 * CDP probe: observe window.name and document.title across all open tabs.
 *
 * Purpose: Observation-Oriented PL-TDD step 1 — gather evidence about
 * how ai-web-agent-mcp tab labels appear in the browser runtime.
 *
 * Evidence preserved in: outputs/probe-tab-labels-<timestamp>.json
 *
 * Usage: node scripts/probe-tab-labels.cjs
 */

const { listPages, connectCDP } = require('./lib/comet-connect.cjs');
const fs = require('fs');
const path = require('path');

const AIWEB_PREFIX = '__AIWEB__';

async function probeAllTabs() {
  const pages = await listPages();
  console.log(`\n📋 Found ${pages.length} open tab(s)\n`);

  const results = [];

  for (const page of pages) {
    const entry = {
      cdp_title: page.title || '(none)',
      cdp_url: page.url || '(none)',
      runtime_title: null,
      runtime_windowName: null,
      detected_label: null,
      label_source: null,
    };

    try {
      const cdp = connectCDP(page.webSocketDebuggerUrl);
      await cdp.connect();

      // Listen for WebSocket messages
      cdp.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id) {
          const cb = cdp.ws._pending?.get(msg.id);
          // handled by send() promise
        }
      });

      // Skip Runtime.enable — go directly to evaluate
      // Evaluate window.name
      const nameResult = await cdp.send('Runtime.evaluate', {
        expression: 'window.name',
        returnByValue: true,
      });
      entry.runtime_windowName = nameResult?.result?.value ?? null;

      // Evaluate document.title
      const titleResult = await cdp.send('Runtime.evaluate', {
        expression: 'document.title',
        returnByValue: true,
      });
      entry.runtime_title = titleResult?.result?.value ?? null;

      // Check for __AIWEB__ label in window.name
      if (entry.runtime_windowName && entry.runtime_windowName.startsWith(AIWEB_PREFIX)) {
        entry.detected_label = entry.runtime_windowName.slice(AIWEB_PREFIX.length);
        entry.label_source = 'window-name';
      }
      // Fallback: check title prefix [label]
      else if (entry.runtime_title) {
        const match = entry.runtime_title.match(/^\[([^\]]+)\]/);
        if (match) {
          entry.detected_label = match[1];
          entry.label_source = 'title-prefix';
        }
      }

      cdp.close();
    } catch (err) {
      entry.error = err.message;
    }

    // Log to console
    const labelStr = entry.detected_label
      ? `✅ label="${entry.detected_label}" (${entry.label_source})`
      : '❌ no label';
    console.log(`  ${labelStr}`);
    console.log(`    title:  ${entry.runtime_title || entry.cdp_title}`);
    console.log(`    name:   ${JSON.stringify(entry.runtime_windowName)}`);
    console.log(`    url:    ${(entry.cdp_url || '').slice(0, 80)}`);
    console.log('');

    results.push(entry);
  }

  // Summary
  const labeled = results.filter(r => r.detected_label);
  const unlabeled = results.filter(r => !r.detected_label && !r.error);
  const errors = results.filter(r => r.error);

  console.log('━━━ Summary ━━━');
  console.log(`  Labeled:   ${labeled.length}`);
  console.log(`  Unlabeled: ${unlabeled.length}`);
  console.log(`  Errors:    ${errors.length}`);

  // Save evidence
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.join(__dirname, '..', 'outputs');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `probe-tab-labels-${timestamp}.json`);

  const evidence = {
    timestamp: new Date().toISOString(),
    probe: 'tab-labels',
    total_tabs: pages.length,
    labeled_count: labeled.length,
    unlabeled_count: unlabeled.length,
    error_count: errors.length,
    results,
  };

  fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2));
  console.log(`\n📄 Evidence saved: ${outFile}`);

  return evidence;
}

probeAllTabs().catch(err => {
  console.error('Probe failed:', err.message);
  process.exit(1);
});
