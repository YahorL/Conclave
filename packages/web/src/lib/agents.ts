const KNOWN = new Set(["claude-code", "codex", "reviewer"]);

export function agentColorVar(agentId: string): { bg: string; text: string } {
  const key = KNOWN.has(agentId) ? agentId : "default";
  return { bg: `var(--agent-${key})`, text: `var(--agent-${key}-text)` };
}

export function initials(name: string): string {
  const parts = name.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
