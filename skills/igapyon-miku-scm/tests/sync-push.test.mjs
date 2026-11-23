import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { applySyncPush, prepareSyncPush, readSyncPushEvidence } from "../scripts/sync-push.mjs";
import { runSyncPull } from "../scripts/sync-pull.mjs";
import { context, hash, loadOperation, operationPath, saveOperation, snapshot } from "../scripts/miku-scm-sync-state.mjs";
import { prepareWritingEvidence } from "../scripts/miku-scm-writing-prepare.mjs";
import { SYNC_PUSH_EVIDENCE_PROFILE } from "../scripts/miku-scm-sync-push-evidence.mjs";
import { fixture } from "./sync-fixture.mjs";
import { draft, preflightPartial } from "./sync-push-support.mjs";

test("sync push repeats fresh checks after a known pre-commit failure", async (t) => {
  const f = await fixture(t);
  await f.write("own.txt", "pending\n");
  const before = f.git(["rev-parse", "HEAD"]);
  let checks = 0;
  const dependencies = { workCommitDependencies: {
    resolveChecks: async () => [{ command: "check", args: [], label: "Repository check" }],
    command: () => ({ ok: ++checks > 1, stderr: "Fix validation" }),
  } };
  const stopped = await prepareSyncPush(f.options, dependencies);
  assert.equal(stopped.status, "partial");
  assert.match(stopped.reason, /Fix validation/);
  assert.equal(stopped.next_command, "miku-scm sync push");
  assert.equal(f.git(["rev-parse", "HEAD"]), before);
  const prepared = await prepareSyncPush(f.options, dependencies);
  assert.equal(prepared.status, "prepared", JSON.stringify(prepared));
  assert.equal(prepared.continuation, "refreshed-after-check-failure");
  assert.equal(checks, 2);
  assert.equal(f.git(["rev-list", "--count", `${before}..HEAD`]), "1");
  assert.equal((await loadOperation(await context(f.repo), stopped.operation_id)).status, "superseded");
});

test("sync push check recovery rechecks sensitive paths and rejects changed history", async (t) => {
  for (const change of ["sensitive", "head", "branch", "commit-stage"]) await t.test(change, async (sub) => {
    const f = await fixture(sub);
    await f.write("own.txt", "pending\n");
    const stopped = await prepareSyncPush(f.options, { workCommitDependencies: {
      resolveChecks: async () => [{ command: "check", args: [], label: "Check" }], command: () => ({ ok: false, stderr: "bad" }),
    } });
    if (change === "sensitive") await f.write("token.ts", "sensitive candidate\n");
    if (change === "head") f.git(["commit", "-m", "Concurrent work"]);
    if (change === "branch") f.git(["switch", "-c", "other-work"]);
    if (change === "commit-stage") {
      const ctx = await context(f.repo);
      const op = await loadOperation(ctx, stopped.operation_id);
      op.commit.result.stage = "commit";
      await saveOperation(ctx, op);
    }
    const r = await prepareSyncPush(f.options);
    assert.equal(r.status, "not-applied");
    if (change === "sensitive") assert.deepEqual(r.sensitive_paths, ["token.ts"]);
    else assert.equal((await loadOperation(await context(f.repo), stopped.operation_id)).status, "partial");
  });
});

test("sync push dirty commits once, prepares evidence, recommits and pushes to done", async (t) => {
  const f = await fixture(t); await f.write("own.txt", "work\n");
  await f.write(".gitignore", "ignored/\n*.cache\n");
  const p = await prepareSyncPush({ ...f.options, message: "Implement work" });
  assert.equal(p.status, "prepared", JSON.stringify(p)); assert.equal(p.commit.status, "created");
  assert.equal(p.warnings.length, 1);
  assert.equal(p.evidence.commit_count, 1); assert.equal(p.evidence.head, p.head);
  const resumed = await prepareSyncPush({ repo: f.repo, resume: p.operation_id, apply: true });
  assert.equal(resumed.status, "prepared", JSON.stringify(resumed)); assert.equal(resumed.plan_sha256, p.plan_sha256); assert.equal(resumed.head, p.head);
  assert.deepEqual(resumed.warnings, p.warnings);
  const options = await draft(f, p);
  const r = await applySyncPush(options);
  assert.equal(r.status, "published", JSON.stringify(r)); assert.equal(r.commit.status, "created"); assert.ok(r.final_branch.endsWith("-done"));
  assert.deepEqual(r.warnings, p.warnings);
  assert.ok(!f.git(["ls-tree", "-r", "--name-only", "HEAD"]).includes("workplace/miku-scm/"));
  assert.equal(f.git(["rev-list", "--left-right", "--count", "HEAD...origin/devel-tiga1026aaa"]).replace(/\s+/g, " "), "0 0");
  assert.equal(f.git(["rev-parse", r.backup_branch]), p.head);
  const again = await applySyncPush(options); assert.equal(again.status, "not-applied");
  assert.equal((await loadOperation(await context(f.repo), p.operation_id)).status, "completed");
});

