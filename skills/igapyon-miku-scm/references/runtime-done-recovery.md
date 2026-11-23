# Frozen branch and local rescue

## Check before acting

On `*-done`, read the branch, full HEAD and staged, unstaged, untracked and
conflicted state. Keep ordinary editing, committing and publishing on work
branches.

- If this conversation establishes that commits were added after publication,
  show both SHAs and offer `miku-scm recover done` to preserve the work.
  If the user asks to edit a frozen branch with existing work, offer the same
  recovery. Handle conflicts or an active Git operation before switching.
- After merge, use `miku-scm sync pull` to verify the exact PR and start the
  next branch with any uncommitted changes. If GitHub is unavailable, the
  helper requests confirmation only if the fetched base includes the current
  HEAD. Show the saved repository, branch, HEAD and base before continuing.
  If there is no proof for the transition, keep the work on the current
  branch or use `miku-scm recover done` to continue locally.

## Recover on the same commit

An explicit request to recover the work authorizes
`repository.done.recover --apply`, including when the PR is open or GitHub
is unreachable. The runner handles the same-HEAD switch, uses a unique local
`rescue/done/*` branch, and verifies both refs and the index. It does not read
worktree file contents or report a clean/dirty state; the result uses
`working_tree: "unknown"`.
The runner disables Git hooks during inspection, switching and verification
to preserve uncommitted work.
Report the two branches and preserved work. If the switch stops, show the
observed branch and HEAD, then inspect the index and worktree before acting
again.

## Work already in recovery

A `rescue/done/*` branch can hold further local work and commits. Fixed
sync, recommit and publication workflows reject that namespace and branches
identified by a v1 recovery backup ref together with its matching journal or
the original rescue branch's creation reflog. A worktree move keeps the
journal discoverable, and removing the checkout leaves its Git reflog and
backup ref available. The reflog fallback also blocks a standard work branch
name created manually from that exact backup SHA. If the necessary evidence
has been deleted or expired, the runner may no longer recognize a v1 branch.
The reflog is checked before journal files. Journal lookup reads only records
whose filename matches a local backup ID and only inside a verified worktree
of the same Git repository. Missing, unreadable, externally symlinked or cyclic
evidence paths are skipped; failures from Git's worktree and ref queries stop
the check.
For a requested integration, verify the prior PR's repository, HEAD,
destination and merge result on the fetched base. Use the **current rescue
branch** to identify the commits and uncommitted work to carry, including
work added after the switch. Keep the branch and its worktree available while
preparing a separate branch from that base. A patch in the base history can
have been reverted, so check the content at the base tip before treating
work as present. Sync or publish from the new work branch after verifying
the transferred work against the rescue branch.

For an interrupted run of the former integration mode, retain the exact
backup, stash and journal. Read its operation record and report the stopped
stage and current Git state. Before any manual continuation, match Git's
`CHERRY_PICK_HEAD` to the recorded `active_commit` and current HEAD to
`head_before_replay`. Review any partly restored index, worktree and
untracked files before acting on the stash. The old resume flags are disabled.
