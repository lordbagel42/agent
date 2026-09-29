import { z } from "zod";
import type { AgentService } from "./service.js";

export const agentWebhookSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({
    action: z.literal("send"),
    id: z.uuid(),
    text: z.string().min(1).max(32000),
  }),
  z.strictObject({ action: z.literal("delivery"), id: z.uuid() }),
  z.strictObject({ action: z.literal("revoke"), id: z.uuid() }),
]);

export function agentWebhookAction(
  service: AgentService,
  input: unknown,
  operationId: string,
  initiatingClient?: string,
) {
  const action = agentWebhookSchema.parse(input);
  if (action.action === "list") return service.targets("message");
  if (action.action === "delivery")
    return service.webhooks.delivery(action.id) ?? null;
  if (action.action === "revoke")
    return service.webhooks.revoke(action.id) ?? null;
  const target = service.targets("message").find(({ id }) => id === action.id);
  if (!target) throw new Error("webhook_unavailable");
  return service.webhooks.enqueue(initiatingClient ?? target.clientId, {
    idempotencyKey: `june:${operationId}`,
    webhookId: target.id,
    type: "message",
    payload: { text: action.text },
  });
}
