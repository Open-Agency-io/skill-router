#!/usr/bin/env node

import process from "node:process";
import { readFile } from "node:fs/promises";

const HELP = `skill-router

Usage: skill-router <command> [options]

Commands planned for the MVP:
  init    Discover skills and initialize a harness
  add     Add an installed skill or local skill source
  scan    Refresh and inspect skill discovery
  route   Select the relevant skill for a request
  check   Diagnose the router installation

Options:
  --help     Show this help
  --version  Show the package version
`;

async function main() {
  const argument = process.argv[2];
  if (!argument || argument === "--help" || argument === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (argument === "--version" || argument === "-v") {
    const packageFile = new URL("../package.json", import.meta.url);
    process.stdout.write(`${JSON.parse(await readFile(packageFile, "utf8")).version}\n`);
    return;
  }
  throw new Error(`Command not implemented yet: ${argument}`);
}

main().catch((error) => {
  process.stderr.write(`skill-router: ${error.message}\n`);
  process.exitCode = 1;
});
