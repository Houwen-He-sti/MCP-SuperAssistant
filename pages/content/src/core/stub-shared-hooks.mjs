/**
 * ESM resolve/load hooks that stub @extension/shared/lib/logger for tests.
 */

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@extension/shared')) {
    return {
      shortCircuit: true,
      url: 'stub-shared://logger',
    };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === 'stub-shared://logger') {
    return {
      shortCircuit: true,
      format: 'module',
      source: `
        export function createLogger() {
          return {
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: () => {},
          };
        }
      `,
    };
  }
  return nextLoad(url, context);
}
