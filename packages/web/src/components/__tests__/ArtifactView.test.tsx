import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { ArtifactView } from "../ArtifactView.js";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("# Plan\nbody")));
  const s = useConclaveStore.getState();
  s.reset();
  s.applyFrame({ type: "artifact", artifact: { id: "a1", name: "plan.md", mime: "text/markdown", size: 6, sha256: "abc", createdBy: "codex", createdAt: "2026-07-13T10:00:00Z" } });
  s.setActiveArtifact("a1");
});

afterEach(() => vi.unstubAllGlobals());

it("renders the artifact name and fetched content", async () => {
  render(<ArtifactView />);
  expect(screen.getByText("plan.md")).toBeInTheDocument();
  expect(await screen.findByText(/# Plan/)).toBeInTheDocument();
});
