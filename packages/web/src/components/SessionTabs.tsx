import { useConclaveStore } from "../store/useConclaveStore.js";
import styles from "./SessionTabs.module.css";

export function SessionTabs(): JSX.Element {
  const threads = useConclaveStore((s) => s.threads);
  const openIds = useConclaveStore((s) => s.openThreadIds);
  const activeId = useConclaveStore((s) => s.activeThreadId);
  const setActive = useConclaveStore((s) => s.setActiveThread);
  const activeArtifactId = useConclaveStore((s) => s.activeArtifactId);
  const artifactsById = useConclaveStore((s) => s.artifactsById);
  const activeTerminalId = useConclaveStore((s) => s.activeTerminalId);
  const terminals = useConclaveStore((s) => s.terminals);
  const activeTerminal = activeTerminalId ? terminals.find((t) => t.id === activeTerminalId) : undefined;

  const label = (id: string): string => threads.find((t) => t.id === id)?.workspace ?? "thread";
  const activeArtifact = activeArtifactId ? artifactsById[activeArtifactId] : undefined;

  return (
    <div className={styles.tabs} data-testid="session-tabs">
      {openIds.map((id) => (
        <button
          key={id}
          className={id === activeId && !activeArtifactId && !activeTerminalId ? styles.tabActive : styles.tab}
          onClick={() => setActive(id)}
        >
          <span className={styles.glyph}>❖</span>
          {label(id)}
        </button>
      ))}
      {activeArtifact && (
        <button className={styles.tabActive} onClick={() => undefined}>
          <span className={styles.glyph}>▦</span>
          <em>{activeArtifact.name}</em>
        </button>
      )}
      {activeTerminal && (
        <button className={styles.tabActive} data-testid="terminal-tab" onClick={() => undefined}>
          <span className={styles.glyph}>❯_</span>
          {activeTerminal.label}
        </button>
      )}
    </div>
  );
}
