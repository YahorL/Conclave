import type Database from "better-sqlite3";
import type { AgentLimits, AgentUsage, UsageReport, UsageSummary } from "@conclave/shared";

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

interface WindowRow {
  agent: string;
  toks: number;
}

export function getUsageSummary(
  db: Database.Database,
  budgetUsd: number,
  limitsByAgent: Record<string, AgentLimits> = {},
): UsageSummary {
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

  // ts is stored as new Date().toISOString() (ISO with 'T'); SQLite's
  // datetime('now', …) emits 'YYYY-MM-DD HH:MM:SS', and comparing the two
  // formats lexicographically is WRONG ('T' > ' '). Compute cutoffs in JS in
  // the SAME format as the stored values.
  const windowQuery = db.prepare(
    `SELECT agent, SUM(input_tokens + output_tokens) AS toks
     FROM usage WHERE ts >= ? GROUP BY agent`,
  );
  const toMap = (windowRows: WindowRow[]): Map<string, number> =>
    new Map(windowRows.map((r) => [r.agent, r.toks ?? 0]));
  const in5h = toMap(windowQuery.all(new Date(Date.now() - 5 * 3600_000).toISOString()) as WindowRow[]);
  const in7d = toMap(windowQuery.all(new Date(Date.now() - 7 * 24 * 3600_000).toISOString()) as WindowRow[]);

  const perAgent: AgentUsage[] = rows.map((r) => {
    const limits = limitsByAgent[r.agent] ?? {};
    const window5hTokens = in5h.get(r.agent) ?? 0;
    const weeklyTokens = in7d.get(r.agent) ?? 0;
    return {
      agent: r.agent,
      inputTokens: r.input_tokens ?? 0,
      outputTokens: r.output_tokens ?? 0,
      costUsd: r.cost_usd ?? 0,
      window5hTokens,
      weeklyTokens,
      window5hPct: limits.window5hTokens
        ? Math.round((100 * window5hTokens) / limits.window5hTokens)
        : undefined,
      weeklyPct: limits.weeklyTokens
        ? Math.round((100 * weeklyTokens) / limits.weeklyTokens)
        : undefined,
    };
  });
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
