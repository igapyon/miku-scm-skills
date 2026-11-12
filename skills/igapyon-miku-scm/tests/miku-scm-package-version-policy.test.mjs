import assert from "node:assert/strict";
import test from "node:test";

import {
  compareStableSemver,
  isPackageVersionOnlyChange,
  parsePackageVersionPolicy,
} from "../scripts/miku-scm-package-version-policy.mjs";

function packageText(version, extras = {}) {
  return JSON.stringify({
    name: "fixture",
    version,
    scripts: { "check:version": "node scripts/validate-version-alignment.mjs --repo ." },
    mikuScm: { version: { policy: "semver", source: "package.json", tagPrefix: "v", check: "check:version" } },
    ...extras,
  }, null, 2);
}

function lockText(version, extras = {}) {
  return JSON.stringify({
    name: "fixture",
    version,
    lockfileVersion: 3,
    packages: { "": { name: "fixture", version }, ...extras },
  }, null, 2);
}

test("explicit package policy resolves SemVer source, tag and fixed check", () => {
  assert.deepEqual(parsePackageVersionPolicy(packageText("0.8.2")), {
    configured: true,
    policy: "semver",
    source: "package.json",
    version: "0.8.2",
    tagPrefix: "v",
    recommendedTag: "v0.8.2",
    check: { command: "npm", args: ["run", "check:version"], label: "npm run check:version" },
  });
});

test("repositories without the opt-in declaration keep the legacy route", () => {
  assert.deepEqual(parsePackageVersionPolicy(JSON.stringify({ name: "other", version: "1.2.3" })), { configured: false });
});

test("invalid policy, unsupported fields, malformed SemVer and changed check script are rejected", () => {
  const valid = JSON.parse(packageText("0.8.2"));
  valid.mikuScm.version.policy = "auto";
  assert.throws(() => parsePackageVersionPolicy(JSON.stringify(valid)), /must declare/);
  const extra = JSON.parse(packageText("0.8.2"));
  extra.mikuScm.version.command = "sh -c arbitrary";
  assert.throws(() => parsePackageVersionPolicy(JSON.stringify(extra)), /must declare/);
  assert.throws(() => parsePackageVersionPolicy(packageText("0.8.2-beta")), /Invalid package.json version/);
  const script = JSON.parse(packageText("0.8.2"));
  script.scripts["check:version"] = "node arbitrary.mjs";
  assert.throws(() => parsePackageVersionPolicy(JSON.stringify(script)), /must be exactly/);
  assert.throws(() => parsePackageVersionPolicy("{"), /Invalid package.json/);
});

test("stable SemVer comparison uses numeric components without precision loss", () => {
  assert.equal(compareStableSemver("0.8.10", "0.8.9"), 1);
  assert.equal(compareStableSemver("1.0.0", "2.0.0"), -1);
  assert.equal(compareStableSemver("0.8.2", "0.8.2"), 0);
  assert.equal(compareStableSemver("9007199254740993.0.0", "9007199254740992.0.0"), 1);
});

test("version-only classification allows only package version fields to change", () => {
  assert.equal(isPackageVersionOnlyChange({
    paths: ["package.json", "package-lock.json"],
    beforePackage: packageText("0.8.1"),
    afterPackage: packageText("0.8.2"),
    beforeLock: lockText("0.8.1"),
    afterLock: lockText("0.8.2"),
    version: "0.8.2",
  }), true);
  const changedScript = JSON.parse(packageText("0.8.2"));
  changedScript.scripts.build = "node build.mjs";
  assert.equal(isPackageVersionOnlyChange({
    paths: ["package.json"],
    beforePackage: packageText("0.8.1"),
    afterPackage: JSON.stringify(changedScript),
    version: "0.8.2",
  }), false);
  const changedDependency = JSON.parse(lockText("0.8.2", { "node_modules/example": { version: "2.0.0" } }));
  assert.equal(isPackageVersionOnlyChange({
    paths: ["package.json", "package-lock.json"],
    beforePackage: packageText("0.8.1"),
    afterPackage: packageText("0.8.2"),
    beforeLock: lockText("0.8.1"),
    afterLock: JSON.stringify(changedDependency),
    version: "0.8.2",
  }), false);
  assert.equal(isPackageVersionOnlyChange({
    paths: ["package.json", "tests/version.test.mjs"],
    beforePackage: packageText("0.8.1"),
    afterPackage: packageText("0.8.2"),
    version: "0.8.2",
  }), false);
});
