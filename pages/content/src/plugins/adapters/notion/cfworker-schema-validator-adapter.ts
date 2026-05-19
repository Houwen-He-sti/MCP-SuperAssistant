/**
 * CfWorkerSchemaValidatorAdapter — Slice K
 *
 * Adapts CfWorkerJsonSchemaValidator (two-step API) to SchemaValidatorPort (one-step API).
 *
 * Design:
 *   - Accepts a duck-typed CfWorkerValidatorLike (not a direct SDK import) for testability
 *   - The concrete CfWorkerJsonSchemaValidator instance is injected by the caller
 *     (notion-runtime-bridge.ts), keeping SDK dependency out of this file
 *   - All errors (invalid args, malformed schema, runtime exceptions) are mapped to
 *     runtimeError('arg_validation_failed', ...) — no schema-level distinction in Slice K
 *   - try/catch wraps the entire flow to handle malformed schema or validator throws
 *
 * See: tmp/slice-k-pl-v2.md
 * Replaces: ObservationOnlySchemaValidator (Slice I placeholder)
 */

import type { SchemaValidatorPort } from '../../../../../../../mcp-runtime/src/core/schema-validator.ts';
import { runtimeOk, runtimeError } from '../../../../../../../mcp-runtime/src/bridge/runtime-result.ts';
import type { RuntimeResult } from '../../../../../../../mcp-runtime/src/bridge/runtime-result.ts';

// ---------------------------------------------------------------------------
// Duck-typed interface for CfWorkerJsonSchemaValidator
//
// This allows injecting the real SDK validator or a test mock
// without requiring '@modelcontextprotocol/sdk' as a direct import here.
// The SDK import lives in notion-runtime-bridge.ts (the injection site).
// ---------------------------------------------------------------------------

export interface CfWorkerValidatorLike {
    getValidator(
        schema: Record<string, unknown>,
    ): (input: unknown) => {
        valid: boolean;
        data: unknown;
        errorMessage: string | undefined;
    };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class CfWorkerSchemaValidatorAdapter implements SchemaValidatorPort {
    private readonly cfWorkerValidator: CfWorkerValidatorLike;

    constructor(cfWorkerValidator: CfWorkerValidatorLike) {
        this.cfWorkerValidator = cfWorkerValidator;
    }

    /**
     * Validate args against schema using the injected CfWorker validator.
     *
     * Maps:
     *   valid=true  → runtimeOk()
     *   valid=false → runtimeError('arg_validation_failed', errorMessage)
     *   throw       → runtimeError('arg_validation_failed', error.message)
     *
     * Never throws — all exceptions are caught and mapped to runtimeError.
     */
    validate(schema: Record<string, unknown>, args: unknown): RuntimeResult {
        try {
            const fn = this.cfWorkerValidator.getValidator(schema);
            const result = fn(args);

            if (result.valid) {
                return runtimeOk();
            }

            return runtimeError(
                'arg_validation_failed',
                result.errorMessage ?? 'Schema validation failed',
            );
        } catch (error) {
            return runtimeError(
                'arg_validation_failed',
                error instanceof Error ? error.message : String(error),
            );
        }
    }
}
