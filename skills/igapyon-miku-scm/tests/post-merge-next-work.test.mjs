import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  prepareNextWorkBranch,
  run as runNextWork,
} from "../scripts/post-merge-next-work.mjs";
import { runWorkflow } from "../scripts/miku-scm-run.mjs";
import { syncGit as runSyncGit } from "../scripts/miku-scm-sync-state.mjs";
import { prepareSyncPush } from "../scripts/sync-push.mjs";

import { PUBLISH_SCRIPT, git, recordedGit, NEXT_WORK_DATE, mergedScenario, nextWorkOptions, scenario, optionsFor, preparePublicationPlan, applySavedPublication, applyDependencies, windowsApplyDependencies, nativeApplyDependencies } from "./post-recommit-publish-support.mjs";

function recordedSyncGit(calls, intercept = () => undefined) {
  return (cwd, args, options = {}) => {
    calls.push(args);
    const replacement = intercept(cwd, args, options);
    return replacement ?? runSyncGit(cwd, args, options);
  };
}

function checksLocation([command, arg]) {
  return (command === "for-each-ref" && arg === "--format=%(HEAD)%00%(refname)%00%(objectname)")
    || (command === "rev-parse" && arg === "HEAD");
}

function runPostMerge(state, syncPullDependencies, runId) {
  return runWorkflow("repository.post-merge.next-work", [
    "--repo", state.repo, "--published-head", state.expectedHead, "--confirmed-merged", "--apply",
  ], {
    cwd: state.repo, artifactRoot: path.join(state.temporary, "runs"), runId,
    syncPullDependencies: { now: () => NEXT_WORK_DATE, ...syncPullDependencies },
  });
}

test("post-merge tag lookup keeps all advisory states distinct", () => {
  const base = "a".repeat(40);
  const other = "b".repeat(40);
  assert.deepEqual(classifyTagLookup("unresolved", null, base), {
    tag_target: null,
    tag_status: "unresolved",
  });
  assert.deepEqual(classifyTagLookup("v20260728f", { ok: true, out: "" }, base), {
    tag_target: null,
    tag_status: "absent",
  });
  assert.deepEqual(classifyTagLookup("v20260728f", {
    ok: false,
    out: "",
    err: "remote unavailable",
  }, base), {
    tag_target: null,
    tag_status: "lookup-failed",
    tag_lookup_warning: "remote unavailable",
  });
  assert.deepEqual(classifyTagLookup("v20260728f", {
    ok: true,
    out: `${base}\trefs/tags/v20260728f`,
  }, base), {
    tag_target: base,
    tag_status: "confirmed",
  });
  assert.deepEqual(classifyTagLookup("v20260728f", {
    ok: true,
    out: `${other}\trefs/tags/v20260728f`,
  }, base), {
    tag_target: other,
    tag_status: "mismatch",
  });
});

test("post-merge helper creates the next work branch from refreshed devel", async (t) => {
  const state = await scenario(t);
  git(state.repo, "config", "branch.autoSetupMerge", "true");
  git(state.repo, "config", "core.hooksPath", path.join(state.repo, ".git/hooks"));
  await writeFile(path.join(state.repo, ".git/hooks/post-checkout"), "#!/bin/sh\ngit rev-parse --symbolic-full-name '@{upstream}' > .git/checkout-upstream\n", { mode: 0o755 });
  git(state.repo, "push", "origin", "HEAD:devel");
  git(state.repo, "branch", "-m", state.branch, `${state.branch}-done`);
  const result = await runNextWork(nextWorkOptions(state), {
    now: () => new Date("2026-07-25T08:45:00+09:00"),
  });
  assert.equal(result.status, "created");
  assert.equal(result.final_branch, "devel-tiga0725ief");
  assert.equal(result.comparison, "0 0");
  assert.equal(result.tag_status, "absent");
  assert.equal(result.human_handoff, "Next work branch is ready: devel-tiga0725ief");
  assert.equal(git(state.repo, "branch", "--show-current"), "devel-tiga0725ief");
  assert.equal(git(state.repo, "rev-parse", "--symbolic-full-name", "@{upstream}"), "refs/remotes/origin/devel");
  assert.equal(git(state.repo, "status", "-sb"), "## devel-tiga0725ief...origin/devel");
  assert.equal((await readFile(path.join(state.repo, ".git/checkout-upstream"), "utf8")).trim(), "refs/remotes/origin/devel");
});

test("post-merge helper tracks the selected remote and base", async (t) => {
  const state = await mergedScenario(t);
  git(state.repo, "config", "branch.autoSetupMerge", "true");
  git(state.repo, "remote", "rename", "origin", "shared");
  git(state.repo, "push", "shared", "HEAD:release");
  const result = await runNextWork({ ...nextWorkOptions(state), remote: "shared", base: "release" }, {
    now: () => NEXT_WORK_DATE,
  });
  assert.equal(result.status, "created");
  assert.equal(result.base_commit, state.expectedHead);
  assert.equal(result.final_branch, "release-tiga0725ief");
  assert.equal(git(state.repo, "rev-parse", "HEAD"), state.expectedHead);
  assert.equal(git(state.repo, "rev-parse", "--symbolic-full-name", "@{upstream}"), "refs/remotes/shared/release");
  assert.equal(git(state.repo, "status", "-sb"), "## release-tiga0725ief...shared/release");
});


