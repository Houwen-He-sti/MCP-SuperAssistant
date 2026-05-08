/**
 * Phase 3: Stream Tool Bridge Initialization
 *
 * Wires the bridge to real MAIN-world dependencies and subscribes to stream events.
 * Called once during render_prescript initialization.
 */

import { executionGuardStore, reserveExecution } from '../mcpexecute/executionGuard';
import { generateContentSignature, storeExecutedFunction } from '../mcpexecute/storage';
import { onStreamEvent as onStreamEventIsolated } from './interceptor';
import { installMainWorldStreamBridge, onStreamEvent as onStreamEventBridge, sendConfigToMainWorld } from './interceptorBridge';
import {
  createStreamToolHandler,
  type AdapterLike,
  type McpClientLike,
  type StreamToolBridgeConfig,
  type StreamToolExecutionEvent,
} from './streamToolBridge';

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

/**
 * Resolve the current adapter from MAIN-world globals.
 * Priority: pluginRegistry → mcpAdapter → window.getCurrentAdapter
 */
function resolveCurrentAdapter(): AdapterLike | null {
  const win = window as Record<string, unknown>;

  // 1. pluginRegistry path
  const registry = win.pluginRegistry as { getActivePlugin?: () => { adapter?: AdapterLike } | null } | undefined;
  if (registry?.getActivePlugin) {
    const plugin = registry.getActivePlugin();
    if (plugin?.adapter) return plugin.adapter;
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
    onEvent: (event: StreamToolExecutionEvent) => {
      // Log bridge events to console for observability
      const level = event.status === 'failed' ? 'warn' : 'debug';
      console[level]('[StreamToolBridge]', event.status, event.phase || '', event.errorCode || '');
    },
  });

  // Subscribe to stream events — use bridge for Notion, isolated interceptor for others
  if (isNotionHost()) {
    // Install the MAIN world bridge listener if not already done
    installMainWorldStreamBridge();
    // Send cutoff config to MAIN world (independent of execution enabled)
    sendConfigToMainWorld({
      enabled: currentConfig.cutoffEnabled,
      mode: undefined, // cutoff mode managed by bridge config, not tool bridge
    });
    unsubscribe = onStreamEventBridge(bridgeHandler);
  } else {
    unsubscribe = onStreamEventIsolated(bridgeHandler);
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
