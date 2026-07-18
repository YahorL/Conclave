import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EditorView } from "codemirror";
import { useConclaveStore } from "../../store/useConclaveStore.js";

const mocks = vi.hoisted(() => ({
  fsRead: vi.fn(async () => ({ content: "hello world" })),
  fsWrite: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../../lib/hubClient.js", () => ({ hubClient: mocks }));

import { FsFileView } from "../FsFileView.js";

function openFile(line?: number): void {
  const s = useConclaveStore.getState();
  s.reset();
  s.setActiveFsFile({ machine: "m1", path: "/w/a.ts", ...(line ? { line } : {}) });
}

async function renderWithView(): Promise<EditorView> {
  let view: EditorView | undefined;
  render(<FsFileView onViewReady={(v) => (view = v)} />);
  await waitFor(() => expect(view).toBeDefined());
  return view!;
}

function type(view: EditorView, text: string): void {
  act(() => {
    view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
  });
}

describe("FsFileView editor", () => {
  beforeEach(() => {
    mocks.fsRead.mockClear();
    mocks.fsWrite.mockClear();
    mocks.fsRead.mockResolvedValue({ content: "hello world" });
  });

  it("loads the file into the editor; clean state (no dirty dot, save disabled)", async () => {
    openFile();
    const view = await renderWithView();
    expect(view.state.doc.toString()).toBe("hello world");
    expect(screen.queryByTestId("fs-dirty")).toBeNull();
    expect((screen.getByTestId("fs-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Mod-s on a clean buffer does not write", async () => {
    openFile();
    await renderWithView();
    const content = document.querySelector(".cm-content")!;
    fireEvent.keyDown(content, { key: "s", ctrlKey: true });
    await act(async () => {}); // flush any pending save promise
    expect(mocks.fsWrite).not.toHaveBeenCalled();
  });

  it("editing sets the dirty dot + store flag; save writes and clears", async () => {
    openFile();
    const s = useConclaveStore.getState();
    s.setActiveThread("th-1");
    s.setActiveFsFile({ machine: "m1", path: "/w/a.ts" }); // thread switch cleared it
    const view = await renderWithView();
    type(view, "!");
    expect(screen.getByTestId("fs-dirty")).toBeInTheDocument();
    expect(useConclaveStore.getState().fsDirty).toBe(true);

    await userEvent.click(screen.getByTestId("fs-save"));
    await waitFor(() => expect(mocks.fsWrite).toHaveBeenCalledWith("m1", "/w/a.ts", "hello world!", "th-1"));
    await waitFor(() => expect(screen.getByTestId("fs-notice").textContent).toContain("saved"));
    expect(useConclaveStore.getState().fsDirty).toBe(false);
    expect(screen.queryByTestId("fs-dirty")).toBeNull();
  });

  it("save failure shows the error and stays dirty", async () => {
    mocks.fsWrite.mockRejectedValueOnce(new Error("hub POST /api/fs/m1/write -> 422"));
    openFile();
    const view = await renderWithView();
    type(view, "!");
    await userEvent.click(screen.getByTestId("fs-save"));
    await waitFor(() => expect(screen.getByTestId("fs-notice").textContent).toContain("save failed"));
    expect(useConclaveStore.getState().fsDirty).toBe(true);
  });

  it("failed load hides the save affordance entirely", async () => {
    mocks.fsRead.mockRejectedValueOnce(new Error("nope"));
    openFile();
    render(<FsFileView />);
    await waitFor(() => expect(screen.getByText("(failed to read file)")).toBeInTheDocument());
    expect(screen.queryByTestId("fs-save")).toBeNull();
  });

  it("scrolls/selects the requested line on load", async () => {
    mocks.fsRead.mockResolvedValueOnce({ content: "l1\nl2\nl3\nl4" });
    openFile(3);
    const view = await renderWithView();
    await waitFor(() => {
      expect(view.state.selection.main.from).toBe(view.state.doc.line(3).from);
    });
  });

  it("clamps a beyond-end line to the last line", async () => {
    mocks.fsRead.mockResolvedValueOnce({ content: "l1\nl2\nl3" });
    openFile(99);
    const view = await renderWithView();
    await waitFor(() => {
      expect(view.state.selection.main.from).toBe(view.state.doc.line(3).from);
    });
  });

  it("line 0 does not crash; cursor stays at doc start", async () => {
    mocks.fsRead.mockResolvedValueOnce({ content: "l1\nl2" });
    const s = useConclaveStore.getState();
    s.reset();
    s.setActiveFsFile({ machine: "m1", path: "/w/a.ts", line: 0 });
    const view = await renderWithView();
    expect(view.state.selection.main.from).toBe(0);
  });

  it("recovers after a failed load when a new file is opened", async () => {
    mocks.fsRead.mockRejectedValueOnce(new Error("nope"));
    openFile();
    let view: EditorView | undefined;
    render(<FsFileView onViewReady={(v) => (view = v)} />);
    await waitFor(() => expect(screen.getByText("(failed to read file)")).toBeInTheDocument());
    act(() => {
      useConclaveStore.getState().setActiveFsFile({ machine: "m1", path: "/w/b.ts" });
    });
    await waitFor(() => expect(view).toBeDefined());
    expect(view!.state.doc.toString()).toBe("hello world");
    expect(screen.queryByText("(failed to read file)")).toBeNull();
  });
});
