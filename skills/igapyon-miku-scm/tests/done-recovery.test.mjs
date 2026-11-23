import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseArgs } from "../scripts/done-recovery.mjs";

const runner = fileURLToPath(new URL("../scripts/miku-scm-run.mjs", import.meta.url));

function git(repo, ...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function invoke(repo, workflow, ...args) {
  const child = spawnSync(process.execPath, [runner, "--format", "json", workflow, "--repo", repo, ...args], {
    cwd: repo, encoding: "utf8",
  });
  return { code: child.status, result: JSON.parse(child.stdout || child.stderr) };
}

async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "miku-scm-done-recovery-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const repo = path.join(temp, "work");
  await mkdir(repo);
  git(repo, "init", "-b", "devel");
  git(repo, "config", "user.name", "Recovery Test");
  git(repo, "config", "user.email", "recovery@example.invalid");
  await writeFile(path.join(repo, ".gitignore"), "/workplace/miku-scm/\n");
  git(repo, "add", "--", ".gitignore");
  const commit = async (file, contents, subject) => {
    await writeFile(path.join(repo, file), contents);
    git(repo, "add", "--", file);
    git(repo, "commit", "-m", subject);
    return git(repo, "rev-parse", "HEAD");
  };
  const base = await commit("tracked.txt", "base\n", "base");
  const source = "devel-tiga1120kaa-done";
  git(repo, "switch", "-c", source);
  const published = await commit("published.txt", "old PR\n", "published PR work");
  const head = await commit("accidental.txt", "later work\n", "accidental work");
  const rescue = `rescue/done/${source}/${head.slice(0, 12)}`;
  return { temp, repo, base, source, published, head, rescue };
}

test("local rescue rejects the retired integration and resume flags", () => {
  assert.throws(() => parseArgs([]), /--apply is required/);
  assert.throws(() => parseArgs(["--apply", "--confirmed-merged"]), /unavailable for local rescue/);
  assert.throws(() => parseArgs(["--apply", "--resume", "legacy-operation"]), /unavailable for local rescue/);
  assert.throws(() => parseArgs(["--apply", "--resolved-carryover"]), /unavailable for local rescue/);
});

test("the fixed runner rescues local commits, index, worktree and untracked files without a remote", async (t) => {
  const { repo, source, head, rescue } = await fixture(t);
  await writeFile(path.join(repo, "tracked.txt"), "staged\n");
  git(repo, "add", "tracked.txt");
  await writeFile(path.join(repo, "tracked.txt"), "staged\nunstaged\n");
  await writeFile(path.join(repo, "untracked.txt"), "untracked\n");
  const hooks = path.join(repo, ".git", "recovery-hooks");
  await mkdir(hooks);
  await writeFile(path.join(hooks, "post-checkout"), "#!/bin/sh\nprintf regenerated > tracked.txt\nprintf regenerated > untracked.txt\n", { mode: 0o755 });
  git(repo, "config", "core.hooksPath", hooks);
  git(repo, "config", "hook.regenerate=files.event", "post-checkout");
  git(repo, "config", "hook.regenerate=files.command", "printf regenerated > untracked.txt");
  const staged = git(repo, "diff", "--cached", "--binary");
  const unstaged = git(repo, "diff", "--binary");
  const indexHook = path.join(hooks, "post-index-change");
  await writeFile(indexHook, "#!/bin/sh\nprintf regenerated > tracked.txt\nprintf regenerated > untracked.txt\nprintf invoked > .git/index-hook-invoked\n", { mode: 0o755 });
  const older = new Date("2000-01-01T00:00:00Z");
  await utimes(path.join(repo, "accidental.txt"), older, older);
  assert.equal(git(repo, "remote"), "");

  const { code, result } = invoke(repo, "repository.done.recover", "--apply");

  assert.equal(code, 0, JSON.stringify(result));
  assert.equal(result.delegate_status, "rescued");
  assert.equal(result.result.final_branch, rescue);
  assert.equal(result.result.head, head);
  for (const branch of [source, rescue]) assert.equal(git(repo, "rev-parse", `refs/heads/${branch}`), head);
  await assert.rejects(stat(path.join(repo, ".git", "index-hook-invoked")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(repo, "untracked.txt"), "utf8"), "untracked\n");
  await rm(indexHook);
  assert.equal(git(repo, "diff", "--cached", "--binary"), staged);
  assert.equal(git(repo, "diff", "--binary"), unstaged);
  assert.equal(await readFile(path.join(repo, "accidental.txt"), "utf8"), "later work\n");
  assert.equal(git(repo, "stash", "list"), "");
  assert.equal(git(repo, "config", "core.hooksPath"), hooks);
  assert.equal(git(repo, "config", "hook.regenerate=files.event"), "post-checkout");
});

