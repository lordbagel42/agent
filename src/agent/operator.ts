import { z } from "zod";

/** Closed host-owned catalog. Never use caller input as a URL or HTTP method. */
const operations = {
  conversation: ["GET", "/operator/conversation"],
  slack_ingress: ["GET", "/operator/ingress/slack"],
  latency: ["GET", "/operator/latency"],
  logs: ["GET", "/operator/logs"],
  telemetry: ["POST", "/operator/telemetry/query"],
  wakeups: ["GET", "/operator/wakeups"],
  deployment_events: ["GET", "/operator/deployment/events"],
  console_login_link: ["POST", "/operator/console/login-links"],
  agents: ["GET", "/operator/agents"],
  revoke_agent: ["POST", "/operator/agents/:id/revoke"],
  reconcile_browser: ["POST", "/operator/browser/:id/reconcile"],
  capabilities: ["GET", "/operator/capabilities/status"],
  capability_audit: ["GET", "/operator/capabilities/audit"],
  propose_capability: ["POST", "/operator/capabilities/proposals"],
  grant_capability: ["POST", "/operator/capabilities/grants"],
  revoke_capability: ["POST", "/operator/capabilities/grants/:id/revoke"],
  cancel_capability: ["POST", "/operator/capabilities/grants/:id/cancel"],
  reconcile_capability: ["POST", "/operator/capabilities/grants/:id/reconcile"],
  execute_capability: ["POST", "/operator/capabilities/grants/:id/execute"],
  capability_receipt: ["GET", "/operator/capabilities/grants/:id/receipt"],
  capability_link: ["POST", "/operator/capabilities/links"],
  revoke_capability_link: ["POST", "/operator/capabilities/links/:id/revoke"],
  job: ["GET", "/operator/jobs/:id"],
  job_diff: ["GET", "/operator/jobs/:id/diff"],
  resume_job: ["POST", "/operator/jobs/:id/resume"],
  cancel_job: ["POST", "/operator/jobs/:id/cancel"],
  memory: ["GET", "/operator/memory"],
  memory_tombstones: ["GET", "/operator/memory/tombstones"],
  memory_backup_status: ["GET", "/operator/memory/backup"],
  backup_memory: ["POST", "/operator/memory/backup"],
  validate_memory_restore: ["POST", "/operator/memory/restore/validate"],
  review_memory: ["POST", "/operator/memory/proposals/:id/review"],
  forget_memory: ["POST", "/operator/memory/forget"],
  revise_personality: ["POST", "/operator/memory/personality/revise"],
  rollback_personality: ["POST", "/operator/memory/personality/rollback"],
  imports: ["GET", "/operator/imports"],
  start_import: ["POST", "/operator/imports/:id/start"],
  cancel_import: ["POST", "/operator/imports/:id/cancel"],
  import_extraction: ["GET", "/operator/imports/:id/extraction"],
  start_import_extraction: ["POST", "/operator/imports/:id/extraction/start"],
  cancel_import_extraction: ["POST", "/operator/imports/:id/extraction/cancel"],
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
  after: z.number().int().nonnegative().safe().optional(),
  watermark: z.number().int().nonnegative().safe().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
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
    if (
      parsed.after !== undefined &&
      !["deployment_events", "capability_audit", "memory_tombstones"].includes(
        parsed.operation,
      )
    )
      throw new Error("cursor_not_supported");
    if (
      (parsed.watermark !== undefined || parsed.limit !== undefined) &&
      parsed.operation !== "memory_tombstones"
    )
      throw new Error("pagination_not_supported");
    const url = new URL(
      template.replace(":id", encodeURIComponent(parsed.id ?? "")),
      "http://june.internal",
    );
    if (parsed.query !== undefined) url.searchParams.set("query", parsed.query);
    for (const key of ["after", "watermark", "limit"] as const)
      if (parsed[key] !== undefined)
        url.searchParams.set(key, String(parsed[key]));
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
