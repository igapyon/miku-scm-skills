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
- At initial copy, new repository content was copied from the verified staging tree to `/Users/igapyon/Documents/git/miku-scm-skills`; the target branch and initial commit were preserved.

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
- At initial verification, hosted macOS/Windows CI, release publication, GitHub re-download verification, and source-repository cleanup were still pending; their final outcomes are recorded below.
- After transfer, a checksum-based `rsync --dry-run` reported no differences (excluding the preserved target `.git`/`LICENSE` and intentionally omitted generated `bundle/`/`node_modules/`). Target version alignment and both generated contract checks passed.

## Final Verification and Source Cleanup (2026-11-13)

- Migration PR Actions passed, including the `Miku SCM required` gate and all platform jobs: [run 43258029683](https://github.com/igapyon/miku-scm-skills/actions/runs/43258029683).
- Release `v0.8.1` was published. The ZIP and SHA-256 sidecar were downloaded and verified; the checksum matched, and the verifier from the exact `v0.8.1` tag accepted the archive as 2 Skills / 203 files.
- The migrated Skill trees and their dedicated maintenance, test, and CI references were removed from `igapyon-agent-skills` branch `devel-tiga1112wfh`, starting at `23a2e492fd957d1ac051943fce341689ec1025a1`; the removal was merged as PR #442 (`b20a37b9690fa54984c0432a72a810f695b7ac18`). The current old-repository `origin/devel` tree at `c9036cc701da649ed5e0f1dc81f1276cad1c2fe7` contains neither migrated Skill. Daybook Issue intake remains available and explicitly requires separately installed miku-scm.
- Old-repository checks passed: version alignment 5/5, Skill index policy and route checks 77/77, daybook 79/79, and `mvn validate`. An isolated copy under `/private/tmp` passed `mvn package`; its archive passed with 13 internal, 13 external, 26 total, 13 source-checked, 12 representative routes, and daybook runtime checks. Text-bundle generation and `git diff --check` also passed.
- The old-repository cleanup is merged into `origin/devel`. The remaining Daybook dependency guidance points to the separate `miku-scm-skills` release. No installed Skill synchronization or local `workplace/` data change was performed.
