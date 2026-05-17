/**
 * Shared EvalError guard for Chrome MV3 CSP compatibility.
 *
 * Chrome MV3 blocks 'unsafe-eval' in extension_pages CSP.
 * MCP SDK's AJV schema compilation uses `new Function()`, which
 * throws EvalError under this restriction.
 *
 * Both SSEPlugin and StreamableHttpPlugin use this guard in their
 * getPrimitives() catch blocks to return empty primitives gracefully
 * instead of crashing.
 *
 * Extracted as a pure function for testability.
 */

/**
 * Check if an error is a CSP-related EvalError that should be
 * gracefully handled (return empty primitives instead of crashing).
 *
 * Returns true if:
 * - error is an instance of EvalError, OR
 * - error.message contains 'unsafe-eval' (fallback for cases where
 *   the error is a plain Error but the message indicates CSP blocking)
 */
export function isCspEvalError(error: unknown): boolean {
  return error instanceof EvalError || (error instanceof Error && error.message.includes('unsafe-eval'));
}
