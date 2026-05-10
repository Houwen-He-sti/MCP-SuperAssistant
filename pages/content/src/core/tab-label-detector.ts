/**
 * Tab Label Detector
 *
 * Detects ai-web-agent-mcp tab labels injected via:
 *   1. window.name = "__AIWEB__<label>"
 *   2. document.title prefix "[<label>] ..."
 *
 * Reports detected labels to the background script and monitors for changes.
 */

import { createLogger } from '@extension/shared/lib/logger';

const logger = createLogger('TabLabelDetector');

const AIWEB_PREFIX = '__AIWEB__';
const WINDOW_NAME_POLL_INTERVAL = 5000; // 5 seconds

/** Known AI platforms and their label prefixes (must match ai-web-agent-mcp). */
const KNOWN_PLATFORM_PREFIXES: Record<string, string> = {
    'chatgpt.com': 'gpt-tab',
    'notion.so': 'notion-tab',
    'chat.deepseek.com': 'deepseek-tab',
    'perplexity.ai': 'perplexity-tab',
    'gemini.google.com': 'gemini-tab',
    'claude.ai': 'claude-tab',
};

export interface DetectedLabel {
    label: string;
    source: 'window-name' | 'title-prefix';
}

/**
 * Pure detection logic: check given values for a tab label.
 * Exported for unit testing — no browser globals accessed.
 */
export function detectFromValues(windowName: string, documentTitle: string): DetectedLabel | null {
    // Primary: window.name with __AIWEB__ namespace
    if (windowName?.startsWith(AIWEB_PREFIX)) {
        const label = windowName.slice(AIWEB_PREFIX.length);
        if (label) {
            return { label, source: 'window-name' };
        }
    }

    // Fallback: parse [label] prefix from document.title
    if (documentTitle) {
        const match = documentTitle.match(/^\[([^\]]+)\]/);
        if (match?.[1]) {
            return { label: match[1], source: 'title-prefix' };
        }
    }

    return null;
}

/**
 * One-shot detection: check window.name and document.title for a label.
 */
export function detectTabLabel(): DetectedLabel | null {
    const wn = typeof window !== 'undefined' ? (window.name ?? '') : '';
    const dt = typeof document !== 'undefined' ? (document.title ?? '') : '';
    return detectFromValues(wn, dt);
}

/**
 * Report a detected (or cleared) label to the background script.
 */
function reportLabel(detected: DetectedLabel | null): void {
    const url = typeof window !== 'undefined' ? window.location.href : '';
    try {
        chrome.runtime.sendMessage({
            type: 'mcp:tab-label-report',
            payload: {
                label: detected?.label ?? null,
                source: detected?.source ?? null,
                url,
            },
            origin: 'content',
            timestamp: Date.now(),
        });
        lastReportedUrl = url;
        if (detected) {
            logger.debug(`Reported label "${detected.label}" (source: ${detected.source}) url=${url}`);
        } else {
            logger.debug('Reported label cleared');
        }
    } catch (err) {
        logger.error('Failed to report tab label:', err);
    }
}

/**
 * Ensure document.title has the [label] prefix.
 * Called when we detect a label from window.name but the title is missing its prefix.
 * This acts as a fallback when ai-web-agent-mcp's own persistence fails (e.g. after refresh on SPAs).
 */
export function ensureTitlePrefix(label: string): boolean {
    if (typeof document === 'undefined') return false;
    const tag = `[${label}]`;
    if (document.title.startsWith(tag)) return false;

    // Strip any existing stale prefix first
    const stripped = document.title.replace(/^\[.*?\]\s*/, '');
    document.title = stripped ? `${tag} ${stripped}` : tag;
    logger.debug(`Restored title prefix: ${tag}`);
    return true;
}

let currentLabel: string | null = null;
let lastReportedUrl: string | null = null;
let titleObserver: MutationObserver | null = null;
let headObserver: MutationObserver | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let autoLabelRequested = false;

/**
 * Get the label prefix for the current page's platform, or null if unknown.
 */
function getKnownPlatformPrefix(): string | null {
    if (typeof window === 'undefined') return null;
    const host = window.location.hostname;
    for (const [domain, prefix] of Object.entries(KNOWN_PLATFORM_PREFIXES)) {
        if (host.endsWith(domain)) return prefix;
    }
    return null;
}

