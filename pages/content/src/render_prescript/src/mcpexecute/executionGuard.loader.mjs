/**
 * Custom module loader for executionGuard smoke test.
 * Mocks workspace-scoped dependencies that aren't available in bare Node.js.
 * 
 * Usage: node --import ./executionGuard.loader.mjs executionGuard.smoke.mjs
 */

import { register } from 'node:module';

register(new URL('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  // Mock @extension/shared/lib/logger
  if (specifier.includes('@extension/shared/lib/logger') || specifier.includes('@extension/shared')) {
    return {
      shortCircuit: true,
      url: 'data:text/javascript,' + encodeURIComponent(
        'export function createLogger() { return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }; }'
      )
    };
  }
  
  // Mock ./storage (generateContentSignature)
  if (specifier.endsWith('/storage') || specifier.endsWith('/storage.ts')) {
    return {
      shortCircuit: true,
      url: 'data:text/javascript,' + encodeURIComponent(\`
        export function generateContentSignature(functionName, params) {
          const sortedParams = {};
          Object.keys(params).sort().forEach(key => { sortedParams[key] = params[key]; });
          const content = JSON.stringify({ name: functionName, params: sortedParams });
          let hash = 0;
          for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = (hash << 5) - hash + char;
            hash = hash & hash;
          }
          return hash.toString(16);
        }
        export function generateExecutionKey(fn, callId, sig) { return fn + ':' + callId + ':' + sig; }
        export function storeExecutedFunction() { return null; }
        export function getPreviousExecution() { return null; }
      \`)
    };
  }
  
  return nextResolve(specifier, context);
}
`)));
