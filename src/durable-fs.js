// Durable filesystem primitives for skill-router control data.
//
// Every helper here is fail-closed: no symlink following on the final path
// component, exact bounded reads, owner-only modes for written files, and
// write -> fsync -> rename -> parent-dir-fsync ordering so control metadata
// survives process death. `durableFsInternals` is a narrow injection seam so
// tests can force deterministic fsync/rename/write failures, simulate a
// filesystem without strong file identity, and count lstat observations.
//
// This module owns the router's one file-identity semantic: `fileIdentity`
// tags every observation `available` or `unavailable`, `identitiesEqual` is
// false whenever either side is unavailable, destructive exact-entry helpers
// (`durableUnlink`, temp cleanup) only ever act on a strong identity, and the
// create helpers preflight the containing filesystem's identity support before
// any temp file, journal, payload, or control record can exist.
//
// Exact deletion (B1) is claim-based everywhere: `durableUnlink` renames the
// entry to a fresh unpredictable same-directory claim, verifies the claimed
// entry (regular file, same strong identity) twice - once after the rename and
// once immediately before the destructive step - and unlinks only that claim.
// A replacement at the original path, or a swapped claim, is preserved and
// fails closed. The documented residual (Node cannot bind an fd to unlink(2))
// lives in the `durableUnlink` comment.
//
// The POSIX privacy/mode checks here are never weakened for an unsupported
// runtime platform; refusing those runtimes is the platform guard's job (see
// `src/platform.js`).
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
const O_DIRECTORY = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;

export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

// Directory fsync is unsupported on some platforms/filesystems. Only these
// documented errors are tolerated; anything else (EIO, ENOSPC, ...) propagates.
const DIRECTORY_SYNC_UNSUPPORTED_CODES = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EPERM"]);

export function durableFsError(code, message, target) {
  const error = new Error(message);
  error.code = code;
  if (target !== undefined) error.path = target;
  return error;
}

/* ------------------------------------------------------------------ *
 * Centralized file identity (the only identity semantics in the router)
 * ------------------------------------------------------------------ */

/**
 * A dev/ino pair is *meaningful* (strong) only when both values are finite,
 * safe, non-negative integers and `ino` is not zero - exactly the shape POSIX
 * filesystems report and the shape the journal schema already records. Any
 * other observation (missing, zero, NaN, fractional, negative, or unsafe) is
 * tagged `unavailable` and never proves, equals, or authorizes anything:
 * comparisons against it are false and destructive operations that require it
 * fail closed with a stable domain error. Identities are never widened through
 * BigInt and the journal schema is unchanged.
 */
export const IDENTITY_STATUS = Object.freeze({ AVAILABLE: "available", UNAVAILABLE: "unavailable" });

const IDENTITY_UNAVAILABLE = Object.freeze({ status: IDENTITY_STATUS.UNAVAILABLE, dev: null, ino: null });

function strongIdentityParts(dev, ino) {
  return Number.isSafeInteger(dev) && dev >= 0 && Number.isSafeInteger(ino) && ino >= 0 && ino !== 0;
}

function taggedIdentity(dev, ino) {
  return strongIdentityParts(dev, ino) ? { status: IDENTITY_STATUS.AVAILABLE, dev, ino } : IDENTITY_UNAVAILABLE;
}

/** Tagged identity of an observed stat-like object. Values are never coerced:
 * only genuine finite, safe, non-negative integer numbers can be strong. */
export function fileIdentity(stat) {
  if (!stat || typeof stat !== "object") throw new TypeError("fileIdentity requires a stat object");
  return taggedIdentity(stat.dev, stat.ino);
}

/**
 * Normalizes a live (tagged) or recorded (plain `{ dev, ino }`) identity into
 * the tagged form. Anything unrecognizable - including a recorded zero/invalid
 * pair or a non-numeric value - normalizes to `unavailable`.
 */
function normalizeIdentity(value) {
  if (!value || typeof value !== "object") return IDENTITY_UNAVAILABLE;
  return taggedIdentity(value.dev, value.ino);
}

/** True only for a strong, available dev/ino identity. */
export function isIdentityAvailable(value) {
  return normalizeIdentity(value).status === IDENTITY_STATUS.AVAILABLE;
}

/**
 * True only when both identities are available and equal. An unavailable (or
 * absent) identity on either side is never equal - not even to another
 * unavailable identity - so two zero identities can never match, and an old
 * journal that recorded a zero/invalid pair can never prove a live entry.
 */
