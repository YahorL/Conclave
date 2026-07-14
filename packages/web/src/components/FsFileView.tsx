import { useEffect, useState } from "react";
import { useConclaveStore } from "../store/useConclaveStore.js";
import { hubClient } from "../lib/hubClient.js";
import styles from "./FsFileView.module.css";

export function FsFileView(): JSX.Element | null {
  const file = useConclaveStore((s) => s.activeFsFile);
  const [text, setText] = useState("");
  useEffect(() => {
    if (!file) return;
    let alive = true;
    void hubClient
      .fsRead(file.machine, file.path)
      .then((r) => { if (alive) setText(r.content); })
      .catch(() => { if (alive) setText("(failed to read file)"); });
    return () => { alive = false; };
  }, [file?.machine, file?.path]);
  if (!file) return null;
  return (
    <div className={styles.view} data-testid="fs-file-view">
      <div className={styles.header}>
        <span className={styles.path}>{file.path}</span>
        <span className={styles.machine}>{file.machine}</span>
      </div>
      <pre className={styles.body}>{text}</pre>
    </div>
  );
}
