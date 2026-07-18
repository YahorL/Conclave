import type {
  AgentConfig, AgentStatus, Approval, Artifact, FsEntry, Message, NewMessage, NewTask, NewWorkspace, Registry, Task, TerminalInfo, TerminalKind, Thread, UsageSummary, Workspace,
} from "@conclave/shared";
import { config } from "./config.js";

export type MachineInfo = { machine: string; files: string[]; terminals: boolean; lastSeen: string };

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      ...config.apiHeaders(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`hub ${method} ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

export const hubClient = {
  listThreads: () => req<Thread[]>("GET", "/api/threads"),
  getThread: (id: string) => req<Thread>("GET", `/api/threads/${id}`),
  listMessages: (threadId: string, after = 0) =>
    req<Message[]>("GET", `/api/threads/${threadId}/messages?after=${after}`),
  postMessage: (threadId: string, msg: NewMessage) =>
    req<Message>("POST", `/api/threads/${threadId}/messages`, msg),
  getRegistry: async () => (await req<Registry>("GET", "/api/registry")).agents as AgentConfig[],
  getStatus: () => req<AgentStatus[]>("GET", "/api/status"),
  getUsageSummary: () => req<UsageSummary>("GET", "/api/usage/summary"),
  createTask: (input: NewTask) => req<Task>("POST", "/api/tasks", input),
  getTask: (id: string) => req<Task>("GET", `/api/tasks/${id}`),
  listTasks: () => req<Task[]>("GET", "/api/tasks"),
  listArtifacts: () => req<Artifact[]>("GET", "/api/artifacts"),
  getArtifact: (id: string) => req<Artifact>("GET", `/api/artifacts/${id}`),
  artifactBlobUrl: (id: string) =>
    `/api/artifacts/${id}/blob${config.token ? `?token=${encodeURIComponent(config.token)}` : ""}`,
  listMachines: () => req<MachineInfo[]>("GET", "/api/machines"),
  fsList: (machine: string, path: string) =>
    req<FsEntry[]>("POST", `/api/fs/${machine}/list`, { path }),
  fsRead: (machine: string, path: string) =>
    req<{ content: string }>("POST", `/api/fs/${machine}/read`, { path }),
  fsWrite: (machine: string, path: string, content: string, threadId?: string) =>
    req<{ ok?: boolean }>("POST", `/api/fs/${machine}/write`, { path, content, threadId }),
  createWorkspace: (input: NewWorkspace) => req<Workspace>("POST", "/api/workspaces", input),
  listWorkspaces: () => req<Workspace[]>("GET", "/api/workspaces"),
  listApprovals: () => req<Approval[]>("GET", "/api/approvals"),
  decideApproval: (id: string, decision: "approved" | "denied", note?: string) =>
    req<Approval>("POST", `/api/approvals/${id}/decide`, { decision, ...(note ? { note } : {}) }),
  listTerminals: () => req<TerminalInfo[]>("GET", "/api/terminals"),
  spawnTerminal: (machine: string, kind: TerminalKind, cwd: string) =>
    req<{ ok: boolean }>("POST", "/api/terminals", { machine, kind, cwd }),
  killTerminal: (id: string) => req<{ ok: boolean }>("DELETE", `/api/terminals/${id}`),
  takeoverTerminal: (machine: string, agentId: string, threadId: string) =>
    req<{ ok: boolean }>("POST", "/api/terminals/takeover", { machine, agentId, threadId }),
  getVapidPublicKey: () => req<{ key: string }>("GET", "/api/push/vapid-public-key"),
  pushSubscribe: (sub: unknown) => req<{ ok: boolean }>("POST", "/api/push/subscribe", sub),
  pushUnsubscribe: (endpoint: string) =>
    req<{ ok: boolean }>("POST", "/api/push/unsubscribe", { endpoint }),
};