export function identitiesEqual(a, b) {
  const left = normalizeIdentity(a);
  const right = normalizeIdentity(b);
  if (left.status !== IDENTITY_STATUS.AVAILABLE || right.status !== IDENTITY_STATUS.AVAILABLE) return false;
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * The exact plain form durable records (journals, control metadata) may store:
 * `{ dev, ino }` when the identity is strong, `null` when it is unavailable.
 */
export function identityRecord(value) {
  const identity = normalizeIdentity(value);
  return identity.status === IDENTITY_STATUS.AVAILABLE ? { dev: identity.dev, ino: identity.ino } : null;
}

export function isOwnerOnlyMode(mode) {
  return Number.isInteger(mode) && (mode & 0o077) === 0;
}

export function sha256Bytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("sha256Bytes expects a Uint8Array");
  return createHash("sha256").update(bytes).digest("hex");
}

export function isUnsupportedDirectorySyncError(error) {
  const code = error && error.code;
  return typeof code === "string" && DIRECTORY_SYNC_UNSUPPORTED_CODES.has(code);
}

// Narrow deterministic-injection seam. Production callers must treat these as
// read-only; tests override individual entries and restore them afterwards.
export const durableFsInternals = {
  async lstat(target) {
    return fsp.lstat(target);
  },
  async writeChunk(handle, data, offset) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset, offset);
    return bytesWritten;
  },
  async writeAll(handle, data) {
    let offset = 0;
    while (offset < data.length) {
      const written = await durableFsInternals.writeChunk(handle, data, offset);
      if (!Number.isInteger(written) || written <= 0 || written > data.length - offset) {
        throw durableFsError("EIO", "Short write while writing file contents");
      }
      offset += written;
    }
  },
  async syncFile(handle) {
    await handle.sync();
  },
  async syncDirectoryHandle(handle) {
    await handle.sync();
  },
  async openDirectoryForSync(target) {
    return fsp.open(target, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  },
  async rename(from, to) {
    await fsp.rename(from, to);
  },
  async closeHandle(handle) {
    await handle.close();
  },
  tempName(basename) {
    return `.${basename}.${randomBytes(8).toString("hex")}.tmp`;
  },
  // Fresh, unpredictable, same-directory claim name used by exact-entry
  // removal (B1). 16 random bytes make the name non-predictive, so a hostile
  // same-user process cannot pre-create or pre-swap the entry we are about to
  // unlink.
  claimName(basename) {
    return `.${basename}.delete-${randomBytes(16).toString("hex")}`;
  },
  async afterReadProbe() {},
};

async function safeCloseHandle(handle) {
  if (!handle) return;
  try {
    await durableFsInternals.closeHandle(handle);
  } catch {
    // Closing is best effort; the primary error is what callers observe.
  }
}

function validateOwnerOnlyMode(mode, target) {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw new TypeError(`mode must be an integer between 0o000 and 0o777: ${target}`);
  }
  if ((mode & 0o077) !== 0) {
    throw durableFsError("EINVAL", `mode must be owner-only (no group/other permission bits): ${target}`, target);
  }
  return mode;
}

// Stable refusal when a filesystem cannot report the strong dev/ino identity
// every identity-checked create, claim, rename-verify, and unlink depends on.
function identityUnsupportedError(target) {
  return durableFsError("ENOTSUP", `Filesystem does not report a stable file identity: ${target}`, target);
}

/**
 * Preflight for every create: the directory that will hold the new entry must
 * sit on a filesystem that reports a strong dev/ino identity, checked *before*
 * any temp file, journal, payload, or control record exists there. Returns
 * true when the directory was observed, false when it is absent (the
 * operation itself keeps reporting the exact ENOENT it always did).
 */
