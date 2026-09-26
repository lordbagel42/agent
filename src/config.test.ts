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
    expect(config.coding.workspaces).toEqual({});
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
