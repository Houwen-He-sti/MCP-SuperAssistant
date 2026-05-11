/**
 * notionTurnDiscovery.ts — Notion AI Chat function result candidate discovery.
 *
 * Notion AI Chat has no stable semantic author markers (unlike ChatGPT's
 * data-message-author-role). Instead of CSS selectors, this module uses
 * JS-based turn lane discovery:
 *
 * 1. Find all .notion-selectable-container elements
 * 2. Within each, discover "turn lanes" — elements whose direct children
 *    look like conversation turns (multiple siblings, at least one containing
 *    function_results text)
 * 3. From turn lanes, select user turn candidates:
 *    - textContent contains <function_results or <function_result
 *    - does NOT contain [data-content-editable-root] (AI response marker)
 *
 * Gate 6 Lane B — consensus with GPT: approach C + guarded B.
 * Not depending on childCount, not depending on fixed wrapper depth.
 */

/**
 * Check if the current page is a Notion host.
 */
export function isNotionHost(hostname: string): boolean {
    return hostname === 'notion.so' || hostname.endsWith('.notion.so');
}

/**
 * Fast prefilter: does text look like it might contain function result XML?
 * This is intentionally broad — actual parsing is done by functionResultParser.
 */
export function containsFunctionResultLikeText(text: string): boolean {
    return text.includes('<function_results') || text.includes('<function_result ');
}

/**
 * Find elements that look like "turn lanes" — containers whose direct children
 * are conversation turns. A turn lane is identified by:
 * - Has >= 2 direct HTMLElement children
 * - At least one direct child's textContent contains function_results-like text
 *
 * This avoids hardcoding wrapper depth (e.g. `:scope > div`).
 */
export function findPossibleTurnLanes(container: HTMLElement): HTMLElement[] {
    const lanes: HTMLElement[] = [];

    // Check the container itself and all descendant divs
    const candidates = [container, ...Array.from(container.querySelectorAll('div'))];

    for (const node of candidates) {
        if (!(node instanceof HTMLElement)) continue;

        const directChildren = Array.from(node.children).filter(
            (child): child is HTMLElement => child instanceof HTMLElement,
        );

        // A turn lane should have multiple turn children
        if (directChildren.length < 2) continue;

        // At least one direct child must contain function_results text
        const hasFunctionResultChild = directChildren.some(child =>
            containsFunctionResultLikeText(child.textContent || ''),
        );

        if (!hasFunctionResultChild) continue;

        lanes.push(node);
    }

    return lanes;
}

/**
 * Get Notion AI chat function result candidates.
 *
 * Scans all .notion-selectable-container elements, discovers turn lanes,
 * and returns user turn elements that contain function_results XML but
 * are NOT AI response turns.
 *
 * @param root - The root node to search within (defaults to document for production,
 *               can be a test container for unit tests)
 */
export function getNotionFunctionResultCandidates(root: ParentNode = document): HTMLElement[] {
    const candidates: HTMLElement[] = [];

    const containers = Array.from(root.querySelectorAll('.notion-selectable-container'));

    for (const container of containers) {
        if (!(container instanceof HTMLElement)) continue;

        const lanes = findPossibleTurnLanes(container);

        for (const lane of lanes) {
            for (const child of Array.from(lane.children)) {
                if (!(child instanceof HTMLElement)) continue;

                const text = child.textContent || '';

                // Guard 1: must contain function_results-like text
                if (!containsFunctionResultLikeText(text)) continue;

                // Guard 2: must NOT contain AI content root
                // In Notion AI Chat, AI responses live under [data-content-editable-root]
                if (child.querySelector('[data-content-editable-root]')) continue;

                // Guard 3: deduplicate — don't add the same element twice
                if (!candidates.includes(child)) {
                    candidates.push(child);
                }
            }
        }
    }

    return candidates;
}
