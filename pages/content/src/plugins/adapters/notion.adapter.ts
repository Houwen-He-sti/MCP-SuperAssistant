import type { AdapterCapability, PluginContext } from '../plugin-types';
import { BaseAdapterPlugin } from './base.adapter';

/**
 * Notion AI Adapter for Notion AI Chat (notion.so/ai)
 *
 * This adapter provides functionality for interacting with Notion AI's
 * chat interface, including text insertion and form submission.
 *
 * Phase 1: Only supports the /ai chat panel. Does not activate on
 * regular Notion pages, databases, or settings.
 */

export class NotionAdapter extends BaseAdapterPlugin {
    readonly name = 'NotionAdapter';
    readonly version = '1.0.0';
    readonly hostnames = ['notion.so', 'www.notion.so'];
    readonly capabilities: AdapterCapability[] = [
        'text-insertion',
        'form-submission',
        'dom-manipulation',
    ];

    // CSS selectors for Notion AI's UI elements (discovered via CDP DOM exploration)
    private readonly selectors = {
        // Primary chat input — contenteditable div with role="textbox"
        CHAT_INPUT:
            'div[role="textbox"][contenteditable="true"], div.content-editable-leaf-rtl[contenteditable="true"]',
        // Send button — data-testid provided by Notion
        SUBMIT_BUTTON: '[data-testid="agent-send-message-button"]',
        // Chat conversation content — lives inside .notion-app-inner (not the sidebar scroller)
        CHAT_CONTENT: '.notion-app-inner',
        // Button insertion points for MCP popover — near the plus menu button
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

    /**
     * Route gating: activate on Notion AI pages (/ai, /chat, /agent paths).
     * Prevents interference with normal Notion pages.
     */
    isSupported(): boolean {
        const path = window.location.pathname;
        return path === '/ai' || path.startsWith('/ai/') || path.startsWith('/chat') || path.startsWith('/agent/');
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

        // Only set up DOM/UI if we're on the /ai page
        if (this.isSupported()) {
            this.wasOnAiPage = true;
            this.setupDOMObservers();
            this.setupUIIntegration();
        } else {
            this.context.logger.debug('Not on /ai page, skipping DOM/UI setup');
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

    async cleanup(): Promise<void> {
        await super.cleanup();
        this.context.logger.debug('Cleaning up Notion AI adapter...');

        if (this.urlCheckInterval) {
            clearInterval(this.urlCheckInterval);
            this.urlCheckInterval = null;
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
     */
    async insertText(text: string, options?: { targetElement?: HTMLElement }): Promise<boolean> {
        if (!this.isSupported()) {
            this.context.logger.debug('Not on /ai page, skipping insertText');
            return false;
        }

        this.context.logger.debug(`Inserting text into Notion AI input: ${text.substring(0, 50)}…`);

        let target: HTMLElement | null = options?.targetElement ?? null;

        if (!target) {
            const selectors = this.selectors.CHAT_INPUT.split(', ');
            for (const sel of selectors) {
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

            // Select all existing content so new text replaces it
            const selection = window.getSelection();
            if (selection) {
                const range = document.createRange();
                range.selectNodeContents(target);
                selection.removeAllRanges();
                selection.addRange(range);
            }

            const newContent = originalContent ? originalContent + '\n' + text : text;

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
            if (!finalContent.includes(text)) {
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
     * Submit the current text in the Notion AI chat input by clicking the send button.
     */
    async submitForm(options?: { formElement?: HTMLFormElement }): Promise<boolean> {
        if (!this.isSupported()) {
            this.context.logger.debug('Not on /ai page, skipping submitForm');
            return false;
        }

        this.context.logger.debug('Attempting to submit Notion AI chat input');

        const submitButton = document.querySelector(this.selectors.SUBMIT_BUTTON) as HTMLElement | null;

        if (!submitButton) {
            this.context.logger.error('Could not find Notion AI send button');
            this.emitExecutionFailed('submitForm', 'Send button not found');
            return false;
        }

        try {
            // Check visibility
            const rect = submitButton.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) {
                this.context.logger.warn('Notion AI send button is not visible');
                this.emitExecutionFailed('submitForm', 'Send button is not visible');
                return false;
            }

            // Check disabled state (Notion uses DIV, so check aria-disabled and pointer-events)
            if (submitButton.getAttribute('aria-disabled') === 'true' ||
                (submitButton as any).disabled === true ||
                window.getComputedStyle(submitButton).pointerEvents === 'none') {
                this.context.logger.warn('Notion AI send button is disabled');
                this.emitExecutionFailed('submitForm', 'Send button is disabled');
                return false;
            }

            submitButton.click();

            this.emitExecutionCompleted('submitForm', {
                formElement: options?.formElement?.tagName || 'unknown',
            }, {
                success: true,
                method: 'submitButton.click',
                buttonSelector: this.selectors.SUBMIT_BUTTON,
            });

            this.context.logger.debug('Notion AI chat input submitted successfully');
            return true;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.context.logger.error(`Error submitting Notion AI chat input: ${msg}`);
            this.emitExecutionFailed('submitForm', msg);
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
                        // Navigated TO /ai — set up DOM/UI
                        this.context.logger.debug('Navigated to /ai, setting up DOM/UI');
                        this.wasOnAiPage = true;
                        this.setupDOMObservers();
                        this.setupUIIntegration();
                    } else if (!nowOnAi && this.wasOnAiPage) {
                        // Navigated AWAY from /ai — tear down DOM/UI
                        this.context.logger.debug('Navigated away from /ai, cleaning up DOM/UI');
                        this.wasOnAiPage = false;
                        this.cleanupUIIntegration();
                        this.cleanupDOMObservers();
                        this.domObserversSetup = false;
                        this.uiIntegrationSetup = false;
                    }
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

    private handleToolExecutionCompleted(data: any): void {
        if (!this.shouldHandleEvents()) return;

        this.context.logger.debug('Handling tool execution in Notion adapter:', data);

        const uiState = this.context.stores.ui;
        if (uiState && data.execution) {
            this.context.logger.debug('Tool execution handled with architecture integration');
        }
    }
}
