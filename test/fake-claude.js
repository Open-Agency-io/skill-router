/*
 * Shared fake Claude Code CLI for tests.
 *
 * One state machine backs both entry points:
 *   - `createFakeClaudeRunner()` returns an in-process executor with the same
 *     signature as `execClaude` (argv + `{ cwd, env, timeout }`), so unit tests
 *     never spawn a process.
 *   - `writeFakeClaudeBin()` writes an executable `.mjs` script that imports
 *     this module, so CLI-level tests can point `SKILL_ROUTER_CLAUDE_BIN` at it.
 *
 * The fake implements exactly the command vocabulary the adapter uses, reads
 * generated manifests from disk so version/name/path assertions exercise real
 * artifacts, records every call's `cwd`, and — like the real CLI — writes the
 * scope-owned marketplace declaration into the settings file the production
 * adapter reads. `failOn(key, message, { mutate: true })` reproduces a CLI
 * that mutates and then exits non-zero.
 */

import { access, appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeMarketplaceSettingsFile } from "../src/claude.js";

const helperPath = fileURLToPath(import.meta.url);

const FORBIDDEN_PLUGIN_KEYS = [
  "hooks",
  "mcpServers",
  "commands",
  "agents",
  "dependencies",
  "scripts",
  "executable",
];

export function emptyFakeClaudeState() {
  return { marketplaces: [], plugins: [] };
}

function parseScope(argv, fallback) {
  const index = argv.indexOf("--scope");
  return index === -1 ? fallback : argv[index + 1];
}

async function manifest(directory, name) {
  const file = path.join(directory, ".claude-plugin", name);
  const text = await readFile(file, "utf8");
  return { file, document: JSON.parse(text) };
}

async function pluginVersion(pluginRoot) {
  const { document } = await manifest(pluginRoot, "plugin.json");
  for (const key of FORBIDDEN_PLUGIN_KEYS) {
    if (Object.hasOwn(document, key)) {
      throw new Error(`plugin.json declares the inert-forbidden key: ${key}`);
    }
  }
  if (document.name === undefined || document.version === undefined) {
    throw new Error("plugin.json is missing name or version");
  }
  return { name: document.name, version: document.version };
}

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  error.exitCode = 1;
  return error;
}

/**
 * Hard barrier for user-scope fake writes: a fake marketplace add/remove may
 * only ever touch a settings file inside a test temp directory, so an
 * unisolated `HOME` can never make the fake behave like the real CLI against
 * the actual user configuration. The only opt-out is the explicit
 * `SKILL_ROUTER_TEST_ALLOW_REAL_CLAUDE_SETTINGS=1` escape hatch reserved for a
 * dedicated isolated-real test.
 */
export function assertFakeClaudeUserSettingsWritable(file, env = process.env) {
  const resolved = path.resolve(file);
  if (env && env.SKILL_ROUTER_TEST_ALLOW_REAL_CLAUDE_SETTINGS === "1") return resolved;
  const tempRoot = path.resolve(os.tmpdir());
  const insideTemp = resolved === tempRoot || resolved.startsWith(`${tempRoot}${path.sep}`);
  if (!insideTemp) {
    throw failure(
      1,
      `refusing to write user-scope Claude settings outside a temporary directory: ${resolved} ` +
        "(set CLAUDE_CONFIG_DIR or HOME to a test temp directory)",
    );
  }
  return resolved;
}

function referenceArgument(argv) {
  const scopeValueIndex = argv.indexOf("--scope") + 1;
  return argv.slice(2).find((value, index) => !value.startsWith("-") && index + 2 !== scopeValueIndex);
}

/**
 * Marketplace ownership of an installed plugin uses either signal: an explicit
 * `marketplace` field or the `name@marketplace` id suffix. Like the real CLI,
 * removing a marketplace uninstalls every plugin it owns — at any scope —
 * which is exactly the blast radius exact detach must refuse to hit.
 */
export function pluginBelongsToMarketplace(entry, marketplace) {
  const id = typeof entry?.id === "string" ? entry.id : "";
  const at = id.lastIndexOf("@");
  const bySuffix = at > 0 && id.slice(at + 1) === marketplace;
  const byExplicit = typeof entry?.marketplace === "string" && entry.marketplace === marketplace;
  return byExplicit || bySuffix;
}

