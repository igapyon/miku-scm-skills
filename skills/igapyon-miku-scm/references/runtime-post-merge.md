# Runtime rules: merged work branch

Use `miku-scm sync pull` for the normal next-work transition. It verifies the
exact merged PR and supports squash and rebase merges.

`repository.post-merge.next-work` is a compatibility entry to the shared
`sync pull` next-work operation. The user's merge report must identify the PR
and selected base. Pass its full SHA with
`--published-head <verified-published-head> --confirmed-merged --apply`.
The entry records the confirmed `-done` branch and full SHA. After acquiring
the worktree's sync lock, the operation checks both against one repository
snapshot before it fetches or moves work. It then fetches the selected base and
checks Git ancestry. It preserves the legacy base inference from the done
branch and remote `HEAD`, and accepts a local
bare remote. Git 2.45 or newer and the normal sync operational storage and
lock are required. If Git cannot prove ancestry, use exact PR verification
with `miku-scm sync pull` or preserve work with `miku-scm recover done`.

Local Git replacement refs and grafts stop the transition. The new local
branch uses the first JST minute whose work and `-done` names are both free.

The shared sync-pull operation checks ignored checkout collisions before it
creates a backup or stash. Staged changes and ignored collisions stop with
work in place. Unstaged and untracked changes use the operation's exact
retained stash. One Git query checks the current branch and its pinned
commit before recording completion. If the transition stops after mutation,
report its saved operation ID and follow the shared operation's `next_action`.
If a read or final state write fails after a change, report the known change
and the operation ID. Use the last saved state to resume after resolving the
reported failure. When lock release fails, report the operation result and
ID with the lock warning. Check the lock before starting another sync.

If next-branch creation stopped while writing tracking configuration,
inspect the branch SHA and upstream, repair them if needed, then resume with
the indicated
`--resolved-next-work`. An unconfirmed checkout or hook also requires
`--resolved-next-work` after inspection. A carryover conflict requires the
usual `--resolved-carryover` confirmation.
When restoration stops, include that option in the resume command after
reviewing and staging the resolved files.
Do not push or modify the tag/Release as part of this handoff.
