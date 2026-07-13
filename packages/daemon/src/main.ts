import { loadDaemonConfig } from "./config.js";
import { HubClient } from "./hub-client.js";
import { HubSocket } from "./hub-socket.js";
import { SessionStore } from "./session-store.js";
import { TurnQueue } from "./turn-queue.js";
import { ClaudeCodeAdapter } from "./claude-adapter.js";
import { AgentLoop } from "./agent-loop.js";

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

  const loop = new AgentLoop({
    agents,
    hub,
    adapter: new ClaudeCodeAdapter(cfg.claudeBin),
    store: new SessionStore(cfg.stateFile),
    queue: new TurnQueue(),
    hubUrl: cfg.hubUrl,
    token: cfg.token,
    allowAgentTriggers: cfg.allowAgentTriggers,
  });

  const socket = new HubSocket({
    hubUrl: cfg.hubUrl,
    token: cfg.token,
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
