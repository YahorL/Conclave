import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { FsFileView } from "../FsFileView.js";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ content: "line one" }))));
  const s = useConclaveStore.getState();
  s.reset();
  s.setActiveFsFile({ machine: "local", path: "/w/a.txt" });
});
afterEach(() => vi.unstubAllGlobals());

it("shows the path and fetched content", async () => {
  render(<FsFileView />);
  expect(screen.getByText(/\/w\/a\.txt/)).toBeInTheDocument();
  expect(await screen.findByText(/line one/)).toBeInTheDocument();
});
