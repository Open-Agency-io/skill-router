import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { canonical } from "./policy.js";

const require = createRequire(import.meta.url);

/**
 * Router-owned installation metadata. It is written inside the marker-protected
 * state directory on every regeneration, so it is the single authority for
 * which harness integrations are recorded and how the generated Claude plugin
 * is addressed. Every state directory without this file predates harness
 * support and therefore infers OpenCode-only.
 */
export const INSTALLATION_FILE = "installation.json";
export const INSTALLATION_SCHEMA_VERSION = 1;
export const INSTALLATION_OWNER = "skill-router";
export const STATE_MARKER_FILE = ".skill-router-owned";
export const STATE_MARKER_CONTENT = "skill-router-state-v1";
export const HARNESS_ORDER = Object.freeze(["opencode", "claude"]);
export const CLAUDE_SCOPES = Object.freeze({ project: "local", global: "user" });
export const CLAUDE_PLUGINS = Object.freeze({
  project: "openagency-skill-router",
  global: "openagency-skill-router-global",
});
export const CLAUDE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
export const CLAUDE_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
export const DEFAULT_CLAUDE_VERSION = "0.1.0";

/** Plain `major.minor.patch` prefix of a semantic version, or `null`. */
export function normalizeSemver(value) {
  const match = String(value ?? "").trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

function readPackageVersion() {
  try {
    return require("../package.json").version;
  } catch {
    return null;
  }
}

/**
 * Base version for a freshly generated Claude plugin: the shipped package
 * version, read once through `createRequire` so the JSON load behaves
 * identically under every supported runtime (no import attributes and no JSON
 * module loader). A prerelease/build suffix is normalized away because the
 * generated plugin version must stay a plain three-part semantic version.
 */
export const ROUTER_PACKAGE_VERSION = normalizeSemver(readPackageVersion()) ?? DEFAULT_CLAUDE_VERSION;

const TOP_LEVEL_KEYS = new Set(["schemaVersion", "owner", "scope", "stateDirectory", "harnesses", "claude"]);
const CLAUDE_KEYS = new Set(["scope", "plugin", "marketplace", "fingerprint", "version"]);
const SCOPE_VALUES = new Set(["project", "global"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function routerScope(global) {
  return global ? "global" : "project";
}

function fail(message) {
  throw new Error(`Invalid installation metadata: ${message}`);
}

/** Canonical harness order, so stored and reported integrations never depend on insertion order. */
export function normalizeHarnesses(values) {
  if (!Array.isArray(values)) fail("harnesses must be an array");
  const present = new Set();
  for (const value of values) {
    if (!HARNESS_ORDER.includes(value)) throw new Error(`Unsupported harness: ${value}`);
    if (present.has(value)) fail("harnesses lists a harness more than once");
    present.add(value);
  }
  if (present.size === 0) fail("harnesses must record at least one harness");
  return HARNESS_ORDER.filter((harness) => present.has(harness));
}

/** Explicit `--harness` selections. An absent option requests nothing. */
export function requestedHarnesses(value) {
  if (value === undefined || value === null || value === "") return [];
  if (value === "all") return [...HARNESS_ORDER];
  if (HARNESS_ORDER.includes(value)) return [value];
  throw new Error(`Unsupported harness: ${value}`);
}

/**
 * Deterministic harness union: recorded integrations are always retained,
 * explicit selections are additive, legacy state without metadata infers
 * OpenCode-only, and a brand new installation without a selection defaults to
 * OpenCode-only.
 */
export function selectHarnesses({ recorded, requested = [], stateExists = false } = {}) {
  const base = new Set(recorded ? normalizeHarnesses(recorded) : stateExists ? ["opencode"] : []);
  for (const value of requested) {
    if (!HARNESS_ORDER.includes(value)) throw new Error(`Unsupported harness: ${value}`);
    base.add(value);
  }
  if (base.size === 0) return ["opencode"];
  return HARNESS_ORDER.filter((harness) => base.has(harness));
}

/**
 * Marketplace identity is derived from the router scope and the canonical
 * state path only, so regenerated skills can never rename it.
 */
export function claudeMarketplaceName(scope, stateDirectory) {
  return `skill-router-${sha256(`${scope}\0${path.resolve(stateDirectory)}`).slice(0, 24)}`;
}

export function claudeIdentity({ global, stateDirectory }) {
  const scope = routerScope(global);
  const canonicalState = path.resolve(stateDirectory);
  return {
    scope,
    claudeScope: CLAUDE_SCOPES[scope],
    plugin: CLAUDE_PLUGINS[scope],
    marketplace: claudeMarketplaceName(scope, canonicalState),
    stateDirectory: canonicalState,
  };
}

/**
 * Fingerprint of the generated plugin content: skill documents, the router
 * instructions, every copied support file, and (where the platform reports
 * them) the normalized POSIX mode bits of each file. The version-bearing
 * manifests are excluded because the version is derived from this fingerprint.
 */
export function claudeFingerprint(identity, entries) {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  return sha256(
    canonical({
      plugin: identity.plugin,
      marketplace: identity.marketplace,
      claudeScope: identity.claudeScope,
      stateDirectory: identity.stateDirectory,
      entries: sorted.map((entry) => ({
        path: entry.path,
        sha256: entry.sha256,
        ...(entry.mode === undefined ? {} : { mode: entry.mode }),
      })),
    }),
  );
}

/**
 * Claude installs and caches plugin content by version, so an unchanged
 * version never refreshes. Identical content keeps its version; changed
 * content advances the patch version so `plugin update` re-reads the
 * marketplace copy. A never-recorded plugin starts at the package version
 * (`baseVersion`, injectable for tests).
 */
export function resolveClaudeVersion(recorded, fingerprint, baseVersion = ROUTER_PACKAGE_VERSION) {
  if (recorded && CLAUDE_VERSION_PATTERN.test(recorded.version ?? "") && recorded.fingerprint === fingerprint) {
    return recorded.version;
  }
  if (recorded && CLAUDE_VERSION_PATTERN.test(recorded.version ?? "")) {
    const [major, minor, patch] = recorded.version.split(".").map(Number);
    return `${major}.${minor}.${patch + 1}`;
  }
  return normalizeSemver(baseVersion) ?? DEFAULT_CLAUDE_VERSION;
}

export function buildInstallation({ global, stateDirectory, harnesses, claude = null }) {
  const scope = routerScope(global);
  const canonicalState = path.resolve(stateDirectory);
  const normalized = normalizeHarnesses(harnesses);
  const document = {
    schemaVersion: INSTALLATION_SCHEMA_VERSION,
    owner: INSTALLATION_OWNER,
    scope,
    stateDirectory: canonicalState,
    harnesses: normalized,
  };
  if (normalized.includes("claude")) {
    if (!claude) fail("the claude harness requires Claude plugin metadata");
    if (!CLAUDE_FINGERPRINT_PATTERN.test(claude.fingerprint ?? "")) fail("claude.fingerprint must be a sha256 hex digest");
    if (!CLAUDE_VERSION_PATTERN.test(claude.version ?? "")) fail("claude.version must be a semantic version");
    const identity = claudeIdentity({ global, stateDirectory: canonicalState });
    document.claude = {
      scope: identity.claudeScope,
      plugin: identity.plugin,
      marketplace: identity.marketplace,
      fingerprint: claude.fingerprint,
      version: claude.version,
    };
  } else if (claude) {
    fail("Claude plugin metadata was provided without the claude harness");
  }
  validateInstallation(document);
  return document;
}

export function validateInstallation(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    fail("the document must be a JSON object");
  }
  for (const key of Object.keys(document)) {
    if (!TOP_LEVEL_KEYS.has(key)) fail(`unknown key: ${key}`);
  }
  if (document.schemaVersion !== INSTALLATION_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${INSTALLATION_SCHEMA_VERSION}`);
  }
  if (document.owner !== INSTALLATION_OWNER) fail(`owner must be ${JSON.stringify(INSTALLATION_OWNER)}`);
  if (!SCOPE_VALUES.has(document.scope)) fail("scope must be project or global");
  if (typeof document.stateDirectory !== "string" || !path.isAbsolute(document.stateDirectory)) {
    fail("stateDirectory must be an absolute path");
  }
  const harnesses = normalizeHarnesses(document.harnesses);
  const claudeEnabled = harnesses.includes("claude");
  if (!claudeEnabled) {
    if (document.claude !== undefined) fail("claude metadata is recorded without the claude harness");
    return document;
  }
  const claude = document.claude;
  if (!claude || typeof claude !== "object" || Array.isArray(claude)) fail("claude must be an object");
  for (const key of Object.keys(claude)) {
    if (!CLAUDE_KEYS.has(key)) fail(`unknown claude key: ${key}`);
  }
  const identity = claudeIdentity({ global: document.scope === "global", stateDirectory: document.stateDirectory });
  if (claude.scope !== identity.claudeScope) {
    fail(`claude.scope must be ${JSON.stringify(identity.claudeScope)} for ${document.scope} scope`);
  }
  if (claude.plugin !== identity.plugin) {
    fail(`claude.plugin must be ${JSON.stringify(identity.plugin)} for ${document.scope} scope`);
  }
  if (claude.marketplace !== identity.marketplace) {
    fail("claude.marketplace does not match the scoped state-path hash");
  }
  if (!CLAUDE_FINGERPRINT_PATTERN.test(claude.fingerprint ?? "")) fail("claude.fingerprint must be a sha256 hex digest");
  if (!CLAUDE_VERSION_PATTERN.test(claude.version ?? "")) fail("claude.version must be a semantic version");
  return document;
}

export function parseInstallation(text, file = INSTALLATION_FILE) {
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid installation JSON at ${file}: ${error.message}`);
  }
  try {
    return validateInstallation(document);
  } catch (error) {
    throw new Error(`Invalid installation metadata at ${file}: ${error.message}`);
  }
}

/** Recorded installation, or `null` for legacy state that predates metadata. */
export async function readInstallation(stateDirectory) {
  const file = path.join(stateDirectory, INSTALLATION_FILE);
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Invalid installation metadata at ${file}: not a regular file`);
    }
    return parseInstallation(await readFile(file, "utf8"), file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function directoryExists(directory) {
  try {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Ownership marker semantics shared by every removal path. The marker must be
 * a regular, non-symlink file whose content is exactly the recorded marker,
 * optionally terminated by the single newline staging writes. Padded, prefixed,
 * extended, or redirected marker content never counts as ownership.
 */
export function isOwnedMarkerContent(content) {
  if (typeof content !== "string") return false;
  return content === STATE_MARKER_CONTENT || content === `${STATE_MARKER_CONTENT}\n`;
}

/**
 * Filesystem identity of a state directory: the resolved path plus `dev` and
 * `ino` when the platform reports a meaningful inode. `dev`/`ino` survive the
 * same-parent rename that commits an uninstall, so they are the only fields
 * that can prove the renamed backup is still the inspected directory.
 */
export function stateIdentityOf(stat, directory) {
  const identity = { path: path.resolve(directory) };
  if (stat && Number.isFinite(stat.ino) && stat.ino !== 0) {
    identity.ino = stat.ino;
    if (Number.isFinite(stat.dev)) identity.dev = stat.dev;
  }
  return identity;
}

/** Compares a recorded identity against a fresh `lstat`; paths are never compared here. */
export function stateIdentityMatches(identity, stat) {
  if (!identity || identity.ino === undefined) return true;
  if (!stat || stat.ino !== identity.ino) return false;
  if (identity.dev !== undefined && stat.dev !== identity.dev) return false;
  return true;
}

async function assertOwnershipMarker(directory, label) {
  const markerFile = path.join(directory, STATE_MARKER_FILE);
  let markerStat;
  try {
    markerStat = await lstat(markerFile);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Refusing unowned ${label}: ${directory}`);
    throw error;
  }
  if (markerStat.isSymbolicLink() || !markerStat.isFile()) {
    throw new Error(`The ownership marker of ${label} is not a regular file: ${markerFile}`);
  }
  const marker = await readFile(markerFile, "utf8");
  if (!isOwnedMarkerContent(marker)) {
    throw new Error(`The ownership marker of ${label} does not match the recorded content: ${markerFile}`);
  }
}

