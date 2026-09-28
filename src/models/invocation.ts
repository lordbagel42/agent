import type {
  ModelInvocation,
  ModelProvider,
  ModelSettlement,
} from "../core/contracts.js";

/** Unsupported providers retain their answer behavior, not settlement authority.
 * A broken lifecycle implementation cannot trigger fallback/replay. */
export function beginModelReply(
  model: ModelProvider,
  ...args: Parameters<ModelProvider["reply"]>
): ModelInvocation {
  try {
    if (model.beginReply) {
      const invocation = model.beginReply(...args);
      return {
        answer: invocation.answer,
        settlement: Promise.resolve()
          .then(() => invocation.settlement)
          .then(
            (value) =>
              value === "not_started" || value === "confirmed_stopped"
                ? value
                : "unknown",
            () => "unknown",
          ),
      };
    }
    return {
      answer: Promise.resolve().then(() => model.reply(...args)),
      settlement: Promise.resolve("unknown"),
    };
  } catch (error) {
    return {
      answer: Promise.reject(error),
      settlement: Promise.resolve("unknown"),
    };
  }
}

/** Run a wrapper once, collecting all child calls without delaying its answer.
 * The wrapper must await its calls and stop dispatching before its answer ends.
 * This covers inference only: intervening tool effects need their own receipts. */
export function wrapModelProvider(
  model: ModelProvider,
  wrap: (child: Pick<ModelProvider, "reply">) => ModelProvider["reply"],
) {
  const beginReply = (
    ...args: Parameters<ModelProvider["reply"]>
  ): ModelInvocation => {
    const children: Promise<ModelSettlement>[] = [];
    const reply: ModelProvider["reply"] = (...childArgs) => {
      const child = beginModelReply(model, ...childArgs);
      children.push(child.settlement);
      return child.answer;
    };
    const answer = Promise.resolve().then(() => wrap({ reply })(...args));
    const finish = async (): Promise<ModelSettlement> => {
      const outcomes = await Promise.all(children);
      if (outcomes.includes("unknown")) return "unknown";
      return outcomes.includes("confirmed_stopped")
        ? "confirmed_stopped"
        : "not_started";
    };
    return { answer, settlement: answer.then(finish, finish) };
  };
  return {
    beginReply,
    reply: (...args: Parameters<ModelProvider["reply"]>) =>
      beginReply(...args).answer,
  };
}
