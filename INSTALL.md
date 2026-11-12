# Install the Skills

1. Download and extract `igapyon-miku-scm-skills-<version>.zip` from [GitHub Releases](https://github.com/igapyon/miku-scm-skills/releases).
2. Copy `skills/igapyon-miku-scm/`, `skills/igapyon-github-writer/`, or both into `$CODEX_HOME/skills/` (normally `~/.codex/skills/`).
3. Restart or refresh the agent session if it does not discover the installed Skill.
4. Read the installed Skill's `SKILL.md`; each Skill has its own explicit activation rules.

To install from a source checkout, run one command for each Skill you want:

```sh
sh scripts/sync-codex-skill.sh igapyon-miku-scm
sh scripts/sync-codex-skill.sh igapyon-github-writer
```

Use `sh scripts/sync-codex-skill.sh --check <skill-name>` to compare source with the installed copy. Synchronization flows only from this repository to `$CODEX_HOME/skills/`.
