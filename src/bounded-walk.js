// Bounded, no-follow filesystem traversal shared by every source, support
// tree, and generated-tree inspection the router performs on untrusted input.
//
// Fixed production limits — never user-configurable:
//
//   maxEntries    4096   observed entries per traversal (skipped names count)
//   maxDepth        32   nested directory levels, root included
//   maxFileBytes   16 MiB per bounded file read
//   maxTotalBytes  64 MiB charged across one shared budget
//
// Traversal streams through `opendir` (never an unbounded `readdir` material
// before the cap), is deterministic and lexical, never follows symlinks, and
// stops the moment a bound is exceeded: no entry observed after an overflow is
// ever handed to a callback, so no file after an entry/depth overflow is read.
// A directory that would exceed `maxDepth` is refused *before* it is reported
// to `onDirectory`, so a mirroring caller never creates it either.
//
// Every failure of a bound is a `BoundedWalkError` carrying exactly one stable
// reason enum (`entries`, `depth`, `file-bytes`, `total-bytes`) and a message
// with no path, name, or cause: a hostile tree can never make the router echo
// sensitive paths or unbounded text through a limit refusal.
//
// Replacement (TOCTOU) hardening: every directory — the root and every child —
// is lstat'ed before it is opened, opened, and lstat'ed again on the same path
// before a single entry is observed. A path that resolves to a symlink, a
// non-directory, or (where the filesystem reports strong dev/ino identity) a
// *different* directory than the one inspected fails closed with a
// `BoundedWalkUnsafeError` before any of its entries can reach a callback.
//
// Residual boundary, stated neutrally: Node exposes no `openat`/`O_PATH`/
// fd-relative directory open, so the post-open verification re-resolves the
// path. An asynchronous replacement (ABA) — swapped away before the open and
// restored before the post-open `lstat`, or swapped between the post-open
// verification and enumeration — is not observable by these pathname checks
// and is therefore out of scope here; the same holds for same-type directory
// swaps on filesystems that do not report a strong identity, where the pin
// degrades to type-stability checks only. Callers that need content-level
// certainty must keep relying on the per-file no-follow reads, which pin the
// opened file's identity and size across the read.
//
// Tests inject small limits through `createWalkBudget({ ...small })` and swap
// the `boundedWalkInternals.lstat`/`opendir` seams; the production entry
// points always use the fixed defaults exported here and the real primitives.
import { lstat, opendir } from "node:fs/promises";
import path from "node:path";
import { fileIdentity, identitiesEqual, isIdentityAvailable, readRegularFileNoFollow } from "./durable-fs.js";

/** The fixed production bounds. Frozen: no caller may widen them. */
export const BOUNDED_WALK_LIMITS = Object.freeze({
  maxEntries: 4096,
  maxDepth: 32,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
});

/** Source/support-tree names that are counted but never descended into. */
export const BOUNDED_WALK_SKIP_NAMES = Object.freeze([".git", "node_modules"]);

/** The complete, stable reason enum. Nothing else is ever a bound failure. */
export const BOUNDED_WALK_REASONS = Object.freeze(["entries", "depth", "file-bytes", "total-bytes"]);

const BOUNDED_WALK_REASON_SET = new Set(BOUNDED_WALK_REASONS);

/**
 * A bound was exceeded. `reason` is always one of `BOUNDED_WALK_REASONS`; the
 * message never names a path, file, directory, or underlying errno, so a
 * caller may surface it (or a fixed wrapper of it) to any diagnostic surface.
 */
export class BoundedWalkError extends Error {
  constructor(reason) {
    if (!BOUNDED_WALK_REASON_SET.has(reason)) {
      throw new TypeError(`BoundedWalkError requires a ${BOUNDED_WALK_REASONS.join("/")} reason`);
    }
    super(`Bounded filesystem traversal exceeded its ${reason} limit`);
    this.name = "BoundedWalkError";
    this.code = "BOUNDED_WALK_LIMIT";
    this.reason = reason;
  }
}

/** True only for a real bound failure; every other error stays distinguishable. */
export function isBoundedWalkLimit(error) {
  return (
    error instanceof BoundedWalkError ||
    (Boolean(error) && error.code === "BOUNDED_WALK_LIMIT" && BOUNDED_WALK_REASON_SET.has(error.reason))
  );
}

/**
 * A directory was not stable around its open: the path became a symlink, a
 * non-directory, or a different directory than the one inspected. Fail closed,
 * never follow, and never report an entry from the replaced directory. The
 * message is fixed and path-free for the same reason bound messages are.
 */
export class BoundedWalkUnsafeError extends Error {
  constructor() {
    super("Bounded filesystem traversal observed a replaced directory");
    this.name = "BoundedWalkUnsafeError";
    this.code = "BOUNDED_WALK_UNSAFE";
  }
}

/** True only for a replacement refusal. */
export function isBoundedWalkUnsafe(error) {
  return error instanceof BoundedWalkUnsafeError || (Boolean(error) && error.code === "BOUNDED_WALK_UNSAFE");
}

