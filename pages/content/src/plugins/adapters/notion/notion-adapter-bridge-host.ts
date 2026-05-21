/**
 * NotionAdapterBridgeHost — Layer 2 of the 4-layer BridgeHost architecture.
 *
 * Implements `NotionProviderHost` (mcp-runtime interface) by delegating to
 * `NotionAdapter`'s existing DOM methods.
 *
 * BH-2 scope: insertText, clickSubmit, getInputContent, getSubmitButtonState.
 * BH-3 scope (deferred): isStreaming, observeAssistantMessages.
 *
 * Architecture:
 *   Layer 4: Protocol (mcp-runtime) — ToolCallLoop + BridgeJsonlParser + HostBindings
 *   Layer 3: Adapter (mcp-runtime) — NotionProviderAdapter via createNotionProviderAdapter()
 *   Layer 2: Bridge Host (here) — NotionAdapterBridgeHost implements NotionProviderHost
 *   Layer 1: DOM (MCP-SA existing) — NotionAdapter.insertText() / submitForm()
 *
 * Evidence:
 *   - BH-0a: Option B+ (allowImportingTsExtensions: true in pages/content/tsconfig.json)
 *   - BH-1: CDP probe (stop-button selector + .layout-content message observer target)
 *   - BH-2 plan: plans/mcpsa-phase2-bridge-host-implementation-plan.md §3
 */

import type {
    NotionProviderHost,
    NotionSubmitButtonState,
} from '../../../../../../../mcp-runtime/src/adapters/notion-provider-adapter.ts';
import {
    runtimeOk,
    runtimeError,
    type RuntimeResult,
} from '../../../../../../../mcp-runtime/src/bridge/runtime-result.ts';
import type { AssistantMessageCallback } from '../../../../../../../mcp-runtime/src/adapters/provider-adapter.ts';
import type { Disposable } from '../../../../../../../mcp-runtime/src/lifecycle/disposable.ts';

// ---------------------------------------------------------------------------
// Selectors (copied from NotionAdapter.selectors — do NOT import adapter class
// to avoid pulling browser-bundle dependencies into tests)
// ---------------------------------------------------------------------------

const NATIVE_CHAT_INPUT_SEL =
    'div[role="textbox"][contenteditable="true"], div[contenteditable="true"][data-placeholder*="Ask"], div[contenteditable="true"][data-placeholder*="Message"]';

const NATIVE_SUBMIT_BUTTON_SEL = '[data-testid="agent-send-message-button"]';

/**
 * STREAMING TRUTH CONTRACT (BH-3):
 *   Authoritative signal (only): [data-testid="stop-button"] presence (BH-1 CDP probe evidence).
 *   Rejected signals: CSS animations, typing indicator, mutation rate, markdown render count.
 *
 *   streaming=true  → "Notion reports active generation" (stop-button visible)
 *   streaming=false → "Primary streaming signal absent"
 *
 *   REVALIDATION REQUIRED: Based on current BH-1/BH-3 observation evidence.
 *   Must be revalidated if Notion runtime changes. NOT a permanent invariant.
 */
const NATIVE_STOP_BUTTON_SEL = '[data-testid="stop-button"]';

/**
 * OBSERVER TARGET CONTRACT (BH-3):
 *   MutationObserver root: .layout-content (BH-1 CDP probe evidence).
 *   REVALIDATION REQUIRED if Notion restructures chat layout.
 */
const NATIVE_CHAT_CONTENT_SEL = '.layout-content';

// ---------------------------------------------------------------------------
// Adapter delegate interface (structural, avoids importing NotionAdapter class)
// ---------------------------------------------------------------------------

