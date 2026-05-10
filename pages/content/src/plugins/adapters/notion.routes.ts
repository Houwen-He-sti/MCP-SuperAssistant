/**
 * Pure route-matching functions for NotionAdapter.
 *
 * Extracted from the class so they can be unit-tested without DOM,
 * PluginContext, or module mocking.
 *
 * @module notion.routes
 */

// ── Legacy path detection ──────────────────────────────────────────

/**
 * Returns true if the pathname belongs to a legacy Notion AI panel
 * (/ai, /ai/*, /agent/*).
 *
 * Note: /chat is NOT a legacy path — it is the native Notion AI chat route.
 */
export function isLegacyPath(pathname: string): boolean {
    return pathname === '/ai'
        || pathname.startsWith('/ai/')
        || pathname.startsWith('/agent/');
}

// ── Native AI agent route ──────────────────────────────────────────

/**
 * Returns true if the pathname is a native AI agent route.
 * Native AI agent appears on /chat and regular Notion workspace pages,
 * but not on /ai or /agent/.
 *
 * /chat is the dedicated native AI chat page (always a native route).
 * Other non-legacy paths require DOM verification by the caller.
 *
 * IMPORTANT: This only checks the URL. The caller MUST also verify
 * that the native AI DOM elements (e.g. NATIVE_SUBMIT_BUTTON) exist
 * before treating the page as a native AI agent.
 */
export function isNativeAiRoute(pathname: string): boolean {
    // /chat is the native Notion AI chat page
    if (pathname.startsWith('/chat')) return true;
    // Any path that is not a legacy path is potentially native
    return !isLegacyPath(pathname);
}

// ── Supported path detection ───────────────────────────────────────

/**
 * Returns true if the pathname+DOM combination indicates a supported
 * Notion AI page.
 *
 * @param pathname   - window.location.pathname
 * @param hasNativeInput - whether a native AI chat input element exists on the page
 */
export function isSupportedPath(pathname: string, hasNativeInput: boolean): boolean {
    // Legacy paths (/ai, /agent/) are always supported
    if (isLegacyPath(pathname)) return true;

    // /chat is always supported (native AI chat page)
    if (pathname.startsWith('/chat')) return true;

    // Other Notion pages require native AI input element
    if (hasNativeInput) return true;

    return false;
}

// ── Bridge prompt injection guard ──────────────────────────────────

/**
 * Pure decision function: should the bridge prompt be injected?
 *
 * @param isNative   - isNativeAiAgent() result (route + DOM verified)
 * @param alreadyInjected - bridge prompt already sent this session
 * @param messageCount - number of conversation messages so far
 * @param inputContent  - current content of the chat input element
 */
export function shouldInjectBridgePrompt(
    isNative: boolean,
    alreadyInjected: boolean,
    messageCount: number,
    inputContent: string,
): boolean {
    return isNative
        && !alreadyInjected
        && messageCount === 0
        && !inputContent.trim();
}
