// The coding-agent CLI runs untrusted, prompt-injectable model output with a
// real shell. It must NOT inherit the hub auth token from the daemon's
// environment: a compromised agent that read CONCLAVE_TOKEN could call the hub
// directly (e.g. POST /api/tasks with requestedBy omitted → defaults to "you")
// and bypass the agent-to-agent ACL entirely. The MCP bridge receives the token
// through its own spawn config, so the agent process itself never needs it.
export function childEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  delete env["CONCLAVE_TOKEN"];
  return env;
}
