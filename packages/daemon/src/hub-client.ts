import type {
  AgentConfig,
  AgentStatusReport,
  Message,
  NewMessage,
  Registry,
  Task,
  TaskState,
  Thread,
  UsageReport,
} from "@conclave/shared";

export class HubApiError extends Error {
  constructor(readonly status: number, body: string) {
    super(`hub api error ${status}: ${body}`);
  }
}

export class HubClient {
  constructor(
    private readonly hubUrl: string,
    private readonly token: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.hubUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new HubApiError(res.status, text);
    return JSON.parse(text) as T;
  }

  async getRegistry(machine: string): Promise<AgentConfig[]> {
    const reg = await this.request<Registry>(
      "GET",
      `/api/registry?machine=${encodeURIComponent(machine)}`,
    );
    return reg.agents;
  }

  getThread(id: string): Promise<Thread> {
    return this.request("GET", `/api/threads/${id}`);
  }

  postMessage(threadId: string, msg: NewMessage): Promise<Message> {
    return this.request("POST", `/api/threads/${threadId}/messages`, msg);
  }

  listAllMessages(after = 0, limit = 500): Promise<Message[]> {
    return this.request("GET", `/api/messages?after=${after}&limit=${limit}`);
  }

  listMessages(threadId: string, after = 0, waitSec = 0): Promise<Message[]> {
    return this.request(
      "GET",
      `/api/threads/${threadId}/messages?after=${after}&wait=${waitSec}`,
    );
  }

  setVerdict(threadId: string, agent: string, verdict: string): Promise<Thread> {
    return this.request("POST", `/api/threads/${threadId}/verdict`, { agent, verdict });
  }

  async postUsage(report: UsageReport): Promise<void> {
    await this.request("POST", "/api/usage", report);
  }

  async postStatus(report: AgentStatusReport): Promise<void> {
    await this.request("POST", "/api/status", report);
  }

  listTasks(assignee: string, state: TaskState): Promise<Task[]> {
    return this.request(
      "GET",
      `/api/tasks?assignee=${encodeURIComponent(assignee)}&state=${encodeURIComponent(state)}`,
    );
  }

  async setTaskState(id: string, state: TaskState): Promise<void> {
    await this.request("POST", `/api/tasks/${id}/state`, { state });
  }
}
