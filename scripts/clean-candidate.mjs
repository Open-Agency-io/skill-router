#!/usr/bin/env node
// Phase 11 clean-candidate gate: prove that the *current* candidate — every
// tracked and untracked file that is not ignored, exactly as a fresh checkout
// would see it — builds, checks, tests, packs, and installs from a clean
// clone, without touching the real repository.
//
// Contract (see `.slim/deepwork/public-release-readiness.md`, Phase 11):
//   1. Enumerate candidates with `git ls-files --cached --others
//      --exclude-standard -z` under an isolated git configuration, and *also*
//      under the ambient host configuration. If disabling the host's ignore
//      rules would add even one file, refuse before copying anything, with a
//      privacy-safe diagnostic that never names a file or its content and
//      points at the repository's own `.gitignore`. Every source git command
//      runs with fsmonitor, hooks, untracked caches, and other external git
//      behaviours explicitly disabled, and with a canonical absolute `git`.
//   2. Record a complete candidate *manifest* for every candidate: validated
//      strict-UTF-8 path (git `-z` bytes decoded across chunk boundaries;
//      invalid encoding fails closed), type, size, content SHA-256, normalized
//      executable mode, and the link-count policy (a regular file with
//      `nlink > 1` is refused). Every ancestor below the canonical repository
//      root must be an ordinary, non-symlink directory.
//   3. Build a temporary Git repository in a gate-owned temp root: copy each
//      candidate through `O_NOFOLLOW` descriptors with pre/post `fstat`
//      identity/size/mode/link-count checks and digest equivalence, commit
//      there, then `git clone --no-local` into a second temp directory. The
//      real index is never staged, reset, or written.
//   4. In that genuinely clean clone run `npm ci`, `npm run check`, `npm test`.
//      The clone's `package.json` must hash to the manifest's `package.json`
//      digest and re-parse to the same identity, so package metadata is bound
//      to the committed snapshot rather than to a mutable work tree.
//   5. `npm pack --json --pack-destination <dir>`, verify exact name/version/
//      filename identity plus the required files, install the tarball into a
//      fresh consumer project with `--ignore-scripts`, and execute exactly
//      `node_modules/.bin/skill-router` (the only allowed `bin` key) expecting
//      the exact package version.
//   6. Re-enumerate and re-hash the source candidates after the copy and again
//      in the final reconciliation (success *and* failure paths, in `finally`),
//      and compare the repository fingerprint (status, real `.git/index`
//      bytes, root entries) before and after. Content drift is detected even
//      when `git status` is byte-identical. A pack artifact this run created in
//      a caller-owned artifact directory is tracked by identity and removed on
//      any later failure. The temp root is removed and its removal is proven by
//      inode: the path must be gone *and* no renamed same-inode directory may
//      remain in the temp parent.
//
// Anti-recursion: every child runs with `SKILL_ROUTER_GATE_ACTIVE=1`, and the
// gate refuses to start when that flag is already set for its own repository.
// That is what makes it safe for the gate's `npm test` step to include this
// gate's own tests: a nested run against the same repository fails closed
// instead of spawning another gate.
//
// Environment: children get a narrow, scrubbed environment (no npm/git/lifecycle
// config, no CI command-file variables such as `GITHUB_ENV`/`GITHUB_PATH`, no
// Docker/Kubernetes/cloud credential paths, no token-shaped variables) plus the
// gate's own HOME, git config, npm cache, hooks directory, and a gate-owned
// `TMPDIR` under the temp root. The temp parent itself must be an existing,
// canonical, non-symlink directory outside the repository; ambient `TMPDIR` is
// never inherited by a child, so a temp directory inside the source tree can
// never be written to.
//
// Trust boundary (stated plainly): this gate is an *integrity and
// reproducibility* gate that runs trusted candidate tests. It is not an OS
// sandbox. Process containment covers ordinary descendants that stay in the
// child's process group; intentionally detached or re-daemonized descendants
// are outside the local gate's portable containment boundary (the gate itself
// still settles — inherited pipes cannot hold it open — and it never claims an
// escaped process was killed). Hostile same-user code is out of scope.
//
// Limits: POSIX process groups are bounded/terminated (see `gate-lib.mjs`);
// live Windows validation is a later gate. `npm ci` needs registry access for
// the package's pinned dependencies. The temp root lives under the caller's
// temp parent, whose canonical, non-symlink, outside-repository provenance is
// part of setup; the temp path prefix is deliberately short because the gate's
// own `npm test` runs path-budget assertions against `TMPDIR`-derived fixture
// paths (see `createIsolationEnvironment`).
//
// Direct behavior: `node scripts/clean-candidate.mjs` (or
// `npm run gate:clean`) prints one bounded summary line on success and bounded
// diagnostics on failure. Exports exist only for the focused tests.

import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GateFailure,
  GATE_ENV_FLAG,
  GATE_TIMEOUT_MS,
  STEP_TIMEOUT_MS,
  VERSION_PATTERN,
  assertNoNestedGate,
  boundTail,
  copyRegularFileNoFollow,
  expectedTarballFilename,
  fileRecord,
  formatGateFailure,
  inodeIdentity,
  parsePackResult,
  readRegularFileBounded,
  resolveExecutable,
  runCommand,
  scrubEnvironment,
  sha256File,
} from "./gate-lib.mjs";

export const REPOSITORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
/**
 * Temp-root prefix. Deliberately short: the gate's own `npm test` creates
 * fixtures under the gate-owned `TMPDIR` (`<root>/tmp`), and three existing
 * router-document tests assert a 300-token budget on text that embeds those
 * paths. Every extra prefix character is one character of that budget (the
 * measured headroom is ~23 characters above the ambient temp path), so the
 * prefix must stay short rather than descriptive.
 */
export const TEMP_PREFIX = "sr-g-";
export const GATE_STEPS = [
  { label: "npm ci", command: "npm", args: ["ci", "--no-audit", "--no-fund"] },
  { label: "npm run check", command: "npm", args: ["run", "check"] },
  { label: "npm test", command: "npm", args: ["test"] },
];

/**
 * Hardening flags prefixed to every git command that reads the *source*
 * repository (and to the clone/temp-repository commands too, where they are
 * equally harmless). `-c` beats repository-local configuration, so a
 * candidate-supplied `core.fsmonitor` hook, `core.hooksPath`, or untracked
 * cache can never be invoked while the gate enumerates or fingerprints the
 * source tree. `core.fsmonitor=false` is the flag the regression test proves
 * (a configured hook script is *not* executed when it is present).
 */
export const SOURCE_GIT_FLAGS = Object.freeze([
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.useBuiltinFSMonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "gc.auto=0",
]);

/** Per-invocation flags: the hardening set plus a gate-owned hooks directory. */
export function sourceGitArgs(args, hooksDir = null) {
  const flags = [...SOURCE_GIT_FLAGS];
  if (typeof hooksDir === "string" && hooksDir !== "") {
    flags.push("-c", `core.hooksPath=${hooksDir}`);
  }
  return [...flags, ...args];
}

function lstatOrNull(target) {
  try {
    return lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new GateFailure("fs", `cannot inspect ${JSON.stringify(target)}: ${error?.code ?? String(error)}`);
  }
}

function isInside(candidate, parent) {
  const child = path.resolve(candidate);
  const root = path.resolve(parent);
  return child !== root && child.startsWith(root + path.sep);
}

