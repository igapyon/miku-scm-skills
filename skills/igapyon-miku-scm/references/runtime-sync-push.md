# Runtime rules: sync push

Run only for an explicit `miku-scm sync push` request. One request authorizes
the complete bounded sequence below; do not ask between successful steps.
For `*-done` or `rescue/done/*`, follow the
[frozen branch procedure](runtime-done-recovery.md) before preparing a push.

1. Run `repository.sync.push.prepare --apply`. It may commit all ordinary
   non-ignored staged, unstaged and untracked work in the target worktree.
   Sensitive paths require a separate explicit path-by-path consent. Only
   show the returned paths, wait for consent, and pass one
   `--allow-sensitive-path` per agreed path when preparing again. A frozen
   `-done` branch stops. Only `prepared` continues. `up-to-date` is complete;
   all other states stop.
2. Use the result's bounded evidence and writing contract. If a material change
   needs more detail, use one JSON `repository.sync.push.evidence.read` call
   with `--repo`, `--operation`, `--expected-plan-sha256` and up to four literal
   `--path` arguments. Use that same preparation's IDs and digests. Draft once
   and save at the suggested path. Review an existing draft against the same
   evidence. Omit details you cannot substantiate.
3. Run read-only `repository.sync.push.draft.prepare` with the same operation
   and plan digest. It returns the verified draft byte digest and the complete
   `repository.sync.push.apply` argument array. Do not edit or substitute paths.
4. Execute exactly that workflow and argument array once. Apply rechecks the
   plan, draft, base, worktree and publication state before backup/reset.

A changed base requires an explicit sync pull and fresh preparation. A failure
before apply preserves the prepared work. If apply or push is unresolved, inspect
the saved receipt and remote; never resend automatically. Keep the ordinary
commit, backup, index and worktree for recovery. Do not increment versions,
create/merge a PR, or create a tag/Release as part of sync push.

If runner output is cut, read only `result.json` and `plan.json` from that exact
run and verify the target, run, workflow and operation IDs. Never rerun prepare
to obtain another output format or select a global latest operation. See
`sync-push.md` for details and recovery.
