#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";
import {
  addOperation,
  checkOperation,
  initOperation,
  routeOperation,
  routeFileOperation,
  scanOperation,
} from "./operations.js";

const HELP = `skill-router

Usage:
  skill-router init [--global|--project] [--harness opencode|all]
  skill-router add <skill-id|path> [--source <path>] [options]
  skill-router scan [--json] [--dry-run]
  skill-router route <request> [--json]
  skill-router route --request-token <32-hex-token> [--json]
  skill-router check [--json]

Common options:
  --root <path>          Project directory (default: current directory)
  --config <path>        Router configuration path
  --global               Use global scope
  --project              Use project scope (default)
  --dry-run              Show changes without writing
  --json                 Emit JSON

Secure agent routing:
  --request-token <token> Consume the matching router-owned request file instead
                          of placing untrusted request text in a shell command

Add options:
  --replace              Select this definition for a duplicate ID
  --alias <phrase>       Add a routing alias (repeatable)
  --description <text>   Override the routing description
  --no-enable            Register but disable routing
  --yes                   Confirm adding every skill in a source directory
`;

const BOOLEAN_OPTIONS = new Set([
  "global",
  "project",
  "dry-run",
  "json",
  "replace",
  "no-enable",
  "yes",
  "all",
]);
const VALUE_OPTIONS = new Set(["root", "config", "harness", "source", "alias", "description", "request-token"]);

function parseArguments(argv) {
  const positionals = [];
  const options = { aliases: [], seen: new Set() };
  let positionalOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && argument.startsWith("--")) {
      const key = argument.slice(2);
      options.seen.add(key);
      if (BOOLEAN_OPTIONS.has(key)) {
        options[key.replaceAll("-", "")] = true;
      } else if (VALUE_OPTIONS.has(key)) {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) throw new Error(`--${key} requires a value`);
        index += 1;
        if (key === "alias") options.aliases.push(value);
        else options[key.replaceAll("-", "")] = value;
      } else {
        throw new Error(`Unknown option: ${argument}`);
      }
    } else {
      positionals.push(argument);
    }
  }
  if (options.global && options.project) throw new Error("Choose either --global or --project");
  options.dryRun = options.dryrun === true;
  options.noEnable = options.noenable === true;
  if (options.all) options.harness = "all";
  return { positionals, options };
}

function validateCommand(command, positionals, options) {
  const common = new Set(["root", "config", "global", "project", "json"]);
  const allowed = {
    init: new Set([...common, "dry-run", "harness", "all"]),
    add: new Set([...common, "dry-run", "source", "replace", "alias", "description", "no-enable", "yes"]),
    scan: new Set([...common, "dry-run"]),
    route: new Set([...common, "request-token"]),
    check: common,
  }[command];
  if (!allowed) return;
  for (const key of options.seen) {
    if (!allowed.has(key)) throw new Error(`--${key} is not valid for ${command}`);
  }
  if (["init", "scan", "check"].includes(command) && positionals.length) {
    throw new Error(`${command} does not accept positional arguments`);
  }
  if (command === "add" && positionals.length !== 1) throw new Error("add requires exactly one skill ID or path");
}

function print(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (result.command === "route") {
    process.stdout.write(
      result.outcome === "select"
        ? `select ${result.skillId} (${result.reason})\n`
        : `${result.outcome}: ${result.reason}\n`,
    );
    return;
  }
  if (result.command === "check") {
    process.stdout.write(result.healthy ? "Skill Router is healthy\n" : "Skill Router has errors\n");
    for (const item of result.diagnostics) process.stdout.write(`${item.level}: ${item.message}\n`);
    return;
  }
  if (result.command === "scan") {
    process.stdout.write(`scan${result.dryRun ? " dry-run" : ""}: ${result.skillCount} skills\n`);
    for (const key of ["added", "removed", "changed"]) {
      if (result.diff[key].length) process.stdout.write(`${key}: ${result.diff[key].join(", ")}\n`);
    }
    for (const item of result.diagnostics) process.stdout.write(`${item.level}: ${item.message}\n`);
    if (result.manualAction) process.stdout.write(`manual action: ${result.manualAction}\n`);
    return;
  }
  process.stdout.write(
    `${result.command}${result.dryRun ? " dry-run" : ""}: ${result.skillCount ?? 0} skills (${result.fingerprint})\n`,
  );
  if (result.added) process.stdout.write(`added: ${result.added.join(", ")}\n`);
  for (const item of result.diagnostics ?? []) process.stdout.write(`${item.level}: ${item.message}\n`);
  if (result.manualAction) process.stdout.write(`manual action: ${result.manualAction}\n`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (command === "--version" || command === "-v") {
    const packageFile = new URL("../package.json", import.meta.url);
    process.stdout.write(`${JSON.parse(await readFile(packageFile, "utf8")).version}\n`);
    return;
  }

  const { positionals, options } = parseArguments(rest);
  validateCommand(command, positionals, options);
  let result;
  if (command === "init") result = await initOperation(options);
  else if (command === "scan") result = await scanOperation(options);
  else if (command === "check") result = await checkOperation(options);
  else if (command === "route") {
    if (options.requesttoken && positionals.length) throw new Error("route accepts a request or --request-token, not both");
    result = options.requesttoken
      ? await routeFileOperation(options.requesttoken, options)
      : await routeOperation(positionals.join(" "), options);
  }
  else if (command === "add") result = await addOperation(positionals[0], options);
  else throw new Error(`Unknown command: ${command}`);
  print(result, options.json);
  if (command === "check" && !result.healthy) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`skill-router: ${error.message}\n`);
  process.exitCode = 1;
});
