import { create } from "zustand";
import type { AgentConfig, AgentStatus, Approval, Artifact, FsEntry, Message, Task, TerminalInfo, Thread, UsageSummary, Workspace } from "@conclave/shared";
import type { MachineInfo } from "../lib/hubClient.js";
import type { WsFrame } from "../lib/socket.js";
import { applyTheme, readStoredTheme, type Theme } from "../lib/theme.js";

export type MobileTab = "workspace" | "chats" | "terminals" | "status";

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
  activeFsFile: { machine: string; path: string; line?: number } | null;
  fsDirty: boolean;
  workspacesById: Record<string, Workspace>;
  activeWorkspaceId: string | null;
  approvalsById: Record<string, Approval>;
  terminals: TerminalInfo[];
  activeTerminalId: string | null;
  pendingTakeover: { agentId: string } | null;
  theme: Theme;
  mobileTab: MobileTab;
  chatListOpen: boolean;
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
  setActiveFsFile(f: { machine: string; path: string; line?: number } | null): void;
  setFsDirty(v: boolean): void;
  setActiveWorkspace(id: string | null): void;
  setApprovals(a: Approval[]): void;
  setTerminals(t: TerminalInfo[]): void;
  setActiveTerminal(id: string | null): void;
  setPendingTakeover(v: { agentId: string } | null): void;
  setTheme(t: Theme): void;
  setMobileTab(tab: MobileTab): void;
  setChatListOpen(v: boolean): void;
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
  activeFsFile: null as { machine: string; path: string; line?: number } | null,
  fsDirty: false,
  workspacesById: {} as Record<string, Workspace>,
  activeWorkspaceId: null as string | null,
  approvalsById: {} as Record<string, Approval>,
  terminals: [] as TerminalInfo[],
  activeTerminalId: null as string | null,
  pendingTakeover: null as { agentId: string } | null,
  theme: readStoredTheme() as Theme,
  mobileTab: "workspace" as MobileTab,
  chatListOpen: false,
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
      fsDirty: false,
      activeTerminalId: null,
      mobileTab: "chats",
      chatListOpen: false,
      openThreadIds: s.openThreadIds.includes(id) ? s.openThreadIds : [...s.openThreadIds, id],
    })),
  setActiveArtifact: (id) =>
    set(
      id
        ? { activeArtifactId: id, activeFsFile: null, fsDirty: false, activeTerminalId: null, mobileTab: "chats" }
        : { activeArtifactId: id, activeFsFile: null, fsDirty: false, activeTerminalId: null },
    ),
  openThread: (id) =>
    set((s) => ({
      openThreadIds: s.openThreadIds.includes(id) ? s.openThreadIds : [...s.openThreadIds, id],
    })),
  setSidebarView: (v) => set({ sidebarView: v }),
  setMachines: (m) => set({ machines: m }),
  setSelectedMachine: (id) => set({ selectedMachine: id }),
  setFsChildren: (key, entries) =>
    set((s) => ({ fsChildren: { ...s.fsChildren, [key]: entries } })),
  setActiveFsFile: (f) =>
    set(
      f
        ? { activeFsFile: f, activeArtifactId: null, activeTerminalId: null, mobileTab: "chats" }
        : { activeFsFile: f, activeArtifactId: null, activeTerminalId: null },
    ),
  setFsDirty: (v) => set({ fsDirty: v }),
  setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),
  setApprovals: (list) => set({ approvalsById: Object.fromEntries(list.map((a) => [a.id, a])) }),
  setTerminals: (t) => set({ terminals: t }),
  setActiveTerminal: (id) =>
    set(
      id
        ? { activeTerminalId: id, activeArtifactId: null, activeFsFile: null, fsDirty: false, mobileTab: "terminals" }
        : { activeTerminalId: id },
    ),
  setPendingTakeover: (v) => set({ pendingTakeover: v }),
  setTheme: (t) => {
    applyTheme(t);
    set({ theme: t });
  },
  setMobileTab: (tab) => set({ mobileTab: tab }),
  setChatListOpen: (v) => set({ chatListOpen: v }),
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
        case "approval":
          return { approvalsById: { ...s.approvalsById, [f.approval.id]: f.approval } };
        case "usage":
          return { usage: f.summary };
        case "terminal-list": {
          const pending = s.pendingTakeover;
          if (pending) {
            const prevIds = new Set(s.terminals.map((t) => t.id));
            const fresh = f.terminals
              .filter((t) => !prevIds.has(t.id) && t.agentId === pending.agentId)
              .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
            if (fresh.length > 0) {
              return {
                terminals: f.terminals,
                activeTerminalId: fresh[0]!.id,
                activeArtifactId: null,
                activeFsFile: null,
                fsDirty: false,
                mobileTab: "terminals",
                pendingTakeover: null,
              };
            }
          }
          return { terminals: f.terminals };
        }
        case "turn":
          return {};
        default:
          return {};
      }
    }),
  reset: () => set({ ...initial }),
}));
