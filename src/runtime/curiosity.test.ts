import type { Client } from "rivetkit/client";
import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import { createJuneRegistry, type JuneClientRegistry } from "./registry.js";

it("does not turn failed or abstaining curiosity into investigated evidence or actions", async (t) => {
  let calls = 0;
  const { client } = await setupTest(
    t,
    createJuneRegistry({
      owner: { id: "owner", identities: [] },
      channels: {},
      model: {
        async reply() {
          throw new Error("No conversation model expected");
        },
      },
      reflection: {
        ownerId: "owner",
        policy: {
          totalCapacity: 2,
          liveReserve: 1,
          cooldownMs: 1,
          maxAttempts: 1,
          maxNoNewEvidence: 1,
          evidenceMaxAgeMs: 60000,
          quiet: { timeZone: "UTC", startMinute: 0, endMinute: 0 },
        },
        idleMs: 10,
        deepMs: 20,
        pollMs: 20,
        timeoutMs: 1000,
        async retrieve({ scope, evidenceIds }) {
          return {
            authorized: true,
            evidence: evidenceIds.map((id) => ({
              id,
              scope,
              text: "Untrusted fixture",
              source: "episode" as const,
              observedAt: Date.now(),
              expiresAt: Date.now() + 60000,
            })),
          };
        },
        async decide(input) {
          calls++;
          const answer = input.evidence[0]?.id;
          if (answer === "throw") throw new Error("Fixture failure");
          expect(input.question).toBe("interruption-cost");
          expect(input.prompt).toContain("No web search was performed");
          if (answer === "tools")
            return {
              answer: "yes",
              rationale: "Fetch more private sources",
              evidenceIds: input.evidence.map((e) => e.id),
              webSearch: "private account query",
            };
          return {
            answer: answer === "no" ? "no" : "abstain",
            rationale: "Fixture",
            evidenceIds: input.evidence.map((e) => e.id),
          };
        },
      },
    }),
  );
  const reflection = (
    client as Client<JuneClientRegistry>
  ).reflection.getOrCreate(["owner"]);
  for (const answer of ["no", "abstain", "throw", "tools"]) {
    const request = {
      kind: "curiosity" as const,
      mode: "idle" as const,
      evidenceIds: [answer],
    };
    expect(await reflection.request(request)).toEqual({ status: "queued" });
    const id = JSON.stringify([JSON.stringify(["private", "owner"]), [answer]]);
    const key = JSON.stringify([id, 1]);
    await expect
      .poll(async () => (await reflection.status()).invocations[key], {
        timeout: 5000,
      })
      .toBe("settled");
    const status = await reflection.status();
    expect(status.decisionOutcomes?.[key]).toBe(
      answer === "throw" ? undefined : answer === "tools" ? "abstain" : answer,
    );
    expect(status.candidateIds).toEqual([]);
    expect(status.reflection.requests.find((r) => r.id === id)).toMatchObject({
      status: "stopped",
      attempts: 1,
    });
    expect(await reflection.request(request)).toEqual({ status: "duplicate" });
  }
  expect(calls).toBe(4);
});
