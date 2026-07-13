import { randomUUID } from "node:crypto";
import type { Message, NewDebate, Thread, TurnRequest } from "@conclave/shared";
import type { Mailbox } from "./mailbox.js";
import type { DebateRecord, DebateStore } from "./debates.js";

const STANCE_PRESETS = ["advocate", "skeptic", "risk-reviewer"];
const FINAL_INSTRUCTION =
  "Final call: you MUST call end_thread now with your verdict (approve / reject / short position summary).";

export function composeInstruction(
  stance: string,
  round: number,
  minRounds: number,
  maxRounds: number,
): string {
  const base = `Round ${round}/${maxRounds}. Your stance: ${stance}.`;
  if (round < minRounds) {
    return `${base} Engage directly with the other participants' arguments. Do NOT call end_thread yet — minimum ${minRounds} rounds.`;
  }
  return `${base} If your position is final, call end_thread with your verdict; otherwise rebut the strongest counterargument.`;
}

export function waitForAgentActivity(
  mailbox: Mailbox,
  threadId: string,
  agentId: string,
  afterMessageId: number,
  timeoutMs: number,
): Promise<"replied" | "verdict" | "settled" | "timeout"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => done("timeout"), timeoutMs);
    function onMessage(m: Message): void {
      if (m.threadId === threadId && m.from === agentId && m.id > afterMessageId) done("replied");
    }
    function onThread(t: Thread): void {
      if (t.id !== threadId) return;
      if (t.verdicts[agentId] !== undefined) return done("verdict");
      if (t.state !== "open") done("settled");
    }
    function done(result: "replied" | "verdict" | "settled" | "timeout"): void {
      clearTimeout(timer);
      mailbox.events.off("message", onMessage);
      mailbox.events.off("thread", onThread);
      resolve(result);
    }
    mailbox.events.on("message", onMessage);
    mailbox.events.on("thread", onThread);
  });
}

function assignStances(
  participants: string[],
  overrides: Record<string, string> | undefined,
): Record<string, string> {
  const stances: Record<string, string> = {};
  participants.forEach((p, i) => {
    stances[p] = overrides?.[p] ?? STANCE_PRESETS[i % STANCE_PRESETS.length]!;
  });
  return stances;
}

export interface OrchestratorOptions {
  turnTimeoutMs?: number;
  finaleTimeoutMs?: number;
}

export class DebateOrchestrator {
  private readonly running = new Set<Promise<void>>();
  private readonly turnTimeoutMs: number;
  private readonly finaleTimeoutMs: number;

  constructor(
    private readonly mailbox: Mailbox,
    private readonly store: DebateStore,
    opts: OrchestratorOptions = {},
  ) {
    this.turnTimeoutMs = opts.turnTimeoutMs ?? 600_000;
    this.finaleTimeoutMs = opts.finaleTimeoutMs ?? 120_000;
  }

  startDebate(input: NewDebate): DebateRecord {
    const thread = this.mailbox.createThread({
      kind: "debate",
      participants: input.participants,
      workspace: input.workspace,
    });
    const rec: DebateRecord = {
      id: randomUUID(),
      threadId: thread.id,
      participants: input.participants,
      stances: assignStances(input.participants, input.stances),
      minRounds: input.minRounds,
      maxRounds: input.maxRounds,
      round: 0,
      state: "running",
    };
    this.store.create(rec);
    this.mailbox.appendMessage(thread.id, {
      from: "you", to: [], type: "proposal", body: input.topic, artifacts: [],
    });
    const run = this.run(rec).catch((err: unknown) => {
      this.store.update(rec.id, { state: "interrupted" });
      console.error(`debate ${rec.id} crashed:`, err instanceof Error ? err.message : err);
    });
    this.running.add(run);
    void run.finally(() => this.running.delete(run));
    return rec;
  }

  async idle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.all([...this.running]);
    }
  }

  private emitTurn(turn: TurnRequest): void {
    this.mailbox.events.emit("turn", turn);
  }

  private latestMessageIdFrom(threadId: string, agentId: string): number {
    const own = this.mailbox.listMessages(threadId).filter((m) => m.from === agentId);
    return own.at(-1)?.id ?? 0;
  }

  private async run(rec: DebateRecord): Promise<void> {
    for (let round = 1; round <= rec.maxRounds; round++) {
      this.store.update(rec.id, { round });
      for (const agent of rec.participants) {
        const thread = this.mailbox.getThread(rec.threadId);
        if (!thread || thread.state !== "open") break;
        if (thread.verdicts[agent] !== undefined) continue;
        const lastSeen = this.mailbox.listMessages(rec.threadId).at(-1)?.id ?? 0;
        this.emitTurn({
          threadId: rec.threadId,
          agentId: agent,
          sinceMessageId: this.latestMessageIdFrom(rec.threadId, agent),
          instruction: composeInstruction(rec.stances[agent]!, round, rec.minRounds, rec.maxRounds),
        });
        const outcome = await waitForAgentActivity(
          this.mailbox, rec.threadId, agent, lastSeen, this.turnTimeoutMs,
        );
        if (outcome === "timeout") {
          this.mailbox.setVerdict(rec.threadId, agent, "no-response (timeout)");
          this.mailbox.appendMessage(rec.threadId, {
            from: "orchestrator", to: [], type: "status",
            body: `${agent} did not respond within the turn timeout`, artifacts: [],
          });
        }
        if (outcome === "settled") break;
      }
      const t = this.mailbox.getThread(rec.threadId);
      if (!t || t.state !== "open") break;
    }

    let thread = this.mailbox.getThread(rec.threadId);
    if (thread && thread.state === "open") {
      for (const agent of rec.participants) {
        thread = this.mailbox.getThread(rec.threadId);
        if (!thread || thread.state !== "open") break;
        if (thread.verdicts[agent] !== undefined) continue;
        const lastSeen = this.mailbox.listMessages(rec.threadId).at(-1)?.id ?? 0;
        this.emitTurn({
          threadId: rec.threadId,
          agentId: agent,
          sinceMessageId: this.latestMessageIdFrom(rec.threadId, agent),
          instruction: FINAL_INSTRUCTION,
        });
        const outcome = await waitForAgentActivity(
          this.mailbox, rec.threadId, agent, lastSeen, this.finaleTimeoutMs,
        );
        const after = this.mailbox.getThread(rec.threadId);
        if (outcome !== "settled" && after && after.verdicts[agent] === undefined) {
          this.mailbox.setVerdict(rec.threadId, agent, "no-response");
        }
      }
    }

    const final = this.mailbox.getThread(rec.threadId);
    if (!final) return;
    const summary = Object.entries(final.verdicts)
      .map(([a, v]) => `${a}: ${v}`)
      .join("\n");
    this.mailbox.appendMessage(rec.threadId, {
      from: "orchestrator", to: [], type: "status",
      body: `debate finished (${final.state}). verdicts:\n${summary}`, artifacts: [],
    });
    this.store.update(rec.id, {
      state: final.state === "settled" ? "settled" : "inconclusive",
    });
  }
}
