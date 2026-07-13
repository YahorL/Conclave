import { MessageCircle } from "lucide-react";
import { useConclaveStore } from "../store/useConclaveStore.js";
import { hubClient } from "../lib/hubClient.js";
import { agentColorVar } from "../lib/agents.js";
import { Avatar } from "./Avatar.js";
import styles from "./Sidebar.module.css";

function threadLabel(workspace: string | null, kind: string): string {
  if (workspace) return workspace;
  return kind === "dm" ? "direct message" : "thread";
}

function artifactColor(name: string): string {
  if (/ticket/i.test(name)) return "var(--artifact-ticket)";
  if (/plan/i.test(name)) return "var(--artifact-plan)";
  return "var(--text-secondary-2)";
}

export function Sidebar(): JSX.Element {
  const threads = useConclaveStore((s) => s.threads);
  const agents = useConclaveStore((s) => s.agents);
  const statusByAgent = useConclaveStore((s) => s.statusByAgent);
  const activeThreadId = useConclaveStore((s) => s.activeThreadId);
  const setActiveThread = useConclaveStore((s) => s.setActiveThread);
  const setMessages = useConclaveStore((s) => s.setMessages);
  const artifacts = useConclaveStore((s) => Object.values(s.artifactsById));
  const setActiveArtifact = useConclaveStore((s) => s.setActiveArtifact);

  const openThread = async (id: string): Promise<void> => {
    setActiveThread(id);
    setMessages(id, await hubClient.listMessages(id));
  };

  return (
    <aside className={styles.sidebar} data-testid="sidebar">
      <div className={styles.rail}>
        <button className={styles.railBtnActive} aria-label="chats">
          <MessageCircle size={16} />
        </button>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHeader}>chats</div>
        {threads.map((t) => {
          const selected = t.id === activeThreadId;
          return (
            <button
              key={t.id}
              className={selected ? styles.rowSelected : styles.row}
              onClick={() => void openThread(t.id)}
            >
              <span className={styles.rowLabel}>{threadLabel(t.workspace, t.kind)}</span>
            </button>
          );
        })}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHeader}>agents</div>
        {agents.map((a) => {
          const st = statusByAgent[a.id]?.status ?? "idle";
          return (
            <div key={a.id} className={styles.agentRow}>
              <Avatar name={a.id} kind="agent" size={18} />
              <span className={styles.agentName} style={{ color: agentColorVar(a.id).bg }}>{a.name}</span>
              <span
                className={styles.dot}
                data-status={st}
                style={{
                  background:
                    st === "running" ? "var(--live)" : st === "blocked" ? "var(--blocked)" : "transparent",
                }}
              />
            </div>
          );
        })}
      </div>

      {artifacts.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>artifacts</div>
          {artifacts.map((a) => (
            <button
              key={a.id}
              className={styles.artifactRow}
              onClick={() => setActiveArtifact(a.id)}
            >
              <span className={styles.artifactIcon} style={{ color: artifactColor(a.name) }}>▦</span>
              <span className={styles.artifactName}>{a.name}</span>
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
