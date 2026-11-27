import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { completeSyncDraftPr } from "../scripts/miku-scm-sync-draft-pr.mjs";
import { context, hash, loadOperation, operationPath, saveOperation, syncGit } from "../scripts/miku-scm-sync-state.mjs";
import { applySyncPush, prepareSyncPush, resumeSyncPushPr } from "../scripts/sync-push.mjs";
import { draft } from "./sync-push-support.mjs";
import { fixture } from "./sync-fixture.mjs";

const githubGit = (cwd, args, options) => {
  const result = syncGit(cwd, args, options);
  if (args[0] === "remote" && args[1] === "get-url") {
    return { ...result, out: "https://github.com/acme/widget.git", stdout: "https://github.com/acme/widget.git\n" };
  }
  return result;
};

async function completedOperation(t) {
  const f = await fixture(t);
  await f.write("change.txt", "new behavior\n");
  const prepared = await prepareSyncPush(f.options, { git: githubGit });
  assert.equal(prepared.status, "prepared", JSON.stringify(prepared));
  const branch = f.git(["branch", "--show-current"]);
  const draft = "Fix widget behavior\r\n\r\n日本語の説明; `$(touch should-not-run)`\r\n";
  await f.write(prepared.suggested_draft_path, Buffer.from(draft));
  f.git(["push", "origin", `${prepared.head}:refs/heads/${branch}`]);
  const backupBranch = `${branch}-sync-test-backup`;
  f.git(["branch", backupBranch, prepared.head]);
  f.git(["branch", "-m", branch, `${branch}-done`]);
  const ctx = await context(f.repo, { git: githubGit });
  const op = await loadOperation(ctx, prepared.operation_id);
  const target = {
    operation: op.id,
    plan_sha256: op.plan_sha256,
    remote: op.remote.name,
    remote_digest: op.remote.digest,
    repository: { host: "github.com", owner: "acme", repository: "widget", full_name: "acme/widget", url: "https://github.com/acme/widget" },
    branch,
    done_branch: `${branch}-done`,
    head: prepared.head,
    backup_branch: backupBranch,
    backup_head: JSON.parse(await readFile(path.join(path.dirname(operationPath(ctx, prepared.operation_id)), "plan.json"), "utf8")).snapshot.head,
    base: "devel",
    draft_path: prepared.suggested_draft_path,
    draft_sha256: hash(Buffer.from(draft)),
  };
  op.status = "completed";
  op.apply_started = true;
  op.recommitted_head = prepared.head;
  op.backup_branch = backupBranch;
  op.delegate = { status: "published", branch, new_head: prepared.head, backup_branch: backupBranch, pushed_branch: branch,
    final_branch: `${branch}-done`, comparison: "0 0", publication: { status: "published", head: prepared.head,
      pushed_branch: branch, final_branch: `${branch}-done`, comparison: "0 0" } };
  op.draft_pr = { schema_version: 1, status: "ready", target, attempt: null };
  await saveOperation(ctx, op);
  return { f, ctx, op, target, draft: Buffer.from(draft), operationFile: operationPath(ctx, op.id) };
}

function listedPull(target, { number = 42, state = "open", draft = true, head = target.head, base = target.base,
  headRepo = target.repository.full_name, baseRepo = target.repository.full_name } = {}) {
  return { number, url: `https://api.github.com/repos/${target.repository.full_name}/pulls/${number}`,
    html_url: `https://${target.repository.host}/${target.repository.full_name}/pull/${number}`,
    state, draft,
    head: { repo: { full_name: headRepo }, ref: target.branch, sha: head },
    base: { repo: { full_name: baseRepo }, ref: base } };
}

function pullDetail(target, { merged = false, ...options } = {}) {
  return { ...listedPull(target, options), merged };
}

