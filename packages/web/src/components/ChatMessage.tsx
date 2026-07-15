import type { Message } from "@conclave/shared";
import { useConclaveStore } from "../store/useConclaveStore.js";
import { agentColorVar } from "../lib/agents.js";
import { parseMessageBody, type Block, type InlineSeg } from "../lib/parseMessage.js";
import { Avatar } from "./Avatar.js";
import { ApprovalCard } from "./ApprovalCard.js";
import styles from "./ChatMessage.module.css";

const BADGE: Partial<Record<Message["type"], string>> = { proposal: "plan", verdict: "verdict" };

function hhmm(ts: string): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function Inline({ seg }: { seg: InlineSeg }): JSX.Element {
  switch (seg.kind) {
    case "mention":
      return <span className={styles.mention}>@{seg.id}</span>;
    case "code":
      return <code className={styles.inlineCode}>{seg.text}</code>;
    case "file":
      return (
        <a className={styles.file} href="#" onClick={(e) => e.preventDefault()}>
          {seg.path}
        </a>
      );
    default:
      return <>{seg.text}</>;
  }
}

function renderBlock(b: Block, i: number): JSX.Element {
  if (b.kind === "codeblock") {
    return (
      <pre key={i} className={styles.codeblock}>
        {b.lines.map((l, j) => (
          <div key={j} className={styles.codeline}>
            {l || " "}
          </div>
        ))}
      </pre>
    );
  }
  return (
    <p key={i} className={styles.para}>
      {b.segments.map((s, j) => (
        <Inline key={j} seg={s} />
      ))}
    </p>
  );
}

export function ChatMessage({ message }: { message: Message }): JSX.Element {
  const agentIds = useConclaveStore((s) => s.agents.map((a) => a.id));
  const isHuman = message.from === "you";
  const badge = BADGE[message.type];

  if (message.type === "approval-request") {
    return <ApprovalCard message={message} />;
  }

  if (message.type === "status") {
    return (
      <div className={styles.systemLine} data-testid="status-line">
        {message.body}
      </div>
    );
  }

  const blocks = parseMessageBody(message.body, agentIds);
  return (
    <div className={styles.message}>
      <Avatar name={message.from} kind={isHuman ? "human" : "agent"} />
      <div className={styles.content}>
        <div className={styles.header}>
          <span
            className={styles.name}
            style={{ color: isHuman ? "var(--text-primary)" : agentColorVar(message.from).bg }}
          >
            {message.from}
          </span>
          <span className={styles.ts}>{hhmm(message.ts)}</span>
          {badge && <span className={styles.badge}>{badge}</span>}
        </div>
        <div className={styles.body}>{blocks.map(renderBlock)}</div>
      </div>
    </div>
  );
}
