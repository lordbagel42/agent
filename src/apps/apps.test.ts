import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, type TestContext, vi } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import { createWorktreeManager } from "../coding/worktree.js";
import type {
  CompanionReply,
  MessageEvent,
  OutboundMessage,
} from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import type { CodingState } from "../runtime/coding.js";
import { createJuneRegistry } from "../runtime/registry.js";
import { artifactDigest, artifactSchema, readAppArtifact } from "./artifact.js";
import {
  appReceiptSchema,
  appsRequestSchema,
  createAppsClient,
} from "./client.js";
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
const appConversationKey = ["slack", "T1", "C1", ""];

async function deployFixture(
  t: TestContext,
  unknown = false,
  proposalScope: string[] | null = appConversationKey,
) {
  const cwd = await mkdtemp(join(tmpdir(), "june-app-model-deploy-"));
  t.onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const deployments: unknown[] = [];
  const requests: string[] = [];
  const jobId = "a".repeat(64);
  const conversationKey = proposalScope ?? ["private", "owner"];
  const job: CodingState = {
    proposal: {
      id: jobId,
      workspace: "apps",
      appId: "counter",
      goal: "Build a counter",
      ...(proposalScope ? { conversationKey: [...proposalScope] } : {}),
      source: {
        id: "source",
        type: "message",
        messageId: "1",
        occurredAt: Date.now(),
        senderId: conversationKey[0] === "guest" ? "U2" : "U1",
        address: {
          channel: "slack",
          accountId: "T1",
          conversationId: proposalScope ? "C1" : "D1",
        },
        direct: !proposalScope,
        botMentioned: true,
        metadata: { channelType: proposalScope ? "channel" : "im" },
        text: "Build a counter",
      },
    },
    status: "completed",
    attempts: 1,
    commandApprovals: { model: 1 },
    verification: {
      status: "passed",
      passed: true,
      exitCode: 0,
      signal: null,
      baseCommit: "0".repeat(40),
      headCommit: "0".repeat(40),
      finishedAt: new Date().toISOString(),
      replayed: false,
      output: "omitted",
      artifactMatches: true,
    },
    appArtifact: {
      ...structuredClone(artifact),
      digest: artifactDigest(artifact),
    },
  };
  const host = createAppsHost({
    database: join(cwd, "apps.sqlite"),
    controlToken,
    viewerToken,
    origin: "https://apps.example.invalid",
    binding: "fixture",
    viewer: {
      port: 3091,
      publicDomain: "public.example.invalid",
      signedInDomain: "signed.example.invalid",
      issuer: "https://fixture.cloudflareaccess.com",
      audience: "a".repeat(64),
    },
    async deploy(source) {
      deployments.push(source);
      if (unknown) throw new Error("Lost deployment response");
      return { release: "model-release" };
    },
    serve: async () => new Response(),
  });
  t.onTestFinished(() => host.close());
  const readJob = vi.fn(async (id: string, callerScope: string[]) => {
    if (
      id !== job.proposal?.id ||
      JSON.stringify(callerScope) !==
        JSON.stringify(job.proposal.conversationKey ?? ["private", "owner"])
    )
      return undefined;
    return structuredClone(job);
  });
  const apps = createAppsClient({
    endpoint: "https://host.example.invalid",
    token: controlToken,
    workspace: "apps",
    readJob,
    fetch: async (url, init) => {
      requests.push(`${init?.method} ${new URL(String(url)).pathname}`);
      return host.app.request(String(url), init);
    },
  });
  const receipt = async (path = "/control/apps/counter") =>
    appReceiptSchema.parse(
      await (
        await host.app.request(path, {
          headers: { authorization: `Bearer ${controlToken}` },
        })
      ).json(),
    );
  await apps.request(
    {
      action: "prepare",
      appId: "counter",
      jobId,
      goal: null,
      access: "public",
    },
    "b".repeat(64),
    conversationKey,
  );
  return {
    apps,
    job,
    conversationKey,
    readJob,
    deployments,
    requests,
    receipt,
    prepared: await receipt(),
  };
}

