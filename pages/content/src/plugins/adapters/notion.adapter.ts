import { assembleInstructions, assembleNotionBridgePrompt, wrapWithSystemPromptTag } from '../../components/sidebar/Instructions/promptTemplateLoader';
import { useToolStore } from '../../stores/tool.store';
import type { ToolResultMountPoint } from '../../types/tool-result-ui';
import type { AdapterCapability, PluginContext } from '../plugin-types';
import { BaseAdapterPlugin } from './base.adapter';
import { NOTION_CHAT_CONTENT_SELECTOR } from './notion.adapter.selectors';
import { choosePromptForFirstConversation, getEnabledToolDefinitions } from './notion.bridge-prompt';
// Architecture: BH path uses mcp-runtime formatter; render_prescript copy retained for streamToolBridge.ts
import type { Disposable } from '../../../../../../mcp-runtime/src/lifecycle/disposable.ts';
import { formatFunctionResult } from '../../../../../../mcp-runtime/src/core/function-result-formatter.ts';
import { startNotionRuntimeBridgeIfEnabled, type WindowLike } from './notion/notion-runtime-bridge.ts';
import { NotionConnectionState } from './notion/notion-connection-state.ts';
import { useConnectionStore } from '../../stores/connection.store';
import { enableStreamBridgeOnWindow } from './notion.bridge-enable';

/**
 * Notion AI Adapter — supports both:
 * 1. Notion AI native agent (face icon) on regular Notion pages
 * 2. Legacy /ai chat panel (fallback)
 *
 * On first conversation with the native agent, automatically injects
 * the SuperAssistant Bridge protocol prompt (loaded from external template).
 */

/**
 * Bridge protocol prompt loaded from prompt-templates/notion-bridge.md.
 * Wrapped with <mcp-system-prompt> for UI card rendering.
 */
const BRIDGE_PROMPT = wrapWithSystemPromptTag(assembleNotionBridgePrompt());

import { isNativeAiRoute, isSupportedPath } from './notion.routes.js';
import { createNotionSubmitContext } from './notion/submit-context';
import { waitForSubmitButtonAndClick } from './notion/submit-readiness.js';
export class NotionAdapter extends BaseAdapterPlugin {
    readonly name = 'NotionAdapter';
    readonly version = '1.1.0';
    readonly hostnames = ['notion.so', 'www.notion.so'];
    readonly capabilities: AdapterCapability[] = [
        'text-insertion',
        'form-submission',
        'dom-manipulation',
    ];

    // CSS selectors for Notion AI's UI elements
    private readonly selectors = {
        // === Native Notion AI agent (face icon) selectors ===
        // Chat input — Notion AI agent uses a contenteditable div
        NATIVE_CHAT_INPUT:
            'div[role="textbox"][contenteditable="true"], div[contenteditable="true"][data-placeholder*="Ask"], div[contenteditable="true"][data-placeholder*="Message"]',
        // Send button — Notion AI agent send button (specific data-testid only;
        // broader aria-label fallbacks removed to prevent false positives on regular pages)
        NATIVE_SUBMIT_BUTTON: '[data-testid="agent-send-message-button"]',
        // Chat content area for native agent
        NATIVE_CHAT_CONTENT: NOTION_CHAT_CONTENT_SELECTOR,

        // === Legacy /ai panel selectors (fallback) ===
        CHAT_INPUT:
            'div[role="textbox"][contenteditable="true"], div.content-editable-leaf-rtl[contenteditable="true"]',
        SUBMIT_BUTTON: '[data-testid="agent-send-message-button"]',
        CHAT_CONTENT: '.notion-app-inner',
        BUTTON_INSERTION_CONTAINER: '[data-testid="unified-chat-plus-menu-button"]',
    };

    // SPA URL tracking
    private lastUrl: string = '';
    private urlCheckInterval: NodeJS.Timeout | null = null;

    // MCP popover state
    private mcpPopoverContainer: HTMLElement | null = null;
    private mcpPopoverRoot: any = null;
    private mutationObserver: MutationObserver | null = null;

    // Event listener unsubscribers
    private eventUnsubscribers: Array<() => void> = [];

    // Setup state tracking
    private storeEventListenersSetup: boolean = false;
    private domObserversSetup: boolean = false;
    private uiIntegrationSetup: boolean = false;
    private wasOnAiPage: boolean = false;

    // First-conversation tracking for bridge prompt injection
    private bridgePromptInjected: boolean = false;
    private conversationMessageCount: number = 0;
    private messageObserver: MutationObserver | null = null;

    // Dynamic bridge prompt cache (Slice 1: populated from tool store on activate)
    private cachedBridgePrompt: string | null = null;
    private toolStoreUnsubscribe: (() => void) | null = null;

