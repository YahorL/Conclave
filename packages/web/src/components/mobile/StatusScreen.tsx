import { useConclaveStore } from "../../store/useConclaveStore.js";
import { LiveStatusCards, PushToggle, UsageLimitsSection, WorkspaceFooter } from "../StatusSections.js";
import styles from "./mobile.module.css";

export function StatusScreen(): JSX.Element {
  const ws = useConclaveStore((s) =>
    s.activeWorkspaceId ? s.workspacesById[s.activeWorkspaceId] : undefined,
  );
  return (
    <div className={styles.screen} data-testid="status-screen">
      <header className={styles.screenHeader}>
        <div>
          <h1 className={styles.title}>Status</h1>
          <div className={styles.subline}>{ws ? `${ws.name} · live` : "live"}</div>
        </div>
      </header>
      <LiveStatusCards />
      <UsageLimitsSection />
      <PushToggle />
      <WorkspaceFooter />
    </div>
  );
}
