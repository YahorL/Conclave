import styles from "./Sidebar.module.css";

export function Sidebar(): JSX.Element {
  return <aside className={styles.sidebar} data-testid="sidebar" />;
}