function comparePaths(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function readableStatus(text) {
  return boundTail(String(text).split("\0").join("\n"), 4096).text;
}

/**
 * Upper bound for a `package.json` this gate will read, in bytes, enforced
 * *before* any buffer is allocated. Real manifests are a few kilobytes; the
 * limit only exists so an absurd file cannot be slurped into memory.
 */
export const PACKAGE_JSON_MAX_BYTES = 256 * 1024;

/**
 * Read and validate `package.json`: identity, version, and safe bin targets.
 *
 * The file is read exactly once, through a bounded `O_NOFOLLOW` descriptor
 * (`readRegularFileBounded`): ordinary single-link regular file, pre/post
 * `fstat` identity/size/mode/link-count stability, strict UTF-8 JSON, and a
 * byte limit checked before allocation. The sha256 of *those bytes* is returned
 * as `packageJsonSha256`, which the gate binds to the candidate manifest and
 * to the committed clone's own read of `package.json`.
 *
 * Refusals name no path and disclose no content — a symlinked, hard-linked,
 * replaced, or oversized manifest is refused without revealing what it (or
 * whatever it points at) contains.
 *
 * `options` is test-only: `maxBytes` overrides the limit and `hook` is a seam
 * invoked at `after-lstat` / `after-open` / `after-pre` / `mid-read`.
 */
export function readPackageMetadata(repository = REPOSITORY, options = {}) {
  const file = path.join(repository, "package.json");
  const read = readRegularFileBounded(file, {
    step: "package",
    label: "package.json",
    maxBytes: Number.isInteger(options.maxBytes) ? options.maxBytes : PACKAGE_JSON_MAX_BYTES,
    hook: options.hook,
  });
  let pkg;
  try {
    pkg = JSON.parse(read.text);
  } catch {
    throw new GateFailure("package", "package.json is not valid JSON");
  }
  const { name, version, bin } = pkg ?? {};
  if (typeof name !== "string" || name === "") {
    throw new GateFailure("package", "package.json must declare a name");
  }
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new GateFailure("package", `package.json version ${JSON.stringify(version)} is not an exact semantic version`);
  }
  expectedTarballFilename(name, version); // rejects unsafe names before any work
  // Exact bin contract: exactly one entry, named `skill-router`, mapping to a
  // safe relative path. A string `bin` (even one npm would normalise to
  // `skill-router`), a missing key, an extra key in any position, or a
  // non-object all fail closed — the gate executes exactly
  // `node_modules/.bin/skill-router` and must be able to prove which file that
  // shim is, so "some other bin first, skill-router second" is not a shape it
  // can accept.
  const EXACT_BIN_NAME = "skill-router";
  if (bin === null || bin === undefined || typeof bin !== "object" || Array.isArray(bin)) {
    throw new GateFailure(
      "package",
      `package.json must declare exactly one object bin entry: {"${EXACT_BIN_NAME}": "<relative path>"} (a string or missing bin is not accepted)`,
    );
  }
  const binKeys = Object.keys(bin);
  if (binKeys.length === 0) {
    throw new GateFailure("package", `package.json must declare a bin entry so the installed CLI can be verified (expected exactly "${EXACT_BIN_NAME}")`);
  }
  if (binKeys.length !== 1 || binKeys[0] !== EXACT_BIN_NAME) {
    throw new GateFailure("package", `package.json bin must contain exactly one entry named "${EXACT_BIN_NAME}" (found ${JSON.stringify(binKeys)})`, [
      ["detail", "the gate executes exactly node_modules/.bin/skill-router; a missing, renamed, reordered, or additional bin entry cannot be verified"],
    ]);
  }
  const binMap = { [EXACT_BIN_NAME]: bin[EXACT_BIN_NAME] };
  const requiredFiles = ["package.json"];
  for (const [binName, target] of Object.entries(binMap)) {
    if (typeof target !== "string" || target === "") {
      throw new GateFailure("package", `bin entry ${JSON.stringify(binName)} is not a path`);
    }
    const normalized = target.replace(/^\.\//, "");
    const segments = normalized.split("/");
    if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || segments.some((part) => part === "" || part === "." || part === "..")) {
      throw new GateFailure("package", `bin entry ${JSON.stringify(binName)} has an unsafe path ${JSON.stringify(target)}`);
    }
    if (!requiredFiles.includes(normalized)) requiredFiles.push(normalized);
  }
  return {
    name,
    version,
    bin: binMap,
    requiredFiles,
    packageJson: pkg,
    packageJsonSha256: read.sha256,
    packageJsonBytes: read.size,
  };
}

/**
 * Private HOME/npm-cache/git-config/template/temp/hooks directories under
 * `root`, plus the scrubbed environment for every gate child. Recognized
 * credential-shaped, lifecycle, CI command-file, and external-tool-configuration
 * environment variables from the host are stripped (see `scrubEnvironment`)
 * and the gate supplies no write token of its own — hygiene for trusted
 * candidate tests, not a sandbox against code that can read the gate process.
 *
 * `TMPDIR`/`TMP`/`TEMP` point at a gate-owned directory inside the temp root:
 * children never inherit the ambient temp path, so a `TMPDIR` that (accidentally
 * or deliberately) points inside the source repository can never be written to,
 * and every temp file a child creates is removed with the temp root. The path is
 * validated as an ordinary, non-symlink directory created here.
 *
 * Path-length note: the temp root prefix (`TEMP_PREFIX`) and this `tmp`
 * component together add only a handful of characters to fixture paths created
 * under the gate-owned `TMPDIR`, because the gate's own `npm test` asserts a
 * 300-token budget on generated text that embeds those paths. Lengthening this
 * path is what previously pushed those assertions over their budget.
 */
export function createIsolationEnvironment(root, base = process.env) {
  const home = path.join(root, "home");
  const npmCache = path.join(root, "npm-cache");
  const gitConfig = path.join(root, "gitconfig");
  const templateDir = path.join(root, "git-template");
  const tempDir = path.join(root, "tmp");
  const hooksDir = path.join(root, "no-hooks");
  for (const directory of [home, npmCache, templateDir, tempDir, hooksDir]) {
    mkdirSync(directory, { recursive: true });
  }
  const rootStats = lstatOrNull(root);
  if (rootStats === null || rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new GateFailure("setup", `gate root must be an ordinary directory, never a link: ${JSON.stringify(root)}`);
  }
  const tempStats = lstatOrNull(tempDir);
  if (tempStats === null || tempStats.isSymbolicLink() || !tempStats.isDirectory()) {
    throw new GateFailure("setup", `gate temp directory must be an ordinary directory, never a link: ${JSON.stringify(tempDir)}`);
  }
  if (lstatOrNull(gitConfig) === null) writeFileSync(gitConfig, "");
  const env = scrubEnvironment(base, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    SKILL_ROUTER_HOME: home,
    [GATE_ENV_FLAG]: "1",
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_SYSTEM: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_cache: npmCache,
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_progress: "false",
    npm_config_loglevel: "warn",
  });
  return { root, home, npmCache, gitConfig, templateDir, tempDir, hooksDir, env };
}

async function gitStep(
  run,
  { command, args, cwd, env, label, timeoutMs = 60000, maxOutputChars = 8 * 1024 * 1024, hooksDir = null, forbiddenRoot = null, resolvedCommand = null },
) {
  const hardened = sourceGitArgs(args, hooksDir);
  const result = await run({ command, args: hardened, cwd, env, timeoutMs, maxOutputChars, forbiddenRoot, resolvedCommand });
  if (result.invalidEncoding) {
    throw new GateFailure(label, `\`git ${args.join(" ")}\` produced output that is not valid UTF-8`, [
      ["detail", "a candidate path is not valid UTF-8; refusing to enumerate with a corrupted path list (failing closed)"],
    ]);
  }
  if (!result.ok) {
    throw new GateFailure(label, `\`git ${args.join(" ")}\` failed`, [
      ["detail", result.timedOut ? `timed out after ${timeoutMs} ms` : (result.error ?? `exit ${result.code}`)],
      ["stderr", result.stderr, true],
      ["stdout", result.stdout, true],
    ]);
  }
  if (result.truncated) {
    throw new GateFailure(label, `\`git ${args.join(" ")}\` output exceeded the output bound; refusing to continue with partial data`);
  }
  return result;
}

/**
 * Ambient (host) environment for the ignore-semantics comparison: identical to
 * `base` except for the variables that would bind git to some other work tree
 * or index, which would make the comparison meaningless rather than hostile.
 */
function ambientGitEnv(base) {
  const bound = new Set([
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
    "GIT_IMPLICIT_WORK_TREE",
  ]);
  const env = {};
  for (const [key, value] of Object.entries(base ?? {})) {
    if (typeof value !== "string") continue;
    if (bound.has(key.toUpperCase())) continue;
    env[key] = value;
  }
  return env;
}

/** Prove the given path is the root of its work tree before enumerating it. */
export async function assertRepositoryRoot({ repository, run = runCommand, env = process.env, hooksDir = null, forbiddenRoot = null, resolvedCommand = null }) {
  const result = await gitStep(run, {
    command: "git",
    args: ["rev-parse", "--show-toplevel"],
    cwd: repository,
    env,
    label: "enumerate",
    hooksDir,
    forbiddenRoot,
    resolvedCommand,
  });
  const top = result.stdout.trim();
  let realTop;
  let realRepository;
  try {
    realTop = realpathSync(top);
    realRepository = realpathSync(repository);
  } catch (error) {
    throw new GateFailure("enumerate", `cannot resolve the repository root: ${error?.code ?? String(error)}`);
  }
  if (realTop !== realRepository) {
    throw new GateFailure("enumerate", `refusing to enumerate a sub-directory: ${realRepository} is not the work-tree root (${realTop})`);
  }
}

/**
 * Every candidate path git reports, decoded strictly (git `-z` bytes) and
 * sorted. Invalid UTF-8 fails closed inside `gitStep`.
 */
async function listCandidatePaths({ repository, run, env, hooksDir = null, forbiddenRoot = null, resolvedCommand = null, label = "enumerate" }) {
  const listed = await gitStep(run, {
    command: "git",
    args: ["ls-files", "--cached", "--others", "--exclude-standard", "--full-name", "-z", "--"],
    cwd: repository,
    env,
    label,
    hooksDir,
    forbiddenRoot,
    resolvedCommand,
  });
  return [...new Set(listed.stdout.split("\0").filter(Boolean))].sort(comparePaths);
}

/**
 * Candidate set: tracked plus untracked non-ignored regular files, sorted, plus
 * the complete manifest for every one of them (validated strict-UTF-8 path,
 * type, size, content SHA-256, normalized executable mode, link count). Deleted
 * tracked files are reported as `missing` (a candidate only exists if it is on
 * disk); symlinks, special files, hard links, and paths whose ancestors are not
 * ordinary directories all fail closed.
 *
 * When `ambientEnv` is given, the same enumeration is also run under the
 * caller's *host* git semantics and compared. If disabling the host's ignore
 * rules would add any file, the gate refuses before copying anything, with a
 * diagnostic that deliberately discloses neither a filename nor any content —
 * a host-level exclusion must be resolved in the repository's own `.gitignore`.
 */
