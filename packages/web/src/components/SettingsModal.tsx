import { useEffect } from "react";
import type { Theme } from "../lib/theme.js";
import { useConclaveStore } from "../store/useConclaveStore.js";
import styles from "./SettingsModal.module.css";

export function SettingsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const theme = useConclaveStore((s) => s.theme);
  const setTheme = useConclaveStore((s) => s.setTheme);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const seg = (t: Theme, label: string): JSX.Element => (
    <button
      data-testid={`theme-${t}`}
      className={theme === t ? styles.segActive : styles.seg}
      aria-pressed={theme === t}
      onClick={() => setTheme(t)}
    >
      {label}
    </button>
  );

  return (
    <div className={styles.backdrop} data-testid="settings-backdrop" onClick={onClose}>
      <div className={styles.modal} data-testid="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className={styles.title}>settings</div>
        <div className={styles.row}>
          <span className={styles.label}>color scheme</span>
          <span className={styles.segmented}>
            {seg("black", "Black")}
            {seg("teal", "Teal")}
          </span>
        </div>
      </div>
    </div>
  );
}
