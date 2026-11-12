import assert from "node:assert/strict";
import test from "node:test";
import { assertVersionAlignment } from "../scripts/validate-version-alignment.mjs";

const packageText = JSON.stringify({ name: "miku-scm-skills", version: "0.8.2" });
const packageLockText = JSON.stringify({ version: "0.8.2", packages: { "": { version: "0.8.2" } } });
const mikuScmText = 'export const PRODUCT_VERSION = "0.8.2";\n';
const githubWriterText = 'export const PRODUCT_VERSION = "0.8.2";\n';

test("both installed Skill runners align to the independent package version", () => {
  assert.deepEqual(assertVersionAlignment({ packageText, mikuScmText, githubWriterText }), {
    packageVersion: "0.8.2",
    mikuScmVersion: "0.8.2",
    githubWriterVersion: "0.8.2",
  });
  assert.deepEqual(assertVersionAlignment({ packageText, packageLockText, mikuScmText, githubWriterText }), {
    packageVersion: "0.8.2",
    packageLockVersion: "0.8.2",
    packageLockRootVersion: "0.8.2",
    mikuScmVersion: "0.8.2",
    githubWriterVersion: "0.8.2",
  });
});

test("package lock root and top-level versions must align with package.json", () => {
  assert.throws(() => assertVersionAlignment({
    packageText,
    packageLockText: JSON.stringify({ version: "0.8.1", packages: { "": { version: "0.8.2" } } }),
    mikuScmText,
    githubWriterText,
  }), /package-lock\.json/);
  assert.throws(() => assertVersionAlignment({
    packageText,
    packageLockText: JSON.stringify({ version: "0.8.2", packages: { "": { version: "0.8.1" } } }),
    mikuScmText,
    githubWriterText,
  }), /package-lock\.json root/);
});

test("version mismatch in either Skill is rejected", () => {
  assert.throws(() => assertVersionAlignment({ packageText, mikuScmText: mikuScmText.replace("0.8.2", "0.8.3"), githubWriterText }), /Version mismatch/);
  assert.throws(() => assertVersionAlignment({ packageText, mikuScmText, githubWriterText: githubWriterText.replace("0.8.2", "0.8.3") }), /Version mismatch/);
});

test("malformed package data or multiple version declarations are rejected", () => {
  assert.throws(() => assertVersionAlignment({ packageText: "{", mikuScmText, githubWriterText }), /Invalid package.json/);
  assert.throws(() => assertVersionAlignment({ packageText: JSON.stringify({ version: "00.8.0" }), mikuScmText, githubWriterText }), /Invalid package.json version/);
  assert.throws(() => assertVersionAlignment({ packageText, mikuScmText: `${mikuScmText}${mikuScmText}`, githubWriterText }), /Expected one PRODUCT_VERSION/);
});
