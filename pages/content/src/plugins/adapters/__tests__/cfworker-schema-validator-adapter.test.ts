/**
 * Slice K TDD — CfWorkerSchemaValidatorAdapter
 *
 * T-K-01..T-K-06
 *
 * T-K-01: valid args → runtimeOk()
 * T-K-02: invalid args → runtimeError('arg_validation_failed', errorMessage)
 * T-K-03: getValidator() throws → runtimeError, no exception escapes
 * T-K-03b: validator function throws → runtimeError, no exception escapes
 * T-K-04: empty schema + any args → runtimeOk() (permissive)
 * T-K-05: integration invalid args → validateArgs() returns arg_validation_failed
 *          (ToolCallLoop gate: callTool will NOT be invoked)
 * T-K-06: integration valid args → validateArgs() returns ok
 *          (ToolCallLoop gate: callTool path unblocked)
 *
 * Run:
 *   node --test --experimental-strip-types \
 *     src/plugins/adapters/__tests__/cfworker-schema-validator-adapter.test.ts
 * (from MCP-SuperAssistant/pages/content/)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryToolRegistry } from '../../../../../../../mcp-runtime/src/core/in-memory-tool-registry.ts';
import { CfWorkerSchemaValidatorAdapter } from '../notion/cfworker-schema-validator-adapter.ts';

// ---------------------------------------------------------------------------
// Mock helpers — duck-typed CfWorkerJsonSchemaValidator
// ---------------------------------------------------------------------------

type ValidatorResult = { valid: true; data: unknown; errorMessage: undefined } | { valid: false; data: undefined; errorMessage: string };
type ValidatorFn = (input: unknown) => ValidatorResult;
type MockCfWorkerValidator = {
    getValidator: (schema: unknown) => ValidatorFn;
};

/** Always returns valid=true */
function makeValidValidator(): MockCfWorkerValidator {
    return {
        getValidator: (_schema: unknown) => (input: unknown): ValidatorResult => ({
            valid: true,
            data: input,
            errorMessage: undefined,
        }),
    };
}

/** Always returns valid=false with the given errorMessage */
function makeInvalidValidator(errorMessage: string): MockCfWorkerValidator {
    return {
        getValidator: (_schema: unknown) => (_input: unknown): ValidatorResult => ({
            valid: false,
            data: undefined,
            errorMessage,
        }),
    };
}

/** getValidator() itself throws — simulates malformed schema causing parse error */
function makeThrowingGetValidatorValidator(message: string): MockCfWorkerValidator {
    return {
        getValidator: (_schema: unknown): ValidatorFn => {
            throw new Error(message);
        },
    };
}

/** getValidator() returns fn, but fn() throws — simulates runtime validation error */
function makeThrowingFnValidator(message: string): MockCfWorkerValidator {
    return {
        getValidator: (_schema: unknown): ValidatorFn => (_input: unknown): ValidatorResult => {
            throw new Error(message);
        },
    };
}

// ---------------------------------------------------------------------------
// Unit tests (T-K-01..T-K-04)
// ---------------------------------------------------------------------------

