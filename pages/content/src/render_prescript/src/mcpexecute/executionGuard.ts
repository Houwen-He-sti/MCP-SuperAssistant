/**
 * Execution Attribution Guard — Session-level auto-execute reservation latch
 * 
 * Prevents MutationObserver concurrent re-entry via reserve-before-execute pattern.
 * Guard store tracks 'pending' state only for same-session race prevention.
 * Permanent dedup is handled by localStorage execution history
 * (storeExecutedFunction / getPreviousExecution / isFunctionExecuted).
 * 
 * Identity key: conversationUrl + functionName + callId + contentSignature
 * Block scope: only auto-executes blocks in the latest assistant message
 * 
 * See: Issue #20, plans/auto-execute-attribution-guard.md
 */

import { createLogger } from '@extension/shared/lib/logger';
import { generateContentSignature } from './storage';

const logger = createLogger('ExecutionGuard');

// --- Types ---

export type ExecutionStatus = 'pending' | 'succeeded' | 'failed';

export interface ExecutionRecord {
    key: string;
    status: ExecutionStatus;
    timestamp: number;
    error?: string;
}

export interface ExecutionKeyInput {
    functionName: string;
    callId: string;
    params: Record<string, any>;
}

// --- Execution Store ---

class ExecutionGuardStore {
    private records: Map<string, ExecutionRecord> = new Map();

    /**
     * Compute execution key using existing storage semantics:
     * normalizedConversationUrl + functionName + callId + contentSignature(functionName, params)
     */
    computeKey(input: ExecutionKeyInput): string {
        const url = this.normalizeUrl(window.location.href);
        const signature = generateContentSignature(input.functionName, input.params);
        return `${url}|${input.functionName}|${input.callId}|${signature}`;
    }

    /**
     * Check if a key exists with any of the given statuses
     */
    has(key: string, statuses: ExecutionStatus[]): boolean {
        const record = this.records.get(key);
        if (!record) return false;
        return statuses.includes(record.status);
    }

    /**
     * Reserve a key with pending status (MUST be called before execution)
     * Returns false if already reserved (pending or succeeded).
     */
    reserve(key: string): boolean {
        if (this.has(key, ['pending', 'succeeded'])) {
            logger.debug(`Reserve blocked: key already has pending/succeeded status: ${key}`);
            return false;
        }
        this.records.set(key, {
            key,
            status: 'pending',
            timestamp: Date.now(),
        });
        logger.debug(`Reserved: ${key}`);
        return true;
    }

    /**
     * Mark execution as succeeded
     */
    markSucceeded(key: string): void {
        const record = this.records.get(key);
        if (record) {
            record.status = 'succeeded';
            record.timestamp = Date.now();
            logger.debug(`Succeeded: ${key}`);
        }
    }

    /**
     * Mark execution as failed (does NOT auto-retry).
     * Manual retry is available via the Execute button's explicit click path.
     */
    markFailed(key: string, error?: string): void {
        const record = this.records.get(key);
        if (record) {
            record.status = 'failed';
            record.error = error;
            record.timestamp = Date.now();
            logger.debug(`Failed: ${key} - ${error || 'unknown'}`);
        }
    }

    /**
     * Get record for a key
     */
    get(key: string): ExecutionRecord | undefined {
        return this.records.get(key);
    }

    /**
     * Clear all records (for testing)
     */
    clear(): void {
        this.records.clear();
    }

    normalizeUrl(url: string): string {
        // Strip query params and hash for stable key
        try {
            const parsed = new URL(url);
            return `${parsed.origin}${parsed.pathname}`;
        } catch {
            return url.split('?')[0].split('#')[0];
        }
    }
}

// Singleton instance
export const executionGuardStore = new ExecutionGuardStore();

// --- Latest Assistant Message Check ---

/**
 * Check if a block is within the latest assistant message.
 * Only blocks in the most recent assistant message are eligible for auto-execute.
 */
export function isInLatestAssistantMessage(block: HTMLElement): boolean {
    // Find the assistant message containing this block
    const msg = block.closest('[data-message-author-role="assistant"]');
    if (!msg) {
        // If the site doesn't use data-message-author-role (e.g., Notion),
        // don't block execution — the attribution guard is not applicable.
        const allMsgs = document.querySelectorAll('[data-message-author-role="assistant"]');
        if (allMsgs.length === 0) {
            logger.debug('No assistant message containers found on this site, allowing execution');
            return true;
        }
        logger.debug('Block not inside any assistant message');
        return false;
    }

    // Get all assistant messages
    const allMsgs = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (allMsgs.length === 0) return true;

    const lastMsg = allMsgs[allMsgs.length - 1];
    return msg === lastMsg;
}

// --- Main Guard Function ---

/**
 * Determines if a function block can be auto-executed.
 * 
 * Checks:
 * 1. Validation passes (isExecutable + isComplete)
 * 2. Block is in latest assistant message
 * 3. Execution key is not already pending or succeeded
 * 
 * @returns true if auto-execution should proceed
 */
export function canAutoExecute(
    block: HTMLElement,
    input: ExecutionKeyInput,
    isExecutable: boolean,
    isComplete: boolean,
): boolean {
    if (!isExecutable || !isComplete) return false;

    const key = executionGuardStore.computeKey(input);

    // Reserve-before-execute: pending and succeeded block re-entry
    if (executionGuardStore.has(key, ['pending', 'succeeded'])) {
        logger.debug(`canAutoExecute: blocked by existing execution state for ${input.functionName}`);
        return false;
    }

    // Active turn check: block must be in latest assistant message
    if (!isInLatestAssistantMessage(block)) {
        logger.debug(`canAutoExecute: block not in latest assistant message for ${input.functionName}`);
        return false;
    }

    return true;
}

/**
 * Reserve execution slot and return the key.
 * Must be called immediately before the execute button click.
 * 
 * The 'pending' state prevents MutationObserver re-entry.
 * Permanent dedup is handled by existing localStorage via storeExecutedFunction/getPreviousExecution.
 * 
 * @returns the key if reserved successfully, null if blocked
 */
export function reserveExecution(input: ExecutionKeyInput): string | null {
    const key = executionGuardStore.computeKey(input);
    const success = executionGuardStore.reserve(key);
    return success ? key : null;
}
