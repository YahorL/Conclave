#!/usr/bin/env node
// Emits Claude-CLI-shaped stream-json. Captures its invocation for assertions.
import { appendFileSync, readFileSync } from "node:fs";

const capture = process.env.FAKE_CLAUDE_CAPTURE;
const stdin = readFileSync(0, "utf8");
const args = process.argv.slice(2);
const resumeIdx = args.indexOf("--resume");
const sessionId = resumeIdx === -1 ? "fake-sess-new" : args[resumeIdx + 1];

if (capture) {
  appendFileSync(
    capture,
    JSON.stringify({ args, stdin, cwd: process.cwd() }) + "\n",
  );
}

if (process.env.FAKE_CLAUDE_MODE === "no-result") {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }));
  process.exit(1);
}
if (process.env.FAKE_CLAUDE_MODE === "hang") {
  setInterval(() => {}, 1000);
} else {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }));
  console.log(
    JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: sessionId,
      result: `echo: ${stdin.trim()}`,
      is_error: false,
      total_cost_usd: 0.01,
    }),
  );
}
