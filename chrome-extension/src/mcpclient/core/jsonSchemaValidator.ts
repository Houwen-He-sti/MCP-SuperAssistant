import type { ClientOptions } from '@modelcontextprotocol/sdk/client/index.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';

export function createExtensionJsonSchemaValidator(): CfWorkerJsonSchemaValidator {
    return new CfWorkerJsonSchemaValidator();
}

export function createExtensionClientOptions(): ClientOptions {
    return {
        capabilities: {},
        jsonSchemaValidator: createExtensionJsonSchemaValidator(),
    };
}