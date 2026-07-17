import { z } from "zod";

export const AgentRuntimeSchema = z.enum(["claude-code", "codex"]);

export const AgentLimitsSchema = z.object({
  window5hTokens: z.number().int().positive().optional(),
  weeklyTokens: z.number().int().positive().optional(),
});

export const AgentConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  runtime: AgentRuntimeSchema,
  machine: z.string().min(1),
  workspace: z.string().min(1),
  role: z.string().default(""),
  allowedTools: z.array(z.string()).default([]),
  dangerousActions: z.array(z.string()).default([]),
  limits: AgentLimitsSchema.optional(),
});

export const AclPairSchema = z.tuple([z.string().min(1), z.string().min(1)]);

export const RegistrySchema = z.object({
  agents: z.array(AgentConfigSchema).default([]),
  acl: z.array(AclPairSchema).default([]),
});

export type AgentRuntime = z.infer<typeof AgentRuntimeSchema>;
export type AgentLimits = z.infer<typeof AgentLimitsSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type Registry = z.infer<typeof RegistrySchema>;
export type AclPair = z.infer<typeof AclPairSchema>;

export function canCommunicate(registry: Registry, a: string, b: string): boolean {
  if (a === "you" || b === "you") return true;
  return registry.acl.some(
    ([x, y]) => (x === a && y === b) || (x === b && y === a),
  );
}
