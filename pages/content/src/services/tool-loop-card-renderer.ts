/**
 * Gate 6C: Semantic Tool-Loop Card Renderer
 *
 * Consumes `mcp-superassistant:tool-loop-event` CustomEvent (from Gate 6B)
 * and renders collapsible UI cards with tone-based styling.
 *
 * Architecture:
 *   - Pure functions: in tool-loop-card-renderer-utils.ts (zero-dep, testable)
 *   - Service: ToolLoopCardRenderer (singleton, DOM lifecycle)
 *
 * Design decisions (4CR consensus with GPT):
 *   - One card per callId, updated in place
 *   - Internal kill switch via localStorage
 *   - Map<callId, HTMLElement> as primary card index (not selector-based)
 *   - Idempotent start via AbortController
 *   - Per-call state preserved even if DOM card can't be created yet
 */

import { createLogger } from '@extension/shared/lib/logger';
import type { AdapterPlugin } from '../plugins/plugin-types';
import type { ToolResultMountPoint } from '../types/tool-result-ui';
import {
    ToolLoopCardStateStore,
    isKnownToolLoopEventType,
    isToolLoopUiEvent,
    type TimelineEntry,
    type ToolLoopCardState,
} from './tool-loop-card-renderer-utils.ts';

export { ToolLoopCardStateStore, getCardStatusIcon, getCardTitle, isKnownToolLoopEventType, isToolLoopUiEvent, mapEventToTone } from './tool-loop-card-renderer-utils.ts';
export type { TimelineEntry, ToolLoopCardState, ToolLoopCardTone } from './tool-loop-card-renderer-utils.ts';

const logger = createLogger('ToolLoopCardRenderer');

// --- CSS ---

const STYLE_TAG_ID = 'mcp-tool-loop-card-renderer-styles';

const TOOL_LOOP_CSS = `
.mcp-tool-loop-card {
  box-sizing: border-box;
  width: min(100%, 820px);
  max-width: 820px;
  margin: 8px auto;
  border: 1px solid var(--mcp-tl-border, #e5e7eb);
  border-radius: 8px;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 14px;
  background: var(--mcp-tl-bg, #f9fafb);
}
.mcp-tool-loop-card[data-mcp-tone="neutral"] { border-left: 3px solid #6b7280; }
.mcp-tool-loop-card[data-mcp-tone="pending"] { border-left: 3px solid #3b82f6; }
.mcp-tool-loop-card[data-mcp-tone="success"] { border-left: 3px solid #10b981; }
.mcp-tool-loop-card[data-mcp-tone="acknowledged"] { border-left: 3px solid #8b5cf6; }
.mcp-tool-loop-card[data-mcp-tone="warning"] { border-left: 3px solid #f59e0b; }
.mcp-tool-loop-card[data-mcp-tone="blocked"] { border-left: 3px solid #6b7280; }
.mcp-tool-loop-card[data-mcp-tone="error"] { border-left: 3px solid #ef4444; }
.mcp-tool-loop-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  user-select: none;
}
.mcp-tool-loop-header:hover {
  background: var(--mcp-tl-hover, #f3f4f6);
}
.mcp-tool-loop-title {
  flex: 1;
  font-weight: 500;
}
.mcp-tool-loop-status {
  font-size: 16px;
}
.mcp-tool-loop-chevron {
  transition: transform 0.2s;
}
.mcp-tool-loop-chevron[data-expanded="true"] {
  transform: rotate(90deg);
}
.mcp-tool-loop-body {
  display: none;
  padding: 12px;
  border-top: 1px solid var(--mcp-tl-border, #e5e7eb);
  max-height: 300px;
  overflow-y: auto;
}
.mcp-tool-loop-body[data-visible="true"] {
  display: block;
}
.mcp-tool-loop-body pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'Menlo', 'Monaco', 'Consolas', monospace;
  font-size: 12px;
  line-height: 1.4;
}
.mcp-tool-loop-timeline-entry {
  padding: 2px 0;
  font-size: 12px;
  color: #6b7280;
}
@media (prefers-color-scheme: dark) {
  .mcp-tool-loop-card {
    --mcp-tl-border: #374151;
    --mcp-tl-bg: #1f2937;
    --mcp-tl-hover: #374151;
  }
  .mcp-tool-loop-timeline-entry {
    color: #9ca3af;
  }
}
`;

