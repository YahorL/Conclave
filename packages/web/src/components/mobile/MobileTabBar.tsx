import { Activity, LayoutList, MessageCircle, SquareTerminal } from "lucide-react";
import { useConclaveStore, type MobileTab } from "../../store/useConclaveStore.js";
import styles from "./mobile.module.css";

const TABS: ReadonlyArray<{ id: MobileTab; label: string; Icon: typeof Activity }> = [
  { id: "workspace", label: "Workspace", Icon: LayoutList },
  { id: "chats", label: "Chats", Icon: MessageCircle },
  { id: "terminals", label: "Terminals", Icon: SquareTerminal },
  { id: "status", label: "Status", Icon: Activity },
];

export function MobileTabBar(): JSX.Element {
  const mobileTab = useConclaveStore((s) => s.mobileTab);
  const setMobileTab = useConclaveStore((s) => s.setMobileTab);
  const approvalsById = useConclaveStore((s) => s.approvalsById);
  // Pending-approval threads stand in for unread counts (approved deviation).
  const pendingThreads = new Set(
    Object.values(approvalsById)
      .filter((a) => a.state === "pending")
      .map((a) => a.threadId),
  ).size;

  return (
    <nav className={styles.tabBar} data-testid="mobile-tab-bar">
      {TABS.map(({ id, label, Icon }) => (
        <button
          key={id}
          className={mobileTab === id ? styles.tabActive : styles.tab}
          data-testid={`mobile-tab-${id}`}
          onClick={() => setMobileTab(id)}
        >
          <span className={styles.tabIcon}>
            <Icon size={18} />
            {id === "chats" && pendingThreads > 0 && (
              <span className={styles.tabBadge} data-testid="mobile-chats-badge">
                {pendingThreads}
              </span>
            )}
          </span>
          <span className={styles.tabLabel}>{label}</span>
        </button>
      ))}
    </nav>
  );
}
