# Recovering Accidental Work From `-done`

An explicit `miku-scm recover done` request authorizes
`repository.done.recover --apply`. It works with a local repository and
requires no remote configuration or PR status. The only workflow options
are `--repo` and `--apply`.

The runner checks that the selected worktree is on a frozen `*-done` branch
with no unresolved index conflicts or active Git operation. It records the
branch, HEAD and raw index entries before choosing an unused
`rescue/done/<source-branch>/<short-head>` name. A same-HEAD switch with no
upstream preserves staged and unstaged changes and untracked files.
The runner disables Git hooks during inspection, switching and verification
to preserve uncommitted work. The repository keeps its hook configuration.
It does not inspect worktree status or read worktree file contents. The result
reports `working_tree: "unknown"`. The original branch continues to point to
the committed work.

Success requires the rescue branch to be checked out, both refs to point to
the saved commit and the raw index entries to match. If Git stops during the
switch or the resulting state differs, inspect the reported branch and HEAD,
then review the index and worktree before acting again.

Ordinary edits and commits can continue on `rescue/done/*`. The fixed sync,
PR recommit and publication runners block this branch namespace and v1
branches identified through their Git backup and their matching journal or
branch creation reflog. The reflog is checked first. Journal lookup reads only
backup-ID-matched records in verified worktrees; unavailable paths and
workplace symlinks outside a worktree, including cyclic links, are skipped. Git query failures remain
errors. Integrating into the shared base starts with a separately
requested review, as described
in the [runtime rules](runtime-done-recovery.md#work-already-in-recovery).

## Previous recovery records

The old integration and resume modes have been retired. Preserve any old
`workplace/miku-scm/done-recovery/<operation-id>.json` record, branch and
stash. Inspect them with the
[runtime rules](runtime-done-recovery.md#work-already-in-recovery) before
continuing manually. The new local rescue leaves those artifacts alone.
