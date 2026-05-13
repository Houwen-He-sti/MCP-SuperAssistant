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
const fs = require('fs');
const path = require('path');

const CDP_PORT = process.env.CDP_PORT || 9222;
const AGENT_URL = process.env.NOTION_AGENT_URL || 'https://www.notion.so/chat';

// ─── Config: read required_workspace from config/workspace.toml ─────────────
// TOML parser for simple key = "value" format (no nested objects/arrays needed)

function readWorkspaceConfig() {
    // Default workspace root: scripts/lib → MCP-SuperAssistant → workspace root
    const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ||
        path.resolve(__dirname, '../../..');
    const CONFIG_PATH = path.join(WORKSPACE_ROOT, 'config', 'workspace.toml');

    try {
        const content = fs.readFileSync(CONFIG_PATH, 'utf-8');

        // Parse [notion] section for required_workspace
        const notionMatch = content.match(/\[notion\]([\s\S]*?)(?:\n\[|$)/);
        if (notionMatch) {
            const workspaceMatch = notionMatch[1].match(/required_workspace\s*=\s*"([^"]+)"/);
            if (workspaceMatch) {
                return workspaceMatch[1];
            }
        }

        // Fallback to [workspace] section for root
        const rootMatch = content.match(/\[workspace\]([\s\S]*?)(?:\n\[|$)/);
        if (rootMatch) {
            const rootPathMatch = rootMatch[1].match(/root\s*=\s*"([^"]+)"/);
            if (rootPathMatch) {
                return path.join(rootPathMatch[1], 'config', 'workspace.toml');
            }
        }
    } catch (err) {
        // Config file not found or unreadable — use default
        console.log(`⚠️  Cannot read config/workspace.toml: ${err.message}`);
    }

    return null;
}

// Read required workspace at module load time
const REQUIRED_WORKSPACE = process.env.NOTION_WORKSPACE || readWorkspaceConfig() || 'sjzj030的工作空间';

// ─── WorkspaceMismatchError ──────────────────────────────────────────────
class WorkspaceMismatchError extends Error {
    constructor(detected, expected) {
        super(
            `❌ Wrong workspace: detected "${detected}", required "${expected}".\n` +
            `   Please switch to "${expected}" in Notion sidebar, then re-run.\n` +
            `   (AI quota may be exhausted in the wrong workspace)`
        );
        this.name = 'WorkspaceMismatchError';
        this.detected = detected;
        this.expected = expected;
    }
}

// ─── checkWorkspace (pure function, no CDP) ─────────────────────────────
// Compares detected workspace against expected. Throws WorkspaceMismatchError
// on mismatch, returns { matched: true, error: null } on match.
function checkWorkspace(detected, expected) {
    if (detected && detected.toLowerCase().includes(expected.toLowerCase())) {
        return { matched: true, error: null };
    }
    const err = new WorkspaceMismatchError(detected, expected);
    throw err;
}

