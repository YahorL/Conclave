import { useState } from "react";
import { Settings } from "lucide-react";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { agentColorVar } from "../../lib/agents.js";
import { artifactColor } from "../../lib/labels.js";
import { Avatar } from "../Avatar.js";
import { SettingsModal } from "../SettingsModal.js";
import { TerminalsSection } from "../TerminalsSection.js";
import { ChatList } from "./ChatList.js";
import styles from "./mobile.module.css";

export function WorkspaceScreen(): JSX.Element {
  const workspacesById = useConclaveStore((s) => s.workspacesById);
  const activeWorkspaceId = useConclaveStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useConclaveStore((s) => s.setActiveWorkspace);
  const usage = useConclaveStore((s) => s.usage);
  const agents = useConclaveStore((s) => s.agents);
  const statusByAgent = useConclaveStore((s) => s.statusByAgent);
  const artifacts = useConclaveStore((s) => Object.values(s.artifactsById));
  const setActiveArtifact = useConclaveStore((s) => s.setActiveArtifact);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const workspaces = Object.values(workspacesById);
  const active = activeWorkspaceId ? workspacesById[activeWorkspaceId] : undefined;
  // Workspace has no branch field; the mock's `main · …` sub-line uses machine
  // instead. Absent segments are omitted (spec: no fake data while the hub loads).
  const subline = [
    active?.machine,
    usage ? `$${usage.totalCostUsd.toFixed(2)} / $${usage.budgetUsd} today` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className={styles.screen} data-testid="workspace-screen">
      <header className={styles.screenHeader}>
        <div>
          {workspaces.length > 1 ? (
            <select
              className={styles.wsSelect}
              aria-label="workspace"
              value={activeWorkspaceId ?? ""}
              onChange={(e) => setActiveWorkspace(e.target.value)}
            >
              <option value="" disabled>
                choose workspace
              </option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          ) : (
            <h1 className={styles.title}>{active?.name ?? workspaces[0]?.name ?? "conclave"}</h1>
          )}
          {subline && <div className={styles.subline}>{subline}</div>}
        </div>
        <button
          className={styles.gearBtn}
          aria-label="settings"
          data-testid="mobile-settings-open"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings size={18} />
        </button>
      </header>

      <div className={styles.sectionHeader}>chats</div>
      <ChatList />

      <div className={styles.termWrap}>
        <TerminalsSection />
      </div>

      <div className={styles.sectionHeader}>agents</div>
      {agents.length === 0 && <div className={styles.empty}>no agents</div>}
      {agents.map((a) => {
        const st = statusByAgent[a.id];
        const status = st?.status ?? "idle";
        return (
          <div key={a.id} className={styles.card} data-testid={`mobile-agent-${a.id}`}>
            <Avatar name={a.id} kind="agent" size={26} />
            <span className={styles.cardTitle}>
              <span style={{ color: agentColorVar(a.id).bg, fontWeight: 600 }}>{a.name}</span>
              <span className={styles.cardPreview}>{st?.activity || "idle"}</span>
            </span>
            <span className={styles.agentStatus} data-status={status}>● {status}</span>
          </div>
        );
      })}

      {artifacts.length > 0 && (
        <>
          <div className={styles.sectionHeader}>artifacts</div>
          {artifacts.map((a) => (
            <button key={a.id} className={styles.card} onClick={() => setActiveArtifact(a.id)}>
              <span style={{ color: artifactColor(a.name) }}>▦</span>
              <span className={styles.cardTitle}>{a.name}</span>
            </button>
          ))}
        </>
      )}

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
