# Runtime rules: sync pull

For an explicit `miku-scm sync pull` or a standalone `miku-scm github merge done`
on a frozen branch, invoke `repository.sync.pull --apply` for the target
repository. Do not push.

The helper fetches the shared base, preserves staged/unstaged/untracked work,
and chooses the supported no-op, fast-forward, or recorded-base replay. It may
stop for conflicts or unsafe history with retained backup/carryover evidence;
report the exact stopped stage and next action. Never delete the recovery stash
or backup.
Pull requires Git 2.45 or newer. It respects configured fetch refspecs and tag
settings; incomplete branch coverage stops divergent replay instead of widening
the fetch.

An ordinary work branch does not query PR merge state. On a local `-done`
branch, the helper fetches the proposed base and verifies the exact merged PR.
If GitHub reads are unavailable, the helper can request human confirmation
when the fetched base contains the current HEAD. Show the saved repository,
branch, HEAD, base and question. Wait for an affirmative
reply about that displayed target. Continue the same operation with its
returned ID. The helper rechecks saved state and refetches;
do not infer merge from the original request, choose another pending operation,
or proceed on an ambiguous answer.

If output was cut, read only the exact run's `result.json` and matching
`plan.json`. Never start another pull to redisplay or retry a stopped result.
See `sync-pull.md` for base selection, recovery, and exceptional cases.
