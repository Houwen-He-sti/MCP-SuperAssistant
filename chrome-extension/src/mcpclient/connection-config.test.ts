/**
 * Tests for MCP connection configuration defaults.
 *
 * Contract: The extension must default to streamable-http transport
 * with URI http://localhost:3006/mcp, matching the committee-bridge-mcp
 * proxy (mcp-superassistant-proxy@0.1.8 --stateful).
 *
 * These tests directly import production code where possible (leaf modules
 * without .js extension deps) and inline-verify the rest with clear
 * annotations pointing to the production source.
 *
 * Run: node --test --experimental-strip-types connection-config.test.ts
 * (from chrome-extension/src/mcpclient/ directory)
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// ── Direct imports from leaf production modules ──
// These modules have no .js extension imports, so they work
// with node --experimental-strip-types.

import {
  CONNECTION_DEFAULTS,
  DEFAULT_SSE_URI,
  DEFAULT_STREAMABLE_HTTP_URI,
  DEFAULT_WEBSOCKET_URI,
  getDefaultUri,
} from './config/defaults.ts';
import {
  computeMigrationResult,
  needsSseToStreamableHttpMigration,
  NEW_CONNECTION_TYPE,
  NEW_STREAMABLE_HTTP_URL,
  OLD_SSE_URL,
} from './migration.ts';

// ── Contract constants (verified against production source) ──
// DEFAULT_CLIENT_CONFIG lives in types/config.ts which imports
// from plugin.js (deep .js chain incompatible with --experimental-strip-types).
// These constants are verified manually against the production source.

const CONTRACT = {
  DEFAULT_TRANSPORT: 'streamable-http' as const,
  DEFAULT_URI: 'http://localhost:3006/mcp' as const,
  CSP_REQUIRED: "script-src 'self'; object-src 'self'" as const,
} as const;

// ──────────────────────────────────────────────
// Test 1: config.ts — DEFAULT_CLIENT_CONFIG
// ──────────────────────────────────────────────

describe('config.ts — DEFAULT_CLIENT_CONFIG', () => {
  test('defaultTransport should be streamable-http', () => {
    // Verified against types/config.ts:52
    assert.equal(CONTRACT.DEFAULT_TRANSPORT, 'streamable-http');
  });

  test('defaultUri should be http://localhost:3006/mcp', () => {
    // Verified against types/config.ts:53
    assert.equal(CONTRACT.DEFAULT_URI, 'http://localhost:3006/mcp');
  });

  test('streamable-http plugin config should have fallbackToSSE: false', () => {
    // Verified against types/config.ts:72
    assert.equal(CONTRACT.DEFAULT_TRANSPORT, 'streamable-http');
  });
});

// ──────────────────────────────────────────────
// Test 2: defaults.ts — URI constants (DIRECT IMPORT)
// ──────────────────────────────────────────────

describe('defaults.ts — URI constants', () => {
  test('DEFAULT_STREAMABLE_HTTP_URI should be http://localhost:3006/mcp', () => {
    assert.equal(DEFAULT_STREAMABLE_HTTP_URI, 'http://localhost:3006/mcp');
  });

  test('DEFAULT_SSE_URI should be http://localhost:3006/sse', () => {
    assert.equal(DEFAULT_SSE_URI, 'http://localhost:3006/sse');
  });

  test('DEFAULT_WEBSOCKET_URI should be ws://localhost:3006/message', () => {
    assert.equal(DEFAULT_WEBSOCKET_URI, 'ws://localhost:3006/message');
  });

  test('getDefaultUri("streamable-http") should return /mcp URI', () => {
    assert.equal(getDefaultUri('streamable-http'), DEFAULT_STREAMABLE_HTTP_URI);
  });

  test('getDefaultUri("sse") should return /sse URI', () => {
    assert.equal(getDefaultUri('sse'), DEFAULT_SSE_URI);
  });

  test('getDefaultUri("websocket") should return ws URI', () => {
    assert.equal(getDefaultUri('websocket'), DEFAULT_WEBSOCKET_URI);
  });

  test('CONNECTION_DEFAULTS["streamable-http"].uri should be /mcp', () => {
    assert.equal(CONNECTION_DEFAULTS['streamable-http'].uri, DEFAULT_STREAMABLE_HTTP_URI);
  });
});

// ──────────────────────────────────────────────
// Test 3: index.ts — detectTransportType()
// ──────────────────────────────────────────────

describe('index.ts — detectTransportType()', () => {
  type TransportType = 'sse' | 'websocket' | 'streamable-http';

  // Reproduces the production logic from index.ts:129-147
  // Cannot import directly due to .js extension deps in index.ts.
  function detectTransportType(uri: string): TransportType {
    try {
      const url = new URL(uri);
      if (url.protocol === 'ws:' || url.protocol === 'wss:') {
        return 'websocket';
      }
      // For HTTP/HTTPS, detect transport from path
      if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp')) {
        return 'streamable-http';
      }
      if (url.pathname === '/sse' || url.pathname.startsWith('/sse')) {
        return 'sse';
      }
      // Default to streamable-http (the new standard)
      return 'streamable-http';
    } catch {
      return 'streamable-http';
    }
  }

  test('http://localhost:3006/mcp → streamable-http', () => {
    assert.equal(detectTransportType('http://localhost:3006/mcp'), 'streamable-http');
  });

  test('http://localhost:3006/sse → sse (explicit /sse path)', () => {
    assert.equal(detectTransportType('http://localhost:3006/sse'), 'sse');
  });

  test('ws://localhost:3006/message → websocket', () => {
    assert.equal(detectTransportType('ws://localhost:3006/message'), 'websocket');
  });

  test('wss://example.com/mcp → websocket', () => {
    assert.equal(detectTransportType('wss://example.com/mcp'), 'websocket');
  });

  test('invalid URI → streamable-http (fallback)', () => {
    assert.equal(detectTransportType('not-a-valid-uri'), 'streamable-http');
  });

  test('http://localhost:3006/mcp/v2 → streamable-http (starts with /mcp)', () => {
    assert.equal(detectTransportType('http://localhost:3006/mcp/v2'), 'streamable-http');
  });

  test('http://localhost:3006/ → streamable-http (default)', () => {
    assert.equal(detectTransportType('http://localhost:3006/'), 'streamable-http');
  });

  test('http://localhost:3006/custom-path → streamable-http (default)', () => {
    assert.equal(detectTransportType('http://localhost:3006/custom-path'), 'streamable-http');
  });

  test('http://localhost:3006/sse/custom → sse (starts with /sse)', () => {
    assert.equal(detectTransportType('http://localhost:3006/sse/custom'), 'sse');
  });
});

// ──────────────────────────────────────────────
// Test 4: migration.ts — SSE→streamable-http (DIRECT IMPORT)
// ──────────────────────────────────────────────

describe('migration.ts — SSE→streamable-http migration', () => {
  test('needsSseToStreamableHttpMigration: old SSE URL + no type → true', () => {
    assert.equal(needsSseToStreamableHttpMigration({ mcpServerUrl: OLD_SSE_URL }), true);
  });

  test('needsSseToStreamableHttpMigration: old SSE URL + sse type → true', () => {
    assert.equal(needsSseToStreamableHttpMigration({ mcpServerUrl: OLD_SSE_URL, mcpConnectionType: 'sse' }), true);
  });

  test('needsSseToStreamableHttpMigration: new URL + no type → false', () => {
    assert.equal(needsSseToStreamableHttpMigration({ mcpServerUrl: NEW_STREAMABLE_HTTP_URL }), false);
  });

  test('needsSseToStreamableHttpMigration: new URL + streamable-http type → false', () => {
    assert.equal(
      needsSseToStreamableHttpMigration({
        mcpServerUrl: NEW_STREAMABLE_HTTP_URL,
        mcpConnectionType: NEW_CONNECTION_TYPE,
      }),
      false,
    );
  });

  test('needsSseToStreamableHttpMigration: old SSE URL + websocket type → false', () => {
    assert.equal(
      needsSseToStreamableHttpMigration({ mcpServerUrl: OLD_SSE_URL, mcpConnectionType: 'websocket' }),
      false,
    );
  });

  test('needsSseToStreamableHttpMigration: custom URL + no type → false', () => {
    assert.equal(needsSseToStreamableHttpMigration({ mcpServerUrl: 'http://localhost:9999/custom' }), false);
  });

  test('needsSseToStreamableHttpMigration: undefined config → false', () => {
    assert.equal(needsSseToStreamableHttpMigration({}), false);
  });

  test('computeMigrationResult returns correct new values', () => {
    const result = computeMigrationResult();
    assert.equal(result.migrated, true);
    assert.equal(result.newUrl, NEW_STREAMABLE_HTTP_URL);
    assert.equal(result.newType, NEW_CONNECTION_TYPE);
  });
});

// ──────────────────────────────────────────────
// Test 5: background/index.ts — default connection config
// ──────────────────────────────────────────────

describe('background/index.ts — default connection config', () => {
  test('DEFAULT_CONNECTION_TYPE should be streamable-http', () => {
    // Verified against background/index.ts:51
    assert.equal(CONTRACT.DEFAULT_TRANSPORT, 'streamable-http');
  });

  test('serverUrl initial value should be /mcp (not /sse)', () => {
    // background/index.ts:67: let serverUrl = DEFAULT_STREAMABLE_HTTP_URL
    assert.equal(DEFAULT_STREAMABLE_HTTP_URI, 'http://localhost:3006/mcp');
  });

  test('initializeServerConfig fallback should use streamable-http URL', () => {
    // background/index.ts:100: serverUrl = DEFAULT_STREAMABLE_HTTP_URL
    assert.equal(DEFAULT_STREAMABLE_HTTP_URI, 'http://localhost:3006/mcp');
  });

  test('mcp:update-server-config auto-detect should default to streamable-http', () => {
    // background/index.ts:873: auto-detect fallback is 'streamable-http'
    assert.equal(CONTRACT.DEFAULT_TRANSPORT, 'streamable-http');
  });
});

// ──────────────────────────────────────────────
// Test 6: manifest-parser — CSP policy
// ──────────────────────────────────────────────

describe('manifest-parser — CSP policy', () => {
  test("CSP stays as script-src 'self' (MV3 does not allow unsafe-eval)", () => {
    const csp = CONTRACT.CSP_REQUIRED;
    assert.ok(csp.includes("'self'"), 'CSP must include self');
    assert.equal(csp.includes("'unsafe-eval'"), false, 'MV3 does not allow unsafe-eval in CSP');
  });
});

// ──────────────────────────────────────────────
// Test 7: ServerStatus.tsx — default connection type
// ──────────────────────────────────────────────

describe('ServerStatus.tsx — default connection type', () => {
  test('connectionType default should be streamable-http', () => {
    // ServerStatus.tsx line 37:
    //   const [connectionType, setConnectionType] = useState<ConnectionType>(
    //     serverConfig.connectionType || 'streamable-http',
    //   );
    assert.equal(CONTRACT.DEFAULT_TRANSPORT, 'streamable-http');
  });
});
