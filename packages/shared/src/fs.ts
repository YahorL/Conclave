import { z } from "zod";

export const FsOpSchema = z.enum(["list", "stat", "read", "write"]);
export const FsRequestSchema = z.object({
  id: z.string().min(1),
  op: FsOpSchema,
  path: z.string().min(1),
  content: z.string().optional(),
  threadId: z.string().optional(),
});
export const FsResponseSchema = z.object({
  id: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export const HelloSchema = z.object({
  machine: z.string().min(1),
  files: z.array(z.string()),
});
export const FsEntrySchema = z.object({
  name: z.string(),
  kind: z.enum(["file", "dir"]),
  size: z.number().int().nonnegative().optional(),
});
export const FsStatSchema = z.object({
  kind: z.enum(["file", "dir"]),
  size: z.number().int().nonnegative(),
  mtime: z.string(),
});

export type FsOp = z.infer<typeof FsOpSchema>;
export type FsRequest = z.infer<typeof FsRequestSchema>;
export type FsResponse = z.infer<typeof FsResponseSchema>;
export type Hello = z.infer<typeof HelloSchema>;
export type FsEntry = z.infer<typeof FsEntrySchema>;
export type FsStat = z.infer<typeof FsStatSchema>;
