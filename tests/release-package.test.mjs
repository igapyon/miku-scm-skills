import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildBundle } from "../scripts/build-skill-bundle.mjs";
import { assertFileMapsEqual, collectReleaseFiles } from "../scripts/release-archive-files.mjs";
import { validateReleaseTag } from "../scripts/validate-release-tag.mjs";
import { writeSha256 } from "../scripts/write-sha256.mjs";
import { verifyReleaseZip } from "../scripts/verify-release-zip.mjs";
import { buildBundleZip } from "../scripts/build-skill-bundle-zip.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillNames = ["igapyon-miku-scm", "igapyon-github-writer"];

function copyFixture(t, { skills = skillNames } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "miku-scm-skills-package-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "skills"), { recursive: true });
  for (const file of ["package.json", "README.md", "INSTALL.md", "LICENSE"]) cpSync(path.join(sourceRoot, file), path.join(root, file));
  for (const name of skills) cpSync(path.join(sourceRoot, "skills", name), path.join(root, "skills", name), { recursive: true });
  return root;
}

test("bundle includes both whole Skills and excludes repository-only files", (t) => {
  const root = copyFixture(t);
  const bundleRoot = buildBundle(root);
  const expected = new Map();
  for (const file of ["README.md", "INSTALL.md", "LICENSE"]) {
    const bytes = readFileSync(path.join(root, file));
    expected.set(file, { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  for (const skill of skillNames) {
    for (const [relative, metadata] of collectReleaseFiles(path.join(root, "skills", skill), { skillRoot: true })) {
      expected.set(`skills/${skill}/${relative}`, metadata);
    }
    assert.equal(existsSync(path.join(bundleRoot, "skills", skill, "SKILL.md")), true);
  }
  assertFileMapsEqual(expected, collectReleaseFiles(bundleRoot), "skill bundle");
  assert.equal(existsSync(path.join(bundleRoot, "docs")), false);
  assert.equal(existsSync(path.join(bundleRoot, ".github")), false);
});

test("bundle fails when one of the two installable Skills is missing", (t) => {
  const root = copyFixture(t, { skills: ["igapyon-miku-scm"] });
  assert.throws(() => buildBundle(root), /missing or empty|SKILL/);
});

test("release ZIP is verified after extraction and both read-only runners execute", (t) => {
  const root = copyFixture(t);
  const zip = buildBundleZip(root);
  assert.equal(existsSync(zip), true);
  const result = verifyReleaseZip(zip, root);
  assert.equal(result.skillCount, 2);
  assert.ok(result.fileCount > 2);
});

test("release tags must match the package version exactly and checksums are write-once", async (t) => {
  assert.equal(validateReleaseTag("v0.8.1", "0.8.1"), "0.8.1");
  assert.throws(() => validateReleaseTag("v0.8.2", "0.8.1"), /must equal/);
  assert.throws(() => validateReleaseTag("v$(touch marker)", "0.8.1"), /must equal/);

  const root = mkdtempSync(path.join(os.tmpdir(), "miku-scm-skills-checksum-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const zip = path.join(root, "bundle.zip");
  writeFileSync(zip, "fixture archive bytes\n");
  const first = await writeSha256(zip);
  assert.match(first.digest, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(first.sidecar, "utf8"), `${first.digest}  bundle.zip\n`);
  await assert.rejects(writeSha256(zip), /EEXIST/);
});