test("post-merge runner uses its saved completion when follow-up Git reads fail", async (t) => {
  const state = await mergedScenario(t);
  await writeFile(path.join(state.repo, "README.md"), "carryover after merge\n");
  const hooks = path.join(state.repo, ".git", "review-hooks");
  await mkdir(hooks, { recursive: true });
  const marker = path.join(state.repo, ".git", "review-checkout-complete");
  await writeFile(path.join(hooks, "post-checkout"),
    "git update-ref -d refs/remotes/origin/devel || exit 1\n: > .git/review-checkout-complete\n",
    { mode: 0o755 });
  git(state.repo, "config", "core.hooksPath", hooks);

  const calls = [];
  let operationId = "";
  let postCompletionBranchHeadReads = 0;
  let stashLookups = 0;
  const failedRead = {
    ok: false, code: 1, stdout: "", out: "", bytes: Buffer.alloc(0), err: "injected read failure",
  };
  const result = await runWorkflow("repository.post-merge.next-work", [
    "--repo", state.repo, "--published-head", state.expectedHead, "--confirmed-merged", "--apply",
  ], {
    cwd: state.repo,
    artifactRoot: path.join(state.temporary, "runs"),
    runId: "saved-completion",
    syncPullDependencies: {
      now: () => NEXT_WORK_DATE,
      beforeAction: (_phase, _ctx, op) => { operationId = op.id; },
      git: recordedSyncGit(calls, (_cwd, args) => {
        if (existsSync(marker) && operationId) {
          const stateFile = path.join(state.repo, "workplace/miku-scm/sync/operations", operationId, "state.json");
          if (existsSync(stateFile) && JSON.parse(readFileSync(stateFile, "utf8")).status === "completed") {
            if ((args[0] === "branch" && args[1] === "--show-current")
              || checksLocation(args)) {
              postCompletionBranchHeadReads += 1;
              throw new Error("post-completion branch/head read should not occur");
            }
          }
        }
        if (!existsSync(marker)) return undefined;
        if (args[0] === "status" && args[1] === "--porcelain") return failedRead;
        if (args[0] === "stash" && args[1] === "list" && args[2] === "--format=%H") {
          stashLookups += 1;
          if (stashLookups > 1) return failedRead;
        }
        return undefined;
      }),
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.result.status, "created");
  assert.equal(result.result.previous_branch, `${state.branch}-done`);
  assert.equal(result.result.final_branch, "devel-tiga0725ief");
  assert.equal(result.result.base, "devel");
  assert.equal(result.result.comparison, "0 0");
  assert.equal(result.result.carryover.working_tree, "unknown");
  assert.equal(result.result.carryover.stash_retained, null);
  const saved = JSON.parse(await readFile(path.join(state.repo, "workplace/miku-scm/sync/operations", operationId, "state.json"), "utf8"));
  assert.equal(saved.status, "completed");
  assert.equal(saved.original.branch, `${state.branch}-done`);
  assert.equal(git(state.repo, "rev-parse", `${state.branch}-done`), state.expectedHead);
  assert.equal(git(state.repo, "rev-parse", "HEAD"), state.expectedHead);
  assert.equal(git(state.repo, "branch", "--show-current"), "devel-tiga0725ief");
  assert.equal(await readFile(path.join(state.repo, "README.md"), "utf8"), "carryover after merge\n");
  assert.ok(git(state.repo, "stash", "list", "--format=%H").includes(result.result.carryover.stash_sha));
  assert.equal(calls.some((args) => args[0] === "rev-list"), false);
  assert.equal(postCompletionBranchHeadReads, 0);
  assert.throws(() => git(state.repo, "show-ref", "--verify", "refs/remotes/origin/devel"));
});

for (const fault of ["HEAD read", "completion write"]) {
  test(`post-merge runner retains the recovery ID on ${fault} failure after restoring work`, async (t) => {
    const state = await mergedScenario(t);
    const carry = path.join(state.repo, "carry.txt");
    await writeFile(carry, "keep this work\n");
    const calls = [];
    let stateFile;
    let retainedReceipt;
    const dependencies = {
      cwd: state.repo, artifactRoot: path.join(state.temporary, "runs"),
      syncPullDependencies: {
        now: () => NEXT_WORK_DATE,
        beforeAction: (_phase, ctx, op) => {
          stateFile = path.join(ctx.storage, "operations", op.id, "state.json");
        },
        git: recordedSyncGit(calls, (_cwd, args) => {
          const [command, arg] = args;
          const inject = fault === "HEAD read" ? checksLocation(args)
            : command === "merge-base" && arg === "--is-ancestor";
          if (!inject || !stateFile || retainedReceipt) return;
          const saved = JSON.parse(readFileSync(stateFile, "utf8"));
          if (!saved.restore_ok) return;
          if (fault === "HEAD read") throw new Error("Injected HEAD read failure");
          // An occupied destination makes the atomic write fail on every supported platform.
          retainedReceipt = path.join(path.dirname(stateFile), "last-state.json");
          renameSync(stateFile, retainedReceipt);
          mkdirSync(stateFile);
        }),
      },
    };
    const stopped = await runWorkflow("repository.post-merge.next-work", [
      "--repo", state.repo, "--published-head", state.expectedHead, "--confirmed-merged", "--apply",
    ], dependencies);
    assert.equal(stopped.status, "unresolved", JSON.stringify(stopped));
    assert.equal(stopped.mutation_invoked, true);
    const recovery = stopped.error.recovery;
    assert.ok(recovery.operation_id);
    assert.equal(recovery.restore_status, "restored");
    assert.equal(recovery.stash_retained, true);
    assert.match(recovery.next_action, /Inspect the retained sync operation/);
    assert.match(stopped.human_output, new RegExp(`Recovery operation: ${recovery.operation_id}`));
    assert.equal(git(state.repo, "branch", "--show-current"), "devel-tiga0725ief");
    assert.equal(await readFile(carry, "utf8"), "keep this work\n");
    const saved = JSON.parse(await readFile(retainedReceipt ?? stateFile, "utf8"));
    assert.equal(saved.id, recovery.operation_id);
    assert.equal(saved.status, fault === "HEAD read" ? "partial" : "running");
    if (fault === "HEAD read") {
      assert.equal(recovery.head, null);
      assert.equal(stopped.error.message, "Injected HEAD read failure");
    } else {
      assert.ok(retainedReceipt);
      assert.match(stopped.human_output, /Could not update the saved sync operation/);
      await rm(stateFile, { recursive: true });
      await rename(retainedReceipt, stateFile);
    }

    const resumed = await runWorkflow("repository.sync.pull", [
      "--repo", state.repo, "--resume", recovery.operation_id, "--apply",
    ], { ...dependencies, syncPullDependencies: { git: recordedSyncGit(calls) } });
    assert.equal(resumed.status, "success", JSON.stringify(resumed));
    assert.equal(resumed.result.operation_id, recovery.operation_id);
    assert.equal(JSON.parse(await readFile(stateFile, "utf8")).status, "completed");
    assert.equal(calls.filter((args) => args.includes("stash") && args.includes("apply")).length, 1);
    assert.equal(await readFile(carry, "utf8"), "keep this work\n");
  });
}

for (const savedStatus of ["completed", "partial"]) {
  test(`post-merge runner preserves a ${savedStatus} result when lock release fails`, async (t) => {
    const state = await mergedScenario(t);
    const carry = path.join(state.repo, "carry.txt");
    await writeFile(carry, "keep this work\n");
    let stateFile, lockFile;
    let invalidatedLock = false;
    const result = await runPostMerge(state, {
      beforeAction: (_phase, ctx, op) => {
        stateFile = path.join(ctx.storage, "operations", op.id, "state.json");
        lockFile = ctx.syncLock.file;
      },
      git: recordedSyncGit([], (_cwd, args) => {
        if (!invalidatedLock && stateFile && checksLocation(args)
          && JSON.parse(readFileSync(stateFile, "utf8")).restore_ok) {
          writeFileSync(lockFile, "Unreadable lock record");
          invalidatedLock = true;
          if (savedStatus === "partial") throw new Error("Checkout observation failed");
        }
        return undefined;
      }),
    });
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(saved.status, savedStatus);
    assert.equal(result.mutation_invoked, true);
    assert.match(result.human_output, /Could not release the sync lock/);
    assert.match(result.human_output, new RegExp(saved.id));
    if (savedStatus === "completed") {
      assert.equal(result.status, "success");
      assert.equal(result.result.operation_id, saved.id);
    } else {
      assert.equal(result.status, "unresolved");
      assert.equal(result.error.recovery.operation_id, saved.id);
      assert.equal(result.error.message, "Checkout observation failed");
    }
    assert.equal(await readFile(lockFile, "utf8"), "Unreadable lock record");
    assert.equal(await readFile(carry, "utf8"), "keep this work\n");
  });
}

test("post-merge does not complete when the next branch advances before final verification", async (t) => {
  const state = await mergedScenario(t);
  let stateFile;
  let advancedHead;
  const stopped = await runPostMerge(state, {
    beforeAction: (_phase, ctx, op) => { stateFile = path.join(ctx.storage, "operations", op.id, "state.json"); },
    git: recordedSyncGit([], (_cwd, args) => {
      if (advancedHead || !stateFile || !checksLocation(args)) return;
      const saved = JSON.parse(readFileSync(stateFile, "utf8"));
      if (!saved.integrated_head) return;
      // Advance at the first location read after the expected HEAD was saved.
      git(state.repo, "commit", "--allow-empty", "-m", "Concurrent local work");
      advancedHead = git(state.repo, "rev-parse", "HEAD");
    }),
  });
  assert.ok(advancedHead, "The concurrent commit was created");
  assert.equal(stopped.status, "unresolved");
  assert.match(stopped.error.message, /branch or HEAD changed/);
  const saved = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(saved.status, "partial");
  assert.equal(stopped.error.recovery.operation_id, saved.id);
  assert.equal(saved.integrated_head, saved.base_sha);
  assert.equal(git(state.repo, "branch", "--show-current"), saved.next_branch);
  assert.equal(git(state.repo, "rev-parse", "HEAD"), advancedHead);
  assert.notEqual(advancedHead, saved.integrated_head);
});

test("post-merge runner stops when the original done branch is checked out before final verification", async (t) => {
  const state = await mergedScenario(t);
  const carry = path.join(state.repo, "carry.txt");
  await writeFile(carry, "keep this work\n");
  const frozen = `${state.branch}-done`;
  let stateFile;
  let switched = false;
  const stopped = await runPostMerge(state, {
    beforeAction: (_phase, ctx, op) => { stateFile = path.join(ctx.storage, "operations", op.id, "state.json"); },
    git: recordedSyncGit([], (_cwd, args) => {
      if (!switched && stateFile && checksLocation(args) && JSON.parse(readFileSync(stateFile, "utf8")).restore_ok) {
        git(state.repo, "switch", frozen);
        switched = true;
      }
      return undefined;
    }),
  });
  assert.equal(stopped.status, "unresolved");
  assert.match(stopped.error.message, /branch or HEAD changed/);
  assert.equal(stopped.error.recovery.final_branch, frozen);
  assert.equal(stopped.error.recovery.restore_status, "restored");
  const saved = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(saved.status, "partial");
  assert.equal(stopped.error.recovery.operation_id, saved.id);
  assert.equal(git(state.repo, "rev-parse", "HEAD"), saved.base_sha);
  assert.equal(await readFile(carry, "utf8"), "keep this work\n");
});

test("sync pull reports the actual resume flag after detecting changed upstream", async (t) => {
  const state = await mergedScenario(t);
  await writeFile(path.join(state.repo, "carry.txt"), "keep this work\n");
  const calls = [];
  const interrupted = await runPostMerge(state, {
    beforeAction: (phase) => {
      if (phase === "next-work-switch") throw new Error("Stop before checking out prepared branch");
    },
    git: recordedSyncGit(calls),
  });
  assert.equal(interrupted.status, "unresolved");
  const { operation_id: id, next_branch: next } = interrupted.error.recovery;
  git(state.repo, "branch", "--unset-upstream", next);
  const dependencies = { cwd: state.repo, artifactRoot: path.join(state.temporary, "runs"),
    syncPullDependencies: { git: recordedSyncGit(calls) } };
  const args = ["--repo", state.repo, "--resume", id, "--apply"];
  const stopped = await runWorkflow("repository.sync.pull", args, dependencies);
  assert.equal(stopped.status, "partial");
  assert.match(stopped.result.reason, /tracking configuration changed/);
  assert.ok(stopped.result.next_action.endsWith(`sync pull --resume ${id} --resolved-next-work`));
  const resumed = await runWorkflow("repository.sync.pull", [...args, "--resolved-next-work"], dependencies);
  assert.equal(resumed.status, "success");
  assert.equal(resumed.result.operation_id, id);
  assert.equal(resumed.result.final_branch, next);
  assert.equal(await readFile(path.join(state.repo, "carry.txt"), "utf8"), "keep this work\n");
  assert.equal(calls.filter((args) => args.includes("stash") && args.includes("apply")).length, 1);
});

test("legacy post-merge preserves a prepared push when a different -done branch is selected", async (t) => {
  const state = await mergedScenario(t);
  const original = `${state.branch}-done`;
  git(state.repo, "switch", "-c", "devel-tiga1122jce", "origin/devel");
  await writeFile(path.join(state.repo, "prepared.txt"), "keep this plan\n");
  git(state.repo, "add", "prepared.txt");
  git(state.repo, "commit", "-m", "Prepare local work");
  const prepared = await prepareSyncPush({ repo: state.repo, remote: "origin", base: "devel", apply: true });
  assert.equal(prepared.status, "prepared", JSON.stringify(prepared));
  const pending = path.join(state.repo, "workplace/miku-scm/sync/operations", prepared.operation_id, "state.json");
  const saved = await readFile(pending, "utf8");
  git(state.repo, "switch", original);
  const other = "release-tiga1122jce-done";
  git(state.repo, "branch", other, state.expectedHead);
  await writeFile(path.join(state.repo, "untracked.txt"), "keep on the selected branch\n");
  const refsBefore = git(state.repo, "for-each-ref", "--format=%(refname)", "refs/heads");
  const calls = [];
  let switched = false;
  const result = await runWorkflow("repository.post-merge.next-work", [
    "--repo", state.repo, "--published-head", state.expectedHead, "--confirmed-merged", "--apply",
  ], {
    cwd: state.repo,
    artifactRoot: path.join(state.temporary, "runs"),
    runId: "legacy-branch-race",
    syncPullDependencies: {
      now: () => NEXT_WORK_DATE,
      git: recordedSyncGit(calls, (cwd, args, options) => {
        if (!switched && args[0] === "rev-parse" && args[1] === "HEAD") {
          switched = true;
          git(state.repo, "switch", other);
        }
        return undefined;
      }),
    },
  });

  assert.equal(switched, true);
  assert.equal(result.status, "not-applied");
  assert.equal(result.mutation_invoked, false);
  assert.equal(await readFile(pending, "utf8"), saved);
  assert.match(result.error.message, new RegExp(`${original}.*${state.expectedHead}`));
  assert.equal(git(state.repo, "branch", "--show-current"), other);
  assert.equal(git(state.repo, "for-each-ref", "--format=%(refname)", "refs/heads"), refsBefore);
  assert.equal(git(state.repo, "status", "--porcelain"), "?? untracked.txt");
  assert.equal(await readFile(path.join(state.repo, "untracked.txt"), "utf8"), "keep on the selected branch\n");
  assert.equal(calls.some(([command]) => ["fetch", "stash", "switch"].includes(command)), false);
  assert.equal(calls.some(([command, subcommand]) => command === "branch" && subcommand === "-f"), false);
});

test("post-merge runner stops before fetch or checkout when the done branch has later commits", async (t) => {
  const state = await mergedScenario(t);
  const frozen = `${state.branch}-done`;
  await writeFile(path.join(state.repo, "accidental.txt"), "committed after the prior PR\n");
  git(state.repo, "add", "accidental.txt");
  git(state.repo, "commit", "-m", "post-publication work");
  const localHead = git(state.repo, "rev-parse", "HEAD");
  await writeFile(path.join(state.repo, "untracked.txt"), "also preserve this\n");
  const calls = [];
  const flags = ["--repo", state.repo, "--confirmed-merged", "--apply"];
  const dependencies = {
    cwd: state.repo, artifactRoot: path.join(state.temporary, "runs"),
    syncPullDependencies: { git: recordedSyncGit(calls), now: () => NEXT_WORK_DATE },
  };

  const missingHead = await runWorkflow("repository.post-merge.next-work", flags, dependencies);
  assert.equal(missingHead.mutation_invoked, false);
  assert.match(missingHead.error.message, /--published-head requires/);
  assert.deepEqual(calls, []);

  const differentHead = await runWorkflow("repository.post-merge.next-work", [
    ...flags, "--published-head", state.expectedHead,
  ], dependencies);
  assert.equal(differentHead.status, "not-applied");
  assert.equal(differentHead.mutation_invoked, false);
  assert.match(differentHead.error.message, /differs from published HEAD.*recover done/);
  assert.equal(calls.some(([command]) => ["fetch", "stash", "switch"].includes(command)), false);
  assert.equal(git(state.repo, "branch", "--show-current"), frozen);
  assert.equal(git(state.repo, "rev-parse", "HEAD"), localHead);
  assert.equal(await readFile(path.join(state.repo, "untracked.txt"), "utf8"), "also preserve this\n");
});

test("an accidental HEAD cannot pass manual merge confirmation after the publishing worktree is removed", async (t) => {
  const main = await scenario(t);
  const publishing = path.join(main.temporary, "publishing checkout");
  git(main.repo, "switch", "devel");
  git(main.repo, "worktree", "add", publishing, main.branch);
  const state = { ...main, repo: publishing };
  const saved = await preparePublicationPlan(state);
  assert.equal((await applySavedPublication(state, saved)).status, "published");
  git(publishing, "push", "origin", `${state.expectedHead}:refs/heads/devel`);
  await writeFile(path.join(publishing, "accidental.txt"), "committed after publication\n");
  git(publishing, "add", "accidental.txt");
  git(publishing, "commit", "-m", "post-publication work");
  const localHead = git(publishing, "rev-parse", "HEAD");
  const done = `${main.branch}-done`;
  git(main.repo, "worktree", "remove", publishing);
  git(main.repo, "switch", done);
  git(main.repo, "remote", "set-url", "origin", pathToFileURL(main.remote).href);
  await writeFile(path.join(main.repo, "untracked.txt"), "also preserve this\n");

  const calls = [];
  const result = await runWorkflow("repository.post-merge.next-work", [
    "--repo", main.repo, "--published-head", localHead, "--confirmed-merged", "--apply",
  ], {
    cwd: main.repo, artifactRoot: path.join(main.temporary, "runs"),
    syncPullDependencies: { git: recordedSyncGit(calls), now: () => NEXT_WORK_DATE },
  });
  assert.equal(result.status, "not-applied");
  assert.equal(result.mutation_invoked, false);
  assert.match(result.error.message, /fetched base does not contain the current -done HEAD.*recover done/);
  assert.equal(calls.some(([command]) => ["stash", "switch"].includes(command)), false);
  assert.equal(git(main.repo, "branch", "--show-current"), done);
  assert.equal(git(main.repo, "rev-parse", "HEAD"), localHead);
  assert.equal(await readFile(path.join(main.repo, "untracked.txt"), "utf8"), "also preserve this\n");
});

test("post-merge stops if the remote base is deleted but its tracking ref remains", async (t) => {
  const state = await mergedScenario(t);
  git(state.remote, "update-ref", "-d", "refs/heads/devel");
  assert.equal(git(state.repo, "rev-parse", "origin/devel"), state.expectedHead);
  await assert.rejects(runNextWork(nextWorkOptions(state)), /git fetch failed/);
  assert.equal(git(state.repo, "branch", "--show-current"), `${state.branch}-done`);
});

test("post-merge branch preparation preserves native Git tracking and rebase policies", async (t) => {
  for (const merge of ["true", "false", "inherit", "simple", "always"]) {
    for (const rebase of ["never", "remote"]) {
      const state = await scenario(t);
      git(state.repo, "config", "branch.autoSetupMerge", merge);
      git(state.repo, "config", "branch.autoSetupRebase", rebase);
      const base = git(state.repo, "rev-parse", "origin/devel");
      git(state.repo, "branch", "control", "origin/devel");
      const result = prepareNextWorkBranch(state.repo, "candidate", base, "refs/remotes/origin/devel");
      const config = (name) => (spawnSync("git", ["config", "--local", "--get-regexp", `^branch\\.${name}\\.`], { cwd: state.repo, encoding: "utf8" }).stdout || "")
        .replaceAll(`branch.${name}.`, "branch.NEXT.").trim().split("\n").sort();
      assert.deepEqual(config("candidate"), config("control"), `${merge}/${rebase}`);
      assert.equal(result.upstream, git(state.repo, "for-each-ref", "--format=%(upstream)", "refs/heads/control"));
      assert.equal(git(state.repo, "rev-parse", "candidate"), base);
      assert.equal(git(state.repo, "branch", "--show-current"), state.branch);
    }
  }
});

test("post-merge branch preparation stops before checkout if the shared ref moves", async (t) => {
  const state = await scenario(t);
  const base = git(state.repo, "rev-parse", "origin/devel");
  const calls = []; const localGit = recordedGit(calls);
  assert.throws(() => prepareNextWorkBranch(state.repo, "candidate", base, "refs/remotes/origin/devel", (cwd, args, allowFailure) => {
    if (args[0] === "branch" && args[1] === "candidate") git(state.repo, "update-ref", "refs/remotes/origin/devel", state.expectedHead);
    return localGit(cwd, args, allowFailure);
  }), /pinned base/);
  assert.equal(git(state.repo, "branch", "--show-current"), state.branch);
  assert.ok(!calls.some((args) => args[0] === "switch"));
});

test("post-merge carries unstaged edits, deletions and new files while retaining both new and existing stashes", async (t) => {
  const state = await mergedScenario(t);
  await writeFile(path.join(state.repo, "README.md"), "older stash\n");
  git(state.repo, "stash", "push", "-m", "existing stash");
  const olderStash = git(state.repo, "rev-parse", "refs/stash");
  await writeFile(path.join(state.repo, "README.md"), "next work\n");
  await rm(path.join(state.repo, "feature.txt"));
  const bytes = Buffer.from([0, 255, 13, 10, 128]);
  await writeFile(path.join(state.repo, "new file.bin"), bytes);
  const calls = [];

  const result = await runNextWork(nextWorkOptions(state), {
    syncPullDependencies: { git: recordedSyncGit(calls), now: () => NEXT_WORK_DATE },
  });

  assert.equal(result.final_branch, "devel-tiga0725ief");
  assert.equal(result.base_commit, state.expectedHead);
  assert.equal(result.comparison, "0 0");
  assert.equal(await readFile(path.join(state.repo, "README.md"), "utf8"), "next work\n");
  await assert.rejects(readFile(path.join(state.repo, "feature.txt")), { code: "ENOENT" });
  assert.deepEqual(await readFile(path.join(state.repo, "new file.bin")), bytes);
  assert.equal(git(state.repo, "diff", "--cached", "--name-only"), "");
  assert.match(git(state.repo, "status", "--porcelain"), /\?\? "new file.bin"/);
  assert.deepEqual(result.carryover, {
    stash_sha: git(state.repo, "rev-parse", "refs/stash"),
    stash_retained: true,
    restore_status: "restored",
    working_tree: "dirty",
  });
  assert.notEqual(result.carryover.stash_sha, olderStash);
  assert.deepEqual(git(state.repo, "stash", "list", "--format=%H").split("\n"), [result.carryover.stash_sha, olderStash]);
  assert.ok(calls.some((args) => args[0] === "stash" && args[1] === "push" && args.includes("--include-untracked")));
  assert.equal(calls.filter((args) => args.includes("stash") && args.includes("apply") && args.includes(result.carryover.stash_sha)).length, 1);
  assert.ok(!calls.some((args) => args[0] === "stash" && ["pop", "drop", "clear"].includes(args[1])));
});

test("post-merge carries untracked-only work through the runner and reports the retained stash", async (t) => {
  const state = await mergedScenario(t);
  await writeFile(path.join(state.repo, "new.txt"), "new work\n");
  const result = await runWorkflow("repository.post-merge.next-work", [
    "--repo", state.repo, "--published-head", state.expectedHead, "--confirmed-merged", "--apply",
  ], {
    cwd: state.repo,
    artifactRoot: path.join(state.temporary, "runs"),
    runId: "carryover-success",
    postMergeDependencies: { now: () => NEXT_WORK_DATE },
  });

  assert.equal(result.status, "success");
  assert.equal(result.mutation_invoked, true);
  assert.equal(await readFile(path.join(state.repo, "new.txt"), "utf8"), "new work\n");
  assert.equal(git(state.repo, "status", "--porcelain"), "?? new.txt");
  assert.match(result.human_output, new RegExp(`Carryover stash: ${result.result.carryover.stash_sha}`));
  assert.match(result.human_output, /Stash retained: yes\nRestore status: restored\nWorking tree: dirty/);
  const saved = JSON.parse(await readFile(path.join(state.temporary, "runs", "carryover-success", "result.json"), "utf8"));
  assert.deepEqual(saved.result.carryover, result.result.carryover);
});

test("post-merge staged changes stop before stash or branch creation", async (t) => {
  const state = await mergedScenario(t);
  await writeFile(path.join(state.repo, "README.md"), "staged\n");
  git(state.repo, "add", "README.md");
  await writeFile(path.join(state.repo, "README.md"), "unstaged too\n");
  const status = git(state.repo, "status", "--porcelain");
  const calls = [];
  await assert.rejects(runNextWork(nextWorkOptions(state), { syncPullDependencies: { git: recordedSyncGit(calls), now: () => NEXT_WORK_DATE } }),
    (error) => error.mutationInvoked === false && /staged changes/.test(error.message));
  assert.equal(git(state.repo, "status", "--porcelain"), status);
  assert.equal(git(state.repo, "branch", "--show-current"), `${state.branch}-done`);
  assert.ok(!calls.some((args) => ["stash", "switch", "fetch"].includes(args[0])));
});

test("post-merge skips work and frozen branch namespace collisions and carries unstaged work", async (t) => {
  const state = await mergedScenario(t);
  git(state.repo, "branch", "devel-tiga0725ief/topic", "devel");
  git(state.repo, "branch", "devel-tiga0725ieg-done/topic", "devel");
  const old = git(state.repo, "rev-parse", "devel");
  await writeFile(path.join(state.repo, "README.md"), "uncommitted\n");
  const result = await runNextWork(nextWorkOptions(state), { now: () => NEXT_WORK_DATE });
  assert.equal(result.final_branch, "devel-tiga0725ieh");
  assert.equal(git(state.repo, "rev-parse", "devel-tiga0725ief/topic"), old);
  assert.equal(git(state.repo, "rev-parse", "devel-tiga0725ieg-done/topic"), old);
  assert.equal(git(state.repo, "rev-parse", `${state.branch}-done`), state.expectedHead);
  assert.equal(await readFile(path.join(state.repo, "README.md"), "utf8"), "uncommitted\n");
});

test("legacy post-merge entry refuses an ignored target before stash or branch creation", async (t) => {
  const state = await mergedScenario(t);
  const upstream = path.join(state.temporary, "ignored-upstream");
  execFileSync("git", ["clone", "--branch", "devel", state.remote, upstream], { stdio: "ignore" });
  git(upstream, "config", "user.name", "Test User");
  git(upstream, "config", "user.email", "test@example.invalid");
  await mkdir(path.join(upstream, "ignored"), { recursive: true });
  await writeFile(path.join(upstream, "ignored", "config.txt"), "remote version\n");
  git(upstream, "add", "ignored/config.txt");
  git(upstream, "commit", "-m", "Track ignored target");
  git(upstream, "push", "origin", "devel");
  const exclude = path.join(state.repo, ".git", "info", "exclude");
  await writeFile(exclude, "ignored/config.txt\n");
  await mkdir(path.join(state.repo, "ignored"), { recursive: true });
  await writeFile(path.join(state.repo, "ignored", "config.txt"), "local ignored version\n");
  await writeFile(path.join(state.repo, "carry.txt"), "preserve this too\n");
  const beforeStash = git(state.repo, "stash", "list", "--format=%H");
  const calls = [];

  await assert.rejects(runNextWork(nextWorkOptions(state), {
    syncPullDependencies: { now: () => NEXT_WORK_DATE, git: recordedSyncGit(calls) },
  }), (error) => error.mutationInvoked === false && /Ignored path would be overwritten by sync/.test(error.message));

  assert.equal(git(state.repo, "branch", "--show-current"), `${state.branch}-done`);
  assert.equal(await readFile(path.join(state.repo, "ignored", "config.txt"), "utf8"), "local ignored version\n");
  assert.equal(await readFile(path.join(state.repo, "carry.txt"), "utf8"), "preserve this too\n");
  assert.equal(git(state.repo, "stash", "list", "--format=%H"), beforeStash);
  assert.equal(calls.some((args) => args[0] === "stash" || (args[0] === "branch" && args[1] === "backup")), false);
});

test("post-merge fetch failure leaves unstaged work and the done branch untouched", async (t) => {
  const state = await mergedScenario(t);
  git(state.repo, "remote", "set-url", "origin", path.join(state.temporary, "missing-remote.git"));
  await writeFile(path.join(state.repo, "README.md"), "remain here\n");
  const calls = [];
  await assert.rejects(runNextWork(nextWorkOptions(state), { syncPullDependencies: { git: recordedSyncGit(calls), now: () => NEXT_WORK_DATE } }),
    (error) => error.mutationInvoked === false && /git fetch/.test(error.message));
  assert.equal(await readFile(path.join(state.repo, "README.md"), "utf8"), "remain here\n");
  assert.equal(git(state.repo, "branch", "--show-current"), `${state.branch}-done`);
  assert.ok(!calls.some((args) => ["stash", "switch"].includes(args[0])));
});

test("post-merge a missing new stash never falls back to an existing stash", async (t) => {
  const state = await mergedScenario(t);
  await writeFile(path.join(state.repo, "README.md"), "older work\n");
  git(state.repo, "stash", "push", "-m", "existing stash");
  const existing = git(state.repo, "rev-parse", "refs/stash");
  await writeFile(path.join(state.repo, "README.md"), "new work\n");
  const calls = [];
  let failure;
  await assert.rejects(runNextWork(nextWorkOptions(state), {
    syncPullDependencies: {
      now: () => NEXT_WORK_DATE,
      git: recordedSyncGit(calls, (_cwd, args) => args[0] === "stash" && args[1] === "push"
        ? { ok: true, code: 0, stdout: "No local changes to save", out: "No local changes to save", bytes: Buffer.from("No local changes to save"), err: "" }
        : undefined),
    },
  }), (error) => { failure = error; return /stash creation did not complete/.test(error.message); });
  assert.equal(failure.recovery.stash_sha, null);
  assert.equal(failure.recovery.stash_retained, false);
  assert.equal(git(state.repo, "rev-parse", "refs/stash"), existing);
  assert.equal(await readFile(path.join(state.repo, "README.md"), "utf8"), "new work\n");
  assert.ok(!calls.some((args) => args[0] === "switch" || (args[0] === "stash" && ["apply", "pop", "drop"].includes(args[1]))));
});

test("post-merge branch-creation failure retains the exact stash without applying or dropping it", async (t) => {
  const state = await mergedScenario(t);
  await writeFile(path.join(state.repo, "README.md"), "preserve me\n");
  const calls = [];
  let failure;
  await assert.rejects(runNextWork(nextWorkOptions(state), {
    syncPullDependencies: {
      now: () => NEXT_WORK_DATE,
      git: recordedSyncGit(calls, (_cwd, args) => {
        if (args[0] === "switch") throw new Error("git switch failed: injected failure");
        return undefined;
      }),
    },
  }), (error) => { failure = error; return error.mutationInvoked === true; });
  assert.equal(failure.recovery.stage, "next-work-switch");
  assert.equal(failure.recovery.final_branch, `${state.branch}-done`);
  assert.equal(failure.recovery.stash_retained, true);
  assert.equal(failure.recovery.restore_status, "not-started");
  assert.equal(failure.recovery.working_tree, "clean");
  assert.ok(failure.recovery.operation_id);
  assert.equal(git(state.repo, "show", `${failure.recovery.stash_sha}:README.md`), "preserve me");
  assert.equal(calls.filter((args) => args[0] === "switch").length, 1);
  assert.ok(!calls.some((args) => args[0] === "stash" && ["apply", "pop", "drop"].includes(args[1])));
});

test("post-merge a partially failed stash creation reports the created stash and stops before switching", async (t) => {
  const state = await mergedScenario(t);
  await writeFile(path.join(state.repo, "new.txt"), "preserve new file\n");
  const calls = [];
  let failure;
  await assert.rejects(runNextWork(nextWorkOptions(state), {
    syncPullDependencies: {
      now: () => NEXT_WORK_DATE,
      git: recordedSyncGit(calls, (cwd, args, options) => {
        if (args[0] !== "stash" || args[1] !== "push") return undefined;
        return { ...runSyncGit(cwd, args, options), ok: false, code: 1, err: "injected partial failure" };
      }),
    },
  }), (error) => { failure = error; return /stash creation did not complete/.test(error.message); });
  assert.equal(failure.mutationInvoked, true);
  assert.equal(failure.recovery.stage, "stash-create");
  assert.equal(failure.recovery.stash_retained, true);
  assert.equal(git(state.repo, "show", `${failure.recovery.stash_sha}^3:new.txt`), "preserve new file");
  assert.ok(!calls.some((args) => args[0] === "switch"));
});

test("post-merge restore conflict preserves the stash and reports recoverable partial state through the runner", async (t) => {
  const state = await mergedScenario(t);
  await writeFile(path.join(state.repo, "README.md"), "upstream edit\n");
  git(state.repo, "add", "README.md");
  git(state.repo, "commit", "-m", "upstream edit");
  const baseHead = git(state.repo, "rev-parse", "HEAD");
  git(state.repo, "push", "origin", "HEAD:devel");
  // Recreate the frozen PR branch at its original HEAD, then add follow-up work.
  git(state.repo, "switch", "--detach", state.expectedHead);
  git(state.repo, "branch", "-f", `${state.branch}-done`, state.expectedHead);
  git(state.repo, "switch", `${state.branch}-done`);
  await writeFile(path.join(state.repo, "README.md"), "local follow-up\n");
  const calls = [];
  const result = await runWorkflow("repository.post-merge.next-work", [
    "--repo", state.repo, "--published-head", state.expectedHead, "--confirmed-merged", "--apply",
  ], {
    cwd: state.repo,
    artifactRoot: path.join(state.temporary, "runs"),
    runId: "carryover-conflict",
    syncPullDependencies: { git: recordedSyncGit(calls), now: () => NEXT_WORK_DATE },
  });

  assert.equal(result.status, "unresolved");
  assert.equal(result.mutation_invoked, true);
  assert.equal(result.error.retryability, "do-not-retry");
  assert.equal(result.error.recovery.stage, "stash-restore");
  assert.equal(result.error.recovery.final_branch, "devel-tiga0725ief");
  assert.equal(result.error.recovery.restore_status, "failed");
  assert.equal(result.error.recovery.stash_retained, true);
  assert.ok(result.error.recovery.operation_id);
  assert.equal(git(state.repo, "rev-parse", "HEAD"), baseHead);
  assert.equal(git(state.repo, "show", `${result.error.recovery.stash_sha}:README.md`), "local follow-up");
  assert.equal(git(state.repo, "status", "--porcelain"), "UU README.md");
  assert.equal(calls.filter((args) => args.includes("stash") && args.includes("apply")).length, 1);
  assert.ok(!calls.some((args) => args[0] === "reset" || (args[0] === "stash" && ["pop", "drop", "clear"].includes(args[1]))));
  assert.match(result.human_output, /Stopped stage: stash-restore/);
  assert.match(result.human_output, /Recovery operation:/);
  assert.match(result.human_output, /miku-scm sync pull --resume/);
  assert.match(result.human_output, /Stash retained: yes\nRestore status: failed\nWorking tree: dirty/);
  assert.doesNotMatch(result.human_output, /Next work branch is ready/);
  const saved = JSON.parse(await readFile(path.join(state.temporary, "runs", "carryover-conflict", "result.json"), "utf8"));
  assert.deepEqual(saved.error.recovery, result.error.recovery);
  const attempt = JSON.parse(await readFile(path.join(state.temporary, "runs", "carryover-conflict", "attempt.json"), "utf8"));
  assert.equal(attempt.status, "unresolved");
  const operationId = result.error.recovery.operation_id;
  assert.ok(result.human_output.includes("sync pull --resume " + operationId + " --resolved-carryover"));
  const applyCount = calls.filter((args) => args.includes("stash") && args.includes("apply")).length;
  await writeFile(path.join(state.repo, "README.md"), "resolved local and upstream work\n");
  git(state.repo, "add", "README.md");
  const resumed = await runWorkflow("repository.sync.pull", [
    "--repo", state.repo, "--resume", operationId, "--resolved-carryover", "--apply",
  ], {
    cwd: state.repo,
    artifactRoot: path.join(state.temporary, "runs"),
    runId: "carryover-conflict-resumed",
    syncPullDependencies: { git: recordedSyncGit(calls), now: () => NEXT_WORK_DATE },
  });
  assert.equal(resumed.status, "success");
  assert.equal(resumed.result.status, "completed");
  assert.equal(resumed.result.operation_id, operationId);
  assert.equal(await readFile(path.join(state.repo, "README.md"), "utf8"), "resolved local and upstream work\n");
  assert.equal(calls.filter((args) => args.includes("stash") && args.includes("apply")).length, applyCount);
  assert.ok(git(state.repo, "stash", "list", "--format=%H").includes(result.error.recovery.stash_sha));
});

test("legacy post-merge checkout failure resumes through the saved sync-pull operation", async (t) => {
  const state = await mergedScenario(t);
  await writeFile(path.join(state.repo, "carry.txt"), "preserve through resume\n");
  const hooks = path.join(state.repo, ".git", "hooks");
  await mkdir(hooks, { recursive: true });
  git(state.repo, "config", "core.hooksPath", hooks);
  await writeFile(path.join(hooks, "post-checkout"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const dependencies = {
    cwd: state.repo,
    artifactRoot: path.join(state.temporary, "runs"),
    runId: "legacy-checkout-stopped",
    syncPullDependencies: { now: () => NEXT_WORK_DATE },
  };

  const stopped = await runWorkflow("repository.post-merge.next-work", [
    "--repo", state.repo, "--published-head", state.expectedHead, "--confirmed-merged", "--apply",
  ], dependencies);

  assert.equal(stopped.status, "unresolved");
  assert.equal(stopped.error.recovery.stage, "next-work-switch");
  assert.ok(stopped.error.recovery.stash_retained);
  assert.ok(stopped.error.recovery.operation_id);
  assert.match(stopped.human_output, new RegExp(`sync pull --resume ${stopped.error.recovery.operation_id} --resolved-next-work`));
  const branches = git(state.repo, "for-each-ref", "--format=%(refname)", "refs/heads");
  const stashes = git(state.repo, "stash", "list", "--format=%H");
  await assert.rejects(readFile(path.join(state.repo, "carry.txt")), { code: "ENOENT" });

  const resumed = await runWorkflow("repository.sync.pull", [
    "--repo", state.repo, "--resume", stopped.error.recovery.operation_id, "--resolved-next-work", "--apply",
  ], { ...dependencies, runId: "legacy-checkout-resumed" });

  assert.equal(resumed.status, "success");
  assert.equal(resumed.result.status, "completed");
  assert.equal(resumed.result.operation_id, stopped.error.recovery.operation_id);
  assert.equal(git(state.repo, "for-each-ref", "--format=%(refname)", "refs/heads"), branches);
  assert.equal(git(state.repo, "stash", "list", "--format=%H"), stashes);
  assert.equal(await readFile(path.join(state.repo, "carry.txt"), "utf8"), "preserve through resume\n");
});

test("legacy post-merge resumes normally when branch creation left no ref", async (t) => {
  const state = await mergedScenario(t);
  await writeFile(path.join(state.repo, "carry.txt"), "restore after normal retry\n");
  const calls = [];
  let failCreation = true;
  const dependencies = {
    cwd: state.repo,
    artifactRoot: path.join(state.temporary, "runs"),
    runId: "legacy-create-absent",
    syncPullDependencies: {
      now: () => NEXT_WORK_DATE,
      git: recordedSyncGit(calls, (_cwd, args) => {
        if (failCreation && args[0] === "branch" && args[1] === "devel-tiga0725ief") {
          throw new Error("git branch failed: injected pre-ref failure");
        }
        return undefined;
      }),
    },
  };
  const stopped = await runWorkflow("repository.post-merge.next-work", [
    "--repo", state.repo, "--published-head", state.expectedHead, "--confirmed-merged", "--apply",
  ], dependencies);

  assert.equal(stopped.status, "unresolved");
  const operationId = stopped.error.recovery.operation_id;
  assert.ok(operationId);
  assert.equal(stopped.error.recovery.stage, "next-work-create");
  assert.match(stopped.error.recovery.next_action, new RegExp(`sync pull --resume ${operationId}(?: |$)`));
  assert.doesNotMatch(stopped.error.recovery.next_action, /--resolved-next-work/);
  assert.throws(() => git(state.repo, "show-ref", "--verify", "refs/heads/devel-tiga0725ief"));
  failCreation = false;

  const resumed = await runWorkflow("repository.sync.pull", [
    "--repo", state.repo, "--resume", operationId, "--apply",
  ], { ...dependencies, runId: "legacy-create-absent-resumed" });

  assert.equal(resumed.status, "success");
  assert.equal(resumed.result.status, "completed");
  assert.equal(resumed.result.operation_id, operationId);
  assert.equal(git(state.repo, "branch", "--show-current"), "devel-tiga0725ief");
  assert.equal(await readFile(path.join(state.repo, "carry.txt"), "utf8"), "restore after normal retry\n");
  assert.equal(calls.filter((args) => args.includes("stash") && args.includes("apply")).length, 1);
});

test("legacy post-merge resumes a branch ref left by interrupted tracking setup", async (t) => {
  const state = await mergedScenario(t);
  await writeFile(path.join(state.repo, "carry.txt"), "restore exactly once\n");
  const configLock = path.join(state.repo, ".git", "config.lock");
  const calls = [];
  const dependencies = {
    cwd: state.repo,
    artifactRoot: path.join(state.temporary, "runs"),
    runId: "legacy-create-stopped",
    syncPullDependencies: {
      now: () => NEXT_WORK_DATE,
      beforeAction: async (phase) => {
        if (phase === "next-work-create") await writeFile(configLock, "injected config lock\n", { flag: "wx" });
      },
      git: recordedSyncGit(calls),
    },
  };

  const stopped = await runWorkflow("repository.post-merge.next-work", [
    "--repo", state.repo, "--published-head", state.expectedHead, "--confirmed-merged", "--apply",
  ], dependencies);

  assert.equal(stopped.status, "unresolved");
  assert.equal(stopped.error.recovery.stage, "next-work-create");
  const operationId = stopped.error.recovery.operation_id;
  const nextBranch = "devel-tiga0725ief";
  assert.ok(operationId);
  assert.match(stopped.error.recovery.next_action, new RegExp(`sync pull --resume ${operationId} --resolved-next-work`));
  const saved = JSON.parse(await readFile(path.join(state.repo, "workplace/miku-scm/sync/operations", operationId, "state.json"), "utf8"));
  assert.equal(saved.status, "partial");
  assert.equal(saved.next_work.phase, "creating");
  assert.equal(git(state.repo, "rev-parse", nextBranch), saved.base_sha);
  assert.equal(git(state.repo, "for-each-ref", "--format=%(upstream)", `refs/heads/${nextBranch}`), "");
  assert.equal(calls.filter((args) => args.includes("stash") && args.includes("apply")).length, 0);
  await rm(configLock, { force: true });
  git(state.repo, "branch", "--set-upstream-to=origin/devel", nextBranch);

  const resumed = await runWorkflow("repository.sync.pull", [
    "--repo", state.repo, "--resume", operationId, "--resolved-next-work", "--apply",
  ], { ...dependencies, runId: "legacy-create-resumed" });

  assert.equal(resumed.status, "success");
  assert.equal(resumed.result.status, "completed");
  assert.equal(resumed.result.operation_id, operationId);
  assert.equal(git(state.repo, "branch", "--show-current"), nextBranch);
  assert.equal(git(state.repo, "rev-parse", "--symbolic-full-name", "@{upstream}"), "refs/remotes/origin/devel");
  assert.equal(await readFile(path.join(state.repo, "carry.txt"), "utf8"), "restore exactly once\n");
  assert.equal(calls.filter((args) => args.includes("stash") && args.includes("apply")).length, 1);
  assert.ok(git(state.repo, "stash", "list", "--format=%H").includes(saved.stash_sha));
});

test("post-merge an untracked path collision retains the original file in the stash", async (t) => {
  const state = await mergedScenario(t);
  await writeFile(path.join(state.repo, "new.txt"), "upstream file\n");
  git(state.repo, "add", "new.txt");
  git(state.repo, "commit", "-m", "upstream new file");
  git(state.repo, "push", "origin", "HEAD:devel");
  git(state.repo, "switch", "--detach", state.expectedHead);
  git(state.repo, "branch", "-f", `${state.branch}-done`, state.expectedHead);
  git(state.repo, "switch", `${state.branch}-done`);
  await writeFile(path.join(state.repo, "new.txt"), "local new file\n");
  let failure;
  await assert.rejects(runNextWork(nextWorkOptions(state), { now: () => NEXT_WORK_DATE }),
    (error) => { failure = error; return /carryover restoration requires resolution/i.test(error.message); });
  assert.equal(failure.recovery.stash_retained, true);
  assert.equal(failure.recovery.final_branch, "devel-tiga0725ief");
  assert.equal(git(state.repo, "show", `${failure.recovery.stash_sha}^3:new.txt`), "local new file");
  assert.equal(await readFile(path.join(state.repo, "new.txt"), "utf8"), "upstream file\n");
});

test("post-merge helper uses remote HEAD for a legacy done branch with a feature upstream", async (t) => {
  const state = await scenario(t);
  const legacy = "tiga0501xea";
  git(state.repo, "branch", "-m", state.branch, legacy);
  git(state.repo, "push", "-u", "origin", `HEAD:refs/heads/${legacy}`);
  git(state.repo, "push", "origin", "HEAD:refs/heads/devel");
  git(state.repo, "remote", "set-head", "origin", "devel");
  git(state.repo, "branch", "-m", legacy, `${legacy}-done`);
  assert.equal(git(state.repo, "rev-parse", "--abbrev-ref", "@{upstream}"), `origin/${legacy}`);

  const result = await runNextWork({
    repo: state.repo,
    remote: "origin",
    base: "",
    publishedHead: state.expectedHead,
    confirmedMerged: true,
    apply: true,
  }, {
    now: () => new Date("2026-08-09T13:18:00+09:00"),
  });

  assert.equal(result.status, "created");
  assert.equal(result.previous_branch, `${legacy}-done`);
  assert.equal(result.base, "devel");
  assert.equal(result.final_branch, "devel-tiga0809nbi");
  assert.equal(result.comparison, "0 0");
  assert.equal(git(state.repo, "branch", "--show-current"), "devel-tiga0809nbi");
});

test("post-merge helper derives a content VERSION.md tag after same-day overflow", async (t) => {
  const state = await scenario(t);
  await writeFile(path.join(state.repo, "VERSION.md"), "20260725aa\n", "utf8");
  git(state.repo, "add", "VERSION.md");
  git(state.repo, "commit", "-m", "add content version");
  state.expectedHead = git(state.repo, "rev-parse", "HEAD");
  git(state.repo, "push", "origin", "HEAD:devel");
  git(state.repo, "branch", "-m", state.branch, `${state.branch}-done`);

  const result = await runNextWork(nextWorkOptions(state), {
    now: () => new Date("2026-07-25T08:45:00+09:00"),
  });

  assert.equal(result.version_source, "VERSION.md");
  assert.equal(result.version, "20260725aa");
  assert.equal(result.recommended_tag, "v20260725aa");
});

