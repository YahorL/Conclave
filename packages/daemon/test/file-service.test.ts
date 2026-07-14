import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GrantStore } from "../src/grants.js";
import { FileService } from "../src/file-service.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "fsroot-"));
  writeFileSync(join(root, "a.txt"), "hello");
  const gf = join(mkdtempSync(join(tmpdir(), "gf-")), "grants.json");
  writeFileSync(gf, JSON.stringify({ files: [root] }));
  return { root, svc: new FileService(new GrantStore(gf)) };
}

describe("FileService", () => {
  it("lists, reads, writes within the jail", async () => {
    const { root, svc } = setup();
    expect((await svc.list(root)).map((e) => e.name)).toContain("a.txt");
    expect((await svc.read(join(root, "a.txt"))).content).toBe("hello");
    await svc.write(join(root, "b.txt"), "world");
    expect((await svc.read(join(root, "b.txt"))).content).toBe("world");
  });
  it("handle() wraps a jailed failure as ok:false", async () => {
    const { svc } = setup();
    const res = await svc.handle({ id: "1", op: "read", path: "/etc/passwd" });
    expect(res).toMatchObject({ id: "1", ok: false });
    expect(res.error).toBeTruthy();
  });
});
