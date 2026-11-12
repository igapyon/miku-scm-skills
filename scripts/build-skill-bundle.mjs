#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectReleaseFiles } from "./release-archive-files.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillNames = Object.freeze(["igapyon-miku-scm", "igapyon-github-writer"]);

function shouldCopy(source, skillRoot) {
  const name = path.basename(source);
  if (name === ".DS_Store" || name === ".git" || name === "node_modules") return false;
  const relative = path.relative(skillRoot, source);
  return !["tmp", "output", "state"].includes(name) || relative.split(path.sep).length > 1;
}

export function buildBundle(repoRoot = root) {
  const packageInfo = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  if (!/^[A-Za-z0-9.-]+$/.test(packageInfo.version)) throw new Error("Invalid package version");
  const bundleRoot = path.join(repoRoot, "bundle", "miku-scm-skills");
  rmSync(bundleRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  mkdirSync(path.join(bundleRoot, "skills"), { recursive: true });
  for (const file of ["README.md", "INSTALL.md", "LICENSE"]) {
    cpSync(path.join(repoRoot, file), path.join(bundleRoot, file));
  }
  for (const name of skillNames) {
    const source = path.join(repoRoot, "skills", name);
    if (!existsSync(path.join(source, "SKILL.md"))) throw new Error(`Missing required Skill directory or SKILL.md: ${name}`);
    const files = collectReleaseFiles(source, { skillRoot: true });
    if (!files.has("SKILL.md")) throw new Error(`missing required Skill entry point: ${name}/SKILL.md`);
    const text = readFileSync(path.join(source, "SKILL.md"), "utf8");
    const frontmatterName = text.split(/\r?\n/).slice(0, 8).find((line) => line.startsWith("name:"))?.slice("name:".length).trim();
    if (frontmatterName !== name) {
      throw new Error(`Skill frontmatter name does not match directory: ${name}`);
    }
    cpSync(source, path.join(bundleRoot, "skills", name), {
      recursive: true,
      filter: (entry) => shouldCopy(entry, source),
    });
  }
  process.stdout.write(`Built bundle/miku-scm-skills with ${skillNames.length} Skills.\n`);
  return bundleRoot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { buildBundle(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
