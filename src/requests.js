// Owner-private request spool primitives (Phase 7 foundation).
//
// Callers pass an exact directory path: nothing here resolves, derives, or
// creates parent directories. The spool is a POSIX privacy boundary — a
// current-user-owned, non-symlink directory that is exactly 0700 and carries an
// owner-only regular marker. Creating or repairing an empty current-owned
// directory is safe and idempotent; a nonempty unmarked directory is never
// adopted. Where the platform reports no POSIX uid/mode semantics the owner
// checks degrade to the checks the platform can actually prove; this module
// makes no Windows enforcement claim, and Phase 14 refuses the spool API on an
// unsupported runtime (win32) before any filesystem effect — see
// `src/platform.js`.
//
// File identity is centralized in `src/durable-fs.js`: every spool, marker,
// entry, and claim decision that could rename or unlink compares a *strong*
// dev/ino identity (`available` tag), and an entry or directory this
// filesystem cannot prove fails closed with the stable
// `REQUEST-IDENTITY-UNAVAILABLE` code. Consumption therefore never renames or
// unlinks an unprovable entry, and claims are only ever created on a spool
// whose own identity was proven first.
//
// Names in a spool (exact grammars, all bounded by `REQUEST_MAX_ENTRIES`):
//   public  `<32 lowercase hex>.txt`          — harness ingress
//   claim   `.claim.<token>.<32 hex nonce>`   — hidden one-time consumer name
//   marker  `.skill-router-spool`             — ownership marker
// Claim enumeration matches only the exact grammar, so look-alike names are
// unknown entries: they are never counted as claims and never deleted.
//
// `consumeRequest` is a dedicated bounded one-time consumer intended to run
// under an existing controlled-read lease (it takes no lock of its own). It
// supports a stable spool plus an optional legacy directory: the stable spool
// wins only when the legacy directory has no entry for the same token, and a
// token present in both locations, a public entry beside a claim, or multiple
// claims are all ambiguity — nothing is renamed, read, or removed.
//
// Consumption order for a public entry:
//   validate spool + entry -> open O_RDONLY|O_NOFOLLOW -> fstat the same fd
//   (regular, current owner, nlink 1, size <= 100000, strong identity) ->
//   re-verify the public path identity -> rename to a random same-directory
//   claim -> fsync directory -> verify claim identity equals the fd -> fchmod
//   0600 and verify -> read at most 100001 bytes through the fd -> strict UTF-8
//   decode -> reject empty or whitespace-only bodies exactly like routing ->
//   re-fstat and re-verify identity/type/owner/link/size -> `route(request)` ->
//   re-verify the exact claim identity -> rename the claim to a fresh nonce
//   (the atomic consume step) -> re-verify identity -> rename once more to a
//   fresh removal claim, re-verify type + strong identity twice, unlink only
//   that verified claim -> fsync directory -> return the callback result.
//
// Delivery contract: every failure after the first rename preserves the exact
// claim (chmod, read, decode, route, identity, rename, unlink), a replacement
// that appears at the public path is never removed, and only one concurrent
// consumer can succeed. Removal goes through an atomic rename(2) before the
// unlink(2) because some platforms let two overlapping unlink(2) calls on the
// same path both report success; renaming one source has exactly one winner,
// so the loser fails closed and at most one delivery is returned. A successful
// unlink followed by a directory-fsync failure is the documented at-most-once
// boundary: the request is consumed and the callback result is discarded, so a
// retry reports absence and the caller resubmits.
//
// Errors are a fixed bounded set (`RequestSpoolError`): request bytes, tokens,
// paths, digests, errno text, and underlying causes never reach callers. The
// one distinct refusal is the shared platform guard, which throws the stable
// `PlatformUnsupportedError` (`PLATFORM_UNSUPPORTED`) before any argument or
// filesystem work on an unsupported runtime.
//
// `requestSpoolInternals` is a narrow injection seam so tests can force
// deterministic rename/chmod/read/fsync/unlink failures, identity swaps, and
// growth or truncation without weakening production defaults.
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  fileIdentity,
  identitiesEqual,
  isIdentityAvailable,
  identityRecord,
  readRegularFileNoFollow,
} from "./durable-fs.js";
import { assertSupportedRuntimePlatform } from "./platform.js";

const O_RDONLY = fsConstants.O_RDONLY;
const O_WRONLY = fsConstants.O_WRONLY;
const O_CREAT = fsConstants.O_CREAT;
const O_EXCL = fsConstants.O_EXCL;
const O_DIRECTORY = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
const O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;

/** Largest accepted request body, in bytes. */
export const REQUEST_MAX_BYTES = 100_000;
/** Bound on every directory scan: total entries, marker included. */
export const REQUEST_MAX_ENTRIES = 512;
/** The only accepted spool directory mode. */
export const REQUEST_SPOOL_MODE = 0o700;
/** Claim files are normalized to this mode before any body byte is read. */
export const REQUEST_ENTRY_MODE = 0o600;
/** Owner-only mode applied to the spool marker. */
export const REQUEST_MARKER_MODE = 0o600;
/** Hidden ownership marker written by `setupRequestSpool`. */
export const REQUEST_MARKER_NAME = ".skill-router-spool";

const TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const CLAIM_PATTERN = /^\.claim\.([a-f0-9]{32})\.([a-f0-9]{32})$/;
const PUBLIC_SUFFIX = ".txt";
const CLAIM_NAME_ATTEMPTS = 4;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

// Directory fsync is unsupported on some platforms/filesystems; only these
// documented errno values are tolerated, anything else fails closed.
const UNSUPPORTED_DIRECTORY_SYNC = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EPERM"]);

const MESSAGES = Object.freeze({
  "REQUEST-ARGUMENT-INVALID": "request spool argument is invalid",
  "REQUEST-TOKEN-INVALID": "request token must be exactly 32 lowercase hexadecimal characters",
  "REQUEST-ROUTE-INVALID": "request route callback must be a function",
  "REQUEST-SPOOL-ABSENT": "request spool does not exist",
  "REQUEST-SPOOL-CREATE": "request spool directory could not be created",
  "REQUEST-SPOOL-TYPE": "request spool is not a directory",
  "REQUEST-SPOOL-OWNER": "request spool is not owned by the current user",
  "REQUEST-SPOOL-MODE": "request spool mode is not exactly 0700",
  "REQUEST-SPOOL-MARKER": "request spool marker is missing or invalid",
  "REQUEST-SPOOL-UNMARKED": "request spool is not empty and has no ownership marker",
  "REQUEST-IDENTITY-UNAVAILABLE": "request spool does not provide a stable file identity on this filesystem",
  "REQUEST-SPOOL-ENTRIES": "request spool has too many entries",
  "REQUEST-SPOOL-NOT-EMPTY": "request spool still contains entries",
  "REQUEST-SPOOL-SYNC-FAILED": "request spool directory could not be synced",
  "REQUEST-ENTRY-TYPE": "request entry is not a regular file",
  "REQUEST-ENTRY-OWNER": "request entry is not owned by the current user",
  "REQUEST-ENTRY-HARDLINK": "request entry has more than one link",
  "REQUEST-ENTRY-TOO-LARGE": "request entry exceeds the maximum accepted size",
  "REQUEST-ENTRY-OPEN": "request entry could not be opened",
  "REQUEST-ABSENT": "request is not present in the spool",
  "REQUEST-AMBIGUOUS": "request state is ambiguous",
  "REQUEST-CHANGED": "request changed while it was being consumed",
  "REQUEST-CLAIM-NAME": "request claim name could not be generated",
  "REQUEST-CLAIM-RENAME": "request could not be claimed",
  "REQUEST-CLAIM-MODE": "request claim mode could not be restricted",
  "REQUEST-CLAIM-REMOVE": "request claim could not be removed",
  "REQUEST-READ-FAILED": "request body could not be read",
  "REQUEST-ENCODING": "request body is not valid UTF-8 text",
  "REQUEST-BODY-EMPTY": "request body is empty",
  "REQUEST-ROUTE-FAILED": "request route callback failed",
  "REQUEST-LEGACY-PENDING": "legacy request files are pending; consume them with skill-router route --request-token before changing router state",
  "REQUEST-LEGACY-UNSAFE": "the legacy request directory cannot be verified as owner-private",
  "REQUEST-IO-FAILED": "request spool I/O failed",
});

/** Fixed, bounded spool error: never carries request bytes, tokens, paths, digests, or causes. */
class RequestSpoolError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES["REQUEST-IO-FAILED"]);
    this.name = "RequestSpoolError";
    this.code = MESSAGES[code] ? code : "REQUEST-IO-FAILED";
  }
}

/** Narrow predicate for the fixed error set produced by this module. */
export function isRequestSpoolError(error) {
  return error instanceof RequestSpoolError;
}

/** True only for an exact 32-lowercase-hexadecimal request token. */
export function isValidRequestToken(token) {
  return typeof token === "string" && TOKEN_PATTERN.test(token);
}

