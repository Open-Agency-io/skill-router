// Shared fixtures for the Phase 6 journaled transaction and recovery tests.
//
// Everything here runs against temporary project roots with a fake lease (or a
// real mutation lock where contention matters); no test touches a real router
// installation or real Claude state.
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildInstallation, claudeIdentity, STATE_MARKER_CONTENT, STATE_MARKER_FILE } from "../src/installation.js";
import { stageManagedState } from "../src/managed-state.js";
import { controlPaths } from "../src/mutation-lock.js";
import { journaledTransactionInternals } from "../src/recovery.js";
import { applyJournaledManagedTransaction, applyJournaledRemovalTransaction } from "../src/transaction.js";

export const OLD_CONFIG = `${JSON.stringify({ schemaVersion: 2, skills: {} }, null, 2)}\n`;
export const NEW_CONFIG = `${JSON.stringify({ schemaVersion: 2, skills: { demo: {} } }, null, 2)}\n`;
export const STATE_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** Journal operations only need a held lease; most tests use this fake. */
export function fakeLease(paths) {
  return {
    paths,
    async assertHeld() {
      return true;
    },
  };
}

/** A lease whose assertion fails, used to prove fail-closed behavior. */
export function brokenLease(paths, message = "lease lost") {
  return {
    paths,
    async assertHeld() {
      const error = new Error(message);
      error.code = "LOCK_COMPROMISED";
      throw error;
    },
  };
}

export async function withTemp(prefix, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function makeRegistry(root) {
  const source = path.join(root, "sources", "demo.md");
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, "---\nname: demo\ndescription: Demo skill\n---\n\nDemo body.\n");
  return {
    fingerprint: "b".repeat(64),
    skills: [{ id: "demo", name: "demo", description: "Demo skill", source, enabled: true }],
    diagnostics: [],
  };
}

/** Project layout: control paths, prior owned state, and a router config. */
export async function createProject(root, { withPrior = true, config = OLD_CONFIG } = {}) {
  const paths = controlPaths({ root });
  await mkdir(paths.controlDirectory, { recursive: true, mode: 0o700 });
  const stateDirectory = path.join(root, ".skill-router");
  const configFile = path.join(root, ".skill-router.json");
  const openCodeConfig = path.join(root, "opencode.json");
  // The stable request spool lives at the resolved project root, exactly as
  // `requestSpoolPaths` derives it for real projects, and never inside state.
  const requestDirectory = path.join(root, ".skill-router-requests");
  if (config !== null) await writeFile(configFile, config);
  let installation = null;
  if (withPrior) {
    installation = buildInstallation({ global: false, stateDirectory, harnesses: ["opencode"] });
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(path.join(stateDirectory, STATE_MARKER_FILE), `${STATE_MARKER_CONTENT}\n`, { mode: 0o600 });
    await writeFile(
      path.join(stateDirectory, "registry.json"),
      `${JSON.stringify({ fingerprint: "a".repeat(64), skills: [] }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      path.join(stateDirectory, "installation.json"),
      `${JSON.stringify(installation, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  const registry = await makeRegistry(root);
  return {
    paths,
    stateDirectory,
    configFile,
    openCodeConfig,
    requestDirectory,
    installation,
    registry,
    lease: fakeLease(paths),
  };
}

export async function priorDigest(stateDirectory) {
  const { inspectStateTree } = await import("../src/managed-state.js");
  const info = await inspectStateTree(stateDirectory);
  return info.status === "owned" ? info.digest : null;
}

export async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/** Every entry of a tree with its full permission bits, root first. */
export async function modeTree(directory) {
  const entries = [{ path: ".", kind: "directory", mode: (await lstat(directory)).mode & 0o7777 }];
  const walk = async (current, relative) => {
    const children = [...(await readdir(current, { withFileTypes: true }))].sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of children) {
      const absolute = path.join(current, entry.name);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        entries.push({ path: name, kind: "directory", mode: (await lstat(absolute)).mode & 0o7777 });
        await walk(absolute, name);
      } else {
        entries.push({ path: name, kind: "file", mode: (await lstat(absolute)).mode & 0o7777 });
      }
    }
  };
  await walk(directory, "");
  return entries;
}

/** Recursive content digest used to compare arbitrary trees byte for byte. */
export async function digestTree(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const digest = {};
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await digestTree(full);
      for (const [key, value] of Object.entries(nested)) digest[`${entry.name}/${key}`] = value;
    } else if (entry.isFile()) {
      digest[entry.name] = createHash("sha256").update(await readFile(full)).digest("hex");
    } else {
      digest[entry.name] = "special";
    }
  }
  return digest;
}

