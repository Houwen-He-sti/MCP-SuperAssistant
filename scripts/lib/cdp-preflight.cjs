/**
 * CDP Preflight Checks — reusable validation for all CDP diagnostic scripts.
 *
 * Prevents two classes of silent failures:
 *   1. Extension identity confusion (P23/P24): operating on wrong extension
 *   2. Wrong execution context (P25): running on wrong page/route
 *
 * Usage:
 *   const { resolveExtensionId, ensureAgentPage, preflight } = require('./lib/cdp-preflight.cjs');
 *
 *   // Option A: full preflight (resolves extension + ensures agent page)
 *   const { extensionId, extensionName, extensionWsUrl, tab, navigated } = await preflight();
 *
 *   // Option B: individual checks
 *   const { extensionId, name, wsUrl } = await resolveExtensionId('MCP SuperAssistant');
 *   const { tab, navigated, url } = await ensureAgentPage();
 */

const http = require('http');
const WebSocket = require('ws');

const CDP_PORT = process.env.CDP_PORT || 9222;
const AGENT_URL = process.env.NOTION_AGENT_URL || 'https://www.notion.so/agent/359cae42116c806fb9c4009257f4c5d1?wfv=chat';

// ─── CDP helpers ────────────────────────────────────────────────────────────

function getTargets() {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${CDP_PORT}/json`, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── P23: Resolve Extension ID by human-readable name ───────────────────────
//
// Instead of hardcoding opaque 32-char hashes, discover the extension ID
// at runtime by matching the human-readable name from the service worker URL
// + manifest inspection.
//
// This eliminates the "wrong extension" class of bugs entirely.
//
async function resolveExtensionId(expectedName = 'MCP SuperAssistant') {
    const targets = await getTargets();

    // Strategy 1: Find service worker whose URL contains "chrome-extension://"
    // and verify name via Runtime.evaluate → chrome.runtime.getManifest()
    const serviceWorkers = targets.filter(t =>
        t.type === 'service_worker' && t.url.startsWith('chrome-extension://')
    );

    for (const sw of serviceWorkers) {
        const extId = sw.url.match(/chrome-extension:\/\/([a-z]+)\//)?.[1];
        if (!extId) continue;

        try {
            const ws = new WebSocket(sw.webSocketDebuggerUrl);
            await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });

            const result = await new Promise((resolve) => {
                ws.on('message', msg => {
                    const o = JSON.parse(msg);
                    if (o.id === 1) resolve(o);
                });
                ws.send(JSON.stringify({
                    id: 1,
                    method: 'Runtime.evaluate',
                    params: { expression: 'chrome.runtime.getManifest().name', returnByValue: true }
                }));
                setTimeout(() => resolve(null), 3000);
            });

            ws.close();

            const name = result?.result?.result?.value;
            if (name && name.includes(expectedName)) {
                return { extensionId: extId, name, wsUrl: sw.webSocketDebuggerUrl };
            }
        } catch {
            // Skip non-responsive service workers
        }
    }

    // Strategy 2: If no SW found, scan extension pages
    const extPages = targets.filter(t =>
        t.url.startsWith('chrome-extension://') && t.type === 'page'
    );
    for (const pg of extPages) {
        const extId = pg.url.match(/chrome-extension:\/\/([a-z]+)\//)?.[1];
        if (extId && pg.title?.includes(expectedName)) {
            return { extensionId: extId, name: pg.title, wsUrl: pg.webSocketDebuggerUrl };
        }
    }

    throw new Error(
        `Extension "${expectedName}" not found among ${serviceWorkers.length} service workers and ${extPages.length} extension pages.\n` +
        `Available:\n` + serviceWorkers.map(s => `  SW: ${s.url}`).join('\n')
    );
}

// ─── P25: Ensure correct page context ───────────────────────────────────────
//
// SPA apps may have visually identical pages on different routes
// that trigger different API endpoints. Always navigate explicitly.
//
async function ensureAgentPage(agentUrl = AGENT_URL) {
    const targets = await getTargets();
    let notionTab = targets.find(t => t.type === 'page' && t.url?.includes('notion.so'));

    if (!notionTab) {
        throw new Error('No Notion tab found in Chrome. Open Notion first.');
    }

    // Check if already on agent page
    if (notionTab.url.includes('/agent/')) {
        return {
            tab: notionTab,
            navigated: false,
            url: notionTab.url,
        };
    }

    // Navigate to agent page
    console.log(`⚠️  Tab on ${notionTab.url.slice(0, 60)} — navigating to /agent/ ...`);
    const ws = new WebSocket(notionTab.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));
    ws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: agentUrl } }));
    await sleep(8000);
    ws.close();

    // Re-fetch to get updated URL/wsUrl
    const targets2 = await getTargets();
    notionTab = targets2.find(t => t.type === 'page' && t.url?.includes('notion.so'));

    if (!notionTab) {
        throw new Error('Notion tab lost after navigation');
    }
    if (!notionTab.url.includes('/agent/')) {
        throw new Error(`Navigation failed: still on ${notionTab.url}`);
    }

    return {
        tab: notionTab,
        navigated: true,
        url: notionTab.url,
    };
}

// ─── Full preflight: extension + page in one call ───────────────────────────

async function preflight(opts = {}) {
    const extName = opts.extensionName || 'MCP SuperAssistant';
    const agentUrl = opts.agentUrl || AGENT_URL;

    console.log('🔍 Preflight: resolving extension...');
    const ext = await resolveExtensionId(extName);
    console.log(`✅ Extension: ${ext.name} (${ext.extensionId})`);

    console.log('🔍 Preflight: ensuring agent page...');
    const page = await ensureAgentPage(agentUrl);
    console.log(`✅ Page: ${page.url.slice(0, 80)}${page.navigated ? ' (navigated)' : ''}`);

    return {
        extensionId: ext.extensionId,
        extensionName: ext.name,
        extensionWsUrl: ext.wsUrl,
        tab: page.tab,
        navigated: page.navigated,
    };
}

module.exports = { resolveExtensionId, ensureAgentPage, preflight, getTargets, sleep, CDP_PORT, AGENT_URL };
