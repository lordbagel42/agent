import { json } from "@sveltejs/kit";
import { readSnapshot } from "$lib/server/snapshot.js";
export async function GET() {
  const snapshot = await readSnapshot();
  return json(snapshot ?? { error: "unavailable" }, {
    status: snapshot ? 200 : 503,
  });
}
