import { describe, expect, it } from "vitest";
import { b64decode, b64encode } from "../base64.js";

describe("base64 helpers", () => {
  it("round-trips ascii and multibyte text", () => {
    for (const s of ["ls -la\n", "échò ünïcode ✓", ""]) {
      const decoded = new TextDecoder().decode(b64decode(b64encode(s)));
      expect(decoded).toBe(s);
    }
  });
  it("encodes to standard base64", () => {
    expect(b64encode("hi")).toBe("aGk=");
  });
});
