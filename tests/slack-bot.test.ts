import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { ModelRequest } from "../src/core/contracts.js";
import { McpConnections } from "../src/tools/connections.js";
import { SlackBotAdapter, slackBotTools } from "../src/tools/slack-bot.js";

test("changing the host bot identity revokes saved grants and pending proposals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "june-bot-identity-"));
  const options = {
    directory,
    key: Buffer.alloc(32, 7),
    owner: "owner",
    origin: "https://june.example",
  };
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    calls++;
    throw new Error("must not dispatch");
  };
  let store = new McpConnections(options, {
    fetch,
    slackBot: { token: "test", teamId: "T1", botUserId: "U1" },
  });
  try {
    await store
      .wrap({
        reply: async () => ({
          text: "",
          mcp: {
            connection: "slack-bot",
            tool: "pins.add",
            argumentsJson: '{"channel":"C1","timestamp":"123.456"}',
          },
        }),
      })
      .reply({
        system: "",
        workspaces: [],
        mcpAvailable: true,
      } as unknown as ModelRequest);
    const proposal = store.proposals()[0];
    assert(proposal);
    await store.close();
    store = new McpConnections(options, {
      fetch,
      slackBot: { token: "other", teamId: "T1", botUserId: "U2" },
    });
    expect(
      store.list()[0]?.tools.every((entry) => entry.permission === "disabled"),
    ).toBe(true);
    await expect(store.confirm(proposal.id)).rejects.toThrow(
      "proposal_expired",
    );
    expect(calls).toBe(0);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("June discovers bot tools, proposes pins and canvas edits, and executes only confirmed exact arguments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "june-slack-bot-"));
  const calls: { url: string; body: unknown; authorization: string | null }[] =
    [];
  const store = new McpConnections(
    {
      directory,
      key: Buffer.alloc(32, 5),
      owner: "owner",
      origin: "https://june.example",
    },
    {
      slackBot: { token: "xoxb-test-only", teamId: "T123", botUserId: "U123" },
      fetch: async (url, init) => {
        const body = Object.fromEntries(
          new URLSearchParams(String(init?.body)),
        );
        calls.push({
          url: String(url),
          body: body.changes
            ? { ...body, changes: JSON.parse(body.changes) }
            : body,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return Response.json({ ok: true, team_id: "T123", user_id: "U123" });
      },
    },
  );
  try {
    const connection = store.list().find((entry) => entry.id === "slack-bot");
    expect(
      connection?.tools.find((entry) => entry.contract.name === "pins.add")
        ?.permission,
    ).toBe("approval");
    expect(
      connection?.tools.find((entry) => entry.contract.name === "canvases.edit")
        ?.permission,
    ).toBe("approval");
    expect(
      connection?.tools.find((entry) => entry.contract.name === "pins.list")
        ?.permission,
    ).toBe("read");
    const request = {
      system: "",
      workspaces: [],
      mcpAvailable: true,
    } as unknown as ModelRequest;
    const wrapped = store.wrap({
      reply: async () => ({
        text: "",
        mcp: {
          connection: "slack-bot",
          tool: "pins.add",
          argumentsJson: JSON.stringify({
            channel: "C123",
            timestamp: "123.456",
          }),
        },
      }),
    });
    expect((await wrapped.reply(request)).text).toContain("Nothing has run");
    expect(calls).toEqual([]);
    const proposal = store.proposals()[0];
    assert(proposal);
    expect(await store.confirm(proposal.id)).toBe("succeeded");
    expect(await store.confirm(proposal.id)).toBe("succeeded");
    expect(calls.filter((call) => call.url.endsWith("/pins.add"))).toEqual([
      {
        url: "https://slack.com/api/pins.add",
        body: { channel: "C123", timestamp: "123.456" },
        authorization: "Bearer xoxb-test-only",
      },
    ]);
    const latest = store.list().find((entry) => entry.id === "slack-bot");
    assert(latest);
    expect(() =>
      store.permit(latest.id, latest.revision, "pins.add", "read"),
    ).toThrow();
    const canvasArgs = {
      canvas_id: "F123",
      changes: [
        {
          operation: "insert_at_end",
          document_content: {
            type: "markdown",
            markdown: "## Status\nReady for review.",
          },
        },
      ],
    };
    await store
      .wrap({
        reply: async () => ({
          text: "",
          mcp: {
            connection: "slack-bot",
            tool: "canvases.edit",
            argumentsJson: JSON.stringify(canvasArgs),
          },
        }),
      })
      .reply(request);
    const canvasProposal = store.proposals()[0];
    assert(canvasProposal);
    expect(await store.confirm(canvasProposal.id)).toBe("succeeded");
    expect(calls.at(-1)?.body).toEqual(canvasArgs);
    expect(calls.at(-1)?.url).toBe("https://slack.com/api/canvases.edit");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bot reads verify org workspace access, report scoped capabilities and reject credential or authority substitution", async () => {
  let authorized = true;
  let includeWorkspace = true;
  const paths: string[] = [];
  const adapter = new SlackBotAdapter(
    "slack-bot:revision",
    slackBotTools.find((tool) => tool.name === "slack.capabilities"),
    { token: "xoxb-test", teamId: "T123", botUserId: "U123" },
    async (url) => {
      paths.push(String(url));
      return Response.json(
        String(url).endsWith("auth.test")
          ? {
              ok: true,
              user_id: "U123",
              team_id: "E123",
              enterprise_id: "E123",
              is_enterprise_install: true,
            }
          : {
              ok: true,
              teams: includeWorkspace ? [{ id: "T123" }] : [{ id: "T999" }],
            },
        { headers: { "x-oauth-scopes": "chat:write,pins:read" } },
      );
    },
  );
  const action = {
    tool: "mcp",
    account: "slack-bot:revision",
    origin: "https://slack.com",
    item: "slack.capabilities",
    arguments: { method: "pins.add" },
  };
  try {
    const result = JSON.parse(
      (await adapter.read(action, undefined, () => authorized)).text,
    );
    expect(result.grantedScopes).toEqual(["chat:write", "pins:read"]);
    expect(result.methods).toEqual([
      {
        name: "pins.add",
        readOnly: false,
        scopeAlternatives: ["pins:write"],
        missingScopeAlternatives: ["pins:write"],
      },
    ]);
    expect(paths).toEqual([
      "https://slack.com/api/auth.test",
      "https://slack.com/api/auth.teams.list",
    ]);
    includeWorkspace = false;
    await expect(adapter.read(action, undefined, () => true)).rejects.toThrow();
    const before = paths.length;
    await expect(
      adapter.read(
        { ...action, origin: "https://attacker.example" },
        undefined,
        () => true,
      ),
    ).rejects.toThrow();
    await expect(
      adapter.read(
        { ...action, arguments: { token: "xoxp-owner" } },
        undefined,
        () => true,
      ),
    ).rejects.toThrow();
    authorized = false;
    await expect(
      adapter.read(action, undefined, () => authorized),
    ).rejects.toThrow();
    expect(paths).toHaveLength(before);
  } finally {
    await adapter.close();
  }
});

test("June pages the bot catalog and synthesizes a read, while private turns, revocation and disconnect survive restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "june-slack-state-"));
  const options = {
    directory,
    key: Buffer.alloc(32, 9),
    owner: "owner",
    origin: "https://june.example",
  };
  let calls = 0;
  const dependencies = {
    slackBot: { token: "xoxb-test", teamId: "T123", botUserId: "U123" },
    fetch: async () => {
      calls++;
      return Response.json(
        { ok: true, user_id: "U123", team_id: "T123" },
        { headers: { "x-oauth-scopes": "pins:read" } },
      );
    },
  };
  let store = new McpConnections(options, dependencies);
  const request = {
    system: "",
    workspaces: [],
    mcpAvailable: true,
  } as unknown as ModelRequest;
  try {
    let round = 0;
    const answer = await store
      .wrap({
        reply: async (input) => {
          round++;
          if (round === 1)
            return {
              text: "",
              mcpCatalog: {
                connection: "slack-bot",
                tool: "slack.capabilities",
                offset: 0,
              },
            };
          if (round === 2) {
            expect(input.system).toContain("contractJson");
            return {
              text: "",
              mcp: {
                connection: "slack-bot",
                tool: "slack.capabilities",
                argumentsJson: '{"method":"pins.add"}',
              },
            };
          }
          expect(input.mcpAvailable).toBe(false);
          expect(input.system).toContain("pins:write");
          expect(input.system).not.toContain("xoxb-test");
          return { text: "Pinning needs pins:write; no pin was attempted." };
        },
      })
      .reply(request);
    expect(answer.text).toBe("Pinning needs pins:write; no pin was attempted.");
    expect(calls).toBe(1);
    await store
      .wrap({
        reply: async (input) => {
          expect(input.mcpAvailable).toBe(false);
          expect(input.system).not.toContain("slack-bot");
          return { text: "No private tools." };
        },
      })
      .reply({ ...request, mcpAvailable: false });
    const pin = store.wrap({
      reply: async () => ({
        text: "",
        mcp: {
          connection: "slack-bot",
          tool: "pins.add",
          argumentsJson: '{"channel":"C123","timestamp":"123.456"}',
        },
      }),
    });
    await pin.reply(request);
    const proposal = store.proposals()[0];
    const connection = store.list()[0];
    assert(proposal && connection);
    store.permit(connection.id, connection.revision, "pins.add", "disabled");
    await expect(store.confirm(proposal.id)).rejects.toThrow(
      "proposal_expired",
    );
    await store.close();
    store = new McpConnections(options, dependencies);
    expect(
      store.list()[0]?.tools.find((tool) => tool.contract.name === "pins.add")
        ?.permission,
    ).toBe("disabled");
    expect(calls).toBe(1);
    const saved = store.list()[0];
    assert(saved);
    store.disconnect(saved.id, saved.revision);
    await store.close();
    store = new McpConnections(options, dependencies);
    expect(store.list()).toEqual([]);
    const input = { name: "June bot", url: "https://slack.com/api/" };
    expect(store.add(input, "reconnect-command")).toBe("slack-bot");
    expect(store.list()).toHaveLength(1);
    const reconnected = store.list()[0];
    assert(reconnected);
    store.disconnect(reconnected.id, reconnected.revision);
    store.add(input, "reconnect-command");
    expect(store.list()).toEqual([]);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("uncertain bot writes are not retried on repeated confirmation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "june-slack-failure-"));
  let mutations = 0;
  const store = new McpConnections(
    {
      directory,
      key: Buffer.alloc(32, 8),
      owner: "owner",
      origin: "https://june.example",
    },
    {
      slackBot: { token: "xoxb-test", teamId: "T123", botUserId: "U123" },
      fetch: async (url) => {
        if (String(url).endsWith("pins.add")) {
          mutations++;
          throw new Error("connection_lost_after_dispatch");
        }
        return Response.json({ ok: true, team_id: "T123", user_id: "U123" });
      },
    },
  );
  try {
    await store
      .wrap({
        reply: async () => ({
          text: "",
          mcp: {
            connection: "slack-bot",
            tool: "pins.add",
            argumentsJson: '{"channel":"C123","timestamp":"123.456"}',
          },
        }),
      })
      .reply({
        system: "",
        workspaces: [],
        mcpAvailable: true,
      } as unknown as ModelRequest);
    const proposal = store.proposals()[0];
    assert(proposal);
    expect(await store.confirm(proposal.id)).toBe("unknown");
    expect(await store.confirm(proposal.id)).toBe("unknown");
    expect(mutations).toBe(1);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("file upload is one approved operation, sends UTF-8 bytes only to Slack's signed host and never forwards the bot token", async () => {
  const sent: { url: string; init?: RequestInit }[] = [];
  const adapter = new SlackBotAdapter(
    "slack-bot:r",
    slackBotTools.find((tool) => tool.name === "files.uploadContent"),
    { token: "xoxb-test", teamId: "T123", botUserId: "U123" },
    async (url, init) => {
      sent.push({ url: String(url), init });
      if (String(url).endsWith("auth.test"))
        return Response.json({ ok: true, user_id: "U123", team_id: "T123" });
      if (String(url).endsWith("files.getUploadURLExternal"))
        return Response.json({
          ok: true,
          file_id: "F123",
          upload_url: "https://files.slack.com/upload/v1/signed",
        });
      if (String(url).startsWith("https://files.slack.com/"))
        return new Response("OK");
      return Response.json({ ok: true });
    },
  );
  try {
    await adapter.execute(
      {
        tool: "mcp",
        account: "slack-bot:r",
        origin: "https://slack.com",
        item: "files.uploadContent",
        arguments: {
          filename: "note.txt",
          content: "héllo",
          channel_id: "C123",
        },
      },
      undefined,
      () => true,
    );
    expect(sent.map((call) => call.url)).toEqual([
      "https://slack.com/api/auth.test",
      "https://slack.com/api/files.getUploadURLExternal",
      "https://files.slack.com/upload/v1/signed",
      "https://slack.com/api/files.completeUploadExternal",
    ]);
    expect(new URLSearchParams(String(sent[1]?.init?.body)).get("length")).toBe(
      "6",
    );
    expect(Buffer.from(sent[2]?.init?.body as Uint8Array).toString()).toBe(
      "héllo",
    );
    expect(new Headers(sent[2]?.init?.headers).get("authorization")).toBeNull();
    const completion = new URLSearchParams(String(sent[3]?.init?.body));
    expect(JSON.parse(completion.get("files") ?? "null")).toEqual([
      { id: "F123", title: "note.txt" },
    ]);
    expect(completion.get("channel_id")).toBe("C123");
  } finally {
    await adapter.close();
  }
});
