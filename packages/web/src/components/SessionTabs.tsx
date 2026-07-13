import { useConclaveStore } from "../store/useConclaveStore.js";
import styles from "./SessionTabs.module.css";

export function SessionTabs(): JSX.Element {
  const threads = useConclaveStore((s) => s.threads);
  const openIds = useConclaveStore((s) => s.openThreadIds);
  const activeId = useConclaveStore((s) => s.activeThreadId);
  const setActive = useConclaveStore((s) => s.setActiveThread);

  const label = (id: string): string => threads.find((t) => t.id === id)?.workspace ?? "thread";

  return (
    <div className={styles.tabs} data-testid="session-tabs">
      {openIds.map((id) => (
        <button
          key={id}
          className={id === activeId ? styles.tabActive : styles.tab}
          onClick={() => setActive(id)}
        >
          <span className={styles.glyph}>❖</span>
          {label(id)}
        </button>
      ))}
    </div>
  );
}