// --- DOM Builder ---

export function buildSemanticCard(state: ToolLoopCardState): HTMLElement {
    const card = document.createElement('div');
    card.className = 'mcp-tool-loop-card';
    card.setAttribute('data-mcp-call-id', state.callId);
    card.setAttribute('data-mcp-tone', state.currentTone);

    const header = document.createElement('div');
    header.className = 'mcp-tool-loop-header';

    const chevron = document.createElement('span');
    chevron.className = 'mcp-tool-loop-chevron';
    chevron.textContent = '▸';
    chevron.setAttribute('data-expanded', 'false');

    const title = document.createElement('span');
    title.className = 'mcp-tool-loop-title';
    title.textContent = state.title;

    const status = document.createElement('span');
    status.className = 'mcp-tool-loop-status';
    status.textContent = state.statusIcon;

    header.appendChild(chevron);
    header.appendChild(title);
    header.appendChild(status);

    const body = document.createElement('div');
    body.className = 'mcp-tool-loop-body';
    body.setAttribute('data-visible', 'false');

    const timeline = document.createElement('pre');
    timeline.textContent = formatTimeline(state.timeline);
    body.appendChild(timeline);

    header.addEventListener('click', () => {
        const isExpanded = chevron.getAttribute('data-expanded') === 'true';
        chevron.setAttribute('data-expanded', String(!isExpanded));
        chevron.textContent = isExpanded ? '▸' : '▾';
        body.setAttribute('data-visible', String(!isExpanded));
    });

    card.appendChild(header);
    card.appendChild(body);

    return card;
}

export function updateSemanticCard(card: HTMLElement, state: ToolLoopCardState): void {
    card.setAttribute('data-mcp-tone', state.currentTone);

    const title = card.querySelector('.mcp-tool-loop-title');
    if (title) title.textContent = state.title;

    const status = card.querySelector('.mcp-tool-loop-status');
    if (status) status.textContent = state.statusIcon;

    const body = card.querySelector('.mcp-tool-loop-body pre');
    if (body) body.textContent = formatTimeline(state.timeline);
}

function formatTimeline(timeline: TimelineEntry[]): string {
    return timeline.map(entry => {
        const time = new Date(entry.timestamp).toLocaleTimeString();
        let line = `[${time}] ${entry.type}`;
        if (entry.phase) line += ` (${entry.phase})`;
        if (entry.errorCode) line += ` [${entry.errorCode}]`;
        if (entry.error) line += ` — ${entry.error}`;
        if (entry.injectOutcome) line += ` → ${entry.injectOutcome}`;
        if (entry.latencyMs !== undefined) line += ` (${Math.round(entry.latencyMs)}ms)`;
        return line;
    }).join('\n');
}

// --- Kill Switch ---

const KILL_SWITCH_KEY = 'mcp:disable-tool-loop-card-renderer';

function isDisabled(): boolean {
    try {
        return globalThis.localStorage?.getItem(KILL_SWITCH_KEY) === '1';
    } catch {
        return false;
    }
}

// --- Service Class ---
// TODO P2: stateStore/cards cleanup on SPA navigation or after terminal state timeout

export class ToolLoopCardRenderer {
    private static instance: ToolLoopCardRenderer | null = null;

    private stateStore = new ToolLoopCardStateStore();
    private cards = new Map<string, HTMLElement>();
    private pendingCreation = new Set<string>();
    private abortController?: AbortController;
    private started = false;
    private getActiveAdapterFn: (() => Promise<{ plugin?: AdapterPlugin } | null>) | null = null;

    private constructor() { }

    static getInstance(): ToolLoopCardRenderer {
        if (!ToolLoopCardRenderer.instance) {
            ToolLoopCardRenderer.instance = new ToolLoopCardRenderer();
        }
        return ToolLoopCardRenderer.instance;
    }

    /** Reset singleton — for testing only */
    static _resetForTest(): void {
        if (ToolLoopCardRenderer.instance) {
            ToolLoopCardRenderer.instance.stop();
        }
        ToolLoopCardRenderer.instance = null;
    }

