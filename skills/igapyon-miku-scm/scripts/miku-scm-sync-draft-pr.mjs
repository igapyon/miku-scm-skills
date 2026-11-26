import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createGhCommandRunner } from "./miku-scm-command-runner.mjs";
import { ghRepository, repositoryApiArgs, repositoryFromRemote } from "./miku-scm-repository.mjs";
import { hash, assertRemote, branch, head, saveOperation } from "./miku-scm-sync-state.mjs";

const GH_TIMEOUT_MS = 15_000;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function apiArgs(repository, suffix, ...options) {
  return repositoryApiArgs(repository, suffix, ...options);
}

function ghRunner(dependencies = {}, platform = process.platform) {
  if (Object.hasOwn(dependencies, "gh")) return dependencies.gh;
  const runner = createGhCommandRunner({ platform, spawn: dependencies.spawn ?? spawnSync,
    forceEnv: { GH_PROMPT_DISABLED: "1" } });
  return (cwd, args, options = {}) => runner(cwd, args, options);
}

function spawnError(result) {
  return result?.error?.code ?? result?.spawn_error ?? "";
}

function safeUrl(value, repository, number = null) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      && url.host.toLowerCase() === repository.host.toLowerCase()
      && url.pathname === `/${repository.full_name}/pull/${number ?? ""}`.replace(/\/$/, "")
      && !url.search && !url.hash;
  } catch { return false; }
}

function positiveNumber(value) { return Number.isSafeInteger(value) && value > 0; }

function completePull(value, repository) {
  const number = value?.number;
  const headRepo = value?.head?.repo?.full_name;
  const baseRepo = value?.base?.repo?.full_name;
  return positiveNumber(number) && safeUrl(value.url, repository, number)
    && ["open", "closed"].includes(value.state) && typeof value.merged === "boolean"
    && typeof value.draft === "boolean" && typeof value.head?.ref === "string"
    && SHA.test(value.head?.sha ?? "") && typeof headRepo === "string"
    && typeof value.base?.ref === "string" && typeof baseRepo === "string";
}

function targetPull(value, target) {
  return value.head.repo.full_name.toLowerCase() === target.repository.full_name.toLowerCase()
    && value.head.ref === target.branch
    && value.base.repo.full_name.toLowerCase() === target.repository.full_name.toLowerCase()
    && value.base.ref === target.base
    && value.head.sha.toLowerCase() === target.head.toLowerCase();
}

function summarize(pull) {
  return { number: pull.number, url: pull.url, state: pull.state, merged: pull.merged, draft: pull.draft };
}

function parsedDraft(bytes) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("PR draft is not valid UTF-8"); }
  if (text.includes("\0")) throw new Error("PR draft contains a NUL character");
  text = text.replace(/\r\n?/g, "\n");
  const split = text.indexOf("\n");
  const title = (split < 0 ? text : text.slice(0, split)).trim();
  let body = split < 0 ? "" : text.slice(split + 1);
  if (body.startsWith("\n")) body = body.slice(1);
  if (!title || !body.trim()) throw new Error("PR draft requires a title and a nonempty body");
  if (title.length > 256) throw new Error("PR draft title exceeds 256 characters");
  return { title, body };
}

async function persist(ctx, op, outcome) {
  op.draft_pr.status = outcome.pr_status;
  op.draft_pr.updated_at = new Date().toISOString();
  if (outcome.reason) op.draft_pr.reason = outcome.reason;
  else delete op.draft_pr.reason;
  if (outcome.pull_request) op.draft_pr.pull_request = outcome.pull_request;
  else delete op.draft_pr.pull_request;
  if (outcome.related_urls) op.draft_pr.related_urls = outcome.related_urls;
  else delete op.draft_pr.related_urls;
  if (outcome.reconcile_only === true) op.draft_pr.reconcile_only = true;
  else if (["created", "existing", "skipped", "not-created", "conflict"].includes(outcome.pr_status)) delete op.draft_pr.reconcile_only;
  if (outcome.attempt) op.draft_pr.attempt = { ...op.draft_pr.attempt, ...outcome.attempt };
  try { await saveOperation(ctx, op); }
  catch (error) { return { ...outcome, pr_status: "unresolved", reason: "result-save-failed", detail: error.message, mutation_invoked: outcome.mutation_invoked === true ? true : null }; }
  return outcome;
}

