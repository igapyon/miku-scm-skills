import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";

import { jstDateParts } from "./miku-scm-jst-time.mjs";
import { parsePackageVersionPolicy } from "./miku-scm-package-version-policy.mjs";
import { branchNameConflicts, localBranchNames } from "./miku-scm-repository.mjs";

function runner(cwd, args, allowFailure = false) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0 && !allowFailure) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return { ok: r.status === 0, stdout: r.stdout || "", out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

export function workBranchName(base, date = new Date()) {
  const parts = jstDateParts(date);
  const abc = (n) => String.fromCharCode(97 + n);
  return `${base}-tiga${String(parts.month).padStart(2, "0")}${String(parts.day).padStart(2, "0")}${abc(parts.hour)}${abc(Math.floor(parts.minute / 10))}${abc(parts.minute % 10)}`;
}

export function unusedWorkBranchName(root, base, date, git = runner) {
  const branches = localBranchNames(root, git);
  for (let offset = 0; offset <= branches.length; offset += 1) {
    const next = workBranchName(base, new Date(date.getTime() + offset * 60_000));
    if (!branchNameConflicts(branches, next) && !branchNameConflicts(branches, `${next}-done`)) return next;
  }
  throw new Error("Could not choose an unused next work branch");
}

export function assertNextWorkHistory(root, git = runner) {
  const replaceRefs = process.env.GIT_REPLACE_REF_BASE || "refs/replace";
  const replacement = git(root, ["for-each-ref", "--count=1", "--format=%(refname)", "--", replaceRefs]).out;
  const result = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "info/grafts"]);
  const grafts = (result.stdout ?? result.out).replace(process.platform === "win32" ? /\r?\n$/ : /\n$/, "");
  if (replacement || statSync(grafts, { throwIfNoEntry: false })?.size) {
    throw new Error("Local Git replacements or grafts can change the history and checkout. Use miku-scm recover done to preserve the work locally.");
  }
}

export function inspectNextWorkBranch(root, next, baseCommit, git = runner) {
  if (git(root, ["rev-parse", "--verify", `refs/heads/${next}^{commit}`]).out !== baseCommit) throw new Error("Next work branch no longer points to the pinned base");
  return { upstream: git(root, ["for-each-ref", "--format=%(upstream)", `refs/heads/${next}`]).out };
}

export function prepareNextWorkBranch(root, next, baseCommit, upstream, git = runner) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseCommit)) throw new Error("Next work base must be a pinned commit");
  if (!upstream.startsWith("refs/remotes/")) throw new Error("Next work upstream must be a remote-tracking ref");
  git(root, ["check-ref-format", "--branch", next]);
  git(root, ["check-ref-format", upstream]);
  if (git(root, ["rev-parse", "--verify", `${upstream}^{commit}`]).out !== baseCommit) throw new Error("Shared base changed before next work branch creation");
  git(root, ["branch", next, upstream]);
  return inspectNextWorkBranch(root, next, baseCommit, git);
}

export function switchNextWorkBranch(root, next, baseCommit, git = runner) {
  inspectNextWorkBranch(root, next, baseCommit, git);
  git(root, ["switch", "--no-overwrite-ignore", next]);
  if (git(root, ["branch", "--show-current"]).out !== next || git(root, ["rev-parse", "HEAD"]).out !== baseCommit) throw new Error("Post-create verification failed");
}

export function createNextWorkBranch(root, next, baseCommit, upstream, git = runner) {
  const prepared = prepareNextWorkBranch(root, next, baseCommit, upstream, git);
  switchNextWorkBranch(root, next, baseCommit, git);
  return prepared;
}

async function version(root, commit, git = runner) {
  const packageManifest = git(root, ["show", `${commit}:package.json`], true);
  if (packageManifest.ok) {
    try {
      const policy = parsePackageVersionPolicy(packageManifest.out);
      if (policy.configured) return { source: policy.source, value: policy.version, tag: policy.recommendedTag, commit };
    } catch (error) {
      return { source: "package.json", value: "unresolved", tag: "unresolved", commit,
        warning: `Configured package version could not be resolved: ${error.message}` };
    }
  }
  const standalone = git(root, ["show", `${commit}:VERSION.md`], true);
  const standaloneValue = standalone.ok ? standalone.out.trim() : "";
  if (/^\d{8}[a-z]+$/.test(standaloneValue)) return { source: "VERSION.md", value: standaloneValue, tag: `v${standaloneValue}`, commit };
  const pom = git(root, ["show", `${commit}:pom.xml`], true).out;
  const value = pom.match(/<project\b[\s\S]*?<version>([^<]+)<\/version>/)?.[1]?.trim() ?? "unresolved";
  const match = value.match(/^1\.(\d{8})\.([1-9]\d*)$/);
  return { source: "pom.xml", value, tag: match ? `v${match[1]}${String.fromCharCode(96 + Number(match[2]))}` : "unresolved", commit };
}

export function classifyTagLookup(recommendedTag, lookup, baseCommit) {
  if (recommendedTag === "unresolved") return { tag_target: null, tag_status: "unresolved" };
  if (!lookup?.ok) return { tag_target: null, tag_status: "lookup-failed", ...(lookup?.err ? { tag_lookup_warning: lookup.err } : {}) };
  const target = lookup.out.split("\n").filter(Boolean).pop()?.split(/\s+/)[0] ?? "";
  if (!target) return { tag_target: null, tag_status: "absent" };
  return { tag_target: target, tag_status: target === baseCommit ? "confirmed" : "mismatch" };
}

export async function nextWorkAdvice(root, baseCommit, remote, git = runner) {
  const info = await version(root, baseCommit, git);
  const lookup = info.tag === "unresolved" ? null : git(root, ["ls-remote", "--tags", remote, `refs/tags/${info.tag}`, `refs/tags/${info.tag}^{}`], true);
  return {
    version: info.value,
    version_source: info.source,
    recommended_tag: info.tag,
    ...classifyTagLookup(info.tag, lookup, baseCommit),
    ...(info.warning ? { warnings: [info.warning] } : {}),
    tag_mutation: false,
    release_mutation: false,
  };
}