test("local rescue does not read an unreadable untracked file", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async (t) => {
  const { repo, source, head, rescue } = await fixture(t);
  await writeFile(path.join(repo, "tracked.txt"), "staged\n");
  git(repo, "add", "tracked.txt");
  await writeFile(path.join(repo, "tracked.txt"), "staged\nunstaged\n");
  const file = path.join(repo, "unreadable.bin");
  const bytes = Buffer.from([0, 255, 13, 10, 128]);
  await writeFile(file, bytes);
  const staged = git(repo, "diff", "--cached", "--binary");
  const unstaged = git(repo, "diff", "--binary");
  const index = git(repo, "ls-files", "--stage");
  await chmod(file, 0);

  const { code, result } = invoke(repo, "repository.done.recover", "--apply");

  await chmod(file, 0o600);
  assert.equal(code, 0, JSON.stringify(result));
  assert.equal(result.result.final_branch, rescue);
  assert.equal(result.result.head, head);
  assert.equal(result.result.working_tree, "unknown");
  for (const branch of [source, rescue]) assert.equal(git(repo, "rev-parse", `refs/heads/${branch}`), head);
  assert.equal(git(repo, "ls-files", "--stage"), index);
  assert.equal(git(repo, "diff", "--cached", "--binary"), staged);
  assert.equal(git(repo, "diff", "--binary"), unstaged);
  assert.deepEqual(await readFile(file), bytes);
});

test("local rescue keeps a preexisting branch and stops for an active Git operation", async (t) => {
  const { repo, source, head, rescue } = await fixture(t);
  git(repo, "branch", rescue, "devel");
  const oldRef = git(repo, "rev-parse", rescue);
  const mergeHead = path.join(repo, ".git", "MERGE_HEAD");
  await writeFile(mergeHead, `${oldRef}\n`);
  const blocked = invoke(repo, "repository.done.recover", "--apply");
  assert.equal(blocked.code, 1);
  assert.equal(blocked.result.status, "not-applied");
  assert.match(blocked.result.error.message, /MERGE_HEAD/);
  assert.equal(git(repo, "branch", "--show-current"), source);
  await rm(mergeHead);

  const rescued = invoke(repo, "repository.done.recover", "--apply");
  assert.equal(rescued.code, 0, JSON.stringify(rescued.result));
  assert.equal(rescued.result.result.final_branch, `${rescue}-2`);
  assert.equal(git(repo, "rev-parse", rescue), oldRef);
  assert.equal(git(repo, "rev-parse", "HEAD"), head);
});

