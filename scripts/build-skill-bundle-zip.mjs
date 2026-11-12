#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildBundle } from "./build-skill-bundle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function buildBundleZip(repoRoot = root, zip = execFileSync) {
  const bundleRoot = buildBundle(repoRoot);
  const version = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
  const zipPath = path.join(repoRoot, "bundle", `igapyon-miku-scm-skills-${version}.zip`);
  rmSync(zipPath, { force: true });
  zip("zip", ["-qr", zipPath, "."], { cwd: bundleRoot, stdio: "inherit" });
  process.stdout.write(`Built ${path.relative(repoRoot, zipPath)}\n`);
  return zipPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { buildBundleZip(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
