import { z } from "zod";

/** Host-generated private hypotheses must not reenter automatic platform context. */
export const PRIVATE_REFLECTION_REVIEW_PREFIX =
  "June private reflection review — owner only\n";

export const reflectionReviewSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({
    action: z.literal("inspect"),
    id: z.string().regex(/^[a-f0-9]{64}$/),
  }),
]);

export type ReflectionReview = z.infer<typeof reflectionReviewSchema>;