export async function collectCandidates({ repository, run = runCommand, env = process.env, ambientEnv = null, hooksDir = null, forbiddenRoot = null, resolvedCommand = null }) {
  const rootStats = lstatOrNull(repository);
  if (rootStats === null || rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new GateFailure("enumerate", "the repository root must be an ordinary directory, never a link");
  }
  await assertRepositoryRoot({ repository, run, env, hooksDir, forbiddenRoot, resolvedCommand });
  const paths = await listCandidatePaths({ repository, run, env, hooksDir, forbiddenRoot, resolvedCommand });
  if (ambientEnv !== null && ambientEnv !== undefined) {
    const ambientPaths = await listCandidatePaths({ repository, run, env: ambientGitEnv(ambientEnv), hooksDir, forbiddenRoot, resolvedCommand, label: "enumerate" });
    const isolatedOnly = paths.filter((entry) => !ambientPaths.includes(entry));
    const ambientOnly = ambientPaths.filter((entry) => !paths.includes(entry));
    if (isolatedOnly.length > 0) {
      throw new GateFailure("enumerate", "host git ignore configuration hides files that deterministic enumeration would include", [
        ["detail", `${isolatedOnly.length} additional file(s) would become candidates once the host's ignore rules are disabled`],
        ["detail", "add those paths to the repository's own .gitignore (or remove the host-level exclusion) and re-run the gate"],
        ["detail", "filenames and contents are deliberately not disclosed by this refusal"],
      ]);
    }
    if (ambientOnly.length > 0) {
      throw new GateFailure("enumerate", "ambient and isolated git ignore semantics disagree in the other direction", [
        ["detail", `${ambientOnly.length} file(s) are enumerated only under the host configuration; refusing a non-deterministic candidate set`],
      ]);
    }
  }
  if (paths.length === 0) {
    throw new GateFailure("enumerate", "no candidate files found; refusing to build an empty candidate repository");
  }
  const files = [];
  const missing = [];
  for (const relative of paths) {
    const absolute = path.join(repository, relative);
    if (isInside(absolute, repository) === false) {
      throw new GateFailure("enumerate", `candidate escapes the repository root: ${JSON.stringify(relative)}`);
    }
    const stats = lstatOrNull(absolute);
    if (stats === null) {
      missing.push(relative);
      continue;
    }
    files.push(relative);
  }
  if (files.length === 0) {
    throw new GateFailure("enumerate", "every candidate is absent from the working tree; refusing to continue");
  }
  const manifest = await buildCandidateManifest({ repository, files });
  return { files, missing, listed: paths.length, manifest };
}

/**
 * Every ancestor of `relative` below `repository` must be an ordinary,
 * non-symlink directory, so no candidate path can be reached through a link
 * that points somewhere else. Stops at the first absent component (a deleted
 * candidate's ancestors are still validated on the way down).
 */
function assertOrdinaryAncestors(repository, relative, label = "enumerate") {
  const segments = String(relative).split("/").filter((segment) => segment !== "");
  let current = repository;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = path.join(current, segments[index]);
    const stats = lstatOrNull(current);
    if (stats === null) break; // absent ancestor — nothing to follow
    if (stats.isSymbolicLink()) {
      throw new GateFailure(label, `path crosses a symbolic link: ${JSON.stringify(segments.slice(0, index + 1).join("/"))}`, [
        ["detail", "every ancestor below the canonical boundary must be an ordinary directory"],
      ]);
    }
    if (!stats.isDirectory()) {
      throw new GateFailure(label, `path ancestor is not an ordinary directory: ${JSON.stringify(segments.slice(0, index + 1).join("/"))}`);
    }
  }
}

/**
 * Complete manifest entry for one candidate: validated UTF-8 path, type, size,
 * content SHA-256, normalized executable mode, permission bits, link count, and
 * dev:ino identity. Hashing happens through `sha256File` (no-follow descriptor,
 * pre/post fstat stability, digest verified twice), and the stat is taken
 * before *and* after the hash so a mutation during the read fails closed.
 */
async function manifestEntry(repository, relative) {
  const absolute = path.join(repository, relative);
  if (isInside(absolute, repository) === false) {
    throw new GateFailure("enumerate", `candidate escapes the repository root: ${JSON.stringify(relative)}`);
  }
  assertOrdinaryAncestors(repository, relative);
  const before = lstatOrNull(absolute);
  if (before === null) return null; // deleted tracked file: reported as missing
  if (before.isSymbolicLink()) {
    throw new GateFailure("enumerate", `refusing symlink candidate: ${JSON.stringify(relative)}`, [
      ["detail", "a candidate must be a regular file so a link cannot pull outside content into the clone"],
    ]);
  }
  if (!before.isFile()) {
    throw new GateFailure("enumerate", `candidate is not a regular file: ${JSON.stringify(relative)}`);
  }
  if (before.nlink > 1) {
    throw new GateFailure("enumerate", `refusing hard-linked candidate: ${JSON.stringify(relative)}`, [
      ["detail", `link count is ${before.nlink}; another path could rewrite this content outside the gate`],
    ]);
  }
  const sha256 = await sha256File(absolute, { step: "enumerate" });
  const after = lstatOrNull(absolute);
  if (after === null || after.isSymbolicLink() || !after.isFile()) {
    throw new GateFailure("enumerate", `candidate changed type while it was being hashed: ${JSON.stringify(relative)}`);
  }
  const record = fileRecord(after);
  const previous = fileRecord(before);
  if (record.size !== previous.size || record.mode !== previous.mode || record.nlink !== previous.nlink) {
    throw new GateFailure("enumerate", `candidate changed while it was being hashed: ${JSON.stringify(relative)}`, [
      ["detail", `size ${previous.size} -> ${record.size}, mode ${previous.mode} -> ${record.mode}, links ${previous.nlink} -> ${record.nlink}`],
    ]);
  }
  return {
    path: relative,
    type: record.type,
    size: record.size,
    sha256,
    mode: record.mode,
    perm: record.perm,
    nlink: record.nlink,
    identity: inodeIdentity(after),
  };
}

/**
 * Manifest for the whole candidate set (existing files only; absent files are
 * the caller's `missing` list). Sorted by path so two runs are comparable.
 */
