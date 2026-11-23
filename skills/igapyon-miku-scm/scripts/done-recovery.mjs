#!/usr/bin/env node

import { lstat, realpath } from "node:fs/promises";
import { devNull } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { DONE_RESCUE_PREFIX } from "./miku-scm-rescue-branch.mjs";
import { syncGit, zeros } from "./miku-scm-sync-state.mjs";

export function parseArgs(argv, cwd = process.cwd()) {
  const options = { repo: cwd, apply: false, help: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (seen.has(argument)) throw new Error(`${argument} may be specified once`);
    seen.add(argument);
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--repo") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--repo requires a value");
      options.repo = value;
    } else if (argument === "--apply") {
      options.apply = true;
    } else if (["--confirmed-merged", "--resume", "--resolved-carryover"].includes(argument)) {
      throw new Error(`${argument} is unavailable for local rescue. Inspect any retained recovery records, branches and stash before acting.`);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!options.help && !options.apply) throw new Error("--apply is required");
  return options;
}

async function requireIdle(git) {
  const gitDir = git(["rev-parse", "--path-format=absolute", "--git-dir"]).out;
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_START"]) {
    try {
      await lstat(path.join(gitDir, name));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(`An existing ${name} operation must be resolved first`);
  }
  if (git(["ls-files", "--unmerged", "-z"]).bytes.length) {
    throw new Error("Resolve index conflicts before recovering this branch");
  }
}

function rescueSnapshot(git) {
  const branch = git(["branch", "--show-current"]).out;
  const head = git(["rev-parse", "HEAD"]).out;
  const index = git(["ls-files", "--stage", "-z"]).bytes;
  return { branch, head, index };
}

function chooseRescueBranch(source, head, git) {
  const prefix = `${DONE_RESCUE_PREFIX}${source}/${head.slice(0, 12)}`;
  const refs = new Set(git(["for-each-ref", "--format=%(refname:strip=2)", "refs/heads"]).out.split("\n"));
  // A parent ref prevents creation beneath it, regardless of the suffix.
  const parents = prefix.split("/").slice(0, -1);
  for (let length = 1; length <= parents.length; length += 1) {
    if (refs.has(parents.slice(0, length).join("/"))) {
      throw new Error("An existing branch occupies the parent of the local rescue branch");
    }
  }
  for (let suffix = 1; suffix <= refs.size + 1; suffix += 1) {
    const candidate = suffix === 1 ? prefix : `${prefix}-${suffix}`;
    if (refs.has(candidate) || [...refs].some((ref) => ref.startsWith(`${candidate}/`))) continue;
    git(["check-ref-format", "--branch", candidate]);
    return candidate;
  }
  throw new Error("Could not choose an unused local rescue branch");
}

export async function run(options, { git: gitRunner = syncGit } = {}) {
  let mutationInvoked = false;
  let git;
  let initial;
  let next;
  try {
    if (!options.apply) throw new Error("--apply is required");
    const root = await realpath(gitRunner(options.repo, ["rev-parse", "--show-toplevel"]).out);
    git = (args, settings) => gitRunner(root, args, settings);
    const source = git(["branch", "--show-current"]).out;
    if (!source.endsWith("-done") || source.startsWith(DONE_RESCUE_PREFIX)) {
      throw new Error("Current branch must be a frozen -done branch");
    }
    const hooks = git(["config", "-z", "--name-only", "--get-regexp", "^hook\\..*\\.event$"], { allowFailure: true });
    if (hooks.code !== 0 && hooks.code !== 1) throw new Error("Cannot inspect configured Git hooks before rescue");
    // --config-env also supports hook names containing an equals sign.
    const hookOverrides = [...new Set(zeros(hooks.stdout))].map((key) =>
      `--config-env=${key.slice(0, -".event".length)}.enabled=MIKU_SCM_RESCUE_HOOK_ENABLED`);
    // Status and diff can refresh the index and invoke post-index-change.
    git = (args, settings) => gitRunner(root, ["-c", `core.hooksPath=${devNull}`, ...hookOverrides, ...args],
      { ...settings, env: { MIKU_SCM_RESCUE_HOOK_ENABLED: "false" } });
    await requireIdle(git);
    initial = rescueSnapshot(git);
    if (initial.branch !== source) throw new Error("Current branch changed during rescue inspection");
    next = chooseRescueBranch(source, initial.head, git);
    const checked = rescueSnapshot(git);
    if (checked.branch !== source || checked.head !== initial.head || !checked.index.equals(initial.index)) {
      throw new Error("Branch, HEAD or index changed before rescue");
    }
    await requireIdle(git);
    mutationInvoked = true;
    // Git uses the current HEAD as the start point, so the checkout does not
    // deliberately install a different tree even if HEAD has just advanced.
    git(["switch", "--no-overwrite-ignore", "--no-track", "--no-recurse-submodules", "-c", next]);
    const final = rescueSnapshot(git);
    if (final.branch !== next
      || git(["rev-parse", "--verify", `refs/heads/${source}`]).out !== initial.head
      || final.head !== initial.head || !final.index.equals(initial.index)) {
      throw new Error("Branch, HEAD or index differs from the expected rescue state");
    }
    return {
      status: "rescued",
      previous_branch: source,
      next_branch: next,
      final_branch: final.branch,
      head: final.head,
      working_tree: "unknown",
      mutation_invoked: true,
    };
  } catch (error) {
    error.mutationInvoked = mutationInvoked;
    if (mutationInvoked) {
      error.recovery = {
        previous_branch: initial.branch,
        next_branch: next,
        final_branch: git(["branch", "--show-current"], { allowFailure: true }).out || null,
        head: git(["rev-parse", "--verify", "HEAD"], { allowFailure: true }).out || null,
        next_action: "Inspect the observed branch, HEAD, index and worktree before attempting another recovery.",
      };
    }
    throw error;
  }
}

export async function cli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write("Usage: done-recovery.mjs [--repo path] --apply\n");
    return;
  }
  process.stdout.write(`${JSON.stringify(await run(options), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "error", message: error.message, recovery: error.recovery ?? null })}\n`);
    process.exitCode = 1;
  });
}
