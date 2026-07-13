import { useConclaveStore } from "../store/useConclaveStore.js";
import styles from "./ContextToolbar.module.css";

export function ContextToolbar(): JSX.Element {
  const activeId = useConclaveStore((s) => s.activeThreadId);
  const thread = useConclaveStore((s) => s.threads.find((t) => t.id === activeId));
  const count = (thread?.participants ?? []).filter((p) => p !== "you").length;

  return (
    <div className={styles.toolbar} data-testid="context-toolbar">
      <span className={styles.item}>{count} agents ▾</span>
      <span className={styles.sep}>·</span>
      <span className={styles.item}>▣ {thread?.workspace ?? "workspace"}</span>
      <span className={styles.state}>● {thread?.state ?? "open"}</span>
    </div>
  );
}
