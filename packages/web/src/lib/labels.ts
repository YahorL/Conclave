export function threadLabel(workspace: string | null, kind: string): string {
  if (workspace) return workspace;
  return kind === "dm" ? "direct message" : "thread";
}

export function artifactColor(name: string): string {
  if (/ticket/i.test(name)) return "var(--artifact-ticket)";
  if (/plan/i.test(name)) return "var(--artifact-plan)";
  return "var(--text-secondary-2)";
}