function output(target, outcome) {
  const manualUrl = target.repository
    ? `${target.repository.url}/compare/${encodeURIComponent(target.base)}...${encodeURIComponent(target.branch)}?expand=1`
    : "unresolved";
  const result = {
    status: outcome.pr_status === "not-created" || outcome.pr_status === "conflict" ? "partial"
      : outcome.pr_status === "unresolved" ? "unresolved" : "published",
    publication_state: "published",
    pr_status: outcome.pr_status,
    pr_reason: outcome.reason,
    ...(outcome.pr_status === "unresolved" ? {} : { pr_manual_url: manualUrl }),
    pr_draft: target.draft_path,
    pr_number: outcome.pull_request?.number,
    pr_url: outcome.pull_request?.url,
    pr_state: outcome.pull_request?.state,
    pr_is_draft: outcome.pull_request?.draft,
    pr_merged: outcome.pull_request?.merged,
    pull_request_mutation: outcome.mutation_invoked,
    mutation_invoked: true,
  };
  if (outcome.pr_status === "unresolved") result.next_action = "The Git push is already confirmed. Run repository.sync.push.pr.resume with this exact operation ID to perform READONLY reconciliation; do not create another PR.";
  else if (outcome.pr_status === "created" || outcome.pr_status === "existing") result.next_action = "The Draft PR is available for review. After it is merged, run miku-scm sync pull.";
  else if (outcome.pr_status === "skipped") result.next_action = target.repository
    ? "The Git push succeeded. Use the saved PR draft and manual comparison URL to create the Draft PR in GitHub."
    : "The Git push succeeded, but this remote cannot be used for GitHub PR creation.";
  else if (outcome.pr_status === "not-created" || outcome.pr_status === "conflict") result.next_action = "The Git push succeeded. Review the PR stage and related PRs before retrying or creating a PR manually.";
  if (outcome.related_urls?.length) result.pr_related_urls = outcome.related_urls;
  if (outcome.detail) result.pr_detail = outcome.detail;
  return result;
}

async function callGh(gh, root, args) {
  return await gh(root, args, { allowFailure: true, timeout: GH_TIMEOUT_MS });
}

function listArgs(repository, target) {
  return apiArgs(repository, "pulls", "-f", "state=all", "-f", `head=${repository.owner}:${target.branch}`, "-f", "per_page=100");
}

async function listPulls(ctx, target, gh) {
  let result;
  try { result = await callGh(gh, ctx.root, listArgs(target.repository, target)); }
  catch { return { kind: "failed" }; }
  if (spawnError(result) === "ENOENT") return { kind: "missing" };
  if (!result?.ok) return { kind: "failed" };
  let pulls;
  try { pulls = JSON.parse(result.stdout ?? result.out ?? ""); }
  catch { return { kind: "invalid" }; }
  if (!Array.isArray(pulls) || pulls.length >= 100 || pulls.some((pull) => !completePull(pull, target.repository))) return { kind: "invalid" };
  const related = pulls.filter((pull) => pull.head.repo.full_name.toLowerCase() === target.repository.full_name.toLowerCase()
    && pull.head.ref === target.branch);
  const exact = related.filter((pull) => targetPull(pull, target));
  const conflicts = related.filter((pull) => {
    if (pull.state === "open") return !targetPull(pull, target);
    return !pull.merged && targetPull(pull, target);
  });
  return { kind: "ok", exact, conflicts, related };
}

