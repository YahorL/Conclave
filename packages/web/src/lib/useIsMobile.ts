import { useSyncExternalStore } from "react";

// Single source of truth for the mobile breakpoint (spec: 768px).
export const MOBILE_QUERY = "(max-width: 768px)";

function subscribe(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(MOBILE_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(MOBILE_QUERY).matches;
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot);
}
