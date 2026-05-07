/**
 * Phase 3: Stream Tool Bridge Initialization
 *
 * Wires the bridge to real MAIN-world dependencies and subscribes to stream events.
 * Called once during render_prescript initialization.
 */

import { onStreamEvent } from './interceptor';
import {
  createStreamToolHandler,
  type AdapterLike,
  type StreamToolBridgeConfig,
  type StreamToolExecutionEvent,
} from './streamToolBridge';

// --- Default config ---
const DEFAULT_CONFIG: StreamToolBridgeConfig = {
  enabled: false, // disabled by default; enable via configureStreamToolBridge()
  autoInsert: true,
  autoSubmit: false,
  toolTimeoutMs: 30_000,
};

let currentConfig: StreamToolBridgeConfig = { ...DEFAULT_CONFIG };
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
 * Resolve real executionGuard from MAIN-world globals.
 */
function resolveGuard() {
  const win = window as Record<string, unknown>;
  const guard = win.executionGuard as {
    reserveExecution?: (input: { functionName: string; callId: string; params: Record<string, unknown> }) => string | null;
    executionGuardStore?: {
      markSucceeded: (key: string) => void;
      markFailed: (key: string, error?: string) => void;
    };
  } | undefined;

  if (guard?.reserveExecution && guard?.executionGuardStore) {
    return guard as {
      reserveExecution: (input: { functionName: string; callId: string; params: Record<string, unknown> }) => string | null;
      executionGuardStore: { markSucceeded: (key: string) => void; markFailed: (key: string, error?: string) => void };
    };
  }
  return null;
}

/**
 * Resolve real mcpClient from MAIN-world globals.
 */
function resolveMcpClient() {
  const win = window as Record<string, unknown>;
  const client = win.mcpClient as {
    callTool?: (name: string, params: Record<string, unknown>) => Promise<unknown>;
    isReady?: () => boolean;
  } | undefined;

  if (client && typeof client.callTool === 'function' && typeof client.isReady === 'function') {
    return client as { callTool: (name: string, params: Record<string, unknown>) => Promise<unknown>; isReady: () => boolean };
  }
  return null;
}

/**
 * Resolve real storage from MAIN-world globals.
 */
function resolveStorage() {
  const win = window as Record<string, unknown>;
  const storage = win.executionStorage as {
    storeExecutedFunction?: (name: string, callId: string, params: Record<string, unknown>, sig: string) => void;
    generateContentSignature?: (name: string, params: Record<string, unknown>) => string;
  } | undefined;

  if (storage && typeof storage.storeExecutedFunction === 'function' && typeof storage.generateContentSignature === 'function') {
    return storage as {
      storeExecutedFunction: (name: string, callId: string, params: Record<string, unknown>, sig: string) => void;
      generateContentSignature: (name: string, params: Record<string, unknown>) => string;
    };
  }
  return null;
}

/**
 * Initialize the stream tool bridge and subscribe to stream events.
 * Safe to call multiple times — resubscribes with latest config.
 */
export function initStreamToolBridge(config?: Partial<StreamToolBridgeConfig>): void {
  if (config) {
    currentConfig = { ...currentConfig, ...config };
  }

  // Unsubscribe previous handler if any
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }

  // Create handler with lazy dependency resolution (dependencies may not be available at init time)
  bridgeHandler = createStreamToolHandler({
    config: currentConfig,
    mcpClient: resolveMcpClient(),
    guard: resolveGuard() || {
      reserveExecution: () => null,
      executionGuardStore: { markSucceeded: () => {}, markFailed: () => {} },
    },
    adapter: resolveCurrentAdapter,
    storage: resolveStorage() || {
      storeExecutedFunction: () => {},
      generateContentSignature: (name, params) => {
        const content = JSON.stringify({ name, params: Object.keys(params).sort().reduce((o, k) => ({ ...o, [k]: params[k] }), {}) });
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
          hash = (hash << 5) - hash + content.charCodeAt(i);
          hash = hash & hash;
        }
        return (hash >>> 0).toString(16);
      },
    },
    onEvent: (event: StreamToolExecutionEvent) => {
      // Log bridge events to console for observability
      const level = event.status === 'failed' ? 'warn' : 'debug';
      console[level]('[StreamToolBridge]', event.status, event.phase || '', event.errorCode || '');
    },
  });

  // Subscribe to stream events
  unsubscribe = onStreamEvent(bridgeHandler);
}

/**
 * Update bridge configuration at runtime.
 */
export function configureStreamToolBridge(config: Partial<StreamToolBridgeConfig>): void {
  currentConfig = { ...currentConfig, ...config };
  // Re-initialize with new config
  initStreamToolBridge();
}
