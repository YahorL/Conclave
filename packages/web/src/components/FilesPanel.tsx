import { useConclaveStore } from "../store/useConclaveStore.js";
import { FileTree } from "./FileTree.js";
import styles from "./FilesPanel.module.css";

export function FilesPanel(): JSX.Element {
  const machines = useConclaveStore((s) => s.machines);
  const selected = useConclaveStore((s) => s.selectedMachine);
  const setSelected = useConclaveStore((s) => s.setSelectedMachine);
  const current = machines.find((m) => m.machine === selected);

  return (
    <div className={styles.panel} data-testid="files-panel">
      <div className={styles.header}>files</div>
      {machines.length === 0 ? (
        <div className={styles.empty}>no machines connected</div>
      ) : (
        <select
          className={styles.picker}
          value={selected ?? ""}
          onChange={(e) => setSelected(e.target.value || null)}
        >
          <option value="">select a machine…</option>
          {machines.map((m) => (
            <option key={m.machine} value={m.machine}>{m.machine}</option>
          ))}
        </select>
      )}
      {current && <FileTree machine={current.machine} roots={current.files} />}
    </div>
  );
}
