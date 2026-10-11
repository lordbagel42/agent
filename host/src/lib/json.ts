import { Predicate } from "effect";

export type JsonObject = Record<string, unknown>;

/** A decoded JSON object (Python `dict`), not an array. */
export const asRecord = (value: unknown): JsonObject | undefined =>
  Predicate.isObject(value) && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;

/** Python `dict.get`: own keys only. */
export const get = (value: unknown, key: string): unknown => {
  const record = asRecord(value);
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
};

/** Python `value == [strings...]` for a decoded JSON value. */
export const equalsList = (value: unknown, expected: readonly string[]) =>
  Array.isArray(value) &&
  value.length === expected.length &&
  value.every((item, index) => item === expected[index]);