    // BH-4: ToolCallLoop disposable (null when lane gate is disabled — default off)
    private bhBridgeDisposable: Disposable | null = null;

    /**
     * Route gating: activate on Notion AI pages.
     * Uses DOM-based detection per PR #49 decision — no legacy path checks.
     */
    isSupported(): boolean {
        const path = window.location.pathname;

        // Native Notion AI agent: detect by presence of AI chat input on any Notion page
        const nativeInput = document.querySelector(this.selectors.NATIVE_CHAT_INPUT);
        return isSupportedPath(path, nativeInput !== null);
    }

    /**
     * Check if we're on the native Notion AI agent page (face icon),
     * as opposed to the legacy /ai panel.
     *
     * Uses BOTH route matching AND DOM verification to prevent
     * false positives on regular Notion edit pages.
     */
    private isNativeAiAgent(): boolean {
        const path = window.location.pathname;
        if (!isNativeAiRoute(path)) return false;

        // DOM guard: verify the native AI submit button actually exists
        const submitBtn = document.querySelector(this.selectors.NATIVE_SUBMIT_BUTTON);
        return submitBtn !== null;
    }

    async initialize(context: PluginContext): Promise<void> {
        if (this.currentStatus === 'initializing' || this.currentStatus === 'active') {
            this.context?.logger.warn('Notion adapter already initialized or active, skipping');
            return;
        }

        await super.initialize(context);
        this.context.logger.debug('Initializing Notion AI adapter...');

        this.lastUrl = window.location.href;
        this.setupUrlTracking();
        this.setupStoreEventListeners();
    }

    async activate(): Promise<void> {
        if (this.currentStatus === 'active') {
            this.context?.logger.warn('Notion adapter already active, skipping');
            return;
        }

        await super.activate();
        this.context.logger.debug('Activating Notion AI adapter...');

        // Reset first-conversation state on each activation
        this.bridgePromptInjected = false;
        this.conversationMessageCount = 0;

        // Cache bridge prompt from tool store on activation (Slice 1 dynamic injection)
        this.refreshBridgePromptCache();
        // Subscribe to tool store changes to keep cache fresh
        this.toolStoreUnsubscribe?.();
        this.toolStoreUnsubscribe = useToolStore.subscribe(() => {
            this.refreshBridgePromptCache();
        });

        if (this.isSupported()) {
            this.wasOnAiPage = true;
            this.setupDOMObservers();
            this.setupUIIntegration();

            // BH-4: start ToolCallLoop if __BH_RUNTIME_BRIDGE_ENABLED__ flag is set (opt-in, default off)
            // Returns null when flag is absent/false or mcpClient unavailable (fail-closed).
            // Must be called BEFORE setupMessageObserver so the return value gates the DOM scan path.
            this.bhBridgeDisposable = startNotionRuntimeBridgeIfEnabled(
                window as unknown as WindowLike,
                {
                    adapter: { insertText: (t) => this.insertText(t), submitForm: () => this.submitForm() },
                    document,
                    MutationObserver,
                    formatFunctionResult,
                    connectionState: new NotionConnectionState(() => useConnectionStore.getState().status),
                },
            );

            // Setup message observer for native AI agent.
            // Skipped when BH ToolCallLoop is active to prevent dual-execution of tool call scanning.
            // (window.mcpNotionDomScan.scan() would conflict with ToolCallLoop's .layout-content observer)
            if (this.isNativeAiAgent() && !this.bhBridgeDisposable) {
                this.setupMessageObserver();
            }

            // Enable stream bridge (render_prescript configureStreamToolBridge) for
            // supported Notion AI pages when the BH-4 ToolCallLoop is NOT active.
            // When bhBridgeDisposable !== null (BH-4 flag enabled), skip to prevent
            // dual MCP execution (ToolCallLoop + streamToolBridge would both fire).
            if (!this.bhBridgeDisposable) {
                enableStreamBridgeOnWindow(window);
            }
        } else {
            this.context.logger.debug('Not on supported page, skipping DOM/UI setup');
        }

        this.context.eventBus.emit('adapter:activated', {
            pluginName: this.name,
            timestamp: Date.now(),
        });
    }

    async deactivate(): Promise<void> {
        if (this.currentStatus === 'inactive' || this.currentStatus === 'disabled') {
            this.context?.logger.warn('Notion adapter already inactive, skipping');
            return;
        }

        await super.deactivate();
        this.context.logger.debug('Deactivating Notion AI adapter...');

        // Unsubscribe from tool store on deactivation
        this.cleanupToolStoreSubscription();

        // BH-4: stop ToolCallLoop if it was started
        await this.bhBridgeDisposable?.dispose();
        this.bhBridgeDisposable = null;

        this.cleanupUIIntegration();
        this.cleanupDOMObservers();

        this.storeEventListenersSetup = false;
        this.domObserversSetup = false;
        this.uiIntegrationSetup = false;

        this.context.eventBus.emit('adapter:deactivated', {
            pluginName: this.name,
            timestamp: Date.now(),
        });
    }

