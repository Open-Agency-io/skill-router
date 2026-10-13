// Cross-process mutation lock built on an atomic-directory lease.
//
// The lease lives under a stable control directory that is independent of
// replaceable router state:
//   project:  <root>/.skill-router-control/
//   global:   <home>/.local/share/skill-router-control/
// It contains `control.json`, `mutation.lock/` (owner.json + heartbeat), and at
// most one `transaction.json` journal. Reclamation never depends on age alone:
// a lock is only reclaimed when the owner metadata is fully valid, on this
// host, heartbeat-stale, and `kill(pid, 0)` reports ESRCH. Everything else
// fails closed with MUTATION_LOCKED / LOCK_FOREIGN / LOCK_COMPROMISED.
//
// Every verification and deletion here is keyed to the strong dev/ino file
// identity centralized in `src/durable-fs.js`: the control directory's
// identity support is preflighted *before* the control or lock directory is
// ever created, and reclaim/release never recursively delete a claim whose
// identity this filesystem can no longer prove (LOCK_COMPROMISED, artifact
// preserved). Windows is refused earlier, at the controlled-runner boundary
// (see `src/platform.js`); the POSIX mode/uid checks below are never weakened.
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  durableAtomicWrite,
  fileIdentity,
  identitiesEqual,
  isOwnerOnlyMode,
  readRegularFileNoFollow,
  syncDirectory,
} from "./durable-fs.js";

export const CONTROL_DIRECTORY_NAME = ".skill-router-control";
export const GLOBAL_CONTROL_SUBPATH = path.join(".local", "share", "skill-router-control");
export const CONTROL_FILE_NAME = "control.json";
export const LOCK_DIRECTORY_NAME = "mutation.lock";
export const OWNER_FILE_NAME = "owner.json";
export const HEARTBEAT_FILE_NAME = "heartbeat";
export const JOURNAL_FILE_NAME = "transaction.json";
export const CLAIM_PREFIX = `${LOCK_DIRECTORY_NAME}.claim-`;
export const OWNER_SCHEMA_VERSION = 1;
export const OWNER_FIELDS = Object.freeze([
  "schema",
  "owner",
  "token",
  "hostname",
  "platform",
  "uid",
  "pid",
  "processStartedAt",
  "acquiredAt",
]);
export const OWNER_MAX_BYTES = 16 * 1024;
export const HEARTBEAT_MAX_BYTES = 64;

export const MUTATION_LOCK_DEFAULTS = Object.freeze({
  timeoutMs: 10000,
  heartbeatMs: 2000,
  staleMs: 15000,
  initGraceMs: 250,
  retryBaseDelayMs: 25,
  retryMaxDelayMs: 300,
});

export const LOCK_ERROR_CODES = Object.freeze({
  MUTATION_LOCKED: "MUTATION_LOCKED",
  LOCK_FOREIGN: "LOCK_FOREIGN",
  LOCK_COMPROMISED: "LOCK_COMPROMISED",
});

const MAX_ATTEMPTS_GUARD = 5000;
const O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;

export class MutationLockError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "MutationLockError";
    this.code = code;
    if (details.lockPath !== undefined) this.lockPath = details.lockPath;
    if (details.ownerPid !== undefined) this.ownerPid = details.ownerPid;
    if (details.ownerHost !== undefined) this.ownerHost = details.ownerHost;
  }
}

function sanitizeHost(hostname) {
  const text = typeof hostname === "string" ? hostname : String(hostname ?? "");
  const cleaned = text.replace(/[^A-Za-z0-9._-]/g, "?").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "unknown-host";
}

function lockedError(lockPath, details = {}) {
  const host = details.ownerHost !== undefined ? ` on ${sanitizeHost(details.ownerHost)}` : "";
  const pid = details.ownerPid !== undefined ? ` by pid ${details.ownerPid}` : "";
  return new MutationLockError(
    LOCK_ERROR_CODES.MUTATION_LOCKED,
    `mutation lock held at ${lockPath}${pid}${host}`,
    { lockPath, ...details },
  );
}

function foreignError(lockPath, reason, details = {}) {
  return new MutationLockError(
    LOCK_ERROR_CODES.LOCK_FOREIGN,
    `mutation lock at ${lockPath} is foreign: ${reason}`,
    { lockPath, ...details },
  );
}

function compromisedError(lockPath, reason) {
  return new MutationLockError(
    LOCK_ERROR_CODES.LOCK_COMPROMISED,
    `mutation lock state compromised at ${lockPath}: ${reason}`,
    { lockPath },
  );
}

function releasedError(lockPath) {
  return new MutationLockError(
    LOCK_ERROR_CODES.LOCK_COMPROMISED,
    `mutation lock lease for ${lockPath} is no longer held`,
    { lockPath },
  );
}

function timeoutError(lockPath, waitedMs, doc) {
  if (doc) {
    return new MutationLockError(
      LOCK_ERROR_CODES.MUTATION_LOCKED,
      `timed out after ${waitedMs}ms acquiring mutation lock at ${lockPath} held by pid ${doc.pid} on ${sanitizeHost(doc.hostname)}`,
      { lockPath, ownerPid: doc.pid, ownerHost: sanitizeHost(doc.hostname) },
    );
  }
  return new MutationLockError(
    LOCK_ERROR_CODES.MUTATION_LOCKED,
    `timed out after ${waitedMs}ms acquiring mutation lock at ${lockPath}`,
    { lockPath },
  );
}

// Stable control paths, independent of mutable router config content.
export function controlPaths(input = {}) {
  const global = input.global === true;
  if (global) {
    if (typeof input.home !== "string" || input.home.length === 0) {
      throw new TypeError("controlPaths({ global: true }) requires a non-empty home path");
    }
  } else if (typeof input.root !== "string" || input.root.length === 0) {
    throw new TypeError("controlPaths requires a non-empty root path unless global is true");
  }
  const controlDirectory = global
    ? path.join(input.home, GLOBAL_CONTROL_SUBPATH)
    : path.join(input.root, CONTROL_DIRECTORY_NAME);
  const lockDirectory = path.join(controlDirectory, LOCK_DIRECTORY_NAME);
  return Object.freeze({
    scope: global ? "global" : "project",
    controlDirectory,
    controlFile: path.join(controlDirectory, CONTROL_FILE_NAME),
    lockDirectory,
    ownerFile: path.join(lockDirectory, OWNER_FILE_NAME),
    heartbeatFile: path.join(lockDirectory, HEARTBEAT_FILE_NAME),
    journalFile: path.join(controlDirectory, JOURNAL_FILE_NAME),
  });
}