// Narrow deterministic-injection seam. Production callers must treat these as
// read-only; tests override individual entries and restore them afterwards.
export const requestSpoolInternals = {
  async lstat(target) {
    return fsp.lstat(target);
  },
  async readdirNames(target, options = {}) {
    // Bounded scan: stop as soon as the limit is exceeded instead of loading
    // an unbounded directory listing into memory.
    const expected = options.expectedIdentity ?? null;
    const directory = await fsp.opendir(target);
    const names = [];
    try {
      // B7 post-open recheck: a caller that passed the exact strong identity
      // it verified before the scan gets one more observation *after* the
      // directory was opened and *before* a single name is read. A path that
      // was swapped to a symlink, a wrong-type entry, a different directory,
      // or an unprovable identity is refused here; the bounded loop below
      // only ever runs for the proven entry. (Residual: Node cannot re-stat
      // the open directory handle itself, so a hostile same-user process that
      // swaps the path away and back exactly across the open is not
      // absolutely excluded; the decision stays fail-closed either way.)
      if (expected) {
        let rescanned;
        try {
          rescanned = await requestSpoolInternals.lstat(target);
        } catch {
          throw new RequestSpoolError("REQUEST-IO-FAILED");
        }
        if (rescanned.isSymbolicLink() || !rescanned.isDirectory()) {
          throw new RequestSpoolError("REQUEST-IO-FAILED");
        }
        if (!identitiesEqual(fileIdentity(rescanned), expected)) {
          throw new RequestSpoolError("REQUEST-IO-FAILED");
        }
      }
      for (;;) {
        const entry = await directory.read();
        if (entry === null) return { names, overflow: false };
        names.push(entry.name);
        if (names.length > REQUEST_MAX_ENTRIES) return { names: [], overflow: true };
      }
    } finally {
      try {
        await directory.close();
      } catch {
        // Closing is best effort; the scan result already decided the outcome.
      }
    }
  },
  async mkdir(target, mode) {
    return fsp.mkdir(target, { mode });
  },
  async chmod(target, mode) {
    return fsp.chmod(target, mode);
  },
  async rename(from, to) {
    return fsp.rename(from, to);
  },
  async unlink(target) {
    return fsp.unlink(target);
  },
  async rmdir(target) {
    return fsp.rmdir(target);
  },
  // O_NOFOLLOW where the platform supports it; the caller re-verifies the
  // opened identity against a fresh lstat on platforms where it is absent.
  async openRead(target) {
    return fsp.open(target, O_RDONLY | O_NOFOLLOW);
  },
  async openCreateExclusive(target, mode) {
    return fsp.open(target, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode);
  },
  async closeHandle(handle) {
    await handle.close();
  },
  async handleStat(handle) {
    return handle.stat();
  },
  async handleChmod(handle, mode) {
    await handle.chmod(mode);
  },
  async handleRead(handle, buffer, offset, length, position) {
    return handle.read(buffer, offset, length, position);
  },
  async syncDirectory(target) {
    const handle = await fsp.open(target, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  uidSemantics() {
    return typeof process.getuid === "function";
  },
  currentUid() {
    return typeof process.getuid === "function" ? process.getuid() : -1;
  },
  claimNonce() {
    return randomBytes(16).toString("hex");
  },
  /** Test hook invoked between the bounded read and the closing re-fstat. */
  async afterRead() {},
};

function currentUid() {
  return requestSpoolInternals.currentUid();
}

function uidSemantics() {
  return requestSpoolInternals.uidSemantics();
}

async function attempt(run, code, errnoMap) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof RequestSpoolError) throw error;
    const errno = typeof error?.code === "string" ? error.code : undefined;
    const mapped = errno !== undefined && errnoMap ? errnoMap[errno] : undefined;
    throw new RequestSpoolError(mapped || code);
  }
}

async function lstatOptional(target, errnoMap) {
  try {
    return await requestSpoolInternals.lstat(target);
  } catch (error) {
    if (error instanceof RequestSpoolError) throw error;
    if (error && error.code === "ENOENT") return null;
    const errno = typeof error?.code === "string" ? error.code : undefined;
    const mapped = errno !== undefined && errnoMap ? errnoMap[errno] : undefined;
    throw new RequestSpoolError(mapped || "REQUEST-IO-FAILED");
  }
}

async function lstatRequired(target, absentCode, errnoMap) {
  const stat = await lstatOptional(target, errnoMap);
  if (!stat) throw new RequestSpoolError(absentCode);
  return stat;
}

async function syncDirectory(directory) {
  try {
    await requestSpoolInternals.syncDirectory(directory);
  } catch (error) {
    if (error instanceof RequestSpoolError) throw error;
    const errno = typeof error?.code === "string" ? error.code : undefined;
    if (errno !== undefined && UNSUPPORTED_DIRECTORY_SYNC.has(errno)) return false;
    throw new RequestSpoolError("REQUEST-SPOOL-SYNC-FAILED");
  }
  return true;
}

function modeOf(stat) {
  return Number(stat.mode) & 0o777;
}

function isRegularOwnedSingleLink(stat) {
  if (stat.isSymbolicLink() || !stat.isFile()) return false;
  if (uidSemantics() && Number(stat.uid) !== currentUid()) return false;
  if (Number(stat.nlink) !== 1) return false;
  return true;
}

// Pre-claim entry validation. Every refusal leaves the entry bytes untouched.
// A strong, available file identity is part of the contract: consumption may
// only ever rename or unlink an entry this filesystem can actually prove.
function assertEntryStat(stat) {
  if (stat.isSymbolicLink() || !stat.isFile()) throw new RequestSpoolError("REQUEST-ENTRY-TYPE");
  if (uidSemantics() && Number(stat.uid) !== currentUid()) {
    throw new RequestSpoolError("REQUEST-ENTRY-OWNER");
  }
  if (Number(stat.nlink) !== 1) throw new RequestSpoolError("REQUEST-ENTRY-HARDLINK");
  if (Number(stat.size) > REQUEST_MAX_BYTES) throw new RequestSpoolError("REQUEST-ENTRY-TOO-LARGE");
  if (!isIdentityAvailable(fileIdentity(stat))) throw new RequestSpoolError("REQUEST-IDENTITY-UNAVAILABLE");
}

// The spool directory itself must carry a strong identity before anything in
// it may be claimed, adopted, or removed.
function assertStrongSpoolIdentity(stat) {
  if (!isIdentityAvailable(fileIdentity(stat))) throw new RequestSpoolError("REQUEST-IDENTITY-UNAVAILABLE");
}

/**
 * Validates the ownership marker and *returns its first observed strong
 * identity*, which the caller carries through every later claim/consume step
 * (the marker's identity is the attribution anchor of the whole removal).
 */
async function assertMarkerFile(target) {
  const marker = await lstatOptional(target, { ENOTDIR: "REQUEST-SPOOL-MARKER" });
  if (!marker) throw new RequestSpoolError("REQUEST-SPOOL-MARKER");
  if (marker.isSymbolicLink() || !marker.isFile()) throw new RequestSpoolError("REQUEST-SPOOL-MARKER");
  if (uidSemantics() && Number(marker.uid) !== currentUid()) {
    throw new RequestSpoolError("REQUEST-SPOOL-MARKER");
  }
  // Exact marker mode: only the owner-only 0600 marker this router writes is
  // an attribution anchor; 0400/0700 or any other mode refuses before any
  // record or rename happens.
  if (modeOf(marker) !== REQUEST_MARKER_MODE) throw new RequestSpoolError("REQUEST-SPOOL-MARKER");
  if (Number(marker.nlink) !== 1) throw new RequestSpoolError("REQUEST-SPOOL-MARKER");
  const identity = fileIdentity(marker);
  if (!isIdentityAvailable(identity)) throw new RequestSpoolError("REQUEST-SPOOL-MARKER");
  return identity;
}

// Single spool entry boundary. It refuses an unsupported runtime platform
// (Phase 14: win32) *before* any filesystem effect - the guard is shared with
// the controlled runners so no per-call-site check can be forgotten - and then
// validates the exact directory argument. Every exported spool operation that
// touches the filesystem validates its directory through this function as its
// first statement.
function assertDirectoryArgument(directory) {
  assertSupportedRuntimePlatform();
  if (typeof directory !== "string" || directory === "") {
    throw new RequestSpoolError("REQUEST-ARGUMENT-INVALID");
  }
}

async function readEntryNames(directory) {
  const result = await attempt(
    () => requestSpoolInternals.readdirNames(directory),
    "REQUEST-IO-FAILED",
    { ENOENT: "REQUEST-SPOOL-ABSENT", ENOTDIR: "REQUEST-SPOOL-TYPE" },
  );
  if (!result || typeof result !== "object" || !Array.isArray(result.names)) {
    throw new RequestSpoolError("REQUEST-IO-FAILED");
  }
  if (result.overflow) throw new RequestSpoolError("REQUEST-SPOOL-ENTRIES");
  return result.names;
}

