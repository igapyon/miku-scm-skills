# Development

## Source layout

- `skills/igapyon-miku-scm/` is the canonical miku-scm Skill source, including its runner, references, workflow contracts, tests, and generated contract metadata.
- `skills/igapyon-github-writer/` is the canonical GitHub Writer Skill source, including its runner, references, workflow contracts, and tests.
- `scripts/`, `tests/`, and `.github/` contain only repository-level version, packaging, and CI support.
- `workplace/` is local scratch space. Track only `.gitkeep`.

Keep the installed Skill names and each Skill's authority boundaries stable. Miku SCM owns its explicit SCM flows and the `draft recommit push` alias. GitHub Writer has no network workflow and must not invoke `gh`.

## Requirements

Use Node.js 22 or newer and Git. Use Node.js 26 for the reproducible release-build environment. Some miku-scm workflows require Git 2.45 or newer. Tests that exercise Maven-backed behavior require Maven and a Java 17 runtime. The `igapyon-github-writer` runner remains local-only.

## Versioning

The repository uses Semantic Versioning (`MAJOR.MINOR.PATCH`), with `package.json` as the authoritative version. The root `mikuScm.version` declaration identifies that policy for miku-scm workflows. Keep the top-level and root-package values in `package-lock.json` and the `PRODUCT_VERSION` values in both Skill runners aligned with it. Release tags use `v<version>`; the current development version is `0.8.2`, with release tag `v0.8.2`. `npm run check:version` validates the package, lockfile, and both Skill runner versions.

## Commands

```sh
npm ci
npm run check:version
npm run test:miku-scm:fast
npm run test:miku-scm:full
npm run test:github-writer:fast
npm run test:github-writer:full
npm run test:ci-selector
npm run test:package
npm test
npm run build:bundle:zip
```

`npm test` runs each full Skill suite once, repository-level selector and package tests, and generated-contract checks. The GitHub Writer fast suite currently selects the same test files as its full suite; do not run both back-to-back without a specific reason. The two bundle-content checks share the generated output and run serially.

When editing a Skill, use its fast suite while iterating and its full suite before handoff. Regenerate its workflow contracts after changing a runner, normative spec, manifest, or contract test; then run that Skill's `--check`. Do not hand-edit generated lock or contract-table files.

## Bundle

`npm run build:bundle:zip` builds both canonical Skill trees into `bundle/miku-scm-skills/` and produces `bundle/igapyon-miku-scm-skills-<version>.zip`. The ZIP root contains `README.md`, `INSTALL.md`, `LICENSE`, and `skills/<skill-name>/` for both Skills. It omits repository-only tests, docs, CI, Git data, local Codex deployments, and `workplace/` data. It retains the files inside each Skill that are required by its contracts and references.

Run `node scripts/verify-release-zip.mjs <zip-path>` against the exact ZIP being prepared or downloaded. It verifies both Skills from the ZIP in an isolated directory and exercises metadata commands and read-only status workflows against a temporary Git repository.

## Release

Use a `v<package.json version>` tag. The release workflow checks out the specified tag, validates the independent package and Skill versions, checks generated contracts, builds and verifies the ZIP, and uploads the ZIP with a SHA-256 sidecar. For a public release, download both assets from GitHub and verify the checksum and ZIP contents against the tagged source.

## Local Scratch and Skill Installation

The repository `.gitignore` excludes `.codex/`, generated bundles, dependencies, and `workplace/*` while retaining `workplace/.gitkeep`. Synchronization is a one-way copy from `skills/<skill-name>/` to `$CODEX_HOME/skills/<skill-name>/`.
