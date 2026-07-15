import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

interface Grants {
  files: string[];
  terminals: boolean;
}

function load(file: string): Grants {
  if (!existsSync(file)) return { files: [], terminals: false };
  try {
    const p = JSON.parse(readFileSync(file, "utf8")) as { files?: unknown; terminals?: unknown };
    return {
      files: Array.isArray(p.files) ? (p.files as string[]) : [],
      terminals: p.terminals === true,
    };
  } catch {
    return { files: [], terminals: false };
  }
}

function save(file: string, grants: Grants): void {
  writeFileSync(file, JSON.stringify(grants, null, 2));
}

export function runCli(argv: string[], grantsFile: string): void {
  const [cmd, arg] = argv;
  const grants = load(grantsFile);
  if (cmd === "grant") {
    if (!arg) throw new Error("usage: conclave-daemon grant <path>");
    const abs = resolve(arg);
    if (!grants.files.includes(abs)) grants.files.push(abs);
    save(grantsFile, grants);
    console.log(`granted files: ${abs}`);
  } else if (cmd === "revoke") {
    if (!arg) throw new Error("usage: conclave-daemon revoke <path>");
    grants.files = grants.files.filter((r) => r !== resolve(arg));
    save(grantsFile, grants);
    console.log(`revoked files: ${resolve(arg)}`);
  } else if (cmd === "grant-terminals") {
    grants.terminals = true;
    save(grantsFile, grants);
    console.log("granted terminals");
  } else if (cmd === "revoke-terminals") {
    grants.terminals = false;
    save(grantsFile, grants);
    console.log("revoked terminals");
  } else if (cmd === "grants") {
    for (const r of grants.files) console.log(r);
    console.log(`terminals: ${grants.terminals ? "on" : "off"}`);
  } else {
    console.error("usage: conclave-daemon <grant|revoke|grant-terminals|revoke-terminals|grants> [path]");
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCli(process.argv.slice(2), process.env["CONCLAVE_GRANTS_FILE"] ?? "./conclave-grants.json");
}
