/**
 * ToolResultRenderer — v1 direct-listener MVP
 *
 * Independently listens to `mcp:tool-execution-complete` DOM events
 * and injects visual result cards into the AI conversation area.
 *
 * Completely decoupled from AutomationService.
 */

import type { ToolResultMountPoint } from '../types/tool-result-ui';
import type { AdapterPlugin } from '../plugins/plugin-types';
import type { ToolExecutionCompleteDetail } from './automation.service';
import {
    stringifyToolResult,
    truncatePreview,
    extractRenderData,
    type ToolResultRenderData,
} from './tool-result-renderer-utils';
import { createLogger } from '@extension/shared/lib/logger';

const logger = createLogger('ToolResultRenderer');

// Re-export pure functions for consumers who import from this module
export { stringifyToolResult, truncatePreview, extractRenderData, type ToolResultRenderData };

// ── Constants ──

const STYLE_TAG_ID = 'mcp-tool-result-renderer-styles';

// ── CSS ──

const TOOL_RESULT_CSS = `
.mcp-tool-result-card {
  margin: 8px 0;
  border: 1px solid var(--mcp-tr-border, #e5e7eb);
  border-radius: 8px;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 14px;
  background: var(--mcp-tr-bg, #f9fafb);
}
.mcp-tool-result-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  user-select: none;
}
.mcp-tool-result-header:hover {
  background: var(--mcp-tr-hover, #f3f4f6);
}
.mcp-tool-result-title {
  flex: 1;
  font-weight: 500;
}
.mcp-tool-result-status {
  font-size: 16px;
}
.mcp-tool-result-chevron {
  transition: transform 0.2s;
}
.mcp-tool-result-chevron[data-expanded="true"] {
  transform: rotate(90deg);
}
.mcp-tool-result-preview {
  display: none;
  padding: 12px;
  border-top: 1px solid var(--mcp-tr-border, #e5e7eb);
  max-height: 400px;
  overflow-y: auto;
}
.mcp-tool-result-preview[data-visible="true"] {
  display: block;
}
.mcp-tool-result-preview pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'Menlo', 'Monaco', 'Consolas', monospace;
  font-size: 13px;
  line-height: 1.5;
}
@media (prefers-color-scheme: dark) {
  .mcp-tool-result-card {
    --mcp-tr-border: #374151;
    --mcp-tr-bg: #1f2937;
    --mcp-tr-hover: #374151;
  }
}
`;

// ── DOM builder (exported for testing) ──

/**
 * Build a tool result card DOM element.
 * Uses textContent exclusively — never innerHTML.
 */
export function buildCardElement(data: ToolResultRenderData): HTMLElement {
    const card = document.createElement('div');
    card.className = 'mcp-tool-result-card';
    card.setAttribute('data-mcp-tool-result-card', 'true');
    card.setAttribute('data-mcp-call-id', data.callId);
    card.setAttribute('data-mcp-event-type', 'tool_execution_completed');

    // ── Header ──
    const header = document.createElement('div');
    header.className = 'mcp-tool-result-header';

    const chevron = document.createElement('span');
    chevron.className = 'mcp-tool-result-chevron';
    chevron.textContent = '▸';
    chevron.setAttribute('data-expanded', 'false');

    const title = document.createElement('span');
    title.className = 'mcp-tool-result-title';
    title.textContent = `Tool: ${data.functionName}`;

    const status = document.createElement('span');
    status.className = 'mcp-tool-result-status';
    status.textContent = data.status === 'success' ? '✅' : '❌';

    header.appendChild(chevron);
    header.appendChild(title);
    header.appendChild(status);

    // ── Preview body ──
    const preview = document.createElement('div');
    preview.className = 'mcp-tool-result-preview';
    preview.setAttribute('data-visible', 'false');

    const pre = document.createElement('pre');
    pre.textContent = data.status === 'success'
        ? data.resultPreview
        : (data.error || 'Unknown error');
    preview.appendChild(pre);

    // ── Toggle ──
    header.addEventListener('click', () => {
        const isExpanded = chevron.getAttribute('data-expanded') === 'true';
        chevron.setAttribute('data-expanded', String(!isExpanded));
        chevron.textContent = isExpanded ? '▸' : '▾';
        preview.setAttribute('data-visible', String(!isExpanded));
    });

    card.appendChild(header);
    card.appendChild(preview);

    return card;
}

// ── Service class ──

