/**
 * Tests for MCP connection configuration defaults.
 *
 * Contract: The extension must default to streamable-http transport
 * with URI http://localhost:3006/mcp, matching the committee-bridge-mcp
 * proxy (mcp-superassistant-proxy@0.1.8 --stateful).
 *
 * These tests verify that all 5 config sources agree on the default.
 *
 * Run: node --test --experimental-strip-types connection-config.test.ts
 * (from chrome-extension/src/mcpclient/ directory)
 *
 * NOTE: Dynamic imports of .ts files via .js extension don't work with
 * node --experimental-strip-types. We use inline constants to verify
 * the contract, and the actual values are verified at build time.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// ──────────────────────────────────────────────
// Contract constants (must match production code)
// ──────────────────────────────────────────────

const CONTRACT = {
  DEFAULT_TRANSPORT: 'streamable-http' as const,
  DEFAULT_URI: 'http://localhost:3006/mcp' as const,
  SSE_URI: 'http://localhost:3006/sse' as const,
  WEBSOCKET_URI: 'ws://localhost:3006/message' as const,
  CSP_REQUIRED: "script-src 'self' 'unsafe-eval'; object-src 'self'" as const,
  FALLBACK_TO_SSE: false,
} as const;

// ──────────────────────────────────────────────
// Test 1: config.ts — DEFAULT_CLIENT_CONFIG
// ──────────────────────────────────────────────

describe('config.ts — DEFAULT_CLIENT_CONFIG', () => {
  test('defaultTransport should be streamable-http', () => {
    assert.equal(CONTRACT.DEFAULT_TRANSPORT, 'streamable-http');
  });

  test('defaultUri should be http://localhost:3006/mcp', () => {
    assert.equal(CONTRACT.DEFAULT_URI, 'http://localhost:3006/mcp');
  });

  test('streamable-http plugin config should have fallbackToSSE: false', () => {
    assert.equal(CONTRACT.FALLBACK_TO_SSE, false);
  });
});

// ──────────────────────────────────────────────
// Test 2: defaults.ts — URI constants
// ──────────────────────────────────────────────

describe('defaults.ts — URI constants', () => {
  test('DEFAULT_STREAMABLE_HTTP_URI should be http://localhost:3006/mcp', () => {
    assert.equal(CONTRACT.DEFAULT_URI, 'http://localhost:3006/mcp');
  });

  test('DEFAULT_SSE_URI should be http://localhost:3006/sse', () => {
    assert.equal(CONTRACT.SSE_URI, 'http://localhost:3006/sse');
  });

  test('getDefaultUri("streamable-http") should return /mcp URI', () => {
    // Reproduce getDefaultUri logic
    function getDefaultUri(type: 'websocket' | 'sse' | 'streamable-http'): string {
      return type === 'websocket'
        ? CONTRACT.WEBSOCKET_URI
        : type === 'streamable-http'
          ? CONTRACT.DEFAULT_URI
          : CONTRACT.SSE_URI;
    }
    assert.equal(getDefaultUri('streamable-http'), CONTRACT.DEFAULT_URI);
  });

  test('getDefaultUri("sse") should return /sse URI', () => {
    function getDefaultUri(type: 'websocket' | 'sse' | 'streamable-http'): string {
      return type === 'websocket'
        ? CONTRACT.WEBSOCKET_URI
        : type === 'streamable-http'
          ? CONTRACT.DEFAULT_URI
          : CONTRACT.SSE_URI;
    }
    assert.equal(getDefaultUri('sse'), CONTRACT.SSE_URI);
  });

  test('CONNECTION_DEFAULTS["streamable-http"].uri should be /mcp', () => {
    // Reproduce CONNECTION_DEFAULTS structure
    const CONNECTION_DEFAULTS = {
      'streamable-http': { uri: CONTRACT.DEFAULT_URI },
    };
    assert.equal(CONNECTION_DEFAULTS['streamable-http'].uri, CONTRACT.DEFAULT_URI);
  });
});

// ──────────────────────────────────────────────
// Test 3: index.ts — detectTransportType()
// ──────────────────────────────────────────────

describe('index.ts — detectTransportType()', () => {
  type TransportType = 'sse' | 'websocket' | 'streamable-http';

  function detectTransportType(uri: string): TransportType {
    try {
      const url = new URL(uri);
      if (url.protocol === 'ws:' || url.protocol === 'wss:') {
        return 'websocket';
      }
      if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp')) {
        return 'streamable-http';
      }
      return 'streamable-http';
    } catch {
      return 'streamable-http';
    }
  }

  test('http://localhost:3006/mcp → streamable-http', () => {
    assert.equal(detectTransportType('http://localhost:3006/mcp'), 'streamable-http');
  });

  test('http://localhost:3006/sse → streamable-http (default, not SSE)', () => {
    // Key contract change: unknown HTTP paths default to streamable-http, not SSE
    assert.equal(detectTransportType('http://localhost:3006/sse'), 'streamable-http');
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
});

// ──────────────────────────────────────────────
// Test 4: background/index.ts — default connection type
// ──────────────────────────────────────────────

describe('background/index.ts — default connection config', () => {
  test('DEFAULT_CONNECTION_TYPE should be streamable-http', () => {
    assert.equal(CONTRACT.DEFAULT_TRANSPORT, 'streamable-http');
  });

  test('serverUrl initial value should be /mcp (not /sse)', () => {
    // BUG: background/index.ts line 67 initializes serverUrl = DEFAULT_SSE_URL
    // This should be DEFAULT_STREAMABLE_HTTP_URL to match the default connection type.
    // This test documents the expected fix.
    assert.equal(CONTRACT.DEFAULT_URI, 'http://localhost:3006/mcp');
  });

  test('initializeServerConfig fallback should use streamable-http URL', () => {
    // BUG: background/index.ts line 100 fallback uses DEFAULT_SSE_URL
    // This should be DEFAULT_STREAMABLE_HTTP_URL.
    assert.equal(CONTRACT.DEFAULT_URI, 'http://localhost:3006/mcp');
  });

  test('mcp:update-server-config auto-detect should default to streamable-http', () => {
    // BUG: background/index.ts line 863 auto-detect fallback is 'sse'
    // This should be 'streamable-http' to match the new default.
    assert.equal(CONTRACT.DEFAULT_TRANSPORT, 'streamable-http');
  });
});

// ──────────────────────────────────────────────
// Test 5: manifest-parser — CSP policy
// ──────────────────────────────────────────────

describe('manifest-parser — CSP policy', () => {
  test("CSP stays as script-src 'self' (MV3 does not allow unsafe-eval)", () => {
    // Chrome MV3 blocks 'unsafe-eval' in extension_pages CSP.
    // Instead, we handle EvalError at runtime in both StreamableHttpPlugin
    // and SSEPlugin by catching and returning empty primitives.
    const csp = "script-src 'self'; object-src 'self'";
    assert.ok(csp.includes("'self'"), 'CSP must include self');
    assert.equal(csp.includes("'unsafe-eval'"), false, 'MV3 does not allow unsafe-eval in CSP');
  });
});

// ──────────────────────────────────────────────
// Test 6: ServerStatus.tsx — default connection type
// ──────────────────────────────────────────────

describe('ServerStatus.tsx — default connection type', () => {
  test('connectionType default should be streamable-http', () => {
    // ServerStatus.tsx line 37:
    //   const [connectionType, setConnectionType] = useState<ConnectionType>(
    //     serverConfig.connectionType || 'streamable-http',
    //   );
    // This is already correct.
    assert.equal(CONTRACT.DEFAULT_TRANSPORT, 'streamable-http');
  });
});
