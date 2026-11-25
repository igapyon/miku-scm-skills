import { spawn } from "node:child_process";

export const SYNC_PUSH_EVIDENCE_PROFILE = "sync-push/v2";
export const MAX_DETAIL_PATHS = 4;
const EVIDENCE_BYTES = 32 * 1024;
const EVIDENCE_RESERVE_BYTES = 256; // Operation suffix and evidence digest added by sync push.
const FULL_PATCH_BYTES = 24 * 1024;
const FILE_PATCH_BYTES = 2 * 1024;
const DETAIL_BYTES = 12 * 1024;
const MAX_INITIAL_PATHS = 6;
const DIFF = ["--no-ext-diff", "--no-textconv", "--no-renames", "--no-color"];

function jsonBytes(value) { return Buffer.byteLength(JSON.stringify(value)); }

export function redactSensitiveLines(value) {
  return String(value).split("\n").map((line) => (
    /(?:token|password|secret|api[_-]?key|authorization)\s*[:=]/i.test(line)
      ? "[redacted-sensitive-line]"
      : line
  )).join("\n");
}

function readPatch(root, args, limit) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    let size = 0;
    let stoppedAtLimit = false;
    child.stdout.on("data", (chunk) => {
      if (stoppedAtLimit) return;
      const kept = chunk.subarray(0, limit - size);
      chunks.push(kept);
      size += kept.length;
      if (kept.length < chunk.length) {
        stoppedAtLimit = true;
        child.kill();
      }
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0 && !(stoppedAtLimit && (signal === "SIGTERM" || code === 1 && process.platform === "win32"))) {
        reject(new Error(`git diff failed while collecting PR evidence (status ${code ?? signal})`));
        return;
      }
      const bytes = Buffer.concat(chunks, size);
      // Drop an incomplete line before decoding or redacting it.
      const complete = stoppedAtLimit ? bytes.subarray(0, bytes.lastIndexOf(10) + 1) : bytes;
      resolve({ text: redactSensitiveLines(complete.toString("utf8")), truncated: stoppedAtLimit });
    });
  });
}

// Explicit top-level literal includes and descendant exclusions keep pathspec
// magic out of file names and handle a file being replaced by a directory.
function exactPath(name) {
  return [`:(top,literal)${name}`, `:(top,exclude,literal)${name}/`];
}

function diffArgs(format, range, paths = []) {
  return ["diff", ...DIFF, ...format, range, "--", ...paths];
}

function collectStats(root, range, git) {
  const rows = git(root, diffArgs(["--numstat", "-z"], range)).out.split("\0").filter(Boolean);
  return rows.map((row) => {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(row);
    if (!match) throw new Error("Invalid Git numstat record while collecting PR evidence");
    const [, added, deleted, path] = match;
    return { path, added: added === "-" ? null : Number(added), deleted: deleted === "-" ? null : Number(deleted) };
  });
}

function groupName(name) {
  const parts = name.split("/");
  return parts.slice(0, Math.min(2, parts.length - 1)).join("/") || ".";
}

function suitablePath({ path }) {
  // A non-UTF-8 file name may decode with U+FFFD. Count it, but don't pass a
  // possibly different path back to Git as an argument.
  return !path.includes("\uFFFD") && Buffer.byteLength(path) <= 1024;
}

function preferredFile(file) {
  return file.added !== null && suitablePath(file)
    && !/(?:^|\/)(?:dist|vendor|generated)(?:\/|$)|\.min\.[^/]+$|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|[^/]+\.lock)$/i.test(file.path);
}

function tryAppend(items, item, limit) {
  items.push(item);
  if (jsonBytes(items) <= limit) return true;
  items.pop();
  return false;
}

function walkGroups(files) {
  const groups = new Map();
  for (const file of files) {
    const key = groupName(file.path);
    if (!groups.has(key)) groups.set(key, { directory: key, files: [], candidates: [] });
    const group = groups.get(key);
    group.files.push(file);
    if (preferredFile(file)) group.candidates.push(file);
  }
  // Smaller patches within a directory are less likely to consume the whole
  // excerpt budget. Keep Git's order for equally sized patches.
  for (const group of groups.values()) group.candidates.sort((a, b) => a.added + a.deleted - b.added - b.deleted);
  return [...groups.values()].sort((a, b) => Number(b.candidates.length > 0) - Number(a.candidates.length > 0));
}

