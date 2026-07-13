import type {
  AgentConfig, AgentStatus, Message, NewMessage, NewTask, Registry, Task, Thread, UsageSummary,
} from "@conclave/shared";
import { config } from "./config.js";

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
};
