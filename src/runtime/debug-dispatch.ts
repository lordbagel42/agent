import { randomUUID } from "node:crypto";
import { link, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import type { DebugInvestigator } from "./session-controls.js";

const idSchema = z.string().uuid();
const receiptSchema = z.strictObject({
  id: idSchema,
  status: z.enum(["running", "completed", "unknown"]),
  threadId: z
    .string()
    .regex(/^T-[a-f0-9-]{36}$/i)
    .optional(),
});

/** Only publishes private files and observes receipts. Never launches Amp. */
export function createDebugDispatcher(settings: {
  directory: string;
  timeoutMs: number;
}): DebugInvestigator {
  const inspect: NonNullable<DebugInvestigator["inspect"]> = async (id) => {
    idSchema.parse(id);
    try {
      const receipt = receiptSchema.parse(
        JSON.parse(
          await readFile(
            join(settings.directory, `${id}.receipt.json`),
            "utf8",
          ),
        ),
      );
      if (receipt.id !== id) throw new Error("Debug receipt identity mismatch");
      return receipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const request = await stat(join(settings.directory, `${id}.json`)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return undefined;
        },
      );
      return request ? { status: "queued" } : undefined;
    }
  };
  return {
    resumeSafe: true,
    inspect,
    async run(snapshot, signal, onThread) {
      idSchema.parse(snapshot.id);
      signal.throwIfAborted();
      const metadata = await stat(settings.directory);
      if (
        (await realpath(settings.directory)) !== settings.directory ||
        !metadata.isDirectory() ||
        (metadata.mode & 0o077) !== 0 ||
        metadata.uid !== process.getuid?.()
      )
        throw new Error("Private canonical debug directory required");
      const bytes = JSON.stringify(snapshot);
      if (Buffer.byteLength(bytes) > 64 * 1024 * 1024)
        throw new Error("Debug snapshot exceeds transport limit");
      const target = join(settings.directory, `${snapshot.id}.json`);
      const temporary = join(settings.directory, `.${randomUUID()}.tmp`);
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
        await file.close();
        try {
          await link(temporary, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if ((await readFile(target, "utf8")) !== bytes)
            throw new Error("Debug snapshot conflict");
        }
        const directory = await open(settings.directory, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        await file.close();
        await unlink(temporary);
      }
      // Losing this observer does not stop the independent service or its agent.
      const observation = AbortSignal.any([
        signal,
        AbortSignal.timeout(settings.timeoutMs),
      ]);
      let threadId: string | undefined;
      for (;;) {
        observation.throwIfAborted();
        const receipt = await inspect(snapshot.id);
        if (!receipt) throw new Error("Debug request disappeared");
        if (receipt.threadId && receipt.threadId !== threadId) {
          threadId = receipt.threadId;
          await onThread(threadId);
        }
        if (receipt.status === "completed" && threadId)
          return {
            threadId,
            report:
              "Investigator returned; inspect the private Amp thread for findings and delivery evidence.",
          };
        if (receipt.status === "unknown")
          throw new Error("Debug launch or completion unknown");
        await setTimeout(1000, undefined, { signal: observation });
      }
    },
  };
}
