import { describe, expect, it } from "vitest";
import { resolveFileLink } from "../fileLink.js";

const ws = { machine: "m1", folderPath: "/home/me/proj" };
const ctx = (over: Partial<Parameters<typeof resolveFileLink>[1]> = {}) => ({
  activeWorkspace: ws, selectedMachine: null, machines: [{ machine: "m9" }], ...over,
});

describe("resolveFileLink", () => {
  it("splits a trailing :line and joins relative paths to the workspace folder", () => {
    expect(resolveFileLink("src/idem.ts:41", ctx())).toEqual({
      machine: "m1", path: "/home/me/proj/src/idem.ts", line: 41,
    });
  });

  it("keeps absolute paths as-is, no line when absent", () => {
    expect(resolveFileLink("/etc/conf/app.yaml", ctx())).toEqual({
      machine: "m1", path: "/etc/conf/app.yaml",
    });
  });

  it("machine precedence: workspace > selectedMachine > first machine", () => {
    expect(resolveFileLink("/a.ts", ctx())!.machine).toBe("m1");
    expect(resolveFileLink("/a.ts", ctx({ activeWorkspace: undefined, selectedMachine: "m5" }))!.machine).toBe("m5");
    expect(resolveFileLink("/a.ts", ctx({ activeWorkspace: undefined }))!.machine).toBe("m9");
  });

  it("returns null when unresolvable", () => {
    // relative path with no workspace
    expect(resolveFileLink("src/a.ts", ctx({ activeWorkspace: undefined }))).toBeNull();
    // no machine anywhere
    expect(resolveFileLink("/a.ts", { activeWorkspace: undefined, selectedMachine: null, machines: [] })).toBeNull();
  });

  it("does not treat a windows-style or malformed line suffix as a line", () => {
    expect(resolveFileLink("src/a.ts:abc", ctx())).toEqual({
      machine: "m1", path: "/home/me/proj/src/a.ts:abc",
    });
  });
});
