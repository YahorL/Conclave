import { z } from "zod";

export const TurnRequestSchema = z.object({
  threadId: z.string().min(1),
  agentId: z.string().min(1),
  sinceMessageId: z.number().int().nonnegative().default(0),
  instruction: z.string().optional(),
});

export const NewDebateSchema = z
  .object({
    topic: z.string().min(1),
    participants: z.array(z.string().min(1)).min(2),
    workspace: z.string().optional(),
    minRounds: z.number().int().positive().default(2),
    maxRounds: z.number().int().positive().default(4),
    stances: z.record(z.string(), z.string()).optional(),
  })
  .refine((d) => d.maxRounds >= d.minRounds, { message: "maxRounds must be >= minRounds" });

export const UsageReportSchema = z.object({
  agent: z.string().min(1),
  threadId: z.string().optional(),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  costUsd: z.number().nonnegative().default(0),
});

export type TurnRequest = z.infer<typeof TurnRequestSchema>;
export type NewDebate = z.infer<typeof NewDebateSchema>;
export type UsageReport = z.infer<typeof UsageReportSchema>;
