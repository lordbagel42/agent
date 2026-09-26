import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelRequest } from "../core/contracts.js";
import { createCodexProvider } from "./codex.js";
import { ModelError } from "./provider.js";

const request: ModelRequest = {
  system: "SYSTEM sentinel: preserve the owner's exact intent.",
  messages: [
    { role: "user", content: "USER sentinel: inspect the blue service." },
    { role: "assistant", content: "ASSISTANT sentinel: which workspace?" },
    { role: "user", content: "SECOND USER sentinel: the orchard." },
  ],
  workspaces: ["orchard", "attic"],
};

const expectedReply = {
  text: "The blue service is ready to inspect.",
  coding: { workspace: "orchard", goal: "Inspect only the blue service" },
  reaction: "🔎",
};

interface FakeRecord {
  args: string[];
  stdin: string;
  cwd: string;
  cwdEntries: string[];
  env: Record<string, string>;
  schema: unknown;
  schemaPath: string;
  answerPath: string;
  pid?: number;
  childPid?: number;
}

interface FakeCodex {
  executable: string;
  home: string;
  recordPath: string;
  root: string;
}

const roots = new Set<string>();
const inheritedSecrets = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_BASE_URL",
  "MCP_PRIVATE_TOKEN",
] as const;
const originalSecrets = new Map(
  inheritedSecrets.map((name) => [name, process.env[name]]),
);

async function makeFakeCodex(body: string): Promise<FakeCodex> {
  const root = await mkdtemp(join(tmpdir(), "june-codex-test-"));
  roots.add(root);
  const executable = join(root, "fake codex;false.mjs");
  const home = join(root, "auth-home");
  const recordPath = join(root, "record.json");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import fs from "node:fs";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;
const schemaPath = args[args.indexOf("--output-schema") + 1];
const answerPath = args[args.indexOf("--output-last-message") + 1];
const recordPath = ${JSON.stringify(recordPath)};
const saveRecord = (extra = {}) => fs.writeFileSync(recordPath, JSON.stringify({
  args,
  stdin,
  cwd: process.cwd(),
  cwdEntries: fs.readdirSync(process.cwd()),
  env: process.env,
  schema: JSON.parse(fs.readFileSync(schemaPath, "utf8")),
  schemaPath,
  answerPath,
  ...extra,
}));
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const writeAnswer = (answer) => fs.writeFileSync(
  answerPath,
  typeof answer === "string" ? answer : JSON.stringify(answer),
);
saveRecord();
${body}
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  return { executable, home, recordPath, root };
}

function successfulBody(reply: unknown = expectedReply): string {
  return `
emit({ type: "thread.started", thread_id: "thread-fixture" });
emit({ type: "turn.started" });
emit({
  type: "item.started",
  item: {
    id: "plan-fixture",
    type: "todo_list",
    items: [{ text: "Compose the reply", completed: false }],
  },
});
emit({
  type: "item.completed",
  item: {
    id: "plan-fixture",
    type: "todo_list",
    items: [{ text: "Compose the reply", completed: true }],
  },
});
const answer = ${JSON.stringify(reply)};
writeAnswer(answer);
emit({
  type: "item.completed",
  item: { id: "message-fixture", type: "agent_message", text: JSON.stringify(answer) },
});
emit({
  type: "turn.completed",
  usage: {
    input_tokens: 37,
    cached_input_tokens: 11,
    cache_write_input_tokens: 0,
    output_tokens: 23,
    reasoning_output_tokens: 5,
  },
});
`;
}

async function readRecord(path: string): Promise<FakeRecord> {
  return JSON.parse(await readFile(path, "utf8")) as FakeRecord;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function caughtModelError(
  promise: Promise<unknown>,
): Promise<ModelError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ModelError);
    return error as ModelError;
  }
  throw new Error("Expected the Codex provider request to reject");
}

afterEach(async () => {
  for (const [name, value] of originalSecrets) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  await Promise.all(
    [...roots].map(async (root) => {
      await rm(root, { recursive: true, force: true });
      roots.delete(root);
    }),
  );
});

