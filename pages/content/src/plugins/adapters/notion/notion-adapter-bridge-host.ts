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
} from '../../../../../../../../../AppData/Local/Temp/vscode-dir-shared-context-post121/mcp-runtime/src/adapters/notion-provider-adapter.ts';
import {
    runtimeOk,
    runtimeError,
    type RuntimeResult,
} from '../../../../../../../../../AppData/Local/Temp/vscode-dir-shared-context-post121/mcp-runtime/src/bridge/runtime-result.ts';

// ---------------------------------------------------------------------------
// Selectors (copied from NotionAdapter.selectors — do NOT import adapter class
// to avoid pulling browser-bundle dependencies into tests)
// ---------------------------------------------------------------------------

const NATIVE_CHAT_INPUT_SEL =
    'div[role="textbox"][contenteditable="true"], div[contenteditable="true"][data-placeholder*="Ask"], div[contenteditable="true"][data-placeholder*="Message"]';

const NATIVE_SUBMIT_BUTTON_SEL = '[data-testid="agent-send-message-button"]';

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
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class NotionAdapterBridgeHost implements NotionProviderHost {
    private readonly adapter: NotionAdapterDelegate;
    private readonly doc: Document;

    constructor({ adapter, document: doc }: NotionAdapterBridgeHostOptions) {
        this.adapter = adapter;
        this.doc = doc;
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
    // isStreaming — DEFERRED BH-3
    // Evidence: BH-1 CDP probe confirms [data-testid="stop-button"] selector.
    // ------------------------------------------------------------------

    // isStreaming(): boolean { ... }   // BH-3

    // ------------------------------------------------------------------
    // observeAssistantMessages — DEFERRED BH-3
    // Evidence: BH-1 CDP probe confirms .layout-content MutationObserver target.
    // ------------------------------------------------------------------

    // observeAssistantMessages(callback: AssistantMessageCallback): Disposable { ... }  // BH-3
}
