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
