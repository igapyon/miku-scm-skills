#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function writeSha256(file) {
  const absolute = path.resolve(file);
  const digest = createHash("sha256").update(await readFile(absolute)).digest("hex");
  const sidecar = `${absolute}.sha256`;
  await writeFile(sidecar, `${digest}  ${path.basename(absolute)}\n`, { encoding: "utf8", flag: "wx" });
  return { digest, sidecar };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeSha256(process.argv[2]).then(({ digest, sidecar }) => {
    process.stdout.write(`${digest}  ${path.basename(sidecar, ".sha256")}\n`);
  }).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
