import { z } from "zod";

export const AgentRuntimeSchema = z.enum(["claude-code", "codex"]);

export const AgentConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  runtime: AgentRuntimeSchema,
  machine: z.string().min(1),
  workspace: z.string().min(1),
  role: z.string().default(""),
  allowedTools: z.array(z.string()).default([]),
  dangerousActions: z.array(z.string()).default([]),
});

export const RegistrySchema = z.object({
  agents: z.array(AgentConfigSchema).default([]),
});

export type AgentRuntime = z.infer<typeof AgentRuntimeSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type Registry = z.infer<typeof RegistrySchema>;
