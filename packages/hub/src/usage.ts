import type Database from "better-sqlite3";
import type { AgentUsage, UsageReport, UsageSummary } from "@conclave/shared";

export interface UsageRow extends UsageReport {
  id: number;
  ts: string;
}

interface DbUsageRow {
  id: number;
  agent: string;
  thread_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  ts: string;
}

export function recordUsage(db: Database.Database, report: UsageReport): void {
  db.prepare(
    `INSERT INTO usage (agent, thread_id, input_tokens, output_tokens, cost_usd, ts)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    report.agent,
    report.threadId ?? null,
    report.inputTokens,
    report.outputTokens,
    report.costUsd,
    new Date().toISOString(),
  );
}

interface SummaryRow {
  agent: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export function getUsageSummary(db: Database.Database, budgetUsd: number): UsageSummary {
  const rows = db
    .prepare(
      `SELECT agent,
              SUM(input_tokens)  AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cost_usd)      AS cost_usd
       FROM usage
       GROUP BY agent
       ORDER BY cost_usd DESC`,
    )
    .all() as SummaryRow[];
  const perAgent: AgentUsage[] = rows.map((r) => ({
    agent: r.agent,
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
    costUsd: r.cost_usd ?? 0,
    window5hTokens: 0,
    weeklyTokens: 0,
  }));
  const totalCostUsd = perAgent.reduce((sum, a) => sum + a.costUsd, 0);
  return { perAgent, totalCostUsd, budgetUsd };
}

export function listUsage(db: Database.Database, limit = 100): UsageRow[] {
  const rows = db
    .prepare("SELECT * FROM usage ORDER BY id DESC LIMIT ?")
    .all(limit) as DbUsageRow[];
  return rows.map((r) => ({
    id: r.id,
    agent: r.agent,
    threadId: r.thread_id ?? undefined,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: r.cost_usd,
    ts: r.ts,
  }));
}