export async function buildCandidateManifest({ repository, files }) {
  const entries = [];
  for (const relative of [...files].sort(comparePaths)) {
    const entry = await manifestEntry(repository, relative);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

/** Field-by-field manifest comparison; returns bounded, human-readable drift. */
export function compareCandidateManifests(baseline, current) {
  const before = new Map((baseline ?? []).map((entry) => [entry.path, entry]));
  const after = new Map((current ?? []).map((entry) => [entry.path, entry]));
  const drift = [];
  for (const path of after.keys()) {
    if (!before.has(path)) drift.push(`added: ${path}`);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) drift.push(`removed: ${path}`);
  }
  for (const [path, expected] of before) {
    const actual = after.get(path);
    if (actual === undefined) continue;
    const fields = [];
    for (const key of ["type", "size", "sha256", "mode", "perm", "nlink"]) {
      if (actual[key] !== expected[key]) fields.push(`${key} ${JSON.stringify(expected[key])} -> ${JSON.stringify(actual[key])}`);
    }
    if (expected.identity !== null && actual.identity !== null && expected.identity !== actual.identity) {
      fields.push(`identity ${expected.identity} -> ${actual.identity}`);
    }
    if (fields.length > 0) drift.push(`${path}: ${fields.join(", ")}`);
  }
  return drift.slice(0, 20);
}

/**
 * Re-enumerate and re-hash the source candidate set and compare it with the
 * manifest taken earlier. This is what catches tracked *and* untracked content
 * drift that leaves `git status` byte-identical (same-size rewrites, executable
 * bit flips, file replacement), plus files that appear or disappear.
 */
export async function assertSourceUnchanged({
  repository,
  files,
  baseline,
  run = runCommand,
  env = process.env,
  hooksDir = null,
  forbiddenRoot = null,
  resolvedCommand = null,
  label = "state",
}) {
  const paths = await listCandidatePaths({ repository, run, env, hooksDir, forbiddenRoot, resolvedCommand });
  const drift = [];
  const expectedPaths = [...files].sort(comparePaths);
  if (paths.join("\n") !== expectedPaths.join("\n")) {
    // A path git reports that is *not* part of the candidate file set is
    // acceptable only while it stays absent from disk: that is a tracked file
    // the caller already reported as missing. Anything else appeared (or
    // reappeared) during the run.
    const added = paths.filter(
      (entry) => !expectedPaths.includes(entry) && lstatOrNull(path.join(repository, entry)) !== null,
    );
    const removed = expectedPaths.filter((entry) => !paths.includes(entry));
    if (added.length > 0) drift.push(`added paths: ${added.slice(0, 10).join(", ")}`);
    if (removed.length > 0) drift.push(`removed paths: ${removed.slice(0, 10).join(", ")}`);
  }
  const current = await buildCandidateManifest({ repository, files: paths });
  drift.push(...compareCandidateManifests(baseline, current));
  if (drift.length > 0) {
    throw new GateFailure(label, "the source candidate set changed during the gate run", [
      ["drift", drift.join("\n")],
      ["detail", "content drift is reported from the manifest even when `git status` is byte-identical"],
    ]);
  }
  return true;
}

/**
 * Copy one candidate into the temporary repository without following links:
 * an `O_NOFOLLOW` descriptor, a single-link regular file, stable pre/post
 * fstat, digest equivalence between source and copy, and an exact match
 * against the manifest entry recorded at enumeration time.
 */
function copyCandidate(repository, destination, relative, baseline = null) {
  const source = path.join(repository, relative);
  const target = path.join(destination, relative);
  if (!isInside(target, destination)) {
    throw new GateFailure("build", `candidate path escapes the temporary repository: ${JSON.stringify(relative)}`);
  }
  assertOrdinaryAncestors(repository, relative);
  const before = lstatOrNull(source);
  if (before === null || before.isSymbolicLink() || !before.isFile()) {
    throw new GateFailure("build", `candidate is no longer a regular file: ${JSON.stringify(relative)}`);
  }
  if (before.nlink > 1) {
    throw new GateFailure("build", `candidate is hard-linked (${before.nlink} links): ${JSON.stringify(relative)}`);
  }
  mkdirSync(path.dirname(target), { recursive: true });
  const record = copyRegularFileNoFollow({ source, target, step: "build" });
  if (baseline !== null) {
    if (record.size !== baseline.size || record.sha256 !== baseline.sha256) {
      throw new GateFailure("build", `candidate changed between enumeration and copy: ${JSON.stringify(relative)}`, [
        ["detail", `manifest size ${baseline.size} sha256 ${baseline.sha256}`],
        ["detail", `copied size ${record.size} sha256 ${record.sha256}`],
      ]);
    }
    if (record.mode !== baseline.mode) {
      throw new GateFailure("build", `candidate mode changed between enumeration and copy: ${JSON.stringify(relative)}`, [
        ["detail", `manifest mode ${baseline.mode.toString(8)}, copied mode ${record.mode.toString(8)}`],
      ]);
    }
  }
  return record;
}

/**
 * Copy the candidate set into a brand-new git repository, commit it there, and
 * verify that exactly the enumerated files were committed — then re-enumerate
 * and re-hash the *source* to prove nothing moved while the copy was running.
 * The real index is never touched: every git command runs with `cwd` inside
 * `destination`.
 */
export async function buildCandidateRepository({
  repository,
  files,
  destination,
  env = process.env,
  run = runCommand,
  templateDir = null,
  baseline = null,
  hooksDir = null,
  forbiddenRoot = null,
  resolvedCommand = null,
}) {
  if (files.length === 0) {
    throw new GateFailure("build", "no candidate files to copy");
  }
  if (lstatOrNull(destination) !== null) {
    throw new GateFailure("build", `refusing to reuse an existing directory: ${destination}`);
  }
  if (isInside(destination, repository)) {
    throw new GateFailure("build", "the temporary candidate repository must be outside the real repository");
  }
  const manifest = Array.isArray(baseline) && baseline.length > 0 ? baseline : await buildCandidateManifest({ repository, files });
  const byPath = new Map(manifest.map((entry) => [entry.path, entry]));
  mkdirSync(destination, { recursive: true });
  if (templateDir !== null) {
    mkdirSync(templateDir, { recursive: true });
  }
  try {
    for (const relative of files) {
      copyCandidate(repository, destination, relative, byPath.get(relative) ?? null);
    }
    const git = (args, label = "build") => gitStep(run, { command: "git", args, cwd: destination, env, label, hooksDir, forbiddenRoot, resolvedCommand });
    const initArgs = ["-c", "init.defaultBranch=main", "init", "--quiet"];
    if (templateDir !== null) initArgs.push(`--template=${templateDir}`);
    await git(initArgs);
    // `--force` keeps a candidate that happens to match a gitignore rule (a
    // tracked-but-ignored file) in the candidate repository; the equality check
    // below still requires exactly the enumerated set.
    await git(["add", "--all", "--force", "--"]);
    await git([
      "-c",
      "user.name=skill-router clean-candidate gate",
      "-c",
      "user.email=gate@localhost.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--no-verify",
      "-m",
      "clean-candidate gate",
    ]);
    const committed = await git(["ls-files", "-z", "--full-name"], "build");
    const actual = committed.stdout.split("\0").filter(Boolean).sort(comparePaths);
    const expected = [...files].sort(comparePaths);
    if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
      const unexpected = actual.filter((entry) => !expected.includes(entry)).slice(0, 5);
      const absent = expected.filter((entry) => !actual.includes(entry)).slice(0, 5);
      throw new GateFailure("build", "committed candidate repository differs from the enumerated candidate set", [
        ["detail", `expected ${expected.length} files, committed ${actual.length}`],
        ["unexpected", unexpected.join("\n") || "(none)"],
        ["absent", absent.join("\n") || "(none)"],
      ]);
    }
    // Proof 1 of 2: the source has not moved since the manifest was taken.
    await assertSourceUnchanged({
      repository,
      files,
      baseline: manifest,
      run,
      env,
      hooksDir,
      forbiddenRoot,
      resolvedCommand,
      label: "build",
    });
    return { destination, count: actual.length, manifest };
  } catch (error) {
    // A refused build never leaves a partial candidate repository behind.
    try {
      rmSync(destination, { recursive: true, force: true });
    } catch {
      /* the caller's cleanup reports the leftover */
    }
    throw error;
  }
}

/**
 * Clone the candidate repository into a second directory, prove it clean and
 * exactly the candidate set, and verify the staged modes: `100755` exactly where
 * the manifest says the file is executable, `100644` everywhere else (that is
 * how an executable bit — or its loss — would otherwise slip through).
 */
export async function cloneCandidateRepository({ source, destination, files, env = process.env, run = runCommand, baseline = null, hooksDir = null }) {
  if (lstatOrNull(destination) !== null) {
    throw new GateFailure("clone", `refusing to reuse an existing directory: ${destination}`);
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  await gitStep(run, {
    command: "git",
    args: ["clone", "--quiet", "--no-local", source, destination],
    cwd: path.dirname(destination),
    env,
    label: "clone",
    timeoutMs: 120000,
    hooksDir,
  });
  const status = await gitStep(run, {
    command: "git",
    args: ["--no-optional-locks", "status", "--porcelain=v1", "-z", "-uall"],
    cwd: destination,
    env,
    label: "clone",
    hooksDir,
  });
  if (status.stdout !== "") {
    throw new GateFailure("clone", "the candidate clone is not a clean work tree", [["status", readableStatus(status.stdout)]]);
  }
  const listed = await gitStep(run, { command: "git", args: ["ls-files", "-z", "--full-name"], cwd: destination, env, label: "clone", hooksDir });
  const actual = listed.stdout.split("\0").filter(Boolean).sort(comparePaths);
  const expected = [...files].sort(comparePaths);
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
    throw new GateFailure("clone", "the clean clone does not contain exactly the candidate set", [
      ["detail", `expected ${expected.length} files, clone has ${actual.length}`],
    ]);
  }
  const staged = await gitStep(run, { command: "git", args: ["ls-files", "--stage", "-z"], cwd: destination, env, label: "clone", hooksDir });
  const modes = new Map();
  for (const record of staged.stdout.split("\0").filter(Boolean)) {
    const match = /^(\d{6})\s+[0-9a-f]{40,64}\s+\d+\t(.+)$/.exec(record);
    if (match === null) {
      throw new GateFailure("clone", "cannot parse the staged mode list of the candidate clone", [["record", boundTail(record, 200).text]]);
    }
    modes.set(match[2], match[1]);
  }
  const expectedModes = new Map((baseline ?? []).map((entry) => [entry.path, entry.mode === 0o755 ? "100755" : "100644"]));
  for (const file of expected) {
    const mode = modes.get(file);
    if (mode !== "100644" && mode !== "100755") {
      throw new GateFailure("clone", `unexpected staged mode for ${JSON.stringify(file)}: ${JSON.stringify(mode)}`);
    }
    const wanted = expectedModes.get(file);
    if (wanted !== undefined && mode !== wanted) {
      throw new GateFailure("clone", `executable bit was not preserved for ${JSON.stringify(file)}`, [
        ["detail", `manifest expects ${wanted}, clone has ${mode}`],
      ]);
    }
  }
  return { destination, count: actual.length };
}

/** Bound for a `.git` gitfile: they are a single `gitdir:` line, nothing more. */
const GITFILE_MAX_BYTES = 4096;

/** Resolve `target` to a canonical path and re-prove it an ordinary directory. */
function canonicalDirectory(target, what) {
  let canonical;
  try {
    canonical = realpathSync(target);
  } catch (error) {
    throw new GateFailure("state", `${what} cannot be resolved (${error?.code ?? String(error)})`);
  }
  const stats = lstatOrNull(canonical);
  if (stats === null || stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new GateFailure("state", `${what} does not resolve to an ordinary directory`);
  }
  return canonical;
}

/**
 * Resolve the repository's git directory, refusing anything that is not an
 * ordinary directory:
 * - `.git` missing → `null` (no repository metadata at all);
 * - `.git` a symlink or a special file (FIFO, socket, device) → fail closed;
 * - `.git` an ordinary directory → canonicalized with `realpath` and re-proved
 *   to be an ordinary directory, so a symlinked *ancestor* is resolved rather
 *   than trusted as spelled;
 * - `.git` a file → the gitfile is read through a bounded `O_NOFOLLOW`
 *   descriptor (strict UTF-8, ≤ `GITFILE_MAX_BYTES`, single line), must be
 *   exactly `gitdir: <path>` (absolute or relative to the repository), and the
 *   declared gitdir must canonicalize to an ordinary directory. Malformed,
 *   dangling, or swapped gitfiles fail closed instead of being guessed at.
 *
 * The returned path is canonical and is the *only* base the index fingerprint
 * is ever derived from.
 */
