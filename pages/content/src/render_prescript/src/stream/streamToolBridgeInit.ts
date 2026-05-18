/**
 * Phase 3: Stream Tool Bridge Initialization
 *
 * Wires the bridge to real MAIN-world dependencies and subscribes to stream events.
 * Called once during render_prescript initialization.
 */

import { executionGuardStore, reserveExecution } from '../mcpexecute/executionGuard';
import { generateContentSignature, storeExecutedFunction } from '../mcpexecute/storage';
import { createAckTracker, type AckTracker } from './ackTracker';
import { extractIdentityFromJsonlBlock } from './functionCallScanner';
import { onStreamEvent as onStreamEventIsolated } from './interceptor';
import { installMainWorldStreamBridge, onStreamEvent as onStreamEventBridge, sendConfigToMainWorld } from './interceptorBridge';
import {
  createStreamToolHandler,
  getAdapterDiagnostic,
  type AdapterLike,
  type AdapterStatus,
  type BridgeEvent,
  type McpClientLike,
  type StreamToolBridgeConfig,
} from './streamToolBridge';
import { normalizeToUiEvent } from './toolLoopUiEvents';
import type { StreamEvent } from './types';

/**
 * Full init config: extends handler config with cutoff activation flag.
 * `cutoffEnabled` controls MAIN world stream_cutoff emission (independent of execution).
 */
export interface StreamToolBridgeInitConfig extends StreamToolBridgeConfig {
  cutoffEnabled: boolean;
}

/**
 * Determine if we're on a Notion page.
 * On Notion, stream events come from MAIN world via the bridge.
 * On other providers, they come from the ISOLATED world interceptor.
 */
function isNotionHost(): boolean {
  return typeof window !== 'undefined' && window.location.hostname.includes('notion.so');
}

// --- Default config ---
const DEFAULT_CONFIG: StreamToolBridgeInitConfig = {
  enabled: false,           // MCP tool execution — disabled until Gate 3
  cutoffEnabled: false,     // Disabled: cutoff path doesn't handle consumer abandonment (SPA nav)
  autoInsert: true,
  autoSubmit: false,        // safety: human confirms before sending function_result
  toolTimeoutMs: 30_000,
};

let currentConfig: StreamToolBridgeInitConfig = { ...DEFAULT_CONFIG };
let bridgeHandler: ((event: unknown) => Promise<void>) | null = null;
let unsubscribe: (() => void) | null = null;
let unsubscribeTextScan: (() => void) | null = null;
let ackTrackerInstance: AckTracker | null = null;
/** StreamId of the last bridge handoff — text scan skips this stream (GPT P1-4). */
let lastHandoffStreamId: string | null = null;
/** Last model ACK event for diagnostic observability (GPT P1-2/P1-7). */
let lastModelAckEvent: import('./ackTracker').ModelAckEvent | null = null;

/** Default ACK timeout (ms) — how long to wait for model to echo nonce. */
const ACK_TIMEOUT_MS = 30_000;

/**
 * Resolve the current adapter from MAIN-world globals.
 * Priority: pluginRegistry → mcpAdapter → window.getCurrentAdapter
 */
function resolveCurrentAdapter(): AdapterLike | null {
  const win = window as Record<string, unknown>;

  // 1. pluginRegistry path
  const registry = win.pluginRegistry as { getActivePlugin?: () => Record<string, unknown> | null } | undefined;
  if (registry?.getActivePlugin) {
    const plugin = registry.getActivePlugin();
    if (plugin) {
      // 1a. plugin.adapter property (legacy shape)
      const nested = plugin.adapter as AdapterLike | undefined;
      if (nested && typeof nested.insertText === 'function') return nested;
      // 1b. plugin IS the adapter (BaseAdapterPlugin pattern)
      if (typeof plugin.insertText === 'function') return plugin as unknown as AdapterLike;
    }
  }

  // 2. mcpAdapter global
  const mcpAdapter = win.mcpAdapter as AdapterLike | undefined;
  if (mcpAdapter && typeof mcpAdapter.insertText === 'function') return mcpAdapter;

  // 3. window.getCurrentAdapter fallback
  const getAdapter = win.getCurrentAdapter as (() => AdapterLike | null) | undefined;
  if (typeof getAdapter === 'function') return getAdapter();

  return null;
}

/**
 * Resolve mcpClient from MAIN-world global (lazy per-event).
 * window.mcpClient is set by content/src/index.ts during initialization.
 */
function resolveMcpClient(): McpClientLike | null {
  const win = window as Record<string, unknown>;
  const client = win.mcpClient as {
    callTool?: (name: string, params: Record<string, unknown>) => Promise<unknown>;
    isReady?: () => boolean;
  } | undefined;

  if (client && typeof client.callTool === 'function' && typeof client.isReady === 'function') {
    return client as McpClientLike;
  }
  return null;
}

