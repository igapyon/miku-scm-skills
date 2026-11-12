#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skills = Object.freeze({
  "igapyon-miku-scm": Object.freeze({
    runner: "skills/igapyon-miku-scm/scripts/miku-scm-run.mjs",
    workflow: "repository.status",
  }),
  "igapyon-github-writer": Object.freeze({
    runner: "skills/igapyon-github-writer/scripts/github-writer-run.mjs",
    workflow: "branch.status",
  }),
});

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || "no process output";
    throw new Error(command + " " + (args[0] ?? "") + " failed"
      + (result.status === null ? "" : " (exit " + result.status + ")") + ": " + detail);
  }
  return result.stdout;
}

function createGitFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "miku-scm-runtime-smoke-"));
  try {
    const globalConfig = path.join(directory, "empty-gitconfig");
    writeFileSync(globalConfig, "", "utf8");
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_NOSYSTEM: "1",
    };
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) {
      delete env[key];
    }

    run("git", ["init", "-b", "main"], directory, env);
    run("git", ["config", "user.name", "miku-scm runtime smoke"], directory, env);
    run("git", ["config", "user.email", "miku-scm-runtime-smoke@example.invalid"], directory, env);
    run("git", ["config", "commit.gpgsign", "false"], directory, env);
    writeFileSync(path.join(directory, "README.md"), "isolated runtime smoke\n", "utf8");
    run("git", ["add", "README.md"], directory, env);
    run("git", ["commit", "-m", "Initialize isolated runtime smoke fixture"], directory, env);
    return { directory, env };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    throw error;
  }
}

export function runRuntimeSmoke(skillName, repoRoot = root) {
  const definition = skills[skillName];
  if (!definition) {
    throw new Error("Unsupported Skill: " + skillName + ". Expected one of: " + Object.keys(skills).join(", "));
  }

  const packageInfo = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const runner = path.join(repoRoot, definition.runner);
  const version = run(process.execPath, [runner, "--version"], repoRoot).trim();
  assert.equal(version, packageInfo.version, skillName + " --version must match package.json");
  assert.ok(run(process.execPath, [runner, "--help"], repoRoot).trim(), skillName + " --help must produce output");

  const fixture = createGitFixture();
  try {
    const output = run(process.execPath, [
      runner,
      "--format",
      "json",
      definition.workflow,
      "--repo",
      fixture.directory,
    ], fixture.directory, fixture.env);
    const result = JSON.parse(output);
    assert.equal(result.status, "success", skillName + " " + definition.workflow + ": " + (result.error?.message ?? ""));
    assert.equal(result.mutation_invoked, false, skillName + " " + definition.workflow + " must be read-only");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }

  process.stdout.write(skillName + " runtime smoke passed on Node " + process.versions.node + ".\n");
  return { skillName, version, workflow: definition.workflow };
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !argv[0]) {
    throw new Error("Usage: node scripts/runtime-smoke.mjs <" + Object.keys(skills).join("|") + ">");
  }
  runRuntimeSmoke(argv[0]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
