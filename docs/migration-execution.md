# Migration Execution Record

This record is updated as the migration proceeds. Do not infer an unlisted check or an unrecorded GitHub operation from a source file's presence.

## Initial Copy

- Source repository: `igapyon/igapyon-agent-skills`
- Source commit: `23a2e492fd957d1ac051943fce341689ec1025a1`
- Source branch at inspection: `devel-tiga1112wfh`
- Target repository: `igapyon/miku-scm-skills`
- Target initial commit: `59ce27871e09c6687c85418000a0949db4315b3c`
- Target branch at inspection: `devel-tiga1112xbf`
- Initial common product version at inspection: `1.20261112.4`
- Source Git tree for `skills/igapyon-miku-scm/`: `d6446c8b8cccfa0957511e72df01eb3916a8d465`.
- Source Git tree for `skills/igapyon-github-writer/`: `fef5a3060a1f2c960156f9db16eb050e95f830e9`.
- Copied full Skill trees; only the three version-alignment test files that read the old root `pom.xml` were adapted to read the new root `package.json` and validate both Skills.
- Copied `WINDOWS11-PUSH-PLAN.md` plus the dedicated miku-scm plans, execution records, and CI maintenance references listed in the migration plan.
- Local implementation environment: Node.js `v26.12.1`, npm `11.20.0`, Git `2.54.0` (Apple Git-157).
- New repository content: copied from the verified staging tree to `/Users/igapyon/Documents/git/miku-scm-skills`; target branch and initial commit are preserved, and the implementation remains uncommitted.

## Verification and Publication

- Local verification on Node.js `v26.12.1` / macOS:
  - miku-scm full suite: 60 test files, 552 cases passed.
  - GitHub Writer full suite: 35 cases passed.
  - CI selector: 6 cases passed.
  - package tests: 7 cases passed; both required Skills present, missing-Skill failure covered, exact ZIP extraction verified, both runners' `--version`/`--help` and read-only Git workflows passed.
  - generated contracts current: miku-scm 38 / GitHub Writer 12; version alignment passed.
  - release ZIP `igapyon-miku-scm-skills-1.20261112.4.zip`: 2 Skills / 203 files; isolated extraction verification passed.
  - all repository `.mjs` files passed `node --check`; all four GitHub Actions YAML files parsed successfully.
- One package smoke check exposed direct-runner path comparison failing under macOS `/var` versus `/private/var` temp paths. Both runners now compare real paths; generated contracts and the relevant runner tests were updated, and the final ZIP smoke passed.
- The aggregate `npm test` was not repeated after correcting an obsolete GitHub Writer static assertion. Each aggregate constituent was run successfully on the final content; repeating the 60-file miku-scm suite solely for a combined exit code was avoided.
- Hosted macOS/Windows CI, release tag/assets, GitHub re-download verification, and source-repository cleanup: not performed.
- After transfer, a checksum-based `rsync --dry-run` reported no differences (excluding the preserved target `.git`/`LICENSE` and intentionally omitted generated `bundle/`/`node_modules/`). Target version alignment and both generated contract checks passed.
- Hosted macOS and Windows CI: pending.
- Release tag, commit SHA, URL, ZIP asset, checksum asset, and re-download verification: pending.
- Removal from `igapyon-agent-skills`: pending release verification.
