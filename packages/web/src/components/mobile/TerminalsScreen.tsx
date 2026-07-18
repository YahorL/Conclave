import { ChevronLeft } from "lucide-react";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { TerminalView } from "../TerminalView.js";
import { TerminalsSection } from "../TerminalsSection.js";
import styles from "./mobile.module.css";

export function TerminalsScreen(): JSX.Element {
  const activeTerminalId = useConclaveStore((s) => s.activeTerminalId);
  const setActiveTerminal = useConclaveStore((s) => s.setActiveTerminal);
  const terminals = useConclaveStore((s) => s.terminals);
  const info = terminals.find((t) => t.id === activeTerminalId);

  if (activeTerminalId) {
    return (
      <div className={styles.detailScreen} data-testid="terminals-screen">
        <header className={styles.backHeader}>
          <button
            className={styles.backBtn}
            data-testid="mobile-back"
            aria-label="back"
            onClick={() => setActiveTerminal(null)}
          >
            <ChevronLeft size={18} />
          </button>
          <span className={styles.backTitle}>{info?.label ?? "terminal"}</span>
        </header>
        <TerminalView />
      </div>
    );
  }

  return (
    <div className={styles.screen} data-testid="terminals-screen">
      <div className={styles.termWrap}>
        <TerminalsSection />
      </div>
      {terminals.length === 0 && <div className={styles.empty}>no terminals</div>}
    </div>
  );
}
