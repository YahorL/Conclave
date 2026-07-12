import type { CliEvent, ParsedTurn } from "./stream-json.js";

export interface TurnOptions {
  cwd: string;
  prompt: string;
  sessionId?: string;
  allowedTools: string[];
  mcpServers?: Record<string, unknown>;
  timeoutMs?: number;
  onEvent?: (e: CliEvent) => void;
}

export type TurnResult = ParsedTurn;

export interface RuntimeAdapter {
  runTurn(opts: TurnOptions): Promise<TurnResult>;
}
