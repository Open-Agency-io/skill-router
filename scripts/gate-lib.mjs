// Phase 11 release-gate library: provider-neutral, built-ins-only helpers
// shared by the clean-candidate gate (`scripts/clean-candidate.mjs`) and the
// release artifact builder (`scripts/release-dist.mjs`).
//
// Design rules:
// - Validation helpers (version/tag match, tarball identity, pack output,
//   checksum files, output bounds, environment scrubbing) are pure: they never
//   touch the filesystem, the network, or the real repository, so every claim
//   they make can be discriminated by a unit test.
// - `runCommand` is the only child-process primitive. Each execution is
//   bounded in output and time, runs as its own POSIX process group, and
//   terminates that group before it settles. Within that boundary — ordinary
//   descendants that stay in the child's process group — a hung pipe, a
//   lingering descendant, or a runaway command cannot outlive a gate step.
//   Outside it: a descendant that detaches or re-daemonizes (new session/
//   process group) is *not* signalled and *may* outlive the step; that
//   limitation is retained deliberately and is never reported as a kill (see
//   the trust boundary below). Settlement is driven by the child's *exit* plus
//   a bounded drain grace, then every stream and listener is destroyed, so an
//   inherited pipe held by any process — in-group or detached — can neither
//   delay nor hang the gate itself.
// - Every command is resolved to a canonical absolute path *before* it runs
//   with a candidate working directory: PATH components must be absolute and
//   non-empty (a `PATH=.` entry is refused outright, so a relative component
//   can never resolve differently when the child's cwd moves into a candidate
//   tree), and a tool that resolves — before or after canonicalisation — into a
//   forbidden root (the candidate repository) is refused.
// - Child output is decoded as strict UTF-8 across chunk boundaries. A `-z`
//   path list therefore cannot be corrupted by a multi-byte character split
//   between two reads, and a non-UTF-8 filename fails the step closed instead
//   of silently becoming a mangled candidate path.
// - Every failure is a `GateFailure` carrying a step label plus bounded
//   details, so callers fail closed with readable diagnostics instead of a
//   stack trace.
//
// Trust boundary (stated, not oversold): this library is an *integrity and
// reproducibility* gate that executes trusted candidate tests — it is not an
// OS sandbox and claims no containment against hostile same-user code.
// Supported containment is exactly "ordinary descendants that remain in the
// child's process group": those are signalled SIGTERM then SIGKILL before the
// step settles, and only those are counted in a step's `survived` result. A
// descendant that intentionally detaches (new session/process group) — or a
// re-daemonized service — leaves that boundary; it may outlive the step, the
// gate neither observes nor claims to have killed it, and it is free to read
// anything the gate's own user can read. Environment scrubbing is hygiene for
// trusted tests (recognized credential/config channels stripped, no write
// token supplied by the gate), not a defense against code that can read the
// gate process itself. Documented limits: process-group signalling is POSIX
// only; on Windows only the direct child can be signalled and live Windows
// validation is a later gate. Output bounds keep the *tail* of each stream
// (that is where npm and test-runner failures are reported) and are counted in
// UTF-16 code units; output still arriving after the drain grace is dropped
// rather than allowed to hold the gate open.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants as FS, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync, writeSync } from "node:fs";
import path from "node:path";

export class GateFailure extends Error {
  constructor(step, message, details = []) {
    super(message);
    this.name = "GateFailure";
    this.code = "GATE_FAILURE";
    this.step = String(step);
    this.details = details;
  }
}

/** Per-stream capture bound for child stdout/stderr, in code units. */
export const OUTPUT_LIMIT_CHARS = 64 * 1024;
/** Per-detail bound when a GateFailure is rendered for a terminal. */
export const DIAGNOSTIC_LIMIT_CHARS = 8 * 1024;
/** Default bound for a single gate command. */
export const STEP_TIMEOUT_MS = 10 * 60 * 1000;
/** Grace between SIGTERM and SIGKILL while terminating a child group. */
export const KILL_GRACE_MS = 1500;
/** Default overall budget for one clean-candidate gate run. */
export const GATE_TIMEOUT_MS = 20 * 60 * 1000;
/** Set on every gate child; a gate refuses to start under its own flag. */
export const GATE_ENV_FLAG = "SKILL_ROUTER_GATE_ACTIVE";
/**
 * `O_NOFOLLOW` where the platform has it (0 elsewhere: Windows validation is a
 * later gate, and every caller still lstat/fstat-checks the path it opened).
 */
export const NO_FOLLOW = process.platform === "win32" ? 0 : FS.O_NOFOLLOW;
/** Bounded wait for trailing output after a child's exit before we settle. */
export const DRAIN_GRACE_MS = 300;

/** Exact semantic version (no leading zeros, no empty prerelease segments). */
export const VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const FORBIDDEN_PACKAGE_SEGMENTS = new Set(["node_modules", ".git"]);

/**
 * Keep only the tail of a string, bounded to `max` code units, and report
 * whether anything was dropped. Never throws: a non-string becomes "".
 */
export function boundTail(text, max = OUTPUT_LIMIT_CHARS) {
  if (typeof text !== "string" || text.length === 0) return { text: "", truncated: false };
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(text.length - max), truncated: true };
}

/** Remove control bytes (except newline/tab) so diagnostics cannot emit them. */
export function sanitizeDiagnostic(text) {
  if (typeof text !== "string") return "";
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "\u00b7");
}