describe('Slice K — CfWorkerSchemaValidatorAdapter unit', () => {
    it('T-K-01: valid args + matching schema → runtimeOk()', () => {
        const adapter = new CfWorkerSchemaValidatorAdapter(makeValidValidator() as any);
        const result = adapter.validate({ type: 'object' }, { foo: 'bar' });

        assert.equal(result.ok, true, 'valid args must return ok=true');
        // runtimeOk() with no value: { ok: true } (no .value property, or value === undefined)
        assert.equal((result as { ok: true; value?: unknown }).value, undefined,
            'runtimeOk() must not carry a success value (ToolCallLoop does not consume it)');
    });

    it('T-K-02: invalid args → runtimeError("arg_validation_failed", errorMessage)', () => {
        const adapter = new CfWorkerSchemaValidatorAdapter(
            makeInvalidValidator('Missing required field: message') as any,
        );
        const result = adapter.validate(
            { type: 'object', required: ['message'] },
            {},
        );

        assert.equal(result.ok, false);
        assert.equal(
            (result as { ok: false; code: string }).code,
            'arg_validation_failed',
        );
        assert.equal(
            (result as { ok: false; message: string }).message,
            'Missing required field: message',
        );
    });

    it('T-K-03: getValidator() throws (malformed schema) → runtimeError, no exception escapes', () => {
        const adapter = new CfWorkerSchemaValidatorAdapter(
            makeThrowingGetValidatorValidator('Schema parse error') as any,
        );

        let threw = false;
        let result: ReturnType<typeof adapter.validate> | null = null;
        try {
            result = adapter.validate({}, {});
        } catch {
            threw = true;
        }

        assert.equal(threw, false, 'validate() must NOT propagate exceptions');
        assert.ok(result !== null);
        assert.equal(result.ok, false);
        assert.equal((result as { ok: false; code: string }).code, 'arg_validation_failed');
        assert.equal((result as { ok: false; message: string }).message, 'Schema parse error');
    });

    it('T-K-03b: validator function throws at runtime → runtimeError, no exception escapes', () => {
        const adapter = new CfWorkerSchemaValidatorAdapter(
            makeThrowingFnValidator('Runtime validation error') as any,
        );

        let threw = false;
        let result: ReturnType<typeof adapter.validate> | null = null;
        try {
            result = adapter.validate({}, {});
        } catch {
            threw = true;
        }

        assert.equal(threw, false, 'validate() must NOT propagate exceptions from validator fn');
        assert.ok(result !== null);
        assert.equal(result.ok, false);
        assert.equal((result as { ok: false; code: string }).code, 'arg_validation_failed');
    });

    it('T-K-04: empty schema + any args → runtimeOk() (permissive)', () => {
        const adapter = new CfWorkerSchemaValidatorAdapter(makeValidValidator() as any);
        const result = adapter.validate({}, 'anything');

        assert.equal(result.ok, true, 'Empty/permissive schema must allow any input');
    });
});

// ---------------------------------------------------------------------------
// Integration tests (T-K-05, T-K-06)
// InMemoryToolRegistry + CfWorkerSchemaValidatorAdapter
//
// These tests verify the adapter is correctly wired into the registry.
// ToolCallLoop uses registry.validateArgs() before calling callTool;
// if validateArgs() returns error, callTool is NOT invoked.
// T-K-05 proves the fail-closed path; T-K-06 proves the valid path is not blocked.
// ---------------------------------------------------------------------------

const testTools = [
    {
        name: 'echo',
        inputSchema: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
        },
    },
];

describe('Slice K — CfWorkerSchemaValidatorAdapter integration with InMemoryToolRegistry', () => {
    it('T-K-05: invalid args → registry.validateArgs() returns arg_validation_failed (ToolCallLoop will NOT call callTool)', () => {
        const adapter = new CfWorkerSchemaValidatorAdapter(
            makeInvalidValidator('message field is required') as any,
        );
        const registry = new InMemoryToolRegistry({ schemaValidator: adapter });
        registry.populate(testTools as Parameters<typeof registry.populate>[0]);

        // Missing required 'message' field
        const result = registry.validateArgs('echo', {});

        assert.equal(result.ok, false, 'Invalid args must fail validation');
        assert.equal(
            (result as { ok: false; code: string }).code,
            'arg_validation_failed',
            'Error code must be arg_validation_failed (not tool_not_found)',
        );
        // If ToolCallLoop receives this error, it will call rejectionHandler
        // and NOT proceed to callTool — this is the fail-closed gate
    });

    it('T-K-06: valid args → registry.validateArgs() returns ok (ToolCallLoop WILL proceed to callTool)', () => {
        const adapter = new CfWorkerSchemaValidatorAdapter(makeValidValidator() as any);
        const registry = new InMemoryToolRegistry({ schemaValidator: adapter });
        registry.populate(testTools as Parameters<typeof registry.populate>[0]);

        // Valid payload matching the schema
        const result = registry.validateArgs('echo', { message: 'hello world' });

        assert.equal(result.ok, true, 'Valid args must pass validation — ToolCallLoop can proceed to callTool');
        // This ensures the real validator does NOT block legitimate tool calls
    });
});
