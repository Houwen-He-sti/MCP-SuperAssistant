/**
 * Future normalized UI event contract.
 *
 * v1 ToolResultRenderer listens directly to `mcp:tool-execution-complete`.
 * This type is reserved for later Gate 5d / bridge ACK integration:
 * - bridge_handoff_ack
 * - model_ack_confirmed
 * - model_ack_timeout
 */
export type ToolResultUiEventType =
    | 'tool_execution_completed'
    | 'tool_result_submitted'
    | 'model_ack_confirmed'
    | 'model_ack_timeout'
    | 'prompt_config';

export interface ToolResultUiEvent {
    type: ToolResultUiEventType;
    functionName?: string;
    callId?: string;
    preview?: string;
    nonce?: string;
    latencyMs?: number;
    details?: unknown;
    kind?: 'tool_result' | 'prompt';
}

/**
 * Mount point for injecting tool result cards into the conversation area.
 * Returned by adapter's findToolResultMountPoint().
 */
export interface ToolResultMountPoint {
    /** The container element to inject into */
    container: HTMLElement;
    /** Optional anchor element; when mode='after', the card is inserted after this element */
    anchor?: HTMLElement;
    /** Insertion mode: 'append' to container, or 'after' the anchor */
    mode: 'append' | 'after';
}

/**
 * Validated and extracted data ready for rendering.
 * Internal to ToolResultRenderer.
 */
export interface ToolResultRenderData {
    callId: string;
    functionName: string;
    status: 'success' | 'error';
    resultPreview: string;
    rawResult?: string;
    error?: string;
    timestamp: number;
    kind?: 'tool_result' | 'prompt';
    title?: string;
}
