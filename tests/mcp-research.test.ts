import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, test, vi } from "vitest";
import type { CompanionReply, ModelRequest } from "../src/core/contracts.js";
import { PRIVATE_REFLECTION_REVIEW_PREFIX } from "../src/core/reflection-review.js";
import { RIVET_REPLY_PREFIX } from "../src/core/rivet.js";
import { replyJsonSchema } from "../src/models/provider.js";
import { McpConnections } from "../src/tools/connections.js";
import { GITHUB_MCP_URL } from "../src/tools/github-oauth.js";
import { PUCK_MCP_URL } from "../src/tools/puck.js";
import { SLACK_BOT_URL } from "../src/tools/slack-bot.js";
import { SLACK_MCP_URL } from "../src/tools/slack-mcp-oauth.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(slackBot = false) {
  const directory = await mkdtemp(join(tmpdir(), "june-mcp-research-"));
  const calls: unknown[] = [];
  const observations: string[] = [];
  const tools: Tool[] = ["lookup", "change", "disabled"].map((name) => ({
    name,
    description: `${name} record`,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  }));
  let result = {
    content: [{ type: "text", text: "Source: https://public.example/report" }],
    structuredContent: { email: "person@public.example" },
  };
  let duringCall = () => {};
  let duringList = () => {};
  let failure: "transport" | "result" | undefined;
  const store = new McpConnections(
    {
      directory,
      key: Buffer.alloc(32, 7),
      owner: "owner",
      origin: "https://june.example",
    },
    {
      ...(slackBot
        ? {
            slackBot: {
              token: "fixture-bot-token",
              teamId: "T1",
              botUserId: "UBOT",
            },
          }
        : {}),
      fetch: async (url, init) => {
        if (String(url).startsWith(SLACK_BOT_URL)) {
          calls.push({ url: String(url) });
          return Response.json({ ok: true, user_id: "UBOT", team_id: "T1" });
        }
        if (init?.method === "DELETE")
          return new Response(null, { status: 204 });
        const message = JSON.parse(String(init?.body));
        if (message.id === undefined)
          return new Response(null, { status: 202 });
        if (message.method === "tools/list") duringList();
        if (message.method === "tools/call") {
          calls.push({ url: String(url), ...message.params });
          duringCall();
          if (failure === "transport")
            throw new Error("private provider failure");
        }
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result:
            message.method === "initialize"
              ? {
                  protocolVersion: "2025-11-25",
                  capabilities: { tools: {} },
                  serverInfo: { name: "fixture", version: "1" },
                }
              : message.method === "tools/list"
                ? { tools }
                : {
                    ...result,
                    ...(failure === "result" ? { isError: true } : {}),
                  },
        });
      },
    },
  );
  cleanups.push(async () => {
    await store.close();
    await rm(directory, { recursive: true });
  });
  const connection = (id: string) => {
    const value = store.list().find((entry) => entry.id === id);
    assert(value);
    return value;
  };
  const enable = async (id: string) => {
    await store.discover(id, connection(id).revision);
    store.permit(id, connection(id).revision, "lookup", "read");
    store.permit(id, connection(id).revision, "change", "approval");
  };
  const add = async (id: string, url = `https://${id}.example/mcp`) => {
    store.add({ name: id, url }, id);
    await enable(id);
    return id;
  };
  const selected = await add("research-selected");
  const unselected = await add("research-unselected");
  const request: ModelRequest = {
    system: "Research public evidence; return findings.",
    messages: [],
    workspaces: [],
    mcpAvailable: true,
    mcpReadScope: { connections: [selected] },
    onMcpObservation: (text) => observations.push(text),
  };
  const call = (id = selected, tool = "lookup", record = "record-9") => ({
    text: "",
    mcp: {
      connection: id,
      tool,
      argumentsJson: JSON.stringify({ id: record }),
    },
  });
  return {
    store,
    selected,
    unselected,
    request,
    calls,
    observations,
    connection,
    enable,
    add,
    call,
    result: (value: typeof result) => {
      result = value;
    },
    duringCall: (fn: () => void) => {
      duringCall = fn;
    },
    duringList: (fn: () => void) => {
      duringList = fn;
    },
    changeContract: () => {
      const tool = tools[0];
      assert(tool);
      tool.description = "Changed contract";
    },
    fail: (value: typeof failure) => {
      failure = value;
    },
  };
}

