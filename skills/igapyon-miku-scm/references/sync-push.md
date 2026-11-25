# Sync push

An exact `miku-scm sync push` request authorizes one compound workflow:
necessary `work.commit`, one evidence-based PR draft, then the existing
recommit/push transition. It does not increment versions, pull/rebase, create
or merge a PR, or create a tag/Release. `draft recommit push` and its
`pr recommit push` alias keep their existing meaning without an ordinary
commit stage.

## Requirements and scope

Use available Node.js and Git commands with an active work branch
and local operational storage under `workplace/miku-scm/sync/`. Missing ignore
setup produces a notice and a local `info/exclude` rule, then continues.
The default remote is `origin`; shared-base selection follows
[sync-pull.md](sync-pull.md#requirements-and-base-selection). Require a single
fetch URL and a single push URL that identify the same repository. A local
`-done` branch is frozen and cannot start this operation.
A `rescue/done/*` branch or a branch identified by a retained v1 recovery
journal must stay local. Sync push blocks its preparation and apply.
Integrate the reviewed work on a separate work branch first.

Fetch honors the remote's branch refspecs and tag settings under the
[pull mapping rules](sync-pull.md#requirements-and-base-selection). Both the
shared base and, when publication is needed, the work branch must map to their
expected remote-tracking refs. A clean no-op needs only the base mapping.
An unfetchable publication branch stops before an
ordinary commit; sync does not expand the configured fetch range to repair it.

The ordinary commit stage includes all current ordinary non-ignored staged,
unstaged and untracked changes, including work outside the latest request;
the existing `work.commit` sensitive-path and validation checks still apply.
Unapproved sensitive paths stop before staging. Show the candidates, wait for
explicit user consent, and repeat preparation with `--allow-sensitive-path`
for each agreed path. A stopped preparation has made no ordinary commit;
start fresh preparation with that bounded consent.
This is a composite workflow, not an alias that changes `draft recommit push`.
When work is already committed, it skips the ordinary commit. When there are
no commits above the base, it returns `up-to-date` without PR drafting,
recommit, push or local `-done` rename.

## Agent route

1. Invoke `node <skill-root>/scripts/miku-scm-run.mjs --format json
   repository.sync.push.prepare --repo <path> --apply`, optionally
   supplying `--remote`, `--base`, and a concise concrete `--message` under
   the same message rules as `work.commit`.
2. Stop on any result other than `prepared`; `up-to-date` needs no draft or
   publication. For `prepared`, retain and verify the exact suggested draft when
   `existing_draft_sha256` is supplied. If the initial evidence leaves a
   material change unclear, make one read-only JSON call to
   `repository.sync.push.evidence.read --repo <path> --operation <id>
   --expected-plan-sha256 <digest> --path <changed-path> [--path <changed-path> ...]`.
   Request up to four literal paths in that call. Compose once from the evidence
   and writing contract, including any supplemental excerpts. Save at
   `suggested_draft_path` and compute its byte SHA-256. An older draft from a
   superseded plan remains unbound.
3. In the same requested workflow, invoke the read-only
   `repository.sync.push.draft.prepare` with this operation ID and plan digest.
   It reads the path only from the verified plan, hashes the exact contained
   draft bytes, and returns the complete apply argument array.
4. Invoke exactly the returned `repository.sync.push.apply` workflow and
   argument array once. Apply rechecks the plan, draft hash and publication
   conditions. Carry the IDs and digests from this conversation; do not choose
   a global latest plan. Report the result in the user's language. When stopped,
   explain whether push started, what work is retained, and the supplied
   `next_command` or inspection.

Successful steps need no extra conversational confirmation. The Agent writes
PR prose; fixed helpers own all Git mechanics. A writing failure leaves the
ordinary commit and prepared operation intact.

### PR evidence

The Node runner collects commit IDs and change statistics across the pinned
base and HEAD. Compose the draft from the net diff and the confirmed purpose
of the change. Exclude the subjects and bodies of the original commits.
For up to 12 files and 400 changed lines, it tries one patch with a 24 KiB
output limit and reuses that patch if it fits. Other changes get totals,
representative paths grouped by directory, omitted counts, and short excerpts
from up to six files. Generated or lock files and binary files count in the
totals. The initial evidence is limited to 32 KiB of compact UTF-8 JSON,
including commit IDs, paths, excerpts and the evidence digest. The outer
runner envelope and formatted console output have their own overhead.
Successful prepare returns the ordinary commit status, path count, checks
and version notice. Its full commit result remains in the operation record.

Supplemental evidence verifies the saved plan and its current branch, HEAD
and local base ref. It validates each requested path against the saved range
before reading its patch. Excerpts keep the existing redaction and stop
at complete lines when an output limit is reached. The supplemental call
does not update the plan or consume the operation. Git publication still
uses the complete prepared tree.

## Reading the same execution result

`--format` selects the output of a new invocation; it does not redisplay an
earlier result. Never start another preparation just to obtain JSON output.
The runner saves the full result before printing either format. Successful
human preparation output includes the operation ID and absolute `Result file`
path, so missing stdout detail can be retrieved without another preparation.

During the same ongoing requested execution, read only that exact `result.json`
and the runner `plan.json` beside it. Confirm their workflow and run IDs agree,
the workflow is `repository.sync.push.prepare`, the plan's `repository` resolves
to the requested repository, and `result.operation_id` matches the operation
from this execution. Require `result.status: prepared`, a complete
`result.evidence` with its `writing_contract`, `suggested_draft_path`, original
`plan_sha256` and HEAD, and matching evidence HEAD. Apply must not have started.
Use those original values for drafting and apply; the existing apply checks
revalidate the current operation, worktree and contracts.

This file read does not advance or resume the operation and needs no extra
confirmation within the same ongoing request. Do not choose a global latest run,
recompute expectations from changed state, or retry an apply. Missing or mismatched
evidence, an interrupted workflow or an uncertain apply outcome stops continuation
and uses the recovery rules below instead of another prepare invocation.

## Prepare contract

Resolve real worktree/common Git directory, branch, remote and shared base.
Use the native command form, report a notice for Linux/other platforms, and
require an active work branch, no conflicting
Git operation and no other pending sync. Fetch once and stop **before an
ordinary commit** if the fetched base is not an ancestor of HEAD. Run fixed
publication preflight (allow dirty only for this read-only preparation) to
check the destination/upstream/completion branch before committing. If the
worktree is clean and HEAD equals that fetched base, save a completed
`up-to-date` operation immediately; skip the work-branch mapping, local done
branch collision check and publication preflight because no publication follows.

Dirty work calls existing `work.commit` once; carry its scope, sensitive-path
checks, version notice, title fallback and repository checks unchanged.
`committed` is the only result that advances; partial/not-applied/conflict or
an exception stops. Clean work skips this commit. No commits above base is
`up-to-date`. Otherwise bind clean branch/HEAD, base SHA, remote expectation,
bounded exact-range PR evidence, draft path and apply contract to a plan
digest stored in ignored `workplace/miku-scm/sync/operations/<id>/`.

Prepare releases the execution lock while awaiting prose. The operation
remains prepared; the recovery routes below can return its saved evidence or
cancel it. A new explicitly requested `sync pull` may supersede a prepared or
needs-sync-pull push only when apply has never started.

## Apply contract

Require exact contained plan identity/digest, current apply contract, prepared
unconsumed operation, original clean snapshot, exact suggested draft path and
draft bytes. Expand actual `remote get-url --all` and `--push --all` URLs;
require one fetch and push URL for the same repository and reject mirrors.
Bind their full digest and the fetch/tag configuration without storing
credentials. Revalidate at apply,
inside the recommit core immediately before backup/reset, and before remote
fetch/push/verification. Bind the prepared remote branch expectation too.

Fetch again before apply; a changed base stops with a fresh-evidence /
`sync pull` instruction while preserving the ordinary commit. Delegate to
`pr.recommit.push` with the pinned base and draft. Share its backup, explicit
remote lease/new-branch absence expectation, publication attempt receipt, exact
post-push `0 0` check and `-done` rename. Do not reconstruct this sequence in
the Agent. Do not retry a consumed plan or an unknown remote mutation.
The remote branch keeps its published name; only the local branch receives
`-done`. The human creates and merges the PR using the saved title/body.
Afterward, explicit `sync pull` can verify the merge and create the next work
branch, or the human can report it with the existing `github merge done`.

Results report the ordinary commit as created/skipped, the stopped stage,
backup and final branch. A remote result that cannot be verified is
`unresolved`, requires inspection of the saved publication attempt, and may
not be cleared by a new pull or an automatic resend.

## Recovery

A repeated plain `sync push` is the normal continuation command. Under the
repository lock, the helper considers only a single pending push for the current
repository, branch and selected remote. It verifies remote configuration and
saved plan integrity. An unchanged unapplied plan returns the same evidence and
existing draft digest without another commit. Changed local work, local base or
apply contract supersedes the unapplied plan and creates fresh evidence with a
distinct draft path. A `needs-sync-pull` operation is also superseded and checked
again, so the result can name `miku-scm sync pull` instead of trapping later syncs.
Old operation files and drafts are retained. Ambiguous operations, another
branch/remote, corrupted evidence, or unknown publication outcomes remain blocked.

An unapplied plan from the earlier evidence contract keeps its saved bytes,
digest and draft. A plain `miku-scm sync push` prepares fresh evidence for the
current contract. Explicit `--resume` reports the contract mismatch and directs
the caller to that command.

A single pending ordinary-commit failure may also be superseded by plain
`sync push` when it stopped in `pre-commit-check` or `post-check-verify`, the
branch and HEAD are unchanged, Git is idle, and no backup, recommit, delegate
or publication apply started. The saved `head_before` must match the original
and current HEAD. Current work and staged content are retained and all normal
checks, including sensitive-path consent, run again. A second failure stops;
the helper does not loop. Commit-stage failures and changed history still
require inspection. The initial failure names the check problem and gives
`miku-scm sync push` as the next command for this supported case.

The same-execution file read above is separate from resuming an interrupted
workflow. Carry the returned operation ID in the conversation. Pass these workflow
arguments are also available for explicit diagnostic selection:

```text
repository.sync.push.prepare --repo <path> --resume <operation-id> --apply
repository.sync.push.prepare --repo <path> --cancel <operation-id> --apply
repository.sync.push.prepare --repo <path> --recover <operation-id> --apply
```

Resume returns the same completed evidence and plan after validating the
saved branch, HEAD, local base ref and remote, without another commit. It
requires a saved complete plan; an interrupted preparation without one must
be cancelled before starting a new preparation. Cancellation is available
only before apply starts and preserves all work, ordinary commits and draft
files; it does not undo the ordinary commit.

Automatic recovery (also selectable with `--recover`) accepts a saved `partial`
after recommit only when its structured publication result proves
`publication-preflight` stopped before push, or the exact legacy branch-path
`ENOENT` proves the same. The original publication expectation must be absent.
The helper verifies the plan digest and identity, backup and exact HEAD, current
branch ancestry, unchanged remote configuration, and current remote branch
absence. The legacy case also verifies missing failed plan/attempt files.
It marks that operation `recovered` and creates a fresh sync
push preparation from the current branch and worktree. That preparation commits
ordinary dirty work under the normal checks and requires a new PR draft bound to
the fresh evidence; it never reuses the consumed plan or draft. A base advance
then returns `next_command: miku-scm sync pull`, with the old operation retired so
pull can run. A remote branch appearing during fresh preparation stops before a
commit. Failed evidence checks and unknown publication results preserve the old
operation for inspection. Publication filenames use safe branch tokens and a
UUID so repeated saves in the same minute cannot collide.

Before backup/reset, publication storage is probed for writability. A failure
that proves recommit never started and leaves the prepared snapshot unchanged
retains the original plan as `prepared`; repeating sync push reuses it after the
environment problem is fixed. No apply attempt is automatically sent twice.

If the base advanced, run `sync pull` only when explicitly requested, then
prepare again and write a fresh bound draft. Do not reuse the old plan/draft
digests. If apply started or the remote outcome is unknown, these preparation
routes cannot cancel or replay it. The verified preflight-only recovery above
is the only automatic path after local recommit;
all other outcomes require inspecting the saved publication result and retained
backup before a separately designed recovery.

## Interrupted initialization and diagnostics

Lock schema 2 records `initializing` until the operation journal is saved,
then `operation-recorded`. If the owner is provably dead and the operation
directory was never created, explicitly cancel that exact initializing lock:

```text
repository.sync.push.prepare --repo <path> --cancel <reported-operation-id> --apply
```

After cancellation returns, repeat plain `miku-scm sync push`. This does not
discard work. Live owners, another root/ID, legacy or malformed locks, and a
missing state inside an existing directory are not eligible. Existing saved
operations continue through the normal recovery rules.

Git failure results include a fixed diagnostic category, exit/signal/spawn code
and guidance for authentication, DNS, connectivity, repository availability,
permissions or timeout. Raw transport stderr and URL credentials are not
copied into the diagnostic. Partial or uncertain mutations keep their recovery
requirements even when the environment error is retryable.
