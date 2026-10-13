// Test-only process isolation for `test/claude.test.js`.
//
// Why this exists
// ---------------
// That file exercises Claude marketplace declaration files. Two of the paths
// those declarations live on are derived from the ambient environment:
//
//   user scope   → `CLAUDE_CONFIG_DIR ?? $HOME/.claude/settings.json`
//   every fixture → child processes inherit `HOME`
//
// Without isolation a full-suite run resolves those paths to the *host* Claude
// configuration, so this test file shares state with the host Claude process
// and with every other test worker. The isolation helper therefore snapshots
// the host files it could otherwise reach, replaces the ambient environment
// with a private temp directory, and byte-compares the host files afterwards.
//
// When it runs
// ------------
// `test/claude.test.js` imports this module *first*, and ES module evaluation
// follows import order, so the snapshot and the environment override happen
// before any other import body or test in that file executes. When the suite
// runner executes this file directly (everything under `test/` is treated as a
// test file) it deliberately does nothing, so the helper has no side effects
// of its own — it only exports.
//
// Cleanup safety
// --------------
// The private root is removed only after proving, with `lstat` (never a
// following `stat`), that it is an ordinary directory whose realpath stays
// inside the realpath of the OS temp directory and whose name carries this
// helper's prefix; the removal is a recursive `rm` (which unlinks rather than
// follows symlinks) followed by an absence check. A violation throws instead
// of removing anything.

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after } from "node:test";

const SELF = fileURLToPath(import.meta.url);
const ROOT_PREFIX = "skill-router-claude-home-";
/** Declaration file names that host Claude configuration may contain. */
const HOST_FILES = ["settings.json", "settings.local.json"];

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(SELF);
  } catch {
    return path.resolve(entry) === SELF;
  }
}

function lstatOrNull(target) {
  try {
    return lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Content identity of one path, never following a symlink for its *type*
 * (a link, its target bytes, and its target name are all recorded so a host
 * swap is visible either way).
 */
export function fingerprint(target) {
  let stats;
  try {
    stats = lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    return { exists: false, observationError: String(error?.code ?? error) };
  }
  if (stats.isSymbolicLink()) {
    const record = { exists: true, kind: "symlink" };
    try {
      record.linkTarget = readlinkSync(target);
    } catch (error) {
      record.linkTarget = `unreadable:${String(error?.code ?? error)}`;
    }
    try {
      const bytes = readFileSync(target);
      record.size = bytes.length;
      record.sha256 = sha256(bytes);
    } catch (error) {
      record.sha256 = `unreadable:${String(error?.code ?? error)}`;
    }
    return record;
  }
  if (stats.isDirectory()) return { exists: true, kind: "directory" };
  if (!stats.isFile()) return { exists: true, kind: "other" };
  const bytes = readFileSync(target);
  return { exists: true, kind: "file", size: bytes.length, sha256: sha256(bytes) };
}

/** Every host Claude path this file could otherwise resolve to. */
function hostDeclarationFiles(original, cwd) {
  const roots = [];
  if (original.CLAUDE_CONFIG_DIR) roots.push(path.resolve(original.CLAUDE_CONFIG_DIR));
  roots.push(path.resolve(original.HOME ?? homedir(), ".claude"));
  roots.push(path.resolve(cwd, ".claude"));
  const files = [];
  for (const root of [...new Set(roots)]) {
    for (const name of HOST_FILES) {
      const file = path.join(root, name);
      if (!files.some((entry) => entry.file === file)) files.push({ file, before: fingerprint(file) });
    }
  }
  return files;
}

/**
 * Fail closed if any host file this file could have touched changed shape or
 * bytes while the tests ran. An external writer (for example the host Claude
 * process rewriting its own settings) is indistinguishable from this file
 * reaching host state, so both are reported as a failure rather than ignored.
 */
export function assertHostClaudeStateUnchanged(files) {
  for (const entry of files) {
    const after = fingerprint(entry.file);
    if (JSON.stringify(after) !== JSON.stringify(entry.before)) {
      throw new Error(
        `host Claude state changed while test/claude.test.js ran: ${entry.file}\n` +
          `  before: ${JSON.stringify(entry.before)}\n` +
          `  after:  ${JSON.stringify(after)}\n` +
          "  either this test file reached host state, or an external process (for example the " +
          "Claude app) wrote it; failing closed instead of hiding the difference",
      );
    }
  }
  return true;
}

/** Remove this helper's private root, refusing anything that is not it. */
export function removeIsolationRoot(root) {
  const stats = lstatOrNull(root);
  if (stats === null) return false;
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`refusing to remove the isolation root ${root}: not an ordinary directory (lstat)`);
  }
  const base = realpathSync(tmpdir());
  const real = realpathSync(root);
  if (real !== base && !real.startsWith(base + path.sep)) {
    throw new Error(`refusing to remove the isolation root ${root}: it resolves outside ${base} (${real})`);
  }
  if (!path.basename(real).startsWith(ROOT_PREFIX)) {
    throw new Error(`refusing to remove the isolation root ${root}: unexpected name ${path.basename(real)}`);
  }
  rmSync(root, { recursive: true, force: true });
  if (lstatOrNull(root) !== null) {
    throw new Error(`leftover isolation root after cleanup: ${root}`);
  }
  return true;
}

function install() {
  const original = {
    HOME: process.env.HOME ?? null,
    USERPROFILE: process.env.USERPROFILE ?? null,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? null,
    SKILL_ROUTER_HOME: process.env.SKILL_ROUTER_HOME ?? null,
  };
  const hostHomedir = homedir();
  const hostFiles = hostDeclarationFiles(original, process.cwd());

  const root = mkdtempSync(path.join(tmpdir(), ROOT_PREFIX));
  const home = path.join(root, "home");
  const claudeConfig = path.join(root, "claude-config");
  for (const directory of [home, claudeConfig, path.join(home, ".config"), path.join(home, "router-home")]) {
    mkdirSync(directory, { recursive: true });
  }

  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.SKILL_ROUTER_HOME = path.join(home, "router-home");
  // A pre-existing CLAUDE_CONFIG_DIR is redirected into the private root. When
  // the host has none, it stays unset so the `$HOME/.claude` fallback keeps
  // being exercised — HOME now points at the private home, so that fallback is
  // private too.
  const claudeConfigRedirected = original.CLAUDE_CONFIG_DIR !== null;
  if (claudeConfigRedirected) process.env.CLAUDE_CONFIG_DIR = claudeConfig;

  const isolation = {
    installed: true,
    root,
    home,
    claudeConfig,
    claudeConfigRedirected,
    original,
    hostHomedir,
    hostFiles,
    assertHostClaudeStateUnchanged: () => assertHostClaudeStateUnchanged(hostFiles),
    removeRoot: () => removeIsolationRoot(root),
  };

  after(() => {
    try {
      assertHostClaudeStateUnchanged(hostFiles);
    } finally {
      removeIsolationRoot(root);
    }
  });

  return isolation;
}

/** Null when this file is executed directly by the suite runner. */
export const claudeTestIsolation = invokedDirectly() ? null : install();

/** True when `child` lies inside `parent` (string comparison, no I/O). */
export function isInsidePath(child, parent) {
  if (typeof child !== "string" || typeof parent !== "string") return false;
  const base = path.resolve(parent);
  const target = path.resolve(child);
  return target !== base && target.startsWith(base + path.sep);
}