/**
 * Exact `v<version>` tag match. Both sides must already be strings; the
 * version must be a full semantic version and the tag must be exactly `v`
 * plus that version — no prefix, suffix, whitespace, or case variation.
 */
export function assertTagMatchesVersion(tag, version) {
  if (typeof tag !== "string" || tag === "") {
    throw new GateFailure("tag", "a release tag is required (expected exactly `v` plus the package.json version)");
  }
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new GateFailure("tag", `package.json version ${JSON.stringify(version)} is not an exact semantic version`);
  }
  const expected = `v${version}`;
  if (tag !== expected) {
    throw new GateFailure("tag", `tag ${JSON.stringify(tag)} does not exactly match package.json version (expected ${JSON.stringify(expected)})`);
  }
  return { tag, version, expected };
}

/**
 * The tarball filename npm must produce: scope and leading `@` collapse to a
 * single dash. The version is re-validated so a crafted version cannot turn
 * the filename into a path.
 */
export function expectedTarballFilename(name, version) {
  if (typeof name !== "string" || name === "") {
    throw new GateFailure("pack", "package name is missing");
  }
  if (!VERSION_PATTERN.test(version)) {
    throw new GateFailure("pack", `refusing to derive a tarball name from version ${JSON.stringify(version)}`);
  }
  const parts = name.split("/");
  const plain = /^[0-9A-Za-z._~-]+$/;
  const scoped = parts.length === 2 && parts[0].startsWith("@") && parts[0].length > 1 && plain.test(parts[0].slice(1)) && plain.test(parts[1]);
  if (!(parts.length === 1 && plain.test(parts[0])) && !scoped) {
    throw new GateFailure("pack", `package name ${JSON.stringify(name)} is not a safe npm name`);
  }
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

/** Reject any pack-relative path that could escape or smuggle build state. */
function assertSafePackagePath(p) {
  if (typeof p !== "string" || p === "" || p.includes("\\") || p.startsWith("/")) {
    throw new GateFailure("pack", `unsafe path in pack output: ${JSON.stringify(p)}`);
  }
  if (/^[A-Za-z]:/.test(p)) {
    throw new GateFailure("pack", `absolute path in pack output: ${JSON.stringify(p)}`);
  }
  const segments = p.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new GateFailure("pack", `traversing path in pack output: ${JSON.stringify(p)}`);
  }
  for (const segment of segments) {
    if (FORBIDDEN_PACKAGE_SEGMENTS.has(segment)) {
      throw new GateFailure("pack", `build state leaked into the tarball: ${JSON.stringify(p)}`);
    }
  }
}

/**
 * Validate `npm pack --json` output against the package identity: exactly one
 * entry, exact name/version/filename, safe relative file paths, and every
 * required file present. Returns the normalized artifact description.
 */
export function parsePackResult(raw, { name, version, requiredFiles = [] }) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new GateFailure("pack", "npm pack produced no JSON output");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GateFailure("pack", "npm pack output is not valid JSON", [["stdout", raw, true]]);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new GateFailure("pack", `npm pack reported ${Array.isArray(parsed) ? parsed.length : "no"} artifacts, expected exactly one`, [["stdout", raw, true]]);
  }
  const entry = parsed[0] ?? {};
  if (entry.name !== name) {
    throw new GateFailure("pack", `tarball name ${JSON.stringify(entry.name)} does not match package name ${JSON.stringify(name)}`);
  }
  if (entry.version !== version) {
    throw new GateFailure("pack", `tarball version ${JSON.stringify(entry.version)} does not match package version ${JSON.stringify(version)}`);
  }
  const expected = expectedTarballFilename(name, version);
  if (entry.filename !== expected) {
    throw new GateFailure("pack", `tarball filename ${JSON.stringify(entry.filename)} does not match expected ${JSON.stringify(expected)}`);
  }
  if (!Array.isArray(entry.files) || entry.files.length === 0) {
    throw new GateFailure("pack", "npm pack reported no file list");
  }
  const files = [];
  for (const file of entry.files) {
    const p = file?.path;
    assertSafePackagePath(p);
    files.push(p);
  }
  for (const required of requiredFiles) {
    if (!files.includes(required)) {
      throw new GateFailure("pack", `tarball is missing required file ${JSON.stringify(required)}`);
    }
  }
  return { name, version, filename: expected, files, size: typeof entry.size === "number" ? entry.size : null };
}

function assertChecksumFilename(filename) {
  if (typeof filename !== "string" || filename === "") {
    throw new GateFailure("checksum", "artifact filename is missing");
  }
  if (!/^[0-9A-Za-z][0-9A-Za-z._~+-]*$/.test(filename)) {
    throw new GateFailure("checksum", `artifact filename must be a plain name: ${JSON.stringify(filename)}`);
  }
}

/**
 * `sha256sum`-compatible file content: one `<hex><two spaces><name>` line per
 * artifact, sorted by filename so the bytes are deterministic.
 */
export function formatChecksumFile(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new GateFailure("checksum", "at least one artifact is required for a checksum file");
  }
  const seen = new Set();
  const normalized = entries.map((entry) => {
    const { filename, digest } = entry ?? {};
    assertChecksumFilename(filename);
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new GateFailure("checksum", `digest for ${JSON.stringify(filename)} is not a lowercase sha256 hex value`);
    }
    if (seen.has(filename)) {
      throw new GateFailure("checksum", `duplicate artifact in checksum file: ${JSON.stringify(filename)}`);
    }
    seen.add(filename);
    return { filename, digest };
  });
  normalized.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return normalized.map((entry) => `${entry.digest}  ${entry.filename}\n`).join("");
}

