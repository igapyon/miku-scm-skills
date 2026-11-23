import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { runSyncPull, parseArgs } from "../scripts/sync-pull.mjs";
import { prepareSyncPush } from "../scripts/sync-push.mjs";
import { run as runNextWork } from "../scripts/post-merge-next-work.mjs";
import { renderHumanOutput } from "../scripts/miku-scm-human-output.mjs";
import { context, loadOperation, lock, newId, snapshot, syncGit, writeJson } from "../scripts/miku-scm-sync-state.mjs";
import { guardIgnored } from "../scripts/miku-scm-sync-worktree.mjs";
import { fixture } from "./sync-fixture.mjs";

import { doneFixture, withoutGh } from "./sync-pull-support.mjs";

test("sync pull reports the package version and configured tag from its pinned base", async (t) => {
  const f = await doneFixture(t);
  await f.write("package.json", JSON.stringify({
    name: "sync-policy-fixture",
    version: "0.8.2",
    scripts: { "check:version": "node scripts/validate-version-alignment.mjs --repo ." },
    mikuScm: { version: { policy: "semver", source: "package.json", tagPrefix: "v", check: "check:version" } },
  }, null, 2), f.other);
  syncGit(f.other, ["add", "package.json"]);
  syncGit(f.other, ["commit", "-m", "Add package version policy"]);
  syncGit(f.other, ["push", "origin", "devel"]);

  const result = await runSyncPull(f.options, f.dependencies);

  assert.equal(result.status, "completed");
  assert.equal(result.version, "0.8.2");
  assert.equal(result.version_source, "package.json");
  assert.equal(result.recommended_tag, "v0.8.2");
  assert.equal(result.tag_status, "absent");
});

test("sync pull retains an invalid package version policy as an advisory warning", async (t) => {
  const f = await doneFixture(t);
  await f.write("package.json", JSON.stringify({
    name: "sync-policy-fixture",
    version: "0.8.2",
    scripts: { "check:version": "node scripts/validate-version-alignment.mjs --repo ." },
    mikuScm: { version: { policy: "semver" } },
  }, null, 2), f.other);
  syncGit(f.other, ["add", "package.json"]);
  syncGit(f.other, ["commit", "-m", "Add invalid package version policy"]);
  syncGit(f.other, ["push", "origin", "devel"]);

  const result = await runSyncPull(f.options, f.dependencies);

  assert.equal(result.status, "completed");
  assert.equal(result.version, "unresolved");
  assert.equal(result.recommended_tag, "unresolved");
  assert.ok(result.warnings.some((warning) => warning.includes("Configured package version could not be resolved")));
});

test("human-confirmed sync pull on private GHE retains staged, unstaged and untracked work", async (t) => {
  const f = await doneFixture(t, {}, false, "ghe.example.test:8443");
  await f.write("carry.txt", "staged\n"); f.git(["add", "carry.txt"]);
  await f.write("carry.txt", "staged\nunstaged\n"); await f.write("untracked.txt", "new\n");
  const before = await snapshot(await context(f.repo));
  const dependencies = withoutGh(f, async () => new Response("", { status: 404 }));
  const pending = await runSyncPull(f.options, dependencies);
  assert.equal(pending.confirmation_required, true);
  assert.equal(pending.mutation_invoked, false);
  assert.equal((await snapshot(await context(f.repo))).digest, before.digest);
  assert.equal(pending.merge_confirmation.repository, "ghe.example.test:8443/owner/repo");
  const latest = await f.advance();
  const noPr = () => { throw new Error("Confirmation must not require PR access"); };
  const confirmed = await runSyncPull({ repo: f.repo, apply: true, confirmMerged: pending.operation_id }, { ...dependencies, gh: noPr, fetch: noPr });
  assert.equal(confirmed.status, "completed", JSON.stringify(confirmed));
  assert.equal(confirmed.head, latest);
  assert.equal(confirmed.merge_verification.source, "human");
  assert.equal(f.git(["show", ":carry.txt"]), "staged");
  assert.equal(await f.read("carry.txt"), "staged\nunstaged\n");
  assert.equal(await f.read("untracked.txt"), "new\n");
  assert.ok(confirmed.stash_retained);
  const output = renderHumanOutput({ workflow: "repository.sync.pull", status: "success", approvalGate: "apply", result: confirmed });
  assert.match(output, /Merge confirmation: human report/);
  assert.doesNotMatch(output, /Verified merged PR/);
  const replay = await runSyncPull({ repo: f.repo, apply: true, confirmMerged: pending.operation_id }, dependencies);
  assert.equal(replay.status, "not-applied");
  assert.equal((await loadOperation(await context(f.repo), pending.operation_id)).status, "completed");
});

