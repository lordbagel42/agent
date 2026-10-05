import { fail, redirect } from "@sveltejs/kit";
import { dev } from "$app/environment";
import { sessionCookie, sessionSeconds } from "$lib/server/auth.js";
import { config } from "$lib/server/config.js";
import type { Actions } from "./$types";

export const actions: Actions = {
  default: async ({ request, cookies }) => {
    const key = (await request.formData()).get("key");
    const id =
      typeof key === "string" ? config().sessions.login(key.trim()) : null;
    if (!id)
      return fail(401, {
        error:
          "Sign-in failed. Check your viewer key, or wait a minute and try again.",
      });
    cookies.set(sessionCookie, id, {
      path: "/",
      httpOnly: true,
      secure: !dev,
      sameSite: "strict",
      maxAge: sessionSeconds,
    });
    redirect(303, "/");
  },
};
