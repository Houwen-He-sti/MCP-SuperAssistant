/**
 * Vite config for MAIN world stream interceptor.
 *
 * Produces a minimal IIFE bundle at dist/content/stream-interceptor-main.iife.js
 * with NO external imports, NO HMR, NO dynamic imports.
 *
 * This bundle runs in Notion's MAIN world and must be completely standalone.
 */
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const rootDir = resolve(import.meta.dirname);
const srcDir = resolve(rootDir, 'src');

export default defineConfig({
  build: {
    lib: {
      name: 'StreamInterceptorMain',
      fileName: 'stream-interceptor-main',
      formats: ['iife'],
      entry: resolve(srcDir, 'render_prescript', 'src', 'stream', 'interceptorMain.ts'),
    },
    outDir: resolve(rootDir, '..', '..', 'dist', 'content'),
    emptyOutDir: false,
    minify: 'terser',
    terserOptions: {
      // Keep it readable for debugging
      compress: {
        drop_console: false,
      },
    },
    rollupOptions: {
      output: {
        entryFileNames: 'stream-interceptor-main.iife.js',
      },
    },
    // No sourcemaps for MAIN world (avoid leaking internal structure)
    sourcemap: false,
  },
  // No plugins — pure TS → JS, no React, no HMR
  plugins: [],
});