describe("createCodexProvider", () => {
  it("runs an isolated ephemeral exec and returns the validated last message", async () => {
    for (const name of inheritedSecrets) {
      process.env[name] = `private-${name.toLowerCase()}`;
    }
    const fake = await makeFakeCodex(successfulBody());
    const provider = createCodexProvider({
      model: "gpt-fixture",
      home: fake.home,
      executable: fake.executable,
      timeoutMs: 5_000,
    });

    await expect(provider.reply(request)).resolves.toEqual(expectedReply);

    const record = await readRecord(fake.recordPath);
    const normalizedArgs = record.args.map((argument) => {
      if (argument === record.schemaPath) return "<schema>";
      if (argument === record.answerPath) return "<answer>";
      return argument;
    });
    expect(normalizedArgs).toEqual([
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--strict-config",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--json",
      "--model",
      "gpt-fixture",
      "-c",
      'approval_policy="never"',
      "-c",
      'web_search="disabled"',
      "-c",
      "project_doc_max_bytes=0",
      "-c",
      'shell_environment_policy.inherit="none"',
      "--enable",
      "skip_host_skill_discovery",
      "--disable",
      "shell_tool",
      "--disable",
      "apps",
      "--disable",
      "plugins",
      "--disable",
      "tool_suggest",
      "--disable",
      "browser_use",
      "--disable",
      "browser_use_external",
      "--disable",
      "browser_use_full_cdp_access",
      "--disable",
      "in_app_browser",
      "--disable",
      "computer_use",
      "--disable",
      "multi_agent",
      "--disable",
      "multi_agent_v2",
      "--disable",
      "view_image",
      "--disable",
      "image_generation",
      "--disable",
      "hooks",
      "--disable",
      "skill_search",
      "--disable",
      "skill_mcp_dependency_install",
      "--disable",
      "code_mode",
      "--disable",
      "code_mode_host",
      "--disable",
      "goals",
      "--disable",
      "sleep_tool",
      "--disable",
      "auth_elicitation",
      "--disable",
      "standalone_web_search",
      "--disable",
      "network_proxy",
      "--output-schema",
      "<schema>",
      "--output-last-message",
      "<answer>",
      "-",
    ]);
    expect(record.args).not.toContain("login");
    expect(record.args).not.toContain("--device-auth");
    expect(record.args.join(" ")).not.toContain("SYSTEM sentinel");
    expect(record.args.join(" ")).not.toContain("USER sentinel");
    expect(record.stdin).toContain(request.system);
    expect(record.stdin).toContain(request.messages[0]?.content);
    expect(record.stdin).toContain(request.messages[1]?.content);
    expect(record.stdin).toContain(request.messages[2]?.content);

    expect(isAbsolute(record.cwd)).toBe(true);
    expect(record.cwd).not.toBe(process.cwd());
    expect(record.cwdEntries).toEqual([]);
    expect(dirname(record.schemaPath)).toBe(dirname(record.cwd));
    expect(dirname(record.answerPath)).toBe(dirname(record.cwd));
    expect(record.schema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        text: {
          type: "string",
          description: "Must be no more than 3500 Unicode characters.",
        },
        coding: {
          type: ["object", "null"],
          additionalProperties: false,
          properties: {
            workspace: { type: "string", enum: ["orchard", "attic"] },
            goal: {
              type: "string",
              description:
                "Must contain at least one non-whitespace character.",
            },
          },
          required: ["workspace", "goal"],
        },
        reaction: { type: ["string", "null"] },
      },
      required: ["text", "coding", "reaction"],
    });

    expect(record.env.CODEX_HOME).toBe(fake.home);
    expect(
      Object.keys(record.env).every((name) =>
        [
          "CODEX_HOME",
          "PATH",
          "LANG",
          "LC_ALL",
          "LC_CTYPE",
          "TZ",
          "SSL_CERT_FILE",
          "SSL_CERT_DIR",
          "NODE_EXTRA_CA_CERTS",
        ].includes(name),
      ),
    ).toBe(true);
    for (const name of inheritedSecrets) {
      expect(record.env[name]).toBeUndefined();
    }

    expect(await exists(dirname(record.cwd))).toBe(false);
    expect(await exists(record.cwd)).toBe(false);
    expect(await exists(record.schemaPath)).toBe(false);
    expect(await exists(record.answerPath)).toBe(false);
  });

  it("rejects a failed generation without exposing process output and cleans its workspace", async () => {
    const fake = await makeFakeCodex(`
emit({ type: "thread.started", thread_id: "thread-error" });
emit({ type: "turn.started" });
emit({
  type: "turn.failed",
  error: { message: "private provider failure containing secret-token" },
});
process.stderr.write("stderr secret-token and private conversation", () => {
  process.exitCode = 23;
});
`);

    const error = await caughtModelError(
      createCodexProvider({
        model: "gpt-fixture",
        home: fake.home,
        executable: fake.executable,
      }).reply(request),
    );

    expect(error).toMatchObject({
      code: "generation_failed",
      retryable: true,
      message: "Model provider request failed (generation_failed)",
    });
    expect(String(error)).not.toContain("secret-token");
    expect(String(error)).not.toContain("private conversation");
    const record = await readRecord(fake.recordPath);
    expect(await exists(dirname(record.cwd))).toBe(false);
  });

  it("rejects malformed structured output instead of returning untrusted JSON", async () => {
    const fake = await makeFakeCodex(`
emit({ type: "thread.started", thread_id: "thread-malformed" });
emit({ type: "turn.started" });
writeAnswer("{ private malformed answer");
emit({
  type: "item.completed",
  item: { id: "message-malformed", type: "agent_message", text: "private malformed answer" },
});
emit({ type: "turn.completed", usage: {
  input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0,
  output_tokens: 1, reasoning_output_tokens: 0,
} });
`);

    const error = await caughtModelError(
      createCodexProvider({
        model: "gpt-fixture",
        home: fake.home,
        executable: fake.executable,
      }).reply(request),
    );

    expect(error).toMatchObject({
      code: "malformed_response",
      retryable: false,
    });
    expect(String(error)).not.toContain("private malformed answer");
    const record = await readRecord(fake.recordPath);
    expect(await exists(dirname(record.cwd))).toBe(false);
  });

  it("rejects a stream that ends without turn completion as truncated", async () => {
    const fake = await makeFakeCodex(`
emit({ type: "thread.started", thread_id: "thread-truncated" });
emit({ type: "turn.started" });
writeAnswer({ text: "A partial answer must not escape." });
emit({
  type: "item.completed",
  item: { id: "message-partial", type: "agent_message", text: "partial" },
});
`);

    const error = await caughtModelError(
      createCodexProvider({
        model: "gpt-fixture",
        home: fake.home,
        executable: fake.executable,
      }).reply(request),
    );

    expect(error).toMatchObject({ code: "truncated", retryable: false });
    expect(String(error)).not.toContain("partial answer");
    const record = await readRecord(fake.recordPath);
    expect(await exists(dirname(record.cwd))).toBe(false);
  });

  it("never retries an unexpected substantive tool event, even if the process times out", async () => {
    const fake = await makeFakeCodex(`
emit({ type: "thread.started", thread_id: "thread-tool" });
emit({ type: "turn.started" });
emit({
  type: "item.started",
  item: {
    id: "command-fixture",
    type: "command_execution",
    command: "printf private-tool-output",
    aggregated_output: "",
    exit_code: null,
    status: "in_progress",
  },
});
setInterval(() => {}, 1000);
`);

    const error = await caughtModelError(
      createCodexProvider({
        model: "gpt-fixture",
        home: fake.home,
        executable: fake.executable,
        timeoutMs: 200,
      }).reply(request),
    );

    expect(error).toMatchObject({
      code: "unexpected_tool_use",
      retryable: false,
    });
    expect(String(error)).not.toContain("private-tool-output");
    const record = await readRecord(fake.recordPath);
    expect(await exists(dirname(record.cwd))).toBe(false);
  });

  it("kills the process group at timeout and cleans paths before rejecting", async () => {
    const markerRoot = await mkdtemp(join(tmpdir(), "june-codex-marker-"));
    roots.add(markerRoot);
    const marker = join(markerRoot, "grandchild-survived");
    const fake = await makeFakeCodex(`
const child = spawn(process.execPath, [
  "-e",
  ${JSON.stringify(`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "survived"), 700); setInterval(() => {}, 1000);`)},
], { stdio: "ignore" });
saveRecord({ pid: process.pid, childPid: child.pid });
setInterval(() => {}, 1000);
`);

    const error = await caughtModelError(
      createCodexProvider({
        model: "gpt-fixture",
        home: fake.home,
        executable: fake.executable,
        timeoutMs: 200,
      }).reply(request),
    );

    expect(error).toMatchObject({ code: "timeout", retryable: true });
    const record = await readRecord(fake.recordPath);
    expect(record.pid).toBeTypeOf("number");
    expect(record.childPid).toBeTypeOf("number");
    expect(await exists(dirname(record.cwd))).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(await exists(marker)).toBe(false);
  });

  it("bounds process output and terminates a noisy process", async () => {
    const fake = await makeFakeCodex(`
process.stderr.write("sensitive-output".repeat(100_000));
setInterval(() => {}, 1000);
`);

    const error = await caughtModelError(
      createCodexProvider({
        model: "gpt-fixture",
        home: fake.home,
        executable: fake.executable,
        timeoutMs: 5_000,
      }).reply(request),
    );

    expect(error).toMatchObject({
      code: "response_too_large",
      retryable: true,
    });
    expect(String(error)).not.toContain("sensitive-output");
    const record = await readRecord(fake.recordPath);
    expect(await exists(dirname(record.cwd))).toBe(false);
  });

  it("uses the same opt-in search contract for Codex without exposing search results", async () => {
    const fake = await makeFakeCodex(`
writeAnswer({ text: "", search: "heron", coding: null, reaction: null });
emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
`);
    const provider = createCodexProvider({
      model: "gpt-fixture",
      home: fake.home,
      executable: fake.executable,
    });
    await expect(
      provider.reply({ ...request, searchAvailable: true }),
    ).resolves.toEqual({ text: "", search: "heron" });
    expect((await readRecord(fake.recordPath)).schema).toMatchObject({
      required: ["text", "coding", "reaction", "search"],
      properties: { search: { type: ["string", "null"] } },
    });
    await expect(provider.reply(request)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("requires an absolute dedicated home before starting a process", () => {
    expect(() =>
      createCodexProvider({
        model: "gpt-fixture",
        home: "relative/codex-home",
        executable: "/path/that/must/not/run",
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "ModelError",
        code: "invalid_configuration",
        retryable: false,
      }),
    );
  });
});
