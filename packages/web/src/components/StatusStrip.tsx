import { LiveStatusCards, PushToggle, UsageLimitsSection, WorkspaceFooter } from "./StatusSections.js";
import styles from "./StatusStrip.module.css";

export function StatusStrip(): JSX.Element {
  return (
    <aside className={styles.strip} data-testid="status-strip">
      <LiveStatusCards />
      <UsageLimitsSection />
      <PushToggle />
      <WorkspaceFooter />
    </aside>
  );
}
