const token = import.meta.env.VITE_CONCLAVE_TOKEN ?? "";

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
