import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type { MessageEvent, OutboundMessage } from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { EvidenceStore } from "../memory/store.js";
import { parseReply } from "../models/provider.js";
import { createInspectionReader } from "./inspection.js";
import { createJuneRegistry } from "./registry.js";

it("only the original exact owner-private command creates a backup; June inspection and replay do not", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "june-backup-command-"));
  const store = new EvidenceStore(
    join(directory, "evidence.sqlite"),
    randomBytes(32),
  );
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const audience = JSON.stringify(["private", owner.id]);
  const sent: OutboundMessage[] = [];
  let modelCalls = 0;
  const registry = createJuneRegistry({
    owner,
    memory: { store, source: () => undefined },
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: true, threads: true },
        async receive() {
          return { response: new Response(), events: [] };
        },
        async send(message) {
          sent.push(message);
          return { status: "sent", messageId: `out-${sent.length}` };
        },
      },
    },
    model: {
      async reply(request) {
        modelCalls++;
        if (request.inspectionAvailable) {
          expect(request.system).toContain('inspection to "backup"');
          expect(request.system).toContain("!memory-backup");
          return parseReply('{"text":"","inspection":"backup"}', [], request);
        }
        // A misbehaving model still cannot expose private backup metadata.
        return { text: "", inspection: "backup" };
      },
    },
    inspection: createInspectionReader({
      audience,
      memory: { store },
      selections: {},
    }),
  });
  const { client } = await setupTest(t, registry);
  t.onTestFinished(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let sequence = 0;
  const deliver = async (patch: Partial<MessageEvent> = {}) => {
    const event: MessageEvent = {
      id: `event-${sequence++}`,
      messageId: `message-${sequence}`,
      type: "message",
      occurredAt: Date.now(),
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      direct: true,
      senderId: "U1",
      text: "!memory-backup",
      metadata: { channelType: "im" },
      memoryBackupEligible: true,
      ...patch,
    };
    const scope = routeEvent(event, owner, true);
    if (!scope) throw new Error("Missing test scope");
    const actor = client.conversation.getOrCreate(scope.key);
    const before = Object.values((await actor.snapshot()).events).filter(
      (e) => e.done,
    ).length;
    await actor.send("inbox", { type: "event", event });
    await expect
      .poll(
        async () =>
          Object.values((await actor.snapshot()).events).filter((e) => e.done)
            .length,
        { timeout: 10000 },
      )
      .toBe(before + 1);
    return { event, actor };
  };
  const root = join(directory, "backups");
  await deliver({ text: 'Please quote "!memory-backup"' });
  await deliver({ text: " !memory-backup" });
  await deliver({ text: "!memory-backup\n" });
  await deliver({ memoryBackupEligible: undefined });
  await deliver({ memoryBackupEligible: false });
  expect(existsSync(root)).toBe(false);
  const beforeUntrusted = sent.length;
  await deliver({
    direct: false,
    address: { channel: "slack", accountId: "T1", conversationId: "C1" },
  });
  await deliver({ senderId: "guest", metadata: { channelType: "im" } });
  expect(existsSync(root)).toBe(false);
  expect(JSON.stringify(sent.slice(beforeUntrusted))).not.toContain(
    "tombstoneWatermark",
  );
  const { event, actor } = await deliver();
  expect(modelCalls).toBe(7);
  expect(store.backupStatus().latest?.tombstoneWatermark).toBe(0);
  const files = readdirSync(root);
  await actor.send("inbox", { type: "event", event });
  await deliver({ text: "Inspect my backup" }); // A later turn drains the duplicate first.
  expect(modelCalls).toBe(8);
  expect(readdirSync(root)).toEqual(files);
  const reports = JSON.stringify(sent);
  expect(reports).toContain("Local encrypted evidence-ledger backup confirmed");
  expect(reports).toContain("This inspection created no backup");
  expect(reports).not.toContain(directory);
  expect(reports).not.toContain("payload");
});
