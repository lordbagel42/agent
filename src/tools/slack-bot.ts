import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolAction } from "./broker.js";
import {
  McpAdapterError,
  mcpToolContractDigest,
  safeToolReadResult,
} from "./mcp.js";

export const SLACK_BOT_URL = "https://slack.com/api/";
export interface SlackBotCredential {
  token: string;
  teamId: string;
  botUserId: string;
}

// This is an allowlist, not an arbitrary Slack/HTTP proxy. Scopes separated by
// | are alternatives determined by conversation type. Slack enforces resource
// ownership, membership, plan and workspace policy in addition to these scopes.
const methods: [
  name: string,
  read: boolean,
  scopes: string,
  required: string,
][] = [
  ["slack.capabilities", true, "", ""],
  ["auth.test", true, "", ""],
  ["pins.list", true, "pins:read", "channel"],
  ["pins.add", false, "pins:write", "channel timestamp"],
  ["pins.remove", false, "pins:write", "channel timestamp"],
  ["canvases.create", false, "canvases:write", ""],
  ["canvases.edit", false, "canvases:write", "canvas_id changes"],
  ["canvases.delete", false, "canvases:write", "canvas_id"],
  ["canvases.sections.lookup", true, "canvases:read", "canvas_id criteria"],
  ["canvases.access.set", false, "canvases:write", "canvas_id access_level"],
  ["canvases.access.delete", false, "canvases:write", "canvas_id"],
  ["conversations.canvases.create", false, "canvases:write", "channel_id"],
  ["bookmarks.list", true, "bookmarks:read", "channel_id"],
  ["bookmarks.add", false, "bookmarks:write", "channel_id title type"],
  ["bookmarks.edit", false, "bookmarks:write", "channel_id bookmark_id"],
  ["bookmarks.remove", false, "bookmarks:write", "channel_id bookmark_id"],
  ["chat.postMessage", false, "chat:write", "channel"],
  ["chat.postEphemeral", false, "chat:write", "channel user"],
  ["chat.update", false, "chat:write", "channel ts"],
  ["chat.delete", false, "chat:write", "channel ts"],
  ["chat.scheduleMessage", false, "chat:write", "channel post_at"],
  [
    "chat.deleteScheduledMessage",
    false,
    "chat:write",
    "channel scheduled_message_id",
  ],
  ["chat.scheduledMessages.list", true, "chat:write", ""],
  ["chat.getPermalink", true, "", "channel message_ts"],
  ["chat.meMessage", false, "chat:write", "channel text"],
  ["chat.unfurl", false, "links:write", ""],
  ["chat.startStream", false, "chat:write", "channel thread_ts"],
  ["chat.appendStream", false, "chat:write", "channel ts"],
  ["chat.stopStream", false, "chat:write", "channel ts"],
  ["reactions.get", true, "reactions:read", ""],
  ["reactions.list", true, "reactions:read", ""],
  ["reactions.add", false, "reactions:write", "channel timestamp name"],
  ["reactions.remove", false, "reactions:write", "name"],
  [
    "conversations.info",
    true,
    "channels:read|groups:read|im:read|mpim:read",
    "channel",
  ],
  [
    "conversations.list",
    true,
    "channels:read|groups:read|im:read|mpim:read",
    "",
  ],
  [
    "conversations.members",
    true,
    "channels:read|groups:read|im:read|mpim:read",
    "channel",
  ],
  [
    "conversations.history",
    true,
    "channels:history|groups:history|im:history|mpim:history",
    "channel",
  ],
  [
    "conversations.replies",
    true,
    "channels:history|groups:history|im:history|mpim:history",
    "channel ts",
  ],
  ["conversations.create", false, "channels:manage|groups:write", "name"],
  ["conversations.archive", false, "channels:manage|groups:write", "channel"],
  ["conversations.unarchive", false, "channels:manage|groups:write", "channel"],
  [
    "conversations.rename",
    false,
    "channels:manage|groups:write",
    "channel name",
  ],
  [
    "conversations.setTopic",
    false,
    "channels:manage|groups:write|im:write|mpim:write",
    "channel topic",
  ],
  [
    "conversations.setPurpose",
    false,
    "channels:manage|groups:write|im:write|mpim:write",
    "channel purpose",
  ],
  [
    "conversations.invite",
    false,
    "channels:manage|groups:write|mpim:write",
    "channel users",
  ],
  [
    "conversations.kick",
    false,
    "channels:manage|groups:write|mpim:write",
    "channel user",
  ],
  ["conversations.join", false, "channels:join", "channel"],
  ["conversations.leave", false, "channels:manage|groups:write", "channel"],
  ["conversations.open", false, "im:write|mpim:write", ""],
  ["conversations.close", false, "im:write|mpim:write", "channel"],
  [
    "conversations.mark",
    false,
    "channels:manage|groups:write|im:write|mpim:write",
    "channel ts",
  ],
  ["files.info", true, "files:read", "file"],
  ["files.list", true, "files:read", ""],
  ["files.delete", false, "files:write", "file"],
  ["files.uploadContent", false, "files:write", "filename content"],
  ["files.remote.info", true, "remote_files:read", ""],
  ["files.remote.list", true, "remote_files:read", ""],
  [
    "files.remote.add",
    false,
    "remote_files:write",
    "external_id external_url title",
  ],
  ["files.remote.update", false, "remote_files:write", ""],
  ["files.remote.remove", false, "remote_files:write", ""],
  ["files.remote.share", false, "remote_files:share", "channels"],
  ["slackLists.create", false, "lists:write", "name"],
  ["slackLists.update", false, "lists:write", "id"],
  ["slackLists.items.list", true, "lists:read", "list_id"],
  ["slackLists.items.info", true, "lists:read", "list_id id"],
  ["slackLists.items.create", false, "lists:write", "list_id"],
  ["slackLists.items.update", false, "lists:write", "list_id cells"],
  ["slackLists.items.delete", false, "lists:write", "list_id id"],
  ["slackLists.items.deleteMultiple", false, "lists:write", "list_id ids"],
  ["slackLists.access.set", false, "lists:write", "list_id access_level"],
  ["slackLists.access.delete", false, "lists:write", "list_id"],
  ["slackLists.download.start", false, "lists:read", "list_id"],
  ["slackLists.download.get", true, "lists:read", "list_id job_id"],
  ["users.info", true, "users:read", "user"],
  ["users.list", true, "users:read", ""],
  ["users.lookupByEmail", true, "users:read.email", "email"],
  [
    "users.conversations",
    true,
    "channels:read|groups:read|im:read|mpim:read",
    "",
  ],
  ["users.getPresence", true, "users:read", "user"],
  ["users.profile.get", true, "users.profile:read", ""],
  ["users.setPresence", false, "users:write", "presence"],
  ["bots.info", true, "users:read", ""],
  ["emoji.list", true, "emoji:read", ""],
  ["team.info", true, "team:read", ""],
  ["team.profile.get", true, "users.profile:read", ""],
  ["dnd.info", true, "dnd:read", ""],
  ["dnd.teamInfo", true, "dnd:read", "users"],
  ["usergroups.list", true, "usergroups:read", ""],
  ["usergroups.users.list", true, "usergroups:read", "usergroup"],
  ["usergroups.create", false, "usergroups:write", "name"],
  ["usergroups.update", false, "usergroups:write", "usergroup"],
  ["usergroups.enable", false, "usergroups:write", "usergroup"],
  ["usergroups.disable", false, "usergroups:write", "usergroup"],
  ["usergroups.users.update", false, "usergroups:write", "usergroup users"],
  ["calls.info", true, "calls:read", "id"],
  ["calls.add", false, "calls:write", "external_unique_id join_url"],
  ["calls.update", false, "calls:write", "id"],
  ["calls.end", false, "calls:write", "id"],
  ["calls.participants.add", false, "calls:write", "id users"],
  ["calls.participants.remove", false, "calls:write", "id users"],
  ["views.publish", false, "", "user_id view"],
  ["views.open", false, "", "trigger_id view"],
  ["views.push", false, "", "trigger_id view"],
  ["views.update", false, "", "view"],
];

