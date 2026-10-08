import { z } from "zod";

// Preferences, not authority: no activation gates, credentials, endpoints,
// storage, policy budgets, native execution limits or deployment controls.
export const settingKeys = [
  "model.model",
  "model.reasoningEffort",
  "model.serviceTier",
  "model.maxOutputTokens",
  "model.timeoutMs",
  "deepModel.model",
  "deepModel.reasoningEffort",
  "deepModel.serviceTier",
  "deepModel.maxOutputTokens",
  "deepModel.timeoutMs",
  "continuity.model.model",
  "continuity.model.reasoningEffort",
  "continuity.model.maxOutputTokens",
  "continuity.model.timeoutMs",
  "reflection.model.model",
  "reflection.model.reasoningEffort",
  "reflection.model.maxOutputTokens",
  "reflection.model.timeoutMs",
  "memory.extraction.model",
  "jev.model",
  "jev.timeoutMs",
  "continuity.idleMs",
  "activitySessions.idleMs",
  "reflection.idleMs",
  "reflection.deepMs",
  "reflection.pollMs",
  "browser.timeoutMs",
  "webSearch.timeoutMs",
  "emojiSearch.timeoutMs",
] as const;
export type SettingKey = (typeof settingKeys)[number];
const key = z.enum(settingKeys);
const value = z.union([
  z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/),
  z.number().int().nonnegative().safe(),
]);
export const settingsOverridesSchema = z.partialRecord(key, value);
export type SettingsOverrides = z.infer<typeof settingsOverridesSchema>;
const version = z.number().int().nonnegative().safe();
export const settingsCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("inspect") }),
  z.strictObject({
    action: z.literal("update"),
    expectedVersion: version,
    changes: z
      .array(z.strictObject({ key, value }))
      .min(1)
      .max(settingKeys.length)
      .refine(
        (changes) =>
          new Set(changes.map((change) => change.key)).size === changes.length,
      ),
  }),
  z.strictObject({
    action: z.literal("reset"),
    expectedVersion: version,
    keys: z
      .array(key)
      .min(1)
      .max(settingKeys.length)
      .refine((keys) => new Set(keys).size === keys.length),
  }),
]);
export type SettingsCommand = z.infer<typeof settingsCommandSchema>;

export const SETTINGS_KNOWLEDGE = `Settings operating knowledge: June can inspect and save ordinary runtime preferences through an execution worker's exposed settings action, without owner/private-chat eligibility or compulsory human approval. Judge the request's authority and global impact. Interaction agents delegate; automated events and completion notifications do not gain settings access. Inspect first: the host lists adjustable keys, applicability, baseline, effective and desired values, version and pendingActivation. All unlisted configuration is protected, not implicitly editable. Updates and resets are saved, pending next authorized activation; they never hot-reload, restart June, cancel active work or request a deployment. Do not claim a saved value is running. An operator configuration/binding change invalidates the entire saved override set, without resurrecting older preferences. Inspect after a conflict or uncertain receipt; do not blindly repeat a write. Reset removes only named preferences, returning them to operator configuration on the next activation. Credentials, permissions, feature gates, safety budgets, storage and deployment/recovery controls remain operator-owned. Personality and typing retain their existing interfaces. DEBUGSHARE/recovery Ultra reasoning and mandatory Fast, and ordinary Amp job modes, are not editable preferences. Source support is not live activation or provider support; a model name passing configuration validation is not proof that the provider accepts it. No background process applies changes or sends settings notifications; do not create one.`;

export const SETTINGS_HELP = `Use settings:{"action":"inspect"} with empty text and no other action. To save, use settings:{"action":"update","expectedVersion":VERSION,"changes":[{"key":"model.timeoutMs","value":45000}]}. To remove selected overrides, use settings:{"action":"reset","expectedVersion":VERSION,"keys":["model.timeoutMs"]}. Use only keys marked adjustable and the exact version from inspection. Model effort is low/medium/high (OpenAI/Codex only); serviceTier is fast/default (Codex only); numeric ranges are in the catalogue and full-configuration validation still applies. Reports must distinguish saved desired values from this process's effective values. A write ends this worker action sequence; do not chain effects or arrange a restart.`;
