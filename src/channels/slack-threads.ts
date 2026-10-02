import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const CHANNEL_FOLLOWUP_SECONDS = 30 * 60;

/** Thread subscriptions and recent top-level replies; IDs/timestamps only. */
export class SlackThreads {
  private db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`CREATE TABLE IF NOT EXISTS slack_threads (
      team TEXT NOT NULL, bot TEXT NOT NULL, channel TEXT NOT NULL, thread TEXT NOT NULL,
      PRIMARY KEY (team, bot, channel, thread)
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS slack_channel_replies (
      team TEXT NOT NULL, bot TEXT NOT NULL, channel TEXT NOT NULL, replied_at REAL NOT NULL,
      PRIMARY KEY (team, bot, channel, replied_at)
    )`);
  }

  has(team: string, bot: string, channel: string, thread: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM slack_threads WHERE team = ? AND bot = ? AND channel = ? AND thread = ?",
      )
      .get(team, bot, channel, thread);
  }

  record(team: string, bot: string, channel: string, thread: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO slack_threads VALUES (?, ?, ?, ?)")
      .run(team, bot, channel, thread);
  }

  hasRecentChannelReply(
    team: string,
    bot: string,
    channel: string,
    ts: string,
  ): boolean {
    // Use the original Slack timestamp, not replay/delivery time. Earlier
    // messages cannot be invited retroactively by a later June reply.
    const at = Number(ts);
    if (!Number.isFinite(at) || at <= 0) return false;
    return !!this.db
      .prepare(
        `SELECT 1 FROM slack_channel_replies WHERE team = ? AND bot = ? AND channel = ?
       AND replied_at <= ? AND replied_at >= ? LIMIT 1`,
      )
      .get(team, bot, channel, at, at - CHANNEL_FOLLOWUP_SECONDS);
  }

  recordChannelReply(
    team: string,
    bot: string,
    channel: string,
    ts: string,
  ): void {
    const at = Number(ts);
    if (!Number.isFinite(at) || at <= 0) return;
    // Retain earlier confirmations: delayed intake may predate a newer post.
    // Like thread subscriptions, this stores no message bodies.
    this.db
      .prepare(
        "INSERT OR IGNORE INTO slack_channel_replies VALUES (?, ?, ?, ?)",
      )
      .run(team, bot, channel, at);
  }

  close(): void {
    this.db.close();
  }
}
