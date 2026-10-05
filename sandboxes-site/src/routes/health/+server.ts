import { json } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import { config } from "$lib/server/config.js";
export function GET() {
  try {
    config();
    return json({ ready: true, revision: env.SANDBOX_REVISION ?? null });
  } catch {
    return json({ ready: false }, { status: 503 });
  }
}