export async function assertDirectoryIdentitySupport(directory) {
  let stat;
  try {
    stat = await durableFsInternals.lstat(directory);
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
  if (!isIdentityAvailable(fileIdentity(stat))) throw identityUnsupportedError(directory);
  return true;
}

async function assertReplaceableDestination(target) {
  let stat;
  try {
    stat = await durableFsInternals.lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw durableFsError("ELOOP", `Refusing to replace symbolic link: ${target}`, target);
  }
  if (!stat.isFile()) {
    throw durableFsError("EFTYPE", `Refusing to replace non-regular file: ${target}`, target);
  }
}

// Best-effort cleanup of one temp entry this call itself created. It only ever
// removes the *exact* entry: an unprovable identity (unavailable on this
// filesystem, or different from the one recorded at creation) preserves the
// entry - it is never guessed at, adopted, or deleted.
async function removeExactTemporary(temporaryPath, identity) {
  try {
    const stat = await durableFsInternals.lstat(temporaryPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return;
    if (!identitiesEqual(fileIdentity(stat), identity)) return;
    // Attributed removal only: the temp this call created is deleted through
    // the claim-based durableUnlink with its creation identity, so a
    // replacement that appears here survives (B1).
    await durableUnlink(temporaryPath, identity);
  } catch {
    // Cleanup is best effort; the original failure already determines the outcome.
  }
}

// Reads a regular file without following a final-path symlink.
// Returns exactly the file bytes; rejects symlink/non-regular/growth/oversize.
// ENOENT only resolves to null when the caller opts in via `allowMissing`.
// With `withIdentity: true` the result is `{ bytes, identity }`, where
// `identity` is the strong tagged identity observed on the very handle the
// bytes were read through - so a caller can carry the identity of *these
// bytes* through a later destructive or publish step (B2/B3).
export async function readRegularFileNoFollow(target, options = {}) {
  const maxBytes = options.maxBytes === undefined ? DEFAULT_MAX_FILE_BYTES : options.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("maxBytes must be a non-negative safe integer");
  }
  const allowMissing = options.allowMissing === true;
  const withIdentity = options.withIdentity === true;

  let before;
  try {
    before = await durableFsInternals.lstat(target);
  } catch (error) {
    if (error.code === "ENOENT" && allowMissing) return null;
    throw error;
  }
  if (before.isSymbolicLink()) {
    throw durableFsError("ELOOP", `Refusing to follow symbolic link: ${target}`, target);
  }
  if (!before.isFile()) {
    throw durableFsError("EFTYPE", `Refusing to read non-regular file: ${target}`, target);
  }
  if (before.size > maxBytes) {
    throw durableFsError("EFBIG", `File exceeds maximum size of ${maxBytes} bytes: ${target}`, target);
  }

  let handle;
  try {
    handle = await fsp.open(target, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ENOENT" && allowMissing) return null;
    if (error.code === "ELOOP") {
      throw durableFsError("ELOOP", `Refusing to follow symbolic link: ${target}`, target);
    }
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw durableFsError("EFTYPE", `Refusing to read non-regular file: ${target}`, target);
    }
    if (!identitiesEqual(fileIdentity(before), fileIdentity(opened))) {
      throw durableFsError("EBUSY", `File changed while reading: ${target}`, target);
    }
    if (opened.size !== before.size) {
      throw durableFsError("EBUSY", `File changed while reading: ${target}`, target);
    }
    if (opened.size > maxBytes) {
      throw durableFsError("EFBIG", `File exceeds maximum size of ${maxBytes} bytes: ${target}`, target);
    }

    const limit = maxBytes + 1;
    const chunks = [];
    let total = 0;
    let position = 0;
    const buffer = Buffer.allocUnsafe(Math.min(limit, 65536));
    for (;;) {
      const want = Math.min(buffer.length, limit - total);
      if (want <= 0) break;
      const { bytesRead } = await handle.read(buffer, 0, want, position);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      total += bytesRead;
      position += bytesRead;
      if (total > maxBytes) {
        throw durableFsError("EFBIG", `File exceeds maximum size of ${maxBytes} bytes: ${target}`, target);
      }
    }
    if (total > maxBytes) {
      throw durableFsError("EFBIG", `File exceeds maximum size of ${maxBytes} bytes: ${target}`, target);
    }

    await durableFsInternals.afterReadProbe(target);

    const after = await handle.stat();
    if (after.size !== opened.size || total !== opened.size) {
      throw durableFsError("EBUSY", `File changed while reading: ${target}`, target);
    }
    const bytes = Buffer.concat(chunks, total);
    if (withIdentity) return { bytes, identity: fileIdentity(opened) };
    return bytes;
  } finally {
    await safeCloseHandle(handle);
  }
}

// Atomic, durable write: same-directory exclusive temp -> write all bytes ->
// file fsync -> close -> reject non-regular destination -> rename -> parent
// fsync. On pre-rename failure the exact temp (identity-checked) is removed.
// The destination must not be a symlink or other non-regular file, and the
// applied mode must be owner-only.
export async function durableAtomicWrite(target, bytes, options = {}) {
  if (typeof target !== "string" || target.length === 0) {
    throw new TypeError("target must be a non-empty path");
  }
  if (!(bytes instanceof Uint8Array)) throw new TypeError("bytes must be a Uint8Array");
  const mode = validateOwnerOnlyMode(options.mode === undefined ? 0o600 : options.mode, target);
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const directory = path.dirname(target);
  const basename = path.basename(target);

  await assertReplaceableDestination(target);
  // Identity preflight before the temp file exists: a filesystem that cannot
  // report a strong dev/ino pair must never receive an identity-checked temp.
  await assertDirectoryIdentitySupport(directory);

  const temporaryPath = path.join(directory, durableFsInternals.tempName(basename));
  let handle = null;
  let created = false;
  let renamed = false;
  let temporaryIdentity = null;
  try {
    handle = await fsp.open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
      mode,
    );
    created = true;
    temporaryIdentity = fileIdentity(await handle.stat());
    await handle.chmod(mode);
    if (data.length > 0) await durableFsInternals.writeAll(handle, data);
    await durableFsInternals.syncFile(handle, temporaryPath);
    await durableFsInternals.closeHandle(handle);
    handle = null;

    await assertReplaceableDestination(target);
    await durableFsInternals.rename(temporaryPath, target);
    renamed = true;
    await syncDirectory(directory);
  } catch (error) {
    await safeCloseHandle(handle);
    if (created && !renamed) await removeExactTemporary(temporaryPath, temporaryIdentity);
    throw error;
  }
  return target;
}

