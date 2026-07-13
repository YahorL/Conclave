import { useConclaveStore } from "../store/useConclaveStore.js";
import { ChatMessage } from "./ChatMessage.js";
import styles from "./GroupChat.module.css";

export function GroupChat(): JSX.Element {
  const activeThreadId = useConclaveStore((s) => s.activeThreadId);
  const messages =
    useConclaveStore((s) => (activeThreadId ? s.messagesByThread[activeThreadId] : undefined)) ?? [];
  const threads = useConclaveStore((s) => s.threads);
  const statusByAgent = useConclaveStore((s) => s.statusByAgent);

  const active = threads.find((t) => t.id === activeThreadId);
  const typing = (active?.participants ?? []).filter(
    (p) =>
      p !== "you" &&
      statusByAgent[p]?.status === "running" &&
      statusByAgent[p]?.threadId === activeThreadId,
  );

  return (
    <div className={styles.chat} data-testid="group-chat">
      {messages.map((m) => (
        <ChatMessage key={m.id} message={m} />
      ))}
      {typing.map((p) => (
        <div key={p} className={styles.typing}>
          {p} is thinking<span className={styles.cursor}>▮</span>
        </div>
      ))}
    </div>
  );
}
