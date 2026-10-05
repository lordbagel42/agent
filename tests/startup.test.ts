import { type ChildProcess, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { parseConfig } from "../src/config.js";
import { SettingsStore } from "../src/settings/store.js";
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
    const baseline = {
      ...config,
      port,
      console: { origin: `http://127.0.0.1:${port}` },
    };
    await writeFile(path, JSON.stringify(baseline));
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
        // Cold startup on the two-core deployment host includes loading Rivet.
        // Match its bounded readiness window, without weakening the assertions.
        { timeout: 30_000 },
      )
      .toEqual({ name: "June", ready: true });
    expect((await request("/operator/conversation")).status).toBe(401);
    const preferences = new SettingsStore({
      path: join(directory, "settings.sqlite"),
      base: parseConfig(baseline),
    });
    preferences.run({
      action: "update",
      expectedVersion: 0,
      changes: [{ key: "model.model", value: "saved-fixture" }],
    });
    preferences.close();
    const beforeActivation = await (
      await request("/console", { headers })
    ).text();
    expect(beforeActivation).toContain("openai · fixture");
    expect(beforeActivation).not.toContain("saved-fixture");
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
    // A telemetry-only corruption must not take messaging down or expose errors.
    await writeFile(
      join(directory, "diagnostics", "logs.sqlite"),
      "private-corrupt-diagnostics",
    );
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
        { timeout: 30_000 },
      )
      .toBe(200);
    expect(await (await request("/console", { headers })).text()).toContain(
      "openai · saved-fixture",
    );
    expect((await request("/operator/logs", { headers })).status).toBe(200);
    expect(await (await request("/operator/logs", { headers })).json()).toEqual(
      { unavailable: true },
    );
    expect(second.output()).toContain("persistent diagnostics unavailable");
    expect(second.output()).not.toContain("private-corrupt-diagnostics");
    // Receive a fresh signed callback with logging unavailable, without inference.
    const fresh = body.replaceAll("wamid.receipt", "wamid.after-restart");
    expect(
      (
        await request("/webhooks/whatsapp", {
          method: "POST",
          body: fresh,
          headers: {
            "content-type": "application/json",
            "x-hub-signature-256": `sha256=${createHmac("sha256", "fixture-secret").update(fresh).digest("hex")}`,
          },
        })
      ).status,
    ).toBe(200);
    await expect
      .poll(async () => Object.values((await snapshot()).events).length)
      .toBe(2);
    expect(Object.values((await snapshot()).events)).toEqual([
      expect.objectContaining({
        done: true,
        event: expect.objectContaining({ messageId: "wamid.receipt" }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({ messageId: "wamid.after-restart" }),
      }),
    ]);
    expect((await snapshot()).history).toEqual([]);
    expect(first.output() + second.output()).not.toContain(operatorToken);
  }, 75_000);

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

  it.each(["absent", "imports", "mcp"] as const)(
    "renders %s capabilities without inference or provider probes",
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), "june-setup-"));
      const enginePort = await freeEnginePort();
      const port = await freeEnginePort();
      const path = join(directory, "config.json");
      const privateDirectory = join(directory, "private");
      await mkdir(privateDirectory, { mode: 0o700 });
      // An immutable release marker belongs to a disposable release, never
      // the checkout shared by other tests. The feed deliberately does not exist.
      let entry = "src/main.ts";
      if (mode === "mcp") {
        await cp("src", join(directory, "src"), { recursive: true });
        await symlink(resolve("node_modules"), join(directory, "node_modules"));
        await writeFile(join(directory, "package.json"), '{"type":"module"}');
        await writeFile(
          join(directory, ".june-release.json"),
          JSON.stringify({
            revision: "a".repeat(40),
            compatibility: "b".repeat(64),
            binding: "c".repeat(64),
            artifactSha256: "d".repeat(64),
          }),
        );
        entry = join(directory, "src/main.ts");
      }
      await writeFile(
        path,
        JSON.stringify({
          port,
          setupMode: true,
          console: { origin: `http://127.0.0.1:${port}` },
          ...(mode !== "absent"
            ? { memory: { directory: privateDirectory, keyEnv: "FIXTURE_KEY" } }
            : {}),
          ...(mode === "mcp"
            ? {
                mcp: { directory: privateDirectory, keyEnv: "FIXTURE_KEY" },
                capabilities: { directory: privateDirectory },
                deployment: {
                  eventsFile: join(directory, "missing-feed.json"),
                },
              }
            : {}),
          ...(mode === "imports"
            ? {
                imports: {
                  history: {
                    platform: "gmail",
                    account: "private-account-not-for-html@example.com",
                    conversations: ["private_conversation_not_for_html"],
                    from: 1000,
                    to: 2000,
                    accessTokenEnv: "MISSING_IMPORT_TOKEN",
                  },
                },
              }
            : {}),
          owner: { id: "raygen", identities: [] },
          model: {
            protocol: "codex",
            model: "gpt-6-astra",
            home: join(directory, ".codex"),
            executable: "/must-not-run-before-sign-in",
          },
          ...(mode === "imports" ? { ...config, setupMode: false } : {}),
        }),
      );
      const child = spawn(process.execPath, ["--import", "tsx", entry], {
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          JUNE_CONFIG: path,
          JUNE_OPERATOR_TOKEN: operatorToken,
          JUNE_DEPLOY_TOKEN: "fixture-deployment-token-32-characters-long",
          JUNE_ALLOW_MEMORY: "1",
          JUNE_ALLOW_HISTORY_IMPORTS: "1",
          FIXTURE_KEY: Buffer.alloc(32, 7).toString("base64"),
          MODEL_KEY: "unused",
          APP_SECRET: "fixture-secret",
          VERIFY_TOKEN: "fixture-verify",
          ACCESS_TOKEN: "unused",
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
      onTestFinished(async () => {
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
          { timeout: 30_000 },
        )
        .toMatchObject({ name: "June", ready: true });
      for (const channel of mode === "imports"
        ? ["slack"]
        : ["slack", "whatsapp"])
        expect(
          (await fetch(`${url}/webhooks/${channel}`, { method: "POST" }))
            .status,
        ).toBe(404);
      expect((await fetch(`${url}/operator/conversation`)).status).toBe(401);
      expect((await fetch(`${url}/operator/capabilities/status`)).status).toBe(
        401,
      );
      const capabilityStatus = await fetch(
        `${url}/operator/capabilities/status`,
        {
          headers: { authorization: `Bearer ${operatorToken}` },
        },
      );
      expect(capabilityStatus.status).toBe(mode === "mcp" ? 200 : 404);
      if (mode === "mcp") {
        expect(await capabilityStatus.json()).toEqual({
          mounted: true,
          registeredTools: 0,
        });
        const grant = await fetch(`${url}/operator/capabilities/grants`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${operatorToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            audience: "raygen",
            action: {
              tool: "browser",
              account: "unbound",
              item: "unbound",
              origin: "https://fixture.example",
              arguments: {},
            },
            expiresAt: Date.now() + 60000,
          }),
        });
        expect(grant.status).toBe(400);
      }
      expect((await fetch(`${url}/console`)).status).toBe(401);
      const overview = await fetch(`${url}/console`, {
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(overview.status).toBe(200);
      const html = await overview.text();
      expect(html).toContain("0 durable events");
      expect(html).toContain("0 proposals");
      const record = (title: string) =>
        html.match(
          new RegExp(`<li class="item">[^]*?<h3>${title}</h3>([^]*?)</li>`),
        )?.[1];
      expect(record("History imports")).toContain(
        mode === "imports" ? "1 configured selection" : "No import selections",
      );
      expect(record("History imports")).toContain(
        mode === "imports" ? ">configured<" : ">not configured<",
      );
      expect(record("MCP tools")).toContain(
        mode === "mcp" ? ">configured<" : ">not configured<",
      );
      if (mode !== "absent") expect(html).toContain("not inspected");
      expect(record("Deployment inspection")).toContain(
        mode === "mcp" ? ">configured<" : ">not configured<",
      );
      expect(html).not.toContain("Imports, tools and deployment");
      for (const privateValue of [
        operatorToken,
        directory,
        "/must-not-run-before-sign-in",
        "private-account-not-for-html",
        "private_conversation_not_for_html",
        "MISSING_IMPORT_TOKEN",
        "<form",
      ])
        expect(html).not.toContain(privateValue);
      if (mode !== "imports") expect(output).toContain("setup mode");
      expect(output).not.toContain(operatorToken);
    },
    45_000,
  );
});
