import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createGitRunner,
  cli,
  executePublish,
  parseArgs,
  resolvePrHandoff,
  runPublish,
  savePublicationPlan,
} from "../scripts/post-recommit-publish.mjs";
import {
  classifyTagLookup,
  nextWorkAdvice,
  prepareNextWorkBranch,
  run as runNextWork,
} from "../scripts/post-merge-next-work.mjs";
import { runWorkflow } from "../scripts/miku-scm-run.mjs";

import { PUBLISH_SCRIPT, git, recordedGit, NEXT_WORK_DATE, mergedScenario, nextWorkOptions, scenario, optionsFor, preparePublicationPlan, applySavedPublication, applyDependencies, windowsApplyDependencies, nativeApplyDependencies } from "./post-recommit-publish-support.mjs";

function packageManifest(version, versionPolicy = { policy: "semver", source: "package.json", tagPrefix: "v", check: "check:version" }) {
  return {
    name: "miku-scm-package-policy-fixture",
    version,
    scripts: { "check:version": "node scripts/validate-version-alignment.mjs --repo ." },
    mikuScm: { version: versionPolicy },
  };
}

test("PR handoff resolves GitHub URL results and deterministic fallbacks", () => {
  const repository = {
    owner: "igapyon",
    repository: "example",
    url: "https://github.com/igapyon/example",
  };
  const branch = "devel-test";
  const creationUrl = "https://github.com/igapyon/example/pull/new/devel-test";
  const expectedArgs = [
    "pr", "list", "--repo", "igapyon/example",
    "--head", branch, "--state", "open", "--limit", "100", "--json", "url",
  ];
  const gh = (payload) => {
    assert.deepEqual(payload, expectedArgs);
    return {
      ok: true,
      stdout: JSON.stringify([{ url: "https://github.com/igapyon/example/pull/7" }]),
    };
  };

  assert.deepEqual(resolvePrHandoff(repository, branch, gh), {
    repository_url: repository.url,
    pr_url: "https://github.com/igapyon/example/pull/7",
    pr_lookup: "confirmed",
  });
  assert.deepEqual(resolvePrHandoff(repository, branch, () => ({ ok: true, stdout: "[]" })), {
    repository_url: repository.url,
    pr_creation_url: creationUrl,
    pr_lookup: "confirmed-none",
  });
  assert.deepEqual(resolvePrHandoff(repository, branch, () => ({
    ok: true,
    stdout: JSON.stringify([
      { url: "https://github.com/igapyon/example/pull/7" },
      { url: "https://github.com/igapyon/example/pull/8" },
    ]),
  })), {
    repository_url: repository.url,
    pr_urls: [
      "https://github.com/igapyon/example/pull/7",
      "https://github.com/igapyon/example/pull/8",
    ],
    pr_lookup: "ambiguous",
  });

  const failed = resolvePrHandoff(repository, branch, () => ({ ok: false, stderr: "offline" }));
  assert.equal(failed.pr_lookup, "unconfirmed");
  assert.equal(failed.pr_creation_url, creationUrl);
  assert.equal(failed.pr_lookup_warning, "offline");

  const malformed = resolvePrHandoff(repository, branch, () => ({
    ok: true,
    stdout: JSON.stringify([{}]),
  }));
  assert.equal(malformed.pr_lookup, "unconfirmed");
  assert.equal(malformed.pr_creation_url, creationUrl);
  assert.match(malformed.pr_lookup_warning, /malformed PR URL metadata/);

  assert.deepEqual(resolvePrHandoff(null, branch, gh), {
    repository_url: "unresolved",
    pr_url: "unresolved",
    pr_lookup: "unresolved",
  });
});

test("preflight is read-only and returns instructions to save a publication plan", async (t) => {
  const state = await scenario(t);
  const before = git(state.repo, "show-ref");
  const result = await runPublish(optionsFor(state), applyDependencies);

  assert.equal(result.status, "preflight-ok");
  assert.deepEqual(result.remote_branch, { state: "absent" });
  assert.ok(result.save_plan_arguments.includes("--save-plan"));
  assert.equal(result.apply_arguments, undefined);
  assert.equal(git(state.repo, "show-ref"), before);
  assert.equal(git(state.repo, "branch", "--show-current"), state.branch);
  assert.equal(git(state.remote, "branch", "--list", state.branch), "");
});