function validateControlPaths(paths) {
  if (!paths || typeof paths !== "object") throw new TypeError("control paths object is required");
  for (const key of ["controlDirectory", "lockDirectory", "ownerFile", "heartbeatFile"]) {
    if (typeof paths[key] !== "string" || paths[key].length === 0) {
      throw new TypeError(`control paths.${key} must be a non-empty string`);
    }
  }
  if (path.dirname(paths.lockDirectory) !== paths.controlDirectory) {
    throw new TypeError("control paths.lockDirectory must be inside paths.controlDirectory");
  }
  if (path.dirname(paths.ownerFile) !== paths.lockDirectory) {
    throw new TypeError("control paths.ownerFile must be inside paths.lockDirectory");
  }
  if (path.dirname(paths.heartbeatFile) !== paths.lockDirectory) {
    throw new TypeError("control paths.heartbeatFile must be inside paths.lockDirectory");
  }
  if (paths.controlFile !== undefined && path.dirname(paths.controlFile) !== paths.controlDirectory) {
    throw new TypeError("control paths.controlFile must be inside paths.controlDirectory");
  }
  if (paths.journalFile !== undefined && path.dirname(paths.journalFile) !== paths.controlDirectory) {
    throw new TypeError("control paths.journalFile must be inside paths.controlDirectory");
  }
}

function nonNegativeNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function positiveInteger(value, name, max) {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new TypeError(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

function requireFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
  return value;
}

async function defaultMkdir(target, options) {
  await fsp.mkdir(target, options);
  const mode = options && typeof options.mode === "number" ? options.mode : 0o700;
  try {
    await fsp.chmod(target, mode);
  } catch (error) {
    // Windows modes are best effort; POSIX mode application must succeed.
    if (process.platform === "win32") return;
    throw error;
  }
}

async function defaultSleep(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function defaultHeartbeatWrite({ handle, content }) {
  await handle.write(content, 0, content.length, 0);
  await handle.truncate(content.length);
  await handle.sync();
}

function createEnv(options) {
  const now = options.now === undefined ? Date.now : options.now;
  requireFunction(now, "now");
  const random = options.random === undefined ? (size) => randomBytes(size) : options.random;
  requireFunction(random, "random");
  const kill = options.kill === undefined ? (pid, signal) => process.kill(pid, signal) : options.kill;
  requireFunction(kill, "kill");
  const mkdir = options.mkdir === undefined ? defaultMkdir : options.mkdir;
  requireFunction(mkdir, "mkdir");
  const rename = options.rename === undefined ? (from, to) => fsp.rename(from, to) : options.rename;
  requireFunction(rename, "rename");
  const rm = options.rm === undefined ? (target, opts) => fsp.rm(target, opts) : options.rm;
  requireFunction(rm, "rm");
  const fsync = options.fsync === undefined ? syncDirectory : options.fsync;
  requireFunction(fsync, "fsync");
  // Narrow test seam (like `now`, `random`, `kill`): production always derives
  // identities through the centralized durable-fs helper. Injecting it lets
  // tests prove that a filesystem without strong identity is refused before a
  // lock is created and never recursively deleted from a claim.
  const identityOf = options.identityOf === undefined ? fileIdentity : options.identityOf;
  requireFunction(identityOf, "identityOf");
  const heartbeat = options.heartbeat === undefined ? defaultHeartbeatWrite : options.heartbeat;
  requireFunction(heartbeat, "heartbeat");
  const sleep = options.sleep === undefined ? defaultSleep : options.sleep;
  requireFunction(sleep, "sleep");

  const hostname = options.hostname === undefined ? os.hostname() : options.hostname;
  if (typeof hostname !== "string" || hostname.length < 1 || hostname.length > 255) {
    throw new TypeError("hostname must be a string of 1..255 characters");
  }
  const platform = options.platform === undefined ? process.platform : options.platform;
  if (typeof platform !== "string" || platform.length < 1 || platform.length > 64) {
    throw new TypeError("platform must be a string of 1..64 characters");
  }
  const uid = options.uid === undefined
    ? (typeof process.getuid === "function" ? process.getuid() : null)
    : options.uid;
  if (uid !== null && (!Number.isInteger(uid) || uid < 0)) {
    throw new TypeError("uid must be null or a non-negative integer");
  }
  const pid = options.pid === undefined ? process.pid : options.pid;
  positiveInteger(pid, "pid", 0x7fffffff);
  if (options.owner !== undefined && (typeof options.owner !== "string" || options.owner.length < 1 || options.owner.length > 255)) {
    throw new TypeError("owner must be a string of 1..255 characters");
  }
  const processStartedAt = options.processStartedAt === undefined
    ? Date.now() - Math.round(process.uptime() * 1000)
    : options.processStartedAt;
  if (typeof processStartedAt !== "number" || !Number.isFinite(processStartedAt) || processStartedAt < 0) {
    throw new TypeError("processStartedAt must be a non-negative finite number");
  }

  return {
    timeoutMs: nonNegativeNumber(options.timeoutMs ?? MUTATION_LOCK_DEFAULTS.timeoutMs, "timeoutMs"),
    heartbeatMs: nonNegativeNumber(options.heartbeatMs ?? MUTATION_LOCK_DEFAULTS.heartbeatMs, "heartbeatMs"),
    staleMs: nonNegativeNumber(options.staleMs ?? MUTATION_LOCK_DEFAULTS.staleMs, "staleMs"),
    initGraceMs: nonNegativeNumber(options.initGraceMs ?? MUTATION_LOCK_DEFAULTS.initGraceMs, "initGraceMs"),
    retryBaseDelayMs: nonNegativeNumber(
      options.retryBaseDelayMs ?? MUTATION_LOCK_DEFAULTS.retryBaseDelayMs,
      "retryBaseDelayMs",
    ),
    retryMaxDelayMs: nonNegativeNumber(
      options.retryMaxDelayMs ?? MUTATION_LOCK_DEFAULTS.retryMaxDelayMs,
      "retryMaxDelayMs",
    ),
    now,
    random,
    kill,
    mkdir,
    rename,
    rm,
    fsync,
    identityOf,
    heartbeat,
    sleep,
    hostname,
    platform,
    uid,
    pid,
    owner: options.owner,
    processStartedAt,
    // File ownership validation always uses the real current uid; the `uid`
    // option only records metadata for diagnostics and tests.
    realUid: typeof process.getuid === "function" ? process.getuid() : null,
  };
}

function randomHex(env, size) {
  const bytes = env.random(size);
  if (!(bytes instanceof Uint8Array) || bytes.length !== size) {
    throw new TypeError(`random(size) must return ${size} bytes`);
  }
  return Buffer.from(bytes).toString("hex");
}

function currentTimestamp(env) {
  const value = env.now();
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("now() must return a non-negative safe integer timestamp");
  }
  return value;
}

function probeProcess(env, pid) {
  try {
    env.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error && error.code === "ESRCH") return "dead";
    // EPERM (alive but not ours), PID reuse, and unknown errors all mean the
    // lock must be treated as held.
    return "unknown";
  }
}