test("unavailable PR evidence cannot authorize leaving accidental commits on -done", async (t) => {
  const f = await doneFixture(t);
  const local = await f.commit("accidental.txt", "later work\n");
  const before = await snapshot(await context(f.repo));
  const dependencies = withoutGh(f, async () => new Response("", { status: 404 }));
  const result = await runSyncPull(f.options, dependencies);
  assert.equal(result.status, "not-applied", JSON.stringify(result));
  assert.equal(result.confirmation_required, undefined);
  assert.equal(result.mutation_invoked, false);
  assert.match(result.reason, /fetched base does not contain the current -done HEAD.*recover done/);
  assert.equal(f.git(["rev-parse", "HEAD"]), local);
  assert.equal((await snapshot(await context(f.repo))).digest, before.digest);
});

test("squash merge needs a verified PR when Git ancestry cannot prove the HEAD was included", async (t) => {
  const f = await doneFixture(t, {}, true);
  const before = await snapshot(await context(f.repo));
  const stopped = await runSyncPull(f.options, withoutGh(f, async () => new Response("", { status: 404 })));
  assert.equal(stopped.status, "not-applied", JSON.stringify(stopped));
  assert.equal(stopped.mutation_invoked, false);
  assert.equal(stopped.confirmation_required, undefined);
  assert.match(stopped.reason, /fetched base does not contain the current -done HEAD/);
  assert.equal((await snapshot(await context(f.repo))).digest, before.digest);

  const verified = await runSyncPull(f.options, f.dependencies);
  assert.equal(verified.status, "completed", JSON.stringify(verified));
  assert.equal(verified.merge_verification.head, f.pull.head.sha);
});

test("next-work skips the name reserved by the frozen branch and can prepare a push", async (t) => {
  const f = await doneFixture(t);
  const frozen = f.git(["branch", "--show-current"]);
  await f.write("carry.txt", "next work\n");
  const pulled = await runSyncPull(f.options, { ...f.dependencies, now: () => new Date("2026-10-26T00:00:25+09:00") });
  assert.equal(pulled.status, "completed", JSON.stringify(pulled));
  assert.equal(pulled.final_branch, "devel-tiga1026aab");
  assert.equal(f.git(["rev-parse", `refs/heads/${frozen}`]), f.pull.head.sha);
  assert.equal(await f.read("carry.txt"), "next work\n");
  const pushed = await prepareSyncPush(f.options);
  assert.equal(pushed.status, "prepared", JSON.stringify(pushed));
});

test("sync pull leaves ignored collisions and untracked carryover in place before backup or stash", async (t) => {
  const f = await doneFixture(t);
  await f.write("ignored/config.txt", "remote version\n", f.other);
  syncGit(f.other, ["add", "-f", "ignored/config.txt"]);
  syncGit(f.other, ["commit", "-m", "Track ignored target"]);
  syncGit(f.other, ["push", "origin", "devel"]);
  await f.write("ignored/config.txt", "local ignored version\n");
  await f.write("carry.txt", "preserve this too\n");
  await writeFile(path.join(f.repo, ".git/info/exclude"), "ignored/config.txt\n");
  const beforeBranch = f.git(["branch", "--show-current"]);
  const beforeRefs = f.git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]);
  const beforeStash = f.git(["stash", "list", "--format=%H"]);
  const calls = [];
  const dependencies = {
    ...f.dependencies,
    git: (cwd, args, options) => { calls.push(args); return f.dependencies.git(cwd, args, options); },
  };

  const result = await runSyncPull(f.options, dependencies);

  assert.equal(result.status, "not-applied", JSON.stringify(result));
  assert.match(result.reason, /Ignored path would be overwritten by sync/);
  assert.equal(result.backup_branch, null);
  assert.equal(result.stash_sha, null);
  assert.equal(f.git(["branch", "--show-current"]), beforeBranch);
  assert.equal(f.git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]), beforeRefs);
  assert.equal(f.git(["stash", "list", "--format=%H"]), beforeStash);
  assert.equal(await f.read("ignored/config.txt"), "local ignored version\n");
  assert.equal(await f.read("carry.txt"), "preserve this too\n");
  assert.equal(calls.some((args) => args[0] === "stash" || (args[0] === "branch" && !args[1]?.startsWith("--"))), false);
});

