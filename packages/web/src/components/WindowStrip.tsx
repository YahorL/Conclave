import styles from "./WindowStrip.module.css";

export function WindowStrip(): JSX.Element {
  return <div className={styles.strip} data-testid="window-strip" />;
}
