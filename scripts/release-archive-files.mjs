import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const omittedNames = new Set([".DS_Store", ".git", "node_modules"]);
const omittedSkillRootDirs = new Set(["tmp", "output", "state"]);

export function collectReleaseFiles(root, { skillRoot = false } = {}) {
  const files = new Map();
  function visit(directory, relativeDirectory = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (omittedNames.has(entry.name)) continue;
      if (skillRoot && !relativeDirectory && omittedSkillRootDirs.has(entry.name)) continue;
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`${relative}: symbolic links are not release files`);
      if (stat.isDirectory()) visit(absolute, relative);
      else if (stat.isFile()) {
        const content = readFileSync(absolute);
        files.set(relative, { size: content.length, sha256: createHash("sha256").update(content).digest("hex") });
      } else throw new Error(`${relative}: not a regular file or directory`);
    }
  }
  visit(root);
  return files;
}

export function assertFileMapsEqual(expected, actual, label) {
  const expectedPaths = new Set(expected.keys());
  const actualPaths = new Set(actual.keys());
  const missing = [...expectedPaths].filter((relative) => !actualPaths.has(relative)).sort();
  const unexpected = [...actualPaths].filter((relative) => !expectedPaths.has(relative)).sort();
  const changed = [...expectedPaths].filter((relative) => actualPaths.has(relative)
    && (expected.get(relative).size !== actual.get(relative).size || expected.get(relative).sha256 !== actual.get(relative).sha256)).sort();
  if (missing.length || unexpected.length || changed.length) {
    const details = [];
    if (missing.length) details.push(`missing: ${missing.join(", ")}`);
    if (unexpected.length) details.push(`unexpected: ${unexpected.join(", ")}`);
    if (changed.length) details.push(`changed: ${changed.join(", ")}`);
    throw new Error(`${label}: file set differs\n${details.join("\n")}`);
  }
}
