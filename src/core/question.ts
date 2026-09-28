import { z } from "zod";

/** Conversational choices, never a substitute for a protected-action approval. */
export const questionSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(300),
  options: z
    .array(z.string().trim().min(1).max(75))
    .min(2)
    .max(5)
    .refine((options) => new Set(options).size === options.length),
});
export type Question = z.infer<typeof questionSchema>;

export function questionText(question: Question): string {
  return `${question.prompt}\n${question.options.map((option, index) => `${index + 1}. ${option}`).join("\n")}\nChoose an option or reply in your own words.`;
}
