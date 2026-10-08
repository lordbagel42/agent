import { expect, it, vi } from "vitest";
import type { MessageEvent } from "../core/contracts.js";
import type { CuratedPersonalityStore } from "../memory/curated.js";
import { createPersonalityActor } from "./personality.js";

// Exercise the real command with a controllable persistence boundary.
vi.mock("rivetkit", () => ({ actor: (definition: unknown) => definition }));

it("authorizes rejection, preserves terminal decisions and re-persists failed-save retries without changing the profile", async () => {
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const proposalId = `personality:${"a".repeat(64)}`;
  const acceptedId = `personality:${"b".repeat(64)}`;
  const lookup = vi.fn((scope: string): { id: string } | undefined =>
    scope === JSON.stringify(["private", owner.id])
      ? { id: proposalId }
      : undefined,
  );
  type State = {
    revisions: unknown[];
    proposalDecisions?: Record<
      string,
      { status: "rejected" } | { status: "accepted"; revision: number }
    >;
  };
  type Context = {
    key: string[];
    state: State;
    saveState: (options: { immediate: boolean }) => Promise<void>;
  };
  const definition = createPersonalityActor(owner, {
    pendingGlobalProposal: lookup,
  } as unknown as CuratedPersonalityStore) as unknown as {
    state: State;
    actions: { command: (c: Context, event: MessageEvent) => Promise<string> };
  };
  const event: MessageEvent = {
    type: "message",
    id: "reject",
    messageId: "1.001",
    occurredAt: Date.now(),
    address: { channel: "slack", accountId: "T1", conversationId: "D1" },
    senderId: "U1",
    direct: true,
    metadata: { channelType: "im" },
    personalityCommandEligible: true,
    text: `!personality reject ${JSON.stringify({ proposalId })}`,
  };
  let persisted = structuredClone(definition.state);
  let failSave = false;
  const c: Context = {
    key: [owner.id],
    state: structuredClone(definition.state),
    saveState: vi.fn(async (options) => {
      expect(options).toEqual({ immediate: true });
      if (failSave) throw new Error("save failed");
      persisted = structuredClone(c.state);
    }),
  };
  const command = (extra: Partial<MessageEvent> = {}) =>
    definition.actions.command(c, { ...event, ...extra });
  await command({
    id: "publish",
    text: '!personality revise {"expectedVersion":0,"changes":{"humor":"none"},"explanation":"private fixture","publish":true}',
  });
  const revisions = structuredClone(c.state.revisions);
  c.state.proposalDecisions = {
    [acceptedId]: { status: "accepted", revision: 1 },
  };
  for (const extra of [
    { senderId: "U2" },
    { address: { ...event.address, accountId: "T2" } },
    { direct: false, metadata: { channelType: "channel" as const } },
    { personalityCommandEligible: undefined },
  ]) {
    expect(await command(extra)).not.toContain("Rejected personality");
  }
  lookup.mockClear();
  expect(
    await command({ text: '!personality reject {"proposalId":"__proto__"}' }),
  ).toContain("Invalid");
  expect(
    await command({
      text: `!personality reject ${JSON.stringify({ proposalId: acceptedId })}`,
    }),
  ).toContain("already accepted");
  expect(lookup).not.toHaveBeenCalled();

  const undecided = structuredClone(c.state);
  const savesBefore = vi.mocked(c.saveState).mock.calls.length;
  lookup.mockReturnValueOnce(undefined);
  expect(await command()).toContain("No current pending");
  lookup.mockImplementationOnce(() => {
    throw new Error("private storage failure");
  });
  expect(await command()).toBe(
    "Personality suggestions are unavailable. Nothing changed.",
  );
  expect(c.state).toEqual(undecided);
  expect(vi.mocked(c.saveState).mock.calls).toHaveLength(savesBefore);
  lookup.mockClear();

  failSave = true;
  await expect(command()).rejects.toThrow("save failed");
  expect(lookup).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify(["private", owner.id]),
    proposalId,
  );
  expect(persisted.proposalDecisions?.[proposalId]).toBeUndefined();
  const failedDecisionMap = c.state.proposalDecisions;
  lookup.mockImplementation(() => {
    throw new Error("evidence no longer available");
  });
  failSave = false;
  const receipt = await command();
  expect(receipt).toBe(
    `Rejected personality suggestion ${proposalId}. Global personality is unchanged.`,
  );
  expect(c.state.proposalDecisions).not.toBe(failedDecisionMap);
  expect(persisted.proposalDecisions).toEqual({
    [acceptedId]: { status: "accepted", revision: 1 },
    [proposalId]: {
      status: "rejected",
      sourceScope: JSON.stringify(["private", owner.id]),
    },
  });
  c.state = structuredClone(persisted);
  expect(await command({ id: "new-owner-retry" })).toBe(receipt);
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(c.state.revisions).toEqual(revisions);
  expect(persisted.revisions).toEqual(revisions);
});
