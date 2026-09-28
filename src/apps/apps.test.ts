import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import { createWorktreeManager } from "../coding/worktree.js";
import type {
  CompanionReply,
  MessageEvent,
  OutboundMessage,
} from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import { createJuneRegistry } from "../runtime/registry.js";
import { artifactSchema, readAppArtifact } from "./artifact.js";
import { appReceiptSchema, createAppsClient } from "./client.js";
import { createAppsHost } from "./host.js";

const artifact = {
  appId: "counter",
  files: {
    "package.json": '{"type":"module","main":"index.js"}',
    "index.js": "export default { fetch: () => Response.json({value:37}) };",
  },
};
const controlToken = "control-fixture-".repeat(3);
const viewerToken = "viewer-fixture-".repeat(3);

it("serializes builds without consuming a waiting approval or logging private request data", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "june-app-serial-"));
  t.onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const events: Record<string, string | number>[] = [];
  const first = Promise.withResolvers<{ release: string }>();
  let deployments = 0;
  const host = createAppsHost({
    database: join(cwd, "apps.sqlite"),
    controlToken,
    viewerToken,
    origin: "https://apps.example.invalid",
    binding: "fixture",
    deploy: () => {
      deployments++;
      return deployments === 1
        ? first.promise
        : Promise.resolve({ release: "second-release" });
    },
    serve: async () => new Response(),
    log: (event) => events.push(event),
  });
  t.onTestFinished(async () => {
    first.resolve({ release: "first-release" });
    await host.close();
  });
  const post = (path: string, body: unknown) =>
    host.app.request(path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const receipts = [];
  for (const appId of ["first", "second"])
    receipts.push(
      appReceiptSchema.parse(
        await (
          await post("/control/prepare", {
            artifact: { ...artifact, appId },
            jobId: "a".repeat(64),
            requestId: "b".repeat(64),
          })
        ).json(),
      ),
    );
  const [a, b] = receipts;
  if (!a || !b) throw new Error("missing fixtures");
  expect((await post(`/control/deploy/${a.id}`, {})).status).toBe(202);
  expect((await post(`/control/deploy/${b.id}`, {})).status).toBe(409);
  expect(deployments).toBe(1);
  first.resolve({ release: "first-release" });
  await expect
    .poll(async () => (await post(`/control/deploy/${b.id}`, {})).status)
    .toBe(202);
  expect(deployments).toBe(2);
  await post(`/control/receipts/private-path?token=private-query`, {});
  const logged = JSON.stringify(events);
  for (const value of [
    controlToken,
    artifact.files["index.js"],
    "private-path",
    "private-query",
  ])
    expect(logged).not.toContain(value);
  expect(events).toContainEqual({ event: "deploy_started", receiptId: b.id });
});

it("keeps source ingestion bounded and rejects paths/symlinks that could export host files", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "june-artifact-"));
  t.onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  for (const path of [
    "../private.json",
    "/etc/secrets.json",
    ".env",
    "src/.git/config.json",
    "node_modules/code.js",
  ])
    expect(
      artifactSchema.safeParse({
        ...artifact,
        files: { ...artifact.files, [path]: "secret" },
      }).success,
    ).toBe(false);
  for (const section of ["dependencies", "devDependencies"]) {
    expect(
      artifactSchema.safeParse({
        ...artifact,
        files: {
          ...artifact.files,
          "package.json": JSON.stringify({
            type: "module",
            main: "index.js",
            [section]: { rivetkit: "2.3.11" },
          }),
        },
      }).success,
    ).toBe(false);
  }
  expect(
    artifactSchema.safeParse({
      ...artifact,
      files: { ...artifact.files, "huge.js": "é".repeat(32_769) },
    }).success,
  ).toBe(false);
  await writeFile(join(cwd, "secret.json"), JSON.stringify(artifact));
  await symlink(join(cwd, "secret.json"), join(cwd, "june-app.json"));
  await expect(readAppArtifact(cwd, "counter")).rejects.toThrow();
});

