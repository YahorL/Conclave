import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { onTermFrame, sendFrame } from "../lib/socket.js";
import { b64decode, b64encode } from "../lib/base64.js";
import { hubClient } from "../lib/hubClient.js";
import { useConclaveStore } from "../store/useConclaveStore.js";
import styles from "./TerminalView.module.css";

function tokenColor(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function TerminalView(): JSX.Element | null {
  const id = useConclaveStore((s) => s.activeTerminalId);
  const info = useConclaveStore((s) => s.terminals.find((t) => t.id === s.activeTerminalId));
  const ref = useRef<HTMLDivElement>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  // Live term-data emitted between the hub marking us attached and the daemon
  // snapshotting its ring buffer is delivered BOTH live and inside the replay.
  // Drop live data until the matching replay arrives; the replay already holds
  // everything emitted before the daemon processed the attach, so nothing is lost.
  const replayed = useRef(false);

  useEffect(() => {
    if (!id || !ref.current) return;
    setExitCode(null);
    replayed.current = false;
    const term = new Terminal({
      fontSize: 11,
      fontFamily: '"JetBrains Mono", monospace',
      theme: {
        background: tokenColor("--surface", "#0d0d0d"),
        foreground: tokenColor("--text-primary", "#f5f5f5"),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    try {
      fit.fit();
    } catch {
      /* jsdom / zero-size container */
    }

    const requestId = crypto.randomUUID();
    const off = onTermFrame((f) => {
      if (f.type === "term-replay" && f.requestId === requestId && f.terminalId === id) {
        if (f.data) term.write(b64decode(f.data));
        replayed.current = true; // even an empty replay opens the live-data gate
      } else if (f.type === "term-data" && f.terminalId === id && f.data) {
        if (replayed.current) term.write(b64decode(f.data));
      } else if (f.type === "term-exit" && f.terminalId === id) {
        setExitCode(f.exitCode ?? 0);
      }
    });
    sendFrame({ type: "term-attach", terminalId: id, requestId });

    const input = term.onData((d) => sendFrame({ type: "term-data", terminalId: id, data: b64encode(d) }));
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        sendFrame({ type: "term-resize", terminalId: id, cols: term.cols, rows: term.rows });
      } catch {
        /* ignore */
      }
    });
    ro.observe(ref.current);

    return () => {
      ro.disconnect();
      input.dispose();
      off();
      sendFrame({ type: "term-detach", terminalId: id });
      term.dispose();
    };
  }, [id]);

  if (!id) return null;

  // The terminal vanished from the list without a term-exit (e.g. the daemon
  // disconnected and the hub cleared + rebroadcast). Distinct from "exited (n)".
  const lost = !info && exitCode === null;

  return (
    <div className={styles.wrap} data-testid="terminal-view">
      <div className={styles.header}>
        <span className={styles.label}>{info?.label ?? id}</span>
        {exitCode !== null ? (
          <span className={styles.exited}>exited ({exitCode})</span>
        ) : lost ? (
          <span className={styles.lost} data-testid="terminal-lost">
            connection lost
          </span>
        ) : (
          <button className={styles.kill} onClick={() => void hubClient.killTerminal(id).catch(() => {})}>
            ✕ kill
          </button>
        )}
      </div>
      <div className={styles.term} ref={ref} />
    </div>
  );
}
