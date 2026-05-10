/**
 * Custom ESM loader that stubs out @extension/shared imports for Node.js tests.
 * Usage: node --import ./stub-shared-loader.mjs --test ...
 */

import { register } from 'node:module';

register(new URL('./stub-shared-hooks.mjs', import.meta.url));
