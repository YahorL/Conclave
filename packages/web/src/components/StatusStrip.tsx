import { useEffect, useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { useConclaveStore } from "../store/useConclaveStore.js";
import { agentColorVar } from "../lib/agents.js";
import { disablePush, enablePush, isPushEnabled, pushPermission, pushSupported } from "../lib/push.js";
import { fmtTok, usageSeverity } from "../lib/severity.js";
import styles from "./StatusStrip.module.css";

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function WindowMeter({ label, agent, used, pct }: {
  label: string; agent: string; used: number; pct?: number;
}): JSX.Element {
  const key = label === "5h" ? "5h" : "wk";
  return (
    <span className={styles.window} data-testid={`win-${key}-${agent}`}>
      <span className={styles.winLabel}>{label}</span>
      {pct === undefined ? (
        <span className={styles.winText}>{fmtTok(used)} tok</span>
      ) : (
        <>
          <span className={styles.winTrack}>
            <span
              className={styles.winFill}
              data-severity={usageSeverity(pct)}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </span>
          <span className={styles.winPct} data-severity={usageSeverity(pct)}>{pct}%</span>
        </>
      )}
    </span>
  );
}

export function StatusStrip(): JSX.Element {
  const agents = useConclaveStore((s) => s.agents);
  const statusByAgent = useConclaveStore((s) => s.statusByAgent);
  const usage = useConclaveStore((s) => s.usage);
  const budget = usage?.budgetUsd ?? 0;

  const [pushOn, setPushOn] = useState(false);
  useEffect(() => {
    if (pushSupported()) void isPushEnabled().then(setPushOn);
  }, []);
  const denied = pushPermission() === "denied";
  const togglePush = async (): Promise<void> => {
    try {
      if (pushOn) {
        await disablePush();
        setPushOn(false);
      } else {
        await enablePush();
        setPushOn(true);
      }
    } catch {
      setPushOn(await isPushEnabled()); // re-sync on failure (e.g. permission refused)
    }
  };

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
        const pct = budget > 0 ? Math.round((u.costUsd / budget) * 100) : 0;
        return (
          <div key={u.agent} className={styles.usageRow}>
            <span className={styles.swatch} style={{ background: agentColorVar(u.agent).bg }} />
            <span className={styles.name}>{u.agent}</span>
            <span className={styles.metric}>
              {(u.inputTokens + u.outputTokens).toLocaleString()} tok · ${u.costUsd.toFixed(2)}
              {st?.status === "blocked" && st.resetsAt ? ` · resets ${hhmm(st.resetsAt)}` : ""}
            </span>
            <div className={styles.usageTrack}>
              <div
                className={styles.usageFill}
                data-severity={usageSeverity(pct)}
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
            <div className={styles.windows}>
              <WindowMeter label="5h" agent={u.agent} used={u.window5hTokens} pct={u.window5hPct} />
              <WindowMeter label="wk" agent={u.agent} used={u.weeklyTokens} pct={u.weeklyPct} />
            </div>
          </div>
        );
      })}

      {pushSupported() && (
        <button
          className={styles.pushToggle}
          data-testid="push-toggle"
          disabled={denied}
          title={
            denied
              ? "notifications blocked in browser settings"
              : pushOn
                ? "disable notifications"
                : "enable notifications"
          }
          onClick={() => void togglePush()}
        >
          {pushOn ? <Bell size={13} /> : <BellOff size={13} />}
          <span>{pushOn ? "notifications on" : "notifications off"}</span>
        </button>
      )}

      <div className={styles.footer}>
        <span>workspace today</span>
        <span className={styles.spend}>
          ${(usage?.totalCostUsd ?? 0).toFixed(2)} / ${budget}
        </span>
      </div>
    </aside>
  );
}
