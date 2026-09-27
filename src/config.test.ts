import { describe, expect, it } from "vitest";
import { parseConfig, secret } from "./config.js";

const input = {
  owner: {
    id: "raygen",
    identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
  },
  model: {
    protocol: "openai",
    model: "configured-model",
    apiKeyEnv: "MODEL_KEY",
  },
  slack: {
    teamId: "T1",
    botUserId: "B1",
    signingSecretEnv: "SLACK_SECRET",
    botTokenEnv: "SLACK_TOKEN",
  },
};

describe("configuration boundary", () => {
  it("defaults to loopback and disables native coding", () => {
    const config = parseConfig(input);
    expect(config.host).toBe("127.0.0.1");
    expect(config.coding.enabled).toBe(false);
    expect(config.coding.runtime).toBeUndefined();
    expect(config.coding.workspaces).toEqual({});
    expect(config.console).toBeUndefined();
    expect(config.capabilities).toBeUndefined();
    expect(
      parseConfig({
        ...input,
        capabilities: { directory: "/private/capabilities" },
      }).capabilities,
    ).toEqual({ directory: "/private/capabilities" });
    for (const capabilities of [
      { directory: "./relative" },
      { directory: "/private/capabilities", tools: { all: true } },
    ])
      expect(() => parseConfig({ ...input, capabilities })).toThrow();
    expect(config.browser).toEqual({
      enabled: false,
      readOperations: [],
      timeoutMs: 15000,
    });
    expect(config.owner.identities).toEqual([
      { channel: "slack", accountId: "T1", senderId: "U08R4KDL6UF" },
    ]);
  });
  it("requires explicit isolation for browser reads and rejects credential or mutation recipes", () => {
    const recipe = {
      name: "public-status",
      account: "anonymous",
      item: "public-page",
      origin: "https://status.example",
      url: "https://status.example/",
      requests: [{ url: "https://status.example/", method: "GET" }],
      success: { selector: "#ok", text: "done" },
    };
    const execution = {
      kind: "isolated-host",
      home: "/run/june-browser/home",
      tempDirectory: "/run/june-browser/tmp",
      processIsolationAcknowledged: true,
      networkIsolationAcknowledged: true,
      ephemeralStorageAcknowledged: true,
      resourceLimitsAcknowledged: true,
    };
    const browser = { enabled: true, readOperations: [recipe], execution };
    const configured = {
      ...input,
      capabilities: { directory: "/private/broker" },
    };
    expect(parseConfig({ ...configured, browser }).browser.enabled).toBe(true);
    expect(
      parseConfig({
        ...configured,
        browser: { readOperations: [recipe], execution },
      }).browser.enabled,
    ).toBe(false);
    for (const invalid of [
      { ...browser, execution: undefined },
      {
        ...browser,
        execution: { ...execution, networkIsolationAcknowledged: false },
      },
      { ...browser, execution: { ...execution, home: "relative" } },
      { ...browser, readOperations: [] },
      { ...browser, allowLoopbackHttp: true },
      {
        ...browser,
        readOperations: [
          { ...recipe, steps: [{ kind: "click", selector: "button" }] },
        ],
      },
      {
        ...browser,
        readOperations: [
          { ...recipe, requests: [{ url: recipe.url, method: "POST" }] },
        ],
      },
      {
        ...browser,
        readOperations: [
          {
            ...recipe,
            requests: [{ url: recipe.url, method: "GET", credential: true }],
          },
        ],
      },
    ])
      expect(() => parseConfig({ ...configured, browser: invalid })).toThrow();
    expect(() => parseConfig({ ...input, browser })).toThrow();
  });
  it("requires a fixed HTTPS or loopback console origin without URL credentials", () => {
    for (const origin of ["http://127.0.0.1:3080", "https://june.example"])
      expect(parseConfig({ ...input, console: { origin } }).console).toEqual({
        origin,
      });
    for (const origin of [
      "http://192.168.0.215:3080",
      "https://user:secret@june.example",
      "https://june.example/console",
      "https://june.example/",
      "https://june.example?token=secret",
    ])
      expect(() => parseConfig({ ...input, console: { origin } })).toThrow();
  });
  it("requires explicit runtime selection and rejects credential or permission shortcuts", () => {
    const coding = {
      enabled: true,
      workspaces: { june: "/srv/repo" },
      isolation: { june: { worktreeRoot: "/srv/worktrees" } },
    };
    expect(() => parseConfig({ ...input, coding })).toThrow();
    for (const runtime of [
      { kind: "amp" },
      { kind: "codex", home: "/private/codex" },
      {
        kind: "claude",
        apiKeyEnv: "CLAUDE_KEY",
        stateDirectory: "/private/claude",
      },
      {
        kind: "pi",
        executable: "/opt/pi",
        provider: "openai",
        model: "configured-model",
        home: "/private/pi",
        path: "/usr/bin",
        agentDir: "/private/pi/config",
        sessionDir: "/private/pi/sessions",
        hostSandboxAcknowledged: true,
      },
    ]) {
      expect(
        parseConfig({ ...input, coding: { ...coding, runtime } }).coding.runtime
          ?.kind,
      ).toBe(runtime.kind);
      expect(
        parseConfig({ ...input, coding: { runtime } }).coding.enabled,
      ).toBe(false);
      expect(() =>
        parseConfig({
          ...input,
          coding: {
            ...coding,
            runtime: { ...runtime, apiKey: "must-not-accept" },
          },
        }),
      ).toThrow();
    }
    expect(() =>
      parseConfig({
        ...input,
        coding: {
          ...coding,
          runtime: {
            kind: "claude",
            apiKeyEnv: "CLAUDE_KEY",
            stateDirectory: "/private/claude",
            allowedTools: ["*"],
          },
        },
      }),
    ).toThrow();
  });
  it("rejects unused typo fields and missing channels", () => {
    expect(() => parseConfig({ ...input, models: {} })).toThrow();
    expect(() => parseConfig({ ...input, slack: undefined })).toThrow();
  });
  it("keeps on-demand channel search opt-in", () => {
    expect(parseConfig(input).slack?.searchEnabled).toBe(false);
    expect(
      parseConfig({ ...input, slack: { ...input.slack, searchEnabled: true } })
        .slack?.searchEnabled,
    ).toBe(true);
  });
  it("accepts a dedicated ChatGPT subscription provider without an API key", () => {
    const model = {
      protocol: "codex",
      model: "gpt-6-astra",
      home: "/var/lib/june/.codex",
      executable: "/opt/june/current/node_modules/.bin/codex",
    };
    expect(parseConfig({ ...input, model }).model).toEqual(model);
    for (const invalid of [
      { ...model, home: "./.codex" },
      { ...model, apiKeyEnv: "MODEL_KEY" },
      { ...model, baseUrl: "https://example.com" },
    ]) {
      expect(() => parseConfig({ ...input, model: invalid })).toThrow();
    }
  });
  it("requires explicit setup mode for a channel-free host and forbids active channels or coding in that mode", () => {
    const setup = {
      ...input,
      setupMode: true,
      slack: undefined,
      owner: { id: "raygen", identities: [] },
    };
    expect(parseConfig(setup).setupMode).toBe(true);
    expect(() => parseConfig({ ...setup, setupMode: false })).toThrow();
    expect(() => parseConfig({ ...setup, slack: input.slack })).toThrow();
    expect(() =>
      parseConfig({
        ...setup,
        coding: { enabled: true, workspaces: { june: "/opt/june" } },
      }),
    ).toThrow();
  });
  it("rejects ambiguous identities and relative execution paths", () => {
    expect(() =>
      parseConfig({
        ...input,
        owner: {
          ...input.owner,
          identities: [...input.owner.identities, ...input.owner.identities],
        },
      }),
    ).toThrow();
    expect(() =>
      parseConfig({
        ...input,
        coding: { enabled: true, workspaces: { app: "../other" } },
      }),
    ).toThrow();
  });
  it("accepts an explicit local provider but rejects credential-bearing URLs", () => {
    expect(
      parseConfig({
        ...input,
        model: { ...input.model, baseUrl: "http://127.0.0.1:8080/v1" },
      }).model,
    ).toMatchObject({ baseUrl: "http://127.0.0.1:8080/v1" });
    expect(() =>
      parseConfig({
        ...input,
        model: { ...input.model, baseUrl: "https://key:secret@example.com/v1" },
      }),
    ).toThrow();
  });
  it("reports a missing secret's name, never other secret values", () => {
    expect(secret("MODEL_KEY", { MODEL_KEY: "private-value" })).toBe(
      "private-value",
    );
    expect(() => secret("MODEL_KEY", { OTHER_KEY: "private-value" })).toThrow(
      "Missing environment variable MODEL_KEY",
    );
  });
});
