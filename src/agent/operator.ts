import { z } from "zod";

/** Closed host-owned catalog. Never use caller input as a URL or HTTP method. */
const operations = {
  conversation: ["GET", "/operator/conversation"],
  slack_ingress: ["GET", "/operator/ingress/slack"],
  job: ["GET", "/operator/jobs/:id"],
  resume_job: ["POST", "/operator/jobs/:id/resume"],
  cancel_job: ["POST", "/operator/jobs/:id/cancel"],
  memory: ["GET", "/operator/memory"],
  review_memory: ["POST", "/operator/memory/proposals/:id/review"],
  forget_memory: ["POST", "/operator/memory/forget"],
  revise_personality: ["POST", "/operator/memory/personality/revise"],
  rollback_personality: ["POST", "/operator/memory/personality/rollback"],
  imports: ["GET", "/operator/imports"],
  start_import: ["POST", "/operator/imports/:id/start"],
  cancel_import: ["POST", "/operator/imports/:id/cancel"],
  reflection: ["GET", "/operator/reflection"],
  enqueue_reflection: ["POST", "/operator/reflection/enqueue"],
  cancel_reflection: ["POST", "/operator/reflection/cancel"],
  reflection_candidate: ["POST", "/operator/reflection/candidate"],
  reconcile_reflection: ["POST", "/operator/reflection/reconcile"],
} as const;

export const operatorSchema = z.strictObject({
  operation: z.enum(
    Object.keys(operations) as [
      keyof typeof operations,
      ...Array<keyof typeof operations>,
    ],
  ),
  id: z
    .string()
    .regex(/^[a-zA-Z0-9_:-]{1,2048}$/)
    .optional(),
  idempotencyKey: z.uuid().optional(),
  query: z.string().max(2000).optional(),
  body: z.record(z.string(), z.unknown()).optional(),
});

export function operatorRequest(
  dispatch: (request: Request) => Response | Promise<Response>,
  operatorToken: string,
) {
  return async (input: z.infer<typeof operatorSchema>) => {
    const parsed = operatorSchema.parse(input);
    const [method, template] = operations[parsed.operation];
    if (template.includes(":id") !== (parsed.id !== undefined))
      throw new Error("operation_id_required_or_unused");
    if (method === "GET" && parsed.body !== undefined)
      throw new Error("read_has_no_body");
    if (parsed.query !== undefined && parsed.operation !== "memory")
      throw new Error("query_not_supported");
    const url = new URL(
      template.replace(":id", encodeURIComponent(parsed.id ?? "")),
      "http://june.internal",
    );
    if (parsed.query !== undefined) url.searchParams.set("query", parsed.query);
    const response = await dispatch(
      new Request(url, {
        method,
        headers: {
          authorization: `Bearer ${operatorToken}`,
          "content-type": "application/json",
          ...(parsed.idempotencyKey
            ? { "idempotency-key": parsed.idempotencyKey }
            : {}),
        },
        ...(method === "POST"
          ? { body: JSON.stringify(parsed.body ?? {}) }
          : {}),
      }),
    );
    if (response.status === 404)
      return { status: 404, error: "unavailable_or_not_found" };
    // Responses are from our own bounded handlers, never arbitrary remote hosts.
    const body = await response.text();
    if (Buffer.byteLength(body) > 512 * 1024)
      return { status: 413, error: "result_too_large_use_message_pagination" };
    return { status: response.status, result: JSON.parse(body) as unknown };
  };
}