    /**
     * Release the Zustand tool store subscription and clear the bridge prompt cache.
     * Called from both deactivate() and cleanup() to prevent listener leaks.
     */
    private cleanupToolStoreSubscription(): void {
        this.toolStoreUnsubscribe?.();
        this.toolStoreUnsubscribe = null;
        this.cachedBridgePrompt = null;
    }

    /**
     * Rebuild the dynamic bridge prompt from the current tool store state.
     * Called on activate() and whenever the tool store changes.
     *
     * Slice 1: if enabled tools are available, builds dynamic prompt via assembleInstructions.
     * Falls back to null (caller uses static BRIDGE_PROMPT) when store is empty or errors.
     */
    private refreshBridgePromptCache(): void {
        try {
            const { availableTools, enabledTools } = useToolStore.getState();
            const toolDefs = getEnabledToolDefinitions(availableTools, enabledTools);
            if (toolDefs.length === 0) {
                this.cachedBridgePrompt = null; // trigger fallback to static BRIDGE_PROMPT
                return;
            }
            this.cachedBridgePrompt = wrapWithSystemPromptTag(
                assembleInstructions({ platform: 'notion', tools: toolDefs })
            );
            this.context?.logger.debug(
                `[Slice1] Dynamic bridge prompt cached (${toolDefs.length} tools).`
            );
        } catch (err) {
            // Fail-safe: on any error, fall back to static prompt.
            // Do NOT unsubscribe here — transient errors should not stop listening for store updates.
            this.context?.logger.warn(
                `[Slice1] Failed to build dynamic bridge prompt, using static fallback: ${err}`
            );
            this.cachedBridgePrompt = null;
        }
    }

    async cleanup(): Promise<void> {
        await super.cleanup();
        this.context.logger.debug('Cleaning up Notion AI adapter...');
        this.cleanupToolStoreSubscription();

        // BH-4: stop ToolCallLoop if it was started
        await this.bhBridgeDisposable?.dispose();
        this.bhBridgeDisposable = null;

        if (this.urlCheckInterval) {
            clearInterval(this.urlCheckInterval);
            this.urlCheckInterval = null;
        }

        // Cleanup message observer
        if (this.messageObserver) {
            this.messageObserver.disconnect();
            this.messageObserver = null;
        }

        // Unsubscribe event listeners
        for (const unsub of this.eventUnsubscribers) {
            unsub();
        }
        this.eventUnsubscribers = [];

        this.cleanupUIIntegration();
        this.cleanupDOMObservers();

        this.storeEventListenersSetup = false;
        this.domObserversSetup = false;
        this.uiIntegrationSetup = false;
        this.wasOnAiPage = false;
        this.bridgePromptInjected = false;
        this.conversationMessageCount = 0;
    }

    // ── Core capabilities ──────────────────────────────────────────────

    /**
     * Emit tool execution success event via eventBus.
     * Missing from BaseAdapterPlugin — defined here to match chatgpt.adapter pattern.
     */
    private emitExecutionCompleted(toolName: string, parameters: any, result: any): void {
        this.context.eventBus.emit('tool:execution-completed', {
            execution: {
                id: this.generateCallId(),
                toolName,
                parameters,
                result,
                timestamp: Date.now(),
                status: 'success',
            },
        });
    }

    /**
     * Emit tool execution failure event via eventBus.
     * Missing from BaseAdapterPlugin — defined here to match chatgpt.adapter pattern.
     */
    private emitExecutionFailed(toolName: string, error: string): void {
        this.context.eventBus.emit('tool:execution-failed', {
            toolName,
            error,
            callId: this.generateCallId(),
        });
    }

