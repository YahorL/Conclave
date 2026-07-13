import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { UsageSummary } from "@conclave/shared";
import { openDb } from "../src/db.js";
import { getUsageSummary, recordUsage } from "../src/usage.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "conclave-usum-"));
  return openDb(join(dir, "test.db"));
}

describe("getUsageSummary", () => {
  it("aggregates per agent and totals, and echoes budget", () => {
    const db = freshDb();
    recordUsage(db, { agent: "codex", inputTokens: 100, outputTokens: 50, costUsd: 1.5 });
    recordUsage(db, { agent: "codex", inputTokens: 20, outputTokens: 10, costUsd: 0.5 });
    recordUsage(db, { agent: "claude-code", inputTokens: 5, outputTokens: 5, costUsd: 0.25 });

    const summary: UsageSummary = getUsageSummary(db, 25);
    expect(summary.budgetUsd).toBe(25);
    expect(summary.totalCostUsd).toBeCloseTo(2.25, 5);
    const codex = summary.perAgent.find((a) => a.agent === "codex");
    expect(codex).toMatchObject({ inputTokens: 120, outputTokens: 60 });
    expect(codex?.costUsd).toBeCloseTo(2.0, 5);
  });

  it("returns an empty summary when there is no usage", () => {
    const summary = getUsageSummary(freshDb(), 10);
    expect(summary.perAgent).toEqual([]);
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.budgetUsd).toBe(10);
  });
});
