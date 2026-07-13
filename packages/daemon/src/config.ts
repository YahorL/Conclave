export interface DaemonConfig {
  hubUrl: string;
  token: string;
  machine: string;
  claudeBin: string;
  codexBin: string;
  stateFile: string;
  allowAgentTriggers: boolean;
}

export function loadDaemonConfig(env: NodeJS.ProcessEnv): DaemonConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  return {
    hubUrl: required("CONCLAVE_HUB_URL").replace(/\/$/, ""),
    token: required("CONCLAVE_TOKEN"),
    machine: required("CONCLAVE_MACHINE"),
    claudeBin: env["CONCLAVE_CLAUDE_BIN"] ?? "claude",
    codexBin: env["CONCLAVE_CODEX_BIN"] ?? "codex",
    stateFile: env["CONCLAVE_STATE_FILE"] ?? "./daemon-state.json",
    allowAgentTriggers: env["CONCLAVE_ALLOW_AGENT_TRIGGERS"] === "1",
  };
}