// ─── Workspace extraction (pure function, testable without CDP) ───────────
//
// Extracts the workspace name from a DOM-like root object by walking
// text nodes. In browser context, pass `document.body`. In unit tests,
// pass a synthetic object with childNodes tree.
//
// Returns: { workspaceName: string | null, confidence: string, matchedText: string | null }
//
function extractWorkspaceInfoFromDocument(root) {
    const WORKSPACE_PATTERN = '的工作空间';
    if (!root) {
        return { workspaceName: null, confidence: 'no_root', matchedText: null };
    }

    // Recursively walk all text nodes in the DOM tree
    const stack = [root];
    while (stack.length > 0) {
        const node = stack.pop();
        if (!node) continue;

        if (node.nodeType === 3) { // TEXT_NODE
            const text = (node.textContent || '').trim();
            if (text.includes(WORKSPACE_PATTERN)) {
                return {
                    workspaceName: text,
                    confidence: 'text_match',
                    matchedText: text,
                };
            }
        }

        // Push children in reverse order for depth-first traversal
        if (node.childNodes) {
            for (let i = node.childNodes.length - 1; i >= 0; i--) {
                stack.push(node.childNodes[i]);
            }
        }
    }

    return { workspaceName: null, confidence: 'not_found', matchedText: null };
}

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
// Workspace enforcement: sjzj030 工作空间有 AI 配额，houwen 工作空间配额已用完
// 强制使用 sjzj030 工作空间进行 L5B-2 测试
//
async function ensureAgentPage(agentUrl = AGENT_URL) {
    const targets = await getTargets();
    let notionTab = targets.find(t => t.type === 'page' && t.url?.includes('notion.so'));

    if (!notionTab) {
        throw new Error('No Notion tab found in Chrome. Open Notion first.');
    }

    // Check workspace: detect via DOM query (NOT tab title)
    // Tab title is extension-injected label (e.g., "[notion-tab-0] Notion AI | Notion")
    // Actual workspace name is in Notion sidebar DOM
    const requiredWorkspaceLower = REQUIRED_WORKSPACE.toLowerCase();
    let currentWorkspace = null;

    try {
        const ws = new WebSocket(notionTab.webSocketDebuggerUrl);
        await new Promise(r => ws.on('open', r));

        // Query DOM for workspace name in sidebar
        const expr = `
            (function() {
                // Strategy 1: Find text nodes containing workspace name pattern
                const walker = document.createTreeWalker(
                    document.body,
                    NodeFilter.SHOW_TEXT,
                    null,
                    false
                );
                
                let node;
                while (node = walker.nextNode()) {
                    const text = node.textContent.trim();
                    if (text.includes('的工作空间')) {
                        return text;
                    }
                }
                
                // Strategy 2: Find elements with white-space:nowrap in sidebar
                const sidebar = document.querySelector('.notion-sidebar');
                if (sidebar) {
                    const divs = sidebar.querySelectorAll('div');
                    for (const div of divs) {
                        const style = window.getComputedStyle(div);
                        if (style.whiteSpace === 'nowrap') {
                            const text = div.textContent?.trim();
                            if (text && text.includes('的工作空间')) {
                                return text;
                            }
                        }
                    }
                }
                
                return null;
            })()
        `;

        const result = await new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(null), 5000);
            const handler = (msg) => {
                const o = JSON.parse(msg);
                if (o.id === 1) {
                    clearTimeout(timeout);
                    ws.removeListener('message', handler);
                    resolve(o?.result?.result?.value);
                }
            };
            ws.on('message', handler);
            ws.send(JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: { expression: expr, returnByValue: true }
            }));
        });

        ws.close();
        currentWorkspace = result;
    } catch (err) {
        console.log(`⚠️  DOM query failed: ${err.message}`);
    }

    // If DOM query failed, fall back to tab title (less reliable but won't break)
    if (!currentWorkspace) {
        console.log('⚠️  Falling back to tab title detection (unreliable)');
        currentWorkspace = notionTab.title || '';
    }

    const isCorrectWorkspace = currentWorkspace.toLowerCase().includes(requiredWorkspaceLower);

    if (!isCorrectWorkspace) {
        throw new Error(
            `❌ Wrong workspace: detected "${currentWorkspace}", required "${REQUIRED_WORKSPACE}".\n` +
            `   Please switch to "${REQUIRED_WORKSPACE}" in Notion sidebar, then re-run.\n` +
            `   (AI quota may be exhausted in the wrong workspace)`
        );
    }

    // Check if already on chat page (agent page has been deprecated, /chat is the new surface)
    if (notionTab.url.includes('/chat') || notionTab.url.includes('/ai')) {
        return {
            tab: notionTab,
            navigated: false,
            url: notionTab.url,
            workspace: REQUIRED_WORKSPACE,
        };
    }

    // Navigate to agent page
    console.log(`⚠️  Tab on ${notionTab.url.slice(0, 60)} — navigating to /agent/ ...`);
    const ws = new WebSocket(notionTab.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));
    ws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: agentUrl } }));
    await sleep(3000);
    ws.close();

    // Reload to trigger content script injection (SPA navigation alone won't inject content scripts)
    console.log('🔄 Reloading page to trigger content script injection...');
    const targets2a = await getTargets();
    const reloadTab = targets2a.find(t => t.type === 'page' && t.url?.includes('notion.so'));
    if (reloadTab) {
        const ws2 = new WebSocket(reloadTab.webSocketDebuggerUrl);
        await new Promise(r => ws2.on('open', r));
        ws2.send(JSON.stringify({ id: 1, method: 'Page.reload', params: { ignoreCache: false } }));
        await sleep(8000);
        ws2.close();
    }

    // Re-fetch to get updated URL/wsUrl
    const targets2 = await getTargets();
    notionTab = targets2.find(t => t.type === 'page' && t.url?.includes('notion.so'));

    if (!notionTab) {
        throw new Error('Notion tab lost after navigation');
    }
    if (!notionTab.url.includes('/chat') && !notionTab.url.includes('/ai')) {
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

module.exports = { resolveExtensionId, ensureAgentPage, preflight, getTargets, sleep, CDP_PORT, AGENT_URL, REQUIRED_WORKSPACE, extractWorkspaceInfoFromDocument, WorkspaceMismatchError, checkWorkspace };