test("local rescue preserves a large untracked file without the sync snapshot size limit", async (t) => {
  const { repo, rescue, head } = await fixture(t);
  const file = path.join(repo, "recording.wav");
  await writeFile(file, "audio");
  await truncate(file, 65 * 1024 * 1024);
  const before = await stat(file);
  const { code, result } = invoke(repo, "repository.done.recover", "--apply");
  assert.equal(code, 0, JSON.stringify(result));
  assert.equal(result.result.final_branch, rescue);
  assert.equal(result.result.head, head);
  const after = await stat(file);
  assert.equal(after.size, before.size);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("direct sync, publication and recommit runners reject a rescue branch before touching work", async (t) => {
  const { temp, repo, head, published, rescue } = await fixture(t);
  const remote = path.join(temp, "origin.git");
  git(repo, "init", "--bare", remote);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "origin", "devel", `${published}:refs/heads/devel-tiga1120kaa`);
  git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/devel");
  const rescued = invoke(repo, "repository.done.recover", "--apply");
  assert.equal(rescued.code, 0, JSON.stringify(rescued.result));
  assert.equal(git(repo, "branch", "--show-current"), rescue);
  await writeFile(path.join(repo, "tracked.txt"), "ordinary local work\n");

  for (const [workflow, ...args] of [
    ["repository.sync.push.prepare", "--apply"],
    ["repository.sync.pull", "--apply"],
    ["pr.publish.preflight", "--expected-head", head, "--save-plan"],
    ["pr.recommit.preflight", "--base", "origin/devel"],
  ]) {
    const blocked = invoke(repo, workflow, ...args);
    assert.equal(blocked.code, 1, JSON.stringify(blocked.result));
    assert.match(JSON.stringify(blocked.result), /Rescue branch is local only/);
    assert.equal(blocked.result.mutation_invoked, false, workflow);
  }
  assert.equal(git(repo, "rev-parse", "HEAD"), head);
  assert.equal(git(repo, "diff", "--cached"), "");
  assert.equal(git(repo, "ls-remote", "--heads", "origin", rescue), "");
  assert.equal(await readFile(path.join(repo, "tracked.txt"), "utf8"), "ordinary local work\n");

  const committed = invoke(repo, "work.commit", "--message", "local recovery work", "--apply");
  assert.equal(committed.code, 0, JSON.stringify(committed.result));
  assert.equal(committed.result.delegate_status, "committed");
});

test("a retained v1 journal keeps its ordinary named rescue branch out of sync and publication", async (t) => {
  const { temp, repo, head, published, source } = await fixture(t);
  const remote = path.join(temp, "legacy-origin.git");
  git(repo, "init", "--bare", remote);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "origin", "devel", `${published}:refs/heads/devel-tiga1120kaa`);
  git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/devel");
  const branch = "devel-tiga1121idd";
  const id = "12345678-1234-4234-9234-123456789abc";
  const backup = `backup/done-recovery-${id}`;
  git(repo, "branch", backup, head);
  git(repo, "branch", branch, head);
  git(repo, "switch", branch);
  const directory = path.join(repo, "workplace", "miku-scm", "done-recovery");
  await mkdir(directory, { recursive: true });
  const record = {
    schema_version: "miku-scm.done-recovery/v1", id, repository: await realpath(repo),
    mode: "rescue", status: "completed", previous_branch: source, initial_head: head, next_branch: branch, backup_branch: backup,
  };
  const journal = path.join(directory, `${id}.json`);
  const journalText = JSON.stringify(record);
  await writeFile(journal, journalText);

  for (const [workflow, ...args] of [
    ["repository.sync.push.prepare", "--apply"],
    ["repository.sync.pull", "--apply"],
    ["pr.publish.preflight", "--expected-head", head, "--save-plan"],
    ["pr.recommit.preflight", "--base", "origin/devel"],
  ]) {
    const { code, result } = invoke(repo, workflow, ...args);
    assert.equal(code, 1, JSON.stringify(result));
    assert.match(JSON.stringify(result), /Rescue branch is local only/);
    assert.equal(result.mutation_invoked, false);
  }
  assert.equal(git(repo, "branch", "--show-current"), branch);
  assert.equal(git(repo, "rev-parse", "HEAD"), head);
  assert.equal(await readFile(journal, "utf8"), journalText);
  assert.equal(git(repo, "ls-remote", "--heads", "origin", branch), "");

  git(repo, "switch", source);
  const linked = path.join(temp, "linked checkout");
  git(repo, "worktree", "add", linked, branch);
  for (const [workflow, ...args] of [
    ["repository.sync.push.prepare", "--apply"],
    ["repository.sync.pull", "--apply"],
    ["pr.publish.preflight", "--expected-head", head, "--save-plan"],
    ["pr.recommit.preflight", "--base", "origin/devel"],
  ]) {
    const { code, result } = invoke(linked, workflow, ...args);
    assert.equal(code, 1, JSON.stringify(result));
    assert.match(JSON.stringify(result), /Rescue branch is local only/);
    assert.equal(result.mutation_invoked, false, workflow);
  }
  assert.equal(git(linked, "branch", "--show-current"), branch);
  assert.equal(git(linked, "rev-parse", "HEAD"), head);
  assert.equal(await readFile(journal, "utf8"), journalText);
  assert.equal(git(repo, "ls-remote", "--heads", "origin", branch), "");

  // Use a v1 journal that originated in the linked checkout being moved.
  const linkedRecord = { ...record, repository: await realpath(linked) };
  const linkedJournal = path.relative(repo, journal);
  await mkdir(path.dirname(path.join(linked, linkedJournal)), { recursive: true });
  await writeFile(path.join(linked, linkedJournal), JSON.stringify(linkedRecord));
  await rm(journal);
  const moved = path.join(temp, "renamed checkout");
  git(repo, "worktree", "move", linked, moved);
  const movedResult = invoke(moved, "repository.sync.push.prepare", "--apply");
  assert.equal(movedResult.code, 1, JSON.stringify(movedResult.result));
  assert.match(JSON.stringify(movedResult.result), /Rescue branch is local only/);
  assert.equal(movedResult.result.mutation_invoked, false);
  assert.equal(git(moved, "rev-parse", "HEAD"), head);
  assert.deepEqual(JSON.parse(await readFile(path.join(moved, linkedJournal), "utf8")), linkedRecord);

  await writeFile(path.join(moved, "more.txt"), "work after rescue\n");
  git(moved, "add", "more.txt");
  git(moved, "commit", "-m", "continue recovery");
  const later = git(moved, "rev-parse", "HEAD");
  git(repo, "worktree", "remove", moved);
  git(repo, "switch", branch);
  const removedResult = invoke(repo, "repository.sync.push.prepare", "--apply");
  assert.equal(removedResult.code, 1, JSON.stringify(removedResult.result));
  assert.match(JSON.stringify(removedResult.result), /Rescue branch is local only/);
  assert.equal(removedResult.result.mutation_invoked, false);
  assert.equal(git(repo, "rev-parse", "HEAD"), later);

  const other = path.join(temp, "independent clone");
  git(repo, "clone", "--branch", "devel", remote, other);
  git(other, "switch", "-c", branch, "origin/devel");
  await mkdir(path.dirname(path.join(other, linkedJournal)), { recursive: true });
  await writeFile(path.join(other, linkedJournal), journalText);
  const unrelated = invoke(other, "repository.sync.pull", "--apply");
  assert.equal(unrelated.code, 0, JSON.stringify(unrelated.result));
  assert.equal(unrelated.result.result.status, "up-to-date");

  // The backup SHA can later become the shared base for normal branches.
  git(repo, "push", "origin", `${head}:refs/heads/devel`);
  git(repo, "switch", "-c", "devel-tiga1121ide", "origin/devel");
  const normal = invoke(repo, "repository.sync.pull", "--apply");
  assert.equal(normal.code, 0, JSON.stringify(normal.result));
  assert.equal(normal.result.result.status, "up-to-date");
});