async function validateSpool(directory, { requireMarker = true, legacy = false } = {}) {
  const stat = await lstatRequired(directory, "REQUEST-SPOOL-ABSENT", { ENOTDIR: "REQUEST-SPOOL-TYPE" });
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new RequestSpoolError("REQUEST-SPOOL-TYPE");
  if (uidSemantics() && Number(stat.uid) !== currentUid()) throw new RequestSpoolError("REQUEST-SPOOL-OWNER");
  // Identity preflight: claims are only ever created inside a spool whose own
  // dev/ino identity this filesystem can prove.
  assertStrongSpoolIdentity(stat);
  const mode = modeOf(stat);
  if (legacy ? (mode & 0o077) !== 0 : mode !== REQUEST_SPOOL_MODE) {
    throw new RequestSpoolError("REQUEST-SPOOL-MODE");
  }
  const names = await readEntryNames(directory);
  if (requireMarker) {
    if (!names.includes(REQUEST_MARKER_NAME)) {
      throw new RequestSpoolError(
        names.length > 0 ? "REQUEST-SPOOL-UNMARKED" : "REQUEST-SPOOL-MARKER",
      );
    }
    await assertMarkerFile(path.join(directory, REQUEST_MARKER_NAME));
  }
  return { stat, names };
}

async function ensureMarker(directory) {
  // Identity preflight: the marker is only ever created inside a spool whose
  // own dev/ino identity this filesystem can prove.
  const directoryStat = await lstatOptional(directory, { ENOTDIR: "REQUEST-SPOOL-MARKER" });
  if (!directoryStat || directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new RequestSpoolError("REQUEST-SPOOL-MARKER");
  }
  assertStrongSpoolIdentity(directoryStat);
  const target = path.join(directory, REQUEST_MARKER_NAME);
  let handle = null;
  try {
    handle = await requestSpoolInternals.openCreateExclusive(target, REQUEST_MARKER_MODE);
  } catch (error) {
    if (error instanceof RequestSpoolError) throw error;
    if (error?.code !== "EEXIST") throw new RequestSpoolError("REQUEST-SPOOL-MARKER");
  }
  if (handle) {
    try {
      await requestSpoolInternals.handleChmod(handle, REQUEST_MARKER_MODE);
    } catch {
      // The final validation below decides whether the marker is acceptable.
    }
    try {
      await requestSpoolInternals.closeHandle(handle);
    } catch {
      // Closing is best effort; the marker is validated by path afterwards.
    }
  }
  await assertMarkerFile(target);
}

/**
 * Creates any missing parent of the spool — one level at a time, owner-only,
 * and only for components this call actually created. Existing components are
 * never chmodded, and a parent that is not a real directory (symlink, file, or
 * anything a no-follow lstat cannot attribute) fails closed instead of being
 * followed or replaced. This is what makes the global spool's
 * `<home>/.local/share` parents safe to establish on a fresh account.
 */
async function createSpoolParents(directory) {
  const missing = [];
  let cursor = path.dirname(directory);
  for (;;) {
    const existing = await lstatOptional(cursor, { ENOTDIR: "REQUEST-SPOOL-CREATE" });
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw new RequestSpoolError("REQUEST-SPOOL-CREATE");
      }
      break;
    }
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const target of missing.reverse()) {
    try {
      await requestSpoolInternals.mkdir(target, REQUEST_SPOOL_MODE);
    } catch (error) {
      if (error instanceof RequestSpoolError) throw error;
      // A concurrent creator of the very same level is fine; anything else
      // fails closed without touching the path.
      if (error?.code !== "EEXIST") throw new RequestSpoolError("REQUEST-SPOOL-CREATE");
      continue;
    }
    // Only a directory this call created is normalized to exactly 0700.
    await attempt(() => requestSpoolInternals.chmod(target, REQUEST_SPOOL_MODE), "REQUEST-SPOOL-CREATE");
  }
}

/**
 * Creates or repairs the exact spool directory: non-symlink, current-user
 * owned, exactly 0700, with an owner-only marker. Empty current-owned
 * directories (including wrongly-moded ones) are adopted idempotently;
 * nonempty unmarked, foreign-owned, symlinked, or non-directory targets are
 * refused without modifying anything. Never deletes an entry.
 *
 * With `{ createParents: true }` missing parents are first created one level
 * at a time under the same rules (see `createSpoolParents`), so a global
 * install on a fresh home directory can establish its spool.
 */
export async function setupRequestSpool(directory, options = {}) {
  assertDirectoryArgument(directory);
  if (options.createParents === true) await createSpoolParents(directory);
  let stat = await lstatOptional(directory, { ENOTDIR: "REQUEST-SPOOL-TYPE" });
  let created = false;
  if (!stat) {
    try {
      await requestSpoolInternals.mkdir(directory, REQUEST_SPOOL_MODE);
      created = true;
    } catch (error) {
      if (error instanceof RequestSpoolError) throw error;
      if (error?.code !== "EEXIST") throw new RequestSpoolError("REQUEST-SPOOL-CREATE");
      stat = await lstatRequired(directory, "REQUEST-SPOOL-ABSENT", { ENOTDIR: "REQUEST-SPOOL-TYPE" });
    }
  }

  if (created) {
    await attempt(() => requestSpoolInternals.chmod(directory, REQUEST_SPOOL_MODE), "REQUEST-IO-FAILED");
    await ensureMarker(directory);
    await syncDirectory(directory);
    return { created: true, adopted: false, mode: REQUEST_SPOOL_MODE };
  }

  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new RequestSpoolError("REQUEST-SPOOL-TYPE");
  if (uidSemantics() && Number(stat.uid) !== currentUid()) throw new RequestSpoolError("REQUEST-SPOOL-OWNER");
  // Identity preflight before any repair (chmod) or marker write: a spool this
  // filesystem cannot prove is never adopted or normalized.
  assertStrongSpoolIdentity(stat);
  const names = await readEntryNames(directory);
  const marked = names.includes(REQUEST_MARKER_NAME);
  if (marked) {
    await assertMarkerFile(path.join(directory, REQUEST_MARKER_NAME));
  } else if (names.length > 0) {
    // Fail closed: a directory we cannot attribute is never adopted.
    throw new RequestSpoolError("REQUEST-SPOOL-UNMARKED");
  }

  const adopted = !marked;
  let changed = false;
  if (modeOf(stat) !== REQUEST_SPOOL_MODE) {
    await attempt(() => requestSpoolInternals.chmod(directory, REQUEST_SPOOL_MODE), "REQUEST-IO-FAILED");
    changed = true;
  }
  if (adopted) {
    await ensureMarker(directory);
    changed = true;
  }
  if (changed) await syncDirectory(directory);
  return { created: false, adopted, mode: REQUEST_SPOOL_MODE };
}

/**
 * Read-only spool report for init/check integration. Never throws for an
 * unready spool and never returns a path: `{ status, entries }` with status
 * one of `absent`, `not-a-directory`, `not-owned`, `identity-unavailable`,
 * `excessive`, `adoptable`, `unmarked`, `marker-invalid`, `not-private`,
 * `ready`. `identity-unavailable` is a refusing state (B5): a spool directory
 * this filesystem cannot prove by strong identity is never reported `ready` or
 * `adoptable`, and `requestSpoolRefusal` refuses it with the stable
 * `REQUEST-IDENTITY-UNAVAILABLE` code before any dry-run or real mutation.
 */
export async function inspectRequestSpool(directory) {
  assertDirectoryArgument(directory);
  const stat = await lstatOptional(directory, { ENOTDIR: "REQUEST-SPOOL-TYPE" });
  if (!stat) return { status: "absent", entries: 0 };
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { status: "not-a-directory", entries: 0 };
  if (uidSemantics() && Number(stat.uid) !== currentUid()) return { status: "not-owned", entries: 0 };
  // B5: a directory whose strong identity this filesystem cannot report is
  // never `ready` (or any other acceptable state): the inspection reports the
  // refusing `identity-unavailable` status instead of probing its entries.
  if (!isIdentityAvailable(fileIdentity(stat))) {
    return { status: "identity-unavailable", entries: null };
  }
  let names;
  try {
    names = await readEntryNames(directory);
  } catch (error) {
    if (isRequestSpoolError(error) && error.code === "REQUEST-SPOOL-ENTRIES") {
      return { status: "excessive", entries: null };
    }
    throw error;
  }
  const marked = names.includes(REQUEST_MARKER_NAME);
  if (!marked) return { status: names.length === 0 ? "adoptable" : "unmarked", entries: names.length };
  try {
    await assertMarkerFile(path.join(directory, REQUEST_MARKER_NAME));
  } catch {
    return { status: "marker-invalid", entries: names.length };
  }
  if (modeOf(stat) !== REQUEST_SPOOL_MODE) return { status: "not-private", entries: names.length };
  return { status: "ready", entries: names.length };
}

/**
 * Proves the spool holds no request data: an absent directory, or one whose
 * only entry is the valid ownership marker. A directory we cannot attribute
 * (no marker) fails closed even when it looks empty, and any other entry fails
 * closed. Never deletes.
 */
