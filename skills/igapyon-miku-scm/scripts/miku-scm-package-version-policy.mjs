const CONFIG = Object.freeze({
  policy: "semver",
  source: "package.json",
  tagPrefix: "v",
  check: "check:version",
});

const VERSION_CHECK_SCRIPT = "node scripts/validate-version-alignment.mjs --repo .";
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error.message}`);
  }
}

export function compareStableSemver(left, right) {
  const leftParts = String(left).match(STABLE_SEMVER);
  const rightParts = String(right).match(STABLE_SEMVER);
  if (!leftParts || !rightParts) throw new Error("Stable SemVer comparison requires MAJOR.MINOR.PATCH values");
  for (let index = 1; index <= 3; index += 1) {
    const a = BigInt(leftParts[index]);
    const b = BigInt(rightParts[index]);
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

export function parsePackageVersionPolicy(packageText) {
  const metadata = parseJson(packageText, "package.json");
  const declaration = metadata?.mikuScm?.version;
  if (declaration === undefined) return { configured: false };
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) {
    throw new Error("package.json mikuScm.version must be an object");
  }
  const keys = Object.keys(declaration).sort();
  const expectedKeys = Object.keys(CONFIG).sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)
    || Object.entries(CONFIG).some(([key, value]) => declaration[key] !== value)) {
    throw new Error("package.json mikuScm.version must declare policy=semver, source=package.json, tagPrefix=v, and check=check:version");
  }
  const version = metadata.version;
  if (typeof version !== "string" || !STABLE_SEMVER.test(version)) {
    throw new Error(`Invalid package.json version for mikuScm semver policy: ${version ?? "missing"}`);
  }
  if (metadata?.scripts?.[CONFIG.check] !== VERSION_CHECK_SCRIPT) {
    throw new Error(`package.json scripts.${CONFIG.check} must be exactly: ${VERSION_CHECK_SCRIPT}`);
  }
  return {
    configured: true,
    policy: CONFIG.policy,
    source: CONFIG.source,
    version,
    tagPrefix: CONFIG.tagPrefix,
    recommendedTag: `${CONFIG.tagPrefix}${version}`,
    check: { command: "npm", args: ["run", CONFIG.check], label: `npm run ${CONFIG.check}` },
  };
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
  }
  return value;
}

function withoutPackageVersion(text) {
  const value = parseJson(text, "package.json");
  if (typeof value.version !== "string" || !STABLE_SEMVER.test(value.version)) return null;
  delete value.version;
  return JSON.stringify(sortObject(value));
}

function withoutLockVersions(text) {
  const value = parseJson(text, "package-lock.json");
  if (!value.packages || typeof value.packages !== "object" || !value.packages[""]
    || typeof value.version !== "string" || !STABLE_SEMVER.test(value.version)
    || typeof value.packages[""].version !== "string" || !STABLE_SEMVER.test(value.packages[""].version)) {
    return null;
  }
  delete value.version;
  delete value.packages[""].version;
  return JSON.stringify(sortObject(value));
}

export function isPackageVersionOnlyChange({ paths, beforePackage, afterPackage, beforeLock, afterLock, version }) {
  const changed = [...new Set(paths)].sort();
  if (changed.length < 1 || changed.some((file) => !["package.json", "package-lock.json"].includes(file))) return false;
  if (!changed.includes("package.json")) return false;
  try {
    const beforePackageValue = parseJson(beforePackage, "HEAD:package.json");
    const afterPackageValue = parseJson(afterPackage, "package.json");
    if (compareStableSemver(afterPackageValue.version, beforePackageValue.version) <= 0
      || afterPackageValue.version !== version
      || withoutPackageVersion(beforePackage) !== withoutPackageVersion(afterPackage)) return false;
    if (changed.includes("package-lock.json")) {
      const beforeLockValue = parseJson(beforeLock, "HEAD:package-lock.json");
      const afterLockValue = parseJson(afterLock, "package-lock.json");
      if (beforeLockValue.version !== beforePackageValue.version
        || beforeLockValue.packages?.[""]?.version !== beforePackageValue.version
        || afterLockValue.version !== afterPackageValue.version
        || afterLockValue.packages?.[""]?.version !== afterPackageValue.version
        || withoutLockVersions(beforeLock) !== withoutLockVersions(afterLock)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
