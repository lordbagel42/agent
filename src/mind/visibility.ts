import { clip, projectSections, splitFrontmatter } from "./markdown.js";
import type { Place } from "./places.js";
import type { MindRepo } from "./repo.js";

/** Where notes are being shown. Everything June sees is projected for it. */
export interface Viewer {
  place: Place;
  /** Raygen's one-to-one DM: the only place the journal is visible. */
  ownerDm: boolean;
}

/** The projected file a viewer may see, or undefined when it is invisible. */
export async function view(repo: MindRepo, path: string, viewer: Viewer) {
  if (
    (path.startsWith("self/journal/") || path.startsWith("self/reports/")) &&
    !viewer.ownerDm
  )
    return undefined;
  const text = await repo.read(path);
  if (text === undefined) return undefined;
  const conversation = /^conversations\/([A-Za-z0-9-]+)\.md$/.exec(path);
  if (conversation) {
    const { meta } = splitFrontmatter(text);
    return conversation[1] === viewer.place.id || meta.kind === "public"
      ? text
      : undefined;
  }
  if (path.startsWith("people/")) return projectSections(text, viewer.place.id);
  return text;
}

export async function visibleList(
  repo: MindRepo,
  prefix: string,
  viewer: Viewer,
) {
  const paths = await repo.list(prefix);
  const visible: { path: string; title: string }[] = [];
  for (const path of paths) {
    const text = await view(repo, path, viewer);
    if (text === undefined) continue;
    const { meta, body } = splitFrontmatter(text);
    const title =
      meta.description ??
      meta.label ??
      /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ??
      "";
    visible.push({ path, title: title.slice(0, 200) });
  }
  return visible;
}

export async function search(
  repo: MindRepo,
  query: string,
  viewer: Viewer,
  prefix = "",
) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: { path: string; line: number; text: string }[] = [];
  for (const path of await repo.list(prefix)) {
    const text = await view(repo, path, viewer);
    if (text === undefined) continue;
    const lines = text.split("\n");
    for (const [index, line] of lines.entries()) {
      if (!line.toLowerCase().includes(needle)) continue;
      matches.push({ path, line: index + 1, text: clip(line.trim(), 300) });
      if (matches.length >= 25) return matches;
    }
  }
  return matches;
}
