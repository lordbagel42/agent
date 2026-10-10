import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Address } from "../core/contracts.js";

/** Content-free cancellation fences. A new message can start new work, but
 * never revives work originating before Slack's stop timestamp. */
export class SlackSessions {
  private readonly db: DatabaseSync;
  private readonly watchers = new Set<{
    address: Address;
    occurredAt: number;
    controller: AbortController;
  }>();

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`CREATE TABLE IF NOT EXISTS slack_session_stops (
      team TEXT NOT NULL, channel TEXT NOT NULL, thread TEXT NOT NULL,
      stopped_at REAL NOT NULL, PRIMARY KEY (team, channel, thread)
    )`);
  }

  active(source: { address: Address; occurredAt: number }): boolean {
    if (source.address.channel !== "slack") return true;
    return !this.db
      .prepare(`SELECT 1 FROM slack_session_stops
      WHERE team = ? AND channel = ? AND (thread = '' OR thread = ?)
      AND stopped_at >= ? LIMIT 1`)
      .get(
        source.address.accountId,
        source.address.conversationId,
        source.address.threadId ?? "",
        source.occurredAt,
      );
  }

  stop(address: Address, at: number): void {
    this.db
      .prepare(`INSERT INTO slack_session_stops VALUES (?, ?, ?, ?)
      ON CONFLICT (team, channel, thread) DO UPDATE SET
      stopped_at = MAX(stopped_at, excluded.stopped_at)`)
      .run(
        address.accountId,
        address.conversationId,
        address.threadId ?? "",
        at,
      );
    for (const watcher of this.watchers)
      if (!this.active(watcher)) watcher.controller.abort();
  }

  watch(source: { address: Address; occurredAt: number }) {
    const watcher = { ...source, controller: new AbortController() };
    this.watchers.add(watcher);
    if (!this.active(source)) watcher.controller.abort();
    return {
      signal: watcher.controller.signal,
      dispose: () => {
        this.watchers.delete(watcher);
      },
    };
  }

  close() {
    for (const watcher of this.watchers) watcher.controller.abort();
    this.watchers.clear();
    this.db.close();
  }
}
