import type { CapabilityBroker } from "./broker.js";
import {
  type BrowserAdapter,
  type BrowserOperation,
  browserCredentialOperationSchema,
  browserOperationDigest,
  browserOperationSchema,
} from "./browser.js";

/** Separate opt-in from reads: one literal fill OR one click, never a sequence. */
export const browserMutationSchema = browserOperationSchema.refine((recipe) => {
  const step = recipe.steps[0];
  const writes = recipe.requests.filter((request) => request.method !== "GET");
  return (
    /^[a-z][a-z0-9_-]{0,63}$/u.test(recipe.name) &&
    recipe.steps.length === 1 &&
    (step?.kind === "fill" || step?.kind === "click") &&
    !recipe.requests.some((request) => request.credential) &&
    recipe.outputSelector === undefined &&
    writes.length <= (step.kind === "click" ? 1 : 0) &&
    writes.every((request) => request.maxUses === 1) &&
    // Keep the review small; its final escaped length is also checked below.
    JSON.stringify(recipe).length <= 1400
  );
}, "Mutation requires a short lowercase name, one anonymous fill or click, no implicit submit, at most one one-use write endpoint, and a recipe of at most 1400 JSON characters");

// Reversible JSON escapes prevent platform mentions, formatting and link unfurls.
function reviewJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&`*_~@/.]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** No grants, credential lookup, network access, or execution on the June path. */
export function createBrowserProposal(options: {
  operations: BrowserOperation[];
  credentialOperations?: BrowserOperation[];
  browser: Pick<BrowserAdapter, "action">;
  broker: Pick<CapabilityBroker, "propose">;
}): (operation: string | null) => string {
  const recipes = [
    ...options.operations.map((input) => ({
      recipe: browserMutationSchema.parse(input),
      credentialed: false,
    })),
    ...(options.credentialOperations ?? []).map((input) => ({
      recipe: browserCredentialOperationSchema.parse(input),
      credentialed: true,
    })),
  ];
  const proposals = recipes.map(({ recipe, credentialed }) => {
    const action = options.broker.propose(options.browser.action(recipe.name));
    const expected = {
      tool: "browser",
      account: recipe.account,
      item: recipe.item,
      origin: recipe.origin,
      arguments: {
        operation: recipe.name,
        recipeDigest: browserOperationDigest(recipe),
      },
    };
    if (JSON.stringify(action) !== JSON.stringify(expected))
      throw new Error("browser_proposal_recipe_mismatch");
    // Credential recipes contain only validated references/selectors, never
    // literal fills or output. Project those fields, not a credential/vault item.
    const review = credentialed
      ? {
          name: recipe.name,
          account: recipe.account,
          item: recipe.item,
          origin: recipe.origin,
          url: recipe.url,
          requests: recipe.requests,
          steps: recipe.steps,
          success: recipe.success,
        }
      : recipe;
    const credential = credentialed
      ? {
          credential: {
            kind: recipe.steps.some((step) => step.kind === "login")
              ? "login"
              : "bearer",
            values: "not_exposed",
          },
        }
      : {};
    const report = `Browser proposal only. Nothing ran and no permission was granted. Review the entire recipe and action in escaped JSON below (JSON decoding restores exact values). ${credentialed ? "Credentials are host-resolved only after approval; anonymous grants cannot authorize this recipe." : "A read grant cannot approve this mutation."} The authenticated owner must grant this exact action at /operator/capabilities/grants, then execute it once at /operator/capabilities/grants/:id/execute. Never automatically retry an unknown receipt.\n${reviewJson({ recipe: review, action, ...credential })}`;
    if (report.length > 3500) throw new Error("browser_proposal_too_large");
    return { name: recipe.name, report };
  });
  const catalog = `Configured browser mutation and credential-operation names (escaped JSON): ${reviewJson(proposals.map(({ name }) => name))}. Ask to propose one exact name for review. Nothing ran; configuration is not approval.`;
  if (catalog.length > 3500) throw new Error("browser_proposal_too_large");
  return (operation) => {
    if (operation === null) return catalog;
    const proposal = proposals.find(({ name }) => name === operation);
    if (!proposal) throw new Error("browser_proposal_unavailable");
    return proposal.report;
  };
}
