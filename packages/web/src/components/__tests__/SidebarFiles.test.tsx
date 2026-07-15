import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { hubClient } from "../../lib/hubClient.js";
import { Sidebar } from "../Sidebar.js";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")));
  useConclaveStore.getState().reset();
});

it("switches to the files view when the files rail icon is clicked", async () => {
  vi.spyOn(hubClient, "listMachines").mockResolvedValue([{ machine: "local", files: ["/w"], terminals: false, lastSeen: "x" }]);
  render(<Sidebar />);
  await userEvent.click(screen.getByLabelText("files"));
  expect(useConclaveStore.getState().sidebarView).toBe("files");
  expect(await screen.findByTestId("files-panel")).toBeInTheDocument();
});
