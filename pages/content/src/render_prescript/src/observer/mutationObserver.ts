import { CONFIG } from '../core/config';
import { debounce } from '../utils/index';
import { renderFunctionCall, renderedFunctionBlocks, processedElements } from '../renderer/index';
import { stabilizeBlock, unstabilizeBlock } from '../renderer/components';
import {
  monitorNode,
  streamingObservers,
  updateQueue,
  streamingLastUpdated,
  startProgressiveUpdates,
} from './streamObserver';
import type { StabilizedBlock } from '../core/types';
import { streamingContentLengths } from '../parser/index';
import { getStandaloneCodeBlockElement, hasFunctionCallLikePattern, isStandaloneCodeBlock } from '../parser/functionCallValidator';
import {
  preExistingIncompleteBlocks,
  startStalledStreamDetection,
  stopStalledStreamDetection,
} from './stalledStreamHandler';
import { createLogger } from '@extension/shared/lib/logger';

// State for processing and observers
let isProcessing = false;
let functionCallObserver: MutationObserver | null = null;
let updateThrottleTimer: ReturnType<typeof setTimeout> | null = null;
let toolRegistryUpdateListener: (() => void) | null = null;

const logger = createLogger('MutationObserver');

// Extend window type
declare global {
  interface Window {
    _isProcessing?: boolean;
    _updateQueue?: Map<string, HTMLElement>;
    _stalledStreams?: Set<string>;
    _stalledStreamRetryCount?: Map<string, number>;
    _processUpdateQueue?: () => void;
    preExistingIncompleteBlocks?: Set<string>;
  }
}

/**
 * Process queued updates with stabilization for smoothness
 */
export const processUpdateQueue = (): void => {
  const validUpdates = new Map<string, HTMLElement>();
  updateQueue.forEach((node, blockId) => {
    if (document.body.contains(node)) {
      validUpdates.set(blockId, node);
      // Update the last updated timestamp
      streamingLastUpdated.set(blockId, Date.now());
      // If previously marked as stalled, remove that marker
      if (window._stalledStreams && window._stalledStreams.has(blockId)) {
        window._stalledStreams.delete(blockId);
        const stalledIndicator = document.querySelector(`.stalled-indicator[data-stalled-for="${blockId}"]`);
        if (stalledIndicator) stalledIndicator.remove();
      }
    } else {
      if (CONFIG.debug) logger.debug(`Node for block ${blockId} removed, skipping update and cleaning up.`);
      const observer = streamingObservers.get(blockId);
      if (observer) {
        observer.disconnect();
        streamingObservers.delete(blockId);
      }
      renderedFunctionBlocks.delete(blockId);
      streamingLastUpdated.delete(blockId);
      if (window._stalledStreams) window._stalledStreams.delete(blockId);
      // Clean up keys starting with blockId- from streamingContentLengths
      Array.from(streamingContentLengths.keys())
        .filter(key => key.startsWith(`${blockId}-`))
        .forEach(key => streamingContentLengths.delete(key));
    }
  });

  if (validUpdates.size === 0) {
    updateQueue.clear();
    if (isProcessing) {
      isProcessing = false;
      window._isProcessing = false;
    }
    return;
  }

  updateQueue.clear();
  validUpdates.forEach((node, blockId) => updateQueue.set(blockId, node));

  if (isProcessing) return;
  isProcessing = true;
  window._isProcessing = true;

  const stabilizedBlocks = new Map<string, StabilizedBlock>();

  try {
    // if (CONFIG.usePositionFixed) {
    //     updateQueue.forEach((node, blockId) => {
    //         const stabilized = stabilizeBlock(blockId);
    //         if (stabilized) {
    //             stabilizedBlocks.set(blockId, stabilized);
    //         }
    //     });
    // }

    updateQueue.forEach((node, blockId) => {
      if (CONFIG.debug) logger.debug(`Processing update for block: ${blockId}`);
      renderFunctionCall(node as HTMLPreElement, { current: isProcessing });
    });

    updateQueue.clear();

    const hasLargeStreaming = Array.from(streamingContentLengths.values()).some(
      length => length > CONFIG.largeContentThreshold,
    );

    if (hasLargeStreaming) {
      startProgressiveUpdates();
    }
  } catch (e) {
    logger.error('Error processing update queue:', e);
  } finally {
    // if (stabilizedBlocks.size > 0) {
    //     setTimeout(() => {
    //         stabilizedBlocks.forEach((stabilized) => {
    //             unstabilizeBlock(stabilized);
    //         });
    //     }, CONFIG.stabilizeTimeout);
    // }
    isProcessing = false;
    window._isProcessing = false;
  }
};

// Expose shared state to window
if (typeof window !== 'undefined') {
  window._isProcessing = isProcessing;
  window._updateQueue = updateQueue;
  window._stalledStreams = window._stalledStreams || new Set<string>();
  window._stalledStreamRetryCount = window._stalledStreamRetryCount || new Map<string, number>();
  window.preExistingIncompleteBlocks = preExistingIncompleteBlocks;
  window._processUpdateQueue = processUpdateQueue;
}

/**
 * Process all function calls in the document
 */
export const processFunctionCalls = (): number => {
  const processedCount = checkForUnprocessedFunctionCalls();
  return processedCount;
};

