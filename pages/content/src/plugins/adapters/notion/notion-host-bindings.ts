/**
 * NotionHostBindings — Layer HostBindings for the 4-layer BH architecture.
 *
 * Implements `HostBindings` (mcp-runtime interface) by calling `mcpClient.callTool`
 * and formatting the result via an injected `formatFunctionResult` function.
 *
 * HostBindings success semantics (aligned with ToolCallLoop contract):
 *   success:true  = formattedResponse is safe to insert into Notion AI
 *                   (whether tool succeeded OR errored — Notion AI should see both)
 *   success:false = infrastructure failure — do NOT insert, do NOT attempt recovery
 *
 * See ToolCallLoop.handleToolCall():
 *   if (!result.success) return;  // formattedResponse not inserted when success:false
 *
 * BH-4 TDD: T-BH-15..T-BH-18b
 */

import type {
    HostBindings,
    ToolCallResult,
    ErrorPayload,
} from '../../../../../../../mcp-runtime/src/bridge/host-bindings.ts';
import type { ToolCallPayload } from '../../../../../../../mcp-runtime/src/core/tool-call-parser.ts';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface NotionMcpClientLike {
    callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
    /** Optional — if absent, callTool is called unconditionally (it will throw if not connected). */
    isReady?: () => boolean;
    /**
     * Optional — Slice I: returns available tool descriptors for InMemoryToolRegistry population.
     * If absent, registry wiring is skipped (warn logged, loop started without toolRegistry).
     */
    getAvailableTools?: () => Promise<Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>>;
}

export interface NotionHostBindingsDeps {
    mcpClient: NotionMcpClientLike;
    formatFunctionResult: (opts: {
        callId: string;
        name: string;
        status: 'success' | 'error';
        result: unknown;
    }) => string;
    logger?: Pick<Console, 'error' | 'warn'>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNotionHostBindings(deps: NotionHostBindingsDeps): HostBindings {
    return {
        async onToolCallDetect(payload: ToolCallPayload): Promise<ToolCallResult> {
            // Guard: check readiness only if isReady() is available
            if (deps.mcpClient.isReady && !deps.mcpClient.isReady()) {
                deps.logger?.warn?.('[NotionHostBindings] MCP client not ready');
                return {
                    callId: payload.callId,
                    formattedResponse: '',
                    success: false,
                    error: 'MCP_CLIENT_NOT_READY',
                };
            }

            try {
                const result = await deps.mcpClient.callTool(payload.name, payload.arguments ?? {});
                return {
                    callId: payload.callId,
                    formattedResponse: deps.formatFunctionResult({
                        callId: payload.callId,
                        name: payload.name,
                        status: 'success',
                        result,
                    }),
                    success: true,
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                // Tool execution error: still insert error result into Notion AI
                // so it can see the failure and adjust reasoning.
                // success:true = "formattedResponse is safe to insert"
                return {
                    callId: payload.callId,
                    formattedResponse: deps.formatFunctionResult({
                        callId: payload.callId,
                        name: payload.name,
                        status: 'error',
                        result: message,
                    }),
                    success: true,
                    error: message,
                };
            }
        },

        onAdapterError(error: ErrorPayload): void {
            // Log only — BH-4 does not attempt recovery from adapter errors
            deps.logger?.error?.('[NotionHostBindings] Adapter error:', error.code, error.message);
        },
    };
}
