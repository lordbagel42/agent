import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { EvidenceStore } from "../memory/store.js";
import { DecisionExecutor, type DecisionFunction } from "./evaluator.js";
import { createJuryTool, type JuryRequest } from "./jury.js";

const scope = '["private","owner"]';
const request: JuryRequest = {
  question: "uncertainty",
  prompt: "Is the observation uncertain?",
  evidenceIds: ["original"],
};

function seed(store: EvidenceStore) {
  for (const [id, audiences, text, observedAt] of [
    ["original", [scope], "The bird may be a heron.", Date.now()],
    ["foreign", ["other"], "FOREIGN", Date.now()],
    ["opt-out", [scope], "## OPT OUT", Date.now()],
    ["stale", [scope], "STALE", 0],
  ] as const)
    store.appendSource({
      id,
      audiences: [...audiences],
      text,
      observedAt,
      platform: "slack",
      account: "T1",
      conversation: "D1",
      author: "U1",
      sourceUrl: "https://example.com/source",
    });
}

it.for(["original", "foreign"])(
  "rejects unauthorized evidence and deletion of %s between jury stages",
  async (deleted) => {
    const store = new EvidenceStore(":memory:", randomBytes(32));
    seed(store);
    let calls = 0;
    let remove = false;
    const received: string[][] = [];
    const decide: DecisionFunction = async (input) => {
      calls++;
      received.push(input.evidence.map((item) => item.id));
      if (remove) store.deleteSource(deleted);
      return {
        answer: "yes",
        rationale: "private observation",
        evidenceIds: ["original"],
      };
    };
    const jury = createJuryTool({
      store,
      scope,
      evidenceMaxAgeMs: 60000,
      executor: new DecisionExecutor(2, 1000),
      providers: {
        jurors: [
          { id: "one", decide },
          { id: "two", decide },
        ],
        critic: decide,
        synthesize: decide,
      },
    });
    const signal = new AbortController().signal;
    try {
      for (const ids of [
        ["foreign"],
        ["opt-out"],
        ["stale"],
        ["missing"],
        ["original", "foreign"],
        ["original", "original"],
        Array(21).fill("original"),
      ])
        expect(await jury({ ...request, evidenceIds: ids }, signal)).toBeNull();
      expect(calls).toBe(0);
      expect(await jury(request, signal)).not.toBeNull();
      expect(calls).toBe(4);
      remove = true;
      expect(await jury(request, signal)).toBeNull();
      // The first juror deletes synchronously; neither the other juror nor
      // critic/synthesis can see the stale snapshot or prior private rationale.
      expect(calls).toBe(5);
      expect(received).toEqual(Array(5).fill(["original"]));
    } finally {
      store.close();
    }
  },
);

it("retains shared capacity and host occupancy until cancelled raw providers actually settle", async () => {
  const store = new EvidenceStore(":memory:", randomBytes(32));
  seed(store);
  const pending =
    Promise.withResolvers<Awaited<ReturnType<DecisionFunction>>>();
  let calls = 0;
  const signals: AbortSignal[] = [];
  const decide: DecisionFunction = async (_input, signal) => {
    calls++;
    signals.push(signal);
    return pending.promise;
  };
  const jury = createJuryTool({
    store,
    scope,
    evidenceMaxAgeMs: 60000,
    executor: new DecisionExecutor(1, 1000),
    providers: {
      jurors: [
        { id: "one", decide },
        { id: "two", decide },
      ],
      critic: decide,
      synthesize: decide,
    },
  });
  const controller = new AbortController();
  let settled = false;
  const first = jury(request, controller.signal).finally(() => {
    settled = true;
  });
  try {
    await expect.poll(() => calls).toBe(1);
    controller.abort();
    const blocked = await jury(request, new AbortController().signal);
    expect(blocked?.firstPass.map((vote) => vote.decision.rationale)).toEqual([
      "capacity",
      "capacity",
    ]);
    expect(blocked?.critic.rationale).toBe("capacity");
    expect(blocked?.synthesis.rationale).toBe("capacity");
    expect(signals[0]?.aborted).toBe(true);
    expect(settled).toBe(false);
    expect(calls).toBe(1);
  } finally {
    pending.resolve({
      answer: "yes",
      rationale: "late private answer",
      evidenceIds: ["original"],
    });
    expect(await first).toBeNull();
    store.close();
  }
});