test("local replacement history cannot authorize a frozen branch transition", async (t) => {
  const f = await doneFixture(t);
  const shared = await f.advance();
  const accidental = await f.commit("local-only.txt", "post-publication work\n");
  f.git(["fetch", "origin"]);
  f.git(["replace", "--graft", shared, accidental]);
  assert.equal(syncGit(f.repo, ["merge-base", "--is-ancestor", accidental, shared], { allowFailure: true }).ok, true);
  assert.equal(syncGit(f.repo, ["--no-replace-objects", "merge-base", "--is-ancestor", accidental, shared], { allowFailure: true }).ok, false);
  const before = await snapshot(await context(f.repo));
  const pull = await runSyncPull(f.options, withoutGh(f, async () => new Response("", { status: 404 })));
  assert.equal(pull.status, "not-applied", JSON.stringify(pull));
  assert.equal(pull.confirmation_required, undefined);
  assert.equal(pull.mutation_invoked, false);
  assert.match(pull.reason, /Local Git replacements or grafts/);
  await assert.rejects(runNextWork({ ...f.options, publishedHead: accidental, confirmedMerged: true }),
    (error) => error.mutationInvoked === false && /Local Git replacements or grafts/.test(error.message));
  assert.equal((await snapshot(await context(f.repo))).digest, before.digest);
  assert.equal(f.git(["rev-parse", "HEAD"]), accidental);
});

test("saved merge confirmation stops when a local graft is introduced", async (t) => {
  const f = await doneFixture(t);
  const dependencies = withoutGh(f, async () => new Response("", { status: 404 }));
  const pending = await runSyncPull(f.options, dependencies);
  assert.equal(pending.confirmation_required, true);
  await f.write(".git/info/grafts", `${f.pull.head.sha}\n`);
  const result = await runSyncPull({ repo: f.repo, apply: true, confirmMerged: pending.operation_id }, dependencies);
  assert.equal(result.status, "not-applied", JSON.stringify(result));
  assert.equal(result.mutation_invoked, false);
  assert.match(result.reason, /Local Git replacements or grafts/);
  assert.equal(f.git(["branch", "--show-current"]), "devel-tiga1026aaa-done");
});

test("a custom graft path with a trailing space stops either next-work entry", { skip: process.platform === "win32" }, async (t) => {
  const f = await doneFixture(t);
  const shared = await f.advance();
  const accidental = await f.commit("local-only.txt", "post-publication work\n");
  const previous = process.env.GIT_GRAFT_FILE;
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_GRAFT_FILE;
    else process.env.GIT_GRAFT_FILE = previous;
  });
  f.git(["fetch", "origin"]);
  await f.write("custom grafts ", `${shared} ${accidental}\n`);
  process.env.GIT_GRAFT_FILE = path.join(f.repo, "custom grafts ");
  assert.equal(syncGit(f.repo, ["merge-base", "--is-ancestor", accidental, shared], { allowFailure: true }).ok, true);
  const stopped = await runSyncPull(f.options, withoutGh(f, async () => new Response("", { status: 404 })));
  assert.equal(stopped.status, "not-applied");
  assert.equal(stopped.confirmation_required, undefined);
  assert.match(stopped.reason, /Local Git replacements or grafts/);
  await assert.rejects(runNextWork({ ...f.options, publishedHead: accidental, confirmedMerged: true }),
    (error) => error.mutationInvoked === false && /Local Git replacements or grafts/.test(error.message));
  assert.equal(f.git(["rev-parse", "HEAD"]), accidental);
});

