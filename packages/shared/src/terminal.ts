import { z } from "zod";

export const TerminalKindSchema = z.enum(["shell", "claude", "codex"]);

export const TerminalInfoSchema = z.object({
  id: z.string().min(1),
  machine: z.string().min(1),
  kind: TerminalKindSchema,
  label: z.string().min(1),
  cwd: z.string().min(1),
  agentId: z.string().optional(),
  startedAt: z.string(),
});

export const SpawnTerminalSchema = z.object({
  machine: z.string().min(1),
  kind: TerminalKindSchema,
  cwd: z.string().min(1),
});

// hub -> daemon (and client -> hub -> daemon) control/stream frames
export const TermSpawnFrameSchema = z.object({
  type: z.literal("term-spawn"),
  kind: TerminalKindSchema,
  cwd: z.string().min(1),
});
export const TermKillFrameSchema = z.object({
  type: z.literal("term-kill"),
  terminalId: z.string().min(1),
});
export const TermDataFrameSchema = z.object({
  type: z.literal("term-data"),
  terminalId: z.string().min(1),
  data: z.string(), // base64
});
export const TermResizeFrameSchema = z.object({
  type: z.literal("term-resize"),
  terminalId: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export const TermAttachFrameSchema = z.object({
  type: z.literal("term-attach"),
  terminalId: z.string().min(1),
  requestId: z.string().min(1),
});
export const TermDetachFrameSchema = z.object({
  type: z.literal("term-detach"),
  terminalId: z.string().min(1),
});
export const TermToDaemonFrameSchema = z.discriminatedUnion("type", [
  TermSpawnFrameSchema,
  TermKillFrameSchema,
  TermDataFrameSchema,
  TermResizeFrameSchema,
  TermAttachFrameSchema,
  TermDetachFrameSchema,
]);

// daemon -> hub frames (term-data reuses TermDataFrameSchema)
export const TermListFrameSchema = z.object({
  type: z.literal("term-list"),
  terminals: z.array(TerminalInfoSchema),
});
export const TermReplayFrameSchema = z.object({
  type: z.literal("term-replay"),
  terminalId: z.string().min(1),
  requestId: z.string().min(1),
  data: z.string(), // base64 ring-buffer snapshot
});
export const TermExitFrameSchema = z.object({
  type: z.literal("term-exit"),
  terminalId: z.string().min(1),
  exitCode: z.number().int(),
});
export const TermErrorFrameSchema = z.object({
  type: z.literal("term-error"),
  message: z.string(),
});

export type TerminalKind = z.infer<typeof TerminalKindSchema>;
export type TerminalInfo = z.infer<typeof TerminalInfoSchema>;
export type SpawnTerminal = z.infer<typeof SpawnTerminalSchema>;
export type TermToDaemonFrame = z.infer<typeof TermToDaemonFrameSchema>;