/** Parse a checksum file strictly; any deviation from the format is an error. */
export function parseChecksumFile(text) {
  if (typeof text !== "string" || text === "") {
    throw new GateFailure("checksum", "checksum file is empty");
  }
  if (text.includes("\r")) {
    throw new GateFailure("checksum", "checksum file must use LF line endings");
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] !== "") {
    throw new GateFailure("checksum", "checksum file must end with a newline");
  }
  lines.pop();
  const seen = new Set();
  const entries = lines.map((line, index) => {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) {
      throw new GateFailure("checksum", `line ${index + 1} is not a valid sha256sum record: ${JSON.stringify(boundTail(line, 200).text)}`);
    }
    const [, digest, filename] = match;
    assertChecksumFilename(filename);
    if (seen.has(filename)) {
      throw new GateFailure("checksum", `duplicate artifact in checksum file: ${JSON.stringify(filename)}`);
    }
    seen.add(filename);
    return { filename, digest };
  });
  return entries;
}

/**
 * `dev:ino` identity for POSIX inode semantics; `null` where the platform or
 * the filesystem cannot express one (Windows, `ino <= 0`). Callers degrade to
 * type/size checks there and say so — an unavailable identity is never treated
 * as "the same file".
 */
export function inodeIdentity(stats) {
  if (process.platform === "win32") return null;
  if (!Number.isFinite(stats?.ino) || stats.ino <= 0) return null;
  if (!Number.isFinite(stats?.dev)) return null;
  return `${stats.dev}:${stats.ino}`;
}

/** Git-comparable mode: exactly `100755` when any execute bit is set. */
export function normalizedExecutableMode(mode) {
  return (Number(mode) & 0o111) !== 0 ? 0o755 : 0o644;
}

/** Comparable stat record: type, size, normalized mode, permissions, links. */
export function fileRecord(stats) {
  return {
    type: stats.isDirectory() ? "directory" : stats.isSymbolicLink() ? "symlink" : stats.isFile() ? "file" : "special",
    size: stats.size,
    mode: normalizedExecutableMode(stats.mode),
    perm: stats.mode & 0o777,
    nlink: stats.nlink,
    dev: stats.dev,
    ino: stats.ino,
  };
}

function identityDrift(before, after) {
  const fields = [];
  if (before.dev !== after.dev || before.ino !== after.ino) fields.push(`identity ${before.dev}:${before.ino} -> ${after.dev}:${after.ino}`);
  if (before.size !== after.size) fields.push(`size ${before.size} -> ${after.size}`);
  if (before.mode !== after.mode) fields.push(`mode ${before.mode} -> ${after.mode}`);
  if (before.nlink !== after.nlink) fields.push(`link count ${before.nlink} -> ${after.nlink}`);
  return fields;
}

/** Open an existing file without ever following a final symlink. */
function openNoFollow(target, flags, step, describe = null) {
  const shown = describe ?? JSON.stringify(target);
  try {
    return openSync(target, flags | NO_FOLLOW);
  } catch (error) {
    const code = error?.code ?? String(error);
    if (code === "ELOOP" || code === "ENOTDIR") {
      throw new GateFailure(step, `refusing to open ${shown} through a symbolic link (${code})`);
    }
    throw new GateFailure(step, `cannot open ${shown}: ${code}`);
  }
}

/**
 * Hash the bytes reachable from an open descriptor. `position === null` reads
 * from the descriptor's current offset; a number reads from that offset and
 * leaves the descriptor's own offset untouched (used for the verification
 * pass). Never opens a path, so a swap of the path cannot redirect the read.
 */
function hashDescriptor(fd, position = null) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let at = position;
  let bytes = 0;
  for (;;) {
    const read = readSync(fd, buffer, 0, buffer.length, at);
    if (read <= 0) break;
    hash.update(buffer.subarray(0, read));
    bytes += read;
    if (at !== null) at += read;
  }
  return { digest: hash.digest("hex"), bytes };
}

/**
 * sha256 of a regular file, hardened:
 * - lstat first (symlinks and special entries are refused with the historical
 *   message), then `O_RDONLY|O_NOFOLLOW`, so a path swapped to a link between
 *   the two calls fails closed instead of following it;
 * - fstat before and after the read on the *same descriptor*, requiring stable
 *   dev/ino/size/mode/link count;
 * - `maxLinkCount` (default 1) refuses hard-linked files, whose content can be
 *   rewritten from outside this gate;
 * - the bytes are hashed twice and the digests must agree, so a same-size
 *   in-place rewrite during the read is detected.
 *
 * `hook` is a test-only seam invoked at named points; production callers never
 * set it.
 */
