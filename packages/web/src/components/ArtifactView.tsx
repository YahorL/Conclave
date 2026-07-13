import { useEffect, useState } from "react";
import { useConclaveStore } from "../store/useConclaveStore.js";
import { hubClient } from "../lib/hubClient.js";
import styles from "./ArtifactView.module.css";

export function ArtifactView(): JSX.Element | null {
  const id = useConclaveStore((s) => s.activeArtifactId);
  const artifact = useConclaveStore((s) => (id ? s.artifactsById[id] : undefined));
  const [text, setText] = useState<string>("");

  useEffect(() => {
    if (!id) return;
    let alive = true;
    void fetch(hubClient.artifactBlobUrl(id))
      .then((r) => r.text())
      .then((t) => {
        if (alive) setText(t);
      })
      .catch(() => {
        if (alive) setText("(failed to load artifact)");
      });
    return () => {
      alive = false;
    };
  }, [id]);

  if (!id || !artifact) return null;
  return (
    <div className={styles.view} data-testid="artifact-view">
      <div className={styles.header}>
        <span className={styles.name}>{artifact.name}</span>
        <span className={styles.mime}>{artifact.mime}</span>
        <a className={styles.download} href={hubClient.artifactBlobUrl(id)} download={artifact.name}>
          download
        </a>
      </div>
      <pre className={styles.body}>{text}</pre>
    </div>
  );
}
