import { describe, expect, it } from "vitest";
import { createDecisionProvider } from "../models/decision.js";
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

describe("decision provider evidence and authority boundaries", () => {
  it("keeps first-pass inputs private and rejects invented citations and authority in both protocols", async () => {
    for (const protocol of ["openai", "anthropic"] as const) {
      let output: unknown = yes;
      let calls = 0;
      const decide = createDecisionProvider({
        protocol,
        auth: "api-key",
        model: "local-fake",
        apiKey: "fake",
        fetch: async (_url, init) => {
          calls++;
          const body = JSON.parse(String(init?.body));
          const messages = body.input ?? body.messages;
          expect(messages).toHaveLength(1);
          expect(JSON.parse(messages[0].content)).toEqual({
            question: input.question,
            prompt: input.prompt,
            now: input.now,
            evidence: input.evidence,
          });
          expect(body.tools).toBeUndefined();
          expect(body.previous_response_id).toBeUndefined();
          expect(init?.redirect).toBe("error");
          const schema =
            body.text?.format.schema ?? body.output_config.format.schema;
          if (schema.properties.alternativeResponses) {
            expect(schema.required).toContain("alternativeResponses");
            expect(body.instructions ?? body.system).toContain(
              "explicitly hypothetical",
            );
          }
          return Response.json(
            protocol === "openai"
              ? {
                  status: "completed",
                  output: [
                    {
                      type: "message",
                      role: "assistant",
                      status: "completed",
                      content: [
                        { type: "output_text", text: JSON.stringify(output) },
                      ],
                    },
                  ],
                }
              : {
                  type: "message",
                  role: "assistant",
                  stop_reason: "end_turn",
                  content: [{ type: "text", text: JSON.stringify(output) }],
                },
          );
        },
      });
      const inherited = {
        ...input,
        secret: "must not serialize",
        prior: [{ id: "private-vote", decision: yes }],
        evidence: input.evidence.map((e) => ({
          ...e,
          secret: "private metadata",
        })),
      };
      const signal = new AbortController().signal;
      expect(await decide(inherited, signal)).toEqual(yes);
      for (const malformed of [
        { ...yes, evidenceIds: ["outside-scope"] },
        { ...yes, permission: "execute" },
      ]) {
        output = malformed;
        expect((await decide(inherited, signal)).answer).toBe("abstain");
      }
      expect(calls).toBe(3);
      expect(
        (await decide({ ...inherited, scope: "public" }, signal)).answer,
      ).toBe("abstain");
      expect((await decide({ ...inherited, now: 200 }, signal)).answer).toBe(
        "abstain",
      );
      expect(calls).toBe(3);

      const simulation = { ...inherited, simulateResponses: true as const };
      const alternatives = [
        "a".repeat(2000),
        "A clarifying question",
        "A shorter reply",
      ];
      output = { ...yes, alternativeResponses: alternatives };
      expect(await decide(simulation, signal)).toEqual(output);
      // The same synthetic payload must not be accepted as an ordinary decision.
      expect((await decide(inherited, signal)).answer).toBe("abstain");
      for (const malformed of [
        { ...yes, alternativeResponses: [...alternatives, "fourth"] },
        { ...yes, alternativeResponses: ["a".repeat(2001)] },
        { ...yes, alternativeResponses: [" "] },
        { ...yes, alternativeResponses: [] },
        yes,
        {
          ...yes,
          alternativeResponses: ["reply"],
          evidenceIds: ["invented-simulation-id"],
        },
        { ...yes, alternativeResponses: ["reply"], hypothesisOnly: false },
      ]) {
        output = malformed;
        expect((await decide(simulation, signal)).answer).toBe("abstain");
      }
      expect(calls).toBe(12);
    }
  });

  it("does not retry failed requests or start cancelled work and forwards revocation to transport", async () => {
    let calls = 0;
    const controller = new AbortController();
    const decide = createDecisionProvider({
      protocol: "openai",
      auth: "api-key",
      model: "local-fake",
      apiKey: "fake",
      fetch: async (_url, init) => {
        calls++;
        controller.abort();
        expect(init?.signal?.aborted).toBe(true);
        throw new Error("provider secret");
      },
    });
    expect(
      (await decide({ ...input, simulateResponses: true }, controller.signal))
        .rationale,
    ).toBe("cancelled");
    expect((await decide(input, controller.signal)).rationale).toBe(
      "cancelled",
    );
    expect(calls).toBe(1);
    const failing = createDecisionProvider({
      protocol: "openai",
      auth: "api-key",
      model: "local-fake",
      apiKey: "fake",
      fetch: async () => {
        calls++;
        return new Response("secret", { status: 429 });
      },
    });
    await expect(
      failing(input, new AbortController().signal),
    ).rejects.toMatchObject({ code: "rate_limited" });
    expect(calls).toBe(2);

    let release!: (response: Response) => void;
    let settled = false;
    const held = new AbortController();
    const uncooperative = createDecisionProvider({
      protocol: "openai",
      auth: "api-key",
      model: "local-fake",
      apiKey: "fake",
      fetch: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const pending = uncooperative(
      { ...input, simulateResponses: true },
      held.signal,
    ).then((decision) => {
      settled = true;
      return decision;
    });
    held.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    release(new Response("late transport failure", { status: 500 }));
    expect((await pending).rationale).toBe("cancelled");
  });
});

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

  it("shares capacity with settlement-aware durable callers after timeout", async () => {
    const executor = new DecisionExecutor(1, 5);
    const raw = Promise.withResolvers<Decision>();
    let signal: AbortSignal | undefined;
    let settled = false;
    const result = executor
      .evaluateSettled(input, async (_input, active) => {
        signal = active;
        return raw.promise;
      })
      .finally(() => {
        settled = true;
      });
    await expect.poll(() => signal?.aborted).toBe(true);
    expect(settled).toBe(false);
    expect((await executor.evaluate(input, async () => yes)).rationale).toBe(
      "capacity",
    );
    raw.resolve(yes);
    expect((await result).rationale).toBe("timeout");
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