export async function sha256File(file, { step = "checksum", maxLinkCount = 1, hook = null } = {}) {
  const notify = (point) => {
    if (typeof hook === "function") hook(point);
  };
  let stats;
  try {
    stats = lstatSync(file);
  } catch (error) {
    throw new GateFailure(step, `cannot stat ${JSON.stringify(file)}: ${error?.code ?? String(error)}`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new GateFailure(step, `refusing to hash a non-regular file: ${JSON.stringify(file)}`);
  }
  notify("after-lstat");
  const fd = openNoFollow(file, FS.O_RDONLY, step);
  try {
    notify("after-open");
    const before = fstatSync(fd);
    if (!before.isFile()) {
      throw new GateFailure(step, `refusing to hash a non-regular file: ${JSON.stringify(file)}`);
    }
    if (Number.isFinite(maxLinkCount) && before.nlink > maxLinkCount) {
      throw new GateFailure(
        step,
        `refusing to hash a file with ${before.nlink} hard links (at most ${maxLinkCount} allowed): ${JSON.stringify(file)}`,
      );
    }
    notify("after-pre");
    const first = hashDescriptor(fd, 0);
    notify("mid-hash");
    const second = hashDescriptor(fd, 0);
    if (first.digest !== second.digest) {
      throw new GateFailure(step, `file changed while it was being hashed: ${JSON.stringify(file)}`);
    }
    const after = fstatSync(fd);
    const drift = identityDrift(before, after);
    if (drift.length > 0 || first.bytes !== after.size) {
      throw new GateFailure(step, `file changed while it was being hashed: ${JSON.stringify(file)}`, [
        ["detail", drift.join("; ") || `read ${first.bytes} of ${after.size} bytes`],
      ]);
    }
    return first.digest;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

/**
 * Read a regular file through a bounded, no-follow descriptor and return
 * `{ text, sha256, size, mode, perm, nlink, identity }`.
 *
 * Guarantees, in order:
 * 1. lstat first — missing, symlink, non-regular (a FIFO can therefore never
 *    block the reader), and hard-linked files are refused before anything is
 *    opened;
 * 2. `O_RDONLY|O_NOFOLLOW` open plus pre-fstat — regular, single-link, and a
 *    size already above `maxBytes` is refused *before* any buffer is
 *    allocated (the read itself is additionally capped at `maxBytes`);
 * 3. strict UTF-8 decode and a sha256 digest over exactly the bytes read;
 * 4. post-fstat must match the pre-fstat dev/ino/size/mode/link count, so a
 *    swap or a mutation during the read fails closed.
 *
 * Diagnostics name only `label` — never an absolute path and never file bytes —
 * so a caller can refuse without disclosing what the file (or whatever it was
 * swapped for) contains. `hook` is a test-only seam invoked at named points
 * (`after-lstat`, `after-open`, `after-pre`, `mid-read`); production callers
 * never set it.
 */
export function readRegularFileBounded(file, { step = "read", label = "file", maxBytes = 1024 * 1024, hook = null } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new GateFailure(step, `${label}: unusable read limit`);
  }
  const notify = (point) => {
    if (typeof hook === "function") hook(point);
  };
  let stats;
  try {
    stats = lstatSync(file);
  } catch (error) {
    throw new GateFailure(step, `${label} is missing or unreadable (${error?.code ?? String(error)})`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new GateFailure(step, `${label} must be an ordinary regular file`);
  }
  if (stats.nlink > 1) {
    throw new GateFailure(step, `${label} must be a single-link file (it has ${stats.nlink} links)`);
  }
  if (stats.size > maxBytes) {
    throw new GateFailure(step, `${label} exceeds the ${maxBytes}-byte read limit`);
  }
  notify("after-lstat");
  const fd = openNoFollow(file, FS.O_RDONLY, step, label);
  try {
    notify("after-open");
    const before = fstatSync(fd);
    if (!before.isFile()) {
      throw new GateFailure(step, `${label} must be an ordinary regular file`);
    }
    if (before.nlink > 1) {
      throw new GateFailure(step, `${label} must be a single-link file (it has ${before.nlink} links)`);
    }
    if (before.size > maxBytes) {
      throw new GateFailure(step, `${label} exceeds the ${maxBytes}-byte read limit`);
    }
    notify("after-pre");
    const buffer = Buffer.allocUnsafe(before.size);
    let total = 0;
    while (total < buffer.length) {
      const read = readSync(fd, buffer, total, buffer.length - total, total);
      if (read <= 0) break;
      total += read;
    }
    notify("mid-read");
    const after = fstatSync(fd);
    const drift = identityDrift(before, after);
    if (drift.length > 0 || total !== after.size) {
      throw new GateFailure(step, `${label} changed while it was being read`, [
        ["detail", drift.join("; ") || `read ${total} of ${after.size} bytes`],
      ]);
    }
    const bytes = buffer.subarray(0, total);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new GateFailure(step, `${label} is not valid UTF-8`);
    }
    return {
      text,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: after.size,
      mode: normalizedExecutableMode(after.mode),
      perm: after.mode & 0o777,
      nlink: after.nlink,
      identity: inodeIdentity(after),
    };
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

/**
 * Copy one regular file through descriptors only: open the source with
 * `O_NOFOLLOW`, require a single-linked regular file, stream it into a freshly
 * created `O_EXCL|O_NOFOLLOW` target while hashing, re-read the source for a
 * second digest, and re-hash the target — every digest must agree and both
 * fstats must be stable. Returns the recorded `{ size, sha256, mode, nlink }`
 * so the caller can bind the copy to the candidate manifest.
 */
export function copyRegularFileNoFollow({ source, target, step = "build" }) {
  const srcFd = openNoFollow(source, FS.O_RDONLY, step);
  let targetDigest = null;
  try {
    const before = fstatSync(srcFd);
    if (!before.isFile()) {
      throw new GateFailure(step, `refusing to copy a non-regular file: ${JSON.stringify(source)}`);
    }
    if (before.nlink > 1) {
      throw new GateFailure(step, `refusing to copy a file with ${before.nlink} hard links: ${JSON.stringify(source)}`);
    }
    const perm = before.mode & 0o777;
    let dstFd;
    try {
      dstFd = openSync(target, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | NO_FOLLOW, perm);
    } catch (error) {
      throw new GateFailure(step, `cannot create ${JSON.stringify(target)}: ${error?.code ?? String(error)}`);
    }
    const copyHash = createHash("sha256");
    let createdIdentity = null;
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      for (;;) {
        const read = readSync(srcFd, buffer, 0, buffer.length, null);
        if (read <= 0) break;
        copyHash.update(buffer.subarray(0, read));
        let offset = 0;
        while (offset < read) {
          offset += writeSync(dstFd, buffer, offset, read - offset);
        }
      }
      createdIdentity = inodeIdentity(fstatSync(dstFd));
    } finally {
      try {
        closeSync(dstFd);
      } catch {
        /* already closed */
      }
    }
    const copiedDigest = copyHash.digest("hex");
    // The path we just wrote must still be the descriptor's file before we
    // touch its mode, and still be that file afterwards.
    const written = lstatSync(target);
    if (written.isSymbolicLink() || !written.isFile() || inodeIdentity(written) !== createdIdentity) {
      throw new GateFailure(step, `copied file is not the regular file that was written: ${JSON.stringify(target)}`);
    }
    // The umask may have masked the created mode: restore the source's own
    // permission bits so the executable bit survives into the candidate repo.
    try {
      chmodSync(target, perm);
    } catch (error) {
      throw new GateFailure(step, `cannot set the mode of ${JSON.stringify(target)}: ${error?.code ?? String(error)}`);
    }
    const afterMode = lstatSync(target);
    if (afterMode.isSymbolicLink() || !afterMode.isFile() || inodeIdentity(afterMode) !== createdIdentity) {
      throw new GateFailure(step, `copied file changed while its mode was being set: ${JSON.stringify(target)}`);
    }
    const reread = hashDescriptor(srcFd, 0);
    if (reread.digest !== copiedDigest) {
      throw new GateFailure(step, `source changed while it was being copied: ${JSON.stringify(source)}`);
    }
    const after = fstatSync(srcFd);
    const drift = identityDrift(before, after);
    if (drift.length > 0 || reread.bytes !== after.size) {
      throw new GateFailure(step, `source changed while it was being copied: ${JSON.stringify(source)}`, [
        ["detail", drift.join("; ") || `read ${reread.bytes} of ${after.size} bytes`],
      ]);
    }
    targetDigest = sha256FileSync(target, step, createdIdentity);
    if (targetDigest !== copiedDigest) {
      throw new GateFailure(step, `copied bytes do not match the source: ${JSON.stringify(target)}`);
    }
    return { size: before.size, sha256: copiedDigest, mode: normalizedExecutableMode(before.mode), perm, nlink: 1 };
  } finally {
    try {
      closeSync(srcFd);
    } catch {
      /* already closed */
    }
  }
}

/** Synchronous, descriptor-based digest used by `copyRegularFileNoFollow`. */
function sha256FileSync(file, step, expectedIdentity = null) {
  const fd = openNoFollow(file, FS.O_RDONLY, step);
  try {
    const before = fstatSync(fd);
    if (expectedIdentity !== null && inodeIdentity(before) !== expectedIdentity) {
      throw new GateFailure(step, `copied file was replaced while it was being verified: ${JSON.stringify(file)}`);
    }
    const first = hashDescriptor(fd, 0);
    const second = hashDescriptor(fd, 0);
    const after = fstatSync(fd);
    if (first.digest !== second.digest || first.bytes !== after.size || identityDrift(before, after).length > 0) {
      throw new GateFailure(step, `copied file changed while it was being verified: ${JSON.stringify(file)}`);
    }
    return first.digest;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

/**
 * Refuse to run a gate that is already inside a gate child environment. This
 * is the anti-recursion boundary: the gate runs `npm test`, and no test may
 * spawn another full gate against the same repository.
 *
 * The comparison is canonical, not lexical: both paths go through `realpath`
 * first, so a `..` spelling or a symlink alias of the gate's own repository is
 * still refused. If either side cannot be canonicalized while the flag is set
 * the gate fails closed — an unresolvable path is never assumed to be "some
 * other repository". Callers run this before creating a temp root, so a
 * refusal leaves nothing behind.
 */
export function assertNoNestedGate(env = process.env, repository = null, owner = null) {
  if (env?.[GATE_ENV_FLAG] !== "1") return;
  const refused = (reason) =>
    new GateFailure(
      "gate",
      `nested clean-candidate gate refused: ${GATE_ENV_FLAG}=1 (a gate must not run inside its own child environment${reason === undefined ? "" : `; ${reason}`})`,
    );
  if (repository === null || owner === null) {
    throw refused();
  }
  let left;
  let right;
  try {
    left = realpathSync(repository);
  } catch {
    throw refused("cannot canonicalize the repository path, refusing to assume it is a different repository");
  }
  try {
    right = realpathSync(owner);
  } catch {
    throw refused("cannot canonicalize the gate's own repository path");
  }
  if (left === right) {
    throw refused();
  }
}

/**
 * Lexical path equality after trailing-separator normalization (no filesystem
 * access). Retained for callers that only need string comparison; the
 * anti-recursion boundary deliberately does *not* use it — see
 * `assertNoNestedGate`, which canonicalizes instead.
 */
export function pathsEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = a.replace(/[\\/]+$/, "");
  const right = b.replace(/[\\/]+$/, "");
  return left === right;
}

/**
 * Drop recognized ambient credential, per-machine configuration, and external
 * command/config channels from a child environment, then apply the caller's
 * overrides. Stripped channels include npm/git/node lifecycle configuration,
 * token-shaped variables, CI command-file variables (`GITHUB_ENV`,
 * `GITHUB_PATH`, `GITHUB_OUTPUT`, …), and tool config/credential paths
 * (Docker, Kubernetes, cloud SDKs, SSH agent sockets, TLS key logs); the gate
 * also deliberately supplies no write token of its own. This is hygiene for
 * *trusted* candidate tests: it keeps host secrets and tool configuration out
 * of the child's environment. It is not a sandbox — code that can read the
 * gate process, its memory, or its files is out of scope (see the trust
 * boundary at the top of this file). Overrides are applied last, so the gate's
 * own isolated HOME/git/npm settings always win.
 */
export function scrubEnvironment(base = process.env, overrides = {}) {
  const SECRET_PATTERN =
    /(?:^|_)(?:TOKEN|SECRET|SECRETS|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|APIKEY|API_KEY|PRIVATE_KEY|AUTH|AUTHORIZATION|PAT|COOKIE|SESSION|KEY)(?:$|_)/i;
  // npm/git lifecycle + configuration channels, CI command-file variables,
  // runner/tool-cache paths, and cloud/tool configuration prefixes.
  const DROP_PREFIX = [
    /^npm_/i,
    /^npm_config_/i,
    /^NPM_/i,
    /^GIT_/i,
    /^GITHUB_/i,
    /^RUNNER_/i,
    /^ACTIONS_/i,
    /^CLOUDSDK_/i,
    /^AZURE_/i,
    /^AWS_/i,
    /^DOCKER_/i,
    /^KUBE/i,
    /^GOOGLE_/i,
  ];
  const DROP_EXACT = new Set([
    "INIT_CWD",
    "NODE_OPTIONS",
    "NODE_PATH",
    "NODE_ENV",
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
    "SSLKEYLOGFILE",
    "NETRC",
    "GIT_EDITOR",
    "EDITOR",
    "VISUAL",
    "PAGER",
    "PWD",
    "OLDPWD",
    "_",
  ]);
  const environment = {};
  for (const [key, value] of Object.entries(base ?? {})) {
    if (typeof value !== "string") continue;
    if (DROP_EXACT.has(key)) continue;
    if (DROP_PREFIX.some((pattern) => pattern.test(key))) continue;
    if (SECRET_PATTERN.test(key)) continue;
    environment[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) continue;
    environment[key] = String(value);
  }
  return environment;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true; // EPERM: exists but is not ours
  }
}

/**
 * Terminate a child's process group: SIGTERM, bounded grace, SIGKILL, bounded
 * grace. Scope is exactly that group — a process that already left it (a
 * detached or re-daemonized descendant) is neither signalled nor reported.
 * Returns whether a member of the group survived both rounds; a survivor is a
 * fail-closed condition for the caller, and the absence of survivors is a
 * statement about the group only, never about escaped processes.
 */
export async function terminateGroup(pid, { enabled = process.platform !== "win32", graceMs = KILL_GRACE_MS } = {}) {
  if (!enabled || typeof pid !== "number" || pid <= 0) {
    return { signalled: false, survived: false };
  }
  if (!groupAlive(pid)) return { signalled: false, survived: false };
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  let deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!groupAlive(pid)) return { signalled: true, survived: false };
    await sleep(50);
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!groupAlive(pid)) return { signalled: true, survived: false };
    await sleep(50);
  }
  return { signalled: true, survived: true };
}

