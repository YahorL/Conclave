import "@testing-library/jest-dom/vitest";

// jsdom does not implement ResizeObserver (used by TerminalView for xterm refits).
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}
