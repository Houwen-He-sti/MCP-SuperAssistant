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

export interface DetectedLabel {
  label: string;
  source: 'window-name' | 'title-prefix';
}

/**
 * One-shot detection: check window.name and document.title for a label.
 */
export function detectTabLabel(): DetectedLabel | null {
  // Primary: window.name with __AIWEB__ namespace
  if (typeof window !== 'undefined' && window.name?.startsWith(AIWEB_PREFIX)) {
    const label = window.name.slice(AIWEB_PREFIX.length);
    if (label) {
      return { label, source: 'window-name' };
    }
  }

  // Fallback: parse [label] prefix from document.title
  if (typeof document !== 'undefined' && document.title) {
    const match = document.title.match(/^\[([^\]]+)\]/);
    if (match?.[1]) {
      return { label: match[1], source: 'title-prefix' };
    }
  }

  return null;
}

/**
 * Report a detected label to the background script.
 */
function reportLabel(detected: DetectedLabel): void {
  try {
    chrome.runtime.sendMessage({
      type: 'mcp:tab-label-report',
      payload: {
        label: detected.label,
        source: detected.source,
      },
      origin: 'content',
      timestamp: Date.now(),
    });
    logger.debug(`Reported label "${detected.label}" (source: ${detected.source})`);
  } catch (err) {
    logger.error('Failed to report tab label:', err);
  }
}

let currentLabel: string | null = null;
let titleObserver: MutationObserver | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Check for label changes and report if changed.
 */
function checkAndReport(): void {
  const detected = detectTabLabel();
  const newLabel = detected?.label ?? null;

  if (newLabel !== currentLabel) {
    currentLabel = newLabel;
    if (detected) {
      reportLabel(detected);
    }
  }
}

/**
 * Start continuous monitoring for label changes.
 *
 * - MutationObserver on <title> for title-prefix changes
 * - Periodic poll for window.name changes (no event API for window.name)
 */
export function startLabelMonitoring(): void {
  // Initial detection
  checkAndReport();

  // Watch <title> mutations
  const titleEl = document.querySelector('title');
  if (titleEl) {
    titleObserver = new MutationObserver(() => checkAndReport());
    titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
    logger.debug('Title MutationObserver started');
  }

  // Poll window.name periodically (no event for window.name changes)
  pollTimer = setInterval(() => checkAndReport(), WINDOW_NAME_POLL_INTERVAL);
  logger.debug('window.name polling started');
}

/**
 * Stop monitoring.
 */
export function stopLabelMonitoring(): void {
  if (titleObserver) {
    titleObserver.disconnect();
    titleObserver = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  logger.debug('Label monitoring stopped');
}