function canonicalGitDirectory(repository) {
  const dotGit = path.join(repository, ".git");
  const dot = lstatOrNull(dotGit);
  if (dot === null) return null;
  if (dot.isSymbolicLink()) {
    throw new GateFailure("state", ".git must be an ordinary directory or a gitfile, never a symbolic link");
  }
  if (dot.isDirectory()) {
    return canonicalDirectory(dotGit, ".git");
  }
  if (!dot.isFile()) {
    throw new GateFailure("state", ".git must be an ordinary directory or a gitfile, not a special file");
  }
  const gitfile = readRegularFileBounded(dotGit, { step: "state", label: ".git", maxBytes: GITFILE_MAX_BYTES });
  const body = gitfile.text.endsWith("\n") ? gitfile.text.slice(0, -1) : gitfile.text;
  if (body.includes("\n") || body.includes("\r") || body.includes("\u0000")) {
    throw new GateFailure("state", ".git is a malformed gitfile (expected exactly one `gitdir:` line)");
  }
  const match = /^gitdir:[ \t]*(.+)$/.exec(body);
  if (match === null || match[1].trim() === "") {
    throw new GateFailure("state", ".git is a malformed gitfile (expected a `gitdir:` line)");
  }
  const declared = path.resolve(repository, match[1].trim());
  return canonicalDirectory(declared, "the gitfile's gitdir");
}

/**
 * Identity of the real `.git/index` — hashed, not just statted: a gate that
 * staged, reset, or rewrote the index would change its bytes while leaving
 * size and mtime plausible. `dev:ino`/`mtime` are deliberately *not* compared
 * (git may rewrite an identical index), the content digest is.
 *
 * The index is only ever read from the canonical git directory proven above,
 * through `sha256File` (no-follow open, pre/post fstat, single-link policy,
 * digest computed twice). An absent index is legitimate and normal — a fresh
 * `git init` repository has no `.git/index` until the first `git add` — so
 * "absent" fingerprints as `null` rather than an error.
 */
async function indexPathIdentity(repository) {
  const gitdir = canonicalGitDirectory(repository);
  if (gitdir === null) return null;
  const indexFile = path.join(gitdir, "index");
  const stats = lstatOrNull(indexFile);
  if (stats === null) return null; // ordinary fresh/unborn repository: no index yet
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new GateFailure("state", "the git index is not a regular file; refusing to fingerprint it");
  }
  if (stats.nlink > 1) {
    throw new GateFailure("state", "the git index is hard-linked; refusing to fingerprint it");
  }
  const sha256 = await sha256File(indexFile, { step: "state", maxLinkCount: 1 });
  const after = lstatOrNull(indexFile);
  if (after === null || after.isSymbolicLink() || !after.isFile() || after.size !== stats.size) {
    throw new GateFailure("state", "the git index changed while it was being fingerprinted; refusing to continue");
  }
  return { size: after.size, sha256 };
}

/**
 * Exact HEAD fingerprint of the source repository: the symbolic ref (or `null`
 * when HEAD is detached), whether HEAD is detached, the resolved commit id (or
 * `null` when the branch is unborn), and an `unborn` flag.
 *
 * Safety properties:
 * - only `git symbolic-ref -q HEAD` and `git rev-parse --verify --quiet HEAD`
 *   are used, both read-only, both prefixed with `SOURCE_GIT_FLAGS` (fsmonitor,
 *   hooks, untracked caches and other external git behaviours disabled) and run
 *   in the gate's isolated git configuration, so no host config, hook, or
 *   template can influence the answer;
 * - "no commit id yet" (unborn branch) is accepted *only* for git's documented
 *   quiet-unknown-revision answer: exit code 1 with no signal, no spawn error,
 *   no timeout, no truncation, and valid UTF-8. Exit 128, a spawn error, a
 *   signal, a timeout, or invalid/partial output are all treated as "HEAD
 *   cannot be determined" and fail closed rather than being read as unborn;
 * - output is strictly UTF-8 (invalid bytes fail closed) and the object id must
 *   match a full hex oid, so nothing but a real id can enter the fingerprint;
 * - the fingerprint is compared structurally and its *values* are never placed
 *   in diagnostics: ref names, object ids, and paths stay out of failure text.
 *
 * This is what catches a commit, a branch move, a checkout, or a detach that
 * leaves `git status`, the index bytes, and the top-level entries untouched.
 */
async function readHeadState({ repository, run = runCommand, env = process.env, hooksDir = null, forbiddenRoot = null, resolvedCommand = null }) {
  const invoke = (args) =>
    run({
      command: "git",
      args: sourceGitArgs(args, hooksDir),
      cwd: repository,
      env,
      timeoutMs: 60000,
      maxOutputChars: 4096,
      forbiddenRoot,
      resolvedCommand,
    });
  const assertDecoded = (result, what) => {
    if (result.invalidEncoding) {
      throw new GateFailure("state", `${what} is not valid UTF-8; refusing to fingerprint HEAD`);
    }
    if (result.truncated) {
      throw new GateFailure("state", `${what} exceeded the output bound; refusing to fingerprint a partial value`);
    }
  };
  const failureDetail = (result) =>
    result.error ?? (result.timedOut ? "timed out" : `exit ${result.code}${result.signal ? ` signal ${result.signal}` : ""}`);
  const cannotDetermine = (result) =>
    new GateFailure("state", "cannot determine HEAD for this repository; refusing to fingerprint state", [["detail", failureDetail(result)]]);
  // git's documented exit code for `rev-parse --verify --quiet` (and for
  // `symbolic-ref -q` when HEAD is not symbolic): quiet "no such object".
  const QUIET_NO_OBJECT = 1;
  const isQuietNoObject = (result) =>
    result.ok === false &&
    result.code === QUIET_NO_OBJECT &&
    result.signal === null &&
    result.error === null &&
    result.timedOut === false &&
    result.invalidEncoding !== true &&
    result.truncated !== true;
  const oidFrom = (result, { allowMissing }) => {
    assertDecoded(result, "the HEAD commit id");
    if (result.ok === true) {
      const oid = result.stdout.trim();
      if (!/^[0-9a-f]{40,64}$/.test(oid)) {
        throw new GateFailure("state", "git reported something other than a full commit id for HEAD");
      }
      return oid;
    }
    if (allowMissing && isQuietNoObject(result)) return null; // unborn branch, exactly as git documents it
    throw cannotDetermine(result);
  };

  const symbolic = await invoke(["symbolic-ref", "-q", "HEAD"]);
  assertDecoded(symbolic, "the HEAD ref name");
  if (!symbolic.ok) {
    // With `-q`, exit 1 is git's documented answer for "HEAD is not a symbolic
    // ref" (detached HEAD). Exit 128, a spawn error, a signal, a timeout, or
    // truncated/invalid output are not that answer and fail closed.
    if (!isQuietNoObject(symbolic)) {
      throw cannotDetermine(symbolic);
    }
    const detachedOid = await invoke(["rev-parse", "--verify", "--quiet", "HEAD"]);
    return { symbolic: null, detached: true, oid: oidFrom(detachedOid, { allowMissing: false }), unborn: false };
  }
  const refName = symbolic.stdout.trim();
  if (refName === "" || /[\r\n\u0000]/.test(refName)) {
    throw new GateFailure("state", "git reported an unusable HEAD ref name; refusing to fingerprint state");
  }
  const resolved = await invoke(["rev-parse", "--verify", "--quiet", "HEAD"]);
  const oid = oidFrom(resolved, { allowMissing: true });
  return { symbolic: refName, detached: false, oid, unborn: oid === null };
}

/** The only fields ever compared (or named) for HEAD. */
const HEAD_FIELDS = ["symbolic", "detached", "oid", "unborn"];

/**
 * Read-only repository fingerprint: the git layout (`.git` must be an ordinary
 * directory or a well-formed gitfile) and the *hashed* contents of its index,
 * status (with optional locks disabled so git cannot refresh the index), the
 * exact HEAD state, and the top-level entries. Used to prove the gate never
 * mutates the real repository — an index rewrite with plausible metadata still
 * changes the digest, a status-identical content edit is caught by the
 * candidate manifest, and a commit or ref move is caught by `head`.
 *
 * The layout/index check runs first so a symlinked, special, or malformed
 * `.git` is always reported by *this* code with a deterministic message,
 * instead of depending on how git words its own error for the same condition.
 */
export async function repositoryState({
  repository,
  run = runCommand,
  env = process.env,
  includeRootEntries = true,
  hooksDir = null,
  forbiddenRoot = null,
  resolvedCommand = null,
}) {
  const source = { repository, run, env, hooksDir, forbiddenRoot, resolvedCommand };
  const index = await indexPathIdentity(repository);
  const status = await gitStep(run, {
    command: "git",
    args: ["--no-optional-locks", "status", "--porcelain=v1", "-z", "-uall"],
    cwd: repository,
    env,
    label: "state",
    maxOutputChars: 4 * 1024 * 1024,
    hooksDir,
    forbiddenRoot,
    resolvedCommand,
  });
  let rootEntries = null;
  if (includeRootEntries) {
    rootEntries = readdirSync(repository).sort(comparePaths);
  }
  const head = await readHeadState(source);
  return { status: status.stdout, index, head, rootEntries };
}

