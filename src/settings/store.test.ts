import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseConfig } from "../config.js";
import { SettingsStore } from "./store.js";

const base = parseConfig({
  setupMode: true,
  owner: { id: "owner", identities: [] },
  model: {
    protocol: "openai",
    model: "fixture",
    apiKeyEnv: "PRIVATE_KEY_REFERENCE",
    timeoutMs: 21000,
  },
  webSearch: { provider: "tavily", apiKeyEnv: "PRIVATE_SEARCH_REFERENCE" },
});

it("persists desired changes with CAS while effective settings remain a startup snapshot", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "june-settings-"));
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "settings.sqlite");
  const first = new SettingsStore({ path, base });
  expect(first.run({ action: "inspect" }).version).toBe(0);
  const saved = first.run({
    action: "update",
    expectedVersion: 0,
    changes: [
      { key: "model.timeoutMs", value: 35000 },
      { key: "webSearch.timeoutMs", value: 7000 },
    ],
  });
  expect(saved.status).toBe("saved");
  expect(saved.pendingActivation).toEqual([
    "model.timeoutMs",
    "webSearch.timeoutMs",
  ]);
  expect(first.effective.model.timeoutMs).toBe(21000);
  expect(() =>
    first.run({
      action: "reset",
      expectedVersion: 0,
      keys: ["model.timeoutMs"],
    }),
  ).toThrow("Settings version changed");
  first.close();
  const second = new SettingsStore({ path, base });
  expect(second.effective.model.timeoutMs).toBe(35000);
  expect(second.effective.webSearch?.timeoutMs).toBe(7000);
  expect(second.run({ action: "inspect" }).pendingActivation).toEqual([]);
  const reset = second.run({
    action: "reset",
    expectedVersion: 1,
    keys: ["model.timeoutMs"],
  });
  expect(reset.pendingActivation).toEqual(["model.timeoutMs"]);
  expect(second.effective.model.timeoutMs).toBe(35000);
  second.close();
  const third = new SettingsStore({ path, base });
  expect(third.effective.model.timeoutMs).toBe(21000);
  expect(third.effective.webSearch?.timeoutMs).toBe(7000);
  third.close();
});

it("invalidates overrides on changed operator baseline and never resurrects an older set", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "june-settings-"));
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "settings.sqlite");
  let baselineCurrent = true;
  const first = new SettingsStore({
    path,
    base,
    isBaselineCurrent: () => baselineCurrent,
  });
  first.run({
    action: "update",
    expectedVersion: 0,
    changes: [{ key: "model.timeoutMs", value: 35000 }],
  });
  baselineCurrent = false;
  expect(() =>
    first.run({
      action: "reset",
      expectedVersion: 1,
      keys: ["model.timeoutMs"],
    }),
  ).toThrow("Operator configuration changed");
  first.close();
  const second = new SettingsStore({
    path,
    base: parseConfig({ ...base, model: { ...base.model, timeoutMs: 42000 } }),
  });
  expect(second.effective.model.timeoutMs).toBe(42000);
  expect(second.run({ action: "inspect" })).toMatchObject({
    version: 2,
    invalidation: "operator-baseline-changed",
  });
  second.close();
  const third = new SettingsStore({ path, base });
  expect(third.effective.model.timeoutMs).toBe(21000);
  expect(third.run({ action: "inspect" }).version).toBe(3);
  third.close();
});

it("rejects protected, inapplicable and invalid changes atomically without disclosing configuration", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "june-settings-"));
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SettingsStore({
    path: join(directory, "settings.sqlite"),
    base: parseConfig({
      ...base,
      setupMode: false,
      owner: {
        id: "owner",
        identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
      },
      slack: {
        teamId: "T1",
        botUserId: "B1",
        signingSecretEnv: "SIGNING_SECRET",
        botTokenEnv: "BOT_TOKEN",
        workspaceUrl: "https://fixture.slack.com/",
      },
      memory: { directory, keyEnv: "MEMORY_KEY" },
      reflection: { model: base.model },
    }),
  });
  for (const changes of [
    [{ key: "model.apiKeyEnv", value: "OTHER_SECRET" }],
    [{ key: "executionEnabled", value: false }],
    [{ key: "reflection.policy.maxAttempts", value: 10 }],
    [{ key: "reflection.timeoutMs", value: 65000 }],
    [{ key: "deepModel.timeoutMs", value: 35000 }],
    [{ key: "model.serviceTier", value: "fast" }],
    [
      { key: "model.timeoutMs", value: 35000 },
      { key: "webSearch.timeoutMs", value: 15001 },
    ],
    [{ key: "__proto__.polluted", value: "yes" }],
  ]) {
    expect(() =>
      store.run({ action: "update", expectedVersion: 0, changes }),
    ).toThrow();
    expect(store.run({ action: "inspect" }).version).toBe(0);
  }
  const snapshot = JSON.stringify(store.run({ action: "inspect" }));
  expect(snapshot).not.toContain("PRIVATE_KEY_REFERENCE");
  expect(snapshot).not.toContain("PRIVATE_SEARCH_REFERENCE");
  expect(store.effective.model.timeoutMs).toBe(21000);
  store.close();
});
