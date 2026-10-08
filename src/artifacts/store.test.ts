import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { MessageEvent } from "../core/contracts.js";
import { redactBrowserPin } from "../core/private-input.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import {
  type CapabilityPorts,
  runCapability,
} from "../runtime/capabilities.js";
import { safeToolReadResult } from "../tools/mcp.js";
import type { ArtifactContext } from "./contracts.js";
import { ArtifactRenderer } from "./render.js";
import { createArtifactRoutes } from "./routes.js";
import { ArtifactService } from "./service.js";
import { slackArtifactSecret } from "./slack-secret.js";
import { ArtifactStore } from "./store.js";

const folders: string[] = [];
const stores: ArtifactStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});
const context = (
  senderId: string,
  operationId: string,
  accountId = "team",
): ArtifactContext => ({
  operationId,
  isCurrent: () => true,
  event: {
    id: operationId,
    type: "message",
    messageId: "1",
    occurredAt: Date.now(),
    senderId,
    direct: true,
    text: "create an artifact",
    address: { channel: "slack", accountId, conversationId: "dm" },
  },
});
const create = {
  action: "create",
  id: null,
  title: "Private plan",
  kind: "html",
  visibility: "private",
  content: "<p>private</p>",
  runId: null,
};
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), "june-artifact-"));
  folders.push(folder);
  const options = {
    file: join(folder, "store.db"),
    owner: {
      id: "owner",
      identities: [
        { channel: "slack" as const, accountId: "team", senderId: "owner" },
      ],
    },
    encryptionKey: "a".repeat(32),
    pepper: "b".repeat(32),
  };
  const store = new ArtifactStore(options);
  stores.push(store);
  return { store, options };
}
it("binds management to creator/account or owner, preserves replay, and revokes sessions on rotation", () => {
  const { store, options } = fixture();
  const record = store.mutate(create, context("creator", "create"), 0);
  expect(store.mutate(create, context("creator", "create"), 0).id).toBe(
    record.id,
  );
  const delivery = store.beginSecret(record.id, 1);
  expect(delivery?.pin).toMatch(/^\d{8}$/);
  const token = store.unlock(record.id, delivery?.pin ?? "", "client");
  expect(store.authorized(record.id, token)).toBe(true);
  const rotation = {
    ...create,
    action: "change_pin",
    id: record.id,
    title: null,
    kind: null,
    visibility: null,
    content: null,
  };
  expect(() => store.mutate(rotation, context("other", "bad"), 0)).toThrow(
    "artifact_denied",
  );
  expect(() =>
    store.mutate(rotation, context("creator", "cross-account", "elsewhere"), 0),
  ).toThrow("artifact_denied");
  const changed = store.mutate(
    rotation,
    context("owner", "rotate"),
    0,
    "00192384",
  );
  expect(changed.generation).toBe(2);
  expect(store.authorized(record.id, token)).toBe(false);
  expect(store.beginSecret(record.id, 2)).toEqual({
    creator: record.creator,
    pin: "00192384",
  });
  expect(
    store.mutate(rotation, context("owner", "rotate"), 0, "00192384")
      .generation,
  ).toBe(2);
  expect(store.beginSecret(record.id, 2)).toBeUndefined();
  expect(readFileSync(options.file).includes(Buffer.from("00192384"))).toBe(
    false,
  );
  expect(JSON.stringify(changed)).not.toContain("00192384");
  expect(() =>
    store.mutate(rotation, context("owner", "rotate"), 0, "11223344"),
  ).toThrow("artifact_operation_conflict");
});
it("does not resend an interrupted secret and persists failed-attempt throttles", () => {
  const { store, options } = fixture();
  const record = store.mutate(create, context("creator", "create"), 0);
  const secret = store.beginSecret(record.id, 1);
  for (let n = 0; n < 10; n++)
    expect(store.unlock(record.id, "invalid", "client")).toBeUndefined();
  store.close();
  stores.splice(stores.indexOf(store), 1);
  const reopened = new ArtifactStore(options);
  stores.push(reopened);
  expect(reopened.get(record.id)?.pinDelivery).toBe("unknown");
  expect(reopened.beginSecret(record.id, 1)).toBeUndefined();
  expect(
    reopened.unlock(record.id, secret?.pin ?? "", "client"),
  ).toBeUndefined();
  const other = reopened.unlock(record.id, secret?.pin ?? "", "another-client");
  expect(reopened.authorized(record.id, other)).toBe(true);
});
it("exposes the action to June without exposing PINs, binds the DM, and protects all private content routes", async () => {
  const { store, options } = fixture();
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const sendSecret = slackArtifactSecret("team", "fixture-token", (async (
    url,
    init,
  ) => {
    const method = String(url).split("/").pop() as string;
    calls.push({ method, body: JSON.parse(String(init?.body)) });
    return Response.json(
      method === "conversations.open"
        ? { ok: true, channel: { id: "DFIXTURE" } }
        : { ok: true, ts: "1.2" },
    );
  }) as typeof fetch);
  const service = new ArtifactService({
    store,
    owner: options.owner,
    origin: "https://artifacts.example.org",
    deletionRevision: () => 0,
    workflow: async () => undefined,
    sendSecret,
  });
  const capabilities = {
    artifactsAvailable: true,
    agentRole: "interaction" as const,
  };
  expect(replyJsonSchema([], capabilities).properties).toHaveProperty(
    "artifact",
  );
  const reply = parseReply(
    JSON.stringify({ text: "", artifact: create }),
    [],
    capabilities,
  );
  const requestContext = context("creator", "create");
  const result = await runCapability(
    reply,
    { ...capabilities, system: "", messages: [], workspaces: [] },
    {
      ...requestContext,
      scope: { key: ["guest"], private: false },
      audience: "guest",
      eventId: "create",
      origin: "event",
      phase: "reply",
      ownerTurn: false,
      deletionRevision: 0,
      personalityVersion: undefined,
      workspaces: [],
      signal: new AbortController().signal,
      valid: () => true,
      model: { reply: async () => ({ text: "" }) },
      deps: { owner: options.owner, artifacts: service },
      ports: {} as CapabilityPorts,
    },
  );
  expect(result.artifactPresentation).toBeDefined();
  const id = result.artifactPresentation?.id as string;
  const pin = /Access PIN: (\d{8})/.exec(String(calls[1]?.body.text))?.[1];
  expect(pin).toMatch(/^\d{8}$/);
  expect(calls[0]).toEqual({
    method: "conversations.open",
    body: { users: "creator" },
  });
  expect(calls[1]?.body.channel).toBe("DFIXTURE");
  expect(JSON.stringify(result)).not.toContain(pin);
  const notification = String(calls[1]?.body.text);
  expect(redactBrowserPin(notification)).not.toContain(pin);
  const encoded = JSON.stringify({ text: notification })
    .replaceAll("June", "\\u004aune")
    .replaceAll("Access", "\\u0041ccess");
  expect(
    safeToolReadResult({ content: [{ text: encoded }] }, "fixture-token").text,
  ).not.toContain(pin);
  await service.request(reply.artifact, context("creator", "create"));
  expect(calls).toHaveLength(2);
  const renderer = new ArtifactRenderer("unused");
  const seen: boolean[] = [];
  renderer.render = async (_record, _workflow, locked) => {
    seen.push(!!locked);
    return Buffer.from("fake PNG");
  };
  const app = createArtifactRoutes(service, renderer);
  for (const path of ["data", "document", "events"])
    expect((await app.request(`/artifacts/${id}/${path}`)).status).toBe(401);
  await app.request(`/artifacts/${id}/preview.png`);
  expect(seen).toEqual([true]);
  const unlocked = await app.request(`/artifacts/${id}/unlock`, {
    method: "POST",
    headers: {
      origin: service.options.origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: `pin=${pin}`,
  });
  expect(unlocked.status).toBe(303);
  const cookie = unlocked.headers.get("set-cookie")?.split(";")[0] as string;
  expect(
    (await app.request(`/artifacts/${id}/document`, { headers: { cookie } }))
      .status,
  ).toBe(200);
  expect(
    (
      await app.request(`/artifacts/${id}/unlock`, {
        method: "POST",
        headers: {
          origin: "https://attacker.example",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: `pin=${pin}`,
      })
    ).status,
  ).toBe(403);
  const command = `!artifact-pin ${id} 00817263`;
  const other = {
    ...context("other", "bad-rotation").event,
    artifactPinEligible: true,
    text: command,
  };
  expect((await service.consumePin(other)).text).not.toContain("00817263");
  expect(store.get(id)?.generation).toBe(1);
  const owner = {
    ...context("owner", "rotation").event,
    artifactPinEligible: true,
    text: command,
  };
  expect((await service.consumePin(owner)).text).not.toContain("00817263");
  expect(calls[2]?.body.users).toBe("creator");
  expect(store.get(id)?.generation).toBe(2);
  expect(
    (await app.request(`/artifacts/${id}/data`, { headers: { cookie } }))
      .status,
  ).toBe(401);
  await service.consumePin(owner);
  expect(calls).toHaveLength(4);
});

it("authorizes workflow creation with its original event while retaining private viewer and PIN controls", async () => {
  const { store, options } = fixture();
  const requestContext = context("creator", "workflow");
  requestContext.event.direct = false;
  requestContext.event.botMentioned = true;
  requestContext.event.metadata = { channelType: "channel" };
  requestContext.event.address.conversationId = "channel";
  requestContext.event.address.threadId = "thread";
  const runId = "c".repeat(64);
  const view = {
    runId,
    name: "shared-status",
    revision: "revision",
    status: "completed",
    operations: [{ name: "step:one", status: "completed" }],
  };
  const authorizations: (MessageEvent | undefined)[] = [];
  let revoked = false;
  let deletionRevision = 0;
  let sends = 0;
  let pin = "";
  const service = new ArtifactService({
    store,
    owner: options.owner,
    origin: "https://artifacts.example.org",
    deletionRevision: () => deletionRevision,
    async workflow(id, event?: MessageEvent) {
      authorizations.push(event);
      if (id !== runId || (event && event !== requestContext.event))
        return undefined;
      return { ...view, status: revoked ? "revoked" : view.status };
    },
    async sendSecret(identity, _id, text) {
      expect(identity).toEqual({
        channel: "slack",
        accountId: "team",
        senderId: "creator",
      });
      sends++;
      pin = /Access PIN: (\d{8})/.exec(text)?.[1] ?? "";
      return { status: "unknown", code: "timeout" };
    },
  });
  const command = { ...create, kind: "workflow", content: null, runId };
  const result = await service.request(command, requestContext);
  expect(authorizations).toEqual([requestContext.event]);
  expect(result.text).toContain("PIN delivery to the creator: unknown");
  expect(result.text).not.toContain(pin);
  await service.request(command, requestContext);
  expect(sends).toBe(1);
  await expect(
    service.request(command, context("owner", "wrong-origin")),
  ).rejects.toThrow("artifact_workflow_denied");
  expect(store.db.prepare("SELECT id FROM artifacts").all()).toHaveLength(1);

  const id = result.presentation.id;
  const app = createArtifactRoutes(service, new ArtifactRenderer("unused"));
  expect((await app.request(`/artifacts/${id}/data`)).status).toBe(401);
  const token = store.unlock(id, pin, "viewer");
  const headers = { cookie: `june_artifact=${token}` };
  const data = await app.request(`/artifacts/${id}/data`, { headers });
  expect(data.status).toBe(200);
  expect((await data.json()).workflow).toEqual(view);
  expect(authorizations.at(-1)).toBeUndefined();
  revoked = true;
  expect((await app.request(`/artifacts/${id}/data`, { headers })).status).toBe(
    410,
  );
  await expect(service.request(command, requestContext)).rejects.toThrow(
    "artifact_workflow_denied",
  );
  revoked = false;
  deletionRevision++;
  expect((await app.request(`/artifacts/${id}/data`, { headers })).status).toBe(
    410,
  );
  expect(sends).toBe(1);
});
