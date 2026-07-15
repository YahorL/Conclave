import type { EventEmitter } from "node:events";
import type { AgentStatus, Approval, PushSubscriptionInfo, Task, Thread } from "@conclave/shared";
import type { PushStore } from "./push-store.js";

export interface NotifyPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export type SendFn = (sub: PushSubscriptionInfo, payload: NotifyPayload) => Promise<void>;

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function approvalPayload(a: Approval): NotifyPayload | null {
  if (a.state !== "pending") return null;
  return {
    title: "Approval needed",
    body: a.action,
    url: `/?thread=${a.threadId}`,
    tag: `approval-${a.id}`,
  };
}

export function taskPayload(t: Task): NotifyPayload | null {
  if (t.state !== "failed") return null;
  return {
    title: "Task failed",
    body: t.spec.slice(0, 80),
    url: `/?thread=${t.threadId}`,
    tag: `task-${t.id}`,
  };
}

export function threadPayload(t: Thread): NotifyPayload | null {
  if (t.state !== "settled") return null;
  const verdicts = Object.values(t.verdicts);
  return {
    title: "Thread settled",
    body: verdicts.length ? verdicts.join("; ").slice(0, 120) : "decision reached",
    url: `/?thread=${t.id}`,
    tag: `thread-${t.id}`,
  };
}

export function statusPayload(s: AgentStatus): NotifyPayload | null {
  if (s.status !== "blocked") return null;
  return {
    title: `${s.agent} blocked`,
    body: s.resetsAt ? `resets ${hhmm(s.resetsAt)}` : "usage limit reached",
    url: "/",
    tag: `status-${s.agent}`,
  };
}

interface NotifierDeps {
  mailboxEvents: EventEmitter;
  statusEvents?: EventEmitter;
  store: PushStore;
  send: SendFn;
}

export class Notifier {
  private readonly inFlight = new Set<Promise<unknown>>();

  private readonly onApproval = (a: Approval): void => this.fanOut(approvalPayload(a));
  private readonly onTask = (t: Task): void => this.fanOut(taskPayload(t));
  private readonly onThread = (t: Thread): void => this.fanOut(threadPayload(t));
  private readonly onStatus = (s: AgentStatus): void => this.fanOut(statusPayload(s));

  constructor(private readonly deps: NotifierDeps) {}

  start(): void {
    this.deps.mailboxEvents.on("approval", this.onApproval);
    this.deps.mailboxEvents.on("task", this.onTask);
    this.deps.mailboxEvents.on("thread", this.onThread);
    this.deps.statusEvents?.on("agent-status", this.onStatus);
  }

  stop(): void {
    this.deps.mailboxEvents.off("approval", this.onApproval);
    this.deps.mailboxEvents.off("task", this.onTask);
    this.deps.mailboxEvents.off("thread", this.onThread);
    this.deps.statusEvents?.off("agent-status", this.onStatus);
  }

  // Test hook (mirrors AgentLoop.idle): resolves when all in-flight sends settle.
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  private fanOut(payload: NotifyPayload | null): void {
    if (!payload) return;
    // allSettled: one dead endpoint must not block delivery to the others.
    const work = Promise.allSettled(
      this.deps.store.list().map((sub) => this.trySend(sub, payload)),
    );
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  private async trySend(sub: PushSubscriptionInfo, payload: NotifyPayload): Promise<void> {
    try {
      await this.deps.send(sub, payload);
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        this.deps.store.remove(sub.endpoint); // expired/gone — prune
      } else {
        console.error(
          `push send failed (${sub.endpoint}):`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  }
}
