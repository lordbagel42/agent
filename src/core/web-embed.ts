import { z } from "zod";

/** Public display URLs only. This is not permission to fetch from June's host. */
export const webEmbedUrlSchema = z
  .string()
  .max(1000)
  .url()
  .refine((value) => {
    const url = URL.parse(value);
    if (!url) return false;
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      !/[\s<>`\\]/.test(value) &&
      /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(
        url.hostname,
      ) &&
      !/\.(?:local|localhost|internal|lan|home|test|invalid|onion)$/i.test(
        url.hostname,
      ) &&
      !url.hostname.endsWith(".slack.com")
    );
  });

export const webEmbedSchema = z.strictObject({
  url: webEmbedUrlSchema,
  thumbnailUrl: webEmbedUrlSchema,
  title: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[^<>&\r\n`]+$/),
});
export type WebEmbed = z.infer<typeof webEmbedSchema>;

export function allowedWebEmbed(
  value: WebEmbed,
  origins: readonly string[],
): boolean {
  return (
    webEmbedSchema.safeParse(value).success &&
    [value.url, value.thumbnailUrl].every((url) =>
      origins.includes(new URL(url).origin),
    )
  );
}

export const WEB_EMBED_HELP = `You can share an already-hosted public webpage through webEmbed: {url, thumbnailUrl, title}, with empty text and no other action. Both HTTPS URLs must use an operator-approved origin and have no credentials, query string or fragment. Use only public, non-sensitive content intended for this owner-private Slack conversation. No raw HTML upload or hosting is provided. This uses Slack's video-block iframe workaround (inspired by Coolton); ordinary webpages may not render, and app configuration is not proof of rendering. The message includes a fallback link; never retry an unknown send. Do not embed June's console, private data, authenticated/bearer links or arbitrary destinations. When useful and a real safe, public, server-enforced view-only E2B desktop stream already exists on an approved origin, consider showcasing it with a brief title instead of only describing it. This is a gentle preference, not a requirement: do not spawn extra desktops, prolong paid sandboxes or weaken access controls just for presentation. The one-shot e2b code tool is headless and destroys its sandbox; it does not provide a desktop URL. Never invent one or claim a desktop is live after teardown.`;
