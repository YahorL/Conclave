import { create } from "zustand";
import type { AgentConfig, AgentStatus, Artifact, FsEntry, Message, Task, Thread, UsageSummary, Workspace } from "@conclave/shared";
import type { MachineInfo } from "../lib/hubClient.js";
import type { WsFrame } from "../lib/socket.js";

interface State {
  threads: Thread[];
  messagesByThread: Record<string, Message[]>;
  agents: AgentConfig[];
  statusByAgent: Record<string, AgentStatus>;
  usage: UsageSummary | null;
  tasksById: Record<string, Task>;
  artifactsById: Record<string, Artifact>;
  activeThreadId: string | null;
  activeArtifactId: string | null;
  openThreadIds: string[];
  sidebarView: "chats" | "files";
  machines: MachineInfo[];
  selectedMachine: string | null;
  fsChildren: Record<string, FsEntry[]>;
  activeFsFile: { machine: string; path: string } | null;
  workspacesById: Record<string, Workspace>;
  activeWorkspaceId: string | null;
  setThreads(t: Thread[]): void;
  setMessages(threadId: string, m: Message[]): void;
  setAgents(a: AgentConfig[]): void;
  setStatuses(s: AgentStatus[]): void;
  setUsage(u: UsageSummary): void;
  setActiveThread(id: string): void;
  setActiveArtifact(id: string | null): void;
  openThread(id: string): void;
  setSidebarView(v: "chats" | "files"): void;
  setMachines(m: MachineInfo[]): void;
  setSelectedMachine(id: string | null): void;
  setFsChildren(key: string, entries: FsEntry[]): void;
  setActiveFsFile(f: { machine: string; path: string } | null): void;
  setActiveWorkspace(id: string | null): void;
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
  artifactsById: {} as Record<string, Artifact>,
  activeThreadId: null as string | null,
  activeArtifactId: null as string | null,
  openThreadIds: [] as string[],
  sidebarView: "chats" as "chats" | "files",
  machines: [] as MachineInfo[],
  selectedMachine: null as string | null,
  fsChildren: {} as Record<string, FsEntry[]>,
  activeFsFile: null as { machine: string; path: string } | null,
  workspacesById: {} as Record<string, Workspace>,
  activeWorkspaceId: null as string | null,
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
      activeArtifactId: null,
      activeFsFile: null,
      openThreadIds: s.openThreadIds.includes(id) ? s.openThreadIds : [...s.openThreadIds, id],
    })),
  setActiveArtifact: (id) => set({ activeArtifactId: id, activeFsFile: null }),
  openThread: (id) =>
    set((s) => ({
      openThreadIds: s.openThreadIds.includes(id) ? s.openThreadIds : [...s.openThreadIds, id],
    })),
  setSidebarView: (v) => set({ sidebarView: v }),
  setMachines: (m) => set({ machines: m }),
  setSelectedMachine: (id) => set({ selectedMachine: id }),
  setFsChildren: (key, entries) =>
    set((s) => ({ fsChildren: { ...s.fsChildren, [key]: entries } })),
  setActiveFsFile: (f) => set({ activeFsFile: f, activeArtifactId: null }),
  setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),
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
        case "artifact":
          return { artifactsById: { ...s.artifactsById, [f.artifact.id]: f.artifact } };
        case "workspace":
          return { workspacesById: { ...s.workspacesById, [f.workspace.id]: f.workspace } };
        case "turn":
          return {};
        default:
          return {};
      }
    }),
  reset: () => set({ ...initial }),
}));
