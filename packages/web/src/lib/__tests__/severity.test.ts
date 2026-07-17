import { describe, expect, it } from "vitest";
import { fmtTok, usageSeverity } from "../severity.js";

describe("usage severity + token formatting", () => {
  it("tiers at 70 and 90", () => {
    expect(usageSeverity(0)).toBe("normal");
    expect(usageSeverity(69)).toBe("normal");
    expect(usageSeverity(70)).toBe("nearing");
    expect(usageSeverity(89)).toBe("nearing");
    expect(usageSeverity(90)).toBe("critical");
    expect(usageSeverity(137)).toBe("critical");
  });

  it("formats token counts compactly", () => {
    expect(fmtTok(999)).toBe("999");
    expect(fmtTok(1000)).toBe("1.0k");
    expect(fmtTok(128_400)).toBe("128.4k");
  });
});
