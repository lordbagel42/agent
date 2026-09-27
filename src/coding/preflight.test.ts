import { chmod, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Config } from "../config.js";
import { nativeCodingPreflight } from "./preflight.js";

it("reports closed native gates without treating configuration or sandbox assertions as protected-host acceptance", async () => {
  const coding: Config["coding"] = {
    enabled: false,
    workspaces: {},
    isolation: {},
    timeoutMs: 1000,
  };
  const before = structuredClone(coding);
  const disabled = await nativeCodingPreflight(coding, false, {});
  expect(disabled).toContain("coding.enabled is false");
  expect(disabled).toContain("JUNE_ALLOW_NATIVE_CODING is not 1");
  expect(disabled).toContain("coding.runtime must select");
  expect(disabled).toContain("no permitted workspace");
  expect(disabled).toContain('"supervisor":"unavailable"');
  expect(disabled).toContain('"protectedHostAcceptance":"unverified"');
  expect(coding).toEqual(before);
});

it("inspects fake-host directory constraints without leaking secrets, mutating storage, or claiming execution readiness", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "june-SECRET-preflight-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repo");
  const nested = join(repository, "nested");
  const home = join(root, "home");
  const link = join(root, "link");
  await mkdir(nested, { recursive: true });
  await mkdir(home, { mode: 0o700 });
  await symlink(home, link);
  const coding: Config["coding"] = {
    enabled: false,
    timeoutMs: 1000,
    runtime: {
      kind: "claude",
      stateDirectory: home,
      apiKeyEnv: "SECRET_KEY_NAME",
      allowedTools: [],
      maxTurns: 1,
    },
    workspaces: { SECRET_LABEL: repository, missing: join(root, "missing") },
    isolation: { SECRET_LABEL: { worktreeRoot: nested } },
  };
  await chmod(home, 0o750);
  const constrained = await nativeCodingPreflight(coding, false, {});
  expect(constrained).toContain(
    "Workspace 1: repository/worktree roots overlap",
  );
  expect(constrained).toContain("Workspace 2 repository: directory is missing");
  expect(constrained).toContain(
    "Workspace 2: coding.isolation entry is missing",
  );
  expect(constrained).toContain("group/other permissions must be removed");
  expect(constrained).toContain("apiKeyEnv does not resolve");
  expect(constrained).not.toContain("SECRET");

  await chmod(home, 0o700);
  coding.runtime = { kind: "codex", home: link };
  expect(await nativeCodingPreflight(coding, false, {})).toContain(
    "not a canonical path",
  );
  await mkdir(join(repository, ".git"));
  await chmod(nested, 0o700);
  coding.runtime = { kind: "codex", home: nested };
  expect(await nativeCodingPreflight(coding, false, {})).toContain(
    "private storage must be outside repositories",
  );

  const worktrees = join(root, "worktrees");
  await mkdir(worktrees);
  coding.enabled = true;
  coding.workspaces = { SECRET_LABEL: repository };
  coding.isolation = { SECRET_LABEL: { worktreeRoot: worktrees } };
  coding.runtime = {
    kind: "pi",
    executable: "/SECRET-DO-NOT-EXECUTE",
    provider: "SECRET",
    model: "SECRET",
    home,
    agentDir: home,
    sessionDir: home,
    path: "SECRET",
    hostSandboxAcknowledged: true,
  };
  const before = structuredClone(coding);
  const report = await nativeCodingPreflight(coding, true, {
    JUNE_ALLOW_NATIVE_CODING: "1",
    SECRET_KEY_NAME: "SECRET_VALUE",
  });
  expect(report).toContain('"missing":[]');
  expect(report).toContain('"supervisor":"configured; not sandboxed"');
  expect(report).toContain('"protectedHostAcceptance":"unverified"');
  expect(report).toContain("operator assertion, not evidence");
  expect(report).toContain("authentication/eligibility");
  expect(report).not.toContain("SECRET");
  expect(coding).toEqual(before);
  expect(await readdir(worktrees)).toEqual([]);
  expect(await readdir(home)).toEqual([]);
});
