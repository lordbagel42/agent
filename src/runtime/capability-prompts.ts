import { capabilityKnowledge as s01 } from "./prompt-sections/s01.js";
import { capabilityKnowledge as s02 } from "./prompt-sections/s02.js";
import { capabilityKnowledge as s03 } from "./prompt-sections/s03.js";
import { capabilityKnowledge as s04 } from "./prompt-sections/s04.js";
import { capabilityKnowledge as s05 } from "./prompt-sections/s05.js";
import { capabilityKnowledge as s06 } from "./prompt-sections/s06.js";
import { capabilityKnowledge as s07 } from "./prompt-sections/s07.js";
import { capabilityKnowledge as s08 } from "./prompt-sections/s08.js";
import { capabilityKnowledge as s09 } from "./prompt-sections/s09.js";
import { capabilityKnowledge as s10 } from "./prompt-sections/s10.js";
import { capabilityKnowledge as s11 } from "./prompt-sections/s11.js";
import { capabilityKnowledge as s12 } from "./prompt-sections/s12.js";
import { capabilityKnowledge as s13 } from "./prompt-sections/s13.js";
import { capabilityKnowledge as s14 } from "./prompt-sections/s14.js";
import { capabilityKnowledge as s15 } from "./prompt-sections/s15.js";
import { capabilityKnowledge as s16 } from "./prompt-sections/s16.js";
import { capabilityKnowledge as s17 } from "./prompt-sections/s17.js";
import { capabilityKnowledge as s18 } from "./prompt-sections/s18.js";
import { capabilityKnowledge as s19 } from "./prompt-sections/s19.js";
import { capabilityKnowledge as s20 } from "./prompt-sections/s20.js";
import { capabilityKnowledge as s21 } from "./prompt-sections/s21.js";
import { capabilityKnowledge as s22 } from "./prompt-sections/s22.js";
import { capabilityKnowledge as s23 } from "./prompt-sections/s23.js";
import { capabilityKnowledge as s24 } from "./prompt-sections/s24.js";
import { capabilityKnowledge as s25 } from "./prompt-sections/s25.js";
import { capabilityKnowledge as s26 } from "./prompt-sections/s26.js";
import { capabilityKnowledge as s27 } from "./prompt-sections/s27.js";
import { capabilityKnowledge as s28 } from "./prompt-sections/s28.js";

/** K8 v1: trusted source prose, never a grant or dynamic file/plugin loader.
 * Include blocked/setup knowledge even when the action is unavailable. Each
 * section must preserve its turn's authority and name the continuation owner.
 */
export interface CapabilityKnowledge {
  interaction?: string;
  execution?: string;
  eventDecision?: string;
  notificationOnly?: string;
}

const sections: readonly CapabilityKnowledge[] = [
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
];

export function capabilityKnowledgeForTurn(
  turn: keyof CapabilityKnowledge,
): string {
  return sections
    .map((section) => section[turn]?.trim())
    .filter(Boolean)
    .join("\n\n");
}