function parseOwnerDocument(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { ok: false, reason: "owner metadata is not valid JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "owner metadata is not a JSON object" };
  }
  const keys = Object.keys(parsed);
  if (keys.length !== OWNER_FIELDS.length || OWNER_FIELDS.some((key) => !Object.hasOwn(parsed, key))) {
    return { ok: false, reason: "owner metadata does not match the closed schema" };
  }
  if (parsed.schema !== OWNER_SCHEMA_VERSION) {
    return { ok: false, reason: "owner metadata schema is not supported" };
  }
  if (typeof parsed.owner !== "string" || parsed.owner.length < 1 || parsed.owner.length > 255) {
    return { ok: false, reason: "owner metadata identity is invalid" };
  }
  if (typeof parsed.token !== "string" || !/^[0-9a-f]{64}$/.test(parsed.token)) {
    return { ok: false, reason: "owner metadata token is invalid" };
  }
  if (typeof parsed.hostname !== "string" || parsed.hostname.length < 1 || parsed.hostname.length > 255) {
    return { ok: false, reason: "owner metadata hostname is invalid" };
  }
  if (typeof parsed.platform !== "string" || parsed.platform.length < 1 || parsed.platform.length > 64) {
    return { ok: false, reason: "owner metadata platform is invalid" };
  }
  if (parsed.uid !== null && (!Number.isInteger(parsed.uid) || parsed.uid < 0)) {
    return { ok: false, reason: "owner metadata uid is invalid" };
  }
  if (!Number.isInteger(parsed.pid) || parsed.pid < 1 || parsed.pid > 0x7fffffff) {
    return { ok: false, reason: "owner metadata pid is invalid" };
  }
  for (const key of ["processStartedAt", "acquiredAt"]) {
    if (typeof parsed[key] !== "number" || !Number.isFinite(parsed[key]) || parsed[key] < 0) {
      return { ok: false, reason: `owner metadata ${key} is invalid` };
    }
  }
  return { ok: true, doc: parsed };
}

function parseHeartbeatTimestamp(bytes) {
  const match = /^([0-9]{1,15})\n?$/.exec(bytes.toString("utf8"));
  if (!match) return { ok: false, reason: "heartbeat content is malformed" };
  return { ok: true, timestamp: Number(match[1]) };
}

function serializeOwnerDocument(doc) {
  const ordered = {};
  for (const key of OWNER_FIELDS) ordered[key] = doc[key];
  return `${JSON.stringify(ordered)}\n`;
}

// Reads a control metadata file no-follow with type/mode/uid/identity checks.
// Returns { status: "missing" } | { status: "invalid", reason } | { status: "ok", bytes, stat }.
async function readControlFile(filePath, env, maxBytes) {
  const name = path.basename(filePath);
  let before;
  try {
    before = await fsp.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return { status: "missing" };
    throw error;
  }
  if (before.isSymbolicLink()) return { status: "invalid", reason: `${name} is a symbolic link` };
  if (!before.isFile()) return { status: "invalid", reason: `${name} is not a regular file` };
  if (env.platform !== "win32") {
    if (!isOwnerOnlyMode(before.mode)) {
      return { status: "invalid", reason: `${name} has group/other permission bits` };
    }
    if (env.realUid !== null && Number(before.uid) !== env.realUid) {
      return { status: "invalid", reason: `${name} is not owned by the current user` };
    }
  }
  let bytes;
  try {
    bytes = await readRegularFileNoFollow(filePath, { maxBytes, allowMissing: true });
  } catch (error) {
    if (error.code === "ENOENT") return { status: "missing" };
    if (error.code === "ELOOP") return { status: "invalid", reason: `${name} is a symbolic link` };
    if (error.code === "EFTYPE" || error.code === "EBUSY") {
      return { status: "invalid", reason: `${name} is not a stable regular file` };
    }
    if (error.code === "EFBIG") return { status: "invalid", reason: `${name} exceeds the metadata size limit` };
    if (error.code === "EACCES" || error.code === "EPERM") {
      return { status: "invalid", reason: `${name} is not readable` };
    }
    throw error;
  }
  if (bytes === null) return { status: "missing" };
  let after;
  try {
    after = await fsp.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return { status: "missing" };
    throw error;
  }
  if (after.isSymbolicLink() || !after.isFile() || !identitiesEqual(env.identityOf(before), env.identityOf(after))) {
    return { status: "invalid", reason: `${name} changed while reading` };
  }
  return { status: "ok", bytes, stat: before };
}