    async start(): Promise<void> {
        if (this.started) {
            logger.debug('[ToolLoopCardRenderer] Already started, skipping');
            return;
        }

        if (isDisabled()) {
            logger.info('[ToolLoopCardRenderer] Disabled by localStorage flag');
            return;
        }

        logger.debug('[ToolLoopCardRenderer] Starting');

        // Lazy-import adapter store
        try {
            const { useAdapterStore } = await import('../stores/adapter.store');
            this.getActiveAdapterFn = async () => {
                const state = useAdapterStore.getState();
                const registration = state.getActiveAdapter();
                return registration ? { plugin: registration.plugin } : null;
            };
        } catch (e) {
            logger.warn('[ToolLoopCardRenderer] Could not import adapter store:', e);
        }

        this.ensureStylesInjected();

        this.abortController = new AbortController();
        window.addEventListener(
            'mcp-superassistant:tool-loop-event',
            this.handleEvent as EventListener,
            { signal: this.abortController.signal },
        );

        this.started = true;
        logger.debug('[ToolLoopCardRenderer] Started successfully');
    }

    stop(): void {
        if (!this.started) return;
        this.abortController?.abort();
        this.abortController = undefined;
        this.started = false;
        logger.debug('[ToolLoopCardRenderer] Stopped');
    }

    private handleEvent = (event: Event): void => {
        const detail = (event as CustomEvent<unknown>).detail;
        if (!isToolLoopUiEvent(detail)) return;

        const { callId } = detail;
        if (typeof callId !== 'string' || callId.length === 0) {
            logger.warn('[ToolLoopCardRenderer] Skip event without callId', {
                type: detail.type,
                streamId: detail.streamId,
            });
            return;
        }

        if (!isKnownToolLoopEventType(detail.type)) {
            logger.warn('[ToolLoopCardRenderer] Unknown tool-loop event type', {
                type: detail.type,
                streamId: detail.streamId,
                callId: detail.callId,
            });
        }

        // Update internal state (always succeeds for valid callId)
        const state = this.stateStore.apply(detail);
        if (!state) return;

        // Check existing card
        let card = this.cards.get(callId);
        if (card && !card.isConnected) {
            this.cards.delete(callId);
            card = undefined;
        }

        if (card) {
            updateSemanticCard(card, state);
            return;
        }

        // Guard: only one creation in-flight per callId
        if (this.pendingCreation.has(callId)) return;

        this.pendingCreation.add(callId);
        void this.tryCreateCard(callId).finally(() => {
            this.pendingCreation.delete(callId);
        });
    };

    private async tryCreateCard(callId: string): Promise<void> {
        const mountPoint = await this.getMountPoint(callId);
        if (!mountPoint) {
            logger.warn('[ToolLoopCardRenderer] Mount point unavailable', { callId });
            return;
        }

        const initialState = this.stateStore.get(callId);
        if (!initialState) return;

        // Re-check: card may have been created while we awaited
        let card = this.cards.get(callId);
        if (card && !card.isConnected) {
            this.cards.delete(callId);
            card = undefined;
        }

        if (!card) {
            card = buildSemanticCard(initialState);
            try {
                if (mountPoint.mode === 'after' && mountPoint.anchor) {
                    mountPoint.anchor.after(card);
                } else {
                    mountPoint.container.appendChild(card);
                }
                this.cards.set(callId, card);
                logger.debug('[ToolLoopCardRenderer] Card created', {
                    callId,
                    toolName: initialState.toolName,
                    tone: initialState.currentTone,
                });
            } catch (e) {
                logger.warn('[ToolLoopCardRenderer] Error injecting card', {
                    callId,
                    error: e instanceof Error ? e.message : String(e),
                });
                return;
            }
        }

        // Critical: re-read latest state after async + DOM insert
        const latestState = this.stateStore.get(callId);
        if (latestState) {
            updateSemanticCard(card, latestState);
        }
    }

    private async getMountPoint(callId: string): Promise<ToolResultMountPoint | null> {
        try {
            if (!this.getActiveAdapterFn) return null;
            const adapterState = await this.getActiveAdapterFn();
            const plugin = adapterState?.plugin;
            if (plugin?.findToolResultMountPoint) {
                return plugin.findToolResultMountPoint({ callId });
            }
        } catch (e) {
            logger.warn('[ToolLoopCardRenderer] Error getting mount point:', e);
        }
        return null;
    }

    private ensureStylesInjected(): void {
        if (document.getElementById(STYLE_TAG_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_TAG_ID;
        style.textContent = TOOL_LOOP_CSS;
        document.head.appendChild(style);
    }
}