test("sync push clean committed work skips ordinary commit; empty branch is no-op", async (t) => {
  const f = await fixture(t);
  const empty = await prepareSyncPush(f.options); assert.equal(empty.status, "up-to-date"); assert.equal(empty.mutation_invoked, false);
  await f.commit("own.txt", "own\n"); const before = f.git(["rev-parse", "HEAD"]);
  const p = await prepareSyncPush(f.options); assert.equal(p.status, "prepared", JSON.stringify(p)); assert.equal(p.commit.status, "skipped"); assert.equal(p.head, before);
});

test("small sync push requests a patch once and reuses it", async (t) => {
  const f = await fixture(t);
  await f.commit("small.txt", "small change\n");
  const seen = [];
  const p = await prepareSyncPush(f.options, { writingDependencies: {
    readPatch: async (_root, args, limit) => {
      seen.push({ args, limit });
      return { text: f.git(args), truncated: false };
    },
  } });
  assert.equal(p.status, "prepared", JSON.stringify(p));
  assert.equal(seen.length, 1);
  assert.ok(seen[0].args.includes(`${p.base_commit}..${p.head}`));
  assert.equal(seen[0].args.at(-1), "--");
  assert.equal(seen[0].limit, 24 * 1024);
  assert.equal(p.evidence.patch_truncated, false);
  assert.match(p.evidence.patch_excerpt, /\+small change/);
});

test("compact sync evidence covers large changes while preserving the published tree", async (t) => {
  const f = await fixture(t);
  await f.write("dist/000.min.js", "X\n".repeat(90_000));
  await f.write("package-lock.json", "Y\n".repeat(70_000));
  await f.write("src/feature.js", "export const retries = 3;\n");
  await f.write("test/feature.test.js", "checks the retry limit\n");
  await f.write("docs/notes.md", "Retry failures up to three times.\n");
  await f.write("binary.bin", Buffer.from([0, 4, 254]));
  const p = await prepareSyncPush(f.options, { writingDependencies: {
    readPatch: async (_root, args, limit) => {
      assert.equal(limit, 2 * 1024, "a large range never requests the whole patch");
      assert.match(args.at(-2), /^:\(top,literal\)(src|test|docs)\//);
      return { text: f.git(args), truncated: false };
    },
  } });
  assert.equal(p.status, "prepared", JSON.stringify(p));
  const e = p.evidence;
  assert.equal(p.commit.path_count, 6);
  assert.equal(e.change_summary.file_count, 6);
  assert.equal(e.change_summary.binary_count, 1);
  assert.equal(e.change_summary.additions, 160_003);
  assert.equal(e.patch_truncated, true);
  assert.equal(e.patch_excerpt, undefined);
  assert.equal(e.patch_excerpts.length, 3);
  assert.match(e.patch_excerpts.find(({ path }) => path === "src/feature.js").patch_excerpt, /retries = 3/);
  assert.ok(e.change_summary.groups.some(({ directory }) => directory === "dist"));
  assert.ok(Buffer.byteLength(JSON.stringify(e)) <= 32 * 1024);
  const original = await prepareWritingEvidence({ mode: "pr", repo: f.repo, target: `${p.base_commit}..${p.head}` });
  assert.equal(original.patch_truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(e)) < Buffer.byteLength(JSON.stringify(original)) / 5);
  const result = await applySyncPush(await draft(f, p));
  assert.equal(result.status, "published", JSON.stringify(result));
  assert.equal(f.git(["rev-parse", `${p.head}^{tree}`]), f.git(["rev-parse", "origin/devel-tiga1026aaa^{tree}"]));
});

test("small line count with a huge line switches to bounded literal excerpts", async (t) => {
  const f = await fixture(t);
  const base = f.git(["rev-parse", "HEAD"]);
  const head = await f.commit("large.txt", `password = ${"x".repeat(1_000_000)}\nsmall ending\n`);
  const p = await prepareWritingEvidence({ mode: "pr", repo: f.repo, target: `${base}..${head}`, evidenceProfile: SYNC_PUSH_EVIDENCE_PROFILE });
  assert.equal(p.patch_truncated, true);
  assert.equal(p.patch_excerpt, undefined);
  assert.equal(p.patch_excerpts[0].patch_truncated, true);
  assert.doesNotMatch(p.patch_excerpts[0].patch_excerpt, /password|x{20}/);
});