test("legacy integrated evidence skips an unrelated worktree with an external workplace symlink", async (t) => {
  const { temp, repo, head, published, source } = await fixture(t);
  const remote = path.join(temp, "integrated-origin.git");
  git(repo, "init", "--bare", remote);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "origin", "devel", `${published}:refs/heads/devel-tiga1120kaa`);
  git(repo, "fetch", "origin");
  git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/devel");

  const symlinkWorktree = path.join(temp, "unrelated worktree");
  git(repo, "worktree", "add", "--detach", symlinkWorktree, "origin/devel");
  const outside = path.join(temp, "external workplace");
  const outsideEvidence = path.join(outside, "miku-scm", "done-recovery");
  await mkdir(outsideEvidence, { recursive: true });
  await symlink(outside, path.join(symlinkWorktree, "workplace"));
  const cyclicWorktree = path.join(temp, "cyclic workplace worktree");
  git(repo, "worktree", "add", "--detach", cyclicWorktree, "origin/devel");
  await symlink("workplace", path.join(cyclicWorktree, "workplace"));

  const id = "22345678-1234-4234-9234-123456789abc";
  const backup = `backup/done-recovery-${id}`;
  const branch = "devel-tiga1121idd";
  git(repo, "branch", backup, head);
  const evidenceWorktree = path.join(temp, "evidence worktree");
  git(repo, "worktree", "add", "--detach", evidenceWorktree, "origin/devel");
  const directory = path.join(evidenceWorktree, "workplace", "miku-scm", "done-recovery");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${id}.json`), JSON.stringify({
    schema_version: "miku-scm.done-recovery/v1", id, repository: await realpath(evidenceWorktree),
    mode: "integrated", status: "completed", previous_branch: source, initial_head: head,
    next_branch: branch, backup_branch: backup,
  }));

  git(repo, "switch", "-c", branch, "origin/devel");
  assert.notEqual(git(repo, "reflog", "show", "--format=%gs", `refs/heads/${branch}`).split("\n")[0], `branch: Created from ${head}`);
  const blocked = invoke(repo, "repository.sync.pull", "--apply");
  assert.equal(blocked.code, 1, JSON.stringify(blocked.result));
  assert.match(JSON.stringify(blocked.result), /Rescue branch is local only/);
  assert.equal(git(repo, "branch", "--show-current"), branch);
  assert.equal(git(repo, "rev-parse", "HEAD"), git(repo, "rev-parse", "origin/devel"));

  const ordinary = "devel-tiga1122aae";
  git(repo, "switch", "-c", ordinary, "origin/devel");
  const normal = invoke(repo, "repository.sync.pull", "--apply");
  assert.equal(normal.code, 0, JSON.stringify(normal.result));
  assert.equal(normal.result.result.status, "up-to-date");
  assert.equal(git(repo, "branch", "--show-current"), ordinary);
});
