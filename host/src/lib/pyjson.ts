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

export class StrictJsonError extends Error {}

/**
 * `json.loads` with `object_pairs_hook` rejecting duplicate keys and
 * `parse_constant` rejecting NaN/Infinity. Integral-valued float tokens become
 * `PyFloat` so Python `type(value) is int` checks keep rejecting them.
 */
export function loadsStrict(text: string | Uint8Array): unknown {
  let source: string;
  try {
    source =
      typeof text === "string"
        ? text
        : new TextDecoder("utf-8", { fatal: true }).decode(text);
  } catch {
    throw new StrictJsonError("invalid_json");
  }
  let index = 0;
  const fail = (): never => {
    throw new StrictJsonError("invalid_json");
  };
  const skip = () => {
    while (" \t\n\r".includes(source[index] ?? "x")) index++;
  };
  const stringToken = (): string => {
    const start = index;
    index++;
    while (index < source.length) {
      const character = source[index];
      if (character === "\\") index += 2;
      else if (character === '"') {
        index++;
        return JSON.parse(source.slice(start, index)) as string;
      } else index++;
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    if (depth > 900) fail();
    skip();
    const character = source[index];
    if (character === "{") {
      index++;
      const result: Record<string, unknown> = {};
      skip();
      if (source[index] === "}") {
        index++;
        return result;
      }
      for (;;) {
        skip();
        if (source[index] !== '"') fail();
        const key = stringToken();
        if (Object.hasOwn(result, key)) fail();
        skip();
        if (source[index++] !== ":") fail();
        result[key] = value(depth + 1);
        skip();
        const next = source[index++];
        if (next === "}") return result;
        if (next !== ",") fail();
      }
    }
    if (character === "[") {
      index++;
      const result: unknown[] = [];
      skip();
      if (source[index] === "]") {
        index++;
        return result;
      }
      for (;;) {
        result.push(value(depth + 1));
        skip();
        const next = source[index++];
        if (next === "]") return result;
        if (next !== ",") fail();
      }
    }
    if (character === '"') return stringToken();
    const literal =
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?)/.exec(
        source.slice(index, index + 400),
      );
    if (!literal) return fail();
    index += literal[0].length;
    if (literal[0] === "true") return true;
    if (literal[0] === "false") return false;
    if (literal[0] === "null") return null;
    if (literal[1] === undefined && literal[2] === undefined) {
      const number = Number(literal[0]);
      return Number.isSafeInteger(number) ? number : BigInt(literal[0]);
    }
    const number = Number(literal[0]);
    if (!Number.isFinite(number)) return fail();
    return Number.isInteger(number) ? new PyFloat(number) : number;
  };
  try {
    JSON.parse(source);
  } catch {
    fail();
  }
  const result = value(0);
  skip();
  if (index !== source.length) fail();
  return result;
}

/** Python `type(value) is int` for a decoded JSON value. */
export const isInt = (value: unknown): value is number | bigint =>
  (typeof value === "number" && Number.isInteger(value)) ||
  typeof value === "bigint";

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
