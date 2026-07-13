export interface CliEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  [key: string]: unknown;
}

export interface ParsedTurn {
  sessionId: string;
  text: string;
  isError: boolean;
  costUsd: number;
  tokens?: { input: number; output: number };
}

interface CodexItem {
  type?: string;
  text?: string;
}

export function parseStreamLine(line: string): CliEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    if (typeof (parsed as { type?: unknown }).type !== "string") return null;
    return parsed as CliEvent;
  } catch {
    return null;
  }
}

export function summarizeTurn(events: CliEvent[]): ParsedTurn {
  const result = events.find((e) => e.type === "result");
  if (!result) throw new Error("no result event in CLI output");
  const sessionId =
    result.session_id ?? events.find((e) => typeof e.session_id === "string")?.session_id;
  return {
    sessionId: sessionId ?? "",
    text: result.result ?? "",
    isError: result.is_error === true,
    costUsd: result.total_cost_usd ?? 0,
  };
}

export function summarizeCodexTurn(events: CliEvent[], fallbackSessionId?: string): ParsedTurn {
  const started = events.find((e) => e.type === "thread.started");
  const completed = events.find((e) => e.type === "turn.completed");
  const failed = events.find((e) => e.type === "turn.failed");
  const agentMessages = events.filter((e) => {
    if (e.type !== "item.completed") return false;
    const item = e["item"] as CodexItem | undefined;
    return item?.type === "agent_message";
  });
  if (!started && !completed && !failed && agentMessages.length === 0) {
    throw new Error("no recognizable codex events in CLI output");
  }
  const lastText = (agentMessages.at(-1)?.["item"] as CodexItem | undefined)?.text;
  const failedMessage = (failed?.["error"] as { message?: string } | undefined)?.message;
  const usage = completed?.["usage"] as
    | { input_tokens?: number; output_tokens?: number }
    | undefined;
  return {
    sessionId: (started?.["thread_id"] as string | undefined) ?? fallbackSessionId ?? "",
    text: lastText ?? failedMessage ?? "",
    isError: failed !== undefined,
    costUsd: 0,
    tokens: usage
      ? { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 }
      : undefined,
  };
}
