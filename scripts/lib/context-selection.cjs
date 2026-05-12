/**
 * Frame-aware CDP execution context selection.
 *
 * Extracts context selection logic into pure functions so it can be
 * unit-tested without a live browser.
 *
 * Fixes the original preflight bug where the first `notion.so` MAIN context
 * was selected — which could be an iframe (aif.notion.so) instead of the
 * top frame (www.notion.so/agent/...).
 *
 * @see e2e-notion-pipeline-preflight.cjs
 * @see debug_frame-aware-probe.cjs
 */

/**
 * Extract the top frame's frameId from a Page.getFrameTree result.
 *
 * @param {object} frameTreeResult - CDP Page.getFrameTree response
 * @returns {string|null} frameId of the top frame
 */
function getTopFrameId(frameTreeResult) {
    const tree = frameTreeResult?.result?.frameTree;
    if (!tree) return null;
    return tree.frame?.id || null;
}

/**
 * Select the MAIN world execution context for the Notion top frame.
 *
 * Selection criteria (all must match):
 *   1. origin includes 'notion.so'
 *   2. NOT an isolated world (auxData.type !== 'isolated')
 *   3. frameId matches the top frame's frameId
 *
 * If frameId matching is not possible (e.g. frameTree unavailable),
 * falls back to selecting the context where `window.top === window`
 * would be true — i.e. the one whose origin is the agent page, not
 * aif.notion.so or identity.notion.so.
 *
 * @param {Array} contexts - Array of Runtime.executionContextCreated contexts
 * @param {string|null} topFrameId - frameId from getTopFrameId()
 * @returns {object|null} The selected context, or null
 */
function selectNotionMainContext(contexts, topFrameId) {
    if (!Array.isArray(contexts) || contexts.length === 0) return null;

    // Strategy 1: frameId match (most reliable)
    if (topFrameId) {
        const match = contexts.find(c =>
            c.origin && c.origin.includes('notion.so') &&
            (!c.name || c.name === '') &&
            c.auxData?.type !== 'isolated' &&
            c.auxData?.frameId === topFrameId
        );
        if (match) return match;
    }

    // Strategy 2: exclude known iframe origins
    // aif.notion.so = Notion's AI frontend iframe
    // identity.notion.so = auth sync iframe
    const candidates = contexts.filter(c =>
        c.origin && c.origin.includes('notion.so') &&
        (!c.name || c.name === '') &&
        c.auxData?.type !== 'isolated' &&
        !c.origin.includes('aif.notion.so') &&
        !c.origin.includes('identity.notion.so')
    );

    // If exactly one candidate, use it
    if (candidates.length === 1) return candidates[0];

    // If multiple, prefer the one with /agent/ in origin or that is www.notion.so
    if (candidates.length > 1) {
        const agentCtx = candidates.find(c => c.origin.includes('www.notion.so'));
        if (agentCtx) return agentCtx;
        return candidates[0]; // last resort
    }

    return null;
}

/**
 * Select the extension's isolated world context in the top frame.
 *
 * @param {Array} contexts - Array of Runtime.executionContextCreated contexts
 * @param {string} extensionId - The extension's ID (from resolveExtensionId)
 * @param {string|null} topFrameId - frameId from getTopFrameId()
 * @returns {object|null} The selected context, or null
 */
function selectExtensionIsolatedContext(contexts, extensionId, topFrameId) {
    if (!Array.isArray(contexts) || contexts.length === 0) return null;
    if (!extensionId) return null;

    // Strategy 1: frameId + extension origin match
    if (topFrameId) {
        const match = contexts.find(c =>
            c.origin && c.origin.includes(extensionId) &&
            c.auxData?.frameId === topFrameId
        );
        if (match) return match;
    }

    // Strategy 2: extension origin + name match (less reliable — may pick iframe context)
    const byOrigin = contexts.filter(c =>
        c.origin && c.origin.includes(extensionId)
    );

    // Prefer the one with 'MCP SuperAssistant' in name
    const named = byOrigin.find(c => c.name && c.name.includes('MCP SuperAssistant'));
    if (named) return named;

    // Prefer the one in the top frame (by excluding known iframe frameIds)
    if (byOrigin.length === 1) return byOrigin[0];

    return byOrigin[0] || null;
}

/**
 * Assess fetch interceptor status, accounting for Sentry wrapping.
 *
 * Sentry's SDK wraps window.fetch after our interceptor installs,
 * hiding our `__mcpSaWrapped` marker on the outer function. But our
 * interceptor code is still in the call chain underneath.
 *
 * Assessment tiers:
 *   - ACTIVE: installKey=true, fetch is not native → interceptor is in chain
 *   - LIKELY_ACTIVE: installKey=true, fetchWrapped=false but fetchIsNative=false
 *     (Sentry or other wrapper is hiding our marker)
 *   - NOT_INSTALLED: installKey=false → interceptor never ran
 *   - NATIVE: fetch is native code → no wrapping at all
 *
 * @param {object} fetchState - Result of evaluating fetch markers in MAIN context
 * @returns {{ status: string, tier: string, detail: string }}
 */
function assessFetchInterceptor(fetchState) {
    if (!fetchState) {
        return { status: 'FAIL', tier: 'NO_DATA', detail: 'No fetch state data available' };
    }

    const { installKey, fetchWrapped, fetchIsNative } = fetchState;

    if (!installKey) {
        return {
            status: 'FAIL',
            tier: 'NOT_INSTALLED',
            detail: 'installKey=false — stream-interceptor-main never ran in this context'
        };
    }

    // installKey=true from here
    if (fetchWrapped) {
        return {
            status: 'PASS',
            tier: 'ACTIVE',
            detail: 'installKey=true, __mcpSaWrapped=true — interceptor fully active'
        };
    }

    if (!fetchIsNative) {
        // installKey=true, fetch is wrapped but __mcpSaWrapped is hidden
        // Most likely Sentry (or another SDK) wrapped on top
        return {
            status: 'PASS',
            tier: 'LIKELY_ACTIVE',
            detail: 'installKey=true, fetchWrapped=false but fetchIsNative=false — interceptor active under Sentry/SDK wrapper'
        };
    }

    // installKey=true but fetch appears native — inconsistent state
    return {
        status: 'FAIL',
        tier: 'INCONSISTENT',
        detail: 'installKey=true but fetch appears native — interceptor installed but fetch was restored to native after'
    };
}

module.exports = {
    getTopFrameId,
    selectNotionMainContext,
    selectExtensionIsolatedContext,
    assessFetchInterceptor,
};
