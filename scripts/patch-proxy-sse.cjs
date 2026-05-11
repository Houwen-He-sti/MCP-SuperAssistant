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

if (!fs.existsSync(TARGET)) {
  console.error('[patch-proxy-sse] Target file not found:', TARGET);
  console.error('[patch-proxy-sse] Run "npm install" first to set up packages/proxy.');
  process.exit(1);
}

const src = fs.readFileSync(TARGET, 'utf8');

// Check if already patched (per-connection pattern has cleanupSession)
if (src.includes('cleanupSession')) {
  console.log('[patch-proxy-sse] Already patched — skipping.');
  process.exit(0);
}

// Verify the original pattern exists
const MODULE_LEVEL_SERVER = /const server = new Server\([^)]+\).*\n\s*const sessions/;
if (!MODULE_LEVEL_SERVER.test(src)) {
  console.error('[patch-proxy-sse] Cannot find module-level Server pattern. File may have changed.');
  process.exit(1);
}

let patched = src;

// 1. Remove module-level `const server = new Server(...)`
patched = patched.replace(
  /^\s*const server = new Server\(\{[^}]+\},\s*\{[^}]+\}\);\n/m,
  ''
);

// 2. Replace the SSE GET handler
const ORIGINAL_HANDLER = /app\.get\(ssePath, async \(req, res\) => \{[\s\S]*?sseTransport\.onerror[\s\S]*?req\.on\('close'[\s\S]*?\}\);\n\s*\}\);/;

const FIXED_HANDLER = `app.get(ssePath, async (req, res) => {
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
            logger.error(\`Failed to connect server for session \${sessionId}:\`, err);
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

if (ORIGINAL_HANDLER.test(patched)) {
  patched = patched.replace(ORIGINAL_HANDLER, FIXED_HANDLER);
} else {
  console.error('[patch-proxy-sse] Cannot find original SSE handler pattern.');
  console.error('[patch-proxy-sse] The file may already be partially patched or have changed.');
  process.exit(1);
}

fs.writeFileSync(TARGET, patched, 'utf8');
console.log('[patch-proxy-sse] Successfully patched', TARGET);
console.log('[patch-proxy-sse] Per-connection Server instances enabled.');
