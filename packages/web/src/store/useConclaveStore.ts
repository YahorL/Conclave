import { create } from "zustand";
import type { AgentConfig, AgentStatus, Message, Task, Thread, UsageSummary } from "@conclave/shared";
import type { WsFrame } from "../lib/socket.js";

interface State {
  threads: Thread[];
  messagesByThread: Record<string, Message[]>;
  agents: AgentConfig[];
  statusByAgent: Record<string, AgentStatus>;
  usage: UsageSummary | null;
  tasksById: Record<string, Task>;
  activeThreadId: string | null;
  openThreadIds: string[];
  setThreads(t: Thread[]): void;
  setMessages(threadId: string, m: Message[]): void;
  setAgents(a: AgentConfig[]): void;
  setStatuses(s: AgentStatus[]): void;
  setUsage(u: UsageSummary): void;
  setActiveThread(id: string): void;
  openThread(id: string): void;
  applyFrame(f: WsFrame): void;
  reset(): void;
}

function upsertMessage(list: Message[], m: Message): Message[] {
  if (list.some((x) => x.id === m.id)) return list;
  return [...list, m].sort((a, b) => a.id - b.id);
}

const initial = {
  threads: [] as Thread[],
  messagesByThread: {} as Record<string, Message[]>,
  agents: [] as AgentConfig[],
  statusByAgent: {} as Record<string, AgentStatus>,
  usage: null as UsageSummary | null,
  tasksById: {} as Record<string, Task>,
  activeThreadId: null as string | null,
  openThreadIds: [] as string[],
};

export const useConclaveStore = create<State>((set) => ({
  ...initial,
  setThreads: (threads) => set({ threads }),
  setMessages: (threadId, m) =>
    set((s) => ({ messagesByThread: { ...s.messagesByThread, [threadId]: m } })),
  setAgents: (agents) => set({ agents }),
  setStatuses: (list) =>
    set({ statusByAgent: Object.fromEntries(list.map((x) => [x.agent, x])) }),
  setUsage: (usage) => set({ usage }),
  setActiveThread: (id) =>
    set((s) => ({
      activeThreadId: id,
      openThreadIds: s.openThreadIds.includes(id) ? s.openThreadIds : [...s.openThreadIds, id],
    })),
  openThread: (id) =>
    set((s) => ({
      openThreadIds: s.openThreadIds.includes(id) ? s.openThreadIds : [...s.openThreadIds, id],
    })),
  applyFrame: (f) =>
    set((s) => {
      switch (f.type) {
        case "message": {
          const cur = s.messagesByThread[f.message.threadId] ?? [];
          return {
            messagesByThread: {
              ...s.messagesByThread,
              [f.message.threadId]: upsertMessage(cur, f.message),
            },
          };
        }
        case "thread": {
          const rest = s.threads.filter((t) => t.id !== f.thread.id);
          return { threads: [f.thread, ...rest] };
        }
        case "agent-status":
          return { statusByAgent: { ...s.statusByAgent, [f.status.agent]: f.status } };
        case "task":
          return { tasksById: { ...s.tasksById, [f.task.id]: f.task } };
        case "turn":
          return {};
        default:
          return {};
      }
    }),
  reset: () => set({ ...initial }),
}));
