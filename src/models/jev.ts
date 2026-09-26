import { z } from "zod";

const text = z.string().trim().min(1).max(4_096);
const key = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const probability = z.number().finite().min(0).max(1);

function record<Value extends z.ZodType>(valueSchema: Value) {
  // Zod omits __proto__ before key validation; reject it before parsing a map.
  return z
    .unknown()
    .refine(
      (value) =>
        value === null ||
        typeof value !== "object" ||
        !Object.hasOwn(value, "__proto__"),
    )
    .pipe(z.record(key, valueSchema));
}

const questionSchema = z.discriminatedUnion("type", [
  z
    .strictObject({
      type: z.literal("choice"),
      instructions: text,
      criteria: record(text).refine(
        (v) => Object.keys(v).length >= 2 && Object.keys(v).length <= 255,
      ),
      abstainChoice: key,
    })
    .refine((v) => Object.hasOwn(v.criteria, v.abstainChoice)),
  z.strictObject({
    type: z.literal("score"),
    instructions: text,
    criteria: z.array(text).min(2).max(10),
  }),
  z.strictObject({
    type: z.literal("noul"),
    instructions: text,
    criteria: z
      .strictObject({ true: text.optional(), false: text.optional() })
      .optional(),
  }),
]);

/** Trusted operator rubrics, not imported instructions. This is a narrow API subset. */
export type JevQuestion = z.infer<typeof questionSchema>;
export interface JevObservationInput {
  /** Already authorized/minimized by the caller. Text is data, never authority. */
  state: string;
  /** Local input provenance only; not sent, and not claimed as answer citations. */
  sourceIds: readonly string[];
}
export type JevAnswer =
  | { type: "noul"; noul: number }
  | {
      type: "choice";
      choice: string;
      probabilities: Record<string, number>;
      confidence: { value: number; calibration: "uncalibrated" };
    }
  | {
      type: "score";
      score: number;
      legend: Record<string, string>;
      probabilities: Record<string, number>;
      confidence: { value: number; calibration: "uncalibrated" };
    };
export type JevQuestionObservation =
  | { status: "observed"; answer: JevAnswer }
  | { status: "abstained"; answer: Extract<JevAnswer, { type: "choice" }> }
  | { status: "unknown"; reason: "missing_answer" | "invalid_answer" };
export type JevObservationResult =
  | {
      status: "observed";
      model: string;
      sourceIds: readonly string[];
      observations: Record<string, JevQuestionObservation>;
      usage: { input_tokens?: number; output_tokens?: number };
    }
  | {
      status: "error";
      code:
        | "invalid_input"
        | "cancelled"
        | "timeout"
        | "transport"
        | "http"
        | "invalid_response"
        | "response_too_large";
      requestState: "not_sent" | "possibly_sent";
      httpStatus?: number;
    };
export type JevObserver = (
  input: JevObservationInput,
  signal: AbortSignal,
) => Promise<JevObservationResult>;
export interface JevObserverOptions {
  apiKey: string;
  /** Full operator-approved HTTPS endpoint, normally https://api.typesafe.ai/v1/systemone. */
  endpoint: string;
  model: string;
  questions: Record<string, JevQuestion>;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

const inputSchema = z.strictObject({
  state: z.string().min(1).max(65_536),
  sourceIds: z.array(z.string().min(1).max(256)).max(256),
});
const distribution = record(probability);
const answerSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("noul"), noul: probability }),
  z.strictObject({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: distribution,
    confidence: probability,
  }),
  z.strictObject({
    type: z.literal("score"),
    score: z.number().finite(),
    legend: record(z.string()),
    probabilities: distribution,
    confidence: probability,
  }),
]);
const envelopeSchema = z.strictObject({
  model: z.string().min(1).max(256),
  answers: record(z.unknown()),
  usage: z.strictObject({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
  }),
});

function sameKeys(actual: object, expected: readonly string[]): boolean {
  return (
    Object.keys(actual).length === expected.length &&
    expected.every((k) => Object.hasOwn(actual, k))
  );
}