test("supplemental evidence binds literal changed files to one unused plan", async (t) => {
  const f = await fixture(t);
  const excludes = path.join(f.repo, ".git/info/exclude");
  const originalExcludes = await readFile(excludes);
  await f.write(".gitignore", "ignored/\n");
  // A path can be removed as a file and also become a directory.
  f.git(["rm", "--", "delete.txt"]);
  await f.write("delete.txt/new-file", "new nested content\n");
  await f.write("src/[literal] name.txt", "password = never-show-this\nimportant feature detail\n");
  const p = await prepareSyncPush(f.options);
  assert.equal(p.status, "prepared", JSON.stringify(p));
  const ctx = await context(f.repo);
  const state = operationPath(ctx, p.operation_id);
  const before = await readFile(state, "utf8");
  await writeFile(excludes, originalExcludes);
  const options = { repo: f.repo, operation: p.operation_id, expectedPlanSha256: p.plan_sha256 };
  await assert.rejects(readSyncPushEvidence({ ...options, paths: ["base.txt"] }), /not a single changed file/);
  await assert.rejects(readSyncPushEvidence({ ...options, paths: ["src/*"] }), /not a single changed file/);
  await assert.rejects(readSyncPushEvidence({ ...options, expectedPlanSha256: "0".repeat(64), paths: ["delete.txt"] }), /digest/);
  const detail = await readSyncPushEvidence({ ...options, paths: ["delete.txt", "src/[literal] name.txt"] });
  assert.equal(detail.status, "evidence-ready");
  assert.match(detail.patch_excerpts[0].patch_excerpt, /-delete me/);
  assert.doesNotMatch(detail.patch_excerpts[0].patch_excerpt, /new nested content/);
  assert.match(detail.patch_excerpts[1].patch_excerpt, /important feature detail/);
  assert.match(detail.patch_excerpts[1].patch_excerpt, /redacted-sensitive-line/);
  assert.doesNotMatch(JSON.stringify(detail), /never-show-this/);
  assert.equal(await readFile(state, "utf8"), before);
  assert.deepEqual(await readFile(excludes), originalExcludes);
  assert.equal(f.git(["rev-parse", "HEAD"]), p.head);
  await f.commit("other.txt", "different HEAD\n");
  await assert.rejects(readSyncPushEvidence({ ...options, paths: ["delete.txt"] }), /HEAD or base changed/);
});

test("previous apply contract preserves original plan and refreshes without committing again", async (t) => {
  const f = await fixture(t);
  await f.write("own.txt", "pending\n");
  const original = await prepareSyncPush(f.options);
  const ctx = await context(f.repo);
  const planFile = path.join(path.dirname(operationPath(ctx, original.operation_id)), "plan.json");
  const plan = JSON.parse(await readFile(planFile, "utf8"));
  plan.contract = "0".repeat(64);
  const oldBytes = JSON.stringify(plan);
  await writeFile(planFile, oldBytes);
  const operation = await loadOperation(ctx, original.operation_id);
  operation.plan_sha256 = hash(plan);
  await saveOperation(ctx, operation);
  const oldDraft = await draft(f, original);
  const resume = await prepareSyncPush({ ...f.options, resume: original.operation_id });
  assert.equal(resume.status, "not-applied");
  assert.match(resume.reason, /contract changed/);
  const fresh = await prepareSyncPush(f.options);
  assert.equal(fresh.status, "prepared", JSON.stringify(fresh));
  assert.equal(fresh.continuation, "refreshed-preparation");
  assert.equal(fresh.commit.status, "skipped");
  assert.equal(fresh.head, original.head);
  assert.notEqual(fresh.suggested_draft_path, oldDraft.prDraft);
  assert.equal(await readFile(planFile, "utf8"), oldBytes);
  assert.match(await f.read(oldDraft.prDraft), /Improve example behavior/);
});

test("sync push detects base advance before ordinary commit and pull supersedes its preparation", async (t) => {
  const f = await fixture(t); await f.write("own.txt", "pending\n"); await f.advance();
  const before = await snapshot(await context(f.repo));
  const p = await prepareSyncPush(f.options); assert.equal(p.status, "not-applied", JSON.stringify(p)); assert.match(p.reason, /sync pull/);
  assert.equal((await snapshot(await context(f.repo))).digest, before.digest);
  const pull = await runSyncPull(f.options); assert.equal(pull.status, "completed", JSON.stringify(pull)); assert.equal(await f.read("own.txt"), "pending\n");
  assert.equal((await loadOperation(await context(f.repo), p.operation_id)).status, "superseded");
});

test("sync push detects later base advance and preserves the created commit for pull", async (t) => {
  const f = await fixture(t); await runSyncPull(f.options); await f.write("own.txt", "pending\n");
  const p = await prepareSyncPush({ ...f.options, message: "Work" }); const options = await draft(f, p); await f.advance();
  const r = await applySyncPush(options); assert.equal(r.status, "not-applied", JSON.stringify(r)); assert.match(r.reason, /Base advanced/); assert.equal(f.git(["rev-parse", "HEAD"]), p.head);
  const pull = await runSyncPull(f.options); assert.equal(pull.status, "completed", JSON.stringify(pull));
  const old = await applySyncPush(options); assert.equal(old.status, "not-applied"); assert.match(old.reason, /not available/);
});
