import { Schema } from "effect";
import { capabilityModules, findCapability } from "./catalog.js";

/** Activation is protected host configuration, not an ordinary settings key.
 * Each source-owned schema stays strict; there is no arbitrary config bag. */
export const capabilityConfigSchema = Schema.Struct({
  s01: Schema.optional(capabilityModules.s01.configSchema),
  s02: Schema.optional(capabilityModules.s02.configSchema),
  s03: Schema.optional(capabilityModules.s03.configSchema),
  s04: Schema.optional(capabilityModules.s04.configSchema),
  s05: Schema.optional(capabilityModules.s05.configSchema),
  s06: Schema.optional(capabilityModules.s06.configSchema),
  s07: Schema.optional(capabilityModules.s07.configSchema),
  s08: Schema.optional(capabilityModules.s08.configSchema),
  s09: Schema.optional(capabilityModules.s09.configSchema),
  s10: Schema.optional(capabilityModules.s10.configSchema),
  s11: Schema.optional(capabilityModules.s11.configSchema),
  s12: Schema.optional(capabilityModules.s12.configSchema),
  s13: Schema.optional(capabilityModules.s13.configSchema),
  s14: Schema.optional(capabilityModules.s14.configSchema),
  s15: Schema.optional(capabilityModules.s15.configSchema),
  s16: Schema.optional(capabilityModules.s16.configSchema),
  s17: Schema.optional(capabilityModules.s17.configSchema),
  s18: Schema.optional(capabilityModules.s18.configSchema),
  s19: Schema.optional(capabilityModules.s19.configSchema),
  s20: Schema.optional(capabilityModules.s20.configSchema),
  s21: Schema.optional(capabilityModules.s21.configSchema),
  s22: Schema.optional(capabilityModules.s22.configSchema),
  s23: Schema.optional(capabilityModules.s23.configSchema),
  s24: Schema.optional(capabilityModules.s24.configSchema),
  s25: Schema.optional(capabilityModules.s25.configSchema),
  s26: Schema.optional(capabilityModules.s26.configSchema),
  s27: Schema.optional(capabilityModules.s27.configSchema),
  s28: Schema.optional(capabilityModules.s28.configSchema),
});
export type CapabilityConfig = typeof capabilityConfigSchema.Type;

/** Default on is software activation, never enrollment or permission. */
export function isCapabilityEnabled(
  id: string,
  config: CapabilityConfig | undefined,
): boolean {
  if (!findCapability(id)) return false;
  const namespace = id.split(".")[0] as keyof CapabilityConfig;
  return config?.[namespace]?.enabled !== false;
}
