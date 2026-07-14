import { Settings, History } from "lucide-react";
import { useConclaveStore } from "../store/useConclaveStore.js";
import styles from "./WindowStrip.module.css";

export function WindowStrip(): JSX.Element {
  const usage = useConclaveStore((s) => s.usage);
  const activeId = useConclaveStore((s) => s.activeThreadId);
  const ws =
    useConclaveStore((s) => s.threads.find((t) => t.id === activeId)?.workspace) ?? "workspace";
  const workspaces = useConclaveStore((s) => Object.values(s.workspacesById));
  const activeWorkspaceId = useConclaveStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useConclaveStore((s) => s.setActiveWorkspace);
  const tokens = (usage?.perAgent ?? []).reduce((n, a) => n + a.inputTokens + a.outputTokens, 0);

  return (
    <div className={styles.strip} data-testid="window-strip">
      {workspaces.length > 0 ? (
        workspaces.map((w) => (
          <button
            key={w.id}
            className={w.id === activeWorkspaceId ? styles.tabActive : styles.tab}
            onClick={() => setActiveWorkspace(w.id)}
          >
            {w.name}
          </button>
        ))
      ) : (
        <div className={styles.tabActive}>
          {ws}
          <span className={styles.close}>×</span>
        </div>
      )}
      <div className={styles.right}>
        <Settings size={14} className={styles.icon} />
        <History size={14} className={styles.icon} />
        <span className={styles.spend}>
          ${(usage?.totalCostUsd ?? 0).toFixed(2)} · {(tokens / 1000).toFixed(0)}k tok
        </span>
      </div>
    </div>
  );
}
