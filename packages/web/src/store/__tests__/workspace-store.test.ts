import { beforeEach, describe, expect, it } from "vitest";
import { useConclaveStore } from "../useConclaveStore.js";
import type { Workspace } from "@conclave/shared";

const ws: Workspace = { id: "w1", name: "svc", machine: "local", folderPath: "/w", createdAt: "2026-07-13T10:00:00Z" };

describe("workspaces + files in the store", () => {
  beforeEach(() => useConclaveStore.getState().reset());
  it("upserts workspaces and toggles views/files", () => {
    const s = useConclaveStore.getState();
    s.applyFrame({ type: "workspace", workspace: ws });
    expect(useConclaveStore.getState().workspacesById["w1"].name).toBe("svc");
    s.setSidebarView("files");
    expect(useConclaveStore.getState().sidebarView).toBe("files");
    s.setActiveFsFile({ machine: "local", path: "/w/a.txt" });
    expect(useConclaveStore.getState().activeFsFile?.path).toBe("/w/a.txt");
    s.setActiveThread("t1");
    expect(useConclaveStore.getState().activeFsFile).toBeNull();
  });
});
