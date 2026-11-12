#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function productVersion(text, label) {
  const matches = [...String(text).matchAll(/^export const PRODUCT_VERSION = "([^"\r\n]+)";[\t ]*\r?$/gm)];
  if (matches.length !== 1) throw new Error(`Expected one PRODUCT_VERSION in ${label}`);
  return matches[0][1];
}

function validateVersion(value, label) {
  const isMikuDateVersion = typeof value === "string" && /^1\.\d{8}\.[1-9]\d*$/.test(value);
  const isStableSemver = typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
  if (!isMikuDateVersion && !isStableSemver) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return value;
}

export function assertVersionAlignment({ packageText, mikuScmText, githubWriterText }) {
  let metadata;
  try {
    metadata = JSON.parse(packageText);
  } catch (error) {
    throw new Error(`Invalid package.json: ${error.message}`);
  }
  const packageVersion = validateVersion(metadata?.version, "package.json version");
  const mikuScmVersion = validateVersion(productVersion(mikuScmText, "miku-scm runner"), "miku-scm PRODUCT_VERSION");
  const githubWriterVersion = validateVersion(productVersion(githubWriterText, "github-writer manifest"), "github-writer PRODUCT_VERSION");
  for (const [label, value] of [["miku-scm", mikuScmVersion], ["github-writer", githubWriterVersion]]) {
    if (value !== packageVersion) {
      throw new Error(`Version mismatch:\n  package.json:       ${packageVersion}\n  ${label}: ${value}`);
    }
  }
  return { packageVersion, mikuScmVersion, githubWriterVersion };
}

export async function validateVersionAlignment(argv, read = readFile) {
  let files;
  if (argv.length === 2 && argv[0] === "--repo" && argv[1]) {
    const root = path.resolve(argv[1]);
    files = [
      path.join(root, "package.json"),
      path.join(root, "skills/igapyon-miku-scm/scripts/miku-scm-run.mjs"),
      path.join(root, "skills/igapyon-github-writer/scripts/github-writer-workflow-manifest.mjs"),
    ];
  } else if (argv.length === 3 && argv.every(Boolean)) {
    files = argv.map((file) => path.resolve(file));
  } else {
    throw new Error("Usage: validate-version-alignment.mjs --repo <repository-root> | <package.json> <miku-scm-run.mjs> <github-writer-workflow-manifest.mjs>");
  }
  const [packageText, mikuScmText, githubWriterText] = await Promise.all(files.map((file) => read(file, "utf8")));
  return assertVersionAlignment({ packageText, mikuScmText, githubWriterText });
}

async function main(argv = process.argv.slice(2)) {
  const result = await validateVersionAlignment(argv);
  console.log(`Version alignment OK: ${result.packageVersion} / miku-scm ${result.mikuScmVersion} / github-writer ${result.githubWriterVersion}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
