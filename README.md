# miku-scm-skills

Agent Skills for local Git and GitHub repository workflows.

This repository provides two independently installable Skills:

| Skill | Purpose |
| --- | --- |
| `igapyon-miku-scm` | Repeatable repository maintenance, sync, commit, PR, Issue, version, and release workflows. |
| `igapyon-github-writer` | Draft GitHub PR, Release, and About text from local repository evidence. |

The Skills keep their established names and invocation rules. `miku-scm draft recommit push` belongs to `igapyon-miku-scm`. `igapyon-github-writer` remains an explicit writing workflow and never invokes `gh` or accesses the network.

## Install

Download `igapyon-miku-scm-skills-<version>.zip` from [GitHub Releases](https://github.com/igapyon/miku-scm-skills/releases), extract it, and copy either or both directories below into `$CODEX_HOME/skills/` (normally `~/.codex/skills/`):

```text
skills/igapyon-miku-scm/
skills/igapyon-github-writer/
```

Each Skill can also be synchronized from a source checkout using `sh scripts/sync-codex-skill.sh <skill-name>`. The command copies source to the Codex Skill home in one direction; it never imports changes from an installed copy.

## Requirements

- Node.js 22 or newer is required by the included runners. Git is required by both Skills.
- Some `igapyon-miku-scm` workflows require Git 2.45 or newer. GitHub CLI availability is workflow-specific.
- `igapyon-github-writer` uses local Git evidence only and prohibits `gh`.
- Installing a released ZIP does not require npm dependencies. Repository tests and bundle generation use Node.js built-ins and system `zip` / `unzip` tools.

## Develop

```sh
npm ci
npm test
npm run build:bundle:zip
node scripts/verify-release-zip.mjs bundle/igapyon-miku-scm-skills-<version>.zip
```

Canonical sources are under `skills/`. `bundle/`, `node_modules/`, `.codex/`, and all `workplace/` contents except `workplace/.gitkeep` are local or generated output. The generated workflow contract locks and tables inside each Skill are updated only through their contract generator.

See [DEVELOPMENT.md](DEVELOPMENT.md), the [migration record](docs/migration-from-agent-skills.md), and the [miku-soft reference](docs/miku-soft-reference.md) for repository details.