test("sync Draft PR helper skips cleanly when gh is missing from PATH", async (t) => {
  const state = await completedOperation(t);
  const calls = [];
  const result = await completeSyncDraftPr(state.ctx, state.op, { allowCreate: true }, {
    readDraft: async (relative) => readFile(path.join(state.f.repo, relative)),
    spawn: (command, args, options) => { calls.push({ command, args, options }); return { status: null, error: { code: "ENOENT" } }; },
  });
  assert.equal(result.status, "published", JSON.stringify(result));
  assert.equal(result.pr_status, "skipped");
  assert.equal(result.pr_reason, "gh-not-found");
  assert.equal(result.pr_manual_url, "https://github.com/acme/widget/compare/devel...devel-tiga1026aaa?expand=1");
  assert.equal(result.pr_draft, state.target.draft_path);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "gh");
  assert.deepEqual(calls[0].args.slice(0, 5), ["api", "--method", "GET", "repos/acme/widget/pulls", "--hostname"]);
  assert.equal(calls[0].options.timeout, 15_000);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.GH_PROMPT_DISABLED, "1");
  assert.equal((await loadOperation(state.ctx, state.op.id)).status, "completed");
  assert.equal((await loadOperation(state.ctx, state.op.id)).draft_pr.status, "skipped");
});

test("sync Draft PR helper creates once with the saved title and body, then verifies exact PR state", async (t) => {
  const state = await completedOperation(t);
  const calls = [];
  let bodyFile;
  const detail = pullDetail(state.target);
  const result = await completeSyncDraftPr(state.ctx, state.op, { allowCreate: true }, {
    readDraft: async (relative) => readFile(`${state.f.repo}/${relative}`),
    gh: async (_cwd, args, options) => {
      calls.push({ args, options });
      if (args[0] === "api" && args[3] === "repos/acme/widget/pulls") {
        return { ok: true, stdout: "[]" };
      }
      if (args[0] === "pr" && args[1] === "create") {
        assert.deepEqual(args.slice(0, 9), ["pr", "create", "--draft", "--repo", "github.com/acme/widget", "--head", state.target.branch, "--base", "devel"]);
        assert.equal(args[9], "--title");
        assert.equal(args[10], "Fix widget behavior");
        assert.equal(args[11], "--body-file");
        bodyFile = args[12];
        assert.equal(await readFile(bodyFile, "utf8"), "日本語の説明; `$(touch should-not-run)`\n");
        return { ok: true, stdout: `${detail.html_url}\n` };
      }
      if (args[0] === "api" && args[3] === "repos/acme/widget/pulls/42") {
        return { ok: true, stdout: JSON.stringify(detail) };
      }
      assert.fail(`Unexpected gh argv: ${JSON.stringify(args)}`);
    },
  });
  assert.equal(result.status, "published", JSON.stringify(result));
  assert.equal(result.pr_status, "created");
  assert.equal(result.pr_number, 42);
  assert.equal(result.pr_url, detail.html_url);
  assert.equal(result.pr_is_draft, true);
  assert.equal(result.pull_request_mutation, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].args.slice(-6), ["-f", "state=all", "-f", `head=acme:${state.target.branch}`, "-f", "per_page=100"]);
  assert.ok(calls.every((call) => call.options.timeout === 15_000));
  assert.equal((await loadOperation(state.ctx, state.op.id)).draft_pr.status, "created");
  assert.equal((await loadOperation(state.ctx, state.op.id)).draft_pr.attempt.status, "verified");
  await assert.rejects(readFile(bodyFile));
});

