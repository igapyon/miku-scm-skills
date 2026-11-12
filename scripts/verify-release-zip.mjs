#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertFileMapsEqual, collectReleaseFiles } from "./release-archive-files.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillNames = Object.freeze(["igapyon-miku-scm", "igapyon-github-writer"]);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false, windowsHide: true, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed${result.error ? `: ${result.error.message}` : ` (${result.status})`}: ${result.stderr || result.stdout}`);
  }
  return result.stdout || "";
}

function shaPath(expected, relative) {
  const bytes = readFileSync(path.join(expected, relative));
  return { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function expectedArchiveFiles(repoRoot) {
  const expected = new Map();
  for (const name of ["README.md", "INSTALL.md", "LICENSE"]) expected.set(name, shaPath(repoRoot, name));
  for (const skill of skillNames) {
    const files = collectReleaseFiles(path.join(repoRoot, "skills", skill), { skillRoot: true });
    for (const [relative, metadata] of files) expected.set(`skills/${skill}/${relative}`, metadata);
  }
  return expected;
}

function initializeFixtureRepository(directory) {
  run("git", ["init", "-b", "main"], { cwd: directory });
  run("git", ["config", "user.name", "miku-scm-skills ZIP smoke"] , { cwd: directory });
  run("git", ["config", "user.email", "miku-scm-skills@example.invalid"], { cwd: directory });
  writeFileSync(path.join(directory, "README.md"), "# isolated ZIP smoke\n", "utf8");
  run("git", ["add", "README.md"], { cwd: directory });
  run("git", ["commit", "-m", "Initial fixture"], { cwd: directory });
}

function verifyInstalledSkills(extractedRoot, packageVersion) {
  for (const skill of skillNames) {
    const skillRoot = path.join(extractedRoot, "skills", skill);
    const skillText = readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
    const declared = skillText.split(/\r?\n/).slice(0, 8).find((line) => line.startsWith("name:"))?.slice("name:".length).trim();
    assert.equal(declared, skill, `${skill} frontmatter name`);
  }

  const scripts = [
    ["skills/igapyon-miku-scm/scripts/miku-scm-run.mjs", ["--version"]],
    ["skills/igapyon-miku-scm/scripts/miku-scm-run.mjs", ["--help"]],
    ["skills/igapyon-github-writer/scripts/github-writer-run.mjs", ["--version"]],
    ["skills/igapyon-github-writer/scripts/github-writer-run.mjs", ["--help"]],
  ];
  for (const [script, args] of scripts) {
    const output = run(process.execPath, [path.join(extractedRoot, script), ...args], { cwd: extractedRoot });
    if (args[0] === "--version") assert.equal(output.trim(), packageVersion, `${script} version`);
    else assert.ok(output.trim().length > 0, `${script} help`);
  }

  const repository = mkdtempSync(path.join(os.tmpdir(), "miku-scm-skills-repository-"));
  try {
    initializeFixtureRepository(repository);
    const workflows = [
      ["skills/igapyon-miku-scm/scripts/miku-scm-run.mjs", "repository.status"],
      ["skills/igapyon-github-writer/scripts/github-writer-run.mjs", "branch.status"],
    ];
    for (const [script, workflow] of workflows) {
      const output = run(process.execPath, [path.join(extractedRoot, script), "--format", "json", workflow, "--repo", repository], { cwd: extractedRoot });
      const result = JSON.parse(output);
      assert.equal(result.status, "success", `${workflow} status: ${result.error?.message ?? ""}`);
      assert.equal(result.mutation_invoked, false, `${workflow} must be read-only`);
    }
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }

  for (const [skill, script] of [
    ["igapyon-miku-scm", "miku-scm-workflow-contracts.mjs"],
    ["igapyon-github-writer", "github-writer-workflow-contracts.mjs"],
  ]) {
    run(process.execPath, [path.join(extractedRoot, "skills", skill, "scripts", script), "--check"], { cwd: extractedRoot });
  }
}

export function verifyReleaseZip(zipPath, repoRoot = root) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "miku-scm-skills-release-zip-"));
  try {
    const archive = path.resolve(zipPath);
    const listing = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" });
    const entries = listing.split(/\r?\n/).map((entry) => entry.replace(/^\.\//, "")).filter(Boolean);
    assert.equal(new Set(entries).size, entries.length, "ZIP contains duplicate entries");
    run("unzip", ["-q", archive, "-d", tempRoot]);
    const expected = expectedArchiveFiles(repoRoot);
    const actual = collectReleaseFiles(tempRoot);
    assertFileMapsEqual(expected, actual, "release ZIP");
    const topSkills = entries.filter((entry) => /^skills\/[^/]+\/SKILL\.md$/.test(entry)).map((entry) => entry.split("/")[1]).sort();
    assert.deepEqual(topSkills, [...skillNames].sort(), "ZIP must contain exactly the two installable Skills");
    const packageVersion = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
    verifyInstalledSkills(tempRoot, packageVersion);
    process.stdout.write(`Verified ${path.basename(archive)}: ${skillNames.length} Skills, ${actual.size} files.\n`);
    return { skillCount: skillNames.length, fileCount: actual.size };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node scripts/verify-release-zip.mjs <zip-path>");
    verifyReleaseZip(process.argv[2]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
