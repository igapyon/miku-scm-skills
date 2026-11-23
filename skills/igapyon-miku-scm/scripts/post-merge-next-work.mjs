#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { syncGit } from "./miku-scm-sync-state.mjs";
import { runSyncPull } from "./sync-pull.mjs";

export { classifyTagLookup, createNextWorkBranch, nextWorkAdvice, prepareNextWorkBranch, workBranchName } from "./miku-scm-next-work.mjs";

const NAME = /^[A-Za-z0-9._-]+$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function runner(cwd, args, allowFailure = false) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0 && !allowFailure) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return { ok: r.status === 0, stdout: r.stdout || "", out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

function observeGit(git, root, args) {
  try {
    const result = git(root, args, { allowFailure: true });
    return { ok: result.ok ?? result.code === 0, out: result.out ?? result.stdout ?? "" };
  } catch {
    return { ok: false, out: "" };
  }
}

export function parseArgs(argv, cwd = process.cwd()) {
  const o = { repo: cwd, remote: "origin", base: "", publishedHead: "", confirmedMerged: false, apply: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--repo") o.repo = argv[++i] ?? "";
    else if (a === "--remote") o.remote = argv[++i] ?? "";
    else if (a === "--base") o.base = argv[++i] ?? "";
    else if (a === "--published-head") {
      if (o.publishedHead) throw new Error("--published-head may be specified once");
      o.publishedHead = argv[++i] ?? "";
    }
    else if (a === "--confirmed-merged") o.confirmedMerged = true;
    else if (a === "--apply") o.apply = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (o.help) return o;
  if (!o.confirmedMerged || !o.apply) throw new Error("--confirmed-merged and --apply are required");
  if (!OBJECT_ID.test(o.publishedHead)) throw new Error("--published-head requires the full object ID of the published PR head");
  if (![o.remote, o.base || "devel"].every((v) => NAME.test(v))) throw new Error("--remote and --base must be Git names");
  return o;
}

function baseFromDoneBranch(branch) {
  return branch.match(/^(.+)-tiga\d{4}[a-x][a-j][a-j]-done$/)?.[1] ?? "";
}

function baseFromRemoteHead(root, remote, git = runner) {
  const symbolic = git(root, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`], true);
  const prefix = `${remote}/`;
  if (!symbolic.ok || !symbolic.out.startsWith(prefix)) return "";
  const base = symbolic.out.slice(prefix.length);
  return NAME.test(base) ? base : "";
}

export async function run(options, dependencies = {}) {
  const git = dependencies.git ?? runner;
  let pullStarted = false;
  try {
    if (!options.confirmedMerged || !options.apply) throw new Error("--confirmed-merged and --apply are required");
    if (!OBJECT_ID.test(options.publishedHead ?? "")) throw new Error("--published-head requires the full object ID of the published PR head");
    const root = git(options.repo, ["rev-parse", "--show-toplevel"]).out;
    const previous = git(root, ["branch", "--show-current"]).out;
    if (!previous.endsWith("-done")) throw new Error("Current branch must end in -done");
    const head = git(root, ["rev-parse", "HEAD"]).out;
    if (head !== options.publishedHead.toLowerCase()) {
      throw new Error(`Current -done HEAD ${head} differs from published HEAD ${options.publishedHead.toLowerCase()}; use miku-scm recover done to preserve the work`);
    }
    const base = options.base || baseFromDoneBranch(previous) || baseFromRemoteHead(root, options.remote, git);
    if (!base || !NAME.test(base)) throw new Error("Base branch is unresolved; pass --base");

    const syncDependencies = { ...(dependencies.syncPullDependencies ?? {}) };
    if (dependencies.now && !syncDependencies.now) syncDependencies.now = dependencies.now;
    if (dependencies.beforeAction && !syncDependencies.beforeAction) syncDependencies.beforeAction = dependencies.beforeAction;
    pullStarted = true;
    const pulled = await runSyncPull({
      repo: root,
      remote: options.remote,
      base,
      apply: true,
      legacyPostMerge: { branch: previous, publishedHead: options.publishedHead.toLowerCase() },
    }, syncDependencies);

    if (pulled.status !== "completed" || pulled.method !== "next-work") {
      const error = new Error(pulled.reason ?? "The shared sync-pull next-work transition did not complete");
      error.mutationInvoked = pulled.mutation_invoked;
      if (pulled.diagnostic) error.gitDiagnostic = pulled.diagnostic;
      if (error.mutationInvoked) {
        const runGit = syncDependencies.git ?? syncGit;
        const observedStatus = observeGit(runGit, root, ["status", "--porcelain"]);
        const observedStashes = pulled.stash_sha
          ? observeGit(runGit, root, ["stash", "list", "--format=%H"])
          : null;
        error.recovery = {
          ...pulled,
          restore_status: pulled.restore_status ?? "not-started",
          stash_retained: !pulled.stash_sha ? false
            : observedStashes?.ok ? observedStashes.out.split("\n").includes(pulled.stash_sha) : null,
          working_tree: observedStatus.ok ? (observedStatus.out ? "dirty" : "clean") : "unknown",
        };
      }
      throw error;
    }

    const previousBranch = pulled.previous_branch;
    const finalBranch = pulled.final_branch;
    const baseName = pulled.base;
    const comparison = pulled.head === pulled.base_commit ? "0 0" : "unknown";
    const runGit = syncDependencies.git ?? syncGit;
    const observedStatus = pulled.stash_sha ? observeGit(runGit, root, ["status", "--porcelain"]) : null;
    const observedStashes = pulled.stash_sha
      ? observeGit(runGit, root, ["stash", "list", "--format=%H"])
      : null;
    const advice = {
      version: pulled.version,
      version_source: pulled.version_source,
      recommended_tag: pulled.recommended_tag,
      tag_target: pulled.tag_target,
      tag_status: pulled.tag_status,
      ...(pulled.tag_lookup_warning ? { tag_lookup_warning: pulled.tag_lookup_warning } : {}),
      ...(pulled.warnings?.length ? { warnings: pulled.warnings } : {}),
      tag_mutation: false,
      release_mutation: false,
    };
    const carryover = pulled.stash_sha ? {
      stash_sha: pulled.stash_sha,
      stash_retained: observedStashes?.ok ? observedStashes.out.split("\n").includes(pulled.stash_sha) : null,
      restore_status: "restored",
      working_tree: observedStatus?.ok ? (observedStatus.out ? "dirty" : "clean") : "unknown",
    } : undefined;
    return {
      status: "created",
      operation_id: pulled.operation_id,
      previous_branch: previousBranch,
      remote: options.remote,
      base: baseName,
      base_commit: pulled.base_commit,
      ...advice,
      next_branch: finalBranch,
      final_branch: finalBranch,
      comparison,
      tag_mutation: false,
      release_mutation: false,
      ...(carryover ? { carryover } : {}),
      human_handoff: `Next work branch is ready: ${finalBranch}`,
    };
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    if (!pullStarted) error.mutationInvoked = false;
    throw error;
  }
}

export async function cli(argv = process.argv.slice(2)) { const o = parseArgs(argv); if (o.help) return; process.stdout.write(`${JSON.stringify(await run(o), null, 2)}\n`); }
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) cli().catch((e) => { process.stderr.write(`${JSON.stringify({ status: "error", message: e.message, mutation_invoked: e.mutationInvoked, ...(e.recovery ? { recovery: e.recovery } : {}) })}\n`); process.exitCode = 1; });