it.for([
  { name: "channel", scope: appConversationKey },
  { name: "guest", scope: ["guest", "slack", "T1", "C1", "", "U2"] },
  { name: "legacy private", scope: null },
])(
  "authorizes the saved job before exposing or deploying another conversation's app ($name)",
  async ({ scope }, t) => {
    const { apps, conversationKey, deployments, requests, prepared, receipt } =
      await deployFixture(t, false, scope);
    const foreignScope = ["slack", "T1", "C2", ""];
    const inspect = {
      action: "inspect" as const,
      appId: "counter",
      jobId: null,
      goal: null,
    };
    const prepare = {
      ...inspect,
      action: "prepare" as const,
      jobId: prepared.jobId,
      access: "public" as const,
    };
    const deploy = {
      ...inspect,
      action: "deploy" as const,
      receiptId: prepared.id,
    };
    for (const request of [inspect, prepare, deploy])
      await expect(
        apps.request(request, "d".repeat(64), foreignScope),
      ).rejects.toThrow("verified_app_required");
    await expect(apps.approve(prepared.id, foreignScope)).rejects.toThrow(
      "verified_app_required",
    );
    expect(requests).toEqual([
      "POST /control/prepare",
      "GET /control/apps/counter",
      `GET /control/receipts/${prepared.id}`,
      `GET /control/receipts/${prepared.id}`,
    ]);
    expect(deployments).toEqual([]);
    expect(await receipt()).toEqual(prepared);

    expect(
      (await apps.request(inspect, "e".repeat(64), conversationKey)).text,
    ).toContain(JSON.stringify(prepared));
    await apps.request(prepare, "e".repeat(64), conversationKey);
    expect(await receipt()).toMatchObject({
      jobId: prepared.jobId,
      digest: prepared.digest,
      access: "public",
      status: "prepared",
    });
    expect(deployments).toEqual([]);
    // Both model choice in admitted public/guest scopes and the legacy command
    // with a historical private job retain their original same-scope authority.
    if (scope) await apps.request(deploy, "f".repeat(64), conversationKey);
    else await apps.approve(prepared.id, conversationKey);
    await expect
      .poll(
        async () => (await receipt(`/control/receipts/${prepared.id}`)).status,
      )
      .toBe("deployed");
    expect(deployments).toEqual([artifact]);
    expect(
      requests.filter((path) => path.startsWith("POST /control/deploy/")),
    ).toEqual([`POST /control/deploy/${prepared.id}`]);
  },
);

it.for(["inspect", "prepare"] as const)(
  "rechecks current context before returning app metadata or exporting source (%s)",
  async (action, t) => {
    const { apps, job, readJob, deployments, requests, prepared } =
      await deployFixture(t);
    let current = true;
    readJob.mockImplementationOnce(async () => {
      current = false;
      return structuredClone(job);
    });
    await expect(
      apps.request(
        {
          action,
          appId: "counter",
          jobId: action === "prepare" ? prepared.jobId : null,
          goal: null,
        },
        "d".repeat(64),
        appConversationKey,
        () => current,
      ),
    ).rejects.toThrow("app_context_revoked");
    expect(requests.filter((path) => path.startsWith("POST "))).toEqual([
      "POST /control/prepare",
    ]);
    expect(deployments).toEqual([]);
  },
);