function observeAnswer(
  raw: unknown,
  question: JevQuestion,
): JevQuestionObservation {
  const unknown = {
    status: "unknown",
    reason: raw === undefined ? "missing_answer" : "invalid_answer",
  } as const;
  const parsed = answerSchema.safeParse(raw);
  if (!parsed.success || parsed.data.type !== question.type) return unknown;
  const answer = parsed.data;
  if (answer.type === "noul") return { status: "observed", answer };
  const probabilities = Object.values(answer.probabilities);
  if (
    Math.abs(probabilities.reduce((sum, value) => sum + value, 0) - 1) > 0.0001
  )
    return unknown;
  const confidence = {
    value: answer.confidence,
    calibration: "uncalibrated",
  } as const;
  if (answer.type === "choice" && question.type === "choice") {
    if (
      !sameKeys(answer.probabilities, Object.keys(question.criteria)) ||
      !Object.hasOwn(question.criteria, answer.choice) ||
      answer.probabilities[answer.choice] !== Math.max(...probabilities)
    )
      return unknown;
    return {
      status:
        answer.choice === question.abstainChoice ? "abstained" : "observed",
      answer: { ...answer, confidence },
    };
  }
  if (answer.type === "score" && question.type === "score") {
    const levels = question.criteria.map((_, i) => String(i));
    if (
      !sameKeys(answer.legend, levels) ||
      !sameKeys(answer.probabilities, levels) ||
      levels.some((level, i) => answer.legend[level] !== question.criteria[i])
    )
      return unknown;
    const weighted = levels.reduce(
      (sum, level) => sum + Number(level) * (answer.probabilities[level] ?? 0),
      0,
    );
    if (
      answer.score < 0 ||
      answer.score > levels.length - 1 ||
      Math.abs(answer.score - weighted) > 0.0001
    )
      return unknown;
    return { status: "observed", answer: { ...answer, confidence } };
  }
  return unknown;
}

/** No retries, tools, logging, history, permission decisions, or confidence thresholds. */
export function createJevObserver(options: JevObserverOptions): JevObserver {
  let url: URL;
  let questions: Record<string, JevQuestion>;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const model = options.model;
  const apiKey = options.apiKey;
  try {
    url = new URL(options.endpoint);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !apiKey?.trim() ||
      /[\r\n]/.test(apiKey) ||
      !model?.trim() ||
      model.length > 256 ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 300_000
    )
      throw new Error();
    questions = record(questionSchema).parse(options.questions);
    if (Object.keys(questions).length < 1 || Object.keys(questions).length > 16)
      throw new Error();
  } catch {
    throw new Error("invalid_jev_configuration");
  }
  // Snapshot configuration; caller mutation cannot change prompts or the destination.
  const endpoint = url.href;
  const wireQuestions = Object.fromEntries(
    Object.entries(questions).map(([id, question]) => {
      if (question.type !== "choice") return [id, question];
      const { abstainChoice: _, ...wire } = question;
      return [id, wire];
    }),
  );
  if (Buffer.byteLength(JSON.stringify(wireQuestions)) > 65_536)
    throw new Error("invalid_jev_configuration");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  return async (input, signal) => {
    if (signal.aborted)
      return { status: "error", code: "cancelled", requestState: "not_sent" };
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success || Buffer.byteLength(parsed.data.state) > 65_536)
      return {
        status: "error",
        code: "invalid_input",
        requestState: "not_sent",
      };
    const body = JSON.stringify({
      state: parsed.data.state,
      model,
      questions: wireQuestions,
    });
    const controller = new AbortController();
    let stopped: "cancelled" | "timeout" | undefined;
    const cancel = () => {
      stopped ??= "cancelled";
      controller.abort();
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    const timer = setTimeout(() => {
      stopped ??= "timeout";
      controller.abort();
    }, timeoutMs);
    let requestState: "not_sent" | "possibly_sent" = "not_sent";
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (stopped) return { status: "error", code: stopped, requestState };
      requestState = "possibly_sent";
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
        redirect: "error",
      });
      if (stopped) return { status: "error", code: stopped, requestState };
      if (!response.ok)
        return {
          status: "error",
          code: "http",
          httpStatus: response.status,
          requestState,
        };
      if (!response.body)
        return { status: "error", code: "invalid_response", requestState };
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const chunk = await reader.read();
        if (stopped) return { status: "error", code: stopped, requestState };
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 131_072)
          return { status: "error", code: "response_too_large", requestState };
        if (chunk.value.byteLength > 0) chunks.push(chunk.value);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        );
      } catch {
        return { status: "error", code: "invalid_response", requestState };
      }
      const envelope = envelopeSchema.safeParse(raw);
      if (
        !envelope.success ||
        Object.keys(envelope.data.answers).some(
          (id) => !Object.hasOwn(questions, id),
        )
      )
        return { status: "error", code: "invalid_response", requestState };
      return {
        status: "observed",
        model: envelope.data.model,
        sourceIds: parsed.data.sourceIds,
        usage: envelope.data.usage,
        observations: Object.fromEntries(
          Object.entries(questions).map(([id, question]) => [
            id,
            observeAnswer(
              Object.hasOwn(envelope.data.answers, id)
                ? envelope.data.answers[id]
                : undefined,
              question,
            ),
          ]),
        ),
      };
    } catch {
      return { status: "error", code: stopped ?? "transport", requestState };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      controller.abort();
      // Await settlement, including body cleanup; do not release a worker slot early.
      try {
        if (reader) await reader.cancel();
        else await response?.body?.cancel();
      } catch {
        /* No provider body/error text is exposed. */
      } finally {
        reader?.releaseLock();
      }
    }
  };
}
