#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function validateReleaseTag(tag, packageVersion) {
  if (!/^1\.\d{8}\.[1-9]\d*$/.test(packageVersion)) throw new Error(`Invalid package version: ${packageVersion}`);
  if (tag !== `v${packageVersion}`) throw new Error(`Release tag ${tag} must equal v${packageVersion}`);
  return packageVersion;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !argv[0]) throw new Error("Usage: validate-release-tag.mjs <tag>");
  const packageInfo = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
  process.stdout.write(`${validateReleaseTag(argv[0], packageInfo.version)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