export async function listEntries(directory) {
  try {
    return (await readdir(directory)).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

/** Every transaction artifact still present in a directory: journal, payloads, stages. */
export async function leftoverArtifacts(directory) {
  const entries = await listEntries(directory);
  return entries.filter(
    (name) =>
      (name === "transaction.json" ||
        name.includes(".skill-router-") ||
        name.includes(".stage-") ||
        name.includes(".backup-")) &&
      name !== ".skill-router-control" &&
      name !== ".skill-router-requests",
  );
}

/**
 * Installs a fault that throws when the shared step seam reaches `target`.
 * Returns a restore function; every install must be paired with one.
 */
export function installStepFault(target) {
  const original = journaledTransactionInternals.onStep;
  journaledTransactionInternals.onStep = async (name) => {
    if (name === target) {
      const error = new Error(`injected fault at ${name}`);
      error.injected = true;
      error.step = name;
      throw error;
    }
  };
  return () => {
    journaledTransactionInternals.onStep = original;
  };
}

/** Installs a rename that completes and then throws (mutate-then-error). */
export function installRenameFault({ after = true } = {}) {
  const original = journaledTransactionInternals.rename;
  journaledTransactionInternals.rename = async (from, to) => {
    await original(from, to);
    if (after) {
      const error = new Error("injected rename error after mutation");
      error.injected = true;
      throw error;
    }
  };
  return () => {
    journaledTransactionInternals.rename = original;
  };
}

/**
 * Stages a fresh managed tree at an exact path, as the executor's buildStage
 * does. Callers pass the project's stable spool as `requestDirectory`: it is a
 * required planning input for the generated router instructions.
 */
export function stageAt(stateDirectory, registry, options = {}) {
  return (exactPath) => stageManagedState(stateDirectory, registry, { ...options, stageDirectory: exactPath });
}

/** OpenCode configuration bytes with and without the managed skills entry. */
export async function openCodePlan(stateDirectory) {
  const sources = [path.join(stateDirectory, "opencode-skills")];
  const withSource = `${JSON.stringify({ $schema: "https://opencode.ai/schema.json", skill: { sources } }, null, 2)}\n`;
  const without = `${JSON.stringify({ $schema: "https://opencode.ai/schema.json", skill: { sources: [] } }, null, 2)}\n`;
  return { withSource, without };
}

/** Standard journaled managed transaction against a fixture project. */
export async function runManagedTransaction(project, overrides = {}) {
  return applyJournaledManagedTransaction({
    paths: project.paths,
    lease: project.lease,
    command: "scan",
    root: path.dirname(project.paths.controlDirectory),
    scope: "project",
    stateDirectory: project.stateDirectory,
    files: [{ role: "router-config", path: project.configFile, content: NEW_CONFIG, expectedBefore: OLD_CONFIG }],
    buildStage: stageAt(project.stateDirectory, project.registry, {
      global: false,
      installation: project.installation,
      requestDirectory: project.requestDirectory,
    }),
    verify: async () => {
      const installed = JSON.parse(await readFile(path.join(project.stateDirectory, "registry.json"), "utf8"));
      if (installed.fingerprint !== project.registry.fingerprint) throw new Error("registry verification failed");
    },
    ...overrides,
  });
}

/** Standard journaled removal transaction against a fixture project. */
export async function runRemovalTransaction(project, overrides = {}) {
  const plan = await openCodePlan(project.stateDirectory);
  await writeFile(project.openCodeConfig, plan.withSource);
  return applyJournaledRemovalTransaction({
    paths: project.paths,
    lease: project.lease,
    command: "uninstall",
    root: path.dirname(project.paths.controlDirectory),
    scope: "project",
    stateDirectory: project.stateDirectory,
    files: [
      {
        role: "opencode-config",
        path: project.openCodeConfig,
        content: plan.without,
        expectedBefore: plan.withSource,
      },
    ],
    verifyLocal: async () => {},
    ...overrides,
  });
}

export { applyJournaledManagedTransaction, applyJournaledRemovalTransaction };

export { claudeIdentity, buildInstallation };
