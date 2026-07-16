import { beforeEach, describe, expect, it } from "vitest";
import { applyTheme, readStoredTheme, THEME_SURFACE } from "../theme.js";
import { useConclaveStore } from "../../store/useConclaveStore.js";

function meta(): HTMLMetaElement {
  let el = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
  if (!el) {
    el = document.createElement("meta");
    el.name = "theme-color";
    document.head.appendChild(el);
  }
  return el;
}

describe("theme apply/persist/read", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.dataset.theme = "black";
    meta().content = "#0d0d0d";
  });

  it("applyTheme sets data-theme, persists, and updates the meta tag", () => {
    applyTheme("teal");
    expect(document.documentElement.dataset.theme).toBe("teal");
    expect(localStorage.getItem("conclave-theme")).toBe("teal");
    expect(meta().content).toBe(THEME_SURFACE.teal);
  });

  it("readStoredTheme defaults to black on missing or garbage values", () => {
    expect(readStoredTheme()).toBe("black");
    localStorage.setItem("conclave-theme", "mauve");
    expect(readStoredTheme()).toBe("black");
    localStorage.setItem("conclave-theme", "teal");
    expect(readStoredTheme()).toBe("teal");
  });

  it("store setTheme updates state and applies", () => {
    useConclaveStore.getState().setTheme("teal");
    expect(useConclaveStore.getState().theme).toBe("teal");
    expect(document.documentElement.dataset.theme).toBe("teal");
    useConclaveStore.getState().setTheme("black");
    expect(useConclaveStore.getState().theme).toBe("black");
  });
});