/**
 * Phase 14 identity preflight: a lock directory (and every claim derived from
 * it) is only ever created on a filesystem that reports the strong dev/ino
 * identity reclaim, release, and dead-claim cleanup all depend on. The nearest
 * existing ancestor is observed so the preflight runs *before* the control
 * directory itself is created.
 */
async function assertIdentitySupport(target, env) {
  let cursor = target;
  for (;;) {
    let stat;
    try {
      stat = await fsp.lstat(cursor);
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return;
      cursor = parent;
      continue;
    }
    const identity = env.identityOf(stat);
    if (!identity || identity.status !== "available") {
      throw compromisedError(target, "the filesystem does not report a stable file identity");
    }
    return;
  }
}

async function validateControlDirectory(paths, env) {
  await assertIdentitySupport(paths.controlDirectory, env);
  const target = paths.controlDirectory;
  let stat = null;
  try {
    stat = await fsp.lstat(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (stat === null) {
    try {
      await env.mkdir(target, { recursive: true, mode: 0o700 });
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
    }
    try {
      stat = await fsp.lstat(target);
    } catch (error) {
      if (error.code === "ENOENT") throw compromisedError(target, "control directory disappeared during creation");
      throw error;
    }
  }
  if (stat.isSymbolicLink()) throw compromisedError(target, "control directory path is a symbolic link");
  if (!stat.isDirectory()) throw compromisedError(target, "control path is not a directory");
  if (env.platform !== "win32") {
    if (!isOwnerOnlyMode(stat.mode)) throw compromisedError(target, "control directory has group/other permission bits");
    if (env.realUid !== null && Number(stat.uid) !== env.realUid) {
      throw compromisedError(target, "control directory is not owned by the current user");
    }
  }
}

function uniqueClaimPath(paths, env) {
  const parent = path.dirname(paths.lockDirectory);
  return path.join(parent, `${CLAIM_PREFIX}${randomHex(env, 8)}`);
}

function assertClaimPath(paths, claimPath) {
  const parent = path.dirname(paths.lockDirectory);
  const name = path.basename(claimPath);
  if (path.dirname(claimPath) !== parent || !name.startsWith(CLAIM_PREFIX) || name.length <= CLAIM_PREFIX.length) {
    throw new Error(`refusing to delete outside the claim namespace: ${claimPath}`);
  }
}

// Classifies the lock at the fixed path. Never ages metadata into reclamation.
async function classifyLock(paths, env) {
  const lockPath = paths.lockDirectory;
  let lockStat;
  try {
    lockStat = await fsp.lstat(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") return { kind: "absent" };
    throw error;
  }
  if (lockStat.isSymbolicLink()) {
    return { kind: "compromised", error: compromisedError(lockPath, "lock path is a symbolic link") };
  }
  if (!lockStat.isDirectory()) {
    return { kind: "compromised", error: compromisedError(lockPath, "lock path is not a directory") };
  }
  if (env.platform !== "win32") {
    if (!isOwnerOnlyMode(lockStat.mode)) {
      return { kind: "compromised", error: compromisedError(lockPath, "lock directory has group/other permission bits") };
    }
    if (env.realUid !== null && Number(lockStat.uid) !== env.realUid) {
      return { kind: "compromised", error: compromisedError(lockPath, "lock directory is not owned by the current user") };
    }
  }

  const ownerRead = await readControlFile(paths.ownerFile, env, OWNER_MAX_BYTES);
  if (ownerRead.status === "missing") return { kind: "metadata-missing", what: "owner" };
  if (ownerRead.status === "invalid") {
    return { kind: "compromised", error: compromisedError(lockPath, ownerRead.reason) };
  }
  const parsed = parseOwnerDocument(ownerRead.bytes);
  if (!parsed.ok) return { kind: "compromised", error: compromisedError(lockPath, parsed.reason) };
  const doc = parsed.doc;

  if (doc.hostname !== env.hostname) {
    return {
      kind: "foreign",
      error: foreignError(lockPath, `owner is on host ${sanitizeHost(doc.hostname)}`, {
        ownerPid: doc.pid,
        ownerHost: sanitizeHost(doc.hostname),
      }),
      doc,
    };
  }

  const heartbeatRead = await readControlFile(paths.heartbeatFile, env, HEARTBEAT_MAX_BYTES);
  if (heartbeatRead.status === "missing") return { kind: "metadata-missing", what: "heartbeat" };
  if (heartbeatRead.status === "invalid") {
    return { kind: "compromised", error: compromisedError(lockPath, heartbeatRead.reason) };
  }
  const heartbeat = parseHeartbeatTimestamp(heartbeatRead.bytes);
  if (!heartbeat.ok) return { kind: "compromised", error: compromisedError(lockPath, heartbeat.reason) };

  const age = Math.max(0, currentTimestamp(env) - heartbeat.timestamp);
  if (age <= env.staleMs) return { kind: "held", doc, stale: false };
  const processState = probeProcess(env, doc.pid);
  if (processState !== "dead") return { kind: "held", doc, stale: true, processState };
  return { kind: "reclaimable", doc, lockStat, ownerStat: ownerRead.stat };
}

// Rename-to-claim, verify the claimed tree still is the classified lock, then
// delete exactly that claim. Losers observe ENOENT and retry.
async function reclaimLock(paths, classification, env) {
  const lockPath = paths.lockDirectory;
  const claimPath = uniqueClaimPath(paths, env);
  try {
    await env.rename(lockPath, claimPath);
  } catch (error) {
    if (error && error.code === "ENOENT") return "vanished";
    if (error && (error.code === "EEXIST" || error.code === "ENOTEMPTY")) return "retry";
    throw error;
  }
  await env.fsync(paths.controlDirectory);

  const failure = await verifyClaimedLock(paths, claimPath, classification, env);
  // A claim that vanished entirely (for example swept by another holder's
  // verified dead-claim reconciliation) is a retry, not a compromise.
  if (failure === "vanished") return "vanished";
  if (failure !== null) throw compromisedError(lockPath, failure);

  // B1: the claim rename is made durable and the claim is re-verified
  // immediately before the destructive recursive removal, so a replacement
  // that appears after the verification above is never deleted. A changed or
  // unprovable claim fails closed with LOCK_COMPROMISED and is preserved.
  await env.fsync(paths.controlDirectory);
  const recheck = await verifyClaimedLock(paths, claimPath, classification, env);
  if (recheck === "vanished") return "vanished";
  if (recheck !== null) throw compromisedError(lockPath, recheck);

  assertClaimPath(paths, claimPath);
  try {
    await env.rm(claimPath, { recursive: true, force: false });
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  await env.fsync(paths.controlDirectory);
  return "reclaimed";
}

async function verifyClaimedLock(paths, claimPath, classification, env) {
  let claimed;
  try {
    claimed = await fsp.lstat(claimPath);
  } catch (error) {
    if (error.code === "ENOENT") return "vanished";
    throw error;
  }
  if (claimed.isSymbolicLink() || !claimed.isDirectory()) return "claimed lock is not a directory";
  if (!identitiesEqual(env.identityOf(claimed), env.identityOf(classification.lockStat))) {
    return "claimed lock identity does not match the classified lock";
  }
  const ownerRead = await readControlFile(path.join(claimPath, OWNER_FILE_NAME), env, OWNER_MAX_BYTES);
  if (ownerRead.status === "missing") return "claimed lock owner metadata is missing";
  if (ownerRead.status === "invalid") return `claimed lock owner metadata is invalid (${ownerRead.reason})`;
  if (!identitiesEqual(env.identityOf(ownerRead.stat), env.identityOf(classification.ownerStat))) {
    return "claimed lock owner metadata identity does not match";
  }
  const parsed = parseOwnerDocument(ownerRead.bytes);
  if (!parsed.ok) return `claimed lock owner metadata is invalid (${parsed.reason})`;
  if (parsed.doc.token !== classification.doc.token) {
    return "claimed lock owner token does not match the classified lock";
  }
  return null;
}

// Best-effort cleanup used only when this process just created the lock
// directory itself. It renames to a claim, verifies the exact identity it
// created, and deletes only that claim; a swapped directory is preserved.
async function cleanupOwnLock(paths, env, createdIdentity) {
  try {
    const lockPath = paths.lockDirectory;
    let current;
    try {
      current = await fsp.lstat(lockPath);
    } catch {
      return;
    }
    if (!identitiesEqual(env.identityOf(current), createdIdentity)) return;
    const claimPath = uniqueClaimPath(paths, env);
    try {
      await env.rename(lockPath, claimPath);
    } catch {
      return;
    }
    let claimed;
    try {
      claimed = await fsp.lstat(claimPath);
    } catch {
      return;
    }
    if (!identitiesEqual(env.identityOf(claimed), createdIdentity)) return;
    assertClaimPath(paths, claimPath);
    await env.rm(claimPath, { recursive: true, force: false });
    await env.fsync(paths.controlDirectory);
  } catch {
    // Cleanup is best effort; the original setup error is rethrown by the caller.
  }
}

async function verifyHeldIntegrity(paths, env, state) {
  try {
    let lockStat;
    try {
      lockStat = await fsp.lstat(paths.lockDirectory);
    } catch (error) {
      if (error.code === "ENOENT") throw compromisedError(paths.lockDirectory, "lock directory is missing");
      throw error;
    }
    if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
      throw compromisedError(paths.lockDirectory, "lock directory was replaced");
    }
    if (!identitiesEqual(env.identityOf(lockStat), state.lockIdentity)) {
      throw compromisedError(paths.lockDirectory, "lock directory identity changed");
    }
    if (env.platform !== "win32") {
      if (!isOwnerOnlyMode(lockStat.mode)) {
        throw compromisedError(paths.lockDirectory, "lock directory has group/other permission bits");
      }
      if (env.realUid !== null && Number(lockStat.uid) !== env.realUid) {
        throw compromisedError(paths.lockDirectory, "lock directory is not owned by the current user");
      }
    }

    const ownerRead = await readControlFile(paths.ownerFile, env, OWNER_MAX_BYTES);
    if (ownerRead.status !== "ok") {
      throw compromisedError(
        paths.lockDirectory,
        ownerRead.status === "missing" ? "owner metadata is missing" : `owner metadata is invalid (${ownerRead.reason})`,
      );
    }
    if (!ownerRead.bytes.equals(state.ownerBytes)) {
      throw compromisedError(paths.lockDirectory, "owner metadata changed");
    }

    let heartbeatStat;
    try {
      heartbeatStat = await fsp.lstat(paths.heartbeatFile);
    } catch (error) {
      if (error.code === "ENOENT") throw compromisedError(paths.lockDirectory, "heartbeat file is missing");
      throw error;
    }
    if (heartbeatStat.isSymbolicLink() || !heartbeatStat.isFile()) {
      throw compromisedError(paths.lockDirectory, "heartbeat file was replaced");
    }
    if (!identitiesEqual(env.identityOf(heartbeatStat), state.heartbeatIdentity)) {
      throw compromisedError(paths.lockDirectory, "heartbeat file identity changed");
    }
    if (env.platform !== "win32" && !isOwnerOnlyMode(heartbeatStat.mode)) {
      throw compromisedError(paths.lockDirectory, "heartbeat file has group/other permission bits");
    }
  } catch (error) {
    if (error instanceof MutationLockError) throw error;
    if (!state.compromisedError) {
      state.compromisedError = compromisedError(paths.lockDirectory, "lease verification could not complete");
    }
    throw state.compromisedError;
  }
}

async function finalizeLease(paths, env) {
  const lockPath = paths.lockDirectory;
  await env.fsync(paths.controlDirectory);

  const acquiredAt = currentTimestamp(env);
  const token = randomHex(env, 32);
  const ownerIdentity = env.owner === undefined ? `${env.hostname}:${env.pid}` : env.owner;
  const doc = {
    schema: OWNER_SCHEMA_VERSION,
    owner: ownerIdentity,
    token,
    hostname: env.hostname,
    platform: env.platform,
    uid: env.uid,
    pid: env.pid,
    processStartedAt: env.processStartedAt,
    acquiredAt,
  };
  const ownerBytes = Buffer.from(serializeOwnerDocument(doc), "utf8");
  const heartbeatBytes = Buffer.from(`${acquiredAt}\n`, "utf8");

  let ownerStat = null;
  let heartbeatStat = null;
  let handle = null;
  try {
    await durableAtomicWrite(paths.ownerFile, ownerBytes, { mode: 0o600 });
    await durableAtomicWrite(paths.heartbeatFile, heartbeatBytes, { mode: 0o600 });
    ownerStat = await fsp.lstat(paths.ownerFile);
    heartbeatStat = await fsp.lstat(paths.heartbeatFile);
    if (env.platform !== "win32") {
      if (!isOwnerOnlyMode(ownerStat.mode)) throw compromisedError(lockPath, "owner metadata mode is not owner-only");
      if (!isOwnerOnlyMode(heartbeatStat.mode)) throw compromisedError(lockPath, "heartbeat file mode is not owner-only");
      if (env.realUid !== null && Number(ownerStat.uid) !== env.realUid) {
        throw compromisedError(lockPath, "owner metadata is not owned by the current user");
      }
      if (env.realUid !== null && Number(heartbeatStat.uid) !== env.realUid) {
        throw compromisedError(lockPath, "heartbeat file is not owned by the current user");
      }
    }
    handle = await fsp.open(paths.heartbeatFile, fsConstants.O_RDWR | O_NOFOLLOW);
    const handleStat = await handle.stat();
    if (!identitiesEqual(env.identityOf(handleStat), env.identityOf(heartbeatStat))) {
      throw compromisedError(lockPath, "heartbeat file changed during setup");
    }
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Best effort close during failed setup.
      }
    }
    throw error;
  }

  const lockStat = await fsp.lstat(lockPath);
  const state = {
    released: false,
    releasing: false,
    compromisedError: null,
    lockIdentity: env.identityOf(lockStat),
    ownerBytes,
    heartbeatIdentity: env.identityOf(heartbeatStat),
    handle,
    handleClosed: false,
    timer: null,
  };

  const lease = {
    owner: doc.owner,
    token: doc.token,
    paths,
    acquiredAt,
    async assertHeld() {
      if (state.compromisedError) throw state.compromisedError;
      if (state.releasing || state.released) throw releasedError(lockPath);
      await verifyHeldIntegrity(paths, env, state);
      return true;
    },
    async heartbeat() {
      if (state.compromisedError) throw state.compromisedError;
      if (state.releasing || state.released) throw releasedError(lockPath);
      try {
        await verifyHeldIntegrity(paths, env, state);
        const content = Buffer.from(`${currentTimestamp(env)}\n`, "utf8");
        await env.heartbeat({ handle: state.handle, content, lockPath, token: doc.token });
      } catch (error) {
        // Failures that race an in-flight release are release outcomes, not
        // new compromises; never poison release with them.
        if (state.releasing || state.released) throw releasedError(lockPath);
        if (!state.compromisedError) {
          state.compromisedError = error instanceof MutationLockError
            ? error
            : compromisedError(lockPath, "heartbeat could not be written");
        }
        throw state.compromisedError;
      }
      return currentTimestamp(env);
    },
    async release() {
      if (state.released) return;
      state.releasing = true;
      if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
      }
      // Closing our own heartbeat handle is never destructive; a compromised
      // lease must still stop its timer and release the descriptor.
      if (!state.handleClosed) {
        state.handleClosed = true;
        try {
          await state.handle.close();
        } catch {
          if (!state.compromisedError) {
            state.compromisedError = compromisedError(lockPath, "heartbeat handle could not be closed");
          }
        }
      }
      if (state.compromisedError) throw state.compromisedError;
      state.released = true;

      let lockStatBefore = null;
      try {
        lockStatBefore = await fsp.lstat(lockPath);
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      const preFailure = await verifyUnclaimed(paths, lockPath, lockStatBefore, state, env);
      if (preFailure !== null) {
        state.compromisedError = compromisedError(lockPath, preFailure);
        throw state.compromisedError;
      }

      const claimPath = uniqueClaimPath(paths, env);
      try {
        await env.rename(lockPath, claimPath);
      } catch (error) {
        if (error && error.code === "ENOENT") return;
        throw error;
      }
      await env.fsync(paths.controlDirectory);

      let claimedStat = null;
      try {
        claimedStat = await fsp.lstat(claimPath);
      } catch (error) {
        if (error.code === "ENOENT") claimedStat = null;
        else throw error;
      }
      const postFailure = claimedStat === null
        ? "claimed lock disappeared after rename"
        : await verifyUnclaimed(paths, claimPath, claimedStat, state, env);
      if (postFailure !== null) {
        // Never delete an unverified claim and never touch the fixed lock path.
        state.compromisedError = compromisedError(lockPath, postFailure);
        throw state.compromisedError;
      }

      // B1: the claim rename is made durable and the claim is re-verified
      // immediately before the destructive recursive removal, so a
      // replacement that appears after the verification above is never
      // deleted. A changed or unprovable claim fails closed with
      // LOCK_COMPROMISED and is preserved at its claim path.
      await env.fsync(paths.controlDirectory);
      let recheckStat = null;
      try {
        recheckStat = await fsp.lstat(claimPath);
      } catch (error) {
        if (error.code === "ENOENT") recheckStat = null;
        else throw error;
      }
      const recheckFailure = recheckStat === null
        ? "claimed lock disappeared before removal"
        : await verifyUnclaimed(paths, claimPath, recheckStat, state, env);
      if (recheckFailure !== null) {
        state.compromisedError = compromisedError(lockPath, recheckFailure);
        throw state.compromisedError;
      }

      assertClaimPath(paths, claimPath);
      try {
        await env.rm(claimPath, { recursive: true, force: false });
      } catch (error) {
        if (!error || error.code !== "ENOENT") throw error;
      }
      await env.fsync(paths.controlDirectory);
    },
  };

  if (env.heartbeatMs > 0) {
    state.timer = setInterval(() => {
      void lease.heartbeat().catch(() => {});
    }, env.heartbeatMs);
    if (typeof state.timer.unref === "function") state.timer.unref();
  }

  return lease;
}

async function verifyUnclaimed(paths, subjectPath, stat, state, env) {
  if (stat.isSymbolicLink() || !stat.isDirectory()) return "lock path is not a directory";
  if (!identitiesEqual(env.identityOf(stat), state.lockIdentity)) return "lock directory identity changed";
  if (env.platform !== "win32") {
    if (!isOwnerOnlyMode(stat.mode)) return "lock directory has group/other permission bits";
    if (env.realUid !== null && Number(stat.uid) !== env.realUid) return "lock directory is not owned by the current user";
  }
  const ownerRead = await readControlFile(path.join(subjectPath, OWNER_FILE_NAME), env, OWNER_MAX_BYTES);
  if (ownerRead.status !== "ok") {
    return ownerRead.status === "missing"
      ? "owner metadata is missing"
      : `owner metadata is invalid (${ownerRead.reason})`;
  }
  if (!ownerRead.bytes.equals(state.ownerBytes)) return "owner metadata changed";
  return null;
}

function retryDelayMs(env, attempt) {
  const raw = Math.min(env.retryMaxDelayMs, env.retryBaseDelayMs * 2 ** Math.min(attempt, 20));
  const jitterUnit = env.random(1)[0];
  const jitter = Number.isFinite(jitterUnit) ? jitterUnit / 255 : 0.5;
  return Math.max(1, Math.round(raw * (0.5 + 0.5 * jitter)));
}

// Acquires the mutation lease for the given control paths. Jittered bounded
// retry until `timeoutMs`; reclamation only on fully validated same-host dead
// owners; all other states fail closed with stable error codes.
export async function acquireMutationLock(paths, options = {}) {
  validateControlPaths(paths);
  const env = createEnv(options);
  const lockPath = paths.lockDirectory;
  await validateControlDirectory(paths, env);

  const startedAt = currentTimestamp(env);
  const deadline = startedAt + env.timeoutMs;
  let attempt = 0;
  let metadataMissingSince = null;
  let lastHeldDoc = null;

  for (;;) {
    if (attempt >= MAX_ATTEMPTS_GUARD) throw timeoutError(lockPath, currentTimestamp(env) - startedAt, lastHeldDoc);
    let created = false;
    try {
      await env.mkdir(lockPath, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
    }
    attempt += 1;

    if (created) {
      let createdIdentity = null;
      try {
        const lockStat = await fsp.lstat(lockPath);
        createdIdentity = env.identityOf(lockStat);
        if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
          throw compromisedError(lockPath, "new lock path is not a directory");
        }
        if (env.platform !== "win32" && !isOwnerOnlyMode(lockStat.mode)) {
          throw compromisedError(lockPath, "new lock directory has group/other permission bits");
        }
        const lease = await finalizeLease(paths, env);
        // Production reconciliation of exact verified dead lock claims: a
        // crash between another holder's rename-to-claim and its removal
        // would otherwise strand the claim forever. Best effort: foreign,
        // malformed, raced, or live claims survive and never weaken
        // acquisition.
        try {
          await cleanupDeadClaimsInternal(paths, env, lease);
        } catch {
          // Leaving an unclassifiable claim behind is always safe.
        }
        return lease;
      } catch (error) {
        if (createdIdentity) await cleanupOwnLock(paths, env, createdIdentity);
        throw error;
      }
    }

    const classification = await classifyLock(paths, env);
    if (classification.kind === "absent") continue;
    if (classification.kind === "compromised") throw classification.error;
    if (classification.kind === "foreign") throw classification.error;

    if (classification.kind === "reclaimable") {
      metadataMissingSince = null;
      const outcome = await reclaimLock(paths, classification, env);
      if (outcome === "reclaimed" || outcome === "vanished") continue;
      continue;
    }

    if (classification.kind === "metadata-missing") {
      // A freshly mkdir'ed lock can still be writing its metadata; retry
      // briefly, then treat missing metadata as unclassifiable/foreign.
      if (metadataMissingSince === null) metadataMissingSince = currentTimestamp(env);
      if (currentTimestamp(env) - metadataMissingSince >= env.initGraceMs) {
        throw foreignError(lockPath, `metadata is missing (${classification.what})`);
      }
    } else {
      metadataMissingSince = null;
      lastHeldDoc = classification.doc;
    }

    const now = currentTimestamp(env);
    if (now >= deadline) throw timeoutError(lockPath, now - startedAt, lastHeldDoc);
    const delay = Math.min(retryDelayMs(env, attempt), Math.max(1, deadline - now));
    await env.sleep(delay);
  }
}

function classifyClaimLeftover(paths, claimPath, env) {
  return (async () => {
    let stat;
    try {
      stat = await fsp.lstat(claimPath);
    } catch (error) {
      if (error.code === "ENOENT") return { verdict: "absent" };
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { verdict: "not a directory", stat };
    if (env.platform !== "win32") {
      if (!isOwnerOnlyMode(stat.mode)) return { verdict: "group/other permission bits", stat };
      if (env.realUid !== null && Number(stat.uid) !== env.realUid) return { verdict: "not owned by the current user", stat };
    }
    const ownerRead = await readControlFile(path.join(claimPath, OWNER_FILE_NAME), env, OWNER_MAX_BYTES);
    if (ownerRead.status === "missing") return { verdict: "owner metadata is missing", stat };
    if (ownerRead.status === "invalid") return { verdict: ownerRead.reason, stat };
    const parsed = parseOwnerDocument(ownerRead.bytes);
    if (!parsed.ok) return { verdict: parsed.reason, stat };
    if (parsed.doc.hostname !== env.hostname) return { verdict: "owner is on a different host", stat };
    const heartbeatRead = await readControlFile(path.join(claimPath, HEARTBEAT_FILE_NAME), env, HEARTBEAT_MAX_BYTES);
    if (heartbeatRead.status === "missing") return { verdict: "heartbeat is missing", stat };
    if (heartbeatRead.status === "invalid") return { verdict: heartbeatRead.reason, stat };
    const heartbeat = parseHeartbeatTimestamp(heartbeatRead.bytes);
    if (!heartbeat.ok) return { verdict: heartbeat.reason, stat };
    const age = Math.max(0, currentTimestamp(env) - heartbeat.timestamp);
    if (age <= env.staleMs) return { verdict: "heartbeat is not stale", stat };
    if (probeProcess(env, parsed.doc.pid) !== "dead") return { verdict: "owner process is not confirmed dead", stat };
    return { verdict: "dead", stat, token: parsed.doc.token, ownerStat: ownerRead.stat };
  })();
}

/**
 * Verifies a dead-claim leftover after it has been renamed to a fresh unique
 * claim path: the directory identity, the owner-metadata identity, and the
 * immutable owner token must all still match what was classified in place.
 */
async function verifyRenamedDeadClaim(paths, reverifyPath, classification, env) {
  let claimed;
  try {
    claimed = await fsp.lstat(reverifyPath);
  } catch (error) {
    if (error && error.code === "ENOENT") return "the renamed claim disappeared";
    throw error;
  }
  if (claimed.isSymbolicLink() || !claimed.isDirectory()) return "the renamed claim is not a directory";
  if (!identitiesEqual(env.identityOf(claimed), env.identityOf(classification.stat))) {
    return "the renamed claim identity changed";
  }
  const ownerRead = await readControlFile(path.join(reverifyPath, OWNER_FILE_NAME), env, OWNER_MAX_BYTES);
  if (ownerRead.status !== "ok") return "the renamed claim owner metadata is missing or invalid";
  if (!identitiesEqual(env.identityOf(ownerRead.stat), env.identityOf(classification.ownerStat))) {
    return "the renamed claim owner metadata identity changed";
  }
  const parsed = parseOwnerDocument(ownerRead.bytes);
  if (!parsed.ok) return "the renamed claim owner metadata is invalid";
  if (parsed.doc.token !== classification.token) return "the renamed claim owner token changed";
  return null;
}

// Explicit, verified cleanup for claim directories left by a crash after the
// rename-to-claim step. Only `mutation.lock.claim-*` entries whose owner is
// fully validated, same-host, stale, and confirmed dead (ESRCH) are removed,
// and only after a rename to a fresh unique claim plus identity/token
// re-verification; nothing is ever wildcard-deleted. `lease` (optional) is
// asserted immediately before the recursive delete.
async function cleanupDeadClaimsInternal(paths, env, lease = null) {
  const result = { removed: [], skipped: [] };
  let entries;
  try {
    entries = await fsp.readdir(paths.controlDirectory);
  } catch (error) {
    if (error.code === "ENOENT") return result;
    throw error;
  }
  for (const name of entries) {
    if (!name.startsWith(CLAIM_PREFIX) || name.length <= CLAIM_PREFIX.length) continue;
    const claimPath = path.join(paths.controlDirectory, name);
    const classification = await classifyClaimLeftover(paths, claimPath, env);
    if (classification.verdict !== "dead") {
      if (classification.verdict !== "absent") result.skipped.push({ path: claimPath, reason: classification.verdict });
      continue;
    }
    const reverifyPath = uniqueClaimPath(paths, env);
    // Immediate lease assertion right before the destructive rename, after
    // every intervening classification probe.
    if (lease && typeof lease.assertHeld === "function") {
      try {
        await lease.assertHeld();
      } catch {
        result.skipped.push({ path: claimPath, reason: "the mutation lease is no longer held" });
        continue;
      }
    }
    try {
      await env.rename(claimPath, reverifyPath);
    } catch (error) {
      // Another cleaner won the race; the leftover is simply gone.
      if (error && error.code === "ENOENT") continue;
      result.skipped.push({ path: claimPath, reason: `the claim rename failed (${(error && error.code) || "unknown"})` });
      continue;
    }
    await env.fsync(paths.controlDirectory);
    let failure = null;
    try {
      failure = await verifyRenamedDeadClaim(paths, reverifyPath, classification, env);
    } catch (error) {
      failure = `the renamed claim could not be verified (${(error && error.code) || "unknown"})`;
    }
    if (failure !== null) {
      // A replaced or changed claim is preserved at its renamed path.
      result.skipped.push({ path: reverifyPath, reason: failure });
      continue;
    }
    if (lease && typeof lease.assertHeld === "function") {
      try {
        await lease.assertHeld();
      } catch {
        result.skipped.push({ path: reverifyPath, reason: "the mutation lease is no longer held" });
        continue;
      }
    }
    // B1: the claim rename is made durable and the renamed claim is
    // re-verified immediately before the destructive recursive removal, so a
    // replacement that appears after the verification above is never deleted;
    // a changed or unprovable claim is preserved at its renamed path.
    await env.fsync(paths.controlDirectory);
    try {
      failure = await verifyRenamedDeadClaim(paths, reverifyPath, classification, env);
    } catch (error) {
      failure = `the renamed claim could not be re-verified (${(error && error.code) || "unknown"})`;
    }
    if (failure !== null) {
      result.skipped.push({ path: reverifyPath, reason: failure });
      continue;
    }
    assertClaimPath(paths, reverifyPath);
    try {
      await env.rm(reverifyPath, { recursive: true, force: false });
    } catch (error) {
      if (!error || error.code !== "ENOENT") {
        result.skipped.push({ path: reverifyPath, reason: `the claim removal failed (${(error && error.code) || "unknown"})` });
        continue;
      }
    }
    await env.fsync(paths.controlDirectory);
    result.removed.push(claimPath);
  }
  return result;
}

export async function cleanupDeadClaimLeftovers(paths, options = {}) {
  validateControlPaths(paths);
  const env = createEnv(options);
  await validateControlDirectory(paths, env);
  const lease = options.lease && typeof options.lease.assertHeld === "function" ? options.lease : null;
  return cleanupDeadClaimsInternal(paths, env, lease);
}
