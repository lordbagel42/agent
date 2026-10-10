/** Small, dependency-free markdown helpers for the mind repository. */

export interface Frontmatter {
  meta: Record<string, string>;
  body: string;
}

export function splitFrontmatter(text: string): Frontmatter {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (pair?.[1]) meta[pair[1]] = (pair[2] ?? "").trim();
  }
  return { meta, body: text.slice(match[0].length) };
}

export function withFrontmatter(meta: Record<string, string>, body: string) {
  const lines = Object.entries(meta).map(
    ([key, value]) => `${key}: ${value.replace(/[\r\n]+/g, " ")}`,
  );
  return `---\n${lines.join("\n")}\n---\n\n${body.trim()}\n`;
}

export interface Section {
  heading: string;
  text: string;
}

/** Split at level-two headings outside code fences.
 * Unindented `## Private — <place>` lines (including privatePlace's accepted
 * dash variants) are reserved privacy boundaries, even inside code fences.
 * Escape the first # as `\##` when showing that syntax in a literal example.
 * Fence state never crosses a privacy boundary. */
export function splitSections(body: string): {
  preamble: string;
  sections: Section[];
} {
  const lines = body.split("\n");
  const preamble: string[] = [];
  const sections: { heading: string; lines: string[] }[] = [];
  let fence: string | undefined;
  for (const line of lines) {
    if (/^## /.test(line) && (!fence || privatePlace(line) !== undefined)) {
      sections.push({ heading: line.trim(), lines: [] });
      // A preceding writer-controlled fence must not change how retained
      // private content is parsed when mergeProjectedWrite appends it.
      fence = undefined;
      continue;
    }
    const match = /^ {0,3}(`{3,}|~{3,})(.*)\r?$/.exec(line);
    const marker = match?.[1];
    const suffix = match?.[2] ?? "";
    if (marker) {
      if (!fence) {
        if (marker[0] === "~" || !suffix.includes("`")) fence = marker;
      } else if (
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        /^[ \t]*$/.test(suffix)
      ) {
        fence = undefined;
      }
    }
    if (sections.length) {
      sections.at(-1)?.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  return {
    preamble: preamble.join("\n"),
    sections: sections.map(({ heading, lines }) => ({
      heading,
      text: lines.join("\n"),
    })),
  };
}

function joinSections(preamble: string, sections: Section[]) {
  return [
    preamble.trimEnd(),
    ...sections.map(({ heading, text }) => `${heading}\n${text.trimEnd()}`),
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

/** `## Private — <place>` sections are visible only in that place. */
export function privatePlace(heading: string): string | undefined {
  return /^## Private\s*[—–-]+\s*([A-Za-z0-9-]+)\s*$/.exec(heading)?.[1];
}

/** Remove every private section that does not belong to the current place. */
export function projectSections(body: string, placeId: string) {
  const { preamble, sections } = splitSections(body);
  return joinSections(
    preamble,
    sections.filter((section) => {
      const owner = privatePlace(section.heading);
      return owner === undefined || owner === placeId;
    }),
  );
}

/** Apply a write made while viewing `projectSections(existing, placeId)`.
 * The writer cannot see or change other places' private sections, so they are
 * carried over from the existing file and any it tried to add are dropped. */
export function mergeProjectedWrite(
  existing: string,
  written: string,
  placeId: string,
) {
  const incoming = splitSections(written);
  const kept = incoming.sections.filter((section) => {
    const owner = privatePlace(section.heading);
    return owner === undefined || owner === placeId;
  });
  const hidden = splitSections(existing).sections.filter((section) => {
    const owner = privatePlace(section.heading);
    return owner !== undefined && owner !== placeId;
  });
  return joinSections(incoming.preamble, [...kept, ...hidden]);
}

export function firstHeading(body: string) {
  return /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
}

export function clip(text: string, limit: number) {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n[… ${text.length - limit} more characters not shown]`;
}
