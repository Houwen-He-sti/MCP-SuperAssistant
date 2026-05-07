/**
 * Custom module loader for Phase 3 smoke test.
 * Mocks workspace-scoped dependencies not available in Node.js.
 * Also handles .ts extension resolution (Vite convention uses extensionless imports).
 *
 * Usage: node --experimental-strip-types --import ./streamToolBridge.smoke.loader.mjs streamToolBridge.smoke.ts
 */

import { register } from 'node:module';

const loaderCode = `
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  // Mock @extension/shared/lib/logger
  if (specifier.includes('@extension/shared')) {
    return {
      shortCircuit: true,
      url: 'data:text/javascript,' + encodeURIComponent(
        'export function createLogger() { return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }; }'
      )
    };
  }

  // Try adding .ts extension for relative imports without extension
  if (specifier.startsWith('.') && !specifier.endsWith('.ts') && !specifier.endsWith('.mjs') && !specifier.endsWith('.js')) {
    try {
      return await nextResolve(specifier + '.ts', context);
    } catch (e) {
      // Try index.ts for directory imports
      try {
        return await nextResolve(specifier + '/index.ts', context);
      } catch (e2) {
        // Fall through to default
      }
    }
  }

  return nextResolve(specifier, context);
}
`;

register('data:text/javascript,' + encodeURIComponent(loaderCode), import.meta.url);