test("an exact existing Draft PR is verified instead of creating another one", async (t) => {
  const state = await completedOperation(t);
  const existing = listedPull(state.target, { number: 43 });
  let createCount = 0;
  const result = await completeSyncDraftPr(state.ctx, state.op, { allowCreate: true }, {
    readDraft: async (relative) => readFile(path.join(state.f.repo, relative)),
    gh: (_cwd, args) => {
      if (args[0] === "api" && args[3] === "repos/acme/widget/pulls") return { ok: true, stdout: JSON.stringify([existing]) };
      if (args[0] === "api" && args[3] === "repos/acme/widget/pulls/43") return { ok: true, stdout: JSON.stringify({ ...existing, merged: false }) };
      createCount++;
      assert.fail(`Existing pull must prevent create: ${JSON.stringify(args)}`);
    },
  });
  assert.equal(result.status, "published");
  assert.equal(result.pr_status, "existing");
  assert.equal(result.pr_number, 43);
  assert.equal(result.pr_url, existing.html_url);
  assert.equal(result.pr_is_draft, true);
  assert.equal(result.pull_request_mutation, false);
  assert.equal(createCount, 0);
});

test("sync Draft PR uncertain create resumes with READONLY lookup and never creates twice", async (t) => {
  const state = await completedOperation(t);
  const firstCalls = [];
  const first = await completeSyncDraftPr(state.ctx, state.op, { allowCreate: true }, {
    readDraft: async (relative) => readFile(`${state.f.repo}/${relative}`),
    gh: (_cwd, args) => {
      firstCalls.push(args);
      if (args[0] === "api" && args[3] === "repos/acme/widget/pulls") return { ok: true, stdout: "[]" };
      if (args[0] === "pr" && args[1] === "create") return { ok: false, status: 1, stderr: "network ended" };
      assert.fail(`Unexpected first gh argv: ${JSON.stringify(args)}`);
    },
  });
  assert.equal(first.pr_status, "unresolved");
  assert.equal((await loadOperation(state.ctx, state.op.id)).draft_pr.attempt.status, "unresolved");
  let createCount = 0;
  const resumed = await completeSyncDraftPr(state.ctx, state.op, { allowCreate: true }, {
    readDraft: async (relative) => readFile(`${state.f.repo}/${relative}`),
    gh: (_cwd, args) => {
      if (args[0] === "api" && args[3] === "repos/acme/widget/pulls") return { ok: true, stdout: "[]" };
      createCount++;
      assert.fail(`Resume must not invoke gh mutation: ${JSON.stringify(args)}`);
    },
  });
  assert.equal(resumed.pr_status, "unresolved");
  assert.equal(resumed.status, "unresolved");
  assert.equal(resumed.pull_request_mutation, false);
  assert.equal(resumed.pr_manual_url, undefined);
  assert.equal(createCount, 0);
  assert.equal(firstCalls.filter((args) => args[0] === "pr").length, 1);
});

test("matching fork and stale closed pulls do not block a new PR", async (t) => {
  const state = await completedOperation(t);
  let createCount = 0;
  const fork = listedPull(state.target, { number: 3, headRepo: "someone/widget-fork" });
  const old = listedPull(state.target, { number: 4, state: "closed", head: "f".repeat(40) });
  const result = await completeSyncDraftPr(state.ctx, state.op, { allowCreate: true }, {
    readDraft: async (relative) => readFile(`${state.f.repo}/${relative}`),
    gh: (_cwd, args) => {
      if (args[0] === "api" && args[3] === "repos/acme/widget/pulls") return { ok: true, stdout: JSON.stringify([fork, old]) };
      if (args[0] === "pr" && args[1] === "create") { createCount++; return { ok: false, status: 1 }; }
      assert.fail(`Unexpected gh argv: ${JSON.stringify(args)}`);
    },
  });
  assert.equal(result.pr_status, "unresolved");
  assert.equal(createCount, 1);
});

test("an open PR from the same head branch with a different base is a conflict", async (t) => {
  const state = await completedOperation(t);
  let createCount = 0;
  const conflict = listedPull(state.target, { number: 19, base: "release" });
  const result = await completeSyncDraftPr(state.ctx, state.op, { allowCreate: true }, {
    readDraft: async (relative) => readFile(path.join(state.f.repo, relative)),
    gh: (_cwd, args) => {
      if (args[0] === "api" && args[3] === "repos/acme/widget/pulls") return { ok: true, stdout: JSON.stringify([conflict]) };
      createCount++;
      assert.fail(`Conflict must prevent PR creation: ${JSON.stringify(args)}`);
    },
  });
  assert.equal(result.pr_status, "conflict");
  assert.equal(result.pr_related_urls[0], conflict.html_url);
  assert.equal(createCount, 0);
});

