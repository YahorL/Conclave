import { z } from "zod";

export const AgentLiveStatusSchema = z.enum(["running", "blocked", "idle"]);

export const AgentStatusReportSchema = z.object({
  agent: z.string().min(1),
  status: AgentLiveStatusSchema,
  activity: z.string().default(""),
  threadId: z.string().optional(),
  resetsAt: z.string().datetime().optional(),
});

export const AgentStatusSchema = AgentStatusReportSchema.extend({
  ts: z.string().datetime(),
});

export const AgentUsageSchema = z.object({
  agent: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  window5hTokens: z.number().nonnegative().default(0),
  weeklyTokens: z.number().nonnegative().default(0),
  window5hPct: z.number().optional(),
  weeklyPct: z.number().optional(),
});

export const UsageSummarySchema = z.object({
  perAgent: z.array(AgentUsageSchema),
  totalCostUsd: z.number().nonnegative(),
  budgetUsd: z.number().nonnegative(),
});

export type AgentLiveStatus = z.infer<typeof AgentLiveStatusSchema>;
export type AgentStatusReport = z.infer<typeof AgentStatusReportSchema>;
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type AgentUsage = z.infer<typeof AgentUsageSchema>;
export type UsageSummary = z.infer<typeof UsageSummarySchema>;
