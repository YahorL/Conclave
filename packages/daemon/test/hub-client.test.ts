import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDb } from "@conclave/hub/src/db.js";
import { Mailbox } from "@conclave/hub/src/mailbox.js";
import { buildServer } from "@conclave/hub/src/server.js";
import { loadDaemonConfig } from "../src/config.js";
import { HubClient, HubApiError } from "../src/hub-client.js";

const TOKEN = "dc-token";

describe("loadDaemonConfig", () => {
  const base = {
    CONCLAVE_HUB_URL: "http://hub:7777/",
    CONCLAVE_TOKEN: "t",
    CONCLAVE_MACHINE: "dev-box",
  };

  it("loads with defaults and strips trailing slash", () => {
    const cfg = loadDaemonConfig(base);
    expect(cfg.hubUrl).toBe("http://hub:7777");
    expect(cfg.claudeBin).toBe("claude");
    expect(cfg.codexBin).toBe("codex");
    expect(cfg.stateFile).toBe("./daemon-state.json");
    expect(cfg.allowAgentTriggers).toBe(false);
  });

  it("throws naming the missing variable", () => {
    expect(() => loadDaemonConfig({ ...base, CONCLAVE_TOKEN: undefined })).toThrow(
      /CONCLAVE_TOKEN/,
    );
  });

  it("parses CONCLAVE_ALLOW_AGENT_TRIGGERS=1", () => {
    expect(
      loadDaemonConfig({ ...base, CONCLAVE_ALLOW_AGENT_TRIGGERS: "1" }).allowAgentTriggers,
    ).toBe(true);
  });
});

describe("HubClient against a live hub", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  async function liveHub(): Promise<{ client: HubClient; mailbox: Mailbox }> {
    const dir = mkdtempSync(join(tmpdir(), "conclave-hc-"));
    const mailbox = new Mailbox(openDb(join(dir, "t.db")));
    app = await buildServer({
      mailbox,
      token: TOKEN,
      registry: {
        agents: [{
          id: "claude-code", name: "CC", runtime: "claude-code",
          machine: "dev-box", workspace: "/tmp/x", role: "", allowedTools: [], dangerousActions: [],
        }],
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    return { client: new HubClient(`http://127.0.0.1:${port}`, TOKEN), mailbox };
  }

  it("round-trips registry, messages, and verdicts", async () => {
    const { client, mailbox } = await liveHub();
    const agents = await client.getRegistry("dev-box");
    expect(agents.map((a) => a.id)).toEqual(["claude-code"]);

    const t = mailbox.createThread({ kind: "chat", participants: ["you", "claude-code"] });
    const posted = await client.postMessage(t.id, {
      from: "claude-code", to: ["you"], type: "text", body: "hello", artifacts: [],
    });
    expect(posted.id).toBeGreaterThan(0);
    expect((await client.listMessages(t.id)).map((m) => m.body)).toEqual(["hello"]);
    expect((await client.listMessages(t.id, posted.id))).toEqual([]);

    const settled = await client.setVerdict(t.id, "claude-code", "approve");
    expect(settled.verdicts["claude-code"]).toBe("approve");
    expect((await client.getThread(t.id)).id).toBe(t.id);
  });

  it("throws HubApiError with status on failures", async () => {
    const { client } = await liveHub();
    await expect(client.getThread("nope")).rejects.toThrowError(HubApiError);
    await expect(client.getThread("nope")).rejects.toMatchObject({ status: 404 });
  });
});