it.for(["deployed", "unknown"] as const)(
  "model deploy uses the exact prepared source and audience without retrying its outcome (%s)",
  async (outcome, t) => {
    const { apps, deployments, requests, prepared, receipt } =
      await deployFixture(t, outcome === "unknown");
    expect(deployments).toEqual([]);
    await apps.request(
      {
        action: "prepare",
        appId: "counter",
        jobId: prepared.jobId,
        goal: null,
        access: "signed-in",
      },
      "c".repeat(64),
      appConversationKey,
    );
    const later = await receipt();
    expect(later.id).not.toBe(prepared.id);
    const request = {
      action: "deploy" as const,
      appId: "counter",
      receiptId: prepared.id,
      jobId: null,
      goal: null,
    };
    await apps.request(request, "d".repeat(64), appConversationKey);
    await expect
      .poll(
        async () => (await receipt(`/control/receipts/${prepared.id}`)).status,
      )
      .toBe(outcome);
    expect(deployments).toEqual([artifact]);
    expect(await receipt(`/control/receipts/${prepared.id}`)).toMatchObject({
      access: "public",
      digest: prepared.digest,
    });
    expect(await receipt(`/control/receipts/${later.id}`)).toMatchObject({
      access: "signed-in",
      status: "prepared",
    });
    await apps.request(request, "e".repeat(64), appConversationKey);
    expect(deployments).toHaveLength(1);
    expect(
      requests.filter((path) => path.startsWith("POST /control/deploy/")),
    ).toEqual([`POST /control/deploy/${prepared.id}`]);
  },
);

it.for([
  "expired",
  "artifact-changed",
  "digest-changed",
  "cancelled",
  "revoked",
  "unverified",
  "context-revoked",
  "wrong-app",
] as const)(
  "model deploy preserves prepared receipt checks (%s)",
  async (mode, t) => {
    const { apps, job, readJob, deployments, requests, prepared } =
      await deployFixture(t);
    let current = true;
    if (mode === "expired") {
      const clock = vi.spyOn(Date, "now").mockReturnValue(prepared.expiresAt);
      t.onTestFinished(() => clock.mockRestore());
    } else if (mode === "artifact-changed" || mode === "digest-changed") {
      if (!job.appArtifact) throw new Error("missing artifact");
      job.appArtifact.files["index.js"] =
        "export default { fetch: () => new Response('changed') };";
      if (mode === "digest-changed")
        job.appArtifact.digest = artifactDigest(job.appArtifact);
    } else if (mode === "cancelled") job.cancelRequested = true;
    else if (mode === "revoked") job.revoked = true;
    else if (mode === "unverified") job.status = "needs_review";
    else if (mode === "context-revoked")
      readJob.mockImplementationOnce(async () => {
        current = false;
        return structuredClone(job);
      });
    const operation = apps.request(
      {
        action: "deploy",
        appId: mode === "wrong-app" ? "other" : "counter",
        receiptId: prepared.id,
        jobId: null,
        goal: null,
      },
      "d".repeat(64),
      appConversationKey,
      () => current,
    );
    if (mode === "expired") expect((await operation).text).toContain("expired");
    else
      await expect(operation).rejects.toThrow(
        mode === "context-revoked" || mode === "digest-changed"
          ? "app_approval_revoked"
          : mode === "wrong-app"
            ? "app_receipt_mismatch"
            : "verified_app_required",
      );
    expect(deployments).toEqual([]);
    expect(
      requests.some((path) => path.startsWith("POST /control/deploy/")),
    ).toBe(false);
  },
);

it("requires an exact receipt for deploy and never accepts a replacement audience or source", () => {
  const request = {
    action: "deploy",
    appId: "counter",
    receiptId: "a".repeat(64),
    jobId: null,
    goal: null,
  };
  expect(appsRequestSchema.safeParse(request).success).toBe(true);
  for (const change of [
    { receiptId: null },
    { receiptId: undefined },
    { receiptId: "short" },
    { access: "public" },
    { jobId: "b".repeat(64) },
    { goal: "Change the source" },
    { conversationKey: appConversationKey },
    { action: "inspect" },
    { action: "prepare", jobId: "b".repeat(64) },
  ])
    expect(appsRequestSchema.safeParse({ ...request, ...change }).success).toBe(
      false,
    );
});

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