export const slackBotTools: Tool[] = methods.map(
  ([name, read, scopes, required]) => ({
    name,
    description:
      name === "slack.capabilities"
        ? "Check June's bot identity and currently granted OAuth scopes. Optionally supply method to inspect missing scope alternatives for an exact tool. Use mcpCatalog to list tools. Does not grant permissions."
        : name === "files.uploadContent"
          ? "Upload a small file as June in one approved operation. filename and content are strings; encoding is utf8 (default) or base64. Optional title, channel_id, initial_comment and thread_ts. Maximum 48 KiB decoded content; whole arguments must fit the 64 KiB broker limit. Never accepts local paths or source URLs."
          : `As June's bot: ${name}. ${read ? "Read-only." : "Requires owner approval; may change Slack state."} Scope alternatives: ${scopes || "none additional"}. API parameters and limits: https://docs.slack.dev/reference/methods/${name}/ . Pass Slack arguments directly; never include a token. Pagination is explicit (cursor); results are bounded.`,
    inputSchema: {
      type: "object",
      properties:
        name === "slack.capabilities"
          ? {
              method: {
                type: "string",
                enum: methods.map(([method]) => method),
              },
            }
          : Object.fromEntries(
              required
                .split(" ")
                .filter(Boolean)
                .map((key) => [key, {}]),
            ),
      required: required.split(" ").filter(Boolean),
      additionalProperties: name !== "slack.capabilities",
    },
    annotations: {
      readOnlyHint: read,
      destructiveHint: !read,
      idempotentHint: read,
      openWorldHint: true,
    },
  }),
);

