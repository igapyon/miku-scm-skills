import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

const UNAVAILABLE = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"]);

export function gitEvidenceText(git, cwd, args) {
  const result = git(cwd, args);
  if (!result.ok) throw new Error(`Git evidence lookup failed: ${args[0]}`);
  return result.stdout ?? result.out;
}

export function registeredWorktreeRoots(root, git) {
  const local = realpathSync(root);
  const listing = gitEvidenceText(git, local, ["worktree", "list", "--porcelain", "-z"]);
  const roots = new Set([local]);
  let common;
  for (const record of listing.split("\0\0")) {
    const [name, ...fields] = record.split("\0");
    if (!name.startsWith("worktree ") || fields.some((field) => field === "bare" || field.startsWith("prunable"))) continue;
    let candidate;
    try {
      candidate = realpathSync(name.slice("worktree ".length));
    } catch (error) {
      if (UNAVAILABLE.has(error.code)) continue;
      throw error;
    }
    if (roots.has(candidate)) continue;
    const commonPath = (cwd) => realpathSync(gitEvidenceText(git, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trimEnd());
    common ??= commonPath(local);
    if (commonPath(candidate) === common) roots.add(candidate);
  }
  return [...roots];
}

export function readEvidenceCandidate(root, directory, name) {
  const expected = path.join(root, "workplace", "miku-scm", directory);
  let actual;
  try {
    actual = realpathSync(expected);
  } catch (error) {
    if (UNAVAILABLE.has(error.code)) return null;
    throw error;
  }
  if (actual !== expected || path.basename(name) !== name) return null;
  const file = path.join(actual, name);
  try {
    const stat = lstatSync(file);
    if (!stat.isFile()) return null;
    if (stat.size > 64 * 1024 * 1024) throw new Error("An operational evidence file exceeds the inspection limit");
    return readFileSync(file);
  } catch (error) {
    if (UNAVAILABLE.has(error.code)) return null;
    throw error;
  }
}

export function parseEvidence(bytes) {
  if (!bytes) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}