/**
 * Initialize the stream tool bridge and subscribe to stream events.
 * Safe to call multiple times — resubscribes with latest config.
 */
export function initStreamToolBridge(config?: Partial<StreamToolBridgeInitConfig>): void {
  if (config) {
    currentConfig = { ...currentConfig, ...config };
  }

  // Unsubscribe previous handler if any
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }

  // Unsubscribe previous text scan listener if any
  if (unsubscribeTextScan) {
    unsubscribeTextScan();
    unsubscribeTextScan = null;
  }

  // Reset handoff stream tracking
  lastHandoffStreamId = null;
  lastModelAckEvent = null;

  // Dispose previous ackTracker if any (clears pending timeouts)
  if (ackTrackerInstance) {
    ackTrackerInstance.dispose();
    ackTrackerInstance = null;
  }

  // Create ACK tracker for cross-turn nonce tracking (Gate 5c.1)
  ackTrackerInstance = createAckTracker({
    timeoutMs: ACK_TIMEOUT_MS,
    onEvent: (event) => {
      const level = event.type === 'model_ack_timeout' ? 'warn' : 'debug';
      console[level]('[AckTracker]', event.type, event.nonce, event.functionName);

      // Store for diagnostic polling (getStreamToolBridgeInfo)
      lastModelAckEvent = event;

      // Dispatch CustomEvent for E2E observability (GPT P1-2)
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('mcp-superassistant:model-ack', {
          detail: { type: event.type, nonce: event.nonce, callId: event.callId, functionName: event.functionName, latencyMs: event.latencyMs },
        }));

        // Gate 6B: Also dispatch normalized UI event for content script consumption
        const uiEvent = normalizeToUiEvent(event);
        if (uiEvent) {
          window.dispatchEvent(new CustomEvent('mcp-superassistant:tool-loop-event', { detail: uiEvent }));
        }
      }
    },
  });

  // Create handler with direct module imports for guard/storage,
  // lazy resolution for mcpClient and adapter (may not be available at init time)
  bridgeHandler = createStreamToolHandler({
    config: currentConfig,
    mcpClient: resolveMcpClient,
    guard: {
      reserveExecution,
      executionGuardStore,
    },
    adapter: resolveCurrentAdapter,
    storage: {
      storeExecutedFunction,
      generateContentSignature,
    },
    ackTracker: ackTrackerInstance,
    onEvent: (event: BridgeEvent) => {
      // Log bridge events to console for observability
      if (event.type === 'bridge_handoff_ack') {
        // Track the stream that triggered handoff — text scan skips this stream
        lastHandoffStreamId = event.streamId;
        console.debug('[StreamToolBridge]', 'bridge_handoff_ack', event.nonce, event.functionName);
      } else {
        const level = event.status === 'failed' ? 'warn' : 'debug';
        console[level]('[StreamToolBridge]', event.status, event.phase || '', event.errorCode || '');
      }

      // Gate 6B: Dispatch normalized UI event via CustomEvent for content script consumption
      if (typeof window !== 'undefined') {
        const uiEvent = normalizeToUiEvent(event);
        if (uiEvent) {
          window.dispatchEvent(new CustomEvent('mcp-superassistant:tool-loop-event', { detail: uiEvent }));
        }
      }
    },
  });

  // Subscribe to stream events — use bridge for Notion, isolated interceptor for others
  if (isNotionHost()) {
    // Install the MAIN world bridge listener if not already done
    installMainWorldStreamBridge();
    // Send cutoff config to MAIN world (independent of execution enabled)
    // Gate 5d: enable stream_chunk_text emission for ACK scanning
    sendConfigToMainWorld({
      enabled: currentConfig.cutoffEnabled,
      mode: undefined, // cutoff mode managed by bridge config, not tool bridge
      requireStructuredIdentity: false, // Gate 5d: Notion NDJSON patches never produce standard function_call JSON,
                                        // so MAIN world cutoff must fire without structured identity.
                                        // Downstream handler still validates identity independently.
      emitChunkText: true,
    });
    unsubscribe = onStreamEventBridge(bridgeHandler);
  } else {
    unsubscribe = onStreamEventIsolated(bridgeHandler);
  }

  // Gate 5d: Register text scan listener for ACK nonce detection
  // Scans stream_chunk_text events for pending nonces in raw NDJSON text.
  // Skips the handoff stream (same-stream echo) per GPT P1-4.
  const textScanHandler = (event: StreamEvent): void => {
    if (event.type !== 'stream_chunk_text') return;
    if (!ackTrackerInstance || ackTrackerInstance.getPendingCount() === 0) return;
    // Skip scanning the same stream that triggered the handoff
    if (event.streamId === lastHandoffStreamId) return;
    ackTrackerInstance.scanRawText(event.text);
  };

  if (isNotionHost()) {
    unsubscribeTextScan = onStreamEventBridge(textScanHandler);
  } else {
    unsubscribeTextScan = onStreamEventIsolated(textScanHandler);
  }

  // Set up window.mcpNotionDomScan bridge for DOM-triggered tool scanning.
  // notion.adapter.ts calls window.mcpNotionDomScan.scan(text) for each new Notion AI message.
  // P1-1: ownership contract includes version, scan, teardown.
  if (typeof window !== 'undefined') {
    const domScanner: McpNotionDomScanner = {
      version: '1',
      scan: scanDomMessage,
      teardown(): void {
        delete (window as unknown as Record<string, unknown>).mcpNotionDomScan;
      },
    };
    (window as unknown as Record<string, unknown>).mcpNotionDomScan = domScanner;
  }
}

