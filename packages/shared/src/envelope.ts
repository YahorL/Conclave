import { z } from "zod";

export const ThreadKindSchema = z.enum(["chat", "debate", "task", "dm"]);
export const ThreadStateSchema = z.enum(["open", "input-required", "settled", "closed"]);
export const MessageTypeSchema = z.enum([
  "text",
  "proposal",
  "verdict",
  "file",
  "approval-request",
  "status",
]);

export const ThreadSchema = z.object({
  id: z.string().min(1),
  kind: ThreadKindSchema,
  workspace: z.string().nullable(),
  participants: z.array(z.string().min(1)).min(1),
  state: ThreadStateSchema,
  verdicts: z.record(z.string(), z.string()),
  createdAt: z.string().datetime(),
});

export const NewThreadSchema = z.object({
  kind: ThreadKindSchema,
  participants: z.array(z.string().min(1)).min(1),
  workspace: z.string().optional(),
});

export const MessageSchema = z.object({
  id: z.number().int().positive(),
  threadId: z.string().min(1),
  from: z.string().min(1),
  to: z.array(z.string()),
  type: MessageTypeSchema,
  body: z.string(),
  artifacts: z.array(z.string()),
  ts: z.string().datetime(),
});

export const NewMessageSchema = z.object({
  from: z.string().min(1),
  to: z.array(z.string()).default([]),
  type: MessageTypeSchema.default("text"),
  body: z.string().min(1),
  artifacts: z.array(z.string()).default([]),
});

export type ThreadKind = z.infer<typeof ThreadKindSchema>;
export type ThreadState = z.infer<typeof ThreadStateSchema>;
export type MessageType = z.infer<typeof MessageTypeSchema>;
export type Thread = z.infer<typeof ThreadSchema>;
export type NewThread = z.infer<typeof NewThreadSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type NewMessage = z.infer<typeof NewMessageSchema>;
