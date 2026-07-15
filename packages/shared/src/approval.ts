import { z } from "zod";

export const ApprovalStateSchema = z.enum(["pending", "approved", "denied"]);

export const ApprovalSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  requestedBy: z.string().min(1),
  action: z.string().min(1),
  idempotencyKey: z.string().min(1),
  state: ApprovalStateSchema,
  note: z.string().optional(),
  createdAt: z.string().datetime(),
  decidedAt: z.string().datetime().optional(),
});

export const NewApprovalSchema = z.object({
  threadId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  requestedBy: z.string().min(1),
  action: z.string().min(1),
  idempotencyKey: z.string().min(1),
});

export const ApprovalDecisionSchema = z.object({
  decision: z.enum(["approved", "denied"]),
  note: z.string().optional(),
});

export type ApprovalState = z.infer<typeof ApprovalStateSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type NewApproval = z.infer<typeof NewApprovalSchema>;
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
