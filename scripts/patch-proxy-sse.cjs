#!/usr/bin/env node
/**
 * patch-proxy-sse.cjs
 *
 * Patches packages/proxy/dist/gateways/stdioToSse.js to use per-connection
 * Server instances instead of a single shared Server.
 *
 * Problem: The original code creates one Server at module level. When a second
 * SSE connection arrives (browser tab reconnect, extension reload), server.connect()
 * throws "Already connected to a transport" and crashes the proxy.
 *
 * Fix: Move `new Server()` inside the GET /sse handler so each connection gets
 * its own Server instance with idempotent cleanup.
 *
 * Usage: node scripts/patch-proxy-sse.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TARGET = path.join(__dirname, '..', 'packages', 'proxy', 'dist', 'gateways', 'stdioToSse.js');
// Unique marker to detect if patch has been applied
const PATCH_MARKER = '/* PATCHED: per-connection-server */';

if (!fs.existsSync(TARGET)) {
  console.error('[patch-proxy-sse] Target file not found:', TARGET);
  console.error('[patch-proxy-sse] Run "npm install" first to set up packages/proxy.');
  process.exit(1);
}

const src = fs.readFileSync(TARGET, 'utf8');

// ── Idempotency check ────────────────────────────────────────────────
if (src.includes(PATCH_MARKER) || (src.includes('cleanupSession') && !src.includes('sseTransport.onerror'))) {
  console.log('[patch-proxy-sse] Already patched — skipping.');
  process.exit(0);
}

// ── Verify original patterns exist ──────────────────────────────────
// Match module-level Server line (handles nested braces like { capabilities: {} })
const MODULE_LEVEL_SERVER_LINE = /^(\s*)const server = new Server\(.+\);\s*$/m;
if (!MODULE_LEVEL_SERVER_LINE.test(src)) {
  console.error('[patch-proxy-sse] Cannot find module-level "const server = new Server(...)" line.');
  console.error('[patch-proxy-sse] File may have changed or already been patched without marker.');
  process.exit(1);
}

// Verify original handler has the single-server pattern (transport-level callbacks)
if (!src.includes('sseTransport.onerror')) {
  console.error('[patch-proxy-sse] Cannot find original SSE handler pattern (sseTransport.onerror).');
  process.exit(1);
}

let patched = src;

// ── Step 1: Remove module-level `const server = new Server(...)` ────
patched = patched.replace(MODULE_LEVEL_SERVER_LINE, '');
// Verify removal succeeded
if (patched === src) {
  console.error('[patch-proxy-sse] Failed to remove module-level Server line.');
  process.exit(1);
}

// ── Step 2: Replace the SSE GET handler ─────────────────────────────
// Match from app.get(ssePath...) to the closing of the handler (before app.post)
const ORIGINAL_HANDLER = /app\.get\(ssePath, async \(req, res\) => \{[\s\S]*?sseTransport\.onerror[\s\S]*?req\.on\('close'[\s\S]*?\}\);\n\s*\}\);/;

const FIXED_HANDLER = `${PATCH_MARKER}
    app.get(ssePath, async (req, res) => {
        logger.info(\`New SSE connection from \${req.ip}\`);
        setResponseHeaders({
            res,
            headers,
        });
        const server = new Server({ name: 'mcp-superassistant-proxy', version: getVersion() }, { capabilities: {} });
        const sseTransport = new SSEServerTransport(\`\${baseUrl}\${messagePath}\`, res);
        const sessionId = sseTransport.sessionId;
        let closed = false;
        const cleanupSession = async (reason) => {
            if (closed) return;
            closed = true;
            logger.info(\`Cleaning up SSE session \${sessionId}: \${reason}\`);
            delete sessions[sessionId];
            try { await server.close(); } catch (err) { logger.error(\`Error closing server for session \${sessionId}:\`, err); }
        };
        server.onclose = () => void cleanupSession('server.close');
        server.onerror = (err) => { logger.error(\`Server error (session \${sessionId}):\`, err); void cleanupSession('server.error'); };
        req.on('close', () => void cleanupSession('req.close'));
        res.on('error', (err) => { logger.error(\`Response error (session \${sessionId}):\`, err); void cleanupSession('res.error'); });
        try {
            await server.connect(sseTransport);
        } catch (err) {
            logger.error(\`Failed to connect server for session \${sessionId} (headersSent=\${res.headersSent}):\`, err);
            await cleanupSession('connect.failed');
            if (!res.headersSent) res.status(500).end('Server connect failed');
            return;
        }
        if (sessionId) {
            sessions[sessionId] = { transport: sseTransport, server, response: res };
        }
        sseTransport.onmessage = (msg) => {
            logger.info(\`SSE → Child (session \${sessionId}): \${JSON.stringify(msg)}\`);
            child.stdin.write(JSON.stringify(msg) + '\\n');
        };
    });`;

if (!ORIGINAL_HANDLER.test(patched)) {
  console.error('[patch-proxy-sse] Cannot find original SSE handler block after step 1.');
  console.error('[patch-proxy-sse] Aborting — file NOT modified (step 1 was in-memory only).');
  process.exit(1);
}

patched = patched.replace(ORIGINAL_HANDLER, FIXED_HANDLER);

// ── Post-patch verification ─────────────────────────────────────────
const checks = [
  [PATCH_MARKER, 'patch marker'],
  ['cleanupSession', 'cleanup function'],
  ['server.onclose', 'server lifecycle callback'],
  ['await server.connect(sseTransport)', 'server.connect in handler'],
];
const failures = checks.filter(([pattern]) => !patched.includes(pattern));
if (failures.length > 0) {
  console.error('[patch-proxy-sse] Post-patch verification FAILED:');
  for (const [, label] of failures) {
    console.error('  - Missing: ' + label);
  }
  console.error('[patch-proxy-sse] File NOT written.');
  process.exit(1);
}

// Verify module-level Server is gone
if (MODULE_LEVEL_SERVER_LINE.test(patched)) {
  console.error('[patch-proxy-sse] Post-patch verification FAILED: module-level Server still present.');
  process.exit(1);
}

// Verify original transport-level callbacks are gone
if (patched.includes('sseTransport.onerror')) {
  console.error('[patch-proxy-sse] Post-patch verification FAILED: old sseTransport.onerror still present.');
  process.exit(1);
}

fs.writeFileSync(TARGET, patched, 'utf8');
console.log('[patch-proxy-sse] Successfully patched', TARGET);
console.log('[patch-proxy-sse] Per-connection Server instances enabled.');
