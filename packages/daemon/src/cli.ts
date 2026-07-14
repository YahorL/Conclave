import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

function load(file: string): string[] {
  if (!existsSync(file)) return [];
  try {
    const p = JSON.parse(readFileSync(file, "utf8")) as { files?: unknown };
    return Array.isArray(p.files) ? (p.files as string[]) : [];
  } catch {
    return [];
  }
}

function save(file: string, files: string[]): void {
  writeFileSync(file, JSON.stringify({ files }, null, 2));
}

export function runCli(argv: string[], grantsFile: string): void {
  const [cmd, arg] = argv;
  const roots = load(grantsFile);
  if (cmd === "grant") {
    if (!arg) throw new Error("usage: conclave-daemon grant <path>");
    const abs = resolve(arg);
    if (!roots.includes(abs)) roots.push(abs);
    save(grantsFile, roots);
    console.log(`granted files: ${abs}`);
  } else if (cmd === "revoke") {
    if (!arg) throw new Error("usage: conclave-daemon revoke <path>");
    save(grantsFile, roots.filter((r) => r !== resolve(arg)));
    console.log(`revoked files: ${resolve(arg)}`);
  } else if (cmd === "grants") {
    for (const r of roots) console.log(r);
  } else {
    console.error("usage: conclave-daemon <grant|revoke|grants> [path]");
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCli(process.argv.slice(2), process.env["CONCLAVE_GRANTS_FILE"] ?? "./conclave-grants.json");
}
