/** Small CPython string semantics that host policies depend on. */

// str.isspace(): JavaScript's \s minus U+FEFF, plus U+001C–U+001F and U+0085.
const extraSpace = new Set([0x1c, 0x1d, 0x1e, 0x1f, 0x85]);
const isSpace = (character: string) =>
  character === "\ufeff"
    ? false
    : /\s/.test(character) || extraSpace.has(character.charCodeAt(0));

/** `not value.strip()` */
export const isBlank = (value: string) => [...value].every(isSpace);

/** `len(value)` counts code points, not UTF-16 units. */
export const length = (value: string) => {
  let count = 0;
  for (const _ of value) count++;
  return count;
};

/** `value[:count]` by code points. */
export const prefix = (value: string, count: number) =>
  [...value].slice(0, count).join("");

/** `str(PurePosixPath(value))`: collapses `//`, drops `.` and a trailing slash. */
export function purePath(value: string): string {
  const root = /^\/\/(?!\/)/.test(value)
    ? "//"
    : value.startsWith("/")
      ? "/"
      : "";
  const parts = value.split("/").filter((part) => part && part !== ".");
  return root + parts.join("/") || ".";
}

/** `base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))` for [A-Za-z0-9_-]. */
export function urlsafeB64decode(value: string): Buffer {
  if (value.length % 4 === 1) throw new Error("Invalid base64-encoded string");
  return Buffer.from(value, "base64url");
}