/** Fail closed if any part of the repository fingerprint moved. */
export function assertRepositoryStateUnchanged(before, after) {
  const changedHead = HEAD_FIELDS.filter((field) => (before?.head?.[field] ?? null) !== (after?.head?.[field] ?? null));
  if (changedHead.length > 0) {
    throw new GateFailure("state", "repository HEAD moved during the gate run (the gate must never create, move, or detach HEAD)", [
      ["detail", `changed fields: ${changedHead.join(", ")}`],
      ["detail", "ref names, object ids, and paths are deliberately not disclosed here"],
    ]);
  }
  if (before.status !== after.status) {
    throw new GateFailure("state", "repository status changed during the gate run", [
      ["before", readableStatus(before.status)],
      ["after", readableStatus(after.status)],
    ]);
  }
  if (JSON.stringify(before.index) !== JSON.stringify(after.index)) {
    throw new GateFailure("state", "the git index was modified during the gate run (the real index must never be staged or rewritten)", [
      ["before", JSON.stringify(before.index)],
      ["after", JSON.stringify(after.index)],
    ]);
  }
  if (before.rootEntries !== null && after.rootEntries !== null && before.rootEntries.join("\n") !== after.rootEntries.join("\n")) {
    const added = after.rootEntries.filter((entry) => !before.rootEntries.includes(entry));
    const removed = before.rootEntries.filter((entry) => !after.rootEntries.includes(entry));
    throw new GateFailure("state", "repository top-level entries changed during the gate run", [
      ["added", added.join("\n") || "(none)"],
      ["removed", removed.join("\n") || "(none)"],
    ]);
  }
  return true;
}

function assertBudget(deadline, label) {
  if (Date.now() >= deadline) {
    throw new GateFailure("gate", `time budget exhausted before step "${label}"; failing closed`, [
      ["detail", "raise the budget only if a slower machine legitimately needs it"],
    ]);
  }
}

function remainingBudget(deadline, fallback) {
  return Math.max(1000, Math.min(fallback, deadline - Date.now()));
}

async function runStep({ label, command, args, cwd, env, run, deadline, timeoutMs = STEP_TIMEOUT_MS, forbiddenRoot = null, resolvedCommand = null }) {
  assertBudget(deadline, label);
  const budget = remainingBudget(deadline, timeoutMs);
  const result = await run({ command, args, cwd, env, timeoutMs: budget, forbiddenRoot, resolvedCommand });
  if (!result.ok) {
    const details = [
      [
        "detail",
        result.timedOut
          ? `command timed out after ${budget} ms`
          : (result.error ?? `exit ${result.code}${result.signal ? ` signal ${result.signal}` : ""}`),
      ],
      ["cwd", String(cwd)],
      ["stderr", result.stderr, true],
      ["stdout", result.stdout, true],
    ];
    if (result.invalidEncoding) details.push(["detail", "child output was not valid UTF-8 and was refused"]);
    if (result.truncated) details.push(["detail", "child output was truncated to the output bound (tail kept)"]);
    if (result.survived) details.push(["detail", "child process group survived SIGKILL; refusing to continue"]);
    throw new GateFailure(label, `\`${command} ${args.join(" ")}\` failed`, details);
  }
  if (result.survived) {
    throw new GateFailure(label, `child process group survived SIGKILL after \`${command} ${args.join(" ")}\``);
  }
  return result;
}

/**
 * The temp parent must be an existing, ordinary (non-symlink) directory whose
 * canonical path is outside the canonical repository. Symlinks are refused
 * outright: a link would let the temp root — and everything a child writes into
 * it — land somewhere the caller never chose.
 *
 * Returns `{ path, canonical }`: `path` is the caller's own spelling (resolved,
 * not canonicalised) and is where the root is created and later scanned,
 * because canonicalising the *creation* path would prepend the platform's
 * symlink prefix (e.g. `/private` on macOS) to every child's gate-owned
 * `TMPDIR` and push path-budget assertions in the suite over their limit.
 * `canonical` is the realpath, used for the containment proof.
 */
function resolveTempParent(tmpParent, repository) {
  if (typeof tmpParent !== "string" || tmpParent === "") {
    throw new GateFailure("setup", "a temporary parent directory is required");
  }
  const stats = lstatOrNull(tmpParent);
  if (stats === null) {
    throw new GateFailure("setup", `temporary directory ${tmpParent} does not exist`);
  }
  if (stats.isSymbolicLink()) {
    throw new GateFailure("setup", `temporary directory ${tmpParent} is a symbolic link; the gate only accepts an ordinary directory`);
  }
  if (!stats.isDirectory()) {
    throw new GateFailure("setup", `temporary directory ${tmpParent} is not an ordinary directory`);
  }
  let canonicalParent;
  let canonicalRepository;
  try {
    canonicalParent = realpathSync(tmpParent);
    canonicalRepository = realpathSync(repository);
  } catch (error) {
    throw new GateFailure("setup", `cannot canonicalize the temporary directory or repository: ${error?.code ?? String(error)}`);
  }
  const resolved = path.resolve(tmpParent);
  if (canonicalParent === canonicalRepository || isInside(canonicalParent, canonicalRepository)) {
    throw new GateFailure("setup", `temporary directory ${tmpParent} must be outside the repository ${repository}`);
  }
  if (isInside(resolved, path.resolve(repository)) || resolved === path.resolve(repository)) {
    throw new GateFailure("setup", `temporary directory ${tmpParent} must be outside the repository ${repository}`);
  }
  return { path: resolved, canonical: canonicalParent, canonicalRepository };
}

/**
 * Records every entry a pack produced in a caller-owned artifact directory so
 * a later failure can remove exactly what this run created — by identity, never
 * by name alone.
 */
function recordPackEntries(packDir) {
  const records = [];
  for (const name of readdirSync(packDir)) {
    const target = path.join(packDir, name);
    const stats = lstatOrNull(target);
    if (stats === null) continue;
    records.push({ name, path: target, dev: stats.dev, ino: stats.ino, size: stats.size });
  }
  return records;
}

function removeRecordedArtifacts(records) {
  const problems = [];
  let removed = 0;
  for (const record of records) {
    const stats = lstatOrNull(record.path);
    if (stats === null) continue; // already gone
    if (stats.isSymbolicLink() || !stats.isFile()) {
      problems.push(`${record.name}: no longer a regular file; refusing to remove something this run may not own`);
      continue;
    }
    if (stats.dev !== record.dev || stats.ino !== record.ino || stats.size !== record.size) {
      problems.push(`${record.name}: identity drifted (dev ${record.dev} ino ${record.ino} size ${record.size} -> dev ${stats.dev} ino ${stats.ino} size ${stats.size}); refusing to remove it`);
      continue;
    }
    try {
      unlinkSync(record.path);
    } catch (error) {
      problems.push(`${record.name}: cannot be removed (${error?.code ?? String(error)})`);
      continue;
    }
    if (lstatOrNull(record.path) !== null) {
      problems.push(`${record.name}: still present after removal`);
    } else {
      removed += 1;
    }
  }
  return { removed, problems };
}

/**
 * Prove the temp root is gone: the path must be absent, and — where inode
 * identity exists — no entry in its direct parent may carry the root's
 * dev:ino, which is how a renamed or hard-linked same-inode root would survive
 * an apparently successful `rm`. Fails closed whenever removal cannot be
 * proven. Portable limit: without inode semantics only path absence is proven.
 */
export function verifyTempRootRemoval({ parent, root, identity = null }) {
  const remaining = lstatOrNull(root);
  if (remaining !== null) {
    throw new GateFailure("cleanup", `leftover temporary directory after the gate: ${root}`);
  }
  if (identity === null || identity === undefined) {
    return { proven: true, note: "no inode identity on this platform; proven by path absence only" };
  }
  let entries;
  try {
    entries = readdirSync(parent);
  } catch (error) {
    throw new GateFailure("cleanup", `cannot scan the temporary parent ${parent}: ${error?.code ?? String(error)}`);
  }
  if (entries.length > 10000) {
    throw new GateFailure("cleanup", `cannot prove removal: the temporary parent holds ${entries.length} entries (scan bound exceeded)`);
  }
  const leftovers = [];
  for (const name of entries) {
    const stats = lstatOrNull(path.join(parent, name));
    if (stats === null) continue;
    if (inodeIdentity(stats) === identity) leftovers.push(name);
  }
  if (leftovers.length > 0) {
    throw new GateFailure("cleanup", "the temporary root survives under a renamed path", [
      ["leftovers", leftovers.join("\n")],
      ["detail", `same inode ${identity} still exists in ${parent}`],
    ]);
  }
  return { proven: true, note: "path absent and no renamed same-inode entry in the temporary parent" };
}

