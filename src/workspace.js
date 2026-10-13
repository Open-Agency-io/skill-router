import { access, lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { CONFIG_FILE, loadConfig } from "./config.js";
import { discoverSources } from "./discovery.js";
import { durableCreateFile, isOwnerOnlyMode, readRegularFileNoFollow } from "./durable-fs.js";
import { jsonSyntaxError, readJsonText } from "./json-errors.js";
import { CONTROL_DIRECTORY_NAME, controlPaths, LOCK_ERROR_CODES, MutationLockError } from "./mutation-lock.js";
import { buildRegistry } from "./registry.js";
import { parseJsonc } from "./jsonc.js";
import { configuredSkillSources } from "./opencode.js";
import { configPolicy, referenceDiagnostics, workflowEntries } from "./policy.js";

export function homeDirectory() {
  return path.resolve(process.env.SKILL_ROUTER_HOME || homedir());
}

export function expandPath(value, base, home = homeDirectory()) {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return path.resolve(base, value);
}

/**
 * Root normalization shared by the control context and the operation context,
 * so `--root` means exactly one thing for every command: an exact `~` and a
 * leading `~/...` expand through the router home, a `~user` prefix is rejected
 * instead of being silently resolved against the wrong home, and any other `~`
 * stays a literal path character. There is deliberately no Windows backslash
 * expansion: the Windows runtime is unsupported.
 */
export function normalizeRootPath(value, home = homeDirectory()) {
  if (value === "~") return home;
  if (typeof value === "string" && value.startsWith("~/")) return path.join(home, value.slice(2));
  if (typeof value === "string" && value.startsWith("~")) {
    throw new Error("The router root must not use a ~user home prefix; use an absolute path");
  }
  return path.resolve(value);
}

async function existing(paths) {
  const result = [];
  for (const candidate of paths) {
    try {
      await access(candidate);
      result.push(candidate);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return result;
}

/**
 * A registered skill source may be the skill file itself or the skill directory
 * that contains its SKILL.md. Discovery treats a source-root SKILL.md as the
 * literal ID SKILL, so skill directories are registered through that file; the
 * configuration key keeps declaring the portable skill ID.
 */
async function resolveDirectSource(value) {
  let directory;
  try {
    directory = await lstat(value);
  } catch (error) {
    if (error.code === "ENOENT") return value;
    throw error;
  }
  if (!directory.isDirectory()) return value;
  const skillFile = path.join(value, "SKILL.md");
  try {
    const skillStat = await lstat(skillFile);
    return skillStat.isFile() ? skillFile : value;
  } catch (error) {
    if (error.code === "ENOENT") return value;
    throw error;
  }
}

async function preferredJsonConfig(jsonFile) {
  try {
    await access(jsonFile);
    return jsonFile;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const jsoncFile = `${jsonFile}c`;
  try {
    await access(jsoncFile);
    return jsoncFile;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return jsonFile;
  }
}

/**
 * True only for a real regular file. A symlinked (or directory/device)
 * `.skill-router.json` is never an initialization signal and is never
 * followed by root discovery, so it cannot redirect ownership.
 */
async function isRegularConfigFile(file) {
  try {
    const stat = await lstat(file);
    return stat.isFile();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * The single Git/worktree boundary check shared by root discovery and source
 * ancestor discovery. A boundary exists only when `.git` itself is a regular
 * file (a worktree or submodule pointer) or a directory; symlinks — valid or
 * dangling — and every other non-regular type are ignored and never followed,
 * so both discovery paths classify boundaries identically. Errors other than
 * ENOENT still fail closed.
 */
export async function isGitBoundary(directory) {
  try {
    const stat = await lstat(path.join(directory, ".git"));
    return stat.isFile() || stat.isDirectory();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Resolve the router root for project-scoped commands.
 *
 * Starting at the requested directory (`--root` or the caller's cwd), walk
 * upward to the nearest ancestor whose `.skill-router.json` is a regular file
 * and use it as `context.root` for every config/state/source/OpenCode path and
 * for Claude command `cwd`. Each candidate directory is checked *before* its
 * boundary is applied, so a config that sits exactly at the Git root is still
 * selected; the search never crosses that boundary, and without a Git boundary
 * it continues to the filesystem root so non-Git projects work. A malformed
 * nearest config is a regular file and is therefore selected (normal config
 * loading reports its error rather than falling through to a higher install),
 * while symlinked or otherwise non-regular candidates are skipped without
 * being read. An explicit `--config` disables discovery (the requested root is
 * kept), and global scope performs no search. When nothing qualifies, the
 * requested directory is returned unchanged.
 */
export async function resolveProjectRoot(requested, { global = false, explicitConfig = false } = {}) {
  const start = path.resolve(requested);
  if (global || explicitConfig) return start;
  let cursor = start;
  while (true) {
    if (await isRegularConfigFile(path.join(cursor, CONFIG_FILE))) return cursor;
    if (await isGitBoundary(cursor)) return start;
    const parent = path.dirname(cursor);
    if (parent === cursor) return start;
    cursor = parent;
  }
}

/* ------------------------------------------------------------------ *
 * Phase 6 — control anchor and control context
 *
 * The control anchor (`<control>/control.json`) is the router's durable,
 * owner-only, no-follow ownership record at the fixed control paths. It is
 * what lets an interrupted fresh init — configuration not written yet — resolve
 * the same root on the next run, and it binds every control directory to one
 * scope and one root.
 * ------------------------------------------------------------------ */

export const CONTROL_ANCHOR_SCHEMA_VERSION = 1;
export const CONTROL_ANCHOR_OWNER = "skill-router";
export const CONTROL_ANCHOR_KEYS = Object.freeze([
  "schemaVersion",
  "owner",
  "scope",
  "root",
  "createdAt",
]);
const CONTROL_ANCHOR_MAX_BYTES = 4096;

function anchorForeign(paths, reason) {
  return new MutationLockError(
    LOCK_ERROR_CODES.LOCK_FOREIGN,
    `control anchor at ${paths.controlFile} is foreign: ${reason}`,
    { lockPath: paths.controlDirectory },
  );
}

/**
 * Strict, side-effect-free read of the control anchor.
 *
 * Returns `null` when no anchor exists, the validated frozen document when it
 * is exactly one of ours, and refuses (`LOCK_FOREIGN`) for anything else:
 * symbolic link, non-regular entry, group/other permission bits, another user's
 * file, unreadable or malformed bytes, unknown or missing fields, a foreign
 * owner/schema, an invalid scope/root/timestamp, or a scope/root that does not
 * match `expected`. Nothing here follows a symlink or writes.
 */
export async function readControlAnchor(paths, expected = {}) {
  if (!paths || typeof paths !== "object" || typeof paths.controlFile !== "string") {
    throw new TypeError("readControlAnchor requires control paths");
  }
  const refuse = (reason) => anchorForeign(paths, reason);
  let stat;
  try {
    stat = await lstat(paths.controlFile);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink()) throw refuse("it is a symbolic link");
  if (!stat.isFile()) throw refuse("it is not a regular file");
  if (process.platform !== "win32") {
    if (!isOwnerOnlyMode(stat.mode)) throw refuse("it is not owner-only");
    if (typeof process.getuid === "function" && Number(stat.uid) !== process.getuid()) {
      throw refuse("it is not owned by the current user");
    }
  }

  let bytes;
  try {
    bytes = await readRegularFileNoFollow(paths.controlFile, { maxBytes: CONTROL_ANCHOR_MAX_BYTES });
  } catch (error) {
    throw refuse(`it cannot be read (${error.code ?? error.message})`);
  }
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw refuse("it is not valid JSON");
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw refuse("it is not a JSON object");
  }
  for (const key of Object.keys(document)) {
    if (!CONTROL_ANCHOR_KEYS.includes(key)) throw refuse(`it has an unknown field: ${key}`);
  }
  for (const key of CONTROL_ANCHOR_KEYS) {
    if (!Object.hasOwn(document, key)) throw refuse(`it is missing the ${key} field`);
  }
  if (document.schemaVersion !== CONTROL_ANCHOR_SCHEMA_VERSION) throw refuse("schemaVersion must be 1");
  if (document.owner !== CONTROL_ANCHOR_OWNER) throw refuse("owner must be skill-router");
  if (document.scope !== "project" && document.scope !== "global") throw refuse("scope must be project or global");
  if (typeof document.root !== "string" || document.root.length === 0) throw refuse("root must be a path");
  if (!path.isAbsolute(document.root) || path.resolve(document.root) !== document.root) {
    throw refuse("root must be a normalized absolute path");
  }
  if (typeof document.createdAt !== "string" || document.createdAt.length < 24 || document.createdAt.length > 32) {
    throw refuse("createdAt must be a timestamp");
  }
  if (!Number.isFinite(Date.parse(document.createdAt))) throw refuse("createdAt must be a timestamp");
  // Self-consistency: the anchor must belong to the control directory it lives in.
  if (document.scope === "project" && paths.controlDirectory !== path.join(document.root, CONTROL_DIRECTORY_NAME)) {
    throw refuse("its root does not own this control directory");
  }
  if (document.scope === "global" && paths.controlDirectory !== controlPaths({ home: document.root, global: true }).controlDirectory) {
    throw refuse("its home does not own this control directory");
  }
  if (expected.scope !== undefined && expected.scope !== null && document.scope !== expected.scope) {
    throw refuse(`it records scope ${document.scope}, expected ${expected.scope}`);
  }
  if (expected.root !== undefined && expected.root !== null && document.root !== path.resolve(expected.root)) {
    throw refuse(`it records root ${document.root}, expected ${path.resolve(expected.root)}`);
  }
  return Object.freeze({
    schemaVersion: document.schemaVersion,
    owner: document.owner,
    scope: document.scope,
    root: document.root,
    createdAt: document.createdAt,
  });
}

/** True when the ancestor candidate carries a strictly valid control anchor. */
async function hasControlAnchor(directory) {
  const candidate = controlPaths({ root: directory });
  try {
    return (await readControlAnchor(candidate)) !== null;
  } catch (error) {
    // A present-but-invalid anchor is not an ownership signal during the
    // upward walk (exactly like a symlinked configuration candidate); it is
    // refused later, at use time, by `ensureControlAnchor`.
    if (error instanceof MutationLockError && error.code === LOCK_ERROR_CODES.LOCK_FOREIGN) return false;
    throw error;
  }
}

/**
 * Validates an existing anchor, or durably and exclusively creates one for a
 * real control operation. `allowCreate: false` (reads, clean recoveries)
 * validates only. A racing creator is re-read and validated rather than
 * overwritten, so two processes can never disagree about ownership.
 */
export async function ensureControlAnchor({ paths, scope, root, allowCreate = true }) {
  const expected = { scope, root };
  const existing = await readControlAnchor(paths, expected);
  if (existing) return Object.freeze({ present: true, created: false, anchor: existing });
  if (!allowCreate) return Object.freeze({ present: false, created: false, anchor: null });

  const anchor = {
    schemaVersion: CONTROL_ANCHOR_SCHEMA_VERSION,
    owner: CONTROL_ANCHOR_OWNER,
    scope,
    root,
    createdAt: new Date().toISOString(),
  };
  const bytes = Buffer.from(`${JSON.stringify(anchor)}\n`, "utf8");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await durableCreateFile(paths.controlFile, bytes, { mode: 0o600 });
    } catch (error) {
      if (error && error.code === "EEXIST") {
        const raced = await readControlAnchor(paths, expected);
        if (raced) return Object.freeze({ present: true, created: false, anchor: raced });
        throw anchorForeign(paths, "it was replaced while it was being created");
      }
      if (error && error.code === "ENOENT" && attempt === 0) {
        // The control directory itself is missing (a read-only path that never
        // took the lock): create exactly it, owner-only, and retry once.
        await mkdir(paths.controlDirectory, { recursive: true, mode: 0o700 });
        continue;
      }
      throw error;
    }
    const created = await readControlAnchor(paths, expected);
    if (!created) throw anchorForeign(paths, "it disappeared while it was being created");
    return Object.freeze({ present: true, created: true, anchor: created });
  }
  throw anchorForeign(paths, "it could not be created");
}

/**
 * Resolve the control context — scope, root, and the fixed control paths —
 * **without loading router configuration**.
 *
 * Project scope with an explicit `--config` keeps the requested root (the
 * accepted Phase 3 contract). Otherwise the walk starts at the requested
 * directory and adopts the nearest ancestor that carries either a regular
 * `.skill-router.json` or a strictly valid control anchor; each candidate is
 * checked *before* that directory's Git/worktree boundary is applied, so an
 * installation exactly at the boundary is found and nothing above a boundary is
 * ever searched. Global scope performs no search and keys the router home.
 *
 * The returned `paths` are the exact control paths the mutation lock, journal,
 * and anchor use, so every process that resolves the same installation also
 * resolves the same lock key.
 */
export async function resolveControlContext(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("resolveControlContext requires an options object");
  }
  const home = homeDirectory();
  // Root normalization happens before *both* the control and the operation
  // context paths are derived, so `~`, `~/...`, and `~user` behave identically
  // for a lock/anchor lookup and for the command itself.
  const requestedRoot = normalizeRootPath(options.root ?? process.cwd(), home);
  const global = options.global === true;
  const explicitConfig = Boolean(options.config);
  if (global) {
    return Object.freeze({
      scope: "global",
      global: true,
      root: requestedRoot,
      // The anchor lives in the router home and must stay valid from any cwd,
      // so it records the home rather than the invoking project root.
      anchorRoot: home,
      home,
      explicitConfig: false,
      requestedRoot,
      paths: controlPaths({ home, global: true }),
    });
  }
  const root = await resolveControlRoot(requestedRoot, { explicitConfig });
  return Object.freeze({
    scope: "project",
    global: false,
    root,
    anchorRoot: root,
    home,
    explicitConfig,
    requestedRoot,
    paths: controlPaths({ root }),
  });
}

/** Upward control-root walk: config anchor, then control anchor, before `.git`. */
async function resolveControlRoot(requested, { explicitConfig }) {
  if (explicitConfig) return requested;
  let cursor = requested;
  while (true) {
    if (await isRegularConfigFile(path.join(cursor, CONFIG_FILE))) return cursor;
    if (await hasControlAnchor(cursor)) return cursor;
    if (await isGitBoundary(cursor)) return requested;
    const parent = path.dirname(cursor);
    if (parent === cursor) return requested;
    cursor = parent;
  }
}

/**
 * Source-ancestor chain of a resolved root, from the root up to (and
 * including) the nearest real Git/worktree boundary. It classifies `.git`
 * through the same lstat-based helper as root discovery, so a symlinked or
 * otherwise non-regular marker never stops either walk; with no boundary the
 * chain is just the starting directory.
 */
async function projectDirectories(directory) {
  let cursor = directory;
  let projectRoot = directory;
  while (true) {
    if (await isGitBoundary(cursor)) {
      projectRoot = cursor;
      break;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const directories = [];
  cursor = directory;
  while (true) {
    directories.unshift(cursor);
    if (cursor === projectRoot) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return directories;
}

/**
 * The stable owner-private request spool for a scope, independent of the
 * configured state directory so a custom `stateDirectory` can never move live
 * request data. Project installs keep it at the resolved root (the same root
 * nearest-initialized-root resolution picks for every other path); global
 * installs share one spool under the router home. The legacy location is
 * exactly `<stateDirectory>/requests`, which older installations wrote and
 * this router still drains.
 */
export function requestSpoolPaths({ root, home = homeDirectory(), global = false, stateDirectory } = {}) {
  const projectRoot = path.resolve(root);
  const routerHome = home ?? homeDirectory();
  return Object.freeze({
    requestDirectory: global
      ? path.join(routerHome, ".local", "share", "skill-router-requests")
      : path.join(projectRoot, ".skill-router-requests"),
    legacyRequestDirectory: path.join(
      stateDirectory ?? (global ? path.join(routerHome, ".local", "share", "skill-router") : path.join(projectRoot, ".skill-router")),
      "requests",
    ),
  });
}

export async function createContext(options = {}, control = {}) {
  // A caller that already resolved the control context seeds the walk with its
  // root: resolution then repeats independently, so a root that changes while
  // the lock is held is detected by revalidation instead of being adopted.
  const home = homeDirectory();
  // Same root normalization as the control context: an already-resolved
  // control root is absolute and therefore unchanged, while a raw `--root` is
  // expanded here exactly as it was there.
  const requestedRoot = normalizeRootPath(control.controlContext?.root ?? options.root ?? process.cwd(), home);
  const global = options.global === true;
  // Project scope without an explicit config starts at the requested directory
  // and adopts the nearest initialized ancestor; an explicit `--config` and
  // `--global` both keep the requested root and skip the search entirely.
  const root = await resolveProjectRoot(requestedRoot, {
    global,
    explicitConfig: Boolean(options.config),
  });
  const ancestors = global ? [] : await projectDirectories(root);
  const configFile = options.config
    ? expandPath(options.config, root, home)
    : global
      ? path.join(home, ".config", "skill-router", "config.json")
      : path.join(root, CONFIG_FILE);
  const { config } = await loadConfig(root, configFile);
  const stateDirectory = global
    ? path.join(home, ".local", "share", "skill-router")
    : expandPath(config.stateDirectory, root, home);
  const openCodeConfig = await preferredJsonConfig(global
    ? path.join(home, ".config", "opencode", "opencode.json")
    : path.join(root, ".opencode", "opencode.json"));

  // The stable spool keys off the resolved root (or the router home when
  // global), never the configured state path, so a customized
  // `stateDirectory` cannot relocate live request data.
  const { requestDirectory, legacyRequestDirectory } = requestSpoolPaths({
    root,
    home,
    global,
    stateDirectory,
  });

  return {
    root,
    home,
    global,
    ancestors,
    configFile,
    stateDirectory,
    requestDirectory,
    legacyRequestDirectory,
    openCodeConfig,
    config,
  };
}

/**
 * Implicit default skill roots for a context, in discovery order and without
 * existence filtering. `sourcePaths` only submits the ones that exist; the same
 * list drives the carry-forward of a default that participated in the
 * installed registry but has since disappeared.
 */
export function implicitDefaultCandidates(context) {
  const globalClaude = path.join(context.home, ".claude", "skills");
  const globalAgents = path.join(context.home, ".agents", "skills");
  const globalOpenCode = path.join(context.home, ".config", "opencode", "skills");
  const ancestors = context.ancestors ?? [context.root];
  return context.global
    ? [globalClaude, globalAgents, globalOpenCode]
    : [
        globalClaude,
        ...ancestors.map((directory) => path.join(directory, ".claude", "skills")),
        globalAgents,
        ...ancestors.map((directory) => path.join(directory, ".agents", "skills")),
        globalOpenCode,
        ...ancestors.map((directory) => path.join(directory, ".opencode", "skills")),
      ];
}

export async function sourcePaths(context, config = context.config) {
  const ancestors = context.ancestors ?? [context.root];
  const defaults = await existing(implicitDefaultCandidates(context));
  const configFiles = context.global
    ? [context.openCodeConfig]
    : [
        path.join(context.home, ".config", "opencode", "opencode.json"),
        path.join(context.home, ".config", "opencode", "opencode.jsonc"),
        ...ancestors.flatMap((directory) => [
          path.join(directory, "opencode.json"),
          path.join(directory, "opencode.jsonc"),
          path.join(directory, ".opencode", "opencode.json"),
          path.join(directory, ".opencode", "opencode.jsonc"),
        ]),
        context.openCodeConfig,
      ];
  const configured = [];
  for (const file of [...new Set(configFiles)]) {
    try {
      const document = parseJsonc(await readJsonText(file), file);
      for (const source of configuredSkillSources(document)) {
        if (typeof source !== "string" || /^https?:\/\//.test(source)) continue;
        const resolved = expandPath(source, context.root, context.home);
        if (resolved !== path.join(context.stateDirectory, "opencode-skills")) configured.push(resolved);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const explicit = config.sources.map((source) => expandPath(source, context.root, context.home));
  const combined = [...defaults, ...configured, ...explicit];
  return combined.filter((source, index) => combined.lastIndexOf(source) === index);
}

/**
 * Did a root participate in the installed registry? New registries carry the
 * exact `sourceRoots` inventory; legacy registries are inferred conservatively
 * when an installed skill path lives inside that root.
 */
function participatedInInstalled(installed, root) {
  if (Array.isArray(installed.sourceRoots)) return installed.sourceRoots.includes(root);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  // A malformed legacy registry (non-array `skills`) is inert inventory: it
  // can neither attest participation nor crash the rebuild that replaces it.
  const skills = Array.isArray(installed.skills) ? installed.skills : [];
  return skills.some((skill) => {
    for (const value of [skill?.source, skill?.path]) {
      if (typeof value !== "string") continue;
      if (value === root || value.startsWith(prefix)) return true;
    }
    return false;
  });
}

/**
 * Implicit default roots that participated in the installed registry but are
 * no longer part of the discovery input because they disappeared. Carrying
 * them forward makes discovery emit a blocking `source-not-found` instead of
 * silently deleting their skills. Only known implicit defaults are carried: a
 * source the user removed from configuration stays removed, and an intentional
 * removal inside an otherwise healthy source is still discoverable.
 */
function retainedMissingDefaults({ context, sources, installed }) {
  if (!installed) return [];
  const retained = [];
  for (const root of implicitDefaultCandidates(context)) {
    if (sources.includes(root)) continue;
    if (!participatedInInstalled(installed, root)) continue;
    retained.push(root);
  }
  return retained;
}

/**
 * A match count for diagnostics: the real value is a discovered-inventory
 * count, phrased with a fixed cap so the rendered number stays a small,
 * bounded token regardless of source size.
 */
const MAX_REPORTED_MATCHES = 999;

function boundedCount(count) {
  return count > MAX_REPORTED_MATCHES ? `${MAX_REPORTED_MATCHES}+` : String(count);
}

export async function buildWorkspaceRegistry(context, config = context.config, options = {}) {
  const sources = await sourcePaths(context, config);
  const retained = retainedMissingDefaults({ context, sources, installed: options.installed });
  const submitted = retained.length ? [...sources, ...retained] : sources;
  const direct = [];
  const replace = Object.create(null);
  const enabled = Object.create(null);
  for (const [id, settings] of Object.entries(config.skills)) {
    if (settings.enabled !== undefined) enabled[id] = settings.enabled;
    if (settings.source) {
      const resolved = expandPath(settings.source, context.root, context.home);
      // A declared source may be the skill directory rather than its SKILL.md.
      // Both schema versions resolve that directory through the same no-follow
      // direct-source resolution, so a directory replacement always names the
      // single skill file discovery actually saw; schema v1 keeps every other
      // permissive property (no ID-match or uniqueness diagnostics, and a
      // source that is not discovered stays inert).
      const discoverPath = await resolveDirectSource(resolved);
      if ((config.schemaVersion ?? 1) >= 2) {
        direct.push({ id, path: resolved, discoverPath });
      } else {
        replace[id] = discoverPath;
      }
    }
  }
  const extra = direct
    .map((entry) => entry.discoverPath)
    .filter((value, index, all) => all.indexOf(value) === index && !submitted.includes(value));
  const discovery = await discoverSources([...submitted, ...extra]);

  // A declared source is an explicit winner, not just a validation hint: it
  // populates the replacement mapping with the resolved discovered skill path
  // so a bulk source with the same ID can never take over the registry (and
  // therefore the managed implementation) for that ID.
  //
  // Diagnostic safety: the configured key is a validated public ID and a
  // discovered match ID is validated by discovery, so either may be named.
  // The resolved source path is untrusted material (it can carry control
  // characters or sensitive absolute components) and never enters a message,
  // field, or count caption; the match count is a bounded phrase.
  const directDiagnostics = [];
  for (const entry of direct) {
    // One declared file can legitimately surface more than once: discovery may
    // reach it through a parent, default, or bulk source and again through its
    // own direct registration. Only distinct skill files count as separate
    // matches, so the duplicate is collapsed on its canonical path instead of
    // being reported as unresolved.
    const uniquePaths = new Set();
    const matches = discovery.skills.filter((skill) => {
      if (skill.source !== entry.discoverPath && skill.path !== entry.discoverPath) return false;
      const canonicalPath = path.resolve(skill.path);
      if (uniquePaths.has(canonicalPath)) return false;
      uniquePaths.add(canonicalPath);
      return true;
    });
    if (matches.length !== 1) {
      directDiagnostics.push({
        level: "error",
        code: "direct-source-unresolved",
        id: entry.id,
        message: `skills.${entry.id}.source must resolve to exactly one skill (${boundedCount(matches.length)} found)`,
      });
    } else if (matches[0].id !== entry.id) {
      directDiagnostics.push({
        level: "error",
        code: "direct-source-id-mismatch",
        id: entry.id,
        resolvedId: matches[0].id,
        message: `skills.${entry.id}.source resolves to skill ID ${matches[0].id}, which must match the configuration key`,
      });
    } else {
      replace[entry.id] = matches[0].path;
    }
  }

  const registry = buildRegistry(discovery, {
    replace,
    enabled,
    // Schema v1 never enforces policy freshness: it routes from the current
    // configuration, so its fingerprint tracks discovered material only and no
    // policy hash is persisted.
    policy: (config.schemaVersion ?? 1) >= 2 ? configPolicy(config) : null,
    workflows: workflowEntries(config),
  });
  registry.diagnostics.push(...directDiagnostics);
  // The roots actually submitted to discovery, in submission order. This is
  // inventory only: the source fingerprint algorithm ignores it, so a legacy
  // registry without the field stays valid and never goes stale because of it.
  registry.sourceRoots = [...submitted, ...extra];

  registry.skills = registry.skills.map((skill) => {
    const settings = config.skills[skill.id];
    if (!settings) return skill;
    return {
      ...skill,
      ...(settings.description ? { description: settings.description } : {}),
      ...(settings.invocation ? { invocation: settings.invocation } : {}),
      ...(settings.applicability ? { applicability: settings.applicability } : {}),
      ...(settings.handoffTo ? { handoffTo: settings.handoffTo } : {}),
    };
  });
  registry.diagnostics.push(...referenceDiagnostics(config, registry.skills));
  return { sources: [...submitted, ...extra], discovery, registry };
}

export async function readRegistry(context) {
  const file = path.join(context.stateDirectory, "registry.json");
  let text;
  try {
    text = await readJsonText(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    // Bounded error: file context plus a safely derived line/column, never the
    // parser's snippet-bearing text.
    throw jsonSyntaxError(text, error, { file, kind: "registry JSON" });
  }
}

/** True when `candidate` is `directory` itself or lives below it, lexically. */
export function isPathInside(candidate, directory) {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolve a path through every component that currently exists, keeping the
 * not-yet-existing remainder attached lexically. A configuration that has not
 * been written yet still reveals whether an existing parent (or leaf) symlink
 * lands inside router-owned state, and nothing is created or written while
 * finding out.
 */
async function resolveThroughExisting(target) {
  const resolved = path.resolve(target);
  const missing = [];
  let cursor = resolved;
  for (;;) {
    try {
      const real = await realpath(cursor);
      return missing.length === 0 ? real : path.join(real, ...missing.slice().reverse());
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return resolved;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * Shared invariant for every *mutating* operation: the router configuration
 * must be disjoint from the router-owned state directory, both lexically and
 * after resolving any existing configuration/parent symlink. A configuration
 * inside state would be written — or removed — by the very lifecycle that is
 * supposed to own that directory, so both placements refuse with copy-outside
 * wording instead. Read-only commands (`route`, `check`) never apply it.
 */
export async function assertConfigOutsideState(configFile, stateDirectory) {
  const config = path.resolve(configFile);
  const state = path.resolve(stateDirectory);
  const remedy =
    "Copy the configuration file outside the router-owned state directory and retry.";
  if (isPathInside(config, state)) {
    throw new Error(
      `Router configuration must stay outside the router-owned state directory: ${config} is inside ${state}. ${remedy}`,
    );
  }
  const [realConfig, realState] = await Promise.all([
    resolveThroughExisting(config),
    resolveThroughExisting(state),
  ]);
  if (isPathInside(realConfig, realState)) {
    throw new Error(
      `Router configuration must stay outside the router-owned state directory: ${config} resolves to ${realConfig}, which is inside the router-owned state directory ${realState}. ${remedy}`,
    );
  }
}