/**
 * Narrow deterministic-injection seam for the traversal's own primitives.
 * Tests wrap `lstat`/`opendir` to force a root or child replacement at the
 * exact moment the walker opens it; production callers must treat these as
 * read-only.
 */
export const boundedWalkInternals = {
  lstat: (target) => lstat(target),
  opendir: (target) => opendir(target),
};

function normalizeLimits(limits) {
  const merged = { ...BOUNDED_WALK_LIMITS, ...(limits ?? {}) };
  for (const key of Object.keys(BOUNDED_WALK_LIMITS)) {
    if (!Number.isSafeInteger(merged[key]) || merged[key] < 0) {
      throw new TypeError(`${key} must be a non-negative safe integer`);
    }
  }
  return Object.freeze(merged);
}

/**
 * One traversal budget: the effective limits plus the aggregate bytes actually
 * read so far. Callers share a single budget across a walk and the reads that
 * follow it so entries, per-file bytes, and aggregate bytes are all decided by
 * one bounded view of the same tree.
 */
export function createWalkBudget(limits) {
  return { limits: normalizeLimits(limits), bytesRead: 0 };
}

/**
 * Bounded, no-follow read of one regular file, charging the *actual* bytes
 * read against the file and aggregate budgets. Type safety, change detection
 * (identity and size across the read), symlink refusal, and the oversize guard
 * reuse the trusted durable-fs primitive; only the two byte bounds are mapped
 * onto path-free `BoundedWalkError`s here. Anything else (missing file,
 * permission failure, a swap to a symlink or special file mid-read) propagates
 * unchanged so callers keep their own, existing diagnostics for those cases.
 */
export async function readBoundedFile(file, budget) {
  const active = budget ?? createWalkBudget();
  let content;
  try {
    content = await readRegularFileNoFollow(file, { maxBytes: active.limits.maxFileBytes });
  } catch (error) {
    if (error?.code === "EFBIG") throw new BoundedWalkError("file-bytes");
    throw error;
  }
  const total = active.bytesRead + content.length;
  if (total > active.limits.maxTotalBytes) throw new BoundedWalkError("total-bytes");
  active.bytesRead = total;
  return content;
}

