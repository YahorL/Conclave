// The token can be injected at serve time by the hub (it replaces the
// __CONCLAVE_TOKEN__ placeholder in index.html with the runtime CONCLAVE_TOKEN),
// so a deployed build needs no rebuild to set/rotate the token. In dev the
// placeholder is left as-is (ignored) and VITE_CONCLAVE_TOKEN is used instead.
const PLACEHOLDER = "CONCLAVE_TOKEN_PLACEHOLDER";
const injected =
  typeof window !== "undefined" ? (window as { __CONCLAVE_TOKEN__?: string }).__CONCLAVE_TOKEN__ : undefined;
const runtimeToken = injected && injected !== PLACEHOLDER ? injected : undefined;
const token = runtimeToken ?? import.meta.env.VITE_CONCLAVE_TOKEN ?? "";

export const config = {
  token,
  apiHeaders(): Record<string, string> {
    return token ? { authorization: `Bearer ${token}` } : {};
  },
  wsUrl(): string {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const q = token ? `?token=${encodeURIComponent(token)}` : "";
    return `${proto}://${location.host}/ws${q}`;
  },
};
