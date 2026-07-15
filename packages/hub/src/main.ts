import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db.js";
import { Mailbox } from "./mailbox.js";
import { buildServer } from "./server.js";
import { loadRegistry } from "./registry.js";
import { DebateStore } from "./debates.js";
import { DebateOrchestrator } from "./orchestrator.js";
import { AgentStatusStore } from "./status.js";
import { TaskStore } from "./tasks.js";
import { ArtifactStore } from "./artifacts.js";
import { WorkspaceStore } from "./workspaces.js";
import { ApprovalStore } from "./approvals.js";
import webpush from "web-push";
import { loadOrCreateVapid } from "./vapid.js";
import { PushStore } from "./push-store.js";
import { Notifier } from "./notifier.js";

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
const artifacts = new ArtifactStore(db);
const workspaces = new WorkspaceStore(db);
const approvals = new ApprovalStore(db);
const vapid = loadOrCreateVapid(dataDir);
// web-push requires a contact; no real address is needed for a self-hosted subscriber.
webpush.setVapidDetails("mailto:conclave@localhost", vapid.publicKey, vapid.privateKey);
const push = new PushStore(db);
new Notifier({
  mailboxEvents: mailbox.events,
  statusEvents: status.events,
  store: push,
  send: async (sub, payload) => {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      JSON.stringify(payload),
    );
  },
}).start();
const budgetUsd = Number(process.env["CONCLAVE_BUDGET_USD"] ?? 25);
const webDir = process.env["CONCLAVE_WEB_DIR"];
const app = await buildServer({
  mailbox, token, registry, db, orchestrator, status, budgetUsd, tasks, artifacts, workspaces, approvals, webDir,
  push, vapidPublicKey: vapid.publicKey,
});
await app.listen({ port, host: "0.0.0.0" });
console.log(`conclave hub: ${registry.agents.length} agent(s) registered`);
if (webDir && existsSync(join(webDir, "index.html"))) console.log(`conclave hub: serving web app from ${webDir}`);
console.log(`conclave hub listening on :${port}`);