test("an existing pull whose detail read fails can only be reconciled, never replaced", async (t) => {
  const state = await completedOperation(t);
  const matching = listedPull(state.target);
  const first = await completeSyncDraftPr(state.ctx, state.op, { allowCreate: true }, {
    gh: (_cwd, args) => args[3] === "repos/acme/widget/pulls"
      ? { ok: true, stdout: JSON.stringify([matching]) } : { ok: false, status: 1 },
    readDraft: async (relative) => readFile(path.join(state.f.repo, relative)),
  });
  assert.equal(first.pr_status, "unresolved");
  assert.equal(first.pull_request_mutation, false);
  assert.equal((await loadOperation(state.ctx, state.op.id)).draft_pr.reconcile_only, true);
  let createCount = 0;
  const resumed = await completeSyncDraftPr(state.ctx, state.op, { allowCreate: true }, {
    gh: (_cwd, args) => {
      if (args[3] === "repos/acme/widget/pulls") return { ok: true, stdout: "[]" };
      createCount++;
      assert.fail(`Incomplete prior PR evidence must never lead to create: ${JSON.stringify(args)}`);
    },
    readDraft: async (relative) => readFile(path.join(state.f.repo, relative)),
  });
  assert.equal(resumed.pr_status, "unresolved");
  assert.equal(resumed.pull_request_mutation, false);
  assert.equal(createCount, 0);
});

test("sync push defers its old PR lookup and creates one verified Draft PR after Git publication", async (t) => {
  const f = await fixture(t);
  await f.write("feature.txt", "feature\n");
  const prepared = await prepareSyncPush(f.options, { git: githubGit });
  const workBranch = f.git(["branch", "--show-current"]);
  const apply = await draft(f, prepared);
  const calls = [];
  let createdUrl;
  const result = await applySyncPush(apply, {
    git: githubGit,
    draftPrDependencies: {
      gh: async (_cwd, args, options) => {
        calls.push({ args, options });
        if (args[0] === "api" && args[3] === "repos/acme/widget/pulls") return { ok: true, stdout: "[]" };
        if (args[0] === "pr" && args[1] === "create") {
          const pushedBranch = args[args.indexOf("--head") + 1];
          const number = 77;
          createdUrl = `https://github.com/acme/widget/pull/${number}`;
          assert.equal(pushedBranch, f.git(["branch", "--show-current"]).replace(/-done$/, ""));
          return { ok: true, stdout: `${createdUrl}\n` };
        }
        if (args[0] === "api" && args[3] === "repos/acme/widget/pulls/77") {
          const branch = f.git(["branch", "--show-current"]).replace(/-done$/, "");
          const sha = f.git(["rev-parse", "HEAD"]);
          return { ok: true, stdout: JSON.stringify(pullDetail({ ...prepared, branch, head: sha,
            repository: { host: "github.com", full_name: "acme/widget" }, base: "devel" }, { number: 77 })) };
        }
        assert.fail(`Unexpected gh argv: ${JSON.stringify(args)}`);
      },
    },
  });
  assert.equal(result.status, "published", JSON.stringify(result));
  assert.equal(result.publication_state, "published");
  assert.equal(result.pr_status, "created");
  assert.equal(result.pr_url, createdUrl);
  assert.equal(result.pull_request_mutation, true);
  assert.equal(f.git(["branch", "--show-current"]), `${workBranch}-done`);
  assert.equal(calls.length, 3);
  assert.equal(calls.filter(({ args }) => args[0] === "pr" && args[1] === "create").length, 1);
  const op = await loadOperation(await context(f.repo, { git: githubGit }), prepared.operation_id);
  assert.equal(op.status, "completed");
  assert.equal(op.draft_pr.status, "created");
});

