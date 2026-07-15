import { useState } from "react";
import type { TerminalKind } from "@conclave/shared";
import { hubClient, type MachineInfo } from "../lib/hubClient.js";
import { agentColorVar } from "../lib/agents.js";
import { useConclaveStore } from "../store/useConclaveStore.js";
import styles from "./Sidebar.module.css";

export function TerminalsSection(): JSX.Element {
  const terminals = useConclaveStore((s) => s.terminals);
  const setActiveTerminal = useConclaveStore((s) => s.setActiveTerminal);
  const machines = useConclaveStore((s) => s.machines);
  const setMachines = useConclaveStore((s) => s.setMachines);
  const [picking, setPicking] = useState(false);
  const [machine, setMachine] = useState("");
  const [kind, setKind] = useState<TerminalKind>("shell");
  const [cwd, setCwd] = useState("");

  const grantedMachines = machines.filter((m: MachineInfo) => m.terminals);
  const selected = grantedMachines.find((m) => m.machine === (machine || grantedMachines[0]?.machine));

  const openPicker = (): void => {
    setPicking((p) => !p);
    if (machines.length === 0) void hubClient.listMachines().then(setMachines);
  };

  const spawn = (): void => {
    const m = selected;
    if (!m) return;
    const dir = cwd || m.files[0];
    if (!dir) return;
    void hubClient.spawnTerminal(m.machine, kind, dir);
    setPicking(false);
  };

  return (
    <div className={styles.section} data-testid="terminals-section">
      <div className={styles.sectionHeader}>
        terminals
        <button className={styles.spawnBtn} data-testid="spawn-terminal" aria-label="new terminal" onClick={openPicker}>
          +
        </button>
      </div>
      {terminals.map((t) => (
        <button
          key={t.id}
          className={styles.terminalRow}
          data-testid={`terminal-row-${t.id}`}
          onClick={() => setActiveTerminal(t.id)}
        >
          <span className={styles.termGlyph} style={t.agentId ? { color: agentColorVar(t.agentId).bg } : undefined}>
            ❯_
          </span>
          <span className={styles.termLabel}>{t.label}</span>
          <span className={styles.runningDot} />
        </button>
      ))}
      {picking && (
        <div className={styles.spawnPicker}>
          <label>
            machine
            <select
              aria-label="machine"
              value={selected?.machine ?? ""}
              onChange={(e) => {
                setMachine(e.target.value);
                setCwd("");
              }}
            >
              {grantedMachines.map((m) => (
                <option key={m.machine} value={m.machine}>
                  {m.machine}
                </option>
              ))}
            </select>
          </label>
          <label>
            kind
            <select aria-label="kind" value={kind} onChange={(e) => setKind(e.target.value as TerminalKind)}>
              <option value="shell">shell</option>
              <option value="claude">claude</option>
              <option value="codex">codex</option>
            </select>
          </label>
          <label>
            folder
            <select aria-label="folder" value={cwd || selected?.files[0] || ""} onChange={(e) => setCwd(e.target.value)}>
              {(selected?.files ?? []).map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <button data-testid="spawn-submit" onClick={spawn}>
            spawn
          </button>
        </div>
      )}
    </div>
  );
}
