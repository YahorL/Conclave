// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");

function block(selector: string): string {
  // Base ":root" must not match the ":root[data-theme=…]" selectors — anchor
  // it on "{" immediately following ":root".
  const re =
    selector === ":root"
      ? /^:root\s*\{([^}]*)\}/m
      : new RegExp(selector.replace(/[[\]"]/g, "\\$&") + "\\s*\\{([^}]*)\\}", "m");
  const m = css.match(re);
  if (!m) throw new Error(`block not found: ${selector}`);
  return m[1]!;
}

function tokenNames(body: string): string[] {
  return [...body.matchAll(/--[\w-]+(?=\s*:)/g)].map((m) => m[0]).sort();
}

const SHARED = [
  "--agent-claude-code", "--agent-claude-code-text", "--agent-codex", "--agent-codex-text",
  "--agent-default", "--agent-default-text", "--agent-reviewer", "--agent-reviewer-text",
  "--blocked", "--danger", "--font-mono", "--font-sans", "--live", "--warn",
].sort();

describe("theme token structure", () => {
  it("defines the shared tokens once, in base :root only", () => {
    expect(tokenNames(block(":root"))).toEqual(SHARED);
    for (const theme of ["black", "teal"]) {
      const names = tokenNames(block(`:root[data-theme="${theme}"]`));
      for (const s of SHARED) expect(names).not.toContain(s);
    }
  });

  it("teal defines exactly the same token names as black", () => {
    expect(tokenNames(block(':root[data-theme="teal"]'))).toEqual(
      tokenNames(block(':root[data-theme="black"]')),
    );
  });

  it("includes the new role tokens in both themes", () => {
    for (const theme of ["black", "teal"]) {
      const names = tokenNames(block(`:root[data-theme="${theme}"]`));
      for (const t of ["--accent", "--mention-bg", "--mention-text", "--inline-code-text", "--file-link", "--badge-text"]) {
        expect(names).toContain(t);
      }
    }
  });

  it("pins the headline teal values", () => {
    const teal = block(':root[data-theme="teal"]');
    expect(teal).toContain("--surface: #131918");
    expect(teal).toContain("--accent: #2dd4bf");
    expect(teal).toContain("--sel-bg: #124e46");
    expect(teal).toContain("--usage-normal: #2dd4bf");
  });
});
