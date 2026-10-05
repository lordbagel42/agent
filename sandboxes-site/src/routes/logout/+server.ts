import { redirect } from "@sveltejs/kit";
import { sessionCookie } from "$lib/server/auth.js";
import { config } from "$lib/server/config.js";
import type { RequestHandler } from "./$types";
export const POST: RequestHandler = ({ cookies }) => {
  config().sessions.logout(cookies.get(sessionCookie));
  cookies.delete(sessionCookie, { path: "/" });
  redirect(303, "/login");
};
