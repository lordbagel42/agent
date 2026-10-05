import { readFileSync } from "node:fs";
import { env } from "$env/dynamic/private";
import { createSessions } from "./auth.js";

let configuration: ReturnType<typeof load> | undefined;
function load() {
  const path =
    env.SANDBOX_CREDENTIAL_FILE ??
    `${env.CREDENTIALS_DIRECTORY}/sandboxes.json`;
  const value = JSON.parse(readFileSync(path, "utf8")) as {
    viewerKeyHash: string;
    readToken: string;
  };
  if (!/^[A-Za-z0-9_-]{43}$/.test(value.readToken))
    throw new Error("Invalid read token");
  const origins = (
    env.SANDBOX_UPSTREAMS ?? "http://127.0.0.1:3081,http://127.0.0.1:3082"
  ).split(",");
  for (const origin of origins) {
    const url = new URL(origin);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("Upstream must be loopback HTTP");
  }
  if (!origins.length || origins.length > 2)
    throw new Error("Invalid upstream count");
  return { ...value, origins, sessions: createSessions(value.viewerKeyHash) };
}
export function config() {
  configuration ??= load();
  return configuration;
}