test("plan CLI modes require a fixed plan path and digest", () => {
  const plan = "workplace/miku-scm/ok-push/ok-push-devel-tiga0721kaa-123456789012-202607250900.json";
  const digest = "a".repeat(64);
  const options = parseArgs(["--apply-plan", plan, "--expected-plan-sha256", digest]);
  assert.equal(options.applyPlan, plan);
  assert.equal(options.expectedPlanSha256, digest);
  assert.throws(() => parseArgs(["--apply-plan", "../plan.json", "--expected-plan-sha256", digest]), /plan under/);
  assert.throws(() => parseArgs(["--expected-head", "a".repeat(40), "--save-plan", "--expect-new-remote-branch", "--apply"]), /save-plan/);
});

test("content VERSION.md derives a v-prefixed tag and resets to a on a new date", async (t) => {
  const state = await scenario(t);
  await writeFile(path.join(state.repo, "VERSION.md"), "20260726a\n", "utf8");
  git(state.repo, "add", "VERSION.md");
  git(state.repo, "commit", "-m", "add content version");
  state.expectedHead = git(state.repo, "rev-parse", "HEAD");

  const saved = await preparePublicationPlan(state, "--expect-new-remote-branch");
  const result = await applySavedPublication(state, saved, applyDependencies);

  assert.equal(result.version, "20260726a");
  assert.equal(result.recommended_tag, "v20260726a");
});

test("post-merge advice reads the declared package policy from the pinned base", async (t) => {
  const state = await scenario(t);
  await writeFile(path.join(state.repo, "package.json"), `${JSON.stringify(packageManifest("0.8.2"), null, 2)}\n`, "utf8");
  git(state.repo, "add", "package.json");
  git(state.repo, "commit", "-m", "add package version policy");
  const base = git(state.repo, "rev-parse", "HEAD");
  const advice = await nextWorkAdvice(state.repo, base, "origin", recordedGit([]));

  assert.equal(advice.version, "0.8.2");
  assert.equal(advice.version_source, "package.json");
  assert.equal(advice.recommended_tag, "v0.8.2");
  assert.equal(advice.tag_status, "absent");
});

test("invalid package version policy leaves next-work advice unresolved with a warning", async (t) => {
  const state = await scenario(t);
  await writeFile(path.join(state.repo, "package.json"), `${JSON.stringify(packageManifest("0.8.2", { policy: "semver" }), null, 2)}\n`, "utf8");
  git(state.repo, "add", "package.json");
  git(state.repo, "commit", "-m", "add invalid package version policy");
  const base = git(state.repo, "rev-parse", "HEAD");
  const advice = await nextWorkAdvice(state.repo, base, "origin", recordedGit([]));

  assert.equal(advice.version, "unresolved");
  assert.equal(advice.recommended_tag, "unresolved");
  assert.match(advice.warnings[0], /Configured package version could not be resolved/);
});

test("declared package policy supplies its configured tag after publication", async (t) => {
  const state = await scenario(t);
  await writeFile(path.join(state.repo, "package.json"), `${JSON.stringify(packageManifest("0.8.2"), null, 2)}\n`, "utf8");
  git(state.repo, "add", "package.json");
  git(state.repo, "commit", "-m", "add package version policy");
  state.expectedHead = git(state.repo, "rev-parse", "HEAD");

  const saved = await preparePublicationPlan(state, "--expect-new-remote-branch");
  const result = await applySavedPublication(state, saved, applyDependencies);

  assert.equal(result.status, "published");
  assert.equal(result.version, "0.8.2");
  assert.equal(result.recommended_tag, "v0.8.2");
});

test("invalid package tag advice warns after publication without changing its success status", async (t) => {
  const state = await scenario(t);
  await writeFile(path.join(state.repo, "package.json"), `${JSON.stringify(packageManifest("0.8.2", { policy: "semver" }), null, 2)}\n`, "utf8");
  git(state.repo, "add", "package.json");
  git(state.repo, "commit", "-m", "add invalid package version policy");
  state.expectedHead = git(state.repo, "rev-parse", "HEAD");

  const saved = await preparePublicationPlan(state, "--expect-new-remote-branch");
  const result = await applySavedPublication(state, saved, applyDependencies);

  assert.equal(result.status, "published");
  assert.equal(result.version, "unresolved");
  assert.equal(result.recommended_tag, "unresolved");
  assert.match(result.warnings.at(-1), /Configured package version could not be resolved/);
});
