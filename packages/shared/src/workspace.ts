import { z } from "zod";

export const WorkspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  machine: z.string().min(1),
  folderPath: z.string().min(1),
  createdAt: z.string().datetime(),
});

export const NewWorkspaceSchema = z.object({
  name: z.string().min(1).optional(),
  machine: z.string().min(1),
  folderPath: z.string().min(1),
});

export type Workspace = z.infer<typeof WorkspaceSchema>;
export type NewWorkspace = z.infer<typeof NewWorkspaceSchema>;