/** Same lifecycle as the remote adapter, with a fixed local method contract.
 * No user OAuth credential, arbitrary endpoint, automatic retry or redirect. */
export class SlackBotAdapter {
  readonly #abort = new AbortController();
  #org = false;
  constructor(
    private readonly account: string,
    private readonly contract: Tool | undefined,
    private readonly bot: SlackBotCredential,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async close() {
    this.#abort.abort();
  }
  async listTools(_credential: unknown): Promise<Tool[]> {
    await this.#identity();
    return structuredClone(slackBotTools);
  }
  async execute(
    action: ToolAction,
    _credential: unknown,
    authorized: () => boolean,
  ) {
    await this.#call(action, authorized, false);
  }
  async read(
    action: ToolAction,
    _credential: unknown,
    authorized: () => boolean,
  ) {
    return safeToolReadResult(
      await this.#call(action, authorized, true),
      this.bot.token,
    );
  }
  async #request(method: string, args: Record<string, unknown>) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(args)) {
      body.set(
        key,
        typeof value === "object" ? JSON.stringify(value) : String(value),
      );
    }
    if (this.#org && !method.startsWith("auth."))
      body.set("team_id", this.bot.teamId);
    const response = await this.fetcher(`${SLACK_BOT_URL}${method}`, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${this.bot.token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.any([
        this.#abort.signal,
        AbortSignal.timeout(20_000),
      ]),
    });
    if (!response.ok || !response.body) throw new McpAdapterError("unknown");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1_048_576) throw new McpAdapterError("unknown");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const result = JSON.parse(Buffer.concat(chunks).toString()) as Record<
      string,
      unknown
    >;
    return { result, scopes: response.headers.get("x-oauth-scopes") };
  }
  async #identity() {
    if (!this.bot.token.startsWith("xoxb-"))
      throw new McpAdapterError("not_started");
    const identity = await this.#request("auth.test", {});
    if (
      identity.result.ok !== true ||
      identity.result.user_id !== this.bot.botUserId
    )
      throw new McpAdapterError("not_started");
    if (identity.result.team_id !== this.bot.teamId) {
      if (
        identity.result.is_enterprise_install !== true ||
        !identity.result.enterprise_id
      )
        throw new McpAdapterError("not_started");
      let cursor = "";
      let found = false;
      for (let page = 0; page < 10; page++) {
        const { result } = await this.#request("auth.teams.list", {
          limit: 1000,
          cursor,
        });
        if (result.ok !== true || !Array.isArray(result.teams)) break;
        if (result.teams.some((team) => team?.id === this.bot.teamId)) {
          found = true;
          break;
        }
        const metadata = result.response_metadata as
          | { next_cursor?: unknown }
          | undefined;
        if (typeof metadata?.next_cursor !== "string" || !metadata.next_cursor)
          break;
        cursor = metadata.next_cursor;
      }
      if (!found) throw new McpAdapterError("not_started");
      this.#org = true;
    }
    return identity;
  }
  async #upload(args: Record<string, unknown>, authorized: () => boolean) {
    const allowed = [
      "filename",
      "content",
      "encoding",
      "title",
      "channel_id",
      "initial_comment",
      "thread_ts",
    ];
    if (
      Object.keys(args).some(
        (key) => !allowed.includes(key) || typeof args[key] !== "string",
      ) ||
      typeof args.filename !== "string" ||
      !args.filename ||
      typeof args.content !== "string" ||
      (args.encoding !== undefined &&
        args.encoding !== "utf8" &&
        args.encoding !== "base64")
    )
      throw new McpAdapterError("not_started");
    const bytes = Buffer.from(
      args.content,
      args.encoding === "base64" ? "base64" : "utf8",
    );
    if (
      !bytes.length ||
      bytes.length > 49_152 ||
      (args.encoding === "base64" && bytes.toString("base64") !== args.content)
    )
      throw new McpAdapterError("not_started");
    if (!authorized()) throw new McpAdapterError("not_started");
    const { result } = await this.#request("files.getUploadURLExternal", {
      filename: args.filename,
      length: bytes.length,
    });
    if (
      result.ok !== true ||
      typeof result.upload_url !== "string" ||
      typeof result.file_id !== "string"
    )
      throw new McpAdapterError("unknown");
    const url = new URL(result.upload_url);
    if (
      url.origin !== "https://files.slack.com" ||
      !url.pathname.startsWith("/upload/") ||
      url.username ||
      url.password ||
      url.hash ||
      !authorized()
    )
      throw new McpAdapterError("unknown");
    const response = await this.fetcher(url.href, {
      method: "POST",
      body: bytes,
      redirect: "error",
      headers: { "content-type": "application/octet-stream" },
      signal: AbortSignal.any([
        this.#abort.signal,
        AbortSignal.timeout(20_000),
      ]),
    });
    await response.body?.cancel();
    if (!response.ok || !authorized()) throw new McpAdapterError("unknown");
    const completion = await this.#request("files.completeUploadExternal", {
      files: [{ id: result.file_id, title: args.title ?? args.filename }],
      ...Object.fromEntries(
        ["channel_id", "initial_comment", "thread_ts"]
          .filter((key) => args[key] !== undefined)
          .map((key) => [key, args[key]]),
      ),
    });
    if (completion.result.ok !== true) throw new McpAdapterError("unknown");
    return completion.result;
  }
  async #call(
    action: ToolAction,
    authorized: () => boolean,
    read: boolean,
  ): Promise<unknown> {
    const method = methods.find(([name]) => name === action.item);
    const canonical = slackBotTools.find((tool) => tool.name === action.item);
    const args = action.arguments;
    if (
      !method ||
      !canonical ||
      !this.contract ||
      mcpToolContractDigest(canonical) !==
        mcpToolContractDigest(this.contract) ||
      action.tool !== "mcp" ||
      action.account !== this.account ||
      action.origin !== "https://slack.com" ||
      (read && !method[1]) ||
      !args ||
      typeof args !== "object" ||
      Array.isArray(args) ||
      Object.hasOwn(args, "token") ||
      (Object.hasOwn(args, "team_id") && args.team_id !== this.bot.teamId) ||
      method[3]
        .split(" ")
        .filter(Boolean)
        .some((key) => !Object.hasOwn(args, key)) ||
      (method[0] === "slack.capabilities" &&
        (Object.keys(args).some((key) => key !== "method") ||
          (args.method !== undefined &&
            !methods.some(([name]) => name === args.method)))) ||
      !authorized()
    )
      throw new McpAdapterError("not_started");
    const identity = await this.#identity();
    if (!authorized() || this.#abort.signal.aborted)
      throw new McpAdapterError("not_started");
    if (method[0] === "slack.capabilities") {
      const granted = identity.scopes
        ?.split(",")
        .map((scope) => scope.trim())
        .filter(Boolean);
      return {
        identity: "June bot (verified)",
        grantedScopes: granted ?? null,
        note: "Scope alternatives depend on resource type; membership, Slack plan and workspace policy still apply. Null scopes means Slack did not return the header. Official user MCP is a separate connection. This does not grant permissions.",
        methods: methods
          .filter(([name]) => name === args.method)
          .map(([name, readOnly, scopes]) => ({
            name,
            readOnly,
            scopeAlternatives: scopes.split("|").filter(Boolean),
            missingScopeAlternatives: granted
              ? scopes
                  .split("|")
                  .filter((scope) => scope && !granted.includes(scope))
              : null,
          })),
      };
    }
    if (method[0] === "files.uploadContent")
      return this.#upload(args, authorized);
    const { result } =
      method[0] === "auth.test"
        ? identity
        : await this.#request(method[0], args);
    if (result.ok !== true) {
      if (!read) throw new McpAdapterError("unknown");
      return {
        ok: false,
        error:
          typeof result.error === "string" &&
          /^[a-z_]{1,80}$/.test(result.error)
            ? result.error
            : "slack_request_failed",
        next: "Inspect slack.capabilities for scopes. Do not switch to owner credentials or retry mutations automatically.",
      };
    }
    return result;
  }
}
