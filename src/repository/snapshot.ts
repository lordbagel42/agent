import { Readable } from "node:stream";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { extract } from "tar-stream";
import { z } from "zod";
import { type RepositoryRead, repositoryReadSchema } from "./contracts.js";

const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
const api = "https://api.github.com/repos/lordbagel42/agent";
const decode = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const unzip = promisify(gunzip);

interface SourceFile {
  bytes: Buffer;
  kind: "text" | "binary" | "link";
}

export class RepositorySnapshot {
  constructor(
    readonly revision: string,
    private readonly files: ReadonlyMap<string, SourceFile>,
  ) {}

  inventory() {
    return [...this.files].map(([path, file]) => ({
      path,
      kind: file.kind,
      bytes: file.bytes.length,
    }));
  }

  read(input: RepositoryRead) {
    const { action, path, query, offset } = repositoryReadSchema.parse(input);
    if (action === "read") {
      const file = this.files.get(path);
      if (!file) return { error: "Path is not in this snapshot." };
      if (file.kind !== "text")
        return {
          error: `${file.kind} entry; bytes are retained but not interpreted or followed.`,
        };
      const text = decode.decode(file.bytes);
      if (offset > text.length) return { error: "Offset exceeds file length." };
      const content = text.slice(offset, offset + 12_000);
      const startLine = text.slice(0, offset).split("\n").length;
      const endLine = startLine + content.split("\n").length - 1;
      return {
        path,
        startLine,
        endLine,
        offset,
        nextOffset:
          offset + content.length < text.length
            ? offset + content.length
            : null,
        citation: `https://github.com/lordbagel42/agent/blob/${this.revision}/${path.split("/").map(encodeURIComponent).join("/")}#L${startLine}-L${endLine}`,
        content,
      };
    }
    if (!query.trim())
      return { error: "Search requires a nonempty literal query." };
    const matches: {
      path: string;
      line: number;
      offset: number;
      excerpt: string;
    }[] = [];
    let skipped = 0;
    for (const [name, file] of this.files) {
      if (!name.startsWith(path) || file.kind !== "text") continue;
      const lines = decode.decode(file.bytes).split("\n");
      let position = 0;
      for (const [index, line] of lines.entries()) {
        const lineOffset = position;
        position += line.length + 1;
        const column = line.toLowerCase().indexOf(query.toLowerCase());
        if (column < 0) continue;
        if (skipped++ < offset) continue;
        if (matches.length === 30)
          return { matches, nextOffset: offset + matches.length };
        matches.push({
          path: name,
          line: index + 1,
          offset: lineOffset + Math.max(0, column - 100),
          excerpt: line.slice(Math.max(0, column - 100), column + 250),
        });
      }
    }
    return { matches, nextOffset: null };
  }
}

/** Parse only into memory. No extraction, link resolution, or host filesystem access. */
export async function parseRepositoryArchive(
  revision: string,
  compressed: Buffer,
) {
  revisionSchema.parse(revision);
  const archive = await unzip(compressed, {
    maxOutputLength: 64 * 1024 * 1024,
  });
  const parser = extract();
  const source = Readable.from([archive]);
  const files = new Map<string, SourceFile>();
  let root: string | undefined;
  let entries = 0;
  source.pipe(parser);
  try {
    for await (const entry of parser) {
      if (++entries > 5000) throw new Error("repository_too_many_entries");
      const { name, type, linkname } = entry.header;
      const parts = name.replace(/\/$/, "").split("/");
      const prefix = parts.shift();
      const suffix = prefix?.match(
        /^(?:lordbagel42-)?agent-([a-f0-9]{7,40})$/,
      )?.[1];
      if (
        !suffix ||
        !revision.startsWith(suffix) ||
        (root && root !== prefix) ||
        parts.some((part) => !part || part === "." || part === "..") ||
        name.includes("\\")
      )
        throw new Error("repository_unsafe_path");
      root = prefix;
      if (type === "directory") {
        entry.resume();
        continue;
      }
      if (!parts.length || !["file", "symlink", "link"].includes(type ?? ""))
        throw new Error("repository_unsupported_entry");
      const path = parts.join("/");
      if (files.has(path)) throw new Error("repository_duplicate_path");
      const chunks: Buffer[] = [];
      for await (const chunk of entry)
        chunks.push(Buffer.from(chunk as Uint8Array));
      const bytes =
        type === "file" ? Buffer.concat(chunks) : Buffer.from(linkname ?? "");
      let kind: SourceFile["kind"] = type === "file" ? "binary" : "link";
      if (type === "file" && !bytes.includes(0)) {
        try {
          decode.decode(bytes);
          kind = "text";
        } catch {
          /* Binary contents remain available in the snapshot, not model text. */
        }
      }
      files.set(path, { bytes, kind });
    }
  } finally {
    source.destroy();
    parser.destroy();
  }
  if (!files.size) throw new Error("repository_empty_archive");
  const snapshot = new RepositorySnapshot(
    revision,
    new Map([...files].sort(([a], [b]) => a.localeCompare(b))),
  );
  if (JSON.stringify(snapshot.inventory()).length > 350_000)
    throw new Error("repository_inventory_too_large");
  return snapshot;
}

async function boundedBody(response: Response, limit: number) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("repository_download_failed");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("repository_download_too_large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/** Fixed public repository, no auth, model URLs, local paths, or partial fallback. */
export function createRepositoryLoader(loadedRevision?: string) {
  let revision =
    loadedRevision === undefined
      ? undefined
      : revisionSchema.parse(loadedRevision);
  let pending: Promise<RepositorySnapshot> | undefined;
  const load = async () => {
    // Public source loading is host-owned, not owned by the first question.
    // Cancelling one waiter must not cancel another worker's consultation.
    const bounded = AbortSignal.timeout(30_000);
    if (!revision) {
      const body = await boundedBody(
        await fetch(`${api}/commits/main`, {
          signal: bounded,
          redirect: "error",
        }),
        1024 * 1024,
      );
      revision = z
        .object({ sha: revisionSchema })
        .parse(JSON.parse(body.toString("utf8"))).sha;
    }
    const redirect = await fetch(`${api}/tarball/${revision}`, {
      signal: bounded,
      redirect: "manual",
    });
    await redirect.body?.cancel();
    const location = new URL(
      redirect.headers.get("location") ?? "https://invalid.invalid",
    );
    if (
      redirect.status !== 302 ||
      location.protocol !== "https:" ||
      location.hostname !== "codeload.github.com" ||
      location.port ||
      location.username ||
      location.password
    )
      throw new Error("repository_invalid_redirect");
    const bytes = await boundedBody(
      await fetch(location, { signal: bounded, redirect: "error" }),
      16 * 1024 * 1024,
    );
    const snapshot = await parseRepositoryArchive(revision, bytes);
    bounded.throwIfAborted();
    return snapshot;
  };
  return (signal: AbortSignal) => {
    signal.throwIfAborted();
    // Share public source bytes, never model context. A later explicit question
    // may retry a failed read, but stays pinned to the same resolved revision.
    pending ??= load().catch((error) => {
      pending = undefined;
      throw error;
    });
    const cancelled = Promise.withResolvers<never>();
    const onAbort = () => cancelled.reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    return Promise.race([pending, cancelled.promise]).finally(() =>
      signal.removeEventListener("abort", onAbort),
    );
  };
}