/** Lexical, locale-independent sibling order: the same tree always walks the same way. */
function compareDirents(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Streaming, cap-enforced, lexically sorted enumeration of one directory with
 * a stable open:
 *
 * - `priorStat` is the caller's own lstat of the same path, taken before the
 *   open. It must be a non-symlink directory.
 * - The directory is opened, then the *same path* is lstat'ed again before a
 *   single entry is read: a symlink or non-directory now, or a strong
 *   identity that no longer matches `priorStat`, fails closed with
 *   `BoundedWalkUnsafeError`. Enumeration never starts on an unverified open.
 * - Entries stream through the directory handle and `observe(dirent)` runs for
 *   each one as it is observed; a throwing `observe` abandons the iterator, so
 *   a directory over the caller's cap is never fully materialized.
 * - The returned entries are sorted in deterministic code-unit lexical order.
 *
 * `options.lstat`/`options.open` are narrow injection seams mirroring
 * `boundedWalkInternals`; production callers pass nothing.
 */
export async function enumerateDirectory(directory, options = {}) {
  const priorStat = options.priorStat;
  if (!priorStat || typeof priorStat !== "object" || typeof priorStat.isDirectory !== "function") {
    throw new TypeError("enumerateDirectory requires a prior lstat observation of the same path");
  }
  if (priorStat.isSymbolicLink() || !priorStat.isDirectory()) throw new BoundedWalkUnsafeError();
  const lstatPath = typeof options.lstat === "function" ? options.lstat : boundedWalkInternals.lstat;
  const openDirectory = typeof options.open === "function" ? options.open : boundedWalkInternals.opendir;
  const observe = typeof options.observe === "function" ? options.observe : null;

  const priorIdentity = fileIdentity(priorStat);
  // Identity pinning applies where the filesystem reports a strong dev/ino
  // pair; where it does not, the type re-checks still refuse symlink and
  // non-directory replacements (documented platform residual).
  const pinned = isIdentityAvailable(priorIdentity);

  const handle = await openDirectory(directory);
  try {
    let after;
    try {
      after = await lstatPath(directory);
    } catch {
      throw new BoundedWalkUnsafeError();
    }
    if (after.isSymbolicLink() || !after.isDirectory()) throw new BoundedWalkUnsafeError();
    const afterIdentity = fileIdentity(after);
    if (pinned && (!isIdentityAvailable(afterIdentity) || !identitiesEqual(priorIdentity, afterIdentity))) {
      throw new BoundedWalkUnsafeError();
    }
    const dirents = [];
    for await (const dirent of handle) {
      // Observed one at a time; the iterator is abandoned on the first
      // throwing observation, so the rest of a huge directory is never read.
      if (observe) observe(dirent);
      dirents.push(dirent);
    }
    dirents.sort(compareDirents);
    return dirents;
  } finally {
    try {
      await handle.close();
    } catch {
      // The async iterator already closed the handle; a second close is a no-op.
    }
  }
}

/** lstat a child directory just before descent; a wrong or vanished type is a replacement. */
async function statChildDirectory(absolute) {
  let stat;
  try {
    stat = await boundedWalkInternals.lstat(absolute);
  } catch {
    throw new BoundedWalkUnsafeError();
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new BoundedWalkUnsafeError();
  return stat;
}

/**
 * Deterministic, bounded, no-follow traversal of one directory tree.
 *
 * - Streams `opendir` and stops observing the moment the entry cap is
 *   exceeded; an unbounded directory read is never performed.
 * - Visits siblings in lexical (code-unit) order, depth first.
 * - Never follows symlinks: a symlink entry is only ever reported through
 *   `onSymlink` (or silently skipped when no callback is given).
 * - Counts every observed entry, including entries under skipped names
 *   (`.git`, `node_modules` by default) whose subtrees are never opened.
 * - `skipNames`/`skip` decide before typing, so a skipped entry is never
 *   opened, read, or classified.
 * - `onFile`/`onDirectory`/`onSymlink`/`onSpecial` receive
 *   `{ name, absolute, relative }` (`relative` is `/`-separated and
 *   root-relative). `onDirectory` runs before the directory is entered, so a
 *   copier can mirror empty directories too — but never for a directory whose
 *   descent would break `maxDepth`: the depth bound is refused *before* the
 *   directory is reported. A throwing callback aborts the traversal with that
 *   error; callbacks run at most once per observed entry and never for an
 *   entry observed after an overflow.
 * - The root itself must be a real directory, never a symlink, and every
 *   opened directory (root and children) is verified stable around its open;
 *   a replacement fails closed with `BoundedWalkUnsafeError` before any of its
 *   entries can reach a callback.
 *
 * Returns `{ entries, bytesRead, limits }`; `bytesRead` is the budget's
 * cumulative total, so a caller that also reads through `readBoundedFile`
 * sees one combined figure.
 */
export async function boundedWalk(root, options = {}) {
  if (typeof root !== "string" || root === "") throw new TypeError("boundedWalk requires a path");
  const budget = options.budget ?? createWalkBudget(options.limits);
  const limits = budget.limits;
  const skipNames = new Set(options.skipNames ?? BOUNDED_WALK_SKIP_NAMES);
  const skip = typeof options.skip === "function" ? options.skip : null;
  const onFile = typeof options.onFile === "function" ? options.onFile : null;
  const onDirectory = typeof options.onDirectory === "function" ? options.onDirectory : null;
  const onSymlink = typeof options.onSymlink === "function" ? options.onSymlink : null;
  const onSpecial = typeof options.onSpecial === "function" ? options.onSpecial : null;

  const rootStat = await boundedWalkInternals.lstat(root);
  if (rootStat.isSymbolicLink()) throw new Error("Refusing to walk a symbolic-link root");
  if (!rootStat.isDirectory()) throw new Error("Refusing to walk a non-directory root");

  let entries = 0;
  const observe = () => {
    entries += 1;
    if (entries > limits.maxEntries) throw new BoundedWalkError("entries");
  };

  const visit = async (directory, relativeDirectory, depth, priorStat) => {
    if (depth > limits.maxDepth) throw new BoundedWalkError("depth");
    const dirents = await enumerateDirectory(directory, { priorStat, observe });
    for (const dirent of dirents) {
      const absolute = path.join(directory, dirent.name);
      const relative = relativeDirectory ? `${relativeDirectory}/${dirent.name}` : dirent.name;
      const entry = { name: dirent.name, absolute, relative };
      if (skipNames.has(dirent.name)) continue;
      if (skip && (await skip(entry, dirent))) continue;
      if (dirent.isSymbolicLink()) {
        if (onSymlink) await onSymlink(entry);
        continue;
      }
      if (dirent.isDirectory()) {
        // The depth bound is refused before the directory is reported or
        // entered, so an overflowing directory is never mirrored by a caller.
        if (depth + 1 > limits.maxDepth) throw new BoundedWalkError("depth");
        // Re-typed immediately before descent: a directory observed by the
        // parent that is now a symlink, a file, or gone fails closed here.
        const childStat = await statChildDirectory(absolute);
        // Reported before the directory is entered, so a caller mirroring a
        // tree can create the destination directory even when it is empty.
        if (onDirectory) await onDirectory(entry);
        await visit(absolute, relative, depth + 1, childStat);
        continue;
      }
      if (dirent.isFile()) {
        if (onFile) await onFile(entry);
        continue;
      }
      if (onSpecial) await onSpecial(entry);
    }
  };

  await visit(root, "", 1, rootStat);
  return Object.freeze({ entries, bytesRead: budget.bytesRead, limits });
}