test("sync push succeeds and leaves a manual Draft PR handoff when gh is missing", async (t) => {
  const f = await fixture(t);
  await f.write("feature.txt", "feature\n");
  const prepared = await prepareSyncPush(f.options, { git: githubGit });
  const workBranch = f.git(["branch", "--show-current"]);
  const apply = await draft(f, prepared);
  const calls = [];
  const result = await applySyncPush(apply, { git: githubGit, draftPrDependencies: {
    gh: (_cwd, args) => { calls.push(args); return { ok: false, error: { code: "ENOENT" } }; },
  } });
  assert.equal(result.status, "published", JSON.stringify(result));
  assert.equal(result.publication_state, "published");
  assert.equal(result.pr_status, "skipped");
  assert.equal(result.pr_reason, "gh-not-found");
  assert.equal(result.pr_draft, prepared.suggested_draft_path);
  assert.match(result.pr_manual_url, /\/compare\/devel\.\.\./);
  assert.equal(f.git(["branch", "--show-current"]), `${workBranch}-done`);
  assert.equal(calls.length, 1);
  const op = await loadOperation(await context(f.repo, { git: githubGit }), prepared.operation_id);
  assert.equal(op.status, "completed");
  assert.equal(op.draft_pr.status, "skipped");
});

for (const { name, state: prState, merged, expectedStatus } of [
  { name: "an open Draft PR", state: "open", merged: false, expectedStatus: "existing" },
  { name: "a merged PR", state: "closed", merged: true, expectedStatus: "existing" },
  { name: "a closed unmerged PR", state: "closed", merged: false, expectedStatus: "conflict" },
]) {
  test(`PR-only resume checks ${name} without repeating the uncertain create`, async (t) => {
    const state = await completedOperation(t);
    state.op.draft_pr.attempt = { status: "unresolved", started_at: new Date().toISOString() };
    state.op.draft_pr.status = "unresolved";
    await saveOperation(state.ctx, state.op);
    const matching = listedPull(state.target, { number: 91, state: prState, draft: prState === "open" });
    const calls = [];
    const resumed = await resumeSyncPushPr({ repo: state.f.repo, operation: state.op.id, apply: true }, {
      git: githubGit,
      draftPrDependencies: {
        gh: (_cwd, args) => {
          calls.push(args);
          if (args[0] === "api" && args[3] === "repos/acme/widget/pulls") return { ok: true, stdout: JSON.stringify([matching]) };
          if (args[0] === "api" && args[3] === "repos/acme/widget/pulls/91") return { ok: true, stdout: JSON.stringify({ ...matching, merged }) };
          assert.fail(`Resume must not mutate GitHub: ${JSON.stringify(args)}`);
        },
      },
    });
    assert.equal(resumed.publication_state, "published");
    assert.equal(resumed.pr_status, expectedStatus);
    assert.equal(resumed.pull_request_mutation, false);
    assert.equal(resumed.mutation_invoked, false);
    assert.deepEqual(calls.map((args) => [args[0], args[3]]), [
      ["api", "repos/acme/widget/pulls"],
      ["api", "repos/acme/widget/pulls/91"],
    ]);
    if (expectedStatus === "existing") {
      assert.equal(resumed.status, "published", JSON.stringify(resumed));
      assert.equal(resumed.pr_number, 91);
      assert.equal(resumed.pr_url, matching.html_url);
      assert.equal(resumed.pr_merged, merged);
    } else {
      assert.equal(resumed.status, "partial");
      assert.equal(resumed.pr_reason, "matching-pull-is-closed-unmerged");
      assert.deepEqual(resumed.pr_related_urls, [matching.html_url]);
    }
  });
}
