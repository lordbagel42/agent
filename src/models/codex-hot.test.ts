import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHotCodexProvider } from "./codex-hot.js";
import { UsageLedger } from "./usage.js";

const systemFiles = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (path: string, encoding: "utf8") =>
      systemFiles.has(path)
        ? Promise.resolve(systemFiles.get(path))
        : actual.readFile(path, encoding),
  };
});
afterEach(() => systemFiles.clear());

// A real subprocess exercises framing, correlation, and lifetime; it never uses credentials.
async function fixture(
  t: { onTestFinished(fn: () => Promise<void>): void },
  mode = "ok",
) {
  const root = await mkdtemp(join(tmpdir(), "hot-codex-test-"));
  const home = join(root, "home");
  await mkdir(home);
  if (mode === "dirty")
    await writeFile(join(home, "config.toml"), 'notify=["unsafe"]');
  const executable = join(root, "codex");
  const log = join(root, "calls");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const emit = x => process.stdout.write(JSON.stringify(x)+'\\n');
let n = 0;
let turns = 0;
const cli = {};
for(let i=2;i<process.argv.length;i++) if(process.argv[i]==='-c') {
 const [key,...values]=process.argv[++i].split('='); const parts=key.split('.');let target=cli;
 for(const part of parts.slice(0,-1)) target=target[part]??={};
 target[parts.at(-1)]=JSON.parse(values.join('='));
}
const terminal = new Set();
const finish = (threadId,status='completed') => {
  terminal.add(threadId);
  emit({method:'turn/completed',params:{threadId,turn:{id:'turn-'+threadId,status}}});
};
const usage = threadId => emit({method:'thread/tokenUsage/updated',params:{threadId,turnId:'turn-'+threadId,tokenUsage:{last:{inputTokens:123,cachedInputTokens:7,cacheWriteInputTokens:0,outputTokens:19,reasoningOutputTokens:2}}}});
for await (const line of createInterface({ input: process.stdin })) {
  const r = JSON.parse(line);
  appendFileSync(${JSON.stringify(log)}, line+'\\n');
  if (r.id === undefined) continue;
  let result = {};
  if(r.method==='initialize' && ${JSON.stringify(mode)}==='slow-init') {setTimeout(()=>emit({id:r.id,result:{}}),300);continue;}
  if (r.method === 'configRequirements/read') result={requirements:${JSON.stringify(mode === "requirements" ? { additionalDeveloperInstructions: "managed instruction" } : mode === "account-policy" ? { additionalDeveloperInstructions: null, modelProvider: null, modelProviders: null, chatgptBaseUrl: null, hooks: null, allowedLoginMethods: ["api", "chatgpt"], featureRequirements: { chronicle: false } } : null)}};
  if (r.method === 'config/read') {
    result = {config:{...structuredClone(cli),mcp_servers:{},model_providers:{},chatgpt_base_url:'https://chatgpt.com/backend-api/',instructions:null,developer_instructions:null,model_instructions_file:null,hooks:null},layers:[{name:{type:'sessionFlags'},config:structuredClone(cli)},{name:{type:'user'},config:{}}]};
    if(${JSON.stringify(mode)}==='cloud') result.layers.push({name:{type:'enterpriseManaged'},config:{}});
    if(${JSON.stringify(mode)}==='feature') result.config.features.shell_tool=true;
    if(${JSON.stringify(mode)}==='endpoint') result.config.chatgpt_base_url='https://untrusted.invalid';
    if(${JSON.stringify(mode)}==='provider-definition') result.config.model_providers.openai={base_url:'https://untrusted.invalid'};
  }
  if (r.method === 'thread/start') result = {thread:{id:'thread-'+ ++n}, modelProvider:'openai',instructionSources:[],approvalPolicy:'never',sandbox:{type:'readOnly'}};
  if(r.method==='thread/start' && n>3 && ${JSON.stringify(mode)}==='slow-replenish') {setTimeout(()=>emit({id:r.id,result}),300);continue;}
  if (r.method === 'thread/unsubscribe') result = {status:'unsubscribed'};
  if (r.method === 'turn/interrupt') {
    const threadId=r.params.threadId;
    if (terminal.has(threadId) || ['interrupt-race','interrupt-unconfirmed'].includes(${JSON.stringify(mode)})) {
      emit({id:r.id,error:{code:-32600,message:'no active turn to interrupt'}});
      if (!terminal.has(threadId) && ${JSON.stringify(mode)}!=='interrupt-unconfirmed') setTimeout(()=>{usage(threadId);finish(threadId);},20);
      continue;
    }
    usage(threadId); finish(threadId,'interrupted');
  }
  if (r.method === 'turn/start') {
    const threadId = r.params.threadId;
    const first=++turns===1;
    if (${JSON.stringify(mode)} === 'lost') process.exit(1);
    if (${JSON.stringify(mode)} === 'no-ack') continue;
    result = {turn:{id:'turn-'+threadId}};
    if (first && ${JSON.stringify(mode)} === 'terminal-before-ack') {
      setTimeout(()=>finish(threadId),100);
      setTimeout(()=>emit({id:r.id,result:{turn:{id:'turn-'+threadId}}}),250);
      continue;
    }
    if (${JSON.stringify(mode)} === 'approval') { emit({id:700,method:'item/commandExecution/requestApproval',params:{threadId}}); continue; }
    if (${JSON.stringify(mode)} === 'late') await new Promise(r=>setTimeout(r,150));
    emit({id:r.id,result});
    if (first && ${JSON.stringify(mode)} === 'failed-first') {usage(threadId);finish(threadId,'failed');continue;}
    if (first && ['interrupt-race','interrupt-usage','interrupt-unconfirmed'].includes(${JSON.stringify(mode)})) continue;
    if (['hang','late'].includes(${JSON.stringify(mode)})) continue;
    const item = {type:${JSON.stringify(mode === "tool" ? "commandExecution" : "agentMessage")},phase:'final_answer',text:${JSON.stringify(mode === "schema" ? '{"text":"hello","coding":{"workspace":"not-authorized","goal":"run"}}' : '{"text":"hello"}')}};
    emit({method:'item/completed',params:{threadId,turnId:result.turn.id,item}});
    if (['failed-first','terminal-before-ack','interrupt-race','interrupt-usage'].includes(${JSON.stringify(mode)})) setTimeout(()=>finish(threadId),400);
    else finish(threadId);
    continue;
  }
  emit({id:r.id,result});
  if (r.method === 'thread/unsubscribe' && ${JSON.stringify(mode)}!=='no-close') emit({method:'thread/closed',params:{threadId:r.params.threadId}});
}
`,
    { mode: 0o700 },
  );
  const ledger = new UsageLedger(join(root, "usage.sqlite"));
  const provider = createHotCodexProvider({
    usage: ledger,
    model: "test",
    home,
    executable,
    timeoutMs: 2000,
  });
  t.onTestFinished(async () => {
    await provider.close();
    ledger.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    provider,
    ledger,
    calls: async () =>
      (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    home,
  };
}
const request = {
  system: "private sentinel",
  messages: [{ role: "user" as const, content: "hello" }],
  workspaces: [],
};

it("consumes pristine bounded threads once with no MCP tools", async (t) => {
  const { provider, calls } = await fixture(t);
  await provider.ready();
  expect(provider.inspect()).toMatchObject({ idle: 3, active: 0, capacity: 3 });
  expect(await provider.reply(request)).toEqual({ text: "hello" });
  expect(await provider.reply(request)).toEqual({ text: "hello" });
  await provider.close();
  const log = await calls();
  const turns = log.filter((x) => x.method === "turn/start");
  expect(new Set(turns.map((x) => x.params.threadId)).size).toBe(2);
  for (const start of log.filter((x) => x.method === "thread/start")) {
    expect(start.params.ephemeral).toBe(true);
    expect(start.params.config.mcp_servers).toEqual({});
    expect(JSON.stringify(start)).not.toContain("private sentinel");
  }
  await expect(provider.reply(request)).rejects.toMatchObject({
    retryable: false,
  });
});

for (const mode of ["lost", "tool", "approval", "schema"]) {
  it(`fails closed without replay after ${mode}`, async (t) => {
    const { provider, calls } = await fixture(t, mode);
    await provider.ready();
    await expect(provider.reply(request)).rejects.toMatchObject({
      retryable: false,
    });
    expect(
      (await calls()).filter((x) => x.method === "turn/start"),
    ).toHaveLength(1);
  });
}

it("waits for the start response before cancelling, then retires the session", async (t) => {
  const { provider, calls } = await fixture(t, "late");
  await provider.ready();
  const controller = new AbortController();
  const result = provider.reply(request, controller.signal);
  const rejected = expect(result).rejects.toThrow();
  await expect
    .poll(async () => (await calls()).some((x) => x.method === "turn/start"))
    .toBe(true);
  controller.abort();
  await rejected;
  expect((await calls()).some((x) => x.method === "turn/interrupt")).toBe(true);
  await expect.poll(() => provider.inspect().idle).toBe(3);
});

it("bounds admission and closes in-flight calls without replenishing or replay", async (t) => {
  const { provider, calls } = await fixture(t, "hang");
  await provider.ready();
  const results = Array.from({ length: 3 }, () => provider.reply(request));
  const settled = Promise.allSettled(results);
  await expect.poll(() => provider.inspect().active).toBe(3);
  await expect(provider.reply(request)).rejects.toMatchObject({
    code: "provider_busy",
    retryable: true,
  });
  await expect
    .poll(
      async () =>
        (await calls()).filter((x) => x.method === "turn/start").length,
    )
    .toBe(3);
  await provider.close();
  expect((await settled).map((r) => r.status)).toEqual([
    "rejected",
    "rejected",
    "rejected",
  ]);
  const log = await calls();
  expect(log.filter((x) => x.method === "thread/start")).toHaveLength(3);
  expect(log.filter((x) => x.method === "turn/start")).toHaveLength(3);
});

it("rejects nonempty config without spawning a process", async (t) => {
  const { provider, calls } = await fixture(t, "dirty");
  await expect(provider.ready()).rejects.toMatchObject({
    code: "hot_codex_requires_clean_config",
    retryable: false,
  });
  await expect(calls()).rejects.toMatchObject({ code: "ENOENT" });
});

for (const mode of [
  "failed-first",
  "terminal-before-ack",
  "interrupt-race",
  "interrupt-usage",
]) {
  it(`preserves other calls and replenishes after ${mode}`, async (t) => {
    const { provider, calls, ledger } = await fixture(t, mode);
    await provider.ready();
    const controller = new AbortController();
    const rejected = expect(
      provider.reply(request, controller.signal),
    ).rejects.toMatchObject({ retryable: false });
    const other = provider.reply(request);
    await expect
      .poll(
        async () =>
          (await calls()).filter((x) => x.method === "turn/start").length,
      )
      .toBe(2);
    if (mode !== "failed-first") controller.abort();
    await rejected;
    expect(await other).toEqual({ text: "hello" });
    await expect.poll(() => provider.inspect().idle).toBe(3);
    expect(await provider.reply(request)).toEqual({ text: "hello" });
    const log = await calls();
    expect(log.filter((x) => x.method === "turn/start")).toHaveLength(3);
    expect(log.filter((x) => x.method === "turn/interrupt")).toHaveLength(
      ["failed-first", "terminal-before-ack"].includes(mode) ? 0 : 1,
    );
    if (mode !== "terminal-before-ack")
      expect(
        ledger.snapshot().recent.find((x) => x.status === "failed"),
      ).toMatchObject({ input: 123, cached: 7, output: 19, reasoning: 2 });
  });
}

it("accepts inert authenticated account requirements", async (t) => {
  const { provider } = await fixture(t, "account-policy");
  await provider.ready();
  await expect(provider.reply(request)).resolves.toHaveProperty("text");
});

for (const mode of [
  "requirements",
  "cloud",
  "feature",
  "endpoint",
  "provider-definition",
]) {
  it(`rejects ${mode} before thread creation or prewarm`, async (t) => {
    const { provider, calls } = await fixture(t, mode);
    await expect(provider.ready()).rejects.toMatchObject({ retryable: false });
    expect(
      (await calls()).filter((x) => x.method === "thread/start"),
    ).toHaveLength(0);
  });
}
for (const file of [
  "/etc/codex/managed_config.toml",
  "/etc/codex/requirements.toml",
]) {
  it(`rejects nonempty ${file} before spawn without altering /etc`, async (t) => {
    systemFiles.set(file, 'additional_developer_instructions="managed"');
    const { provider, calls } = await fixture(t);
    await expect(provider.ready()).rejects.toMatchObject({
      code: "hot_codex_requires_clean_config",
    });
    await expect(calls()).rejects.toMatchObject({ code: "ENOENT" });
  });
}

for (const mode of ["no-ack", "no-close", "interrupt-unconfirmed"]) {
  it(`fails closed without replay when ${mode}`, async (t) => {
    const { provider, calls } = await fixture(t, mode);
    await provider.ready();
    await expect(provider.reply(request)).rejects.toMatchObject({
      retryable: false,
    });
    expect(provider.inspect().state).toBe("failed");
    expect(
      (await calls()).filter((x) => x.method === "turn/start"),
    ).toHaveLength(1);
    expect(
      (await calls()).filter((x) => x.method === "thread/start"),
    ).toHaveLength(3);
  });
}
for (const mode of ["slow-init", "slow-replenish"]) {
  it(`settles close during ${mode} without subsequent replacement`, async (t) => {
    const { provider, calls } = await fixture(t, mode);
    if (mode === "slow-replenish") {
      await provider.ready();
      await provider.reply(request);
    }
    await expect
      .poll(async () => {
        const log = await calls().catch(() => []);
        return mode === "slow-init"
          ? log.some((x) => x.method === "initialize")
          : log.filter((x) => x.method === "thread/start").length === 4;
      })
      .toBe(true);
    await provider.close();
    await expect(provider.ready()).rejects.toMatchObject({ retryable: false });
    await expect.poll(() => provider.inspect().creating).toBe(0);
    expect(
      (await calls()).filter((x) => x.method === "thread/start"),
    ).toHaveLength(mode === "slow-init" ? 0 : 4);
  });
}

it("rechecks managed files before replenishing", async (t) => {
  const { provider, calls } = await fixture(t);
  await provider.ready();
  systemFiles.set(
    "/etc/codex/requirements.toml",
    'additional_developer_instructions="new policy"',
  );
  await provider.reply(request);
  await expect.poll(() => provider.inspect().state).toBe("failed");
  expect(
    (await calls()).filter((x) => x.method === "thread/start"),
  ).toHaveLength(3);
});
