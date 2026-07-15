import { spawn } from "node:child_process";
import { childEnv } from "./child-env.js";
import { createInterface } from "node:readline";
import type { RuntimeAdapter, TurnOptions, TurnResult } from "./adapter.js";
import { parseStreamLine, summarizeTurn, type CliEvent } from "./stream-json.js";

const DEFAULT_TIMEOUT_MS = 600_000;
const STDERR_LIMIT = 8192;

export class ClaudeCodeAdapter implements RuntimeAdapter {
  constructor(private readonly bin = "claude") {}

  runTurn(opts: TurnOptions): Promise<TurnResult> {
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "dontAsk",
      "--allowedTools", opts.allowedTools.join(","),
    ];
    if (opts.mcpServers) {
      args.push("--mcp-config", JSON.stringify({ mcpServers: opts.mcpServers }));
      args.push("--strict-mcp-config");
    }
    if (opts.sessionId) args.push("--resume", opts.sessionId);

    return new Promise<TurnResult>((resolve, reject) => {
      const child = spawn(this.bin, args, {
        cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], env: childEnv(),
      });
      const events: CliEvent[] = [];
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        fail(new Error(`claude turn timeout after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
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
          succeed(summarizeTurn(events));
        } catch (err) {
          const detail = stderr.trim().slice(-500);
          fail(
            new Error(
              `${(err as Error).message} (exit code ${code}${detail ? `, stderr: ${detail}` : ""})`,
            ),
          );
        }
      });

      // EPIPE when the child dies early must not crash the process; the
      // close handler above settles the turn correctly for every death mode.
      child.stdin.on("error", () => {});
      child.stdin.write(opts.prompt);
      child.stdin.end();
    });
  }
}