/** Merge extra failures into one failure that keeps the primary step/message. */
function combineFailures(primary, extras) {
  const additional = extras.filter((entry) => entry instanceof Error);
  if (additional.length === 0) return primary;
  const base = primary instanceof Error ? primary : new Error(String(primary));
  const details = [...(base.details ?? [])];
  for (const extra of additional) {
    const step = extra.step ?? "gate";
    details.push([`${step} failure`, boundTail(String(extra.message ?? extra), 4000).text]);
    for (const detail of (extra.details ?? []).slice(0, 8)) {
      details.push([`${step}: ${String(detail[0] ?? "detail")}`, boundTail(String(detail[1] ?? ""), 4000).text]);
    }
  }
  return new GateFailure(base.step ?? "gate", base.message ?? String(base), details.slice(0, 60));
}

/**
 * Run the whole gate.
 *
 * Throws a bounded `GateFailure` on any violation and, in every case (success
 * or failure), performs the same `finally` sequence: re-enumerate and re-hash
 * the source candidates, compare the repository fingerprint, remove any pack
 * artifact this run created in a caller-owned directory, remove the temp root,
 * and prove that removal by inode. Primary, drift, and cleanup diagnostics are
 * all preserved in the thrown failure.
 */
export async function runGate(options = {}) {
  const {
    repository = REPOSITORY,
    env = process.env,
    tmpParent = tmpdir(),
    artifactDir = null,
    budgetMs = GATE_TIMEOUT_MS,
    run = runCommand,
  } = options;

  assertNoNestedGate(env, repository, REPOSITORY);
  if (typeof repository !== "string" || repository === "") {
    throw new GateFailure("gate", "a repository path is required");
  }
  // Canonical, non-symlink, outside the repository — validated *before* the
  // temp root exists, so a refusal leaves nothing behind.
  const tempParent = resolveTempParent(tmpParent, repository);
  // Resolve both tools to canonical absolute paths before any candidate
  // directory can become a child's cwd: relative/empty PATH components and
  // repository-local fakes are refused here, up front.
  const toolEnv = scrubEnvironment(env);
  const tools = {
    git: resolveExecutable("git", { env: toolEnv, forbiddenRoot: repository, step: "setup" }),
    npm: resolveExecutable("npm", { env: toolEnv, forbiddenRoot: repository, step: "setup" }),
  };
  // Read and validate `package.json` *before* anything is created: a refused
  // manifest (missing, symlinked, hard-linked, non-regular, oversized, or
  // malformed) must fail with zero temp-root or build mutation, and the digest
  // of this exact read is what the manifest and the clone are bound to below.
  const metadata = readPackageMetadata(repository);

  const startedAt = Date.now();
  let root;
  try {
    root = mkdtempSync(path.join(tempParent.path, TEMP_PREFIX));
  } catch (error) {
    throw new GateFailure("setup", `cannot create a temporary root under ${tempParent.path}: ${error?.code ?? String(error)}`);
  }
  const rootIdentity = inodeIdentity(lstatOrNull(root));

  let failure = null;
  let summary = null;
  let before = null;
  let candidates = null;
  let baseline = null;
  let childEnv = null;
  let hooksDir = null;
  const artifactRecords = [];
  try {
    const isolation = createIsolationEnvironment(root, env);
    childEnv = isolation.env;
    hooksDir = isolation.hooksDir;
    const deadline = startedAt + Math.max(0, budgetMs);
    const sourceCommands = {
      run,
      env: childEnv,
      hooksDir,
      forbiddenRoot: repository,
      resolvedCommand: tools.git,
    };

    before = await repositoryState({ repository, ...sourceCommands });
    candidates = await collectCandidates({ repository, ...sourceCommands, ambientEnv: env });
    baseline = candidates.manifest;
    if (!candidates.files.includes("package.json")) {
      throw new GateFailure("package", "package.json is missing from the candidate manifest; package metadata cannot be bound to the committed snapshot");
    }
    const packageEntry = candidates.manifest.find((entry) => entry.path === "package.json");
    if (packageEntry.sha256 !== metadata.packageJsonSha256) {
      // The manifest hashes the candidate through `sha256File` (no-follow,
      // single-link, digest computed twice) while the metadata read used its
      // own bounded no-follow read; both must be the same bytes, or
      // `package.json` moved between the two reads.
      throw new GateFailure("package", "package.json changed between the metadata read and the candidate manifest", [
        ["detail", "refusing to bind package metadata to a file that is still moving"],
        ["metadata", metadata.packageJsonSha256],
        ["manifest", packageEntry.sha256],
      ]);
    }
    if (!candidates.files.includes("package-lock.json")) {
      throw new GateFailure("package", "package-lock.json is missing from the candidate set; `npm ci` cannot run without it", [
        ["detail", "commit or un-ignore the lockfile: CI and this gate both require an exact dependency lock"],
      ]);
    }

    const workRoot = path.join(root, "work");
    mkdirSync(workRoot, { recursive: true });
    const candidateRepo = path.join(workRoot, "repo");
    await buildCandidateRepository({
      repository,
      files: candidates.files,
      destination: candidateRepo,
      ...sourceCommands,
      templateDir: path.join(workRoot, "git-template"),
      baseline,
    });
    const cloneRoot = path.join(workRoot, "clone");
    await cloneCandidateRepository({
      source: candidateRepo,
      destination: cloneRoot,
      files: candidates.files,
      ...sourceCommands,
      baseline,
    });

    // Bind package metadata to the committed clone snapshot: same identity,
    // and byte-for-byte the same `package.json` as the read the gate validated
    // (both sides go through `readPackageMetadata`, which returns the digest
    // of its own bounded, no-follow read).
    const cloneMetadata = readPackageMetadata(cloneRoot);
    if (
      cloneMetadata.name !== metadata.name ||
      cloneMetadata.version !== metadata.version ||
      JSON.stringify(cloneMetadata.bin) !== JSON.stringify(metadata.bin)
    ) {
      throw new GateFailure("package", "the committed package.json does not match the source package metadata", [
        ["source", `${metadata.name}@${metadata.version} ${JSON.stringify(metadata.bin)}`],
        ["clone", `${cloneMetadata.name}@${cloneMetadata.version} ${JSON.stringify(cloneMetadata.bin)}`],
      ]);
    }
    if (cloneMetadata.packageJsonSha256 !== metadata.packageJsonSha256) {
      throw new GateFailure("package", "the committed package.json bytes do not match the source package.json read", [
        ["source", metadata.packageJsonSha256],
        ["clone", cloneMetadata.packageJsonSha256],
      ]);
    }

    const executed = [];
    for (const step of GATE_STEPS) {
      await runStep({ label: step.label, command: step.command, args: step.args, cwd: cloneRoot, env: childEnv, run, deadline, forbiddenRoot: repository, resolvedCommand: tools.npm });
      executed.push(step.label);
    }

    // Artifact directory: either the caller's (release) or a temp one that the
    // cleanup below removes. It must be an empty directory so no stale file
    // can be mistaken for a freshly validated artifact, and its ancestors must
    // be ordinary directories inside a boundary the gate can prove.
    let packDir = path.join(root, "pack");
    const externalArtifact = artifactDir !== null;
    if (externalArtifact) {
      const stats = lstatOrNull(artifactDir);
      if (stats === null || !stats.isDirectory() || stats.isSymbolicLink()) {
        throw new GateFailure("pack", `artifact directory must be an existing directory: ${artifactDir}`);
      }
      if (readdirSync(artifactDir).length !== 0) {
        throw new GateFailure("pack", `artifact directory must be empty before packing: ${artifactDir}`);
      }
      if (isInside(artifactDir, root)) {
        throw new GateFailure("pack", "artifact directory must be outside the temporary root");
      }
      const resolvedArtifact = path.resolve(artifactDir);
      const resolvedRepository = path.resolve(repository);
      const ancestorBase = isInside(resolvedArtifact, resolvedRepository)
        ? resolvedRepository
        : isInside(resolvedArtifact, tempParent.canonicalRepository)
          ? tempParent.canonicalRepository
          : isInside(resolvedArtifact, tempParent.path)
            ? tempParent.path
            : null;
      if (ancestorBase === null) {
        throw new GateFailure("pack", "artifact directory must live inside the repository or the gate's temp parent so its ancestors can be proven", [
          ["detail", resolvedArtifact],
        ]);
      }
      // Canonically validate the ancestors this scope controls: every component
      // from the proven boundary down to the artifact directory must be an
      // ordinary, non-symlink directory (this is what stops `dist` from being
      // swapped for a link between validation and packing).
      assertOrdinaryAncestors(ancestorBase, path.relative(ancestorBase, resolvedArtifact), "pack");
      packDir = artifactDir;
    } else {
      mkdirSync(packDir, { recursive: true });
    }

    assertBudget(deadline, "npm pack");
    const packed = await run({
      command: "npm",
      args: ["pack", "--json", "--pack-destination", packDir],
      cwd: cloneRoot,
      env: childEnv,
      timeoutMs: remainingBudget(deadline, STEP_TIMEOUT_MS),
      forbiddenRoot: repository,
      resolvedCommand: tools.npm,
    });
    if (externalArtifact) {
      // Everything that appeared in a provably empty, caller-owned directory
      // was created by this pack: record its identity so a later failure can
      // remove exactly this run's artifact (and nothing else).
      artifactRecords.push(...recordPackEntries(packDir));
    }
    if (!packed.ok) {
      throw new GateFailure("npm pack", "`npm pack` failed", [
        ["detail", packed.timedOut ? "timed out" : (packed.error ?? `exit ${packed.code}`)],
        ["stderr", packed.stderr, true],
        ["stdout", packed.stdout, true],
      ]);
    }
    if (packed.truncated) {
      throw new GateFailure("npm pack", "`npm pack` output exceeded the output bound; refusing to validate a partial file list");
    }
    if (packed.survived) {
      throw new GateFailure("npm pack", "child process group survived SIGKILL after `npm pack`");
    }
    const artifact = parsePackResult(packed.stdout, {
      name: metadata.name,
      version: metadata.version,
      requiredFiles: metadata.requiredFiles,
    });
    const tarballPath = path.join(packDir, artifact.filename);
    const tarballStats = lstatOrNull(tarballPath);
    if (tarballStats === null || !tarballStats.isFile() || tarballStats.isSymbolicLink()) {
      throw new GateFailure("npm pack", `packed tarball is missing or not a regular file: ${tarballPath}`);
    }
    const digest = await sha256File(tarballPath);
    executed.push("npm pack");

    // Fresh consumer project: lifecycle scripts disabled, then the installed
    // CLI must print exactly the package version.
    const consumerRoot = path.join(root, "consumer");
    mkdirSync(consumerRoot, { recursive: true });
    writeFileSync(
      path.join(consumerRoot, "package.json"),
      `${JSON.stringify({ name: "clean-candidate-consumer", version: "0.0.0", private: true }, null, 2)}\n`,
    );
    await runStep({
      label: "consumer install",
      command: "npm",
      args: ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath],
      cwd: consumerRoot,
      env: childEnv,
      run,
      deadline,
      forbiddenRoot: repository,
      resolvedCommand: tools.npm,
    });
    executed.push("consumer install");

    const installedRoot = path.join(consumerRoot, "node_modules", ...metadata.name.split("/"));
    let installed;
    try {
      installed = JSON.parse(
        readRegularFileBounded(path.join(installedRoot, "package.json"), {
          step: "consumer",
          label: "the installed package.json",
          maxBytes: PACKAGE_JSON_MAX_BYTES,
        }).text,
      );
    } catch (error) {
      throw error instanceof GateFailure
        ? error
        : new GateFailure("consumer", `installed package metadata is not valid JSON (${error?.code ?? String(error)})`);
    }
    if (installed?.name !== metadata.name || installed?.version !== metadata.version) {
      throw new GateFailure("consumer", `installed package is ${installed?.name}@${installed?.version}, expected ${metadata.name}@${metadata.version}`);
    }

    // Exactly `node_modules/.bin/skill-router` — the single bin key the package
    // metadata contract allows — and nothing else.
    const binName = Object.keys(metadata.bin)[0];
    if (binName !== "skill-router") {
      throw new GateFailure("consumer", `unexpected bin name ${JSON.stringify(binName)}; the gate executes exactly node_modules/.bin/skill-router`);
    }
    const binShim = path.join(consumerRoot, "node_modules", ".bin", process.platform === "win32" ? `${binName}.cmd` : binName);
    const shimStats = lstatOrNull(binShim);
    if (shimStats === null) {
      throw new GateFailure("consumer", `installed bin shim is missing: ${binShim}`);
    }
    const modulesRoot = realpathSync(path.join(consumerRoot, "node_modules"));
    const resolvedShim = realpathSync(binShim);
    if (isInside(resolvedShim, modulesRoot) === false) {
      throw new GateFailure("consumer", "the installed bin resolves outside the consumer node_modules; refusing to execute it", [
        ["detail", resolvedShim],
      ]);
    }
    const declaredTarget = path.join(installedRoot, metadata.bin[binName].replace(/^\.\//, ""));
    if (shimStats.isSymbolicLink()) {
      let expectedTarget = null;
      try {
        expectedTarget = realpathSync(declaredTarget);
      } catch (error) {
        throw new GateFailure("consumer", `the declared bin target is missing from the installed package: ${error?.code ?? String(error)}`);
      }
      if (resolvedShim !== expectedTarget) {
        throw new GateFailure("consumer", "the installed bin shim does not resolve to the package's declared bin target", [
          ["shim", resolvedShim],
          ["expected", expectedTarget],
        ]);
      }
    } else {
      const targetStats = lstatOrNull(declaredTarget);
      if (targetStats === null || targetStats.isSymbolicLink() || !targetStats.isFile()) {
        throw new GateFailure("consumer", "the declared bin target is missing or not a regular file in the installed package");
      }
    }
    const versionRun = await runStep({
      label: "installed skill-router --version",
      command: binShim,
      args: ["--version"],
      cwd: consumerRoot,
      env: childEnv,
      run,
      deadline,
      timeoutMs: 60000,
      forbiddenRoot: repository,
    });
    if (versionRun.stdout !== `${metadata.version}\n`) {
      throw new GateFailure("installed skill-router --version", "the installed CLI did not print exactly the package version", [
        ["expected", `${metadata.version}\\n`],
        ["stdout", versionRun.stdout, true],
        ["stderr", versionRun.stderr, true],
      ]);
    }
    if (versionRun.stderr !== "") {
      throw new GateFailure("installed skill-router --version", "the installed CLI wrote to stderr", [["stderr", versionRun.stderr, true]]);
    }
    executed.push(`installed ${binName} --version`);

    summary = {
      repository,
      candidates: { files: candidates.files.length, missing: candidates.missing, listed: candidates.listed },
      steps: executed,
      tarball: { filename: artifact.filename, sha256: digest, size: tarballStats.size, directory: artifactDir, files: artifact.files },
      consumer: { version: metadata.version, bin: binName },
      durationMs: Date.now() - startedAt,
      tempRoot: root,
    };
  } catch (error) {
    failure = error;
  }

  // ---- `finally`: reconciliation, artifact cleanup, proven temp removal ----
  const diagnostics = [];
  if (before !== null && candidates !== null && baseline !== null && childEnv !== null) {
    try {
      const after = await repositoryState({
        repository,
        run,
        env: childEnv,
        hooksDir,
        forbiddenRoot: repository,
        resolvedCommand: tools.git,
      });
      assertRepositoryStateUnchanged(before, after);
    } catch (error) {
      diagnostics.push(error);
    }
    try {
      // Proof 2 of 2: the source is re-enumerated and re-hashed on the way out,
      // success or failure, so drift cannot hide behind an unchanged status.
      await assertSourceUnchanged({
        repository,
        files: candidates.files,
        baseline,
        run,
        env: childEnv,
        hooksDir,
        forbiddenRoot: repository,
        resolvedCommand: tools.git,
        label: "state",
      });
    } catch (error) {
      diagnostics.push(error);
    }
  }
  const runFailed = failure !== null || diagnostics.length > 0;
  if (runFailed && artifactRecords.length > 0) {
    try {
      const { problems } = removeRecordedArtifacts(artifactRecords);
      if (problems.length > 0) {
        diagnostics.push(new GateFailure("cleanup", "a pack artifact created by this run could not be proven removed", [["leftovers", problems.join("\n")]]));
      }
    } catch (error) {
      // A failed artifact cleanup must never skip temp-root removal below.
      diagnostics.push(
        error instanceof GateFailure ? error : new GateFailure("cleanup", `artifact cleanup failed: ${error?.message ?? String(error)}`),
      );
    }
  }
  let cleanupFailure = null;
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    cleanupFailure = new GateFailure("cleanup", `cannot remove the temporary root ${root}: ${error?.code ?? String(error)}`);
  }
  if (cleanupFailure === null) {
    try {
      verifyTempRootRemoval({ parent: tempParent.path, root, identity: rootIdentity });
    } catch (error) {
      cleanupFailure = error;
    }
  }

  if (failure === null && diagnostics.length === 0 && cleanupFailure === null) {
    return summary;
  }
  if (cleanupFailure !== null) {
    throw combineFailures(cleanupFailure, [failure, ...diagnostics]);
  }
  const primary = failure ?? diagnostics[0];
  const rest = failure !== null ? diagnostics : diagnostics.slice(1);
  throw combineFailures(primary, rest);
}

/** One bounded success line — the only thing a passing gate prints. */
export function formatSummary(summary) {
  const missing = summary.candidates.missing.length > 0 ? `, ${summary.candidates.missing.length} absent` : "";
  return (
    `gate: clean | candidates ${summary.candidates.files}${missing} | steps ${summary.steps.join(" -> ")} | ` +
    `tarball ${summary.tarball.filename} sha256 ${summary.tarball.sha256} (${summary.tarball.size} bytes) | ` +
    `installed ${summary.consumer.bin} --version ${summary.consumer.version} | temp cleaned | ${(summary.durationMs / 1000).toFixed(1)}s`
  );
}

async function main() {
  const summary = await runGate({ repository: REPOSITORY, env: process.env });
  process.stdout.write(`${formatSummary(summary)}\n`);
}

/** Run only when invoked as a script, so tests can import the seams. */
function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return path.resolve(entry) === self;
  }
}

if (invokedDirectly()) {
  main().then(
    () => {
      process.exitCode = 0;
    },
    (error) => {
      process.stderr.write(formatGateFailure(error));
      process.exitCode = 1;
    },
  );
}