/** True when `target` is `root` itself or lives underneath it (path only). */
function isInsidePath(target, root) {
  const relative = path.relative(root, target);
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

/**
 * Resolve a command to one canonical absolute path, or fail closed.
 *
 * - A command containing a path separator must already be absolute: a relative
 *   command would resolve against whatever cwd a child happens to get.
 * - A bare name is searched in `env.PATH`, whose components must each be
 *   non-empty and absolute. A `PATH=.`-style component is refused outright, so
 *   a relative component can never be resolved against a child's candidate
 *   working directory.
 * - The canonical path (and the path it was found at) must not sit inside
 *   `forbiddenRoot` — the candidate repository — which is what stops a
 *   repository-local fake `git`/`npm` from being executed.
 *
 * Throws `GateFailure` for policy refusals and an `Error` with `code: ENOENT`
 * when the command simply is not on `PATH`.
 */
export function resolveExecutable(command, { env = process.env, forbiddenRoot = null, step = "environment" } = {}) {
  if (typeof command !== "string" || command === "") {
    throw new GateFailure(step, "a command is required");
  }
  const looksLikePath = path.isAbsolute(command) || command.includes("/") || command.includes("\\");
  if (looksLikePath) {
    if (!path.isAbsolute(command)) {
      throw new GateFailure(step, `refusing a relative command path: ${JSON.stringify(command)}`);
    }
    return canonicalizeTool(command, { forbiddenRoot, step });
  }
  const search = typeof env?.PATH === "string" ? env.PATH : typeof env?.Path === "string" ? env.Path : "";
  if (search === "") {
    throw new GateFailure(step, `cannot resolve ${JSON.stringify(command)}: PATH is missing or empty`);
  }
  const names = [command];
  if (process.platform === "win32") {
    const extensions = String(env?.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
    for (const extension of extensions) names.push(`${command}${extension.toLowerCase()}`);
  }
  const entries = search.split(path.delimiter);
  // Validate the whole PATH first: children inherit it and resolve their own
  // tools through it, so a single relative or empty component is a hazard even
  // when the tool we want sits in an earlier, absolute entry.
  for (const entry of entries) {
    if (entry === "") {
      throw new GateFailure(step, `PATH contains an empty component; refusing to resolve ${JSON.stringify(command)}`);
    }
    if (!path.isAbsolute(entry)) {
      throw new GateFailure(step, `PATH contains a relative component ${JSON.stringify(entry)}; refusing to resolve ${JSON.stringify(command)}`);
    }
  }
  for (const entry of entries) {
    for (const name of names) {
      const candidate = path.join(entry, name);
      let stats;
      try {
        stats = statSync(candidate);
      } catch {
        continue; // not here (this also skips a dangling symlink)
      }
      if (!stats.isFile()) continue;
      return canonicalizeTool(candidate, { forbiddenRoot, step });
    }
  }
  if (process.platform === "win32") {
    // Documented limit: on Windows the bare name is handed to `spawn`, which
    // applies PATHEXT itself; live Windows validation is a later gate.
    return command;
  }
  const missing = new Error(`command not found in PATH: ${command}`);
  missing.code = "ENOENT";
  throw missing;
}

function canonicalizeTool(candidate, { forbiddenRoot, step }) {
  let resolved;
  try {
    resolved = realpathSync(candidate);
  } catch (error) {
    throw new GateFailure(step, `cannot resolve ${JSON.stringify(candidate)}: ${error?.code ?? String(error)}`);
  }
  if (!path.isAbsolute(resolved)) {
    throw new GateFailure(step, `resolved command is not absolute: ${JSON.stringify(candidate)}`);
  }
  if (forbiddenRoot !== null && forbiddenRoot !== undefined) {
    const root = path.resolve(forbiddenRoot);
    const offending = isInsidePath(candidate, root) ? candidate : isInsidePath(resolved, root) ? resolved : null;
    if (offending !== null) {
      throw new GateFailure(step, `refusing to execute a tool from inside the candidate repository: ${JSON.stringify(path.relative(root, offending))}`, [
        ["detail", "commands must resolve to absolute tools outside the repository before any candidate directory becomes a cwd"],
      ]);
    }
  }
  return resolved;
}

/**
 * Run one bounded command.
 *
 * Resolves (never rejects) with `{ ok, code, signal, error, timedOut, stdout,
 * stderr, truncated, invalidEncoding, durationMs, pid, survived }`.
 *
 * Settlement invariant: the promise settles only after the child's process
 * group has been terminated and every stream/listener has been destroyed, so a
 * step does not leak *same-group* processes, open pipes, or listeners into the
 * next step or into temp-directory cleanup. `survived` describes that group
 * only. A descendant that detaches or re-daemonizes is outside this boundary:
 * it may outlive the step, it is never signalled here, and its result is never
 * reported as killed (trust boundary at the top of this file).
 *
 * Settlement is driven by the child's `exit` plus a bounded drain grace:
 * `close` waits for the stdio pipes to close, and any process that inherits
 * and keeps them open — in-group or detached — would otherwise hold the gate
 * open indefinitely. Output still arriving after the drain grace is dropped
 * (documented limit), which is strictly better than letting an inherited pipe
 * block the gate.
 *
 * `forbiddenRoot` and `resolvedCommand` are how the gate pre-resolves and
 * canonicalises tools *before* a candidate directory becomes a cwd; a caller
 * that supplies `resolvedCommand` executes exactly that path.
 */
export function runCommand({
  command,
  args = [],
  cwd,
  env = process.env,
  timeoutMs = STEP_TIMEOUT_MS,
  maxOutputChars = OUTPUT_LIMIT_CHARS,
  killGraceMs = KILL_GRACE_MS,
  forbiddenRoot = null,
  resolvedCommand = null,
} = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const detached = process.platform !== "win32";
    let settled = false;
    let child = null;
    let spawnError = null;
    let timedOut = false;
    let invalidEncoding = false;
    let exitRecord = null;
    let executable = null;
    let timeoutTimer = null;
    let forceTimer = null;
    let settleTimer = null;
    let drainTimer = null;
    const out = { text: "", truncated: false };
    const err = { text: "", truncated: false };
    // Strict, streaming UTF-8: a multi-byte character split across two chunks
    // survives intact, and invalid bytes fail the step closed.
    const outDecoder = new TextDecoder("utf-8", { fatal: true });
    const errDecoder = new TextDecoder("utf-8", { fatal: true });
    const collect = (target, decoder) => (chunk) => {
      if (invalidEncoding) return;
      let text;
      try {
        text = decoder.decode(chunk, { stream: true });
      } catch {
        invalidEncoding = true;
        return;
      }
      target.text += text;
      if (target.text.length > maxOutputChars) {
        target.text = target.text.slice(target.text.length - maxOutputChars);
        target.truncated = true;
      }
    };
    const onOut = collect(out, outDecoder);
    const onErr = collect(err, errDecoder);

    const captured = () => ({
      timedOut,
      stdout: out.text,
      stderr: err.text,
      truncated: out.truncated || err.truncated,
      invalidEncoding,
    });

    const outcome = () => ({
      ok: !timedOut && spawnError === null && !invalidEncoding && exitRecord !== null && exitRecord.code === 0,
      code: exitRecord?.code ?? null,
      signal: exitRecord?.signal ?? null,
      error: spawnError
        ? `${spawnError?.code ?? "spawn failed"}: ${spawnError?.message ?? String(spawnError)}`
        : invalidEncoding
          ? "child output is not valid UTF-8; failing closed"
          : null,
      ...captured(),
    });

    // Release every handle the child gave us so an inherited pipe or a late
    // listener can never keep the gate (or its test runner) alive.
    const destroyHandles = () => {
      for (const stream of [child?.stdout, child?.stderr]) {
        if (!stream) continue;
        try {
          stream.removeAllListeners();
        } catch {
          /* already gone */
        }
        try {
          stream.destroy();
        } catch {
          /* already gone */
        }
      }
      if (child) {
        try {
          child.removeAllListeners("exit");
        } catch {
          /* already gone */
        }
        try {
          child.removeAllListeners("close");
        } catch {
          /* already gone */
        }
        try {
          child.removeAllListeners("error");
          child.on("error", () => {});
        } catch {
          /* already gone */
        }
      }
    };

    // Single settlement path: clear every timer, terminate the child's process
    // group, destroy streams/listeners, then resolve exactly once.
    const finish = (partial) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceTimer);
      clearTimeout(settleTimer);
      clearTimeout(drainTimer);
      terminateGroup(child?.pid, { enabled: detached, graceMs: killGraceMs }).then((group) => {
        destroyHandles();
        resolve({
          command,
          args,
          cwd,
          ok: false,
          code: null,
          signal: null,
          error: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          truncated: false,
          invalidEncoding: false,
          durationMs: Date.now() - started,
          pid: child?.pid ?? null,
          ...partial,
          survived: group.survived,
        });
      });
    };

    if (typeof command !== "string" || command === "") {
      finish({ error: "command is missing" });
      return;
    }

    if (resolvedCommand !== null && resolvedCommand !== undefined) {
      if (typeof resolvedCommand !== "string" || !path.isAbsolute(resolvedCommand)) {
        finish({ error: `pre-resolved command is not absolute: ${JSON.stringify(resolvedCommand)}` });
        return;
      }
      executable = resolvedCommand;
    } else {
      try {
        executable = resolveExecutable(command, { env, forbiddenRoot });
      } catch (error) {
        finish({ error: error?.code === "ENOENT" ? `ENOENT: ${error.message}` : String(error?.message ?? error) });
        return;
      }
    }

    try {
      child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached });
    } catch (error) {
      finish({ error: String(error?.message ?? error), ...captured() });
      return;
    }

    child.stdout?.on("data", onOut);
    child.stderr?.on("data", onErr);
    child.on("error", (error) => {
      spawnError = error;
      finish({ ...outcome(), error: `${error?.code ?? "spawn failed"}: ${error?.message ?? String(error)}` });
    });
    child.on("exit", (code, signal) => {
      if (settled || exitRecord !== null) return;
      exitRecord = { code, signal };
      // Bounded drain: `close` would wait forever for a pipe a descendant
      // inherited, so we wait a short, fixed grace and then settle anyway.
      drainTimer = setTimeout(() => finish(outcome()), DRAIN_GRACE_MS);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      exitRecord = { code, signal };
      clearTimeout(drainTimer);
      finish(outcome());
    });

    timeoutTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      try {
        if (detached && child.pid) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      forceTimer = setTimeout(() => {
        if (settled) return;
        try {
          if (detached && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        // Even if neither `exit` nor `close` ever fires, the step must settle.
        settleTimer = setTimeout(() => {
          finish({ ...outcome(), timedOut: true, ok: false });
        }, killGraceMs);
      }, killGraceMs);
    }, Math.max(1, timeoutMs));
  });
}

/** Render a GateFailure (or anything else) as bounded, sanitized text. */
export function formatGateFailure(error) {
  const failure = error instanceof GateFailure ? error : new GateFailure("gate", String(error?.stack ?? error));
  const lines = [`gate: failed | step ${failure.step} | ${sanitizeDiagnostic(boundTail(failure.message, DIAGNOSTIC_LIMIT_CHARS).text)}`];
  for (const detail of failure.details ?? []) {
    const [label, value] = detail;
    const raw = typeof value === "string" ? value : String(value);
    const bounded = boundTail(raw, DIAGNOSTIC_LIMIT_CHARS);
    lines.push(`  ${label}:`);
    for (const line of sanitizeDiagnostic(bounded.text).split("\n")) {
      lines.push(`    ${line}`);
    }
    if (bounded.truncated) lines.push(`    … truncated (${bounded.text.length} of ${raw.length} code units kept)`);
  }
  return `${lines.join("\n")}\n`;
}
