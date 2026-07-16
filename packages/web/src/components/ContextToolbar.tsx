import { useState } from "react";
import { hubClient } from "../lib/hubClient.js";
import { useConclaveStore } from "../store/useConclaveStore.js";
import styles from "./ContextToolbar.module.css";

export function ContextToolbar(): JSX.Element {
  const activeId = useConclaveStore((s) => s.activeThreadId);
  const thread = useConclaveStore((s) => s.threads.find((t) => t.id === activeId));
  const tasksById = useConclaveStore((s) => s.tasksById);
  const approvalsById = useConclaveStore((s) => s.approvalsById);
  const agents = useConclaveStore((s) => s.agents);
  const machines = useConclaveStore((s) => s.machines);
  const setPendingTakeover = useConclaveStore((s) => s.setPendingTakeover);
  const [menuOpen, setMenuOpen] = useState(false);
  const [takeoverError, setTakeoverError] = useState<string | null>(null);
  const pendingApprovals = Object.values(approvalsById).filter(
    (a) => a.threadId === activeId && a.state === "pending",
  ).length;
  const count = (thread?.participants ?? []).filter((p) => p !== "you").length;

  const task =
    thread?.kind === "task"
      ? Object.values(tasksById).find((t) => t.threadId === thread.id)
      : undefined;

  const grantedMachine = (m: string): boolean => {
    const known = machines.find((x) => x.machine === m);
    return known ? known.terminals : machines.length === 0; // unknown-yet → allow (403 will surface)
  };
  const candidates = (thread?.participants ?? [])
    .filter((p) => p !== "you")
    .map((p) => agents.find((a) => a.id === p))
    .filter((a): a is NonNullable<typeof a> => !!a && grantedMachine(a.machine));

  const takeover = (a: { id: string; machine: string }): void => {
    if (!thread) return;
    setTakeoverError(null);
    setPendingTakeover({ agentId: a.id });
    void hubClient.takeoverTerminal(a.machine, a.id, thread.id).catch((e: unknown) => {
      setPendingTakeover(null);
      setTakeoverError(`take over failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    setMenuOpen(false);
  };

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
      {candidates.length === 1 && (
        <button className={styles.takeover} data-testid="takeover" onClick={() => takeover(candidates[0]!)}>
          ⇄ take over
        </button>
      )}
      {candidates.length > 1 && (
        <span className={styles.takeoverWrap}>
          <button className={styles.takeover} data-testid="takeover" onClick={() => setMenuOpen((o) => !o)}>
            ⇄ take over ▾
          </button>
          {menuOpen && (
            <span className={styles.takeoverMenu}>
              {candidates.map((a) => (
                <button key={a.id} data-testid={`takeover-${a.id}`} className={styles.takeoverItem} onClick={() => takeover(a)}>
                  {a.id}
                </button>
              ))}
            </span>
          )}
        </span>
      )}
      {takeoverError && <span className={styles.takeoverError} data-testid="takeover-error">{takeoverError}</span>}
    </div>
  );
}
