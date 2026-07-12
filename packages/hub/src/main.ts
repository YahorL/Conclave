import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db.js";
import { Mailbox } from "./mailbox.js";
import { buildServer } from "./server.js";

const token = process.env["CONCLAVE_TOKEN"];
if (!token) {
  console.error("CONCLAVE_TOKEN is required");
  process.exit(1);
}

const port = Number(process.env["CONCLAVE_PORT"] ?? 7777);
const dataDir = process.env["CONCLAVE_DATA_DIR"] ?? "./data";
mkdirSync(dataDir, { recursive: true });

const mailbox = new Mailbox(openDb(join(dataDir, "conclave.db")));
const app = await buildServer({ mailbox, token });
await app.listen({ port, host: "0.0.0.0" });
console.log(`conclave hub listening on :${port}`);
