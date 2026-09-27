import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Config } from "../config.js";

function within(parent: string, child: string) {
  const path = relative(parent, child);
  return (
    !path ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
}

/** Metadata only: never read auth files, execute a CLI/verifier, or create a worktree. */
export async function nativeCodingPreflight(
  coding: Config["coding"],
  supervisorConfigured: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const missing: string[] = [];
  const directories: { field: string; status: string }[] = [];
  const unverified = [
    "Protected-host filesystem/credential separation, network restrictions, process containment and deployment authority separation require independent operator acceptance. No attestation is available to this preflight.",
    "Git checkout roots and shared-repository aliases, runtime installation/authentication/eligibility and verifier execution are not probed.",
    "Supervisor configuration is not job approval, worker liveness, stoppage or permission to resume an uncertain job.",
    "Automatic deployment drain with native coding remains unsupported. Idle or cancelled job status is not settlement authority; legacy sessions and removed workspace roots require independent reconciliation.",
  ];
  if (!coding.enabled)
    missing.push("coding.enabled is false (activation gate closed).");
  if (env.JUNE_ALLOW_NATIVE_CODING !== "1")
    missing.push(
      "JUNE_ALLOW_NATIVE_CODING is not 1 (host opt-in gate closed).",
    );
  if (!supervisorConfigured)
    missing.push("Native coding supervisor is not configured in this process.");
  if (!coding.runtime)
    missing.push("coding.runtime must select an explicit runtime.");

  async function directory(
    field: string,
    path: string,
    privateStorage = false,
  ) {
    let status = "directory exists";
    let canonical: string | undefined;
    try {
      canonical = await realpath(path);
      const metadata = await stat(canonical);
      if (!metadata.isDirectory()) status = "not a directory";
      else if (privateStorage) {
        if (canonical !== path) status = "not a canonical path";
        else if (metadata.uid !== process.getuid?.())
          status = "not owned by service UID";
        else if ((metadata.mode & 0o077) !== 0)
          status = "group/other permissions must be removed";
        else {
          for (let parent = canonical; ; parent = dirname(parent)) {
            const inRepository = await stat(join(parent, ".git")).then(
              () => true,
              (error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
                return false;
              },
            );
            if (inRepository) {
              status = "private storage must be outside repositories";
              break;
            }
            if (parent === dirname(parent)) break;
          }
        }
      }
    } catch (error) {
      status =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "directory is missing"
          : "directory metadata could not be inspected";
    }
    directories.push({ field, status });
    if (status !== "directory exists") {
      missing.push(`${field}: ${status}.`);
      return undefined;
    }
    return canonical;
  }

  const workspaces = Object.entries(coding.workspaces);
  if (!workspaces.length)
    missing.push("coding.workspaces has no permitted workspace.");
  const roots: string[] = [];
  for (const [index, [name, path]] of workspaces.slice(0, 10).entries()) {
    // Ordinals keep operator-controlled labels bounded and out of retained receipts.
    const label = `Workspace ${index + 1}`;
    const repository = await directory(`${label} repository`, path);
    const policy = coding.isolation[name];
    if (!policy) missing.push(`${label}: coding.isolation entry is missing.`);
    const worktree = policy
      ? await directory(`${label} worktreeRoot`, policy.worktreeRoot)
      : undefined;
    for (const root of [repository, worktree]) {
      if (!root) continue;
      if (roots.some((other) => within(root, other) || within(other, root)))
        missing.push(
          `${label}: repository/worktree roots overlap another configured root.`,
        );
      roots.push(root);
    }
    if (policy && !policy.verifier)
      unverified.push(
        `${label}: no independent verifier is configured (optional; worker reports are not verification).`,
      );
  }
  if (
    Object.keys(coding.isolation).some(
      (name) => !Object.hasOwn(coding.workspaces, name),
    )
  )
    missing.push(
      "coding.isolation contains entries without a matching workspace.",
    );
  if (workspaces.length > 10)
    unverified.push(
      "Only the first 10 workspaces were inspected; remaining paths and cross-root overlaps are unverified.",
    );

  const runtime = coding.runtime;
  if (runtime?.kind === "codex")
    await directory("coding.runtime.home", runtime.home, true);
  if (runtime?.kind === "claude") {
    await directory(
      "coding.runtime.stateDirectory",
      runtime.stateDirectory,
      true,
    );
    if (!env[runtime.apiKeyEnv]?.trim())
      missing.push(
        "coding.runtime.apiKeyEnv does not resolve to a nonempty credential.",
      );
  }
  if (runtime?.kind === "pi") {
    for (const field of ["home", "agentDir", "sessionDir"] as const)
      await directory(`coding.runtime.${field}`, runtime[field], true);
    unverified.push(
      "Pi hostSandboxAcknowledged is an operator assertion, not evidence of containment.",
    );
  }
  if (runtime?.kind === "amp")
    unverified.push(
      "Amp can inherit service credentials and host access; a workspace allowlist does not restrict them.",
    );

  return `Native coding preflight at ${new Date().toISOString()}. Read-only; not permission to enable or execute. Keep activation gates closed until separately authorized protected-host acceptance.\n${JSON.stringify(
    {
      enabled: coding.enabled,
      hostOptIn: env.JUNE_ALLOW_NATIVE_CODING === "1",
      supervisor: supervisorConfigured
        ? "configured; not sandboxed"
        : "unavailable",
      runtime: runtime?.kind ?? null,
      protectedHostAcceptance: "unverified",
      workspaces: workspaces.length,
      inspectedWorkspaces: Math.min(workspaces.length, 10),
      missing,
      directories,
      unverified,
    },
  )}\nNo paths, credential names/values, command arguments, auth-file contents or raw errors returned. No configuration changes, worker launch, approval, resume, credential provisioning or network probes performed.`;
}
