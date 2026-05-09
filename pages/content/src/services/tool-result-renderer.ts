/**
 * ToolResultRenderer — v1 direct-listener MVP
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
export { stringifyToolResult, truncatePreview, extractRenderData, type ToolResultRenderData };

const STYLE_TAG_ID = 'mcp-tool-result-renderer-styles';

const TOOL_RESULT_CSS = `
.mcp-tool-result-card {
  box-sizing: border-box;
  width: min(100%, 820px);
  max-width: 820px;
  margin: 10px auto;
  border: 1px solid var(--mcp-tr-border, #374151);
  border-radius: 10px;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 14px;
  background: var(--mcp-tr-bg, #111827);
  color: var(--mcp-tr-fg, #f9fafb);
}
.mcp-tool-result-header { display: flex; align-items: center; gap: 8px; padding: 10px 14px; cursor: pointer; user-select: none; }
.mcp-tool-result-header:hover { background: var(--mcp-tr-hover, rgba(255,255,255,0.06)); }
.mcp-tool-result-title { flex: 1; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mcp-tool-result-status { font-size: 13px; opacity: 0.86; }
.mcp-tool-result-chevron { transition: transform 0.2s; }
.mcp-tool-result-chevron[data-expanded="true"] { transform: rotate(90deg); }
.mcp-tool-result-preview { display: none; padding: 14px; border-top: 1px solid var(--mcp-tr-border, #374151); max-height: 420px; overflow-y: auto; }
.mcp-tool-result-preview[data-visible="true"] { display: block; }
.mcp-tool-result-preview pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: 'Menlo', 'Monaco', 'Consolas', monospace; font-size: 13px; line-height: 1.55; }
@media (prefers-color-scheme: light) { .mcp-tool-result-card { --mcp-tr-border: #d1d5db; --mcp-tr-bg: #f9fafb; --mcp-tr-fg: #111827; --mcp-tr-hover: #f3f4f6; } }
@media (prefers-color-scheme: dark) { .mcp-tool-result-card { --mcp-tr-border: #374151; --mcp-tr-bg: #111827; --mcp-tr-fg: #f9fafb; --mcp-tr-hover: rgba(255,255,255,0.06); } }
`;

export function buildCardElement(data: ToolResultRenderData): HTMLElement {
    const card = document.createElement('div');
    card.className = 'mcp-tool-result-card';
    card.setAttribute('data-mcp-tool-result-card', 'true');
    card.setAttribute('data-mcp-card-kind', data.kind || 'tool_result');
    card.setAttribute('data-mcp-call-id', data.callId);
    card.setAttribute('data-mcp-event-type', data.kind === 'prompt' ? 'prompt_config' : 'tool_execution_completed');

    const header = document.createElement('div');
    header.className = 'mcp-tool-result-header';

    const chevron = document.createElement('span');
    chevron.className = 'mcp-tool-result-chevron';
    chevron.textContent = '▸';
    chevron.setAttribute('data-expanded', 'false');

    const title = document.createElement('span');
    title.className = 'mcp-tool-result-title';
    title.textContent = data.kind === 'prompt'
        ? 'prompt: SuperAssistant Bridge 协作协议'
        : `MCP tool ${data.functionName} 调用结果`;

    const status = document.createElement('span');
    status.className = 'mcp-tool-result-status';
    status.textContent = data.kind === 'prompt' ? 'config' : data.status;

    header.appendChild(chevron);
    header.appendChild(title);
    header.appendChild(status);

    const preview = document.createElement('div');
    preview.className = 'mcp-tool-result-preview';
    preview.setAttribute('data-visible', 'false');

    const pre = document.createElement('pre');
    pre.textContent = data.status === 'success' ? data.resultPreview : (data.error || 'Unknown error');
    preview.appendChild(pre);

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

export class ToolResultRenderer {
    private static instance: ToolResultRenderer | null = null;
    private isInitialized = false;
    private eventListener: ((event: Event) => void) | null = null;
    private getActiveAdapterFn: (() => Promise<{ plugin?: AdapterPlugin } | null>) | null = null;

    private constructor() { }

    static getInstance(): ToolResultRenderer {
        if (!ToolResultRenderer.instance) ToolResultRenderer.instance = new ToolResultRenderer();
        return ToolResultRenderer.instance;
    }

    static _resetForTest(): void {
        if (ToolResultRenderer.instance) ToolResultRenderer.instance.cleanup();
        ToolResultRenderer.instance = null;
    }

    async initialize(): Promise<void> {
        if (this.isInitialized) return;
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
    }

    cleanup(): void {
        if (!this.isInitialized) return;
        if (this.eventListener) {
            document.removeEventListener('mcp:tool-execution-complete', this.eventListener);
            this.eventListener = null;
        }
        this.isInitialized = false;
    }

    private setupEventListener(): void {
        if (this.eventListener) document.removeEventListener('mcp:tool-execution-complete', this.eventListener);
        this.eventListener = (event: Event) => {
            const detail = (event as CustomEvent<ToolExecutionCompleteDetail>).detail;
            this.handleToolExecutionComplete(detail);
        };
        document.addEventListener('mcp:tool-execution-complete', this.eventListener);
    }

    private async handleToolExecutionComplete(detail: ToolExecutionCompleteDetail): Promise<void> {
        const data = extractRenderData(detail as any);
        if (!data) return;
        this.injectResultBlock(data);
    }

    private async injectResultBlock(data: ToolResultRenderData): Promise<boolean> {
        const existing = document.querySelector(`[data-mcp-tool-result-card="true"][data-mcp-call-id="${CSS.escape(data.callId)}"]`);
        if (existing) return true;

        let mountPoint: ToolResultMountPoint | null = null;
        try {
            if (this.getActiveAdapterFn) {
                const adapterState = await this.getActiveAdapterFn();
                const plugin = adapterState?.plugin;
                if (plugin?.findToolResultMountPoint) mountPoint = plugin.findToolResultMountPoint({ callId: data.callId } as any);
            }
        } catch (e) {
            logger.warn('[ToolResultRenderer] Error getting mount point:', e);
        }

        if (!mountPoint) {
            logger.warn('[ToolResultRenderer] mount point not found', { functionName: data.functionName, callId: data.callId });
            return false;
        }

        const card = buildCardElement(data);
        try {
            if (mountPoint.mode === 'after' && mountPoint.anchor) mountPoint.anchor.after(card);
            else mountPoint.container.appendChild(card);
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
