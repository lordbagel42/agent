import { type ChildProcess, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { freeEnginePort, stopTestEngine } from "./rivet.js";

const operatorToken = "fixture-operator-token-32-characters-long";
const config = {
  owner: {
    id: "raygen",
    identities: [
      { channel: "whatsapp", accountId: "123", senderId: "15550123" },
    ],
  },
  model: {
    protocol: "openai",
    model: "fixture",
    apiKeyEnv: "MODEL_KEY",
    baseUrl: "http://127.0.0.1:9/v1",
  },
  whatsapp: {
    phoneNumberId: "123",
    apiVersion: "v25.0",
    appSecretEnv: "APP_SECRET",
    verifyTokenEnv: "VERIFY_TOKEN",
    accessTokenEnv: "ACCESS_TOKEN",
  },
};

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

describe("runnable June host", () => {
  it("persists a signed receipt across application and engine restarts, without inference or live messages", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "june-startup-"));
    const enginePort = await freeEnginePort();
    const port = await freeEnginePort();
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ ...config, port }));
    const children: ChildProcess[] = [];
    let output = "";
    t.onTestFinished(async () => {
      if (t.task.result?.state === "fail") console.error(output);
      for (const child of children) await stop(child);
      await stopTestEngine(directory, enginePort);
      await rm(directory, { recursive: true, force: true });
    });
    function start() {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "src/main.ts"],
        {
          env: {
            PATH: process.env.PATH,
            HOME: directory,
            JUNE_CONFIG: path,
            JUNE_OPERATOR_TOKEN: operatorToken,
            MODEL_KEY: "unused",
            APP_SECRET: "fixture-secret",
            VERIFY_TOKEN: "fixture-verify",
            ACCESS_TOKEN: "unused",
            RIVETKIT_STORAGE_PATH: directory,
            RIVET_RUN_ENGINE_PORT: String(enginePort),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      children.push(child);
      child.stdout?.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        output += String(chunk);
      });
      return { child, output: () => output };
    }
    const url = `http://127.0.0.1:${port}`;
    const request = (path: string, init?: RequestInit) =>
      fetch(`${url}${path}`, { ...init, signal: AbortSignal.timeout(5000) });
    const headers = { authorization: `Bearer ${operatorToken}` };
    const first = start();
    await expect
      .poll(
        async () => {
          if (first.child.exitCode !== null) return `Exited: ${first.output()}`;
          return request("/health")
            .then((response) => response.json())
            .catch(() => null);
        },
        { timeout: 15_000 },
      )
      .toEqual({ name: "June", ready: true });
    expect((await request("/operator/conversation")).status).toBe(401);
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: "123" },
                statuses: [
                  {
                    id: "wamid.receipt",
                    status: "read",
                    timestamp: "1790000000",
                    recipient_id: "15550123",
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const response = await request("/webhooks/whatsapp", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${createHmac("sha256", "fixture-secret").update(body).digest("hex")}`,
      },
    });
    expect(response.status).toBe(200);
    const snapshot = async () =>
      (await request("/operator/conversation", { headers })).json();
    await expect
      .poll(async () => Object.values((await snapshot()).events), {
        timeout: 3000,
      })
      .toEqual([
        expect.objectContaining({
          done: true,
          event: expect.objectContaining({
            type: "receipt",
            messageId: "wamid.receipt",
            status: "read",
          }),
        }),
      ]);
    await stop(first.child);
    await stopTestEngine(directory, enginePort);
    const second = start();
    await expect
      .poll(
        async () => {
          if (second.child.exitCode !== null)
            return `Exited: ${second.output()}`;
          return request("/health")
            .then((response) => response.status)
            .catch(() => null);
        },
        { timeout: 15_000 },
      )
      .toBe(200);
    expect(Object.values((await snapshot()).events)).toEqual([
      expect.objectContaining({
        done: true,
        event: expect.objectContaining({ messageId: "wamid.receipt" }),
      }),
    ]);
    expect((await snapshot()).history).toEqual([]);
    expect(first.output() + second.output()).not.toContain(operatorToken);
  }, 45_000);

  it("refuses native coding without the separate host opt-in, before starting Rivet", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "june-opt-in-"));
    t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        ...config,
        coding: {
          enabled: true,
          runtime: { kind: "amp" },
          workspaces: { june: directory },
          isolation: { june: { worktreeRoot: join(directory, "worktrees") } },
        },
      }),
    );
    const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        JUNE_CONFIG: path,
        RIVETKIT_STORAGE_PATH: directory,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    const [code] = await once(child, "exit");
    expect(code).toBe(1);
    expect(output).toContain("JUNE_ALLOW_NATIVE_CODING=1");
  });

  it("starts subscription setup mode without model or messaging credentials and exposes no webhook", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "june-setup-"));
    const enginePort = await freeEnginePort();
    const port = await freeEnginePort();
    const path = join(directory, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        port,
        setupMode: true,
        owner: { id: "raygen", identities: [] },
        model: {
          protocol: "codex",
          model: "gpt-6-astra",
          home: join(directory, ".codex"),
          executable: "/must-not-run-before-sign-in",
        },
      }),
    );
    const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        JUNE_CONFIG: path,
        JUNE_OPERATOR_TOKEN: operatorToken,
        RIVETKIT_STORAGE_PATH: directory,
        RIVET_RUN_ENGINE_PORT: String(enginePort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr])
      stream?.on("data", (chunk) => {
        output += String(chunk);
      });
    t.onTestFinished(async () => {
      await stop(child);
      await stopTestEngine(directory, enginePort);
      await rm(directory, { recursive: true, force: true });
    });
    const url = `http://127.0.0.1:${port}`;
    await expect
      .poll(
        async () => {
          if (child.exitCode !== null) return output;
          return fetch(`${url}/health`)
            .then((response) => response.json())
            .catch(() => null);
        },
        { timeout: 15_000 },
      )
      .toEqual({ name: "June", ready: true });
    for (const channel of ["slack", "whatsapp"])
      expect(
        (await fetch(`${url}/webhooks/${channel}`, { method: "POST" })).status,
      ).toBe(404);
    expect((await fetch(`${url}/operator/conversation`)).status).toBe(401);
    expect(output).toContain("setup mode");
    expect(output).not.toContain(operatorToken);
  });
});