async function detailPull(ctx, repository, number, gh) {
  let result;
  try { result = await callGh(gh, ctx.root, apiArgs(repository, `pulls/${number}`)); }
  catch { return null; }
  if (!result?.ok) return null;
  try {
    const pull = JSON.parse(result.stdout ?? result.out ?? "");
    return completePull(pull, repository) ? pull : null;
  } catch { return null; }
}

async function readVerifiedExisting(ctx, target, pull, gh) {
  const detail = await detailPull(ctx, target.repository, pull.number, gh);
  if (!detail || !targetPull(detail, target)) return null;
  return detail;
}

function classifyListFailure(listed, { recovery, firstRead }) {
  if (listed.kind === "missing") return recovery
    ? { pr_status: "unresolved", reason: "gh-not-found-during-reconciliation", mutation_invoked: false }
    : { pr_status: "skipped", reason: "gh-not-found", mutation_invoked: false };
  if (listed.kind === "failed" || listed.kind === "invalid") return recovery
    ? { pr_status: "unresolved", reason: "reconciliation-read-failed", mutation_invoked: false }
    : { pr_status: "not-created", reason: listed.kind === "invalid" ? "invalid-pull-list" : "pull-list-failed", mutation_invoked: false };
  return null;
}

async function assertCreateTarget(ctx, op, target, dependencies) {
  assertRemote(ctx, op.remote, true);
  if (target.remote !== op.remote.name || target.remote_digest !== op.remote.digest) throw new Error("Saved remote identity changed before PR creation");
  if (!target.backup_branch || !SHA.test(target.backup_head ?? "")
    || target.backup_branch !== op.backup_branch || target.backup_branch !== op.delegate?.backup_branch) throw new Error("Saved recommit backup identity changed before PR creation");
  const backup = ctx.git(ctx.root, ["rev-parse", "--verify", `refs/heads/${target.backup_branch}`], { allowFailure: true });
  if (!backup.ok || backup.out.toLowerCase() !== target.backup_head.toLowerCase()) throw new Error("Saved recommit backup no longer matches the prepared HEAD");
  const currentUrl = ctx.git(ctx.root, ["remote", "get-url", "--all", op.remote.name]).out.trim();
  const currentRepository = repositoryFromRemote(currentUrl);
  if (!currentRepository || currentRepository.host !== target.repository.host
    || currentRepository.full_name.toLowerCase() !== target.repository.full_name.toLowerCase()
    || currentRepository.url !== target.repository.url) throw new Error("Selected remote no longer identifies the saved GitHub repository");
  if (branch(ctx) !== target.done_branch || head(ctx).toLowerCase() !== target.head.toLowerCase()) throw new Error("Published checkout no longer matches the saved -done branch and HEAD");
  if (!ctx.git(ctx.root, ["check-ref-format", "--branch", target.branch], { allowFailure: true }).ok
    || !ctx.git(ctx.root, ["check-ref-format", "refs/heads/" + target.base], { allowFailure: true }).ok) throw new Error("Saved PR branch or base ref is invalid");
  const refs = ctx.git(ctx.root, ["ls-remote", "--heads", op.remote.name, `refs/heads/${target.branch}`, `refs/heads/${target.base}`]);
  const observed = new Map((refs.out ?? refs.stdout ?? "").split(/\r?\n/).filter(Boolean).map((line) => {
    const [sha, ref] = line.split(/\s+/);
    return [ref, sha];
  }));
  if (observed.get(`refs/heads/${target.branch}`)?.toLowerCase() !== target.head.toLowerCase()
    || !SHA.test(observed.get(`refs/heads/${target.base}`) ?? "")) throw new Error("Published head or saved base ref changed before PR creation");
  const bytes = await dependencies.readDraft(target.draft_path);
  if (hash(bytes) !== target.draft_sha256) throw new Error("Saved PR draft changed after publication");
  return parsedDraft(bytes);
}

