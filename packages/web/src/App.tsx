import { useEffect } from "react";
import { startSync } from "./store/sync.js";
import { useConclaveStore } from "./store/useConclaveStore.js";
import { WindowStrip } from "./components/WindowStrip.js";
import { Sidebar } from "./components/Sidebar.js";
import { SessionTabs } from "./components/SessionTabs.js";
import { ContextToolbar } from "./components/ContextToolbar.js";
import { GroupChat } from "./components/GroupChat.js";
import { Composer } from "./components/Composer.js";
import { StatusStrip } from "./components/StatusStrip.js";
import { ArtifactView } from "./components/ArtifactView.js";
import { FsFileView } from "./components/FsFileView.js";
import { TerminalView } from "./components/TerminalView.js";
import styles from "./App.module.css";

export function App(): JSX.Element {
  useEffect(() => startSync(), []);
  const activeArtifactId = useConclaveStore((s) => s.activeArtifactId);
  const activeFsFile = useConclaveStore((s) => s.activeFsFile);
  const activeTerminalId = useConclaveStore((s) => s.activeTerminalId);
  return (
    <div className={styles.app} data-testid="app-root">
      <WindowStrip />
      <div className={styles.body}>
        <Sidebar />
        <main className={styles.main}>
          <SessionTabs />
          <ContextToolbar />
          {activeTerminalId ? (
            <TerminalView />
          ) : activeFsFile ? (
            <FsFileView />
          ) : activeArtifactId ? (
            <ArtifactView />
          ) : (
            <>
              <GroupChat />
              <Composer />
            </>
          )}
        </main>
        <StatusStrip />
      </div>
    </div>
  );
}
