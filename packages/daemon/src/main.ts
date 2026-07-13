import { loadDaemonConfig } from "./config.js";
import { HubClient } from "./hub-client.js";
import { HubSocket } from "./hub-socket.js";
import { DaemonState } from "./daemon-state.js";
import { TurnQueue } from "./turn-queue.js";
import { ClaudeCodeAdapter } from "./claude-adapter.js";
import { AgentLoop, runCatchUp } from "./agent-loop.js";

async function main(): Promise<void> {
  const cfg = loadDaemonConfig(process.env);
  const hub = new HubClient(cfg.hubUrl, cfg.token);

  const agents = (await hub.getRegistry(cfg.machine)).filter(
    (a) => a.runtime === "claude-code",
  );
  if (agents.length === 0) {
    console.warn(`no claude-code agents registered for machine "${cfg.machine}" — idling`);
  }
  for (const a of agents) console.log(`agent ${a.id} → ${a.workspace}`);

  const state = new DaemonState(cfg.stateFile);
  const loop = new AgentLoop({
    agents,
    hub,
    adapter: new ClaudeCodeAdapter(cfg.claudeBin),
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
    },
    onMessage: (m) => {
      loop.handleMessage(m);
    },
  });
  socket.start();
  console.log(`conclave daemon on ${cfg.machine}: watching ${agents.length} agent(s) via ${cfg.hubUrl}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