it("never redeploys an uncertain intent after restart and strips viewer/proxy credentials", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "june-app-host-"));
  t.onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  let deployments = 0;
  const options = {
    database: join(cwd, "apps.sqlite"),
    controlToken,
    viewerToken,
    origin: "https://apps.example.invalid",
    binding: "fixture",
    async deploy() {
      deployments++;
      throw Object.assign(new Error("lost response with SECRET"), {
        code: "dynamic_apps_pack_failed",
      });
    },
    async serve(request: Request) {
      const headers: Record<string, string> = {};
      request.headers.forEach((value, name) => {
        headers[name] = value;
      });
      return Response.json(headers, {
        headers: { "set-cookie": "unsafe=1" },
      });
    },
  };
  let host = createAppsHost(options);
  const call = (path: string, body?: unknown, token = controlToken) =>
    host.app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const proposal = {
    artifact,
    jobId: "a".repeat(64),
    requestId: "c".repeat(64),
  };
  const expired = appReceiptSchema.parse(
    await (await call("/control/prepare", proposal)).json(),
  );
  expect(deployments).toBe(0);
  const clock = vi.spyOn(Date, "now").mockReturnValue(expired.expiresAt);
  t.onTestFinished(() => clock.mockRestore());
  expect((await call(`/control/deploy/${expired.id}`, {})).status).toBe(409);
  expect(await (await call("/control/prepare", proposal)).json()).toEqual(
    expired,
  );
  const receipt = appReceiptSchema.parse(
    await (
      await call("/control/prepare", { ...proposal, requestId: "d".repeat(64) })
    ).json(),
  );
  expect(receipt.id).not.toBe(expired.id);
  expect(receipt.expiresAt).toBe(expired.expiresAt + 600_000);
  clock.mockRestore();
  expect(
    (await call(`/control/deploy/${receipt.id}`, {}, viewerToken)).status,
  ).toBe(401);
  await call(`/control/deploy/${receipt.id}`, {});
  await expect
    .poll(
      async () =>
        (await (await call(`/control/receipts/${receipt.id}`)).json()).status,
    )
    .toBe("unknown");
  await host.close();
  host = createAppsHost(options);
  t.onTestFinished(() => host.close());
  expect(
    await (await call(`/control/deploy/${receipt.id}`, {})).json(),
  ).toMatchObject({
    status: "unknown",
    release: null,
    failureCode: "dynamic_apps_pack_failed",
  });
  expect(
    await (await call(`/control/receipts/${receipt.id}`)).text(),
  ).not.toContain("SECRET");
  const next = appReceiptSchema.parse(
    await (
      await call("/control/prepare", {
        artifact,
        jobId: "b".repeat(64),
        requestId: "e".repeat(64),
      })
    ).json(),
  );
  expect((await call(`/control/deploy/${next.id}`, {})).status).toBe(409);
  expect(await (await call("/control/apps/counter")).json()).toMatchObject({
    id: receipt.id,
    status: "unknown",
  });
  expect(deployments).toBe(1);
  expect((await host.app.request("/apps/counter/")).status).toBe(401);
  const served = await host.app.request("/apps/counter/", {
    headers: {
      authorization: `Bearer ${viewerToken}`,
      cookie: "private=secret",
      "cf-access-jwt-assertion": "secret",
      "x-rivet-token": "secret",
      accept: "application/json",
    },
  });
  expect(await served.json()).toEqual({ accept: "application/json" });
  expect(served.headers.has("set-cookie")).toBe(false);
});

