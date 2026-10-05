import { readSnapshot } from "$lib/server/snapshot.js";
export async function load() {
  return { snapshot: await readSnapshot() };
}
