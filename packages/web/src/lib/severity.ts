export type UsageSeverity = "normal" | "nearing" | "critical";

export function usageSeverity(pct: number): UsageSeverity {
  if (pct >= 90) return "critical";
  if (pct >= 70) return "nearing";
  return "normal";
}

export function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