    private generateCallId(): string {
        return `notion-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    }

    /**
     * Insert text into the Notion AI chat input (contenteditable div).
     * Uses execCommand / InputEvent to update both DOM and editor internal state.
     *
     * On native AI agent, injects bridge prompt on first conversation if input is empty.
     */
    async insertText(text: string, options?: { targetElement?: HTMLElement }): Promise<boolean> {
        if (!this.isSupported()) {
            this.context.logger.debug('Not on supported page, skipping insertText');
            return false;
        }

        this.context.logger.debug(`Inserting text into Notion AI input: ${text.substring(0, 50)}…`);

        let target: HTMLElement | null = options?.targetElement ?? null;

        if (!target) {
            // Try native agent selectors first, then legacy fallback
            const allSelectors = [
                ...this.selectors.NATIVE_CHAT_INPUT.split(', '),
                ...this.selectors.CHAT_INPUT.split(', '),
            ];
            for (const sel of allSelectors) {
                target = document.querySelector(sel.trim()) as HTMLElement;
                if (target) break;
            }
        }

        if (!target) {
            this.context.logger.error('Could not find Notion AI chat input element');
            this.emitExecutionFailed('insertText', 'Chat input element not found');
            return false;
        }

        try {
            const originalContent = target.textContent || '';
            target.focus();

            // On native AI agent, inject bridge prompt on first conversation
            let contentToInsert = text;
            const promptForFirstConversation = choosePromptForFirstConversation(
                this.cachedBridgePrompt,
                BRIDGE_PROMPT,
                this.isNativeAiAgent(),
                this.bridgePromptInjected,
                this.conversationMessageCount,
                originalContent,
            );
            if (promptForFirstConversation !== null) {
                this.context.logger.debug('First conversation detected, injecting bridge prompt');
                contentToInsert = promptForFirstConversation + '\n\n' + text;
                this.bridgePromptInjected = true;
            }

            // Select all existing content so new text replaces it
            const selection = window.getSelection();
            if (selection) {
                const range = document.createRange();
                range.selectNodeContents(target);
                selection.removeAllRanges();
                selection.addRange(range);
            }

            const newContent = originalContent ? originalContent + '\n' + contentToInsert : contentToInsert;

            // Try execCommand first — best way to sync with editor state
            const execResult = document.execCommand('insertText', false, newContent);

            if (!execResult) {
                // Fallback: use InputEvent (works with modern contenteditable editors)
                this.context.logger.debug('execCommand failed, using InputEvent fallback');
                target.textContent = newContent;
                target.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    cancelable: true,
                    inputType: 'insertText',
                    data: newContent,
                }));
            }

            // Fire additional events for React reconciliation
            target.dispatchEvent(new Event('input', { bubbles: true }));
            target.dispatchEvent(new Event('change', { bubbles: true }));

            // Verify insertion
            const finalContent = target.textContent || '';
            if (!finalContent.includes(contentToInsert)) {
                this.context.logger.warn('Text insertion may not have taken effect');
            }

            this.emitExecutionCompleted('insertText', { text }, {
                success: true,
                originalLength: originalContent.length,
                newLength: text.length,
                totalLength: newContent.length,
            });

            this.context.logger.debug('Text inserted successfully into Notion AI input');
            return true;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.context.logger.error(`Error inserting text: ${msg}`);
            this.emitExecutionFailed('insertText', msg);
            return false;
        }
    }

    /**
     * Get the current text content of the Notion AI chat input.
     * Required by streamToolBridge fail-closed logic to check for user drafts.
     */
    getInputContent(): string | null {
        const selectors = [
            ...this.selectors.NATIVE_CHAT_INPUT.split(', '),
            ...this.selectors.CHAT_INPUT.split(', '),
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel.trim()) as HTMLElement;
            if (el) return el.textContent || '';
        }
        return null;
    }

    /**
     * Submit the current text in the Notion AI chat input by clicking the send button.
     * Supports both native AI agent and legacy /ai panel.
     */
    async submitForm(options?: { formElement?: HTMLFormElement }): Promise<boolean> {
        if (!this.isSupported()) {
            this.context.logger.debug("Not on supported page, skipping submitForm");
            return false;
        }

        this.context.logger.debug("Attempting to submit Notion AI chat input (with polling)");

        // Try native agent selectors first, then legacy fallback
        const allSelectors = [
            ...this.selectors.NATIVE_SUBMIT_BUTTON.split(", "),
            ...this.selectors.SUBMIT_BUTTON.split(", "),
        ];

        const getButton = (): HTMLElement | null => {
            for (const sel of allSelectors) {
                const btn = document.querySelector(sel.trim()) as HTMLElement | null;
                if (btn) return btn;
            }
            return null;
        };

        const context = createNotionSubmitContext(getButton);
        const result = await waitForSubmitButtonAndClick(context, {
            maxAttempts: 50,
            intervalMs: 100, // Waits up to 5s total
        });

        if (result.ok) {
            // Increment conversation count after successful submit on native agent
            if (this.isNativeAiAgent()) {
                this.conversationMessageCount++;
            }

            this.emitExecutionCompleted("submitForm", {
                formElement: options?.formElement?.tagName || "unknown",
            }, {
                success: true,
                method: "submitButton.click",
                buttonSelector: this.selectors.SUBMIT_BUTTON,
                attempts: result.attempts,
            });

            this.context.logger.debug("Notion AI chat input submitted successfully after " + result.attempts + " attempts");
            return true;
        } else {
            const reasonMsg = result.reason === "button_disabled" ? "Send button is disabled or detached" : result.reason === "button_not_found" ? "Send button not found" : "Click failed";
            const fullMsg = "Could not submit: " + reasonMsg + " (" + result.attempts + " attempts)";
            this.context.logger.error(fullMsg);
            this.emitExecutionFailed("submitForm", fullMsg);
            return false;
        }
    }


    // ── URL tracking (SPA) ─────────────────────────────────────────────

    private setupUrlTracking(): void {
        if (!this.urlCheckInterval) {
            this.urlCheckInterval = setInterval(() => {
                const currentUrl = window.location.href;
                if (currentUrl !== this.lastUrl) {
                    this.context.logger.debug(`URL changed from ${this.lastUrl} to ${currentUrl}`);
                    if (this.onPageChanged) {
                        this.onPageChanged(currentUrl, this.lastUrl);
                    }
                    this.lastUrl = currentUrl;

                    // Handle SPA navigation between /ai and non-/ai
                    const nowOnAi = this.isSupported();
                    if (nowOnAi && !this.wasOnAiPage) {
                        // Navigated TO supported page — set up DOM/UI
                        this.context.logger.debug('Navigated to supported page, setting up DOM/UI');
                        this.wasOnAiPage = true;
                        this.setupDOMObservers();
                        this.setupUIIntegration();
                    } else if (!nowOnAi && this.wasOnAiPage) {
                        // Navigated AWAY from supported page — tear down DOM/UI
                        this.context.logger.debug('Navigated away from supported page, cleaning up DOM/UI');
                        this.wasOnAiPage = false;
                        this.cleanupUIIntegration();
                        this.cleanupDOMObservers();
                        this.domObserversSetup = false;
                        this.uiIntegrationSetup = false;
                    }

                    // Reset bridge prompt state on any URL change (handles /chat→/chat?t=new)
                    this.bridgePromptInjected = false;
                    this.conversationMessageCount = 0;
                }
            }, 1000);
        }
    }

    // ── Store event listeners ──────────────────────────────────────────

    private setupStoreEventListeners(): void {
        if (this.storeEventListenersSetup) return;

        this.context.logger.debug('Setting up store event listeners for Notion adapter');

        const unsub1 = this.context.eventBus.on('tool:execution-completed', (data) => {
            this.context.logger.debug('Tool execution completed:', data);
            this.handleToolExecutionCompleted(data);
        });

        const unsub2 = this.context.eventBus.on('ui:sidebar-toggle', (data) => {
            this.context.logger.debug('Sidebar toggled:', data);
        });

        this.eventUnsubscribers.push(unsub1, unsub2);
        this.storeEventListenersSetup = true;
    }

    // ── Message observer for native AI agent ──────────────────────────

    /**
     * Setup MutationObserver to track conversation messages on native AI agent.
     * Used to determine when to inject the bridge prompt (only on first message).
     */
    private setupMessageObserver(): void {
        if (this.messageObserver) {
            this.messageObserver.disconnect();
        }

        this.context.logger.debug('Setting up message observer for native AI agent');

        // Observe the chat content area for new messages
        const chatContent = document.querySelector(this.selectors.NATIVE_CHAT_CONTENT);
        if (!chatContent) {
            this.context.logger.debug('Chat content not found, skipping message observer');
            return;
        }

        this.messageObserver = new MutationObserver((mutations) => {
            for (let i = 0; i < mutations.length; i++) {
                const mutation = mutations[i];
                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    // Check if added nodes look like message elements
                    for (let j = 0; j < mutation.addedNodes.length; j++) {
                        const node = mutation.addedNodes[j];
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            const el = node as Element;
                            // Heuristic: messages typically have text content and are not hidden
                            if (el.textContent && el.textContent.trim().length > 10) {
                                this.conversationMessageCount++;
                                this.context.logger.debug(`Message detected, count: ${this.conversationMessageCount}`);
                                // DOM trigger: scan message for JSONL function calls and ACK nonces
                                const text = el.textContent ?? '';
                                const domScanner = (window as unknown as Record<string, unknown>).mcpNotionDomScan as
                                    | { scan?: (t: string) => void } | undefined;
                                domScanner?.scan?.(text);
                                break;
                            }
                        }
                    }
                }
            }
        });

        this.messageObserver.observe(chatContent, {
            childList: true,
            subtree: true,
        });
    }

    // ── DOM observers ──────────────────────────────────────────────────

    private setupDOMObservers(): void {
        if (this.domObserversSetup) return;
        if (!this.isSupported()) {
            this.context.logger.debug('Not on /ai page, skipping DOM observers');
            return;
        }

        this.context.logger.debug('Setting up DOM observers for Notion adapter');

        this.mutationObserver = new MutationObserver((mutations) => {
            let shouldReinject = false;
            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    if (!document.getElementById('mcp-popover-container')) {
                        shouldReinject = true;
                        break;
                    }
                }
            }
            if (shouldReinject) {
                const insertionPoint = this.findButtonInsertionPoint();
                if (insertionPoint) {
                    this.context.logger.debug('MCP popover removed, re-injecting');
                    this.setupUIIntegration();
                }
            }
        });

        this.mutationObserver.observe(document.body, {
            childList: true,
            subtree: true,
        });

        this.domObserversSetup = true;
    }

    // ── UI integration (MCP popover) ───────────────────────────────────

    private setupUIIntegration(): void {
        if (!this.isSupported()) {
            this.context.logger.debug('Not on /ai page, skipping UI integration');
            return;
        }

        if (this.uiIntegrationSetup) {
            this.context.logger.debug('UI integration already set up, re-injecting for page changes');
        } else {
            this.context.logger.debug('Setting up UI integration for Notion adapter');
            this.uiIntegrationSetup = true;
        }

        this.waitForPageReady()
            .then(() => {
                if (!this.isSupported() || this.currentStatus !== 'active') {
                    this.context.logger.debug('Skipping MCP popover injection: no longer on /ai or adapter inactive');
                    return;
                }
                this.injectMCPPopoverWithRetry();
            })
            .catch((error) => {
                this.context.logger.warn('Failed to wait for page ready:', error);
            });
    }

    private async waitForPageReady(): Promise<void> {
        return new Promise((resolve, reject) => {
            let attempts = 0;
            const maxAttempts = 10;
            const checkReady = () => {
                attempts++;
                const insertionPoint = this.findButtonInsertionPoint();
                if (insertionPoint) {
                    this.context.logger.debug('Page ready for MCP popover injection');
                    resolve();
                } else if (attempts >= maxAttempts) {
                    this.context.logger.warn('Page ready check timed out');
                    reject(new Error('No insertion point found after maximum attempts'));
                } else {
                    setTimeout(checkReady, 500);
                }
            };
            setTimeout(checkReady, 100);
        });
    }

    private injectMCPPopoverWithRetry(maxRetries: number = 5): void {
        const attemptInjection = (attempt: number) => {
            if (!this.isSupported() || this.currentStatus !== 'active') {
                this.context.logger.debug('Skipping MCP popover injection: no longer on /ai or adapter inactive');
                return;
            }

            this.context.logger.debug(`Attempting MCP popover injection (attempt ${attempt}/${maxRetries})`);

            if (document.getElementById('mcp-popover-container')) {
                this.context.logger.debug('MCP popover already exists');
                return;
            }

            const insertionPoint = this.findButtonInsertionPoint();
            if (insertionPoint) {
                this.injectMCPPopover(insertionPoint);
            } else if (attempt < maxRetries) {
                this.context.logger.debug(`Insertion point not found, retrying in 1s (attempt ${attempt}/${maxRetries})`);
                setTimeout(() => attemptInjection(attempt + 1), 1000);
            } else {
                this.context.logger.warn('Failed to inject MCP popover after maximum retries');
            }
        };
        attemptInjection(1);
    }

    private findButtonInsertionPoint(): { container: Element; insertAfter: Element | null } | null {
        this.context.logger.debug('Finding button insertion point for MCP popover');

        // Try the plus menu button (data-testid="unified-chat-plus-menu-button")
        const plusButton = document.querySelector(this.selectors.BUTTON_INSERTION_CONTAINER);
        if (plusButton && plusButton.parentElement) {
            this.context.logger.debug('Found plus menu button, inserting MCP button after it');
            return { container: plusButton.parentElement, insertAfter: plusButton };
        }

        // Fallback: find the input area and insert before it
        const chatInput = document.querySelector(this.selectors.CHAT_INPUT);
        if (chatInput) {
            // Walk up to find a suitable container
            let container = chatInput.parentElement;
            for (let i = 0; i < 5 && container; i++) {
                if (container.children.length > 1) {
                    this.context.logger.debug('Found fallback insertion point near chat input');
                    return { container, insertAfter: null };
                }
                container = container.parentElement;
            }
        }

        this.context.logger.debug('Could not find suitable insertion point');
        return null;
    }

    private injectMCPPopover(insertionPoint: { container: Element; insertAfter: Element | null }): void {
        this.context.logger.debug('Injecting MCP popover into Notion AI interface');

        try {
            if (document.getElementById('mcp-popover-container')) {
                this.context.logger.debug('MCP popover already exists, skipping');
                return;
            }

            const reactContainer = document.createElement('div');
            reactContainer.id = 'mcp-popover-container';
            reactContainer.style.display = 'inline-block';
            reactContainer.style.margin = '0 4px';

            const { container, insertAfter } = insertionPoint;
            if (insertAfter && insertAfter.parentNode === container) {
                container.insertBefore(reactContainer, insertAfter.nextSibling);
            } else {
                container.appendChild(reactContainer);
            }

            this.mcpPopoverContainer = reactContainer;
            this.renderMCPPopover(reactContainer);

            this.context.logger.debug('MCP popover injected successfully');
        } catch (error) {
            this.context.logger.error('Failed to inject MCP popover:', error);
        }
    }

    private renderMCPPopover(container: HTMLElement): void {
        this.context.logger.debug('Rendering MCP popover');

        try {
            if (!container || !container.isConnected) {
                this.context.logger.warn('Container not connected to DOM, skipping render');
                return;
            }

            import('react').then((React) => {
                import('react-dom/client').then((ReactDOM) => {
                    import('../../components/mcpPopover/mcpPopover').then(({ MCPPopover }) => {
                        if (!container || !container.isConnected) {
                            this.context.logger.warn('Container became invalid during async import');
                            return;
                        }

                        const toggleStateManager = this.createToggleStateManager();
                        const adapterButtonConfig = {
                            className: 'mcp-notion-button-base',
                            contentClassName: 'mcp-notion-button-content',
                            textClassName: 'mcp-notion-button-text',
                            activeClassName: 'mcp-button-active',
                        };

                        try {
                            if (this.mcpPopoverRoot) {
                                try {
                                    this.mcpPopoverRoot.unmount();
                                } catch (unmountError) {
                                    this.context.logger.warn('Error unmounting existing React root:', unmountError);
                                }
                                this.mcpPopoverRoot = null;
                            }

                            this.mcpPopoverRoot = ReactDOM.createRoot(container);
                            this.mcpPopoverRoot.render(
                                React.createElement(MCPPopover, {
                                    toggleStateManager,
                                    adapterButtonConfig,
                                    adapterName: this.name,
                                }),
                            );

                            this.context.logger.debug('MCP popover rendered successfully');
                        } catch (renderError) {
                            this.context.logger.error('Error during React render:', renderError);
                            if (this.mcpPopoverRoot) {
                                try {
                                    this.mcpPopoverRoot.unmount();
                                } catch (e) {
                                    /* ignore */
                                }
                                this.mcpPopoverRoot = null;
                            }
                        }
                    }).catch((e) => this.context.logger.error('Failed to import MCPPopover:', e));
                }).catch((e) => this.context.logger.error('Failed to import ReactDOM:', e));
            }).catch((e) => this.context.logger.error('Failed to import React:', e));
        } catch (error) {
            this.context.logger.error('Failed to render MCP popover:', error);
        }
    }

    private createToggleStateManager() {
        const context = this.context;

        const stateManager = {
            getState: () => {
                try {
                    const uiState = context.stores.ui;
                    return {
                        mcpEnabled: uiState?.mcpEnabled ?? false,
                        autoInsert: uiState?.preferences?.autoInsert ?? false,
                        autoSubmit: uiState?.preferences?.autoSubmit ?? false,
                        autoExecute: uiState?.preferences?.autoExecute ?? false,
                    };
                } catch {
                    return { mcpEnabled: false, autoInsert: false, autoSubmit: false, autoExecute: false };
                }
            },

            setMCPEnabled: (enabled: boolean) => {
                context.logger.debug(`Setting MCP ${enabled ? 'enabled' : 'disabled'}`);
                try {
                    if (context.stores.ui?.setMCPEnabled) {
                        context.stores.ui.setMCPEnabled(enabled, 'mcp-popover-toggle');
                    } else if (context.stores.ui?.setSidebarVisibility) {
                        context.stores.ui.setSidebarVisibility(enabled, 'mcp-popover-toggle-fallback');
                    }

                    const sidebarManager = (window as any).activeSidebarManager;
                    if (sidebarManager) {
                        if (enabled) {
                            sidebarManager.show().catch((e: any) => context.logger.error('Error showing sidebar:', e));
                        } else {
                            sidebarManager.hide().catch((e: any) => context.logger.error('Error hiding sidebar:', e));
                        }
                    }
                } catch (error) {
                    context.logger.error('Error in setMCPEnabled:', error);
                }
                stateManager.updateUI();
            },

            setAutoInsert: (enabled: boolean) => {
                context.logger.debug(`Setting Auto Insert ${enabled ? 'enabled' : 'disabled'}`);
                if (context.stores.ui?.updatePreferences) {
                    context.stores.ui.updatePreferences({ autoInsert: enabled });
                }
                stateManager.updateUI();
            },

            setAutoSubmit: (enabled: boolean) => {
                context.logger.debug(`Setting Auto Submit ${enabled ? 'enabled' : 'disabled'}`);
                if (context.stores.ui?.updatePreferences) {
                    context.stores.ui.updatePreferences({ autoSubmit: enabled });
                }
                stateManager.updateUI();
            },

            setAutoExecute: (enabled: boolean) => {
                context.logger.debug(`Setting Auto Execute ${enabled ? 'enabled' : 'disabled'}`);
                if (context.stores.ui?.updatePreferences) {
                    context.stores.ui.updatePreferences({ autoExecute: enabled });
                }
                stateManager.updateUI();
            },

            updateUI: () => {
                const popoverContainer = document.getElementById('mcp-popover-container');
                if (popoverContainer) {
                    const currentState = stateManager.getState();
                    const event = new CustomEvent('mcp:update-toggle-state', {
                        detail: { toggleState: currentState },
                    });
                    popoverContainer.dispatchEvent(event);
                }
            },
        };

        return stateManager;
    }

    // ── Cleanup helpers ────────────────────────────────────────────────

    private cleanupDOMObservers(): void {
        if (this.mutationObserver) {
            this.mutationObserver.disconnect();
            this.mutationObserver = null;
        }
    }

    private cleanupUIIntegration(): void {
        this.context.logger.debug('Cleaning up UI integration for Notion adapter');

        try {
            if (this.mcpPopoverRoot) {
                try {
                    this.mcpPopoverRoot.unmount();
                } catch (e) {
                    this.context.logger.warn('Error unmounting React root:', e);
                }
                this.mcpPopoverRoot = null;
            }

            const popoverContainer = document.getElementById('mcp-popover-container');
            if (popoverContainer && popoverContainer.isConnected && popoverContainer.parentNode) {
                try {
                    popoverContainer.parentNode.removeChild(popoverContainer);
                } catch {
                    popoverContainer.remove();
                }
            }
        } catch (error) {
            this.context.logger.error('Error during UI integration cleanup:', error);
        }

        this.mcpPopoverContainer = null;
    }

    // ── Tool result mount point ────────────────────────────────────────

    /**
     * Find where to inject a tool result card in the Notion AI conversation UI.
     *
     * PR #33 revealed that app-level scroll containers are too broad: they can
     * create a full-width bottom card. Prefer a narrow chat-column wrapper near
     * the Notion AI input; fall back to the root only if no better column exists.
     */
    findToolResultMountPoint(_event?: { callId?: string; kind?: string }): ToolResultMountPoint | null {
        if (!this.isSupported()) return null;

        const root = document.querySelector(this.selectors.CHAT_CONTENT) as HTMLElement | null;
        if (!root) return null;

        const chatColumn = this.findChatColumnNearInput(root);
        if (chatColumn) {
            return { container: chatColumn, mode: 'append' as const };
        }

        const scrollContainer = this.findScrollableContainer(root);
        if (scrollContainer) {
            return { container: scrollContainer, mode: 'append' as const };
        }

        return { container: root, mode: 'append' as const };
    }

    /**
     * Find the narrow Notion AI chat column by walking upward from the input.
     * This is more stable than Stylex class selectors and avoids choosing the
     * full app-level scroll root.
     */
    private findChatColumnNearInput(root: HTMLElement): HTMLElement | null {
        const selectors = this.selectors.CHAT_INPUT.split(', ');
        let input: HTMLElement | null = null;
        for (const sel of selectors) {
            input = root.querySelector(sel.trim()) as HTMLElement | null;
            if (input) break;
        }
        if (!input) return null;

        let current: HTMLElement | null = input.parentElement;
        for (let depth = 0; depth < 8 && current && current !== root; depth++) {
            const rect = current.getBoundingClientRect();
            if (rect.width >= 500 && rect.width <= 900 && rect.height >= 80) {
                return current;
            }
            current = current.parentElement;
        }
        return null;
    }

    /**
     * Fallback only: find a large scrollable div. This must not be the preferred
     * path because it may select the app-level scroll container.
     */
    private findScrollableContainer(root: HTMLElement): HTMLElement | null {
        const divs = root.querySelectorAll('div');
        for (let i = 0; i < divs.length; i++) {
            const el = divs[i];
            const style = getComputedStyle(el);
            if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') continue;
            const rect = el.getBoundingClientRect();
            if (rect.width > 500 && rect.width < 1100 && rect.height > 300) {
                return el as HTMLElement;
            }
        }
        return null;
    }

    private handleToolExecutionCompleted(data: any): void {
        if (!this.shouldHandleEvents()) return;

        this.context.logger.debug('Handling tool execution in Notion adapter:', data);

        const uiState = this.context.stores.ui;
        if (uiState && data.execution) {
            this.context.logger.debug('Tool execution handled with architecture integration');
        }
    }
}
