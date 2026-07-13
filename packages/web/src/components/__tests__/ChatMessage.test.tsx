import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { Message } from "@conclave/shared";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { ChatMessage } from "../ChatMessage.js";

const msg: Message = {
  id: 1, threadId: "t1", from: "codex", to: [], type: "proposal",
  body: "use `key` in payments/idem.ts:41 cc @claude-code",
  artifacts: [], ts: "2026-07-13T10:00:00Z",
};

it("renders name, plan badge, inline code, file link and mention", () => {
  useConclaveStore.getState().reset();
  useConclaveStore.getState().setAgents([
    { id: "claude-code", name: "claude-code", runtime: "claude-code", machine: "m", workspace: "/w", role: "", allowedTools: [] },
  ]);
  render(<ChatMessage message={msg} />);
  expect(screen.getByText("codex")).toBeInTheDocument();
  expect(screen.getByText("plan")).toBeInTheDocument();
  expect(screen.getByText("key")).toBeInTheDocument();
  expect(screen.getByText("payments/idem.ts:41")).toBeInTheDocument();
  expect(screen.getByText("@claude-code")).toBeInTheDocument();
});
