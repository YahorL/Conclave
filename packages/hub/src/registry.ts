import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { RegistrySchema, type Registry } from "@conclave/shared";

export function loadRegistry(path: string): Registry {
  if (!existsSync(path)) return { agents: [], acl: [] };
  return RegistrySchema.parse(parse(readFileSync(path, "utf8")));
}
