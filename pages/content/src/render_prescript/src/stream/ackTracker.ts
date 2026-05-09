/**
 * ackTracker.ts — Cross-turn ACK nonce registry for browser MCP tool-loop.
 *
 * Gate 5c.1 + 5d: Tracks pending ACK nonces after bridge handoff,
 * scans next-turn model output for confirmation, emits events on
 * confirmation or timeout.
 *
 * Part of Issue #24 (VSCode-Dir): Browser MCP tool-loop state machine.
 */

// --- Interfaces ---

export interface ModelAckEvent {
    type: 'model_ack_confirmed' | 'model_ack_timeout';
    nonce: string;
    callId: string;
    functionName: string;
    latencyMs: number;
}

export interface AckTrackerConfig {
    /** Timeout in ms before emitting model_ack_timeout. Default: 30000. */
    timeoutMs: number;
    /** Event callback for ACK events. */
    onEvent: (event: ModelAckEvent) => void;
}

interface PendingEntry {
    nonce: string;
    callId: string;
    functionName: string;
    registeredAt: number;
    timeoutHandle: ReturnType<typeof setTimeout>;
}

export interface AckTracker {
    registerPending(nonce: string, callId: string, functionName: string): void;
    confirmAck(nonce: string): void;
    hasPending(nonce: string): boolean;
    scanText(text: string): void;
    getPendingCount(): number;
    dispose(): void;
}

// --- Nonce Generation ---

/** Counter for uniqueness within same millisecond. */
let nonceCounter = 0;

/** Safe alphabet for nonce: alphanumeric + underscore + hyphen only. */
const SAFE_CHAR = /[^A-Za-z0-9_-]/g;

/**
 * Generate a short, unique, XML-safe ACK nonce for a given callId.
 * Format: ack_<sanitized_callId>_<counter_base36>
 * Guaranteed < 50 chars and safe for XML attribute values.
 */
export function generateNonce(callId: string): string {
    const sanitized = callId.replace(SAFE_CHAR, '').slice(0, 20);
    const suffix = (nonceCounter++).toString(36);
    return `ack_${sanitized}_${suffix}`;
}

// --- ACK Scanner Regex ---

const ACK_PATTERN = /<mcp_ack\s+nonce="([^"]+)"\s*\/>/g;

// --- Factory ---

export function createAckTracker(config: AckTrackerConfig): AckTracker {
    const pending = new Map<string, PendingEntry>();

    function registerPending(nonce: string, callId: string, functionName: string): void {
        // Cancel existing if re-registered (shouldn't happen, but be safe)
        if (pending.has(nonce)) {
            clearTimeout(pending.get(nonce)!.timeoutHandle);
        }

        const registeredAt = Date.now();
        const timeoutHandle = setTimeout(() => {
            if (!pending.has(nonce)) return;
            const entry = pending.get(nonce)!;
            pending.delete(nonce);
            config.onEvent({
                type: 'model_ack_timeout',
                nonce: entry.nonce,
                callId: entry.callId,
                functionName: entry.functionName,
                latencyMs: Date.now() - entry.registeredAt,
            });
        }, config.timeoutMs);

        pending.set(nonce, { nonce, callId, functionName, registeredAt, timeoutHandle });
    }

    function confirmAck(nonce: string): void {
        const entry = pending.get(nonce);
        if (!entry) return;

        clearTimeout(entry.timeoutHandle);
        pending.delete(nonce);

        config.onEvent({
            type: 'model_ack_confirmed',
            nonce: entry.nonce,
            callId: entry.callId,
            functionName: entry.functionName,
            latencyMs: Date.now() - entry.registeredAt,
        });
    }

    function hasPending(nonce: string): boolean {
        return pending.has(nonce);
    }

    function scanText(text: string): void {
        ACK_PATTERN.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = ACK_PATTERN.exec(text)) !== null) {
            const detectedNonce = match[1];
            if (pending.has(detectedNonce)) {
                confirmAck(detectedNonce);
            }
        }
    }

    function getPendingCount(): number {
        return pending.size;
    }

    function dispose(): void {
        for (const entry of pending.values()) {
            clearTimeout(entry.timeoutHandle);
        }
        pending.clear();
    }

    return { registerPending, confirmAck, hasPending, scanText, getPendingCount, dispose };
}