it("connects June's app tool to approved coding, immutable artifacts and separate owner deployment approval", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "june-app-flow-"));
  t.onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const repositoryRoot = join(cwd, "repo");
  const worktreeRoot = join(cwd, "worktrees");
  await mkdir(repositoryRoot);
  await mkdir(worktreeRoot);
  execFileSync("git", ["init"], { cwd: repositoryRoot, stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ],
    { cwd: repositoryRoot, stdio: "pipe" },
  );
  const manager = createWorktreeManager({
    repositoryRoot,
    worktreeRoot,
    verifier: {
      argv: [
        process.execPath,
        "-e",
        "const a=JSON.parse(require('fs').readFileSync('june-app.json','utf8'));if(!a.files['index.js'].includes('37'))process.exit(1)",
      ],
      timeoutMs: 5000,
    },
  });
  let deployments = 0;
  let workerRuns = 0;
  const host = createAppsHost({
    database: join(cwd, "apps.sqlite"),
    controlToken,
    viewerToken,
    origin: "https://apps.example.invalid",
    binding: "fixture",
    async deploy(source) {
      expect(source).toEqual(artifact);
      deployments++;
      return { release: "release-fixture" };
    },
    async serve() {
      return new Response();
    },
  });
  t.onTestFinished(() => host.close());
  const apps = createAppsClient({
    endpoint: "https://host.example.invalid",
    token: controlToken,
    workspace: "apps",
    readJob: async (id) => client.job.get(["owner", id]).snapshot(),
    fetch: async (url, init) => host.app.request(String(url), init),
  });
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const sent: OutboundMessage[] = [];
  let action: CompanionReply = {
    text: "",
    apps: {
      action: "build",
      appId: "counter",
      goal: "Build a JSON counter returning 37.",
      jobId: null,
    },
  };
  const registry = createJuneRegistry({
    owner,
    apps,
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: true, threads: true },
        async receive() {
          return { response: new Response(), events: [] };
        },
        async send(message) {
          sent.push(message);
          return { status: "sent", messageId: String(sent.length) };
        },
      },
    },
    model: {
      async reply(request) {
        expect(
          Object.hasOwn(
            replyJsonSchema(request.workspaces, request).properties,
            "apps",
          ),
        ).toBe(!!request.appsAvailable);
        if (request.system.includes("Coding completion"))
          return { text: "Build ready; not deployed." };
        if (request.appsAvailable)
          return parseReply(
            JSON.stringify(action),
            request.workspaces,
            request,
          );
        return action; // Deliberately malicious/custom provider in public scope.
      },
    },
    coding: {
      runtimeId: "fixture",
      runtimeKind: "amp",
      workspaces: { apps: repositoryRoot },
      appsWorkspace: "apps",
      isolation: { apps: manager },
      timeoutMs: 5000,
      runtime: {
        async run(input) {
          workerRuns++;
          expect(input.prompt).toContain("Do not deploy");
          await input.onThread("fixture-thread");
          await writeFile(
            join(input.cwd, "june-app.json"),
            JSON.stringify(artifact),
          );
          return { threadId: "fixture-thread", report: "Exported source." };
        },
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const june = client.conversation.getOrCreate(["private", owner.id]);
  let serial = 0;
  const deliver = async (
    text: string,
    direct = true,
    presentation: "plain" | "quoted" | "missing" = "plain",
  ) => {
    const event: MessageEvent = {
      id: `event-${serial++}`,
      messageId: String(serial),
      type: "message",
      occurredAt: Date.now(),
      senderId: "U1",
      direct,
      text,
      codingCommandEligible: direct,
      ...(presentation === "missing"
        ? {}
        : { appDeploymentEligible: presentation === "plain" }),
      address: {
        channel: "slack",
        accountId: "T1",
        conversationId: direct ? "D1" : "C1",
      },
    };
    const scope = routeEvent(event, owner);
    if (!scope) throw new Error("missing scope");
    const conversation = client.conversation.getOrCreate(scope.key);
    await conversation.send("inbox", { type: "event", event });
    await expect
      .poll(async () =>
        Object.values((await conversation.snapshot()).events).some(
          (entry) => entry.event.id === event.id && entry.done,
        ),
      )
      .toBe(true);
  };
  await deliver("Build it", false);
  expect(Object.keys((await june.snapshot()).jobs)).toHaveLength(0);
  await deliver("Build it");
  const jobId = Object.keys((await june.snapshot()).jobs)[0];
  if (!jobId) throw new Error("missing job");
  expect(workerRuns).toBe(0);
  expect(deployments).toBe(0);
  await deliver(`!approve ${jobId.slice(0, 12)}`);
  const job = client.job.get([owner.id, jobId]);
  await expect
    .poll(async () => (await job.snapshot()).status)
    .toBe("completed");
  const completed = await job.snapshot();
  expect(completed.appArtifact?.files).toEqual(artifact.files);
  if (!completed.worktree) throw new Error("missing worktree");
  await writeFile(
    join(completed.worktree.cwd, "june-app.json"),
    "changed after verification",
  );
  action = {
    text: "",
    apps: { action: "prepare", appId: "counter", goal: null, jobId },
  };
  // Current main also binds the whole workspace. Retained bytes cannot be
  // swapped, and a changed workspace must not bypass that additional check.
  if (!action.apps) throw new Error("missing prepare request");
  await expect(apps.request(action.apps, "b".repeat(64))).rejects.toThrow(
    "verified_app_required",
  );
  await writeFile(
    join(completed.worktree.cwd, "june-app.json"),
    JSON.stringify(artifact),
  );
  await deliver("Prepare the app");
  const prepared = appReceiptSchema.parse(
    await (
      await host.app.request("/control/apps/counter", {
        headers: { authorization: `Bearer ${controlToken}` },
      })
    ).json(),
  );
  expect(prepared.status).toBe("prepared");
  expect(deployments).toBe(0);
  await deliver(`!deploy-app ${prepared.id}`, false);
  await deliver(`!deploy-app ${prepared.id}`, true, "quoted");
  await deliver(`!deploy-app ${prepared.id}`, true, "missing");
  expect(deployments).toBe(0);
  await deliver(`!deploy-app ${prepared.id}`);
  await expect.poll(() => deployments).toBe(1);
  await deliver(`!deploy-app ${prepared.id}`);
  expect(deployments).toBe(1);
  action = {
    text: "",
    apps: { action: "inspect", appId: "counter", goal: null, jobId: null },
  };
  await deliver("Inspect the app");
  const content = sent.at(-1)?.content;
  expect(content?.type === "text" ? content.text : "").toContain(
    '"release":"release-fixture"',
  );
  await job.cancel(true);
  await expect(apps.approve(prepared.id)).rejects.toThrow(
    "verified_app_required",
  );
});