async function readSettings(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Write the scope-owned declaration exactly like the real CLI does. */
async function declareMarketplace(file, name, directory) {
  const document = (await readSettings(file)) ?? {};
  if (!document.extraKnownMarketplaces || typeof document.extraKnownMarketplaces !== "object") {
    document.extraKnownMarketplaces = {};
  }
  document.extraKnownMarketplaces[name] = { source: { source: "directory", path: directory } };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
}

/** Remove one declaration, leaving every other marketplace untouched. */
async function undeclareMarketplace(file, name) {
  const document = await readSettings(file);
  if (!document?.extraKnownMarketplaces || !Object.hasOwn(document.extraKnownMarketplaces, name)) {
    return false;
  }
  delete document.extraKnownMarketplaces[name];
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
  return true;
}

/**
 * Execute one fake Claude invocation against `state`.
 * Returns `{ stdout, stderr }` or throws an error carrying `exitCode`.
 */
export async function runFakeClaude(state, argv, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const [group, command, ...rest] = argv;
  if (group !== "plugin") throw failure(1, `unknown command: ${argv.join(" ")}`);

  if (command === "validate") {
    const strict = rest.includes("--strict");
    const target = rest.filter((value) => value !== "--strict").at(-1);
    const marketplaceManifest = path.join(target, ".claude-plugin", "marketplace.json");
    try {
      if (await exists(marketplaceManifest)) {
        const { document } = await manifest(target, "marketplace.json");
        if (!document.name || !Array.isArray(document.plugins)) throw new Error("marketplace.json is incomplete");
        for (const entry of document.plugins) {
          if (!entry.name || !entry.source) throw new Error("marketplace entry is incomplete");
          if (String(entry.source).includes("..")) throw new Error(`Path contains "..": ${entry.source}`);
        }
        if (strict && !document.description) throw new Error("No marketplace description provided");
        const source = String(document.plugins[0].source).replace(/^\.\//, "");
        await pluginVersion(path.join(target, source));
      } else {
        await pluginVersion(target);
      }
    } catch (error) {
      throw failure(1, `validation failed: ${error.message}`);
    }
    return { stdout: "✔ Validation passed\n", stderr: "" };
  }

  if (command === "marketplace") {
    if (rest[0] === "list") return { stdout: `${JSON.stringify(state.marketplaces, null, 2)}\n`, stderr: "" };
    if (rest[0] === "add") {
      const scope = parseScope(argv, "user");
      const directory = rest.at(-1);
      if (!scope) throw failure(1, "missing scope");
      const settingsFile = claudeMarketplaceSettingsFile(scope, { cwd, env });
      if (scope === "user") assertFakeClaudeUserSettingsWritable(settingsFile, env);
      const { document } = await manifest(directory, "marketplace.json");
      await declareMarketplace(settingsFile, document.name, directory);
      const existing = state.marketplaces.find((entry) => entry.name === document.name);
      if (existing) existing.path = directory;
      else state.marketplaces.push({ name: document.name, path: directory, scope });
      return { stdout: `✔ Successfully added marketplace: ${document.name}\n`, stderr: "" };
    }
    if (rest[0] === "remove" || rest[0] === "rm") {
      const name = rest[1];
      const scope = parseScope(argv, "user");
      const settingsFile = claudeMarketplaceSettingsFile(scope, { cwd, env });
      if (scope === "user") assertFakeClaudeUserSettingsWritable(settingsFile, env);
      const declared = await undeclareMarketplace(settingsFile, name);
      if (!declared) throw failure(1, `unknown marketplace: ${name}`);
      state.marketplaces = state.marketplaces.filter((entry) => entry.name !== name);
      // Removing a marketplace uninstalls every plugin that belongs to it, so
      // an extra plugin from this marketplace is lost with it.
      state.plugins = state.plugins.filter((entry) => !pluginBelongsToMarketplace(entry, name));
      return { stdout: `✔ Successfully removed marketplace: ${name}\n`, stderr: "" };
    }
    throw failure(1, `unknown marketplace command: ${rest[0]}`);
  }

  if (command === "list") return { stdout: `${JSON.stringify(state.plugins, null, 2)}\n`, stderr: "" };

  if (command === "install" || command === "i") {
    const reference = referenceArgument(argv);
    const scope = parseScope(argv, "user");
    const [pluginName, marketplaceName] = String(reference).split("@");
    const marketplace = state.marketplaces.find((entry) => entry.name === marketplaceName);
    if (!marketplace) throw failure(1, `unknown marketplace: ${marketplaceName}`);
    if (state.plugins.some((entry) => entry.id === reference && entry.scope === scope)) {
      return { stdout: `✔ Plugin "${reference}" is already installed (scope: ${scope})\n`, stderr: "" };
    }
    const { version } = await pluginVersion(path.join(marketplace.path, "plugins", pluginName));
    state.plugins.push({ id: reference, version, scope, enabled: true });
    return { stdout: `✔ Successfully installed plugin: ${reference} (scope: ${scope})\n`, stderr: "" };
  }

  if (command === "update") {
    const reference = referenceArgument(argv);
    const scope = parseScope(argv, "user");
    const entry = state.plugins.find((item) => item.id === reference && item.scope === scope);
    if (!entry) throw failure(1, `plugin not installed: ${reference}`);
    const [pluginName, marketplaceName] = String(reference).split("@");
    const marketplace = state.marketplaces.find((item) => item.name === marketplaceName);
    if (!marketplace) throw failure(1, `unknown marketplace: ${marketplaceName}`);
    const { version } = await pluginVersion(path.join(marketplace.path, "plugins", pluginName));
    entry.version = version;
    return { stdout: `✔ ${pluginName} updated to ${version}\n`, stderr: "" };
  }

  if (command === "uninstall" || command === "remove") {
    const reference = referenceArgument(argv);
    const scope = parseScope(argv, "user");
    const before = state.plugins.length;
    state.plugins = state.plugins.filter((entry) => !(entry.id === reference && entry.scope === scope));
    if (state.plugins.length === before) throw failure(1, `plugin not installed: ${reference}`);
    return { stdout: `✔ Successfully uninstalled plugin: ${reference} (scope: ${scope})\n`, stderr: "" };
  }

  throw failure(1, `unknown plugin command: ${command}`);
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * In-process fake executor. `stateFile` makes the state durable across process
 * boundaries for the spawned CLI fake; otherwise it stays in memory.
 *
 * `failOn(key, message)` fails before mutating (a plain rejection);
 * `failOn(key, message, { mutate: true })` applies the command first and then
 * rejects, reproducing a CLI that mutated and still exited non-zero.
 */
export function createFakeClaudeRunner({ stateFile = null } = {}) {
  const memory = emptyFakeClaudeState();
  const log = [];
  const calls = [];
  const failures = new Map();
  const runner = async (argv, options = {}) => {
    const cwd = options.cwd ?? process.cwd();
    const env = options.env ?? process.env;
    const key = argv.join(" ");
    log.push(key);
    calls.push({ key, argv: [...argv], cwd, env });
    if (process.env.FAKE_CLAUDE_LOG) {
      await appendFile(process.env.FAKE_CLAUDE_LOG, `${key} cwd=${cwd}\n`);
    }
    const injected = failures.get(key);
    if (injected && !injected.mutate) {
      const error = new Error(injected.message);
      error.code = "CLAUDE_FAILED";
      throw error;
    }
    const state = stateFile ? JSON.parse(await readFile(stateFile, "utf8")) : memory;
    let result;
    try {
      result = await runFakeClaude(state, argv, { cwd, env });
    } catch (error) {
      if (stateFile) await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
      const wrapped = new Error(error.message);
      wrapped.code = "CLAUDE_FAILED";
      throw wrapped;
    }
    if (stateFile) await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    if (injected) {
      const error = new Error(injected.message);
      error.code = "CLAUDE_FAILED";
      throw error;
    }
    return result;
  };
  runner.log = log;
  runner.calls = calls;
  runner.state = memory;
  runner.failOn = (command, message, options = {}) => failures.set(command, { message, mutate: options.mutate === true });
  return runner;
}

const SCRIPT = `#!/usr/bin/env node
import { createFakeClaudeRunner } from ${JSON.stringify(helperPath)};

const runner = createFakeClaudeRunner({ stateFile: process.env.FAKE_CLAUDE_STATE });
try {
  const result = await runner(process.argv.slice(2), { cwd: process.cwd(), env: process.env });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
} catch (error) {
  process.stderr.write(\`\${error.message}\\n\`);
  process.exit(typeof error.exitCode === "number" ? error.exitCode : 1);
}
`;

/** Writes an executable fake `claude` binary and a durable state file. */
export async function writeFakeClaudeBin(directory) {
  await mkdir(directory, { recursive: true });
  const bin = path.join(directory, "claude.mjs");
  const stateFile = path.join(directory, "claude-state.json");
  await writeFile(bin, SCRIPT, { mode: 0o755 });
  await writeFile(stateFile, `${JSON.stringify(emptyFakeClaudeState(), null, 2)}\n`);
  await chmod(bin, 0o755);
  return { bin, stateFile };
}