export interface NotionAdapterDelegate {
    insertText(text: string): Promise<boolean>;
    submitForm(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface NotionAdapterBridgeHostOptions {
    /** DOM adapter to delegate insertText/clickSubmit to */
    adapter: NotionAdapterDelegate;
    /**
     * Injectable document for test isolation.
     * Pass `document` (the global) in production.
     * GPT P1: do NOT use globalThis.document as default (undefined in Node.js test runtime).
     */
    document: Document;
    /**
     * Injectable MutationObserver class for test isolation.
     * Pass `MutationObserver` (the global) in production.
     * Same rationale as `document`: not available in Node.js test runtime.
     *
     * OBSERVER LIFECYCLE CONTRACT (BH-3):
     *   Each observeAssistantMessages() call creates one independent observer.
     *   Concurrent observers: NOT SUPPORTED (BH-3 primitive; BH-4+ coordinator scope).
     *   SPA navigation / reattach: OUT OF SCOPE for BH-3.
     */
    MutationObserver: typeof MutationObserver;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class NotionAdapterBridgeHost implements NotionProviderHost {
    private readonly adapter: NotionAdapterDelegate;
    private readonly doc: Document;
    private readonly MutationObserverCtor: typeof MutationObserver;

    constructor({ adapter, document: doc, MutationObserver: MOCtor }: NotionAdapterBridgeHostOptions) {
        this.adapter = adapter;
        this.doc = doc;
        this.MutationObserverCtor = MOCtor;
    }

    // ------------------------------------------------------------------
    // insertText — BH-2
    // ------------------------------------------------------------------

    async insertText(text: string): Promise<RuntimeResult> {
        const ok = await this.adapter.insertText(text);
        return ok
            ? runtimeOk(undefined)
            : runtimeError('NOTION_INSERT_FAILED', 'insertText returned false');
    }

    // ------------------------------------------------------------------
    // clickSubmit — BH-2
    // ------------------------------------------------------------------

    async clickSubmit(): Promise<RuntimeResult> {
        const ok = await this.adapter.submitForm();
        return ok
            ? runtimeOk(undefined)
            : runtimeError('NOTION_SUBMIT_FAILED', 'submitForm returned false');
    }

    // ------------------------------------------------------------------
    // getInputContent — BH-2
    // Evidence: notion-dom-contract-20260513.md (NATIVE_CHAT_INPUT selector)
    // ------------------------------------------------------------------

    getInputContent(): string | null {
        const el = this.doc.querySelector(NATIVE_CHAT_INPUT_SEL);
        if (!el) return null;
        return el.textContent ?? null;
    }

    // ------------------------------------------------------------------
    // getSubmitButtonState — BH-2
    // Evidence: Slice G probe (submitCount=1 on /chat, button present)
    // GPT P1: tests added as T-BH-07b..T-BH-07e
    // ------------------------------------------------------------------

    getSubmitButtonState(): NotionSubmitButtonState | null {
        const el = this.doc.querySelector(NATIVE_SUBMIT_BUTTON_SEL);
        if (!el) return { kind: 'missing' };
        // HTMLElement narrowing (GPT P2)
        const btn = el as HTMLElement;
        if (!btn.isConnected) return { kind: 'detached' };
        if (btn.getAttribute('aria-disabled') === 'true') return { kind: 'disabled' };
        return { kind: 'enabled' };
    }

    // ------------------------------------------------------------------
    // isStreaming — BH-3
    // Evidence: BH-1 CDP probe confirms [data-testid="stop-button"] selector.
    // See NATIVE_STOP_BUTTON_SEL contract comment above.
    // ------------------------------------------------------------------

    isStreaming(): boolean {
        return this.doc.querySelector(NATIVE_STOP_BUTTON_SEL) !== null;
    }

    // ------------------------------------------------------------------
    // observeAssistantMessages — BH-3
    // Evidence: BH-1 CDP probe confirms .layout-content MutationObserver target.
    // See NATIVE_CHAT_CONTENT_SEL contract comment above.
    //
    // DEFERRED SETUP (Slice V fix for React SPA timing):
    //   Notion AI renders .layout-content asynchronously (~50-200ms after
    //   document_idle). If the container is absent at call time, a document-level
    //   MutationObserver waits for it to appear, then attaches the real observer.
    //
    // OBSERVER LIFECYCLE:
    //   Fast path (element present at call time):
    //     [CREATE] new MutationObserver on .layout-content
    //     [SCAN]   emit all existing non-empty childNodes (initial scan)
    //     [ACTIVE] fires callback for each new content node (empty nodes skipped)
    //     [DISPOSE] caller calls disposable.dispose() → observer.disconnect()
    //
    //   Deferred path (element absent at call time):
    //     [CREATE] document-level watcher MutationObserver
    //     [WAIT]   fires each DOM mutation until .layout-content appears
    //     [ATTACH] disconnect watcher → initial scan → real observer (fast path)
    //     [DISPOSE] sets disposed flag; disconnects watcher OR real observer
    //
    // SAFETY INVARIANTS (P1 constraints from committee review):
    //   - disposed flag prevents real observer from attaching after dispose()
    //   - initial scan nodes added to shared `seen` WeakSet → no double-fire
    // ------------------------------------------------------------------

    observeAssistantMessages(callback: AssistantMessageCallback): Disposable {
        const container = this.doc.querySelector(NATIVE_CHAT_CONTENT_SEL);
        if (container) {
            // Fast path: element already present
            return this._attachObserver(container, callback);
        }

        // Deferred path: wait for .layout-content to appear
        let disposed = false;
        let innerDispose: (() => void) | null = null;

        const watcher = new this.MutationObserverCtor(() => {
            // disposed flag prevents attach after dispose() clears the watcher
            if (disposed) return;
            const el = this.doc.querySelector(NATIVE_CHAT_CONTENT_SEL);
            if (!el) return;
            watcher.disconnect();
            const d = this._attachObserver(el, callback);
            innerDispose = () => d.dispose();
        });
        watcher.observe(this.doc.documentElement as unknown as Node, { childList: true, subtree: true });

        return {
            dispose: () => {
                disposed = true;
                watcher.disconnect();
                innerDispose?.();
            },
        };
    }

    // ------------------------------------------------------------------
    // _attachObserver — internal helper for observeAssistantMessages
    //
    // Performs initial scan of existing nodes, then attaches MutationObserver.
    // Shared `seen` WeakSet prevents double-fire for nodes present at scan time.
    // ------------------------------------------------------------------

    private _attachObserver(container: Element, callback: AssistantMessageCallback): Disposable {
        const seen = new WeakSet<object>();

        // Initial scan: emit pre-existing non-empty nodes
        // Defensive: childNodes may be absent in test mocks that only implement querySelector
        const existingNodes = (container as unknown as { childNodes?: Iterable<unknown> }).childNodes;
        for (const node of existingNodes ? Array.from(existingNodes) : []) {
            const content = (node as { textContent?: string | null }).textContent ?? '';
            if (!content.trim()) continue;
            seen.add(node as object);
            void callback({ content, isComplete: true, timestamp: Date.now() });
        }

        // MutationObserver for new nodes (shares `seen` with initial scan)
        const observer = new this.MutationObserverCtor((records) => {
            for (const record of records) {
                for (const node of Array.from(record.addedNodes)) {
                    if (seen.has(node as object)) continue;
                    seen.add(node as object);
                    const content = (node as { textContent?: string | null }).textContent ?? '';
                    if (!content.trim()) continue;
                    void callback({ content, isComplete: true, timestamp: Date.now() });
                }
            }
        });
        observer.observe(container as unknown as Node, { childList: true, subtree: true });
        return { dispose: () => observer.disconnect() };
    }
}