/**
 * Verifies that `directory` is a non-symlink directory carrying the exact
 * ownership marker, and returns its `lstat`. Every removal mutation is
 * bracketed by this check so unowned, symlinked, or foreign directories are
 * refused before anything is renamed or deleted.
 */
export async function assertOwnedStateDirectory(directory, label = "router state") {
  let stat;
  try {
    stat = await lstat(directory);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Missing ${label}: ${directory}`);
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`Refusing ${label} through a symlink: ${directory}`);
  if (!stat.isDirectory()) throw new Error(`Refusing ${label} that is not a directory: ${directory}`);
  await assertOwnershipMarker(directory, label);
  return stat;
}

/**
 * Read-only ownership inspection for uninstall. Returns `{status:'absent'}`
 * only when the state path truly does not exist; every other state must be a
 * non-symlink directory with the exact ownership marker and installation
 * metadata that matches the requested scope and the resolved state path.
 * Marker-owned state without installation metadata predates harness support
 * and is reported as legacy OpenCode-only. Any wrong type, symlink, marker,
 * metadata, scope, or path refuses by throwing, so a caller can never mutate
 * state it cannot attribute to this router.
 */
export async function readOwnedInstallationForRemoval(stateDirectory, { global } = {}) {
  const resolved = path.resolve(stateDirectory);
  let stat;
  try {
    stat = await lstat(resolved);
  } catch (error) {
    if (error.code === "ENOENT") return { status: "absent" };
    throw new Error(`Cannot inspect router state at ${resolved}: ${error.message}`);
  }
  if (stat.isSymbolicLink()) throw new Error(`Refusing router state through a symlink: ${resolved}`);
  if (!stat.isDirectory()) throw new Error(`Refusing router state that is not a directory: ${resolved}`);
  await assertOwnershipMarker(resolved, "router state");

  const installation = await readInstallation(resolved);
  let legacy = false;
  let harnesses;
  if (!installation) {
    // Valid marker without installation metadata predates harness support:
    // the only integration this state can own is OpenCode.
    legacy = true;
    harnesses = ["opencode"];
  } else {
    const scope = routerScope(global);
    if (installation.scope !== scope) {
      throw new Error(`Refusing removal: ${INSTALLATION_FILE} scope is ${installation.scope}, expected ${scope}`);
    }
    if (installation.stateDirectory !== resolved) {
      throw new Error(`Refusing removal: ${INSTALLATION_FILE} stateDirectory does not match ${resolved}`);
    }
    harnesses = normalizeHarnesses(installation.harnesses);
  }
  return { status: "owned", installation, legacy, harnesses, stateIdentity: stateIdentityOf(stat, resolved) };
}

/**
 * Ownership checks for the state directory and its installation metadata.
 * Returns human-readable problems instead of throwing so `check` can report
 * every issue in one pass.
 */
export async function installationProblems(stateDirectory, { global }) {
  const problems = [];
  let installation = null;
  let legacy = false;
  try {
    installation = await readInstallation(stateDirectory);
  } catch (error) {
    problems.push(error.message);
    return { installation: null, legacy: false, problems };
  }
  if (!installation) {
    // Metadata predates harness support: infer OpenCode-only without failing,
    // and let the caller report the legacy state as a warning.
    legacy = await directoryExists(stateDirectory);
    return { installation: null, legacy, problems };
  }
  const scope = routerScope(global);
  if (installation.scope !== scope) {
    problems.push(`installation.json scope is ${installation.scope}, expected ${scope}`);
  }
  if (installation.stateDirectory !== path.resolve(stateDirectory)) {
    problems.push("installation.json stateDirectory does not match this state directory");
  }
  return { installation, legacy: false, problems };
}
