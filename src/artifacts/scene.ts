import { z } from "zod";

const number = z.number().finite().min(-1_000_000).max(1_000_000);
const element = z
  .object({
    id: z.string().min(1).max(128),
    type: z.enum([
      "rectangle",
      "diamond",
      "ellipse",
      "arrow",
      "line",
      "freedraw",
      "text",
      "frame",
    ]),
    x: number,
    y: number,
    width: number.nonnegative(),
    height: number.nonnegative(),
    version: z.number().int().min(1).max(2_147_483_647),
    versionNonce: z.number().int().min(0).max(2_147_483_647),
    index: z
      .string()
      .regex(/^[A-Za-z][0-9A-Za-z]+$/)
      .max(256)
      .refine((key) => {
        const head = key.charCodeAt(0);
        const integerLength = head >= 97 ? head - 97 + 2 : 90 - head + 2;
        return (
          key.length >= integerLength &&
          (key.length === integerLength || !key.endsWith("0")) &&
          key !== `A${"0".repeat(26)}`
        );
      }),
    isDeleted: z.boolean(),
    link: z.null().optional(),
    customData: z.never().optional(),
  })
  .passthrough();
export type SceneElement = z.infer<typeof element>;
export function parseScene(input: unknown): SceneElement[] {
  const elements = z.array(element).max(2000).parse(input);
  if (
    new Set(elements.map((entry) => entry.id)).size !== elements.length ||
    JSON.stringify(elements).length > 1_048_576
  )
    throw new Error("artifact_scene_limit");
  return elements;
}
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** Complete model-authored elements: array order becomes layer order. */
export function completeScene(input: unknown): SceneElement[] {
  if (!Array.isArray(input)) return parseScene(input);
  // Models send null for unused fields; treat host-filled nulls as omitted.
  const filled = [
    "id",
    "index",
    "version",
    "versionNonce",
    "isDeleted",
    "width",
    "height",
  ];
  const entries = input.map((entry) =>
    typeof entry === "object" && entry !== null
      ? Object.fromEntries(
          Object.entries(entry).filter(
            ([key, value]) => value !== null || !filled.includes(key),
          ),
        )
      : entry,
  );
  const reindex = entries.some((entry) => entry?.index === undefined);
  return parseScene(
    entries.map((entry: Record<string, unknown>, position) => ({
      isDeleted: false,
      version: 1,
      versionNonce: position,
      width: 0,
      height: 0,
      ...entry,
      id: entry?.id ?? `june-${position}`,
      ...(reindex
        ? {
            index:
              position < 62
                ? `a${DIGITS[position]}`
                : `b${DIGITS[Math.floor(position / 62)]}${DIGITS[position % 62]}`,
          }
        : {}),
    })),
  );
}
export function mergeScene(
  saved: SceneElement[],
  incoming: SceneElement[],
): SceneElement[] {
  const result = new Map(saved.map((entry) => [entry.id, entry]));
  for (const entry of incoming) {
    const old = result.get(entry.id);
    if (
      !old ||
      entry.version > old.version ||
      (entry.version === old.version && entry.versionNonce > old.versionNonce)
    )
      result.set(entry.id, entry);
  }
  // Array order is layer order. Excalidraw restoreElements repairs indices to
  // match its input array, so preserving Map insertion order loses reordering.
  return parseScene(
    [...result.values()].sort((a, b) => {
      if (a.index !== b.index) return a.index < b.index ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    }),
  );
}
