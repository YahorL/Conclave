import { useEffect, useRef, useState } from "react";
import { basicSetup, EditorView } from "codemirror";
import { keymap } from "@codemirror/view";
import { Compartment } from "@codemirror/state";
import { languages } from "@codemirror/language-data";
import { useConclaveStore } from "../store/useConclaveStore.js";
import { hubClient } from "../lib/hubClient.js";
import styles from "./FsFileView.module.css";

const cmTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--code-bg)",
    color: "var(--text-code)",
    fontSize: "11.5px",
    height: "100%",
  },
  ".cm-content": { fontFamily: "var(--font-mono)", caretColor: "var(--text-primary)" },
  ".cm-gutters": {
    backgroundColor: "var(--code-bg)",
    color: "var(--text-muted)",
    border: "none",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "var(--sel-bg)",
  },
  "&.cm-focused .cm-selectionBackground *": { color: "var(--sel-text)" },
  ".cm-activeLine": { backgroundColor: "transparent" },
});

export function FsFileView({ onViewReady }: { onViewReady?: (v: EditorView) => void }): JSX.Element | null {
  const file = useConclaveStore((s) => s.activeFsFile);
  const activeThreadId = useConclaveStore((s) => s.activeThreadId);
  const setFsDirty = useConclaveStore((s) => s.setFsDirty);
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [failed, setFailed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const markDirty = (v: boolean): void => {
    setDirty(v);
    setFsDirty(v);
  };

  const save = async (): Promise<void> => {
    const view = viewRef.current;
    if (!view || !file || saving || !dirty) return;
    setSaving(true);
    setNotice(null);
    try {
      await hubClient.fsWrite(file.machine, file.path, view.state.doc.toString(), activeThreadId ?? undefined);
      markDirty(false);
      setNotice("saved ✓");
      setTimeout(() => setNotice(null), 2000);
    } catch (e) {
      setNotice(`save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (!file || !host.current) return;
    let disposed = false;
    setFailed(false);
    setNotice(null);
    markDirty(false);

    void hubClient
      .fsRead(file.machine, file.path)
      .then(async (r) => {
        if (disposed || !host.current) return;
        const langCompartment = new Compartment();
        const view = new EditorView({
          doc: r.content,
          parent: host.current,
          extensions: [
            basicSetup,
            cmTheme,
            langCompartment.of([]),
            keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { void saveRef.current(); return true; } }]),
            EditorView.updateListener.of((u) => {
              if (u.docChanged) markDirty(true);
            }),
          ],
        });
        viewRef.current = view;

        const name = file.path.split("/").pop() ?? "";
        const desc = languages.find((l) => l.extensions.some((ext) => name.endsWith(`.${ext}`)));
        if (desc) {
          void desc.load().then((support) => {
            if (viewRef.current === view) view.dispatch({ effects: langCompartment.reconfigure(support) });
          });
        }

        if (file.line) {
          const line = Math.max(1, Math.min(file.line, view.state.doc.lines));
          const pos = view.state.doc.line(line).from;
          view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
        }
        onViewReady?.(view);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });

    return () => {
      disposed = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.machine, file?.path]);

  if (!file) return null;

  return (
    <div className={styles.view} data-testid="fs-file-view">
      <div className={styles.header}>
        <span className={styles.path}>{file.path}</span>
        {dirty && <span className={styles.dirty} data-testid="fs-dirty">●</span>}
        {notice && <span className={styles.notice} data-testid="fs-notice">{notice}</span>}
        {!failed && (
          <button
            className={styles.save}
            data-testid="fs-save"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            save
          </button>
        )}
        <span className={styles.machine}>{file.machine}</span>
      </div>
      {failed && <pre className={styles.body}>(failed to read file)</pre>}
      {/* Host stays mounted through failures so the load effect can retry when the file changes. */}
      <div className={styles.editor} data-testid="fs-editor" ref={host} hidden={failed} />
    </div>
  );
}