// Durably creates a NEW file at its final pathname without ever replacing an
// existing entry. A temp+rename is not sufficient here: rename could clobber an
// attacker-created destination between the existence check and the swap, so
// this opens the final path directly with O_CREAT|O_EXCL|O_NOFOLLOW (no
// hard-link tricks), writes every byte, fsyncs the file, closes it, and fsyncs
// the parent directory. The applied mode must be owner-only.
//
// Failure handling: any failure before the file is fully written and synced
// removes the file only while its identity still matches the handle this call
// created (a swapped-in foreign entry is preserved). Once the file itself is
// durable, a parent-fsync failure propagates without deleting the committed
// creation.
export async function durableCreateFile(target, bytes, options = {}) {
  if (typeof target !== "string" || target.length === 0) {
    throw new TypeError("target must be a non-empty path");
  }
  if (!(bytes instanceof Uint8Array)) throw new TypeError("bytes must be a Uint8Array");
  const mode = validateOwnerOnlyMode(options.mode === undefined ? 0o600 : options.mode, target);
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Identity preflight before the final-path exclusive create: a filesystem
  // that cannot report a strong dev/ino pair must never receive a journal,
  // payload, or control record that later steps would have to verify.
  await assertDirectoryIdentitySupport(path.dirname(target));

  let handle = null;
  let created = false;
  let committed = false;
  let createdIdentity = null;
  try {
    try {
      handle = await fsp.open(
        target,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
        mode,
      );
    } catch (error) {
      if (error.code === "EEXIST") throw await existingEntryError(target);
      throw error;
    }
    created = true;
    createdIdentity = fileIdentity(await handle.stat());
    await handle.chmod(mode);
    if (data.length > 0) await durableFsInternals.writeAll(handle, data);
    await durableFsInternals.syncFile(handle, target);
    await durableFsInternals.closeHandle(handle);
    handle = null;
    committed = true;
    await syncDirectory(path.dirname(target));
  } catch (error) {
    await safeCloseHandle(handle);
    if (created && !committed) await removeExactTemporary(target, createdIdentity);
    throw error;
  }
  return target;
}

// Classifies an EEXIST at the final path for a helpful, fail-closed code.
async function existingEntryError(target) {
  try {
    const stat = await fsp.lstat(target);
    if (stat.isSymbolicLink()) {
      return durableFsError("ELOOP", `Refusing to create over symbolic link: ${target}`, target);
    }
    if (!stat.isFile()) {
      return durableFsError("EFTYPE", `Refusing to create over non-regular file: ${target}`, target);
    }
    return durableFsError("EEXIST", `File already exists: ${target}`, target);
  } catch {
    return durableFsError("EEXIST", `File already exists: ${target}`, target);
  }
}

// Renames exactly `from` to `to` and syncs both affected parent directories.
export async function durableRename(from, to) {
  await durableFsInternals.rename(from, to);
  const fromDirectory = path.dirname(from);
  const toDirectory = path.dirname(to);
  await syncDirectory(fromDirectory);
  if (toDirectory !== fromDirectory) await syncDirectory(toDirectory);
}