/**
 * Check for unprocessed function calls in the document
 */
export const checkForUnprocessedFunctionCalls = (): number => {
  let processedCount = 0;

  // Get all pre/code elements in the document that might contain function calls
  const getTargetElements = (): HTMLElement[] => {
    const elements: HTMLElement[] = [];
    const seen = new Set<HTMLElement>();
    for (const selector of CONFIG.targetSelectors) {
      const found = document.querySelectorAll<HTMLElement>(selector);
      for (const element of Array.from(found)) {
        const standalone = getStandaloneCodeBlockElement(element);
        if (standalone && !seen.has(standalone)) {
          seen.add(standalone);
          elements.push(standalone);
        }
      }
    }
    return elements;
  };

  // Process each target element
  const elements = getTargetElements();
  for (const element of elements) {
    if (isStandaloneCodeBlock(element) && !processedElements.has(element) && !element.closest('.function-block')) {
      const blockId =
        element.getAttribute('data-block-id') || `block-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      const result = renderFunctionCall(element as HTMLPreElement, { current: false });
      if (result) {
        processedCount++;
        monitorNode(element, blockId);
      }
    }
  }

  return processedCount;
};

/**
 * Start direct monitoring of content for function calls
 */
export const startDirectMonitoring = (): void => {
  if (!CONFIG.enableDirectMonitoring) return;

  // Start with a clean slate
  stopDirectMonitoring();

  // Process any existing function calls
  processFunctionCalls();

  // Set up stalled stream detection
  startStalledStreamDetection();

  // Define a function to observe DOM changes and process new function calls
  const handleDomChanges = debounce(() => {
    if (!isProcessing) {
      const processedCount = checkForUnprocessedFunctionCalls();
      if (processedCount > 0 && CONFIG.debug) {
        logger.debug(`Processed ${processedCount} new function blocks`);
      }
    }
  }, CONFIG.updateThrottle);

  toolRegistryUpdateListener = () => {
    if (!isProcessing) {
      handleDomChanges();
    }
  };
  window.addEventListener('mcp:tool-registry-updated', toolRegistryUpdateListener);

  // Create a mutation observer to watch for changes to the DOM
  functionCallObserver = new MutationObserver(mutations => {
    let shouldProcess = false;
    let potentialFunctionCall = false;

    for (const mutation of mutations) {
      // Check if any added nodes might contain function calls
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        for (const node of Array.from(mutation.addedNodes)) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node as Element;

            const standaloneElement = getStandaloneCodeBlockElement(element as HTMLElement);
            const standaloneDescendant = element.querySelector?.('pre, pre > code') as HTMLElement | null;
            const candidate = standaloneElement || (standaloneDescendant ? getStandaloneCodeBlockElement(standaloneDescendant) : null);

            if (candidate && hasFunctionCallLikePattern(candidate.textContent || '')) {
              potentialFunctionCall = true;
              shouldProcess = true;
              break;
            }
          } else if (node.nodeType === Node.TEXT_NODE) {
            const parent = node.parentElement;
            const candidate = parent ? getStandaloneCodeBlockElement(parent) : null;
            if (candidate && hasFunctionCallLikePattern(candidate.textContent || '')) {
              potentialFunctionCall = true;
              shouldProcess = true;
              break;
            }
          }
        }
      } else if (mutation.type === 'characterData') {
        const parent = mutation.target.parentElement;
        const candidate = parent ? getStandaloneCodeBlockElement(parent) : null;
        if (candidate && hasFunctionCallLikePattern(candidate.textContent || '')) {
          potentialFunctionCall = true;
          shouldProcess = true;
        }
      }

      if (shouldProcess) break;
    }

    if (shouldProcess) {
      if (potentialFunctionCall && CONFIG.debug) {
        logger.debug('Potential function call detected, processing DOM changes');
      }
      handleDomChanges();
    }
  });

  // Configure the observer to watch for changes to the document
  functionCallObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true, // Also watch for text content changes
    characterDataOldValue: true, // Keep old values for comparison
  });

  if (CONFIG.debug) logger.debug('Direct monitoring started for function calls');
};

/**
 * Stop direct monitoring of content for function calls
 */
export const stopDirectMonitoring = (): void => {
  // Disconnect the main mutation observer
  if (functionCallObserver) {
    functionCallObserver.disconnect();
    functionCallObserver = null;
  }

  if (toolRegistryUpdateListener) {
    window.removeEventListener('mcp:tool-registry-updated', toolRegistryUpdateListener);
    toolRegistryUpdateListener = null;
  }

  // Disconnect all streaming observers
  streamingObservers.forEach(observer => observer.disconnect());
  streamingObservers.clear();

  // Clear the streaming update timer
  if (updateThrottleTimer) {
    clearTimeout(updateThrottleTimer);
    updateThrottleTimer = null;
  }

  // Stop stalled stream detection
  stopStalledStreamDetection();

  if (CONFIG.debug) logger.debug('Direct monitoring stopped for function calls');
};

/**
 * Initialize the observer for function calls
 */
export const initializeObserver = (): void => {
  if (CONFIG.enableDirectMonitoring) {
    startDirectMonitoring();
  }
};
