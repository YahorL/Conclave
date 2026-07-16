import { agentColorVar, initials } from "../lib/agents.js";
import styles from "./Avatar.module.css";

export function Avatar({
  name, kind, size = 26,
}: { name: string; kind: "agent" | "human"; size?: number }): JSX.Element {
  const isAgent = kind === "agent";
  const color = isAgent
    ? agentColorVar(name)
    : { bg: "var(--human-avatar-bg)", text: "var(--human-avatar-text)" };
  return (
    <span
      className={styles.avatar}
      data-kind={kind}
      style={{
        width: size, height: size,
        borderRadius: isAgent ? 5 : "50%",
        background: color.bg, color: color.text,
        fontSize: Math.round(size * 0.42),
      }}
    >
      {initials(name)}
    </span>
  );
}