// Verifies the claimed entry still is the exact entry observed at `target`: a
// regular, non-symlink file carrying the same strong identity.
async function verifyClaimedEntry(claimPath, identity, target) {
  let claimed;
  try {
    claimed = await durableFsInternals.lstat(claimPath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw durableFsError("EBUSY", `Entry vanished while it was being removed: ${target}`, target);
    }
    throw error;
  }
  if (claimed.isSymbolicLink() || !claimed.isFile()) {
    throw durableFsError("EBUSY", `Refusing to unlink a replaced entry: ${target}`, target);
  }
  if (!isIdentityAvailable(fileIdentity(claimed))) throw identityUnsupportedError(target);
  if (!identitiesEqual(fileIdentity(claimed), identity)) {
    throw durableFsError("EBUSY", `Refusing to unlink a replaced entry: ${target}`, target);
  }
  return claimed;
}

// Unlinks exactly one filesystem entry (never a broad deletion) and syncs the
// parent directory. Directories are refused, and the entry must carry a strong,
// available file identity: an entry this filesystem cannot prove is never
// unlinked (stable `ENOTSUP` refusal, artifact preserved).
//
// B1 exact-entry removal with caller attribution: the original pathname is
// never handed to unlink(2). An *attributed* caller passes the exact strong
// identity it observed earlier (`expectedIdentity`); this call's first
// observation and every claim verification must match that identity, so a
// replacement that appeared anywhere - before this call, at the claim, or
// between the claim checks - is already a refusal (`EBUSY`, artifact
// preserved). The entry is first renamed to a fresh, unpredictable,
// same-directory claim name, the claimed entry is verified against the
// attributed identity twice (once after the rename and once immediately
// before the destructive step), and only that verified claim is unlinked.
//
// The expected identity is MANDATORY: there is no observe-and-delete fallback.
// A caller that cannot attribute the entry must not delete it - a valid
// leftover is always preferable to an unattributed removal.
//
// Residual trust boundary: Node cannot atomically bind an open fd to
// unlink(2) - there is no `unlinkat(fd, ...)` binding in the API - so a
// hostile *same-user* process that can race the final verify->unlink window
// at the unpredictable claim name is not absolutely excluded. The claim name
// carries 128 random bits (never derivable or pre-creatable in advance), the
// window contains no other syscall, and every earlier window is
// identity-checked - which is the strongest binding the platform offers.
export async function durableUnlink(target, expectedIdentity) {
  if (expectedIdentity === null || expectedIdentity === undefined) {
    throw new TypeError("durableUnlink requires the caller's expected file identity");
  }
  if (typeof expectedIdentity !== "object" || Array.isArray(expectedIdentity)) {
    throw new TypeError("expectedIdentity must be a tagged or recorded file identity");
  }
  if (!isIdentityAvailable(expectedIdentity)) throw identityUnsupportedError(target);
  const expected = expectedIdentity;

  const stat = await durableFsInternals.lstat(target);
  if (stat.isDirectory()) {
    throw durableFsError("EFTYPE", `Refusing to unlink directory: ${target}`, target);
  }
  const identity = fileIdentity(stat);
  if (!isIdentityAvailable(identity)) throw identityUnsupportedError(target);
  if (expected !== null && !identitiesEqual(identity, expected)) {
    // The entry at the path is not the entry the caller attributed: a
    // replacement that appeared before this call is never removed.
    throw durableFsError("EBUSY", `Refusing to unlink an entry that is not the attributed one: ${target}`, target);
  }

  const directory = path.dirname(target);
  const claimPath = path.join(directory, durableFsInternals.claimName(path.basename(target)));
  try {
    await durableFsInternals.rename(target, claimPath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw durableFsError("ENOENT", `No such file to unlink: ${target}`, target);
    }
    throw error;
  }
  // Every claim check matches the attributed identity (`identity` is exactly
  // the caller's identity whenever one was supplied).
  await verifyClaimedEntry(claimPath, identity, target);
  // Recheck immediately before the destructive step.
  await verifyClaimedEntry(claimPath, identity, target);
  await fsp.unlink(claimPath);
  await syncDirectory(directory);
}

// Attempts an fsync on a directory. Returns true when fsync ran, false when
// only a documented unsupported-platform error was suppressed. Other errors
// propagate.
export async function syncDirectory(target) {
  let handle;
  try {
    handle = await durableFsInternals.openDirectoryForSync(target);
  } catch (error) {
    if (isUnsupportedDirectorySyncError(error)) return false;
    throw error;
  }
  try {
    try {
      await durableFsInternals.syncDirectoryHandle(handle, target);
    } catch (error) {
      if (isUnsupportedDirectorySyncError(error)) return false;
      throw error;
    }
    return true;
  } finally {
    await safeCloseHandle(handle);
  }
}