test("restricted reads expose only selected read contracts and observe the actual evidence before synthesis", async () => {
  const f = await fixture();
  const prompts: ModelRequest[] = [];
  const answer = await f.store
    .wrap({
      async reply(request) {
        prompts.push(request);
        expect(request.onMcpObservation).toBeUndefined();
        if (request.usageStage === "synthesis") {
          expect(f.observations).toHaveLength(1);
          const result = JSON.parse(
            request.system.split("Result (JSON): ")[1] ?? "null",
          );
          const observed = f.observations[0];
          assert(observed);
          expect(JSON.parse(observed)).toEqual({
            text: '{"structuredContent":{"email":"person@public.example"},"text":"Source: https://public.example/report"}',
            truncated: false,
          });
          expect(result).toEqual({
            tool: "lookup",
            ...JSON.parse(observed),
          });
          return {
            text: "Found https://public.example/report and person@public.example.",
          };
        }
        expect(request.mcpPermissionAvailable).toBe(false);
        expect(request.mcpProposalAvailable).toBe(false);
        expect(replyJsonSchema([], request).properties).not.toHaveProperty(
          "mcpPermission",
        );
        expect(replyJsonSchema([], request).properties).not.toHaveProperty(
          "mcpProposal",
        );
        expect(request.system).toContain(f.selected);
        expect(
          request.system.split("\nMCP catalog lookup results")[0],
        ).not.toMatch(
          /research-unselected|change record|disabled record|connection inventory|approval receipts|Puck|slack-bot/,
        );
        if (prompts.length === 1)
          return {
            text: "",
            mcpCatalog: { connection: null, tool: null, offset: 0 },
          };
        const page = JSON.parse(
          request.system.split("\n").at(-1) ?? "null",
        ).result;
        if (prompts.length === 2) {
          expect(
            page.tools.map(
              (tool: {
                connection: string;
                name: string;
                permission: string;
              }) => [tool.connection, tool.name, tool.permission],
            ),
          ).toEqual([[f.selected, "lookup", "read"]]);
          return {
            text: "",
            mcpCatalog: { connection: f.unselected, tool: "lookup", offset: 0 },
          };
        }
        if (prompts.length === 3) {
          expect(page.error).toBe("tool_not_enabled");
          return {
            text: "",
            mcpCatalog: { connection: f.selected, tool: "change", offset: 0 },
          };
        }
        expect(page.error).toBe("tool_not_enabled");
        return f.call();
      },
    })
    .reply(f.request);
  expect(answer.text).toContain("https://public.example/report");
  expect(f.calls).toEqual([
    {
      url: "https://research-selected.example/mcp",
      name: "lookup",
      arguments: { id: "record-9" },
    },
  ]);
  expect(f.store.proposals()).toEqual([]);
});

test.each(["unselected", "approval", "disabled"] as const)(
  "restricted %s calls cannot dispatch or create proposals",
  async (kind) => {
    const f = await fixture();
    const before = f.store.list();
    const reply = await f.store
      .wrap({
        reply: async (request) =>
          request.usageStage === "synthesis"
            ? { text: "unauthorized evidence" }
            : f.call(
                kind === "unselected" ? f.unselected : f.selected,
                kind === "approval"
                  ? "change"
                  : kind === "disabled"
                    ? "disabled"
                    : "lookup",
              ),
      })
      .reply(f.request);
    expect(reply.text).toMatch(/MCP request (denied|unavailable):/);
    expect(f.calls).toEqual([]);
    expect(f.observations).toEqual([]);
    expect(f.store.proposals()).toEqual([]);
    expect(f.store.list()).toEqual(before);
  },
);

