import { hubClient } from "../lib/hubClient.js";
import { initPushNavigation } from "../lib/push.js";
import { connectSocket } from "../lib/socket.js";
import { useConclaveStore } from "./useConclaveStore.js";

export function startSync(): () => void {
  const store = useConclaveStore.getState();

  const hydrate = async (): Promise<void> => {
    const [threads, agents, statuses, usage] = await Promise.all([
      hubClient.listThreads(),
      hubClient.getRegistry(),
      hubClient.getStatus().catch(() => []),
      hubClient.getUsageSummary().catch(() => null),
    ]);
    store.setThreads(threads);
    store.setAgents(agents);
    store.setStatuses(statuses);
    if (usage) store.setUsage(usage);
    const artifacts = await hubClient.listArtifacts().catch(() => []);
    for (const a of artifacts) store.applyFrame({ type: "artifact", artifact: a });
    const wss = await hubClient.listWorkspaces().catch(() => []);
    for (const w of wss) store.applyFrame({ type: "workspace", workspace: w });
    const approvals = await hubClient.listApprovals().catch(() => []);
    store.setApprovals(approvals);
    void hubClient.listTerminals().then((t) => useConclaveStore.getState().setTerminals(t)).catch(() => {});
    void hubClient.listMachines().then((m) => useConclaveStore.getState().setMachines(m)).catch(() => {});
    const deepLink = new URLSearchParams(location.search).get("thread");
    if (deepLink && threads.some((t) => t.id === deepLink)) {
      store.setActiveThread(deepLink);
      store.setMessages(deepLink, await hubClient.listMessages(deepLink));
    } else if (!useConclaveStore.getState().activeThreadId && threads.length > 0) {
      // Auto-select without setActiveThread: hydrate must not steer the mobile
      // shell off the Workspace home tab (setActiveThread forces mobileTab "chats").
      const first = threads[0].id;
      useConclaveStore.setState((s) => ({
        activeThreadId: first,
        activeArtifactId: null,
        activeFsFile: null,
        fsDirty: false,
        activeTerminalId: null,
        openThreadIds: s.openThreadIds.includes(first) ? s.openThreadIds : [...s.openThreadIds, first],
      }));
      store.setMessages(first, await hubClient.listMessages(first));
    }
  };

  void hydrate();
  const close = connectSocket((f) => useConclaveStore.getState().applyFrame(f));
  initPushNavigation((threadId) => {
    const s = useConclaveStore.getState();
    s.setActiveThread(threadId);
    void hubClient.listMessages(threadId).then((m) => s.setMessages(threadId, m));
  });
  return close;
}