export class ToolResultRenderer {
    private static instance: ToolResultRenderer | null = null;
    private isInitialized = false;
    private eventListener: ((event: Event) => void) | null = null;
    private getActiveAdapterFn: (() => Promise<{ plugin?: AdapterPlugin } | null>) | null = null;

    private constructor() { }

    static getInstance(): ToolResultRenderer {
        if (!ToolResultRenderer.instance) {
            ToolResultRenderer.instance = new ToolResultRenderer();
        }
        return ToolResultRenderer.instance;
    }

    /** Reset singleton — for testing only */
    static _resetForTest(): void {
        if (ToolResultRenderer.instance) {
            ToolResultRenderer.instance.cleanup();
        }
        ToolResultRenderer.instance = null;
    }

    async initialize(): Promise<void> {
        if (this.isInitialized) {
            logger.debug('[ToolResultRenderer] Already initialized, skipping');
            return;
        }

        logger.debug('[ToolResultRenderer] Initializing');

        // Lazy-import adapter store to avoid circular deps
        try {
            const { useAdapterStore } = await import('../stores/adapter.store');
            this.getActiveAdapterFn = async () => {
                const state = useAdapterStore.getState();
                const registration = state.getActiveAdapter();
                return registration ? { plugin: registration.plugin } : null;
            };
        } catch (e) {
            logger.warn('[ToolResultRenderer] Could not import adapter store:', e);
        }

        this.ensureStylesInjected();
        this.setupEventListener();
        this.isInitialized = true;

        logger.debug('[ToolResultRenderer] Initialized successfully');
    }

    /**
     * Cleanup: removes event listener only.
     * Injected style tags and card DOM elements are intentionally left in place
     * because they are part of the page's visible conversation history.
     * Cards remain visible until the page is reloaded.
     */
    cleanup(): void {
        if (!this.isInitialized) return;
        if (this.eventListener) {
            document.removeEventListener('mcp:tool-execution-complete', this.eventListener);
            this.eventListener = null;
        }
        this.isInitialized = false;
        logger.debug('[ToolResultRenderer] Cleaned up');
    }

    private setupEventListener(): void {
        if (this.eventListener) {
            document.removeEventListener('mcp:tool-execution-complete', this.eventListener);
        }
        this.eventListener = (event: Event) => {
            const detail = (event as CustomEvent<ToolExecutionCompleteDetail>).detail;
            this.handleToolExecutionComplete(detail);
        };
        document.addEventListener('mcp:tool-execution-complete', this.eventListener);
    }

    private async handleToolExecutionComplete(detail: ToolExecutionCompleteDetail): Promise<void> {
        const data = extractRenderData(detail);
        if (!data) return;

        this.injectResultBlock(data);
    }

    private async injectResultBlock(data: ToolResultRenderData): Promise<boolean> {
        // 1. Idempotent check
        const existing = document.querySelector(
            `[data-mcp-tool-result-card="true"][data-mcp-call-id="${CSS.escape(data.callId)}"]`
        );
        if (existing) {
            logger.debug('[ToolResultRenderer] Card already exists for callId:', data.callId);
            return true;
        }

        // 2. Get mount point from adapter
        let mountPoint: ToolResultMountPoint | null = null;
        try {
            if (this.getActiveAdapterFn) {
                const adapterState = await this.getActiveAdapterFn();
                const plugin = adapterState?.plugin;
                if (plugin?.findToolResultMountPoint) {
                    mountPoint = plugin.findToolResultMountPoint({ callId: data.callId });
                }
            }
        } catch (e) {
            logger.warn('[ToolResultRenderer] Error getting mount point:', e);
        }

        if (!mountPoint) {
            logger.warn('[ToolResultRenderer] mount point not found', {
                functionName: data.functionName,
                callId: data.callId,
            });
            return false;
        }

        // 3. Build and inject card
        const card = buildCardElement(data);

        try {
            if (mountPoint.mode === 'after' && mountPoint.anchor) {
                mountPoint.anchor.after(card);
            } else {
                mountPoint.container.appendChild(card);
            }
            logger.debug('[ToolResultRenderer] Card injected for:', data.functionName, data.callId);
            return true;
        } catch (e) {
            logger.warn('[ToolResultRenderer] Error injecting card:', e);
            return false;
        }
    }

    private ensureStylesInjected(): void {
        if (document.getElementById(STYLE_TAG_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_TAG_ID;
        style.textContent = TOOL_RESULT_CSS;
        document.head.appendChild(style);
    }
}
