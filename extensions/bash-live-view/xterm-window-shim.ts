// @xterm/headless touches `window` during module evaluation. This shim must run
// before that module is evaluated, so it lives in its own module and is imported
// immediately above it -- ESM evaluates imports in source order.
if (!globalThis.window) {
  (globalThis as typeof globalThis & { window: object }).window = {};
}
export {};
