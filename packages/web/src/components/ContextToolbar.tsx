import styles from "./ContextToolbar.module.css";

export function ContextToolbar(): JSX.Element {
  return <div className={styles.toolbar} data-testid="context-toolbar" />;
}