/**
 * Request an auto-generated label from the background script.
 * Only runs once per page load — sets window.name and title prefix on success.
 */
async function requestAutoLabel(): Promise<void> {
    if (autoLabelRequested) return;
    autoLabelRequested = true;

    const prefix = getKnownPlatformPrefix();
    if (!prefix) return;

    try {
        const response = await chrome.runtime.sendMessage({
            type: 'mcp:request-auto-label',
            payload: { prefix },
            origin: 'content',
            timestamp: Date.now(),
        });

        if (response?.payload?.label) {
            const label = response.payload.label;
            window.name = AIWEB_PREFIX + label;
            ensureTitlePrefix(label);
            currentLabel = label;
            reportLabel({ label, source: 'window-name' });
            logger.debug(`Auto-assigned label: ${label}`);
        }
    } catch (err) {
        logger.error('Failed to request auto-label:', err);
        autoLabelRequested = false; // Allow retry on next poll
    }
}

/**
 * Check for label changes, ensure title prefix, and report if changed.
 */
function checkAndReport(): void {
    const detected = detectTabLabel();
    const newLabel = detected?.label ?? null;

    // Ensure title prefix when we have a label from window.name
    if (detected && detected.source === 'window-name') {
        ensureTitlePrefix(detected.label);
    }

    // Re-report if label changed OR URL changed (SPA navigation)
    const currentUrl = typeof window !== 'undefined' ? window.location.href : '';
    const labelChanged = newLabel !== currentLabel;
    const urlChanged = detected && currentUrl !== lastReportedUrl;

    if (labelChanged || urlChanged) {
        currentLabel = newLabel;
        reportLabel(detected);
    }

    // If no label detected on a known platform, request auto-labeling
    if (!detected && !autoLabelRequested) {
        requestAutoLabel();
    }
}

/**
 * Observe the current <title> element for mutations.
 * When title changes, re-check the label and re-apply prefix if needed.
 */
let _insideObserverCallback = false;
function observeTitle(): void {
    if (titleObserver) {
        titleObserver.disconnect();
        titleObserver = null;
    }
    const titleEl = document.querySelector('title');
    if (titleEl) {
        titleObserver = new MutationObserver(() => {
            // Guard against re-entrancy: our own ensureTitlePrefix triggers a mutation
            if (_insideObserverCallback) return;
            _insideObserverCallback = true;
            try {
                checkAndReport();
            } finally {
                _insideObserverCallback = false;
            }
        });
        titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
}

/**
 * Start continuous monitoring for label changes.
 * Idempotent — safe to call multiple times.
 *
 * - MutationObserver on <title> for title-prefix changes
 * - MutationObserver on <head> to detect SPA title element replacement
 * - Periodic poll for window.name changes (no event API for window.name)
 */
export function startLabelMonitoring(): void {
    // Stop any existing monitoring first (idempotent)
    stopLabelMonitoring();

    // Initial detection
    checkAndReport();

    // Watch <title> mutations
    observeTitle();

    // Watch <head> for added/removed <title> elements (SPA frameworks may replace <title>)
    const head = document.head;
    if (head) {
        headObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                const titleChanged = Array.from(m.addedNodes).some(n => (n as Element).tagName === 'TITLE') ||
                    Array.from(m.removedNodes).some(n => (n as Element).tagName === 'TITLE');
                if (titleChanged) {
                    observeTitle();
                    checkAndReport();
                    break;
                }
            }
        });
        headObserver.observe(head, { childList: true });
    }

    // Poll window.name periodically (no event for window.name changes)
    pollTimer = setInterval(() => checkAndReport(), WINDOW_NAME_POLL_INTERVAL);
    logger.debug('Label monitoring started');
}

/**
 * Stop monitoring.
 */
export function stopLabelMonitoring(): void {
    if (titleObserver) {
        titleObserver.disconnect();
        titleObserver = null;
    }
    if (headObserver) {
        headObserver.disconnect();
        headObserver = null;
    }
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    logger.debug('Label monitoring stopped');
}
