import { z } from "zod";
import { capabilityModules, findCapability } from "./catalog.js";

/** Activation is protected host configuration, not an ordinary settings key.
 * Each source-owned schema stays strict; there is no arbitrary config bag. */
export const capabilityConfigSchema = z.strictObject({
  s01: capabilityModules.s01.configSchema.optional(),
  s02: capabilityModules.s02.configSchema.optional(),
  s03: capabilityModules.s03.configSchema.optional(),
  s04: capabilityModules.s04.configSchema.optional(),
  s05: capabilityModules.s05.configSchema.optional(),
  s06: capabilityModules.s06.configSchema.optional(),
  s07: capabilityModules.s07.configSchema.optional(),
  s08: capabilityModules.s08.configSchema.optional(),
  s09: capabilityModules.s09.configSchema.optional(),
  s10: capabilityModules.s10.configSchema.optional(),
  s11: capabilityModules.s11.configSchema.optional(),
  s12: capabilityModules.s12.configSchema.optional(),
  s13: capabilityModules.s13.configSchema.optional(),
  s14: capabilityModules.s14.configSchema.optional(),
  s15: capabilityModules.s15.configSchema.optional(),
  s16: capabilityModules.s16.configSchema.optional(),
  s17: capabilityModules.s17.configSchema.optional(),
  s18: capabilityModules.s18.configSchema.optional(),
  s19: capabilityModules.s19.configSchema.optional(),
  s20: capabilityModules.s20.configSchema.optional(),
  s21: capabilityModules.s21.configSchema.optional(),
  s22: capabilityModules.s22.configSchema.optional(),
  s23: capabilityModules.s23.configSchema.optional(),
  s24: capabilityModules.s24.configSchema.optional(),
  s25: capabilityModules.s25.configSchema.optional(),
  s26: capabilityModules.s26.configSchema.optional(),
  s27: capabilityModules.s27.configSchema.optional(),
  s28: capabilityModules.s28.configSchema.optional(),
});
export type CapabilityConfig = z.infer<typeof capabilityConfigSchema>;

/** Default on is software activation, never enrollment or permission. */
export function isCapabilityEnabled(
  id: string,
  config: CapabilityConfig | undefined,
): boolean {
  if (!findCapability(id)) return false;
  const namespace = id.split(".")[0] as keyof CapabilityConfig;
  return config?.[namespace]?.enabled !== false;
}
