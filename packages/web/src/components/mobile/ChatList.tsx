import { useConclaveStore } from "../../store/useConclaveStore.js";
import { hubClient } from "../../lib/hubClient.js";
import { threadLabel } from "../../lib/labels.js";
import styles from "./mobile.module.css";

// Chats tab badge + card badge use the pending-approval signal — the store has
// no unread counts (approved deviation from the phone mock's unread badges).
export function ChatList(): JSX.Element {
  const threads = useConclaveStore((s) => s.threads);
  const activeThreadId = useConclaveStore((s) => s.activeThreadId);
  const setActiveThread = useConclaveStore((s) => s.setActiveThread);
  const setMessages = useConclaveStore((s) => s.setMessages);
  const messagesByThread = useConclaveStore((s) => s.messagesByThread);
  const workspacesById = useConclaveStore((s) => s.workspacesById);
  const activeWorkspaceId = useConclaveStore((s) => s.activeWorkspaceId);
  const approvalsById = useConclaveStore((s) => s.approvalsById);

  const active = activeWorkspaceId ? workspacesById[activeWorkspaceId] : undefined;
  const shown = active ? threads.filter((t) => t.workspace === active.name) : threads;
  const pending = new Set(
    Object.values(approvalsById)
      .filter((a) => a.state === "pending")
      .map((a) => a.threadId),
  );

  const open = async (id: string): Promise<void> => {
    setActiveThread(id);
    setMessages(id, await hubClient.listMessages(id));
  };

  return (
    <div className={styles.cardList} data-testid="mobile-chat-list">
      {shown.length === 0 && <div className={styles.empty}>no chats</div>}
      {shown.map((t) => {
        const msgs = messagesByThread[t.id];
        const last = msgs?.[msgs.length - 1];
        return (
          <button
            key={t.id}
            className={t.id === activeThreadId ? styles.cardSelected : styles.card}
            data-testid={`mobile-chat-${t.id}`}
            onClick={() => void open(t.id)}
          >
            <span className={styles.cardTitle}>
              <span>{threadLabel(t.workspace, t.kind)}</span>
              {last && (
                <span className={styles.cardPreview}>{`${last.from}: ${last.body.slice(0, 80)}`}</span>
              )}
            </span>
            {pending.has(t.id) && (
              <span className={styles.cardBadge} data-testid="mobile-approval-badge">!</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
