export interface FileTarget {
  machine: string;
  path: string;
  line?: number;
}

export interface FileLinkCtx {
  activeWorkspace?: { machine: string; folderPath: string };
  selectedMachine: string | null;
  machines: Array<{ machine: string }>;
}

// Resolve a chat file reference ("src/a.ts:41" or "/abs/b.ts") to a concrete
// machine + absolute path. Returns null when the reference cannot be resolved
// (relative path with no active workspace, or no known machine) — the link
// then stays inert.
export function resolveFileLink(raw: string, ctx: FileLinkCtx): FileTarget | null {
  const m = raw.match(/^(.*?):(\d+)$/);
  const pathPart = m ? m[1]! : raw;
  const line = m ? Number(m[2]) : undefined;

  let path: string;
  if (pathPart.startsWith("/")) {
    path = pathPart;
  } else if (ctx.activeWorkspace) {
    path = `${ctx.activeWorkspace.folderPath.replace(/\/$/, "")}/${pathPart}`;
  } else {
    return null;
  }

  const machine =
    ctx.activeWorkspace?.machine ?? ctx.selectedMachine ?? ctx.machines[0]?.machine;
  if (!machine) return null;

  return line === undefined ? { machine, path } : { machine, path, line };
}
