import type Database from "better-sqlite3";
import type { PushSubscriptionInfo } from "@conclave/shared";

interface SubRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export class PushStore {
  constructor(private readonly db: Database.Database) {}

  upsert(sub: PushSubscriptionInfo): void {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
      )
      .run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, new Date().toISOString());
  }

  list(): PushSubscriptionInfo[] {
    const rows = this.db
      .prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions")
      .all() as SubRow[];
    return rows.map((r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }));
  }

  remove(endpoint: string): void {
    this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  }
}