test.each([
  "slack",
  "slack-bot",
  "github",
  "amp",
  "aliased-slack",
  "aliased-github",
  "aliased-amp",
])(
  "research excludes the %s private integration even when explicitly selected and read-enabled",
  async (kind) => {
    const f = await fixture(kind === "slack-bot");
    const expiresAt = Date.now() + 3600_000;
    if (kind === "slack")
      f.store.connectSlack({ accessToken: "fixture-token", expiresAt });
    else if (kind === "github")
      f.store.connectGitHub({
        accessToken: "fixture-token",
        expiresAt,
        refreshToken: "fixture-refresh",
        refreshExpiresAt: expiresAt,
        account: "fixture-owner",
      });
    else if (kind === "amp")
      f.store.connectAmp({
        accessToken: "fixture-token",
        expiresAt,
        account: "fixture-owner",
      });
    else if (kind !== "slack-bot")
      await f.add(
        kind,
        kind === "aliased-slack"
          ? SLACK_MCP_URL
          : kind === "aliased-github"
            ? GITHUB_MCP_URL.replace(/\/$/, "")
            : PUCK_MCP_URL,
      );
    if (["slack", "github", "amp"].includes(kind)) await f.enable(kind);
    const before = f.store.list();
    const reply = await f.store
      .wrap({
        async reply(request) {
          expect(request.system).not.toContain(`"connection":"${kind}"`);
          return request.usageStage === "synthesis"
            ? { text: "private integration evidence" }
            : f.call(kind, kind === "slack-bot" ? "auth.test" : "lookup");
        },
      })
      .reply({
        ...f.request,
        mcpReadScope: { connections: [f.selected, kind] },
      });
    expect(reply.text).toMatch(/MCP request (denied|unavailable):/);
    expect(f.calls).toEqual([]);
    expect(f.observations).toEqual([]);
    expect(f.store.proposals()).toEqual([]);
    expect(f.store.list()).toEqual(before);
  },
);

test.each([false, true])(
  "custom research models cannot inspect permissions/receipts or mix directives (catalog first=%s)",
  async (catalogFirst) => {
    const f = await fixture();
    await f.store
      .wrap({
        reply: async (request) =>
          request.usageStage === "synthesis"
            ? { text: "Ordinary write completed." }
            : f.call(f.unselected, "change"),
      })
      .reply({ ...f.request, mcpReadScope: undefined });
    const proposal = f.store.proposals()[0];
    assert(proposal);
    expect(proposal.status).toBe("succeeded");
    expect(f.calls).toHaveLength(1);
    const previousCalls = [...f.calls];
    const before = f.store.proposals();
    const replies: CompanionReply[] = [
      { text: "", mcpPermission: { connection: f.unselected, tool: "change" } },
      { text: "", mcpProposal: { action: "inspect", id: proposal.id } },
      { text: "", mcpProposal: { action: "result", id: proposal.id } },
      { ...f.call(), text: "invalid simultaneous text" },
      {
        ...f.call(),
        mcpPermission: { connection: f.selected, tool: "lookup" },
      },
    ];
    for (const forbidden of replies) {
      const prompts: string[] = [];
      let round = 0;
      await expect(
        f.store
          .wrap({
            async reply(request) {
              prompts.push(request.system);
              if (catalogFirst && round++ === 0)
                return {
                  text: "",
                  mcpCatalog: { connection: null, tool: null, offset: 0 },
                };
              // Mutating a provider's copy cannot expand the host's grants.
              request.mcpPermissionAvailable = true;
              request.mcpProposalAvailable = true;
              return forbidden;
            },
          })
          .reply(f.request),
      ).rejects.toThrow("invalid_response");
      expect(prompts.join("\n")).not.toContain(proposal.id);
      expect(f.calls).toEqual(previousCalls);
      expect(f.observations).toEqual([]);
      expect(f.store.proposals()).toEqual(before);
    }
  },
);

