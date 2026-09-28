import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Thread subscriptions from direct owner contact or confirmed posts; IDs only. */
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

  close(): void {
    this.db.close();
  }
}
