import { useMemo, useState } from "react";
import { useConclaveStore } from "../store/useConclaveStore.js";
import { hubClient } from "../lib/hubClient.js";
import styles from "./Composer.module.css";

export function Composer(): JSX.Element {
  const [text, setText] = useState("");
  const activeThreadId = useConclaveStore((s) => s.activeThreadId);
  const threads = useConclaveStore((s) => s.threads);
  const agents = useConclaveStore((s) => s.agents);

  const active = threads.find((t) => t.id === activeThreadId);
  const participantAgents = useMemo(
    () => agents.filter((a) => active?.participants.includes(a.id)),
    [agents, active],
  );
  const mentionQuery = /(?:^|\s)@([\w-]*)$/.exec(text)?.[1];
  const suggestions =
    mentionQuery !== undefined
      ? participantAgents.filter((a) => a.id.startsWith(mentionQuery))
      : [];

  const send = async (): Promise<void> => {
    const body = text.trim();
    if (!body || !activeThreadId) return;
    const ids = new Set(participantAgents.map((a) => a.id));
    const to = [
      ...new Set([...body.matchAll(/@([\w-]+)/g)].map((m) => m[1]).filter((id) => ids.has(id))),
    ];
    setText("");
    await hubClient.postMessage(activeThreadId, { from: "you", to, type: "text", body, artifacts: [] });
  };

  const pick = (id: string): void => setText((t) => t.replace(/@[\w-]*$/, `@${id} `));

  return (
    <div className={styles.wrap} data-testid="composer">
      {suggestions.length > 0 && (
        <div className={styles.suggest}>
          {suggestions.map((a) => (
            <button key={a.id} className={styles.suggestItem} onClick={() => pick(a.id)}>
              @{a.id}
            </button>
          ))}
        </div>
      )}
      <div className={styles.composer}>
        <span className={styles.glyph}>›</span>
        <textarea
          className={styles.input}
          rows={1}
          value={text}
          placeholder="Message war-room — @agent to direct, /task to assign"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <span className={styles.hint}>⏎ send</span>
      </div>
    </div>
  );
}