test.each(["empty scope", "MCP disabled", "interaction"])(
  "research cannot regain MCP authority with %s",
  async (kind) => {
    const f = await fixture();
    const request: ModelRequest = {
      ...f.request,
      ...(kind === "empty scope"
        ? { mcpReadScope: { connections: [] } }
        : kind === "MCP disabled"
          ? { mcpAvailable: false }
          : { agentRole: "interaction" }),
    };
    await expect(
      f.store.wrap({ reply: async () => f.call() }).reply(request),
    ).rejects.toThrow();
    expect(f.calls).toEqual([]);
    expect(f.observations).toEqual([]);
    expect(f.store.proposals()).toEqual([]);
  },
);

test.each([
  "before dispatch",
  "during result",
  "cancelled",
  "stale",
  "changed contract",
])("research withholds evidence and observations when %s", async (boundary) => {
  const f = await fixture();
  const controller = new AbortController();
  let current = true;
  const revoke = () =>
    f.store.permit(
      f.selected,
      f.connection(f.selected).revision,
      "lookup",
      "disabled",
    );
  if (boundary === "before dispatch") f.duringList(revoke);
  else if (boundary === "during result") f.duringCall(revoke);
  else if (boundary === "cancelled") f.duringCall(() => controller.abort());
  else if (boundary === "stale")
    f.duringCall(() => {
      current = false;
    });
  else f.changeContract();
  let inferences = 0;
  const reply = await f.store
    .wrap({
      async reply() {
        inferences++;
        return f.call();
      },
    })
    .reply(f.request, controller.signal, () => current);
  expect(inferences).toBe(1);
  expect(reply.text).not.toMatch(/public\.example/);
  expect(f.observations).toEqual([]);
  expect(f.calls).toHaveLength(
    ["before dispatch", "changed contract"].includes(boundary) ? 0 : 1,
  );
  expect(f.store.proposals()).toEqual([]);
});