export async function assertRequestSpoolEmpty(directory) {
  assertDirectoryArgument(directory);
  const stat = await lstatOptional(directory, { ENOTDIR: "REQUEST-SPOOL-TYPE" });
  if (!stat) return { empty: true, present: false };
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new RequestSpoolError("REQUEST-SPOOL-TYPE");
  if (uidSemantics() && Number(stat.uid) !== currentUid()) throw new RequestSpoolError("REQUEST-SPOOL-OWNER");
  // B5: emptiness is only provable for a spool directory whose strong
  // identity this filesystem can report; an unprovable directory refuses
  // before any entry name is even read (uninstall dry-run and real alike).
  assertStrongSpoolIdentity(stat);
  const names = await readEntryNames(directory);
  // No marker means the directory is unattributable, whether empty or not;
  // the message distinguishes the two so the repair is clear.
  if (!names.includes(REQUEST_MARKER_NAME)) {
    throw new RequestSpoolError(names.length > 0 ? "REQUEST-SPOOL-UNMARKED" : "REQUEST-SPOOL-MARKER");
  }
  const others = names.filter((name) => name !== REQUEST_MARKER_NAME);
  if (others.length > 0) throw new RequestSpoolError("REQUEST-SPOOL-NOT-EMPTY");
  await assertMarkerFile(path.join(directory, REQUEST_MARKER_NAME));
  return { empty: true, present: true };
}

/**
 * Removes the spool directory only when it is provably ours and provably
 * empty: its own valid marker being the single entry. Any other state fails
 * closed and is preserved; unknown entries are never deleted.
 */
/* ------------------------------------------------------------------ *
 * R2 - record-bound, crash-reenterable spool removal
 *
 * A spool removal is authorized and re-entered only through a *durable
 * external removal record* - a sibling file `.<spool>.removal-<nonce>.json`
 * written (0600, fsynced file and parent) BEFORE anything is claimed. It
 * binds the nonce, the original spool identity, the original marker
 * identity, the owner, and a schema version. The directory claim
 * (`.<spool>.claim-<nonce>`) and every marker claim
 * (`.<spool>.claim-<nonce>.marker-<h>`) derive from that nonce, so re-entry
 * trusts only a *valid record plus its matching claims* - never a bare
 * grammar or shape - and exact-shaped foreign claims without a valid record
 * survive untouched. The record is kept until the directory removal has
 * committed and is then consumed by an attributed removal.
 *
 * Sequence: attribute spool (exact 0700, current uid, strong identity) and
 * marker (exact 0600, current uid, nlink 1, strong identity); write/resolve
 * the record; re-prove the spool immediately before the claim rename; move the
 * spool to its nonce claim (fsync parent); re-prove identity and the exact
 * marker-only contents; move the marker to a correlated fresh marker claim
 * (fsync the source claim directory and the destination parent); consume that
 * claim through an identity-re-proven attributed unlink; re-prove the empty
 * claim and remove it with a non-recursive rmdir (fsync parent); finally
 * consume the record itself by attributed removal.
 *
 * Record invariants are exact and revalidated at every step of use: mode
 * 0600, current uid, nlink 1, a closed `{dev,ino}` schema, and an identity
 * that is stable across the path observation and the bounded read handle; a
 * parent scan that overflows the bound refuses *before* any new record or
 * claim is created.
 *
 * Residual trust boundary (documented, not claimable away): this defends
 * ordinary concurrency, crashes, and persistent replacements. Node cannot
 * bind an fd to unlink(2)/rmdir(2), so the final verify->remove syscall
 * window at an unpredictable, never-pre-creatable claim name is the strongest
 * binding available; a malicious same-UID process precisely racing that final
 * pathname syscall is out of scope.
 * ------------------------------------------------------------------ */

const SPOOL_REMOVAL_SCHEMA = 1;