for (const change of ["worktree", "index", "head", "remote", "base-history", "deleted base"]) {
  test(`human merge confirmation rejects changed ${change}`, async (t) => {
    const f = await doneFixture(t);
    await f.advance();
    const dependencies = withoutGh(f, async () => new Response("", { status: 403 }));
    const pending = await runSyncPull(f.options, dependencies);
    if (change === "worktree") await f.write("edit.txt", "changed\n");
    if (change === "index") { await f.write("edit.txt", "changed\n"); f.git(["add", "edit.txt"]); }
    if (change === "head") await f.commit("edit.txt", "changed\n");
    if (change === "remote") f.git(["config", "remote.origin.tagOpt", "--no-tags"]);
    if (change === "base-history") syncGit(f.other, ["push", "--force", "origin", "HEAD~1:devel"]);
    if (change === "deleted base") syncGit(f.remote, ["update-ref", "-d", "refs/heads/devel"]);
    const before = await snapshot(await context(f.repo));
    const result = await runSyncPull({ repo: f.repo, apply: true, confirmMerged: pending.operation_id }, dependencies);
    assert.equal(result.status, "not-applied", JSON.stringify(result));
    assert.equal(result.mutation_invoked, false);
    assert.equal(result.backup_branch, null);
    assert.equal((await snapshot(await context(f.repo))).digest, before.digest);
  });
}

test("a fresh pull supersedes the old merge question and a pending question can be cancelled", async (t) => {
  const f = await doneFixture(t);
  const dependencies = withoutGh(f, async () => new Response("", { status: 404 }));
  const old = await runSyncPull(f.options, dependencies);
  const fresh = await runSyncPull(f.options, dependencies);
  assert.equal((await loadOperation(await context(f.repo), old.operation_id)).status, "superseded");
  const cancelled = await runSyncPull({ repo: f.repo, apply: true, abort: fresh.operation_id }, dependencies);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.mutation_invoked, false);
  for (const pending of [old, fresh]) {
    const result = await runSyncPull({ repo: f.repo, apply: true, confirmMerged: pending.operation_id }, dependencies);
    assert.equal(result.status, "not-applied");
    assert.equal(result.mutation_invoked, false);
  }
});

test("unmerged PR evidence cannot be overridden by human-confirmation recovery", async (t) => {
  const f = await doneFixture(t, { merged: false });
  const pending = await runSyncPull(f.options, f.dependencies);
  assert.equal(pending.confirmation_required, undefined);
  const result = await runSyncPull({ repo: f.repo, apply: true, confirmMerged: pending.operation_id }, f.dependencies);
  assert.equal(result.status, "not-applied");
  assert.match(result.reason, /not awaiting human merge confirmation/);
});

test("TLS failures retain a bounded diagnostic and offer human merge confirmation", async (t) => {
  const f = await doneFixture(t, {}, false, "ghe.example.test");
  const result = await runSyncPull(f.options, withoutGh(f, async () => {
    throw new TypeError("private transport details", { cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } });
  }));
  assert.equal(result.confirmation_required, true);
  assert.match(result.reason, /SELF_SIGNED_CERT_IN_CHAIN/);
  assert.doesNotMatch(result.reason, /private transport details/);
});

test("sync pull next-work resumes a prepared branch without another branch or stash", async (t) => {
  const f = await doneFixture(t);
  f.git(["config", "branch.autoSetupMerge", "true"]);
  await f.write("carry.txt", "preserve me\n");
  const stopped = await runSyncPull(f.options, {
    ...f.dependencies,
    beforeAction: (phase) => { if (phase === "next-work-switch") throw new Error("Interrupted before checkout"); },
  });
  assert.equal(stopped.status, "partial", JSON.stringify(stopped));
  assert.equal(stopped.final_branch, "devel-tiga1026aaa-done");
  assert.equal(f.git(["rev-parse", "HEAD"]), f.pull.merge_commit_sha);
  assert.equal(f.git(["rev-parse", "--symbolic-full-name", "devel-tiga1026mef@{upstream}"]), "refs/remotes/origin/devel");
  await assert.rejects(f.read("carry.txt"), { code: "ENOENT" });
  const calls = [];
  const resumed = await runSyncPull({ repo: f.repo, resume: stopped.operation_id, apply: true }, {
    ...f.dependencies,
    git: (cwd, args, options) => { calls.push(args); return f.dependencies.git(cwd, args, options); },
  });
  assert.equal(resumed.status, "completed", JSON.stringify(resumed));
  assert.equal(resumed.stash_sha, stopped.stash_sha);
  assert.equal(f.git(["rev-parse", "--symbolic-full-name", "@{upstream}"]), "refs/remotes/origin/devel");
  assert.equal(await f.read("carry.txt"), "preserve me\n");
  assert.ok(!calls.some((args) => args[0] === "fetch" || (args[0] === "branch" && args[1] === "devel-tiga1026mef") || (args[0] === "stash" && args[1] === "push")));
  assert.equal(calls.filter((args) => args[0] === "switch").length, 1);
});