test.each(["before dispatch", "during result"])(
  "research expiry %s prevents unauthorized calls or observations",
  async (boundary) => {
    const f = await fixture();
    const expiresAt = Date.now() + 60_000;
    const id = f.store.add({
      name: "Expiring research source",
      url: "https://expiring.example/mcp",
      expiresAt,
    });
    await f.enable(id);
    const clock = vi.spyOn(Date, "now");
    try {
      const expire = () => {
        clock.mockReturnValue(expiresAt + 1);
      };
      if (boundary === "before dispatch") f.duringList(expire);
      else f.duringCall(expire);
      const reply = await f.store
        .wrap({
          reply: async (request) =>
            request.usageStage === "synthesis"
              ? { text: "Expired evidence should be withheld." }
              : f.call(id),
        })
        .reply({ ...f.request, mcpReadScope: { connections: [id] } });
      expect(reply.text).toMatch(/MCP request (failed|denied):/);
      expect(f.calls).toHaveLength(boundary === "before dispatch" ? 0 : 1);
      expect(f.observations).toEqual([]);
      expect(f.store.proposals()).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  },
);

test.each([RIVET_REPLY_PREFIX, PRIVATE_REFLECTION_REVIEW_PREFIX])(
  "private inspection markers suppress research synthesis and observation (%s)",
  async (marker) => {
    const f = await fixture();
    f.result({
      content: [{ type: "text", text: `PRIVATE COPY${"x".repeat(13000)}` }],
      structuredContent: { email: marker },
    });
    let inferences = 0;
    const reply = await f.store
      .wrap({
        reply: async () => {
          inferences++;
          return f.call();
        },
      })
      .reply(f.request);
    expect(inferences).toBe(1);
    expect(reply.text).toContain("won't retain or forward");
    expect(reply.text).not.toContain("PRIVATE COPY");
    expect(f.observations).toEqual([]);
    expect(f.calls).toHaveLength(1);
  },
);

test.each(["transport", "result"] as const)(
  "research %s failures stay unknown without retry or observation",
  async (failure) => {
    const f = await fixture();
    f.fail(failure);
    let inferences = 0;
    const reply = await f.store
      .wrap({
        reply: async () => {
          inferences++;
          return f.call();
        },
      })
      .reply({ ...f.request, agentRole: "execution" });
    expect(reply.text).toContain("MCP request unknown:");
    expect(inferences).toBe(1);
    expect(f.calls).toHaveLength(1);
    expect(f.observations).toEqual([]);
    expect(f.store.proposals()).toEqual([]);
  },
);

test("research execution observes at most three reads and final synthesis has no action capabilities", async () => {
  const f = await fixture();
  let reads = 0;
  const reply = await f.store
    .wrap({
      async reply(request) {
        if (request.usageStage === "synthesis") {
          expect(f.observations).toHaveLength(3);
          expect(request.ampThreadsAvailable).toBe(false);
          expect(request.researchAvailable).toBe(false);
          expect(request.telemetryAvailable).toBe(false);
          expect(request.javascriptAvailable).toBe(false);
          expect(request.e2bAvailable).toBe(false);
          expect(request.repositoryReadAvailable).toBe(false);
          const schema = replyJsonSchema([], request);
          for (const key of [
            "ampThread",
            "mcp",
            "mcpCatalog",
            "mcpPermission",
            "mcpProposal",
            "research",
            "javascript",
            "e2b",
            "telemetry",
          ])
            expect(schema.properties).not.toHaveProperty(key);
          return { text: "Three sources checked." };
        }
        expect(request.system).not.toContain("Puck");
        return f.call(f.selected, "lookup", `record-${++reads}`);
      },
    })
    .reply({
      ...f.request,
      agentRole: "execution",
      ampThreadsAvailable: true,
      researchAvailable: true,
      javascriptAvailable: true,
      telemetryAvailable: true,
      e2bAvailable: true,
      repositoryReadAvailable: true,
    });
  expect(reply.text).toBe("Three sources checked.");
  expect(f.calls).toHaveLength(3);
  expect(f.observations).toHaveLength(3);
  expect(f.store.proposals()).toEqual([]);
});

test.each(["permission", "typing"])(
  "restricted synthesis reparses custom %s directives before consuming them",
  async (kind) => {
    const f = await fixture();
    const typing: boolean[] = [];
    const reply = await f.store
      .wrap({
        reply: async (request) =>
          request.usageStage === "synthesis"
            ? {
                text: "",
                ...(kind === "typing"
                  ? { typingEnabled: true }
                  : {
                      mcpPermission: {
                        connection: f.unselected,
                        tool: "change",
                      },
                    }),
              }
            : f.call(),
      })
      .reply({
        ...f.request,
        typingControlAvailable: true,
        onTypingPreference: async (enabled) => {
          typing.push(enabled);
        },
      });
    expect(reply.text).toContain("MCP request failed:");
    expect(typing).toEqual([]);
    expect(f.calls).toHaveLength(1);
    expect(f.observations).toHaveLength(1);
  },
);

test("ordinary MCP reads, immediate ledger writes and permission inspection work without research observations", async () => {
  const f = await fixture();
  const request = { ...f.request, mcpReadScope: undefined };
  const read = await f.store
    .wrap({
      reply: async (input) =>
        input.usageStage === "synthesis"
          ? { text: "Ordinary read." }
          : f.call(f.unselected),
    })
    .reply(request);
  expect(read.text).toBe("Ordinary read.");
  const proposal = await f.store
    .wrap({
      reply: async (input) => {
        if (input.usageStage === "synthesis") {
          expect(input.system).toContain("Fresh MCP execution receipt");
          expect(input.system).toContain("do not repeat it");
          return { text: "Ordinary write completed." };
        }
        return f.call(f.unselected, "change");
      },
    })
    .reply(request);
  expect(proposal.text).toBe("Ordinary write completed.");
  expect(f.store.proposals()).toHaveLength(1);
  expect(f.store.proposals()[0]?.status).toBe("succeeded");
  const permission = await f.store
    .wrap({
      reply: async () => ({
        text: "",
        mcpPermission: { connection: f.unselected, tool: "change" },
      }),
    })
    .reply(request);
  expect(permission.text).toContain('"permission":"approval"');
  expect(f.calls).toHaveLength(2);
  expect(f.calls[1]).toMatchObject({
    name: "change",
    arguments: { id: "record-9" },
  });
  expect(f.observations).toEqual([]);
});
