/**
 * notion.bridge-enable.ts
 *
 * Standalone helper that enables the MCP stream bridge injected by
 * render_prescript (content/index.iife.js) by calling the
 * `configureStreamToolBridge` function that it exposes on the ISOLATED-world
 * window object.
 *
 * Kept dependency-free so it can be imported by unit tests without pulling
 * in the full adapter graph (promptTemplateLoader, useToolStore, etc.).
 */

/**
 * Enables the stream tool bridge for native AI agent pages.
 *
 * `configureStreamToolBridge` is set on `window` in the ISOLATED world by
 * render_prescript/src/index.ts; it is NOT visible from CDP MAIN world
 * (`page.evaluate`), but IS visible here because content scripts share the
 * same ISOLATED world.
 *
 * Gracefully no-ops when the function is not present (e.g. in test
 * environments or when the extension has not injected yet).
 */
export function enableStreamBridgeOnWindow(win: typeof globalThis): void {
  const configure = (win as unknown as Record<string, unknown>).configureStreamToolBridge as
    | ((config: object) => void)
    | undefined;
  configure?.({ enabled: true, autoInsert: true, autoSubmit: true });
}
