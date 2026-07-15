import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import webpush from "web-push";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

// Zero-config: generated on first boot, persisted next to the SQLite db so
// existing browser subscriptions stay valid across restarts.
export function loadOrCreateVapid(dataDir: string): VapidKeys {
  const file = join(dataDir, "vapid.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as VapidKeys;
  const keys = webpush.generateVAPIDKeys();
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}
