import { useConclaveStore } from "../../store/useConclaveStore.js";
import { ChatsScreen } from "./ChatsScreen.js";
import { MobileTabBar } from "./MobileTabBar.js";
import { StatusScreen } from "./StatusScreen.js";
import { TerminalsScreen } from "./TerminalsScreen.js";
import { WorkspaceScreen } from "./WorkspaceScreen.js";
import styles from "./mobile.module.css";

export function MobileShell(): JSX.Element {
  const mobileTab = useConclaveStore((s) => s.mobileTab);
  return (
    <div className={styles.shell} data-testid="mobile-shell">
      {mobileTab === "workspace" && <WorkspaceScreen />}
      {mobileTab === "chats" && <ChatsScreen />}
      {mobileTab === "terminals" && <TerminalsScreen />}
      {mobileTab === "status" && <StatusScreen />}
      <MobileTabBar />
    </div>
  );
}
