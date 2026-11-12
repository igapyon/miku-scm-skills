# Migration from igapyon-agent-skills

The canonical source for these two Skills moved from `igapyon-agent-skills` to `miku-scm-skills`.

| Installed Skill | New source |
| --- | --- |
| `igapyon-miku-scm` | `skills/igapyon-miku-scm/` |
| `igapyon-github-writer` | `skills/igapyon-github-writer/` |

The migration preserves the installed Skill names and their separate activation rules. The initial migration source commit and content hashes are recorded in `migration-execution.md`. The new repository owns the independent package version, tests, CI, bundle, and GitHub Release assets. The earlier repository's existing history and Releases remain unchanged.

The installed copy in `$CODEX_HOME/skills/` is a deployment target. Synchronization goes from this repository's `skills/` directories to that target only.