async function verifyCreated(ctx, target, number, gh) {
  const pull = await detailPull(ctx, target.repository, number, gh);
  if (!pull || !targetPull(pull, target) || pull.state !== "open" || pull.merged || !pull.draft) return null;
  return pull;
}

async function createDraftPull(ctx, op, target, parsed, gh) {
  let directory;
  let mutationCallStarted = false;
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), "miku-scm-pr-body-"));
    await chmod(directory, 0o700);
    const bodyFile = path.join(directory, "body.md");
    await writeFile(bodyFile, parsed.body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(bodyFile, 0o600);
    op.draft_pr.attempt = { status: "pending", started_at: new Date().toISOString() };
    await saveOperation(ctx, op);
    mutationCallStarted = true;
    const result = await callGh(gh, ctx.root, ["pr", "create", "--draft", "--repo", ghRepository(target.repository),
      "--head", target.branch, "--base", target.base, "--title", parsed.title, "--body-file", bodyFile]);
    if (spawnError(result) === "ENOENT") {
      return { pr_status: "skipped", reason: "gh-not-found", mutation_invoked: false,
        attempt: { status: "not-started", completed_at: new Date().toISOString(), spawn_error: "ENOENT" } };
    }
    if (!result?.ok) return { pr_status: "unresolved", reason: "create-command-outcome-unknown", mutation_invoked: null,
      attempt: { status: "unresolved", completed_at: new Date().toISOString(), exit_code: Number.isInteger(result?.status) ? result.status : null,
        spawn_error: spawnError(result) || undefined } };
    const urls = String(result.stdout ?? result.out ?? "").match(/https?:\/\/[^\s<>"']+/g) ?? [];
    const url = urls.find((value) => {
      try { const parsedUrl = new URL(value); return parsedUrl.host.toLowerCase() === target.repository.host.toLowerCase()
        && parsedUrl.pathname.startsWith(`/${target.repository.full_name}/pull/`); } catch { return false; }
    });
    const number = Number(url?.match(/\/pull\/([1-9]\d*)$/)?.[1]);
    if (!positiveNumber(number) || !safeUrl(url, target.repository, number)) return { pr_status: "unresolved", reason: "create-response-unverified", mutation_invoked: null,
      attempt: { status: "unresolved", completed_at: new Date().toISOString(), exit_code: 0 } };
    const pull = await verifyCreated(ctx, target, number, gh);
    if (!pull) return { pr_status: "unresolved", reason: "created-pr-verification-failed", mutation_invoked: null,
      attempt: { status: "unresolved", completed_at: new Date().toISOString(), exit_code: 0 } };
    return { pr_status: "created", pull_request: summarize(pull), mutation_invoked: true,
      attempt: { status: "verified", completed_at: new Date().toISOString(), exit_code: 0 } };
  } catch (error) {
    return { pr_status: mutationCallStarted ? "unresolved" : "not-created", reason: mutationCallStarted ? "create-command-outcome-unknown" : "create-preflight-failed", detail: error.message, mutation_invoked: mutationCallStarted ? null : false,
      attempt: op.draft_pr.attempt?.status === "pending" ? { status: mutationCallStarted ? "unresolved" : "not-started", completed_at: new Date().toISOString() } : undefined };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Complete or reconcile the PR stage of an already-published sync push.
 * `allowCreate` is false after any create attempt and for explicit recovery of
 * a previously confirmed/conflicting result.
 */
export async function completeSyncDraftPr(ctx, op, { allowCreate = true } = {}, dependencies = {}) {
  const saved = op.draft_pr;
  const target = saved?.target;
  if (!saved || saved.schema_version !== 1 || !target || target.operation !== op.id
    || !SHA.test(target.head ?? "") || !/^[0-9a-f]{64}$/.test(target.plan_sha256 ?? "")
    || !/^[0-9a-f]{64}$/.test(target.draft_sha256 ?? "")) {
    return output(target ?? { base: "", branch: "", draft_path: "", repository: null },
      { pr_status: "not-created", reason: "saved-target-invalid", mutation_invoked: false });
  }
  if (!target.repository) {
    const outcome = await persist(ctx, op, { pr_status: "skipped", reason: "unsupported-remote", mutation_invoked: false });
    return output(target, outcome);
  }
  const previousAttempt = saved.attempt;
  const recovery = !allowCreate || saved.reconcile_only === true || ["pending", "unresolved", "verified"].includes(previousAttempt?.status)
    || ["created", "existing", "conflict"].includes(saved.status);
  const gh = ghRunner(dependencies, dependencies.platform ?? process.platform);
  const listed = await listPulls(ctx, target, gh);
  const failed = classifyListFailure(listed, { recovery, firstRead: true });
  if (failed) {
    const outcome = await persist(ctx, op, failed);
    return output(target, outcome);
  }
  if (listed.exact.length > 1) {
    const outcome = await persist(ctx, op, { pr_status: recovery ? "unresolved" : "conflict", reason: recovery ? "reconciliation-ambiguous" : "multiple-matching-pulls",
      related_urls: listed.exact.map((pull) => pull.url), mutation_invoked: false });
    return output(target, outcome);
  }
  if (listed.conflicts.length) {
    const outcome = await persist(ctx, op, { pr_status: recovery ? "unresolved" : "conflict", reason: recovery ? "reconciliation-found-mismatched-pull" : "published-head-has-conflicting-pull",
      related_urls: listed.conflicts.map((pull) => pull.url), mutation_invoked: false });
    return output(target, outcome);
  }
  if (listed.exact.length === 1) {
    const detail = await readVerifiedExisting(ctx, target, listed.exact[0], gh);
    if (detail) {
      if (detail.state === "closed" && !detail.merged) {
        const outcome = await persist(ctx, op, { pr_status: "conflict", reason: "matching-pull-is-closed-unmerged",
          related_urls: [detail.url], mutation_invoked: false });
        return output(target, outcome);
      }
      const outcome = await persist(ctx, op, { pr_status: "existing", pull_request: summarize(detail), mutation_invoked: false });
      return output(target, outcome);
    }
    const outcome = await persist(ctx, op, { pr_status: "unresolved", reason: "matching-pull-detail-unavailable",
      mutation_invoked: false, reconcile_only: true });
    return output(target, outcome);
  }
  if (recovery) {
    if (saved.status === "conflict") {
      const outcome = await persist(ctx, op, { pr_status: "conflict", reason: "previous-conflict-requires-human-review", mutation_invoked: false,
        related_urls: saved.related_urls });
      return output(target, outcome);
    }
    const outcome = await persist(ctx, op, { pr_status: "unresolved", reason: "no-pull-found-after-possible-create", mutation_invoked: false });
    return output(target, outcome);
  }
  if (!allowCreate) {
    const outcome = await persist(ctx, op, { pr_status: "unresolved", reason: "pull-not-found-during-read-only-recovery", mutation_invoked: false });
    return output(target, outcome);
  }
  let parsed;
  try { parsed = await assertCreateTarget(ctx, op, target, { ...dependencies, readDraft: dependencies.readDraft ?? (async () => { throw new Error("PR draft reader is unavailable"); }) }); }
  catch (error) {
    const outcome = await persist(ctx, op, { pr_status: "not-created", reason: "create-preflight-failed", detail: error.message, mutation_invoked: false });
    return output(target, outcome);
  }
  const created = await createDraftPull(ctx, op, target, parsed, gh);
  const outcome = await persist(ctx, op, created);
  return output(target, outcome);
}

export function syncDraftPrRecoveryOnly(op) {
  const saved = op?.draft_pr;
  return ["pending", "unresolved", "verified"].includes(saved?.attempt?.status)
    || ["created", "existing", "conflict"].includes(saved?.status);
}
