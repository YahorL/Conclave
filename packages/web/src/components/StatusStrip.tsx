import { useConclaveStore } from "../store/useConclaveStore.js";
import { agentColorVar } from "../lib/agents.js";
import styles from "./StatusStrip.module.css";

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function StatusStrip(): JSX.Element {
  const agents = useConclaveStore((s) => s.agents);
  const statusByAgent = useConclaveStore((s) => s.statusByAgent);
  const usage = useConclaveStore((s) => s.usage);
  const budget = usage?.budgetUsd ?? 0;

  return (
    <aside className={styles.strip} data-testid="status-strip">
      <div className={styles.sectionHeader}>live status</div>
      {agents.map((a) => {
        const st = statusByAgent[a.id];
        const status = st?.status ?? "idle";
        return (
          <div key={a.id} className={styles.card}>
            <div className={styles.cardHead}>
              <span className={styles.swatch} style={{ background: agentColorVar(a.id).bg }} />
              <span className={styles.name}>{a.name}</span>
              <span className={styles.status} data-status={status}>
                ● {status}
              </span>
            </div>
            <div className={styles.activity}>{st?.activity || "idle"}</div>
            <div className={styles.progressTrack}>
              <div className={status === "running" ? styles.progressRunning : styles.progressIdle} />
            </div>
          </div>
        );
      })}

      <div className={styles.sectionHeader}>usage limits</div>
      {(usage?.perAgent ?? []).map((u) => {
        const st = statusByAgent[u.agent];
        const pct = budget > 0 ? Math.min(100, Math.round((u.costUsd / budget) * 100)) : 0;
        return (
          <div key={u.agent} className={styles.usageRow}>
            <span className={styles.swatch} style={{ background: agentColorVar(u.agent).bg }} />
            <span className={styles.name}>{u.agent}</span>
            <span className={styles.metric}>
              {(u.inputTokens + u.outputTokens).toLocaleString()} tok · ${u.costUsd.toFixed(2)}
              {st?.status === "blocked" && st.resetsAt ? ` · resets ${hhmm(st.resetsAt)}` : ""}
            </span>
            <div className={styles.usageTrack}>
              <div className={styles.usageFill} style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}

      <div className={styles.footer}>
        <span>workspace today</span>
        <span className={styles.spend}>
          ${(usage?.totalCostUsd ?? 0).toFixed(2)} / ${budget}
        </span>
      </div>
    </aside>
  );
}