/** Exact pattern of a spool-removal record: `.<basename>.removal-<32hex>.json`. */
function spoolRemovalRecordPattern(basename) {
  const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\.${escaped}\\.removal-([0-9a-f]{32})\\.json$`);
}

function spoolRemovalRecordPath(parent, basename, nonce) {
  return path.join(parent, `.${basename}.removal-${nonce}.json`);
}

/** The directory claim bound to a record nonce: `.<basename>.claim-<nonce>`. */
function spoolClaimNameFor(basename, nonce) {
  return `.${basename}.claim-${nonce}`;
}

/** A marker claim bound to a record nonce: `.<claim>.marker-<nonce>`. */
function markerClaimNameFor(claimBasename, nonce) {
  return `${claimBasename}.marker-${nonce}`;
}

/** Serializes the durable removal record (closed, bounded schema). */
function serializeRemovalRecord({ nonce, spool, marker }) {
  return Buffer.from(
    `${JSON.stringify({
      schema: SPOOL_REMOVAL_SCHEMA,
      owner: "skill-router",
      nonce,
      spool: identityRecord(spool),
      marker: identityRecord(marker),
    })}\n`,
    "utf8",
  );
}

/**
 * Strictly validates one removal record: a regular, owner-only, current-uid
 * file whose closed schema binds this spool basename's nonce to strong
 * original spool and marker identities. Returns the validated record, or null
 * for a foreign lookalike (never touched).
 */
async function readValidatedRemovalRecord(recordPath, basename, nonce) {
  let stat;
  try {
    stat = await requestSpoolInternals.lstat(recordPath);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return null;
  if (uidSemantics() && Number(stat.uid) !== currentUid()) return null;
  // Exact record invariants: mode 0600, single link, strong identity.
  if (modeOf(stat) !== REQUEST_MARKER_MODE) return null;
  if (Number(stat.nlink) !== 1) return null;
  if (!isIdentityAvailable(fileIdentity(stat))) return null;
  let read;
  try {
    read = await readRegularFileNoFollow(recordPath, { maxBytes: 4096, allowMissing: true, withIdentity: true });
  } catch {
    return null;
  }
  if (read === null) return null;
  // Stable identity across the path observation and the read handle.
  if (!identitiesEqual(read.identity, fileIdentity(stat))) return null;
  let record;
  try {
    record = JSON.parse(read.bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const keys = Object.keys(record).sort();
  // Exact closed identity schema: {dev, ino} with no extra keys, strong.
  const exactPair = (value) =>
    value !== null
    && typeof value === "object"
    && Object.keys(value).sort().join(",") === "dev,ino"
    && isIdentityAvailable(value);
  if (
    keys.length !== 5
    || record.schema !== SPOOL_REMOVAL_SCHEMA
    || record.owner !== "skill-router"
    || record.nonce !== nonce
    || !exactPair(record.spool)
    || !exactPair(record.marker)
  ) {
    return null;
  }
  return { path: recordPath, identity: fileIdentity(stat), nonce, spool: record.spool, marker: record.marker };
}

/**
 * Verifies a marker entry against the *recorded* marker identity: a regular,
 * owner-only, exactly-0600, current-uid, single-link file with that exact
 * strong identity. Returns the observed identity, or null (preserved).
 */
async function verifyMarkerAgainstRecord(target, expectedIdentity) {
  let stat;
  try {
    stat = await requestSpoolInternals.lstat(target);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return null;
  if (uidSemantics() && Number(stat.uid) !== currentUid()) return null;
  if (modeOf(stat) !== REQUEST_MARKER_MODE) return null;
  if (Number(stat.nlink) !== 1) return null;
  const identity = fileIdentity(stat);
  if (!isIdentityAvailable(identity) || !identitiesEqual(identity, expectedIdentity)) return null;
  return identity;
}

/** Verifies a claimed spool directory against the recorded spool identity. */
async function verifyClaimedDirectory(claimPath, expectedIdentity) {
  let stat;
  try {
    stat = await requestSpoolInternals.lstat(claimPath);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
  if (uidSemantics() && Number(stat.uid) !== currentUid()) return null;
  if (modeOf(stat) !== REQUEST_SPOOL_MODE) return null;
  const identity = fileIdentity(stat);
  if (!isIdentityAvailable(identity) || !identitiesEqual(identity, expectedIdentity)) return null;
  return identity;
}

/** Consumes a validated marker claim: re-proven twice, unlinked attributed. */
async function consumeMarkerClaim(claimPath, expectedIdentity) {
  const first = await verifyMarkerAgainstRecord(claimPath, expectedIdentity);
  if (first === null) throw new RequestSpoolError("REQUEST-IO-FAILED");
  // Recheck immediately before the destructive unlink.
  const recheck = await verifyMarkerAgainstRecord(claimPath, expectedIdentity);
  if (recheck === null) throw new RequestSpoolError("REQUEST-IO-FAILED");
  await attempt(() => requestSpoolInternals.unlink(claimPath), "REQUEST-IO-FAILED");
  await syncDirectory(path.dirname(claimPath));
}

/** Attributed removal of a validated removal record, itself re-proven. */
async function consumeRemovalRecord(record) {
  let stat;
  try {
    stat = await requestSpoolInternals.lstat(record.path);
  } catch {
    return;
  }
  const identity = fileIdentity(stat);
  // Revalidate every record invariant immediately before the attributed
  // removal: exact 0600, current uid, nlink 1, and the same strong identity
  // that was validated when the record was read.
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || (uidSemantics() && Number(stat.uid) !== currentUid())
    || modeOf(stat) !== REQUEST_MARKER_MODE
    || Number(stat.nlink) !== 1
    || !isIdentityAvailable(identity)
    || !identitiesEqual(identity, record.identity)
  ) {
    return;
  }
  try {
    await requestSpoolInternals.unlink(record.path);
  } catch {
    return;
  }
  await syncDirectory(path.dirname(record.path));
}

/**
 * Completes the removal authorized by one validated record. Marker claims
 * bound to the record's nonce are consumed first; the directory claim is
 * completed (marker move if the crash landed before it, with the source claim
 * directory and destination parent fsynced after the cross-directory move),
 * then removed by an identity-and-emptiness-proven non-recursive rmdir; only
 * after that commit is the record itself consumed. Foreign contents or an
 * unprovable claim preserve everything and report not-completed.
 */
async function completeRecordedSpoolRemoval(directory, record) {
  const parent = path.dirname(directory);
  const base = path.basename(directory);
  const claimBasename = spoolClaimNameFor(base, record.nonce);
  const claimPath = path.join(parent, claimBasename);
  const escapedClaim = claimBasename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const markerPattern = new RegExp(`^${escapedClaim}\\.marker-([0-9a-f]{32})$`);

  // 1) Marker claims bound to this record are consumed first.
  let listing = null;
  try {
    listing = await requestSpoolInternals.readdirNames(parent);
  } catch {
    return false;
  }
  if (listing && typeof listing === "object" && Array.isArray(listing.names) && !listing.overflow) {
    for (const name of listing.names) {
      if (!markerPattern.test(name)) continue;
      const markerClaim = path.join(parent, name);
      const identity = await verifyMarkerAgainstRecord(markerClaim, record.marker);
      if (identity === null) continue;
      await consumeMarkerClaim(markerClaim, identity);
    }
  }

  // 2) The directory claim: complete its removal.
  const claimIdentity = await verifyClaimedDirectory(claimPath, record.spool);
  if (claimIdentity !== null) {
    let contents = null;
    try {
      contents = await requestSpoolInternals.readdirNames(claimPath);
    } catch {
      return false;
    }
    if (!contents || typeof contents !== "object" || !Array.isArray(contents.names) || contents.overflow) {
      return false;
    }
    const markers = contents.names.filter((name) => name === REQUEST_MARKER_NAME);
    if (contents.names.length === 1 && markers.length === 1) {
      // Crash after the directory rename, before the marker move: move the
      // marker to a correlated fresh marker claim and consume it there.
      const markerPath = path.join(claimPath, REQUEST_MARKER_NAME);
      const markerIdentity = await verifyMarkerAgainstRecord(markerPath, record.marker);
      if (markerIdentity === null) return false;
      const markerClaim = path.join(parent, markerClaimNameFor(claimBasename, requestSpoolInternals.claimNonce()));
      await attempt(() => requestSpoolInternals.rename(markerPath, markerClaim), "REQUEST-IO-FAILED");
      // Fsync the source claim directory and the destination parent after the
      // cross-directory marker move.
      await syncDirectory(claimPath);
      await syncDirectory(parent);
      await consumeMarkerClaim(markerClaim, markerIdentity);
    } else if (contents.names.length !== 0) {
      return false;
    }

    // Reprove identity and emptiness immediately before the rmdir.
    const finalIdentity = await verifyClaimedDirectory(claimPath, record.spool);
    if (finalIdentity === null) throw new RequestSpoolError("REQUEST-IO-FAILED");
    let finalContents = null;
    try {
      finalContents = await requestSpoolInternals.readdirNames(claimPath);
    } catch {
      return false;
    }
    if (
      !finalContents
      || typeof finalContents !== "object"
      || !Array.isArray(finalContents.names)
      || finalContents.overflow
      || finalContents.names.length !== 0
    ) {
      throw new RequestSpoolError("REQUEST-IO-FAILED");
    }
    try {
      await requestSpoolInternals.rmdir(claimPath);
    } catch (error) {
      if (error instanceof RequestSpoolError) throw error;
      if (error?.code !== "ENOENT") {
        if (error?.code === "ENOTEMPTY" || error?.code === "EEXIST") {
          throw new RequestSpoolError("REQUEST-SPOOL-NOT-EMPTY");
        }
        throw new RequestSpoolError("REQUEST-IO-FAILED");
      }
    }
    await syncDirectory(parent);
  } else {
    // No provable directory claim: a present-but-unprovable claim (or a
    // foreign lookalike at that name) preserves the record too.
    const claimStat = await lstatOptional(claimPath, {});
    if (claimStat !== null) return false;
  }

  // 3) The removal committed: consume the record itself.
  await consumeRemovalRecord(record);
  return true;
}

/**
 * Completes every interrupted spool removal for this exact spool by scanning
 * the parent (bounded by the spool scan bound) for *valid removal records*
 * only: exact-shaped claims and record lookalikes without a valid record are
 * foreign and survive untouched. A valid record whose spool still exists and
 * whose claim does not yet is the record-before-claim crash point: it is
 * returned for the fresh sequence to resume with its own nonce.
 */
async function completeInterruptedSpoolRemovals(directory) {
  const parent = path.dirname(directory);
  const base = path.basename(directory);
  const recordPattern = spoolRemovalRecordPattern(base);
  let listing;
  try {
    listing = await requestSpoolInternals.readdirNames(parent);
  } catch {
    return { completed: false, resumable: null };
  }
  if (!listing || typeof listing !== "object" || !Array.isArray(listing.names)) {
    return { completed: false, resumable: null };
  }
  if (listing.overflow) {
    // Bounded scan refused: never create a new record or claim while the
    // parent cannot be fully enumerated - a leftover claim must stay
    // discoverable, and an unbounded scan cannot prove that.
    throw new RequestSpoolError("REQUEST-SPOOL-ENTRIES");
  }
  let completed = false;
  let resumable = null;
  for (const name of listing.names) {
    const match = recordPattern.exec(name);
    if (!match) continue;
    const record = await readValidatedRemovalRecord(path.join(parent, name), base, match[1]);
    if (record === null) continue;
    const claimStat = await lstatOptional(path.join(parent, spoolClaimNameFor(base, record.nonce)), {});
    const spoolStat = await lstatOptional(directory, {});
    if (!claimStat && spoolStat) {
      // Crash after the record write and before the claim rename.
      resumable = record;
      continue;
    }
    completed = (await completeRecordedSpoolRemoval(directory, record)) || completed;
  }
  return { completed, resumable };
}

/**
 * Proves an empty spool directory and removes it through the record-bound
 * protocol above. Interrupted removals are completed (or a valid record is
 * resumed) first; then the spool is attributed, bound to a durable external
 * removal record created before any claim, re-proved immediately before the
 * nonce claim rename, its marker moved to a correlated fresh marker claim,
 * consumed by an attributed removal, and the proven-empty claim removed
 * non-recursively; finally the record itself is consumed. Every refusal
 * leaves the original spool path (and any replacement there) preserved, and
 * a proved-but-refused claim or record is preserved for a later verified
 * pass.
 */
export async function removeRequestSpoolIfEmpty(directory) {
  assertDirectoryArgument(directory);

  // R2 re-entry: finish (or resume) recorded removals of this exact spool
  // before considering a fresh claim.
  const { completed, resumable } = await completeInterruptedSpoolRemovals(directory);

  const stat = await lstatOptional(directory, { ENOTDIR: "REQUEST-SPOOL-TYPE" });
  if (!stat) return { removed: completed };
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new RequestSpoolError("REQUEST-SPOOL-TYPE");
  if (uidSemantics() && Number(stat.uid) !== currentUid()) throw new RequestSpoolError("REQUEST-SPOOL-OWNER");
  // Destructive operation: the exact spool directory this call removes must
  // carry a strong, available identity, be exactly 0700, and be attributed
  // here and re-proved at every later step.
  assertStrongSpoolIdentity(stat);
  if (modeOf(stat) !== REQUEST_SPOOL_MODE) throw new RequestSpoolError("REQUEST-SPOOL-MODE");
  const spoolIdentity = fileIdentity(stat);
  const names = await readEntryNames(directory);
  if (!names.includes(REQUEST_MARKER_NAME)) {
    throw new RequestSpoolError(names.length > 0 ? "REQUEST-SPOOL-UNMARKED" : "REQUEST-SPOOL-MARKER");
  }
  const others = names.filter((name) => name !== REQUEST_MARKER_NAME);
  if (others.length > 0) throw new RequestSpoolError("REQUEST-SPOOL-NOT-EMPTY");

  // Attribute the exact *first* marker before anything is mutated:
  // `assertMarkerFile` validates (regular, owner-only, current uid, nlink 1,
  // strong identity) and returns that first identity, which every later
  // claim/consume step is reproved against.
  const marker = path.join(directory, REQUEST_MARKER_NAME);
  const markerIdentity = await assertMarkerFile(marker);

  const parent = path.dirname(directory);
  const base = path.basename(directory);

  // R2: resolve or create the durable external removal record. A resumed
  // record's attributed identities must still match the current spool and
  // marker (identity equality implies the same inode, owner, and mode).
  let record = resumable;
  if (record !== null) {
    if (
      !identitiesEqual(record.spool, spoolIdentity)
      || !identitiesEqual(record.marker, markerIdentity)
    ) {
      throw new RequestSpoolError("REQUEST-IO-FAILED");
    }
  } else {
    const nonce = requestSpoolInternals.claimNonce();
    if (!/^[0-9a-f]{32}$/.test(nonce)) throw new RequestSpoolError("REQUEST-CLAIM-NAME");
    const recordPath = spoolRemovalRecordPath(parent, base, nonce);
    let handle = null;
    try {
      handle = await requestSpoolInternals.openCreateExclusive(recordPath, REQUEST_MARKER_MODE);
      await requestSpoolInternals.handleChmod(handle, REQUEST_MARKER_MODE);
      const recordBytes = serializeRemovalRecord({ nonce, spool: spoolIdentity, marker: markerIdentity });
      await handle.write(recordBytes, 0, recordBytes.length, 0);
      if (typeof handle.sync === "function") await handle.sync();
    } catch (error) {
      if (handle) {
        try {
          await requestSpoolInternals.closeHandle(handle);
        } catch {
          // Closing is best effort.
        }
      }
      if (error instanceof RequestSpoolError) throw error;
      throw new RequestSpoolError("REQUEST-IO-FAILED");
    }
    try {
      await requestSpoolInternals.closeHandle(handle);
    } catch {
      // Closing is best effort; the record is validated by its content below.
    }
    // Fsync the record's parent so the record-outlives-the-claim invariant is
    // durable before anything is claimed.
    await syncDirectory(parent);
    const validated = await readValidatedRemovalRecord(recordPath, base, nonce);
    if (validated === null) throw new RequestSpoolError("REQUEST-IO-FAILED");
    record = validated;
  }

  // R2: reprove the original spool immediately before the claim rename.
  const preRename = await lstatOptional(directory, { ENOTDIR: "REQUEST-IO-FAILED" });
  if (
    !preRename
    || preRename.isSymbolicLink()
    || !preRename.isDirectory()
    || (uidSemantics() && Number(preRename.uid) !== currentUid())
    || modeOf(preRename) !== REQUEST_SPOOL_MODE
    || !identitiesEqual(fileIdentity(preRename), spoolIdentity)
  ) {
    throw new RequestSpoolError("REQUEST-IO-FAILED");
  }

  // Claim the exact spool directory with the record-bound nonce name.
  const claimBasename = spoolClaimNameFor(base, record.nonce);
  const claimPath = path.join(parent, claimBasename);
  await attempt(() => requestSpoolInternals.rename(directory, claimPath), "REQUEST-IO-FAILED");
  await syncDirectory(parent);

  // Re-prove the claimed directory against the *recorded* spool identity and
  // the exact marker-only contents.
  const claimIdentity = await verifyClaimedDirectory(claimPath, record.spool);
  if (claimIdentity === null) throw new RequestSpoolError("REQUEST-IO-FAILED");
  let claimContents = null;
  try {
    claimContents = await requestSpoolInternals.readdirNames(claimPath);
  } catch {
    throw new RequestSpoolError("REQUEST-IO-FAILED");
  }
  if (
    !claimContents
    || typeof claimContents !== "object"
    || !Array.isArray(claimContents.names)
    || claimContents.overflow
    || claimContents.names.length !== 1
    || claimContents.names[0] !== REQUEST_MARKER_NAME
  ) {
    throw new RequestSpoolError("REQUEST-IO-FAILED");
  }

  // Move the marker to a correlated fresh marker claim; fsync the source
  // claim directory and the destination parent after the cross-directory move.
  const markerClaim = path.join(parent, markerClaimNameFor(claimBasename, requestSpoolInternals.claimNonce()));
  await attempt(
    () => requestSpoolInternals.rename(path.join(claimPath, REQUEST_MARKER_NAME), markerClaim),
    "REQUEST-IO-FAILED",
  );
  await syncDirectory(claimPath);
  await syncDirectory(parent);
  await consumeMarkerClaim(markerClaim, markerIdentity);

  // Reprove the empty claim against the recorded identity, then remove it
  // with a non-recursive rmdir.
  const finalIdentity = await verifyClaimedDirectory(claimPath, record.spool);
  if (finalIdentity === null) throw new RequestSpoolError("REQUEST-IO-FAILED");
  let finalContents = null;
  try {
    finalContents = await requestSpoolInternals.readdirNames(claimPath);
  } catch {
    throw new RequestSpoolError("REQUEST-IO-FAILED");
  }
  if (
    !finalContents
    || typeof finalContents !== "object"
    || !Array.isArray(finalContents.names)
    || finalContents.overflow
    || finalContents.names.length !== 0
  ) {
    throw new RequestSpoolError("REQUEST-IO-FAILED");
  }
  try {
    await requestSpoolInternals.rmdir(claimPath);
  } catch (error) {
    if (error instanceof RequestSpoolError) throw error;
    if (error?.code === "ENOENT") return { removed: true };
    if (error?.code === "ENOTEMPTY" || error?.code === "EEXIST") {
      throw new RequestSpoolError("REQUEST-SPOOL-NOT-EMPTY");
    }
    throw new RequestSpoolError("REQUEST-IO-FAILED");
  }
  await syncDirectory(parent);

  // The removal committed: consume the durable record itself (attributed).
  await consumeRemovalRecord(record);
  return { removed: true };
}

/**
 * Read-only, no-follow, bounded classification of a legacy `<state>/requests`
 * directory. It exists to decide whether router state may still change, so it
 * proves only what the decision needs — current ownership, directory type, and
 * owner-only confidentiality — and never reads a request body, never returns a
 * name or path, and never deletes anything. A directory it cannot prove is
 * `unsafe`; only a completed bounded scan of an owner-private directory we own
 * is reported as `absent`, `empty`, or `present`. An overflow (more entries
 * than the bound) is `present` with an unknown count: the actionable fact is
 * that pending entries exist, and the caller refuses or reports generically
 * either way.
 *
 * B7 (TOCTOU): the scan is never authorized by a single observation. The
 * directory is proven, then *re-lstat'ed immediately before* the bounded
 * `readdirNames` call and must again be a real (non-symlink) directory we own,
 * owner-private, and carry a strong identity equal to the first observation;
 * the scan itself re-verifies the path's identity once more *after* opening it
 * (see the `readdirNames` seam). Any swap - to a symlink, to a foreign
 * directory, or to an entry with an unprovable identity - yields `unsafe` with
 * `entries: null`, so no foreign name or count is ever observed or reported.
 * Residual (documented, not removable in Node): `fs.opendir` cannot be bound
 * to an fd the caller can re-stat, so a hostile same-user process that swaps
 * the path away and back exactly across the open is not absolutely excluded;
 * every other window is identity-checked and the final decision stays
 * fail-closed.
 */
export async function inspectLegacyRequestDirectory(directory) {
  assertDirectoryArgument(directory);
  let stat;
  try {
    stat = await requestSpoolInternals.lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "absent", entries: 0 };
    return { status: "unsafe", entries: null };
  }
  if (!legacyScanStatAcceptable(stat)) return { status: "unsafe", entries: null };
  const identity = fileIdentity(stat);

  // B7: re-lstat immediately before the bounded scan. Only the exact entry
  // that was just proven - same strong identity, still a real directory - may
  // be enumerated.
  let rescanned;
  try {
    rescanned = await requestSpoolInternals.lstat(directory);
  } catch {
    return { status: "unsafe", entries: null };
  }
  if (!legacyScanStatAcceptable(rescanned) || !identitiesEqual(fileIdentity(rescanned), identity)) {
    return { status: "unsafe", entries: null };
  }

  let result;
  try {
    // `expectedIdentity` drives the seam's post-open recheck, so a swap that
    // lands while the directory is being opened is refused before any name is
    // read.
    result = await requestSpoolInternals.readdirNames(directory, { expectedIdentity: identity });
  } catch {
    return { status: "unsafe", entries: null };
  }
  if (!result || typeof result !== "object" || !Array.isArray(result.names)) {
    return { status: "unsafe", entries: null };
  }
  if (result.overflow) return { status: "present", entries: null };
  return result.names.length === 0
    ? { status: "empty", entries: 0 }
    : { status: "present", entries: result.names.length };
}

/** One acceptance predicate for every legacy-scan observation of the directory. */
function legacyScanStatAcceptable(stat) {
  if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  if (uidSemantics() && Number(stat.uid) !== currentUid()) return false;
  // A directory this filesystem cannot prove by identity is never reported as
  // safe: the inspection only ever speaks for entries it can attribute.
  if (!isIdentityAvailable(fileIdentity(stat))) return false;
  // Legacy directories predate the marker, so they carry no attribution file;
  // confidentiality is still mandatory.
  if ((modeOf(stat) & 0o077) !== 0) return false;
  return true;
}

/**
 * Refuses while a legacy request directory still holds entries, or while it
 * cannot be proven safe. The errors are the fixed bounded set: no entry name,
 * count, path, or body is ever revealed, and nothing is modified.
 */
/**
 * The fixed refusal for a recorded legacy-request inspection, or `null` when
 * the directory is provably absent or empty. Both codes are generic: no
 * request body, token, entry name, count, or path is ever echoed.
 */
export function legacyRequestRefusal(inspection) {
  if (inspection?.status === "present") return new RequestSpoolError("REQUEST-LEGACY-PENDING");
  if (inspection?.status === "unsafe") return new RequestSpoolError("REQUEST-LEGACY-UNSAFE");
  return null;
}

export async function assertLegacyRequestDirectoryEmpty(directory) {
  const inspection = await inspectLegacyRequestDirectory(directory);
  const refusal = legacyRequestRefusal(inspection);
  if (refusal) throw refusal;
  return inspection;
}

/** Statuses a managed mutation may proceed with: what `setupRequestSpool` can repair or verify. */
const MUTATION_ACCEPTABLE_SPOOL = new Set(["absent", "adoptable", "ready", "not-private"]);

/**
 * Fixed refusal for a spool classification a managed mutation must not touch:
 * a foreign type/owner/marker, a nonempty unmarked directory, an unbounded
 * scan, or a directory whose strong identity cannot be proven (B5:
 * `identity-unavailable` - dry-run and real runs refuse it alike, before any
 * probe, journal, state, or harness mutation). `absent`, `adoptable`, `ready`,
 * and a repairable `not-private` mode are the states `setupRequestSpool` can
 * safely establish or normalize, so they never refuse. Returns `null` when the
 * inspection is acceptable.
 */
export function requestSpoolRefusal(inspection) {
  const status = inspection?.status;
  if (MUTATION_ACCEPTABLE_SPOOL.has(status)) return null;
  const codes = {
    "not-a-directory": "REQUEST-SPOOL-TYPE",
    "not-owned": "REQUEST-SPOOL-OWNER",
    "unmarked": "REQUEST-SPOOL-UNMARKED",
    "marker-invalid": "REQUEST-SPOOL-MARKER",
    excessive: "REQUEST-SPOOL-ENTRIES",
    "identity-unavailable": "REQUEST-IDENTITY-UNAVAILABLE",
  };
  return new RequestSpoolError(codes[status] ?? "REQUEST-IO-FAILED");
}

function classifyEntries(names, token) {
  const publicName = `${token}${PUBLIC_SUFFIX}`;
  let hasPublic = false;
  let claims = 0;
  for (const name of names) {
    if (name === publicName) {
      hasPublic = true;
      continue;
    }
    const match = CLAIM_PATTERN.exec(name);
    if (match && match[1] === token) claims += 1;
  }
  let status = "absent";
  if (hasPublic && claims > 0) status = "public-and-claim";
  else if (claims > 1) status = "multiple-claims";
  else if (claims === 1) status = "claim";
  else if (hasPublic) status = "public";
  return { status, hasPublic, claims };
}

/**
 * Public/claim presence for one token — the legacy preflight primitive.
 * Reports only a status and counts, never a path or the token itself. With
 * `{ legacy: true }` the directory needs no marker and only has to be
 * owner-private, because legacy `<state>/requests` predates the marker.
 */
export async function inspectRequestEntry(directory, token, options = {}) {
  assertDirectoryArgument(directory);
  if (!isValidRequestToken(token)) throw new RequestSpoolError("REQUEST-TOKEN-INVALID");
  const legacy = options.legacy === true;
  const { names } = await validateSpool(directory, { requireMarker: !legacy, legacy });
  const view = classifyEntries(names, token);
  return { status: view.status, public: view.hasPublic, claims: view.claims };
}

function selectTarget(stable, legacy) {
  const unstable = stable.status === "public-and-claim" || stable.status === "multiple-claims";
  const legacyUnstable =
    legacy !== null && (legacy.status === "public-and-claim" || legacy.status === "multiple-claims");
  const stableHas = stable.status !== "absent";
  const legacyHas = legacy !== null && legacy.status !== "absent";
  if (unstable || legacyUnstable || (stableHas && legacyHas)) {
    throw new RequestSpoolError("REQUEST-AMBIGUOUS");
  }
  if (stableHas) return stable;
  if (legacyHas) return legacy;
  throw new RequestSpoolError("REQUEST-ABSENT");
}

function singleClaimName(names, token) {
  let found = null;
  for (const name of names) {
    const match = CLAIM_PATTERN.exec(name);
    if (!match || match[1] !== token) continue;
    if (found) throw new RequestSpoolError("REQUEST-AMBIGUOUS");
    found = name;
  }
  if (!found) throw new RequestSpoolError("REQUEST-ABSENT");
  return found;
}

async function availableClaimPath(directory, token, knownNames) {
  for (let attemptNumber = 0; attemptNumber < CLAIM_NAME_ATTEMPTS; attemptNumber += 1) {
    const nonce = requestSpoolInternals.claimNonce();
    if (!isValidRequestToken(nonce)) throw new RequestSpoolError("REQUEST-CLAIM-NAME");
    const name = `.claim.${token}.${nonce}`;
    if (knownNames.includes(name)) continue;
    const existing = await lstatOptional(path.join(directory, name), { ENOTDIR: "REQUEST-CHANGED" });
    if (existing) continue;
    return path.join(directory, name);
  }
  throw new RequestSpoolError("REQUEST-AMBIGUOUS");
}

async function openNoFollow(target, absentCode) {
  try {
    return await requestSpoolInternals.openRead(target);
  } catch (error) {
    if (error instanceof RequestSpoolError) throw error;
    const errno = error?.code;
    if (errno === "ENOENT") throw new RequestSpoolError(absentCode);
    if (errno === "ELOOP" || errno === "EACCES" || errno === "EPERM") {
      throw new RequestSpoolError("REQUEST-ENTRY-TYPE");
    }
    throw new RequestSpoolError("REQUEST-ENTRY-OPEN");
  }
}

// Exact identity equality for two observations of one entry. An unprovable
// identity on either side is the stable `REQUEST-IDENTITY-UNAVAILABLE`
// refusal; a proven, strong mismatch stays `REQUEST-CHANGED`. Nothing here
// ever guesses at, adopts, or acts on an entry this filesystem cannot prove.
function assertSameEntryIdentity(live, expected) {
  if (!isIdentityAvailable(live) || !isIdentityAvailable(expected)) {
    throw new RequestSpoolError("REQUEST-IDENTITY-UNAVAILABLE");
  }
  if (!identitiesEqual(live, expected)) throw new RequestSpoolError("REQUEST-CHANGED");
}

// Opens O_RDONLY|O_NOFOLLOW and re-validates through the same fd's fstat:
// regular, current owner, exactly one link, size within the bound, a strong
// file identity, and the same inode the caller just inspected by path.
async function openAndVerify(target, expected, absentCode) {
  const handle = await openNoFollow(target, absentCode);
  try {
    const stat = await attempt(() => requestSpoolInternals.handleStat(handle), "REQUEST-IO-FAILED");
    assertEntryStat(stat);
    assertSameEntryIdentity(fileIdentity(stat), fileIdentity(expected));
    return { handle, stat };
  } catch (error) {
    try {
      await requestSpoolInternals.closeHandle(handle);
    } catch {
      // Closing is best effort; the original failure is what callers observe.
    }
    throw error;
  }
}

async function verifyPathIdentity(target, expected, absentCode) {
  const stat = await lstatOptional(target, { ENOTDIR: "REQUEST-CHANGED" });
  if (!stat) throw new RequestSpoolError(absentCode);
  if (!isRegularOwnedSingleLink(stat)) throw new RequestSpoolError("REQUEST-CHANGED");
  assertSameEntryIdentity(fileIdentity(stat), expected);
  return stat;
}

async function restrictClaimMode(handle, expected) {
  await attempt(() => requestSpoolInternals.handleChmod(handle, REQUEST_ENTRY_MODE), "REQUEST-CLAIM-MODE");
  const stat = await attempt(() => requestSpoolInternals.handleStat(handle), "REQUEST-CLAIM-MODE");
  if (modeOf(stat) !== REQUEST_ENTRY_MODE) throw new RequestSpoolError("REQUEST-CLAIM-MODE");
  if (!isRegularOwnedSingleLink(stat)) throw new RequestSpoolError("REQUEST-CHANGED");
  assertSameEntryIdentity(fileIdentity(stat), expected);
}

// Reads at most REQUEST_MAX_BYTES + 1 bytes through the fd so an entry that
// grew past the limit is detected without ever buffering unbounded input.
async function readBounded(handle) {
  const limit = REQUEST_MAX_BYTES + 1;
  const chunks = [];
  let total = 0;
  const buffer = Buffer.allocUnsafe(Math.min(limit, 65536));
  try {
    while (total < limit) {
      const want = Math.min(buffer.length, limit - total);
      const outcome = await requestSpoolInternals.handleRead(handle, buffer, 0, want, total);
      const bytesRead = Number(outcome?.bytesRead);
      if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > want) {
        throw new RequestSpoolError("REQUEST-READ-FAILED");
      }
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      total += bytesRead;
    }
  } catch (error) {
    if (error instanceof RequestSpoolError) throw error;
    throw new RequestSpoolError("REQUEST-READ-FAILED");
  }
  if (total > REQUEST_MAX_BYTES) throw new RequestSpoolError("REQUEST-ENTRY-TOO-LARGE");
  return Buffer.concat(chunks, total);
}

async function closeQuietly(handle) {
  if (!handle) return;
  try {
    await requestSpoolInternals.closeHandle(handle);
  } catch {
    // Closing is best effort; consumption already decided its outcome.
  }
}

async function consumeTarget(target, token, route) {
  const directory = target.directory;
  const publicPath = path.join(directory, `${token}${PUBLIC_SUFFIX}`);
  let handle = null;
  try {
    let claimPath;
    let openedIdentity;
    let initialSize;

    if (target.status === "public") {
      const before = await lstatRequired(publicPath, "REQUEST-ABSENT", { ENOTDIR: "REQUEST-CHANGED" });
      assertEntryStat(before);
      const opened = await openAndVerify(publicPath, before, "REQUEST-ABSENT");
      handle = opened.handle;
      // The fd's own fstat is the baseline: identity and size checks all
      // compare against the bytes this descriptor actually holds. Its
      // identity was already proven strong by `assertEntryStat`.
      openedIdentity = fileIdentity(opened.stat);
      initialSize = Number(opened.stat.size);
      // The fd may hold the pre-rename bytes; only rename the path if it still
      // points at exactly this inode.
      await verifyPathIdentity(publicPath, openedIdentity, "REQUEST-CHANGED");
      claimPath = await availableClaimPath(directory, token, target.names);
      await attempt(() => requestSpoolInternals.rename(publicPath, claimPath), "REQUEST-CLAIM-RENAME", {
        ENOENT: "REQUEST-CHANGED",
      });
      await syncDirectory(directory);
      await verifyPathIdentity(claimPath, openedIdentity, "REQUEST-CHANGED");
      await restrictClaimMode(handle, openedIdentity);
    } else {
      // Resume of exactly one interrupted claim left by a previous run.
      claimPath = path.join(directory, singleClaimName(target.names, token));
      const before = await lstatRequired(claimPath, "REQUEST-CHANGED", { ENOTDIR: "REQUEST-CHANGED" });
      assertEntryStat(before);
      const opened = await openAndVerify(claimPath, before, "REQUEST-CHANGED");
      handle = opened.handle;
      openedIdentity = fileIdentity(opened.stat);
      initialSize = Number(opened.stat.size);
      await restrictClaimMode(handle, openedIdentity);
    }

    const bytes = await readBounded(handle);
    await attempt(() => requestSpoolInternals.afterRead(), "REQUEST-READ-FAILED");
    const finalStat = await attempt(() => requestSpoolInternals.handleStat(handle), "REQUEST-READ-FAILED");
    if (
      !isRegularOwnedSingleLink(finalStat) ||
      !identitiesEqual(fileIdentity(finalStat), openedIdentity) ||
      Number(finalStat.size) !== initialSize ||
      bytes.length !== initialSize
    ) {
      throw new RequestSpoolError("REQUEST-CHANGED");
    }
    await verifyPathIdentity(claimPath, openedIdentity, "REQUEST-CHANGED");

    let text;
    try {
      text = utf8Decoder.decode(bytes);
    } catch {
      throw new RequestSpoolError("REQUEST-ENCODING");
    }
    if (!text.trim()) throw new RequestSpoolError("REQUEST-BODY-EMPTY");

    let result;
    try {
      result = await route(text);
    } catch {
      // Callback failures are reported without their message or cause so no
      // request byte can escape through an error property.
      throw new RequestSpoolError("REQUEST-ROUTE-FAILED");
    }

    await verifyPathIdentity(claimPath, openedIdentity, "REQUEST-CHANGED");
    // Exclusive consumption: rename the claim to a fresh same-directory name
    // before removing it. rename(2) is atomic, so exactly one concurrent
    // consumer can win even on platforms where two overlapping unlink(2) calls
    // on the same path may both report success (observed on darwin/APFS); the
    // loser observes a vanished source and fails without touching anything.
    // The destination still matches the claim grammar, so a crash right here
    // leaves exactly one resumable claim for a later consumer.
    const commitPath = await availableClaimPath(directory, token, [
      ...target.names,
      path.basename(claimPath),
    ]);
    await attempt(() => requestSpoolInternals.rename(claimPath, commitPath), "REQUEST-CLAIM-RENAME", {
      ENOENT: "REQUEST-CHANGED",
    });
    claimPath = commitPath;
    // Re-verify after the rename so a swapped-in replacement is never unlinked.
    await verifyPathIdentity(claimPath, openedIdentity, "REQUEST-CHANGED");
    // B1 exact-entry removal: the final destructive step never unlinks a name
    // that was verified one step earlier. The claim is renamed to one more
    // fresh, grammar-valid, unpredictable claim name (128 unpredictable bits,
    // so a hostile same-user process cannot pre-create or pre-swap it), the
    // claimed entry is verified to be exactly the consumed entry - regular,
    // owner, single link, strong identity equal to the fd's - that identity is
    // re-verified immediately before the unlink, and only the verified claim
    // is removed. A replacement at the public path, at the earlier claim, or
    // at this claim after verification survives untouched and fails closed.
    // The destination still matches the claim grammar, so a crash between the
    // rename and the unlink leaves exactly one resumable claim and at-most-once
    // delivery is preserved. Residual (documented): Node cannot atomically
    // bind an open fd to unlink(2), so the final verify->unlink window at the
    // unpredictable claim name is the strongest binding the platform offers.
    const removalPath = await availableClaimPath(directory, token, [
      ...target.names,
      path.basename(claimPath),
    ]);
    await attempt(() => requestSpoolInternals.rename(claimPath, removalPath), "REQUEST-CLAIM-RENAME", {
      ENOENT: "REQUEST-CHANGED",
    });
    await verifyPathIdentity(removalPath, openedIdentity, "REQUEST-CHANGED");
    // Re-verify immediately before the destructive unlink.
    await verifyPathIdentity(removalPath, openedIdentity, "REQUEST-CHANGED");
    await attempt(() => requestSpoolInternals.unlink(removalPath), "REQUEST-CLAIM-REMOVE", {
      ENOENT: "REQUEST-CHANGED",
    });
    // At-most-once boundary: after the unlink the request is consumed, so a
    // directory-sync failure here propagates and the callback result is lost.
    await syncDirectory(directory);
    return result;
  } finally {
    await closeQuietly(handle);
  }
}

/**
 * One-time consumer for a single token, meant to run under an existing
 * controlled-read lease. The stable spool must be set up and valid; an optional
 * `legacyDirectory` participates only when it exists and is owner-private.
 * Returns the `route(request)` result verbatim and never returns request bytes.
 *
 * Failure modes are fixed and bounded; every pre-commit failure preserves the
 * public entry or the exact claim, and unknown entries are never touched.
 */
export async function consumeRequest(options = {}) {
  const { directory, legacyDirectory, route, token } = options || {};
  assertDirectoryArgument(directory);
  if (legacyDirectory !== undefined && (typeof legacyDirectory !== "string" || legacyDirectory === "")) {
    throw new RequestSpoolError("REQUEST-ARGUMENT-INVALID");
  }
  if (!isValidRequestToken(token)) throw new RequestSpoolError("REQUEST-TOKEN-INVALID");
  if (typeof route !== "function") throw new RequestSpoolError("REQUEST-ROUTE-INVALID");

  const stableSpool = await validateSpool(directory, { requireMarker: true, legacy: false });
  const stable = {
    directory,
    names: stableSpool.names,
    status: classifyEntries(stableSpool.names, token).status,
  };

  let legacy = null;
  if (legacyDirectory !== undefined) {
    const stat = await lstatOptional(legacyDirectory, { ENOTDIR: "REQUEST-SPOOL-TYPE" });
    if (stat) {
      const legacySpool = await validateSpool(legacyDirectory, { requireMarker: false, legacy: true });
      legacy = {
        directory: legacyDirectory,
        names: legacySpool.names,
        status: classifyEntries(legacySpool.names, token).status,
      };
    }
  }

  return consumeTarget(selectTarget(stable, legacy), token, route);
}
