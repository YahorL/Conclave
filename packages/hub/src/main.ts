import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db.js";
import { Mailbox } from "./mailbox.js";
import { buildServer } from "./server.js";
import { loadRegistry } from "./registry.js";
import { DebateStore } from "./debates.js";
import { DebateOrchestrator } from "./orchestrator.js";
import { AgentStatusStore } from "./status.js";
import { TaskStore } from "./tasks.js";

const token = process.env["CONCLAVE_TOKEN"];
if (!token) {
  console.error("CONCLAVE_TOKEN is required");
  process.exit(1);
}

const port = Number(process.env["CONCLAVE_PORT"] ?? 7777);
const dataDir = process.env["CONCLAVE_DATA_DIR"] ?? "./data";
mkdirSync(dataDir, { recursive: true });

const db = openDb(join(dataDir, "conclave.db"));
const mailbox = new Mailbox(db);
const registry = loadRegistry(join(dataDir, "registry.yaml"));
const debateStore = new DebateStore(db);
const interrupted = debateStore.markRunningInterrupted();
if (interrupted > 0) console.warn(`${interrupted} debate(s) marked interrupted from previous run`);
const orchestrator = new DebateOrchestrator(mailbox, debateStore);
const status = new AgentStatusStore();
const tasks = new TaskStore(db);
const budgetUsd = Number(process.env["CONCLAVE_BUDGET_USD"] ?? 25);
const app = await buildServer({ mailbox, token, registry, db, orchestrator, status, budgetUsd, tasks });
await app.listen({ port, host: "0.0.0.0" });
console.log(`conclave hub: ${registry.agents.length} agent(s) registered`);
console.log(`conclave hub listening on :${port}`);
