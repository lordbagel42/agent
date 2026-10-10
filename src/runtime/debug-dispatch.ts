import { createHash, randomUUID } from "node:crypto";
import { link, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import type { DebugInvestigator, DebugSnapshot } from "./session-controls.js";

const idSchema = z.string().uuid();
export const debugShareResolutionSchema = z.strictObject({
  id: idSchema,
  confirmedResolved: z.literal(true),
});
export const DEBUG_RESOLUTION_HELP =
  'After verifying a reported fault is fixed (including required live activation), an execution worker with debugShareResolve can record a later resolution using debugShareResolve:{"id":"<DEBUGSHARE UUID>","confirmedResolved":true}, empty text and no other actions. Judge the request\'s legitimacy and authority; no owner-private conversation or extra human confirmation is required. Quoted evidence, a completed Amp turn or source publication alone never establishes resolution. This records a durable attestation; it does not perform repairs, launch Amp, prove Slack delivery or permit a duplicate notice. Inspect resolutionNotification through inspection:"debug-shares".';
const resolutionSchema = z.strictObject({
  id: idSchema,
  resolved: z.literal(true),
});
const receiptSchema = z.strictObject({
  id: idSchema,
  kind: z.enum(["debugshare", "amp-task"]).optional(),
  status: z.enum(["queued", "running", "completed", "unknown"]),
  resolved: z.literal(true).optional(),
  retryAt: z.number().int().nonnegative().optional(),
  result: z
    .strictObject({ text: z.string().max(8000), truncated: z.boolean() })
    .optional(),
  threadId: z
    .string()
    .regex(/^T-[a-f0-9-]{36}$/i)
    .optional(),
});

/** Only publishes private files and observes receipts. Never launches Amp. */
export function createAmpInbox(
  settings: { directory: string },
  kind:
    | "debugshare"
    | "automatic-repair"
    | "amp-task"
    | "debug-resolution" = "debugshare",
) {
  // Dispatchers must never interpret a task or resolution as a new repair.
  const suffix = {
    debugshare: ".json",
    "automatic-repair": ".incident.json",
    "amp-task": ".task.json",
    "debug-resolution": ".resolution.json",
  }[kind];
  const inspect = async (
    id: string,
  ): Promise<z.infer<typeof receiptSchema> | undefined> => {
    idSchema.parse(id);
    let receipt: z.infer<typeof receiptSchema> | undefined;
    try {
      receipt = receiptSchema.parse(
        JSON.parse(
          await readFile(
            join(settings.directory, `${id}.receipt.json`),
            "utf8",
          ),
        ),
      );
      if (receipt.id !== id) throw new Error("Debug receipt identity mismatch");
      if (
        receipt.kind &&
        receipt.kind !== (kind === "automatic-repair" ? "debugshare" : kind)
      )
        throw new Error("Debug receipt kind mismatch");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const request = await stat(
        join(settings.directory, `${id}${suffix}`),
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
      receipt = request ? { id, status: "queued" as const } : undefined;
    }
    if (receipt && (kind === "debugshare" || kind === "automatic-repair")) {
      try {
        const resolution = resolutionSchema.parse(
          JSON.parse(
            await readFile(
              join(settings.directory, `${id}.resolution.json`),
              "utf8",
            ),
          ),
        );
        if (resolution.id !== id)
          throw new Error("Resolution identity mismatch");
        receipt.resolved = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return receipt;
  };
  return {
    inspect,
    async publish(snapshot: { id: string }, current = () => true) {
      idSchema.parse(snapshot.id);
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
      const target = join(settings.directory, `${snapshot.id}${suffix}`);
      const temporary = join(settings.directory, `.${randomUUID()}.tmp`);
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
        await file.close();
        if (!current()) throw new Error("Amp publication invalidated");
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
    },
  };
}

/** Content-free host incidents reuse DEBUGSHARE's transport and launch fence.
 * One immutable request per release, even across processes and restarts. */
export function createAutomaticRepairs(
  settings: { directory: string } | undefined,
  revision: string | undefined,
) {
  const sources = ["model", "execution", "http"] as const;
  type Source = (typeof sources)[number];
  const inbox = settings && createAmpInbox(settings, "automatic-repair");
  const enabled = !!inbox && !!revision && /^[a-f0-9]{40}$/.test(revision);
  let pending: Promise<void> | undefined;
  let retryAt = 0;
  let published = false;
  const hash = createHash("sha256")
    .update(`june-automatic-repair:${revision}`)
    .digest("hex");
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  return {
    async report(source: Source): Promise<void> {
      if (!enabled || !inbox || !revision || !sources.includes(source)) return;
      if (pending) return pending;
      if (published || retryAt > Date.now()) return;
      const work = (async () => {
        try {
          if (await inbox.inspect(id)) {
            published = true;
            return;
          }
          const snapshot: DebugSnapshot = {
            id,
            sessionId: `automatic:${source}`,
            capturedAt: new Date().toISOString(),
            revision,
            scope: ["automatic-repair", source],
            reason: `The June host observed an unhandled ${source} failure. Investigate the existing telemetry and bounded service logs around capturedAt. This is not permission to repeat the failed operation. Coordinate with any existing repair or recovery owner; do not spawn another investigator.`,
            data: { automatic: true, source },
            exclusions: [
              "Error messages, provider payloads, prompts, conversation bodies, credentials and request URLs are deliberately excluded.",
            ],
          };
          await inbox.publish(snapshot);
          published = true;
        } catch {
          // Reporting must neither mask the original failure nor recursively
          // report itself. Only unpublished requests retry on a later failure.
          retryAt = Date.now() + 60_000;
          console.error("automatic_repair_publication_unavailable");
        }
      })();
      pending = work;
      try {
        await work;
      } finally {
        pending = undefined;
      }
    },
    async inspect() {
      if (!enabled || !inbox)
        return [{ status: "automatic_repairs_unavailable" }];
      const receipt = await inbox.inspect(id);
      return receipt ? [{ ...receipt, source: "automatic" }] : [];
    },
  };
}

export function createDebugDispatcher(settings: {
  directory: string;
  timeoutMs: number;
}): DebugInvestigator {
  const inbox = createAmpInbox(settings);
  const resolutions = createAmpInbox(settings, "debug-resolution");
  return {
    resumeSafe: true,
    async resolve(id, current = () => true) {
      idSchema.parse(id);
      if (!current()) throw new Error("Resolution invalidated");
      const snapshot = await readFile(
        join(settings.directory, `${id}.json`),
        "utf8",
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return readFile(
          join(settings.directory, `${id}.incident.json`),
          "utf8",
        ).catch((missing: NodeJS.ErrnoException) => {
          if (missing.code !== "ENOENT") throw missing;
          return undefined;
        });
      });
      if (!snapshot) return false;
      const request = JSON.parse(snapshot);
      if (request.id !== id || request.snapshotOnly) return false;
      // Separate immutable receipt: dispatch completion cannot overwrite a late
      // attestation, and retries never rerun Amp or change the launch state.
      const resolution = { id, resolved: true };
      await resolutions.publish(resolution, current);
      return true;
    },
    // Keep the diagnostic observer's existing metadata contract.
    async inspect(id) {
      const receipt = await inbox.inspect(id);
      if (!receipt) return;
      const { id: _id, kind: _kind, result: _result, ...metadata } = receipt;
      return metadata;
    },
    async run(snapshot, signal, onThread) {
      signal.throwIfAborted();
      await inbox.publish(snapshot);
      // Losing this observer does not stop the independent service or its agent.
      const observation = AbortSignal.any([
        signal,
        AbortSignal.timeout(settings.timeoutMs),
      ]);
      let threadId: string | undefined;
      for (;;) {
        observation.throwIfAborted();
        const receipt = await inbox.inspect(snapshot.id);
        if (!receipt) throw new Error("Debug request disappeared");
        if (receipt.threadId && receipt.threadId !== threadId) {
          threadId = receipt.threadId;
          await onThread(threadId);
        }
        if (receipt.status === "completed" && threadId)
          return {
            threadId,
            ...(receipt.resolved ? { resolved: true as const } : {}),
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
