#!/usr/bin/env node
// Emits codex-exec-shaped JSONL. Captures its invocation for assertions.
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_CODEX_MODE === "die-early") process.exit(1);

const stdin = readFileSync(0, "utf8");
const resumeIdx = args.indexOf("resume");
const threadId = resumeIdx === -1 ? "codex-thread-new" : args[resumeIdx + 1];

if (process.env.FAKE_CODEX_CAPTURE) {
  appendFileSync(
    process.env.FAKE_CODEX_CAPTURE,
    JSON.stringify({ args, stdin, cwd: process.cwd() }) + "\n",
  );
}

if (process.env.FAKE_CODEX_MODE === "fail") {
  console.log(JSON.stringify({ type: "thread.started", thread_id: threadId }));
  console.log(JSON.stringify({ type: "turn.failed", error: { message: "usage limit reached" } }));
  process.exit(1);
}
if (process.env.FAKE_CODEX_MODE === "hang") {
  setInterval(() => {}, 1000);
} else {
  console.log(JSON.stringify({ type: "thread.started", thread_id: threadId }));
  console.log(JSON.stringify({ type: "turn.started" }));
  console.log(JSON.stringify({
    type: "item.completed",
    item: { id: "item_1", type: "agent_message", text: `codex says: ${stdin.trim()}` },
  }));
  console.log(JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 25 },
  }));
}
