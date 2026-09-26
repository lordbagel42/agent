import { describe, expect, it } from "vitest";
import type { Decision, DecisionInput } from "./evaluator.js";
import { DecisionExecutor, runJury, typedEvaluator } from "./evaluator.js";

const input: DecisionInput = {
  scope: "dm",
  question: "novelty",
  prompt: "Is this new?",
  now: 100,
  evidenceMaxAgeMs: 100,
  evidence: [
    {
      id: "a",
      scope: "dm",
      text: "one",
      source: "episode",
      observedAt: 50,
      expiresAt: 200,
    },
  ],
};
const yes: Decision = {
  answer: "yes",
  rationale: "supported",
  evidenceIds: ["a"],
  confidence: 1,
};

describe("bounded typed decisions", () => {
  it("validates malformed output, exceptions, unsupported citations and stale context as abstentions", async () => {
    const executor = new DecisionExecutor(1, 100);
    for (const value of [
      { ...yes, grant: true },
      { ...yes, confidence: NaN },
      { ...yes, evidenceIds: ["invented"] },
      { ...yes, answer: "execute" },
      { ...yes, evidenceIds: [] },
      { ...yes, answer: ["yes"] },
    ]) {
      expect(
        (await executor.evaluate(input, async () => value as Decision)).answer,
      ).toBe("abstain");
    }
    expect(
      (
        await executor.evaluate(input, async () => {
          throw new Error("secret provider error");
        })
      ).rationale,
    ).not.toContain("secret");
    expect(
      (await executor.evaluate({ ...input, now: 200 }, async () => yes)).answer,
    ).toBe("abstain");
    const result = await executor.evaluate(
      input,
      typedEvaluator(async () => yes),
    );
    expect(result).toEqual(yes);
    expect(result).not.toHaveProperty("permission");
  });

  it("bounds concurrent calls, cancels promptly and retains slots for uncooperative work", async () => {
    const executor = new DecisionExecutor(1, 1000);
    let release!: (value: Decision) => void;
    const controller = new AbortController();
    const pending = executor.evaluate(
      input,
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      controller.signal,
    );
    await Promise.resolve();
    expect((await executor.evaluate(input, async () => yes)).rationale).toBe(
      "capacity",
    );
    controller.abort();
    expect((await pending).rationale).toBe("cancelled");
    expect((await executor.evaluate(input, async () => yes)).rationale).toBe(
      "capacity",
    );
    release(yes);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await executor.evaluate(input, async () => yes)).answer).toBe(
      "yes",
    );
  });

  it("times out failed providers and never starts pre-cancelled work", async () => {
    const executor = new DecisionExecutor(1, 5);
    const controller = new AbortController();
    controller.abort();
    expect(
      (
        await executor.evaluate(
          input,
          async () => {
            throw new Error("must not run");
          },
          controller.signal,
        )
      ).rationale,
    ).toBe("cancelled");
    expect(
      (await executor.evaluate(input, () => new Promise(() => {}))).rationale,
    ).toBe("timeout");
  });
});

describe("independent jury", () => {
  it("retains failures and abstentions when critic/synthesizer fail, and strips inherited prior votes", async () => {
    const inherited = { ...input, prior: [{ id: "leaked", decision: yes }] };
    const result = await runJury(inherited, new DecisionExecutor(2, 100), {
      jurors: [
        {
          id: "one",
          decide: async (context) => ({
            ...yes,
            answer: context.prior ? "yes" : "no",
          }),
        },
        {
          id: "two",
          decide: async () => {
            throw new Error("offline");
          },
        },
      ],
      critic: async (context) => {
        context.prior?.splice(0);
        throw new Error("offline");
      },
      synthesize: async () => ({ ...yes, grant: "execute" }) as Decision,
    });
    expect(result.firstPass.map((v) => v.decision.answer)).toEqual([
      "no",
      "abstain",
    ]);
    expect(result.critic.answer).toBe("abstain");
    expect(result.synthesis.answer).toBe("abstain");
    expect(result.dissent.map((v) => v.id)).toEqual(["one", "two", "critic"]);
  });

  it("isolates equal evidence on first pass and preserves dissent and abstention despite synthesis", async () => {
    const contexts: DecisionInput[] = [];
    const capture = (decision: Decision) => async (context: DecisionInput) => {
      contexts.push(structuredClone(context));
      const first = context.evidence[0];
      if (!first) throw new Error("Missing fixture evidence");
      first.text = "mutated";
      return decision;
    };
    const result = await runJury(input, new DecisionExecutor(3, 100), {
      jurors: [
        { id: "a", decide: capture(yes) },
        { id: "b", decide: capture({ ...yes, answer: "no" }) },
        {
          id: "c",
          decide: capture({
            answer: "abstain",
            rationale: "uncertain",
            evidenceIds: [],
          }),
        },
      ],
      critic: async (context) => {
        expect(context.prior).toHaveLength(3);
        return yes;
      },
      synthesize: async (context) => {
        expect(context.prior).toHaveLength(4);
        return yes;
      },
    });
    expect(contexts).toEqual([input, input, input]);
    expect(input.evidence[0]?.text).toBe("one");
    expect(result.firstPass.map((v) => v.decision.answer)).toEqual([
      "yes",
      "no",
      "abstain",
    ]);
    expect(result.dissent.map((v) => v.id)).toEqual(["b", "c"]);
    expect(result.synthesis.answer).toBe("yes");
    expect(result).not.toHaveProperty("grant");
  });
});
