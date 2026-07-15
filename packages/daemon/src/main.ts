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
import { loadPty, TerminalService } from "./terminal-service.js";
import { wireTerminals } from "./terminal-wiring.js";

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
  const ptyMod = await loadPty();
  const termsGranted = grants.terminalsGranted() && ptyMod !== null;
  if (grants.terminalsGranted() && !ptyMod) {
    console.warn("terminals granted but node-pty failed to load — terminals disabled");
  }
  const terminalService = ptyMod
    ? new TerminalService(ptyMod, grants, {
        machine: cfg.machine,
        claudeBin: cfg.claudeBin,
        codexBin: cfg.codexBin,
        resolveAgentId: (kind) =>
          agents.find((a) => (kind === "claude" ? a.runtime === "claude-code" : a.runtime === "codex"))?.id,
      })
    : null;
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
  });

  let terminals: ReturnType<typeof wireTerminals>;
  const socket = new HubSocket({
    hubUrl: cfg.hubUrl,
    token: cfg.token,
    onOpen: async () => {
      const caught = await runCatchUp(hub, state, (m) => loop.handleMessage(m));
      if (caught > 0) console.log(`catch-up: processed ${caught} message(s)`);
      const caughtTasks = await runTaskCatchUp(hub, agents, (t) => loop.handleTask(t));
      if (caughtTasks > 0) console.log(`task catch-up: picked up ${caughtTasks} task(s)`);
      socket.send({ type: "hello", machine: cfg.machine, files: grants.roots(), terminals: termsGranted });
      terminals.sendList();
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
    onApproval: (a) => {
      loop.handleApproval(a);
    },
    onFsRequest: (req) => {
      void (async () => socket.send({ type: "fs-response", ...(await fileService.handle(req)) }))();
    },
    onTerm: (f) => terminals.onTerm(f),
  });
  terminals = wireTerminals({
    service: terminalService,
    granted: termsGranted,
    send: (frame) => socket.send(frame),
  });
  socket.start();
  console.log(`conclave daemon on ${cfg.machine}: watching ${agents.length} agent(s) via ${cfg.hubUrl}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
