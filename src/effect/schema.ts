import { Effect, Schema, SchemaTransformation } from "effect";

/** Zod-compatible building blocks for the Zod → Effect Schema migration. They
 * keep validation and the JSON Schema given to models identical to Zod 4's:
 * strict objects, UUID patterns, length bounds and defaults. */

/** Zod's `z.uuid()`: RFC variants 1–8 plus the nil and lowercase max UUID. */
const UUID =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
export const Uuid = Schema.String.check(
  Schema.isPattern(UUID, {
    expected: "a UUID",
    toJsonSchema: () => ({ format: "uuid", pattern: UUID.source }),
  }),
);

/** Zod's `.regex(regExp)`. Effect's `Schema.isPattern` omits `pattern` from
 * JSON Schema unless the RegExp has the `u` flag; Zod always emits it. */
export const isPattern = (regExp: RegExp) =>
  Schema.isPattern(regExp, {
    toJsonSchema: () => ({ pattern: regExp.source }),
  });

/** Zod's `z.strictObject({})`: an object with no keys. `Schema.Struct({})`
 * accepts any non-nullish value instead. */
export const EmptyObject = Schema.Record(Schema.String, Schema.Never);

/** Zod's `z.record(z.string(), z.unknown())`. Zod drops an own `__proto__`
 * key (for example from `JSON.parse`); `Schema.Record` keeps it. */
export const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown).pipe(
  Schema.decodeTo(
    Schema.Record(Schema.String, Schema.Unknown),
    SchemaTransformation.transform({
      decode: (record) =>
        Object.fromEntries(
          Object.entries(record).filter(([key]) => key !== "__proto__"),
        ),
      encode: (record) => record,
    }),
  ),
);

/** Zod 4's `z.url()`: accepted when `URL.canParse` accepts the trimmed
 * string; decodes to that trimmed string without ASCII tabs and newlines. */
export const Url = Schema.String.check(
  Schema.makeFilter((value: string) => URL.canParse(value.trim()), {
    expected: "a URL",
    toJsonSchema: () => ({ format: "uri" }),
  }),
).pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (value) => value.trim().replace(/[\t\n\r]/g, ""),
      encode: (value) => value,
    }),
  ),
);

/** Zod 4's `z.iso.datetime({ offset: true })`: RFC 3339 with seconds and a
 * `Z` or `±hh:mm` offset; leap days checked; no other date validation. */
const ISO_DATETIME_OFFSET =
  /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$/;
export const IsoDateTimeOffset = Schema.String.check(
  Schema.isPattern(ISO_DATETIME_OFFSET, {
    expected: "an ISO date-time with offset",
    toJsonSchema: () => ({
      format: "date-time",
      pattern: ISO_DATETIME_OFFSET.source,
    }),
  }),
);

/** Zod's `z.string().trim().min(min).max(max)`: bounds apply after trimming,
 * but JSON Schema advertises them on the input string as Zod does. */
export function TrimmedString(bounds: { min?: number; max?: number } = {}) {
  const advertised = {
    ...(bounds.min === undefined ? {} : { minLength: bounds.min }),
    ...(bounds.max === undefined ? {} : { maxLength: bounds.max }),
  };
  const checks = [
    ...(bounds.min === undefined ? [] : [Schema.isMinLength(bounds.min)]),
    ...(bounds.max === undefined ? [] : [Schema.isMaxLength(bounds.max)]),
  ];
  return Schema.String.check(
    Schema.makeFilter<string>(() => true, {
      toJsonSchema: () => advertised,
    }),
  ).pipe(
    Schema.decodeTo(
      checks.length
        ? Schema.String.check(...(checks as [(typeof checks)[number]]))
        : Schema.String,
      SchemaTransformation.trim(),
    ),
  );
}

/** Zod's `z.number().int()` with optional `.min`/`.gt`/`.max`: a safe integer,
 * and JSON Schema bounds that default to the safe range as Zod emits them.
 * Pass `minimum` or `exclusiveMinimum`, not both. */
export function Int(
  bounds: {
    minimum?: number;
    exclusiveMinimum?: number;
    maximum?: number;
  } = {},
) {
  const { minimum, exclusiveMinimum, maximum } = bounds;
  return Schema.Int.check(
    Schema.makeFilter<number>(
      (value) =>
        (minimum === undefined || value >= minimum) &&
        (exclusiveMinimum === undefined || value > exclusiveMinimum) &&
        (maximum === undefined || value <= maximum),
      {
        expected: "an integer within bounds",
        toJsonSchema: () => ({
          ...(exclusiveMinimum === undefined
            ? { minimum: minimum ?? Number.MIN_SAFE_INTEGER }
            : { exclusiveMinimum }),
          maximum: maximum ?? Number.MAX_SAFE_INTEGER,
        }),
      },
    ),
  );
}

/** Zod's `.default(value)` on an object key: optional in input, `default` in
 * JSON Schema. Unlike Zod, an explicit `undefined` is rejected; JSON has none.
 * The same holds for `Schema.optionalKey` versus Zod's `.optional()`: the
 * undefined-accepting `Schema.optional`/`withDecodingDefault` cannot produce
 * Zod's JSON Schema (they add `null`), so model-facing schemas use the key forms. */
export const withDefault =
  <S extends Schema.Top>(value: S["Encoded"]) =>
  (self: S) =>
    Schema.withDecodingDefaultKey<S>(Effect.succeed(value))(
      self.annotate({ default: value }) as S,
    );

/** Strict decoding, like `z.strictObject(...).parse`: excess keys fail. Throws
 * a `SchemaError` on invalid input. Strictness applies at every nesting level,
 * whereas Zod's is per object: a non-strict `z.object` nested in a strict one
 * needs `Schema.StructWithRest` or similar to keep stripping. */
export const decodeStrict = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
) => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" });

/** Draft 2020-12 JSON Schema in the shape `z.toJSONSchema` produces for the
 * schema's input, with `additionalProperties: false` on strict objects. */
export function toJsonSchema(
  schema: Schema.Constraint,
): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(schema, {
    onExcessProperty: "error",
  });
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...(emptyProperties(document.schema) as object),
    ...(Object.keys(document.definitions).length
      ? { $defs: emptyProperties(document.definitions) }
      : {}),
  };
}

/** Zod's order for the keys it emits next to `const`. */
const keyOrder = (key: string) =>
  ["default", "type", "const"].indexOf(key) + 1 || 99;

/** Keywords whose values are data, not subschemas. */
const VALUE_KEYWORDS = new Set(["default", "examples", "const", "enum"]);

/** Zod lists `properties: {}` on an object with no keys; some function-calling
 * clients require `properties` on every object schema. */
function emptyProperties(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(emptyProperties);
  if (!node || typeof node !== "object") return node;
  const entries = Object.entries(node).map(([key, value]) => [
    key,
    VALUE_KEYWORDS.has(key) ? value : emptyProperties(value),
  ]);
  const result = Object.fromEntries(entries) as Record<string, unknown>;
  // Zod emits `const` for a literal; Effect emits a one-value `enum`.
  if (Array.isArray(result.enum) && result.enum.length === 1) {
    const {
      enum: [value],
      ...rest
    } = result as { enum: unknown[] };
    return Object.fromEntries(
      Object.entries({ ...rest, const: value }).sort(
        ([a], [b]) => keyOrder(a) - keyOrder(b),
      ),
    );
  }
  return result.type === "object" &&
    result.additionalProperties === false &&
    !("properties" in result) &&
    !("patternProperties" in result)
    ? { type: "object", properties: {}, ...result }
    : result;
}
