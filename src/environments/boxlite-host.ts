import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { join, posix } from "node:path";

async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** A durable exclusive marker, not a PID lock that can be reclaimed on timeout.
 * A crash fences the entire provider BEFORE SDK recovery can attach to a VM.
 * Only verified shutdown removes it; reconciliation is an operator operation. */
export async function openBoxLiteHost(directory: string) {
  const entries = await fs.readdir(directory);
  const managed = entries.includes("june-managed-v1");
  const identity = managed
    ? await fs.readFile(join(directory, "june-managed-v1"), "utf8")
    : `${randomUUID()}\n`;
  if (managed ? !/^[a-f0-9-]{36}\n$/.test(identity) : entries.length !== 0)
    throw new Error("BoxLite home is not a verified June-managed directory");
  const marker = join(directory, "june-active");
  const records = join(directory, "june-boxes");
  const handle = await fs.open(marker, "wx", 0o600);
  try {
    await handle.writeFile(
      "Unconfirmed until all VMs and the runtime stop. Never remove based on PID age or SDK status alone.\n",
    );
    await handle.sync();
    if (!managed)
      await fs.writeFile(join(directory, "june-managed-v1"), identity, {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
    await fs.mkdir(records, { recursive: true, mode: 0o700 });
    await syncDirectory(directory);
  } finally {
    await handle.close();
  }
  let closing: Promise<void> | undefined;
  const ownerRecord = (owner: string) =>
    `${createHash("sha256").update(owner).digest("hex")}\n`;
  const recordPath = (id: string) => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid box ID");
    return join(records, id);
  };
  return {
    binding: `boxlite:${identity.trim()}`,
    witness: witnessBoxLiteProcess,
    async retain(owner: string, id: string) {
      const path = recordPath(id);
      const value = ownerRecord(owner);
      try {
        await fs.writeFile(path, value, {
          flag: "wx",
          mode: 0o600,
          flush: true,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if ((await fs.readFile(path, "utf8")) !== value)
          throw new Error("Box ownership mismatch");
      }
      await syncDirectory(records);
    },
    async retained(owner: string) {
      const ids: string[] = [];
      for (const id of await fs.readdir(records)) {
        try {
          if (
            (await fs.readFile(recordPath(id), "utf8")) === ownerRecord(owner)
          )
            ids.push(id);
        } catch (error) {
          // Another worker may retire its record after this directory snapshot.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      return ids;
    },
    async confirmRemoved(owner: string, id: string) {
      const path = recordPath(id);
      if ((await fs.readFile(path, "utf8")) !== ownerRecord(owner))
        throw new Error("Box ownership mismatch");
      // No clone/export/snapshot APIs are exposed. 0.10.5 keeps all mutable
      // guest bytes under boxes/<id>; its remove() hides filesystem failures.
      try {
        await fs.lstat(join(directory, "boxes", id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try {
          await syncDirectory(join(directory, "boxes"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await syncDirectory(directory);
        }
        await fs.unlink(path);
        await syncDirectory(records);
        return;
      }
      throw new Error("Box storage deletion is unconfirmed");
    },
    close() {
      closing ??= (async () => {
        await fs.unlink(marker);
        await syncDirectory(directory);
      })();
      return closing;
    },
  };
}
export type BoxLiteHost = Awaited<ReturnType<typeof openBoxLiteHost>>;

async function processIdentity(pid: number) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    // comm may itself contain spaces or parentheses; starttime is field 22.
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    if (!/^\d+$/.test(fields[19] ?? ""))
      throw new Error("Invalid process identity");
    return { start: fields[19], state: fields[0] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** BoxLite 0.10.5 treats cgroup setup/join/kill as best effort. Witness actual
 * launcher membership before permitting commands; SDK stop alone is not proof.
 * Requires exclusive host ownership: nobody may migrate/restart these processes.
 * Reads only this SDK-selected PID and its dedicated cgroup, never scans/kills. */
export async function witnessBoxLiteProcess(
  id: string,
  pid: number | undefined,
) {
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(id) ||
    !Number.isSafeInteger(pid) ||
    !pid ||
    pid < 1
  )
    throw new Error("Missing BoxLite process identity");
  const original = await processIdentity(pid);
  if (!original || original.state === "Z")
    throw new Error("BoxLite process is not live");
  const membership = await fs.readFile(`/proc/${pid}/cgroup`, "utf8");
  const relative = /^0::([^\n]+)$/m.exec(membership)?.[1];
  if (
    !relative?.startsWith("/") ||
    posix.normalize(relative) !== relative ||
    !relative.endsWith(`/boxlite/${id}`)
  )
    throw new Error("BoxLite has no verified dedicated cgroup");
  const group = `/sys/fs/cgroup${relative}`;
  const identity = await fs.stat(group);
  const members = await fs.readFile(join(group, "cgroup.procs"), "utf8");
  if (
    !members.trim().split(/\s+/).includes(String(pid)) ||
    (await processIdentity(pid))?.start !== original.start
  )
    throw new Error("BoxLite containment changed during admission");
  return async () => {
    const deadline = performance.now() + 2000;
    do {
      const current = await fs.stat(group);
      if (current.dev !== identity.dev || current.ino !== identity.ino)
        throw new Error("BoxLite cgroup identity changed");
      const events = await fs.readFile(join(group, "cgroup.events"), "utf8");
      if (/^populated 0$/m.test(events)) {
        const process = await processIdentity(pid);
        const after = await fs.stat(group);
        if (after.dev !== identity.dev || after.ino !== identity.ino)
          throw new Error("BoxLite cgroup identity changed");
        if (
          !process ||
          process.start !== original.start ||
          process.state === "Z"
        )
          return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (performance.now() < deadline);
    throw new Error("BoxLite compute termination is unconfirmed");
  };
}
