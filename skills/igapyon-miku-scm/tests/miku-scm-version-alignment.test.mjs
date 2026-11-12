import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertVersionAlignment, validateVersionAlignment } from "../../../scripts/validate-version-alignment.mjs";

const testPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(testPath), "../../..");
const packageText = await readFile(path.join(repositoryRoot, "package.json"), "utf8");
const version = JSON.parse(packageText).version;
const aligned = {
  packageText,
  mikuScmText: `export const PRODUCT_VERSION = "${version}";\n`,
  githubWriterText: `export const PRODUCT_VERSION = "${version}";\n`,
};

test("standalone package version validation aligns both installed Skill runners", () => {
  assert.deepEqual(assertVersionAlignment(aligned), {
    packageVersion: version,
    mikuScmVersion: version,
    githubWriterVersion: version,
  });
});

test("version validation rejects a stale miku-scm runner version", () => {
  assert.throws(
    () => assertVersionAlignment({
      ...aligned,
      mikuScmText: 'export const PRODUCT_VERSION = "1.20260812.9";\n',
    }),
    /Version mismatch/,
  );
});

test("version validation rejects a stale github-writer runner version", () => {
  assert.throws(
    () => assertVersionAlignment({
      ...aligned,
      githubWriterText: 'export const PRODUCT_VERSION = "1.20260812.9";\n',
    }),
    /Version mismatch/,
  );
});

test("version validation reads the package and both Skill sources from --repo", async () => {
  const root = "/synthetic/repository";
  const texts = new Map([
    [`${root}/package.json`, packageText],
    [`${root}/package-lock.json`, JSON.stringify({ version, packages: { "": { version } } })],
    [`${root}/skills/igapyon-miku-scm/scripts/miku-scm-run.mjs`, `export const PRODUCT_VERSION = "${version}";\n`],
    [`${root}/skills/igapyon-github-writer/scripts/github-writer-workflow-manifest.mjs`, `export const PRODUCT_VERSION = "${version}";\n`],
  ]);
  const reads = [];
  const result = await validateVersionAlignment(["--repo", root], async (file) => {
    reads.push(file);
    return texts.get(file);
  });
  assert.equal(reads.length, 4);
  assert.equal(result.packageVersion, version);
  assert.equal(result.packageLockVersion, version);
  assert.equal(result.packageLockRootVersion, version);
  assert.equal(result.githubWriterVersion, version);
});