test("sync pull never retries an unconfirmed checkout hook without explicit resolution", async (t) => {
  const f = await doneFixture(t);
  await f.write("carry.txt", "preserve me\n");
  f.git(["config", "core.hooksPath", path.join(f.repo, ".git/hooks")]);
  await writeFile(path.join(f.repo, ".git/hooks/post-checkout"), "#!/bin/sh\nprintf x >> .git/checkout-count\nexit 1\n", { mode: 0o755 });
  const stopped = await runSyncPull(f.options, f.dependencies);
  assert.equal(stopped.status, "partial", JSON.stringify(stopped));
  assert.equal(stopped.final_branch, "devel-tiga1026mef");
  const output = renderHumanOutput({ workflow: "repository.sync.pull", status: "partial", approvalGate: "apply", delegateStatus: stopped.status, mutationInvoked: stopped.mutation_invoked, result: stopped });
  assert.match(output, /^Current branch: devel-tiga1026mef$/m);
  assert.doesNotMatch(output, /New work branch:/);
  const plain = await runSyncPull({ repo: f.repo, resume: stopped.operation_id, apply: true }, f.dependencies);
  assert.equal(plain.status, "partial"); assert.match(plain.reason, /--resolved-next-work/);
  await assert.rejects(f.read("carry.txt"), { code: "ENOENT" });
  const resolved = await runSyncPull({ repo: f.repo, resume: stopped.operation_id, resolvedNextWork: true, apply: true }, f.dependencies);
  assert.equal(resolved.status, "completed", JSON.stringify(resolved));
  assert.equal(await f.read("carry.txt"), "preserve me\n");
  assert.equal(await readFile(path.join(f.repo, ".git/checkout-count"), "utf8"), "x");
});

test("sync pull recovers an unconfirmed branch preparation only after explicit review", async (t) => {
  const f = await doneFixture(t); await f.write("carry.txt", "pending\n");
  const stopped = await runSyncPull(f.options, {
    ...f.dependencies,
    git: (cwd, args, options) => {
      const result = f.dependencies.git(cwd, args, options);
      if (args[0] === "branch" && args[1] === "devel-tiga1026mef") throw new Error("Lost branch preparation receipt");
      return result;
    },
  });
  assert.equal(stopped.status, "partial", JSON.stringify(stopped));
  assert.equal(stopped.final_branch, "devel-tiga1026aaa-done");
  const plain = await runSyncPull({ repo: f.repo, resume: stopped.operation_id, apply: true }, f.dependencies);
  assert.equal(plain.status, "partial"); assert.match(plain.reason, /no complete receipt/);
  const calls = [];
  const resolved = await runSyncPull({ repo: f.repo, resume: stopped.operation_id, resolvedNextWork: true, apply: true }, {
    ...f.dependencies, git: (cwd, args, options) => { calls.push(args); return f.dependencies.git(cwd, args, options); },
  });
  assert.equal(resolved.status, "completed", JSON.stringify(resolved));
  assert.equal(await f.read("carry.txt"), "pending\n");
  assert.equal(resolved.stash_sha, stopped.stash_sha);
  assert.ok(!calls.some((args) => args[0] === "fetch" || (args[0] === "branch" && args[1] === "devel-tiga1026mef") || (args[0] === "stash" && args[1] === "push")));
});

