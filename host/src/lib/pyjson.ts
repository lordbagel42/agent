/**
 * Byte-compatible with CPython's `json.dumps`/`json.loads`. Receipts, state
 * files and fingerprints written by the Python services are read and hashed
 * by June, the debug site and recovery threads, so the encoding must not drift.
 */

export type Json =
  | null
  | boolean
  | number
  | bigint
  | string
  | readonly Json[]
  | { readonly [key: string]: Json | undefined };

export interface DumpOptions {
  /** Python's `separators`; defaults to `(", ", ": ")`, or `(",", ": ")` with indent. */
  readonly separators?: readonly [string, string];
  readonly sortKeys?: boolean;
  readonly ensureAscii?: boolean;
  readonly indent?: number;
  readonly allowNan?: boolean;
}

const hex4 = (code: number) => code.toString(16).padStart(4, "0");

const shortEscapes: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
};

export function encodeString(value: string, ensureAscii = true): string {
  let out = '"';
  for (let index = 0; index < value.length; index++) {
    const character = value[index] as string;
    const code = value.charCodeAt(index);
    const short = shortEscapes[character];
    if (short) out += short;
    else if (code < 0x20 || (ensureAscii && code > 0x7e))
      // UTF-16 code units are exactly Python's surrogate-pair escapes.
      out += `\\u${hex4(code)}`;
    else out += character;
  }
  return `${out}"`;
}

/** CPython `float.__repr__`: shortest round-trip digits, exponent outside [-4, 16). */
export function floatRepr(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const [mantissa = "", exponentText = "0"] = value.toExponential().split("e");
  const negative = mantissa.startsWith("-");
  const digits = mantissa.replace("-", "").replace(".", "");
  const exponent = Number(exponentText);
  let body: string;
  if (exponent < -4 || exponent >= 16) {
    const fraction = digits.slice(1);
    body = `${digits[0]}${fraction ? `.${fraction}` : ""}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  } else if (exponent < 0) {
    body = `0.${"0".repeat(-exponent - 1)}${digits}`;
  } else if (digits.length <= exponent + 1) {
    body = `${digits}${"0".repeat(exponent + 1 - digits.length)}.0`;
  } else {
    body = `${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`;
  }
  return negative ? `-${body}` : body;
}

/** Marks a number that Python held as a float even when it is integral. */
export class PyFloat {
  constructor(readonly value: number) {}
}

export function dumps(value: unknown, options: DumpOptions = {}): string {
  const ensureAscii = options.ensureAscii ?? true;
  const allowNan = options.allowNan ?? true;
  const indent = options.indent;
  const [itemSeparator, keySeparator] =
    options.separators ?? (indent === undefined ? [", ", ": "] : [",", ": "]);
  const encode = (item: unknown, depth: number): string => {
    if (item === null || item === undefined) return "null";
    if (item === true) return "true";
    if (item === false) return "false";
    if (typeof item === "bigint") return item.toString();
    if (typeof item === "string") return encodeString(item, ensureAscii);
    if (typeof item === "number" || item instanceof PyFloat) {
      const number = typeof item === "number" ? item : item.value;
      if (!Number.isFinite(number) && !allowNan)
        throw new RangeError(
          "Out of range float values are not JSON compliant",
        );
      if (typeof item === "number" && Number.isInteger(number))
        return Object.is(number, -0) ? "0" : number.toFixed(0);
      return floatRepr(number);
    }
    const open = (bracket: string, close: string, parts: string[]) => {
      if (parts.length === 0) return `${bracket}${close}`;
      if (indent === undefined)
        return `${bracket}${parts.join(itemSeparator)}${close}`;
      const inner = `\n${" ".repeat(indent * (depth + 1))}`;
      const outer = `\n${" ".repeat(indent * depth)}`;
      return `${bracket}${inner}${parts.join(itemSeparator + inner)}${outer}${close}`;
    };
    if (Array.isArray(item))
      return open(
        "[",
        "]",
        item.map((entry) => encode(entry, depth + 1)),
      );
    if (typeof item === "object") {
      let keys = Object.keys(item).filter(
        (key) => (item as Record<string, unknown>)[key] !== undefined,
      );
      if (options.sortKeys) keys = keys.sort(compareCodePoints);
      return open(
        "{",
        "}",
        keys.map(
          (key) =>
            `${encodeString(key, ensureAscii)}${keySeparator}${encode((item as Record<string, unknown>)[key], depth + 1)}`,
        ),
      );
    }
    throw new TypeError(
      `Object of type ${typeof item} is not JSON serializable`,
    );
  };
  return encode(value, 0);
}

export function compareCodePoints(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference =
      (a[index]?.codePointAt(0) ?? 0) - (b[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

/**
 * Like `json.loads`: integers beyond 2^53 stay exact as `bigint` (controller
 * attempt IDs are nanosecond timestamps). Callers validate shapes.
 */
export function loads(text: string | Uint8Array): unknown {
  const source =
    typeof text === "string"
      ? text
      : new TextDecoder("utf-8", { fatal: true }).decode(text);
  return JSON.parse(source, (_key, value, context?: { source?: string }) =>
    typeof value === "number" &&
    !Number.isSafeInteger(value) &&
    context?.source !== undefined &&
    /^-?\d+$/.test(context.source)
      ? BigInt(context.source)
      : value,
  );
}
