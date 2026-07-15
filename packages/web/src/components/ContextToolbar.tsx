import { useConclaveStore } from "../store/useConclaveStore.js";
import styles from "./ContextToolbar.module.css";

export function ContextToolbar(): JSX.Element {
  const activeId = useConclaveStore((s) => s.activeThreadId);
  const thread = useConclaveStore((s) => s.threads.find((t) => t.id === activeId));
  const tasksById = useConclaveStore((s) => s.tasksById);
  const approvalsById = useConclaveStore((s) => s.approvalsById);
  const pendingApprovals = Object.values(approvalsById).filter(
    (a) => a.threadId === activeId && a.state === "pending",
  ).length;
  const count = (thread?.participants ?? []).filter((p) => p !== "you").length;

  const task =
    thread?.kind === "task"
      ? Object.values(tasksById).find((t) => t.threadId === thread.id)
      : undefined;

  return (
    <div className={styles.toolbar} data-testid="context-toolbar">
      <span className={styles.item}>{count} agents ▾</span>
      <span className={styles.sep}>·</span>
      <span className={styles.item}>▣ {thread?.workspace ?? "workspace"}</span>
      {task ? (
        <span className={styles.state} data-task-state={task.state}>● task: {task.state}</span>
      ) : (
        <span className={styles.state}>● {thread?.state ?? "open"}</span>
      )}
      {pendingApprovals > 0 && (
        <span className={styles.state} data-testid="approval-indicator">
          ⚠ {pendingApprovals} approval{pendingApprovals > 1 ? "s" : ""} waiting
        </span>
      )}
    </div>
  );
}
