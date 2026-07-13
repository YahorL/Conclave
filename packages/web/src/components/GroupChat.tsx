import styles from "./GroupChat.module.css";

export function GroupChat(): JSX.Element {
  return <div className={styles.chat} data-testid="group-chat" />;
}
