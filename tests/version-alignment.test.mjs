import assert from "node:assert/strict";
import test from "node:test";
import { assertVersionAlignment } from "../scripts/validate-version-alignment.mjs";

const packageText = JSON.stringify({ name: "miku-scm-skills", version: "1.20261112.4" });
const mikuScmText = 'export const PRODUCT_VERSION = "1.20261112.4";\n';
const githubWriterText = 'export const PRODUCT_VERSION = "1.20261112.4";\n';

test("both installed Skill runners align to the independent package version", () => {
  assert.deepEqual(assertVersionAlignment({ packageText, mikuScmText, githubWriterText }), {
    packageVersion: "1.20261112.4",
    mikuScmVersion: "1.20261112.4",
    githubWriterVersion: "1.20261112.4",
  });
});

test("version mismatch in either Skill is rejected", () => {
  assert.throws(() => assertVersionAlignment({ packageText, mikuScmText: mikuScmText.replace(".4", ".3"), githubWriterText }), /Version mismatch/);
  assert.throws(() => assertVersionAlignment({ packageText, mikuScmText, githubWriterText: githubWriterText.replace(".4", ".3") }), /Version mismatch/);
});

test("malformed package data or multiple version declarations are rejected", () => {
  assert.throws(() => assertVersionAlignment({ packageText: "{", mikuScmText, githubWriterText }), /Invalid package.json/);
  assert.throws(() => assertVersionAlignment({ packageText: JSON.stringify({ version: "0.0.1" }), mikuScmText, githubWriterText }), /Invalid package.json version/);
  assert.throws(() => assertVersionAlignment({ packageText, mikuScmText: `${mikuScmText}${mikuScmText}`, githubWriterText }), /Expected one PRODUCT_VERSION/);
});