async function excerpt(root, range, name, read) {
  const patch = await read(root, diffArgs(["--unified=1"], range, exactPath(name)), FILE_PATCH_BYTES);
  const result = { path: name, patch_excerpt: "", patch_truncated: patch.truncated };
  // JSON escaping also counts towards the evidence budget.
  for (const line of patch.text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    result.patch_excerpt += line;
    if (jsonBytes(result) > FILE_PATCH_BYTES + 1024) {
      result.patch_excerpt = result.patch_excerpt.slice(0, -line.length);
      result.patch_truncated = true;
      break;
    }
  }
  return result;
}

export async function collectSyncPushEvidence(root, range, evidence, { git, read = readPatch }) {
  const files = collectStats(root, range, git);
  const summary = { file_count: files.length, binary_count: 0, additions: 0, deletions: 0 };
  for (const file of files) {
    if (file.added === null) summary.binary_count++;
    summary.additions += file.added ?? 0;
    summary.deletions += file.deleted ?? 0;
  }
  const initial = { ...evidence, evidence_profile: SYNC_PUSH_EVIDENCE_PROFILE, change_summary: summary };
  const fits = (value) => jsonBytes(value) <= EVIDENCE_BYTES - EVIDENCE_RESERVE_BYTES;
  if (summary.file_count <= 12 && summary.additions + summary.deletions <= 400) {
    const patch = await read(root, diffArgs(["--unified=1"], range), FULL_PATCH_BYTES);
    const full = { ...initial, patch_excerpt: patch.text, patch_truncated: false };
    if (!patch.truncated && fits(full)) return full;
  }

  const groups = walkGroups(files);
  const visibleGroups = [];
  let listedFileCount = 0;
  let displayedPathCount = 0;
  for (const group of groups) {
    if (visibleGroups.length === 12) break;
    const representatives = [];
    for (const file of group.candidates.slice(0, 2)) representatives.push(file);
    for (const file of group.files) {
      if (representatives.length === 2) break;
      if (!suitablePath(file) || representatives.includes(file)) continue;
      representatives.push(file);
    }
    const entry = { directory: group.directory, file_count: group.files.length, representative_files: representatives };
    if (tryAppend(visibleGroups, entry, 5 * 1024)) {
      listedFileCount += group.files.length;
      displayedPathCount += representatives.length;
    }
  }
  const compact = {
    ...initial,
    change_summary: { ...summary, groups: visibleGroups, omitted_groups: groups.length - visibleGroups.length,
      files_in_omitted_groups: files.length - listedFileCount, paths_not_listed_in_summary: files.length - displayedPathCount },
    patch_truncated: true,
    patch_excerpts: [],
  };
  const selected = [];
  const candidateGroups = groups.filter((group) => group.candidates.length);
  for (let i = 0; selected.length < MAX_INITIAL_PATHS; i++) {
    const available = candidateGroups.flatMap((group) => group.candidates[i] ? [group.candidates[i]] : []);
    if (!available.length) break;
    selected.push(...available.slice(0, MAX_INITIAL_PATHS - selected.length));
  }
  for (const patch of await Promise.all(selected.map(({ path }) => excerpt(root, range, path, read)))) {
    compact.patch_excerpts.push(patch);
    if (!fits(compact)) compact.patch_excerpts.pop();
  }
  if (!fits(compact)) throw new Error("PR evidence exceeds its JSON budget");
  return compact;
}

export async function readSyncPushExcerpts(root, range, paths, { git, read = readPatch }) {
  if (!paths?.length || paths.length > MAX_DETAIL_PATHS || new Set(paths).size !== paths.length
    || paths.some((path) => typeof path !== "string" || !path || path.includes("\0") || !suitablePath({ path }))) {
    throw new Error(`Supply one to ${MAX_DETAIL_PATHS} distinct literal changed paths`);
  }
  // Validate every literal path before reading any patch. Separate Git calls
  // avoid an exclusion for one path interfering with another requested path.
  for (const name of paths) {
    const matches = git(root, diffArgs(["--name-only", "-z"], range, exactPath(name))).out;
    if (matches !== `${name}\0`) throw new Error("A requested path is not a single changed file in the prepared range");
  }
  const excerpts = [];
  const patches = await Promise.all(paths.map((name) => excerpt(root, range, name, read)));
  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i];
    if (!tryAppend(excerpts, patch, DETAIL_BYTES - 256)) {
      excerpts.push({ request_index: i, patch_excerpt: "", patch_truncated: true });
    }
  }
  return excerpts;
}
