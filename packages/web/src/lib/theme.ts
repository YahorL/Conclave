export type Theme = "black" | "teal";

const KEY = "conclave-theme";
const THEMES: Theme[] = ["black", "teal"];

// Meta theme-color must match each theme's --surface. jsdom can't resolve CSS
// variables from stylesheets, and the browser needs the value before styles
// settle anyway, so the surface colors are mirrored here (source of truth:
// tokens.css — the token-parity test pins the teal value).
export const THEME_SURFACE: Record<Theme, string> = {
  black: "#0d0d0d",
  teal: "#131918",
};

export function readStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return THEMES.includes(v as Theme) ? (v as Theme) : "black";
  } catch {
    return "black";
  }
}

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* private mode — session-only theming */
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_SURFACE[t]);
}
