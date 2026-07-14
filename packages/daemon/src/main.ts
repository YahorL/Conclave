import { loadDaemonConfig } from "./config.js";
import { HubClient } from "./hub-client.js";
import { HubSocket } from "./hub-socket.js";
import { DaemonState } from "./daemon-state.js";
import { TurnQueue } from "./turn-queue.js";
import { ClaudeCodeAdapter } from "./claude-adapter.js";
import { CodexAdapter } from "./codex-adapter.js";
import { AgentLoop, runCatchUp, runTaskCatchUp } from "./agent-loop.js";
import { GrantStore } from "./grants.js";
import { FileService } from "./file-service.js";

async function main(): Promise<void> {
  const cfg = loadDaemonConfig(process.env);
  const hub = new HubClient(cfg.hubUrl, cfg.token);

  const agents = await hub.getRegistry(cfg.machine);
  if (agents.length === 0) {
    console.warn(`no agents registered for machine "${cfg.machine}" — idling`);
  }
  for (const a of agents) console.log(`agent ${a.id} → ${a.workspace}`);

  const state = new DaemonState(cfg.stateFile);
  const grants = new GrantStore(process.env["CONCLAVE_GRANTS_FILE"] ?? "./conclave-grants.json");
  const fileService = new FileService(grants);
  const loop = new AgentLoop({
    agents,
    hub,
    adapters: {
      "claude-code": new ClaudeCodeAdapter(cfg.claudeBin),
      codex: new CodexAdapter(cfg.codexBin),
    },
    state,
    queue: new TurnQueue(),
    hubUrl: cfg.hubUrl,
    token: cfg.token,
    allowAgentTriggers: cfg.allowAgentTriggers,
  });

  const socket = new HubSocket({
    hubUrl: cfg.hubUrl,
    token: cfg.token,
    onOpen: async () => {
      const caught = await runCatchUp(hub, state, (m) => loop.handleMessage(m));
      if (caught > 0) console.log(`catch-up: processed ${caught} message(s)`);
      const caughtTasks = await runTaskCatchUp(hub, agents, (t) => loop.handleTask(t));
      if (caughtTasks > 0) console.log(`task catch-up: picked up ${caughtTasks} task(s)`);
      socket.send({ type: "hello", machine: cfg.machine, files: grants.roots() });
    },
    onMessage: (m) => {
      loop.handleMessage(m);
    },
    onTurn: (turn) => {
      loop.handleTurnRequest(turn);
    },
    onTask: (task) => {
      loop.handleTask(task);
    },
    onFsRequest: (req) => {
      void (async () => socket.send({ type: "fs-response", ...(await fileService.handle(req)) }))();
    },
  });
  socket.start();
  console.log(`conclave daemon on ${cfg.machine}: watching ${agents.length} agent(s) via ${cfg.hubUrl}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
