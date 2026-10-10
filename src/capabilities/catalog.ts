import { z } from "zod";
import type { CapabilityDefinition, CapabilityTurn } from "./contracts.js";
import * as s01 from "./modules/s01.js";
import * as s02 from "./modules/s02.js";
import * as s03 from "./modules/s03.js";
import * as s04 from "./modules/s04.js";
import * as s05 from "./modules/s05.js";
import * as s06 from "./modules/s06.js";
import * as s07 from "./modules/s07.js";
import * as s08 from "./modules/s08.js";
import * as s09 from "./modules/s09.js";
import * as s10 from "./modules/s10.js";
import * as s11 from "./modules/s11.js";
import * as s12 from "./modules/s12.js";
import * as s13 from "./modules/s13.js";
import * as s14 from "./modules/s14.js";
import * as s15 from "./modules/s15.js";
import * as s16 from "./modules/s16.js";
import * as s17 from "./modules/s17.js";
import * as s18 from "./modules/s18.js";
import * as s19 from "./modules/s19.js";
import * as s20 from "./modules/s20.js";
import * as s21 from "./modules/s21.js";
import * as s22 from "./modules/s22.js";
import * as s23 from "./modules/s23.js";
import * as s24 from "./modules/s24.js";
import * as s25 from "./modules/s25.js";
import * as s26 from "./modules/s26.js";
import * as s27 from "./modules/s27.js";
import * as s28 from "./modules/s28.js";

/** Source-controlled imports only. No runtime discovery or installed plugin hooks. */
export const capabilityModules = {
  s01,
  s02,
  s03,
  s04,
  s05,
  s06,
  s07,
  s08,
  s09,
  s10,
  s11,
  s12,
  s13,
  s14,
  s15,
  s16,
  s17,
  s18,
  s19,
  s20,
  s21,
  s22,
  s23,
  s24,
  s25,
  s26,
  s27,
  s28,
} as const;
export const capabilityDefinitions: readonly CapabilityDefinition[] =
  Object.entries(capabilityModules).flatMap(([namespace, module]) => {
    for (const definition of module.definitions) {
      if (!definition.id.startsWith(`${namespace}.`))
        throw new Error("Invalid capability namespace");
    }
    return module.definitions;
  });
if (
  new Set(capabilityDefinitions.map(({ id }) => id)).size !==
  capabilityDefinitions.length
)
  throw new Error("Duplicate capability registration");

export function findCapability(id: string): CapabilityDefinition | undefined {
  return capabilityDefinitions.find((definition) => definition.id === id);
}

/** Selection is a ceiling, not authority. The host also checks current ports,
 * configuration and role before dispatch. Empty or unknown IDs deny all. */
export function capabilityCommandSchema(
  ids: readonly string[],
  turn: CapabilityTurn,
) {
  const schemas = capabilityDefinitions
    .filter(
      (definition) =>
        ids.includes(definition.id) &&
        definition.allowedTurns.some((allowed) => allowed === turn),
    )
    .map((definition) =>
      z.strictObject({
        id: z.literal(definition.id),
        command: definition.commandSchema,
      }),
    );
  return schemas.length ? z.union(schemas) : z.never();
}
export type CapabilityCommand = z.infer<
  ReturnType<typeof capabilityCommandSchema>
>;
