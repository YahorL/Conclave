import { useState } from "react";
import { useConclaveStore } from "../store/useConclaveStore.js";
import { hubClient } from "../lib/hubClient.js";
import type { FsEntry } from "@conclave/shared";
import styles from "./FileTree.module.css";

function join(base: string, name: string): string {
  return `${base.replace(/\/$/, "")}/${name}`;
}

function Node({ machine, path, name, kind }: { machine: string; path: string; name: string; kind: "file" | "dir" }): JSX.Element {
  const [open, setOpen] = useState(false);
  const key = `${machine}:${path}`;
  const children = useConclaveStore((s) => s.fsChildren[key]);
  const setFsChildren = useConclaveStore((s) => s.setFsChildren);
  const setActiveFsFile = useConclaveStore((s) => s.setActiveFsFile);

  if (kind === "file") {
    return (
      <button
        className={styles.file}
        onClick={() => {
          const s = useConclaveStore.getState();
          if (s.fsDirty && !window.confirm("discard unsaved changes?")) return;
          setActiveFsFile({ machine, path });
        }}
      >
        {name}
      </button>
    );
  }
  const toggle = async (): Promise<void> => {
    const next = !open;
    setOpen(next);
    if (next && !children) setFsChildren(key, await hubClient.fsList(machine, path));
  };
  return (
    <div className={styles.dir}>
      <div className={styles.dirRow}>
        <button className={styles.dirName} onClick={() => void toggle()}>
          {open ? "▾" : "▸"} <span className={styles.dirLabel}>{name}</span>
        </button>
        <button
          className={styles.pick}
          title="Set as workspace"
          onClick={() => void hubClient.createWorkspace({ machine, folderPath: path })}
        >
          ＋
        </button>
      </div>
      {open && children && (
        <div className={styles.children}>
          {[...children]
            .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1))
            .map((c: FsEntry) => (
              <Node key={c.name} machine={machine} path={join(path, c.name)} name={c.name} kind={c.kind} />
            ))}
        </div>
      )}
    </div>
  );
}

export function FileTree({ machine, roots }: { machine: string; roots: string[] }): JSX.Element {
  return (
    <div className={styles.tree} data-testid="file-tree">
      {roots.map((r) => (
        <Node key={r} machine={machine} path={r} name={r} kind="dir" />
      ))}
    </div>
  );
}
