import { ChevronLeft } from "lucide-react";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { threadLabel } from "../../lib/labels.js";
import { ArtifactView } from "../ArtifactView.js";
import { Avatar } from "../Avatar.js";
import { Composer } from "../Composer.js";
import { GroupChat } from "../GroupChat.js";
import { LazyFsFileView } from "../LazyFsFileView.js";
import { ChatList } from "./ChatList.js";
import styles from "./mobile.module.css";

export function ChatsScreen(): JSX.Element {
  const activeFsFile = useConclaveStore((s) => s.activeFsFile);
  const activeArtifactId = useConclaveStore((s) => s.activeArtifactId);
  const chatListOpen = useConclaveStore((s) => s.chatListOpen);
  const setChatListOpen = useConclaveStore((s) => s.setChatListOpen);
  const setActiveFsFile = useConclaveStore((s) => s.setActiveFsFile);
  const setActiveArtifact = useConclaveStore((s) => s.setActiveArtifact);
  const thread = useConclaveStore((s) => s.threads.find((t) => t.id === s.activeThreadId));
  const agents = useConclaveStore((s) => s.agents);
  const statusByAgent = useConclaveStore((s) => s.statusByAgent);

  if (activeFsFile) {
    const closeEditor = (): void => {
      // Same dirty guard as the desktop file-open call sites.
      if (useConclaveStore.getState().fsDirty && !window.confirm("discard unsaved changes?")) return;
      setActiveFsFile(null);
    };
    return (
      <div className={styles.detailScreen} data-testid="chats-screen">
        <header className={styles.backHeader}>
          <button className={styles.backBtn} data-testid="mobile-back" aria-label="back" onClick={closeEditor}>
            <ChevronLeft size={18} />
          </button>
          <span className={styles.backTitle}>{activeFsFile.path.split("/").pop()}</span>
        </header>
        <LazyFsFileView />
      </div>
    );
  }

  if (activeArtifactId) {
    return (
      <div className={styles.detailScreen} data-testid="chats-screen">
        <header className={styles.backHeader}>
          <button
            className={styles.backBtn}
            data-testid="mobile-back"
            aria-label="back"
            onClick={() => setActiveArtifact(null)}
          >
            <ChevronLeft size={18} />
          </button>
          <span className={styles.backTitle}>artifact</span>
        </header>
        <ArtifactView />
      </div>
    );
  }

  if (chatListOpen || !thread) {
    return (
      <div className={styles.screen} data-testid="chats-screen">
        <div className={styles.sectionHeader}>chats</div>
        <ChatList />
      </div>
    );
  }

  const agentParticipants = thread.participants.filter((p) => agents.some((a) => a.id === p));
  const running = agentParticipants.filter((p) => statusByAgent[p]?.status === "running").length;

  return (
    <div className={styles.detailScreen} data-testid="chats-screen">
      <header className={styles.backHeader}>
        <button
          className={styles.backBtn}
          data-testid="mobile-back"
          aria-label="back"
          onClick={() => setChatListOpen(true)}
        >
          <ChevronLeft size={18} />
        </button>
        <span className={styles.chatTitleWrap}>
          <span className={styles.backTitle}>{threadLabel(thread.workspace, thread.kind)}</span>
          <span className={styles.chatSub}>
            {running > 0 && <span className={styles.liveDot} />}
            {agentParticipants.length} agents · {running} running
          </span>
        </span>
        <span className={styles.avatarStack}>
          {agentParticipants.slice(0, 3).map((p) => (
            <Avatar key={p} name={p} kind="agent" size={22} />
          ))}
        </span>
      </header>
      <GroupChat />
      <Composer />
    </div>
  );
}
