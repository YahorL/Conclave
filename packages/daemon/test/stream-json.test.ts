import { describe, expect, it } from "vitest";
import { parseStreamLine, summarizeTurn, type CliEvent } from "../src/stream-json.js";

const INIT = `{"type":"system","subtype":"init","session_id":"sess-1"}`;
const RESULT = `{"type":"result","subtype":"success","session_id":"sess-1","result":"Hello from Claude","is_error":false,"total_cost_usd":0.0123,"usage":{"input_tokens":10,"output_tokens":5}}`;

describe("parseStreamLine", () => {
  it("parses NDJSON events", () => {
    expect(parseStreamLine(INIT)).toMatchObject({ type: "system", session_id: "sess-1" });
  });

  it("returns null for blank and garbage lines", () => {
    expect(parseStreamLine("")).toBeNull();
    expect(parseStreamLine("   ")).toBeNull();
    expect(parseStreamLine("not json {")).toBeNull();
    expect(parseStreamLine(`"just a string"`)).toBeNull();
    expect(parseStreamLine("[1,2,3]")).toBeNull();
    expect(parseStreamLine("{}")).toBeNull();
  });
});

describe("summarizeTurn", () => {
  it("extracts session, text, cost from a result event", () => {
    const events = [parseStreamLine(INIT)!, parseStreamLine(RESULT)!];
    expect(summarizeTurn(events)).toEqual({
      sessionId: "sess-1",
      text: "Hello from Claude",
      isError: false,
      costUsd: 0.0123,
      tokens: { input: 10, output: 5 },
    });
  });

  it("flags error results", () => {
    const events: CliEvent[] = [
      { type: "result", session_id: "s", result: "boom", is_error: true },
    ];
    const turn = summarizeTurn(events);
    expect(turn.isError).toBe(true);
    expect(turn.costUsd).toBe(0);
  });

  it("throws when there is no result event", () => {
    const events = [parseStreamLine(INIT)!];
    expect(() => summarizeTurn(events)).toThrow(/no result event/);
  });
});