it("connects model-selected app coding to immutable artifacts and exact receipt deployment", async (t) => {
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
    viewer: {
      port: 3091,
      publicDomain: "public.example.invalid",
      signedInDomain: "signed.example.invalid",
      issuer: "https://fixture.cloudflareaccess.com",
      audience: "a".repeat(64),
    },
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
    readJob: async (id, conversationKey) => {
      const job = client.job.get(["owner", id]);
      const { proposal } = await job.snapshot(false);
      if (
        !proposal ||
        JSON.stringify(conversationKey) !==
          JSON.stringify(proposal.conversationKey ?? ["private", owner.id]) ||
        JSON.stringify(conversationKey) !==
          JSON.stringify(routeEvent(proposal.source, owner)?.key)
      )
        return undefined;
      return job.snapshot();
    },
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
  if (!action.apps) throw new Error("missing build request");
  const build = await apps.request(action.apps, "a".repeat(64), [
    "private",
    owner.id,
  ]);
  if (!build.coding) throw new Error("missing coding task");
  const jobId = "a".repeat(64);
  const job = client.job.getOrCreate([owner.id, jobId]);
  expect(workerRuns).toBe(0);
  expect(deployments).toBe(0);
  // Exercise the host proposal contract directly; registry producers attach
  // these host-only fields after their own admission/provenance checks.
  await job.send("commands", {
    type: "propose",
    proposal: {
      ...build.coding,
      id: jobId,
      runtimeId: "fixture",
      runImmediately: true,
      deletionRevision: 0,
      conversationKey: ["private", owner.id],
      source: {
        id: "app-build",
        type: "message",
        messageId: "build",
        occurredAt: Date.now(),
        senderId: "U1",
        direct: true,
        text: "Build a counter",
        address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      },
    },
  });
  await expect
    .poll(async () => (await job.snapshot()).status)
    .toBe("completed");
  expect(workerRuns).toBe(1);
  const completed = await job.snapshot();
  expect(completed.appArtifact?.files).toEqual(artifact.files);
  if (!completed.worktree) throw new Error("missing worktree");
  await writeFile(
    join(completed.worktree.cwd, "june-app.json"),
    "changed after verification",
  );
  action = {
    text: "",
    apps: {
      action: "prepare",
      appId: "counter",
      goal: null,
      jobId,
      access: "public",
    },
  };
  // Current main also binds the whole workspace. Retained bytes cannot be
  // swapped, and a changed workspace must not bypass that additional check.
  if (!action.apps) throw new Error("missing prepare request");
  await expect(
    apps.request(action.apps, "b".repeat(64), ["private", owner.id]),
  ).rejects.toThrow("verified_app_required");
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
  expect(prepared.access).toBe("public");
  expect(prepared.url).toBe(
    "https://counter.public.example.invalid/apps/counter/",
  );
  const proposalMessage = sent.at(-1)?.content;
  expect(
    proposalMessage?.type === "text" ? proposalMessage.text : "",
  ).toContain("Anyone, without signing in");
  expect(deployments).toBe(0);
  // Raw-command compatibility is separate from model choice: malformed or
  // nonprivate command text alone must not authorize a deployment.
  action = { text: "" };
  await deliver(`!deploy-app ${prepared.id}`, false);
  await deliver(`!deploy-app ${prepared.id}`, true, "quoted");
  await deliver(`!deploy-app ${prepared.id}`, true, "missing");
  expect(deployments).toBe(0);
  action = {
    text: "",
    apps: {
      action: "deploy",
      appId: "counter",
      receiptId: prepared.id,
      jobId: null,
      goal: null,
    },
  };
  await deliver("Deploy the exact prepared app");
  await expect.poll(() => deployments).toBe(1);
  await deliver("Deploy that same receipt again");
  // The old explicit command also shares the same no-relaunch path.
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
  await expect(
    apps.approve(prepared.id, ["private", owner.id]),
  ).rejects.toThrow("verified_app_required");
});