/**
 * Update bridge configuration at runtime.
 */
export function configureStreamToolBridge(config: Partial<StreamToolBridgeInitConfig>): void {
  currentConfig = { ...currentConfig, ...config };
  // Re-initialize with new config
  initStreamToolBridge();
}

/**
 * Preflight diagnostic — reports whether all dependencies are ready for tool execution.
 * Call from devtools console (ISOLATED world context) to check before E2E testing.
 */
export function getStreamToolBridgeInfo(): {
  config: StreamToolBridgeInitConfig;
  isNotionHost: boolean;
  bridgeHandlerReady: boolean;
  subscribed: boolean;
  mcpClientAvailable: boolean;
  mcpClientReady: boolean;
  adapterAvailable: boolean;
  adapterStatus: AdapterStatus;
  inputEmpty: boolean | null;
  inputTextLength: number | null;
  ackTrackerActive: boolean;
  ackPendingCount: number;
  lastModelAckEvent: import('./ackTracker').ModelAckEvent | null;
} {
  const mcpClient = resolveMcpClient();
  const currentAdapter = resolveCurrentAdapter();
  const adapterDiag = getAdapterDiagnostic(currentAdapter);
  return {
    config: { ...currentConfig },
    isNotionHost: isNotionHost(),
    bridgeHandlerReady: bridgeHandler !== null,
    subscribed: unsubscribe !== null,
    mcpClientAvailable: mcpClient !== null,
    mcpClientReady: mcpClient !== null && mcpClient.isReady(),
    ...adapterDiag,
    ackTrackerActive: ackTrackerInstance !== null,
    ackPendingCount: ackTrackerInstance?.getPendingCount() ?? 0,
    lastModelAckEvent: lastModelAckEvent ? { ...lastModelAckEvent } : null,
  };
}

// ============================================================================
// DOM Trigger — window.mcpNotionDomScan bridge
// ============================================================================

/**
 * Window bridge interface for DOM-triggered tool scanning.
 *
 * Set on window after initStreamToolBridge() to allow notion.adapter.ts
 * (content-script world) to call scan() for each new Notion AI message.
 *
 * P1-1 (GPT review): ownership contract — includes version, scan, teardown.
 */
export interface McpNotionDomScanner {
  version: string;
  scan(text: string): void;
  teardown(): void;
}

/**
 * Extract content from fenced ```jsonl code blocks in markdown text.
 *
 * P0-2 (GPT review): DOM text ≠ raw NDJSON stream.
 * Only scan content inside fenced ```jsonl blocks, not raw textContent.
 *
 * @param text - Full DOM element text content
 * @returns Array of block contents (without the fences)
 */
function extractJsonlFencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  const fencePattern = /```jsonl\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(text)) !== null) {
    if (match[1]) blocks.push(match[1]);
  }
  return blocks;
}

/**
 * Scan a DOM message element's text for:
 * 1. ACK nonces via ackTracker.scanText() — uses full text (ACK tags can appear anywhere)
 * 2. JSONL function_call blocks inside fenced ```jsonl blocks → dispatch ToolInvocationEvent
 *
 * Called from notion.adapter.ts setupMessageObserver() on each new Notion AI message.
 *
 * P1-2 (GPT review): Uses CustomEvent 'mcp-superassistant:dom-tool-invocation'
 * (NOT synthetic StreamEvent — this is a transport-agnostic semantic trigger).
 *
 * No-op if bridge is not initialized.
 */
export function scanDomMessage(text: string): void {
  // 1. ACK scanning — full text (ACK tags can appear anywhere in the message)
  ackTrackerInstance?.scanText(text);

  // 2. Function call detection — fenced ```jsonl blocks only (P0-2 canonicalization)
  const blocks = extractJsonlFencedBlocks(text);
  for (const block of blocks) {
    const identity = extractIdentityFromJsonlBlock(block);
    if (identity?.name) {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('mcp-superassistant:dom-tool-invocation', {
          detail: identity,
        }));
      }
    }
  }
}

/**
 * Test-only accessor for the current ackTracker instance.
 * Allows tests to register pending nonces before calling scanDomMessage().
 *
 * @internal — do not use in production code paths
 */
export function _getAckTrackerForTest(): AckTracker | null {
  return ackTrackerInstance;
}
