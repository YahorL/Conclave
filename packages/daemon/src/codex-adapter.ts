import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { RuntimeAdapter, TurnOptions, TurnResult } from "./adapter.js";
import { parseStreamLine, summarizeCodexTurn, type CliEvent } from "./stream-json.js";

const DEFAULT_TIMEOUT_MS = 600_000;
const STDERR_LIMIT = 8192;

export class CodexAdapter implements RuntimeAdapter {
  constructor(private readonly bin = "codex") {}

  runTurn(opts: TurnOptions): Promise<TurnResult> {
    // opts.allowedTools intentionally unused: Codex has no per-tool allowlist;
    // the workspace-write sandbox is the control surface.
    const args = ["exec"];
    if (opts.sessionId) args.push("resume", opts.sessionId);
    args.push("--json", "--sandbox", "workspace-write", "-c", "approval_policy=never");
    if (opts.mcpServers) {
      for (const [name, server] of Object.entries(opts.mcpServers)) {
        const s = server as { command: string; args?: string[]; env?: Record<string, string> };
        args.push("-c", `mcp_servers.${name}.command=${JSON.stringify(s.command)}`);
        if (s.args) args.push("-c", `mcp_servers.${name}.args=${JSON.stringify(s.args)}`);
        for (const [key, value] of Object.entries(s.env ?? {})) {
          args.push("-c", `mcp_servers.${name}.env.${key}=${JSON.stringify(value)}`);
        }
      }
    }

    return new Promise<TurnResult>((resolve, reject) => {
      const child = spawn(this.bin, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
      const events: CliEvent[] = [];
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        fail(new Error(`codex turn timeout after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
        child.kill("SIGKILL");
      }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      function fail(err: Error): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }

      function succeed(result: TurnResult): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }

      child.on("error", (err) => fail(new Error(`failed to spawn ${this.bin}: ${err.message}`)));
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > STDERR_LIMIT) stderr = stderr.slice(-STDERR_LIMIT);
      });

      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        const event = parseStreamLine(line);
        if (!event) return;
        events.push(event);
        opts.onEvent?.(event);
      });

      child.on("close", (code) => {
        try {
          succeed(summarizeCodexTurn(events, opts.sessionId));
        } catch (err) {
          const detail = stderr.trim().slice(-500);
          fail(
            new Error(
              `${(err as Error).message} (exit code ${code}${detail ? `, stderr: ${detail}` : ""})`,
            ),
          );
        }
      });

      // EPIPE when the child dies before draining stdin must not crash the
      // process; the close handler settles the turn for every death mode.
      child.stdin.on("error", () => {});
      child.stdin.write(opts.prompt);
      child.stdin.end();
    });
  }
}
