import { z } from "zod";

export const ArtifactSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().min(1),
  createdBy: z.string().min(1),
  createdAt: z.string().datetime(),
});

export const NewArtifactSchema = z.object({
  name: z.string().min(1),
  mime: z.string().min(1).default("text/plain"),
  content: z.string().min(1),
  createdBy: z.string().min(1).optional(),
});

export type Artifact = z.infer<typeof ArtifactSchema>;
export type NewArtifact = z.infer<typeof NewArtifactSchema>;
