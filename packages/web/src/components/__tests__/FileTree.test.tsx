import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { hubClient } from "../../lib/hubClient.js";
import { FileTree } from "../FileTree.js";

beforeEach(() => {
  useConclaveStore.getState().reset();
});

it("lazily expands a dir and opens a file", async () => {
  vi.spyOn(hubClient, "fsList").mockResolvedValue([
    { name: "a.txt", kind: "file", size: 3 },
    { name: "sub", kind: "dir" },
  ]);
  render(<FileTree machine="local" roots={["/w"]} />);
  await userEvent.click(screen.getByText("/w"));
  expect(hubClient.fsList).toHaveBeenCalledWith("local", "/w");
  const file = await screen.findByText("a.txt");
  await userEvent.click(file);
  expect(useConclaveStore.getState().activeFsFile).toEqual({ machine: "local", path: "/w/a.txt" });
});
