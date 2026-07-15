import { canCommunicate, type Registry } from "@conclave/shared";

// Returns the first recipient `from` may not message, or null if all recipients
// are allowed. Only registered agents other than `from` are gated; the human
// ("you"), the sender itself, and non-agent labels pass. A non-agent `from`
// (human or unknown) is never gated.
export function assertAclAllowed(registry: Registry, from: string, to: string[]): string | null {
  const isAgent = (x: string): boolean => registry.agents.some((a) => a.id === x);
  if (!isAgent(from)) return null;
  for (const r of to) {
    if (r !== from && isAgent(r) && !canCommunicate(registry, from, r)) return r;
  }
  return null;
}
