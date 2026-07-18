import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useIsMobile } from "../useIsMobile.js";

type Listener = (e: { matches: boolean }) => void;

function stubMatchMedia(initial: boolean): { fire: (matches: boolean) => void } {
  let matches = initial;
  const listeners: Listener[] = [];
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (media: string) => ({
      get matches() {
        return matches;
      },
      media,
      addEventListener: (_: string, cb: Listener) => listeners.push(cb),
      removeEventListener: (_: string, cb: Listener) => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      },
    }),
  });
  return {
    fire: (m: boolean) => {
      matches = m;
      listeners.forEach((cb) => cb({ matches: m }));
    },
  };
}

function Probe(): JSX.Element {
  return <div data-testid="probe">{String(useIsMobile())}</div>;
}

describe("useIsMobile", () => {
  it("reflects the initial matchMedia state", () => {
    stubMatchMedia(true);
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("true");
  });

  it("updates when the media query changes", () => {
    const mm = stubMatchMedia(false);
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("false");
    act(() => mm.fire(true));
    expect(screen.getByTestId("probe").textContent).toBe("true");
  });

  it("returns false when matchMedia is unavailable (jsdom default)", () => {
    // @ts-expect-error deliberately removing the stub
    delete window.matchMedia;
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("false");
  });
});
