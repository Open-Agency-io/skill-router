import { randomBytes, randomUUID } from "node:crypto";
import { lstat, link, mkdir, open, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { assertOwnedStateDirectory, STATE_MARKER_CONTENT, stateIdentityMatches } from "./installation.js";
import {
  cleanupPayloads,
  cleanupPayloadTransients,
  createJournal,
  FILE_ROLES,
  JOURNAL_ERROR_CODES,
  JOURNAL_OWNER,
  JOURNAL_SCHEMA_VERSION,
  JOURNAL_TERMINAL_PHASES,
  JournalError,
  MAX_FILE_RECORDS,
  payloadPathFor,
  payloadTransientPath,
  readJournal,
  readPayload,
  removeJournal,
  stagePathFor,
  backupPathFor,
  updateJournal,
} from "./journal.js";
import {
  DEFAULT_MAX_FILE_BYTES,
  durableFsInternals,
  durableUnlink,
  fileIdentity,
  identitiesEqual,
  isIdentityAvailable,
  identityRecord,
  readRegularFileNoFollow,
  sha256Bytes,
  syncDirectory,
} from "./durable-fs.js";
import { classifyStateArtifact, inspectStateTree } from "./managed-state.js";
import {
  applyFileFromPayload,
  cleanupStateArtifactViaClaim,
  createJournalClaudeObserver,
  journaledTransactionInternals,
  recoverPendingTransaction,
} from "./recovery.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Stable journal error codes re-exported for the journaled executors. */
const journalError = (code, message, details) => new JournalError(code, message, details);
const invalidJournal = (message, details) => journalError(JOURNAL_ERROR_CODES.JOURNAL_INVALID, message, details);
const recoveryConflict = (message, details) =>
  journalError(JOURNAL_ERROR_CODES.RECOVERY_CONFLICT, message, details);
const recoveryAmbiguous = (message, details) =>
  journalError(JOURNAL_ERROR_CODES.RECOVERY_AMBIGUOUS, message, details);

/**
 * Fault-injection seam for the journaled executors and recovery machine; see
 * `src/recovery.js`. Re-exported here because both halves of a transaction
 * report through it.
 */
export { journaledTransactionInternals };

async function faultStep(stepName, context) {
  await journaledTransactionInternals.onStep(stepName, context ?? {});
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/* ================================================================== *
 * Phase 6 - side-effect-free payload planning and durable materialization
 * ================================================================== */

const O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;

function mapTargetReadError(error, target) {
  const code = error && error.code;
  if (code === "ELOOP" || code === "EFTYPE" || code === "EBUSY" || code === "EFBIG" || code === "EACCES" || code === "EPERM") {
    return recoveryConflict(
      `Refusing to replace non-regular file: ${target} (it is not the readable regular file that was planned)`,
      { path: target },
    );
  }
  return error;
}

function toBytes(value, label) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value instanceof Uint8Array) return Buffer.isBuffer(value) ? value : Buffer.from(value);
  throw new TypeError(`${label} must be text or bytes`);
}

/**
 * Side-effect-free payload planning. Every target is read no-follow within the
 * payload size bound (or proven absent), CAS-checked against the caller's
 * `expectedBefore` when one is recorded, and converted into the exact journal
 * record plus the exact before/after payload descriptors - paths, sha256
 * digests, and existence only. The bytes themselves are retained **in memory
 * only**: this function creates, writes, or renames nothing, so a crash here
 * leaves no artifact at all and no payload can ever predate its journal.
 *
 * Accepts `filePlans` entries of `{role, path, content, expectedBefore}`
 * (`target`/`afterBytes` are accepted aliases). `expectedBefore` may be `null`
 * (the target must be absent), text/bytes (the target must hold exactly those
 * bytes), or an already-computed `{exists, sha256}` pair; omitting it records
 * the observed state without a compare-and-swap.
 *
 * Returns a frozen array of plans: `{target, role, record, before, after}`,
 * where `record` is journal-ready and `before`/`after` hold the in-memory
 * bytes for `materializeFilePayloads`.
 */
export async function planFilePayloads(transactionId, filePlans, options = {}) {
  if (typeof transactionId !== "string" || !SHA256_PATTERN.test(transactionId)) {
    throw new TypeError("planFilePayloads requires a lowercase sha256 transaction id");
  }
  if (!Array.isArray(filePlans)) throw new TypeError("filePlans must be an array");
  if (filePlans.length > MAX_FILE_RECORDS) {
    throw invalidJournal(`filePlans must hold at most ${MAX_FILE_RECORDS} entries`);
  }
  const lease = options.lease;
  if (lease && typeof lease.assertHeld === "function") await lease.assertHeld();

  const controlDirectory =
    options.controlDirectory ?? (lease && lease.paths ? lease.paths.controlDirectory : null);
  const stateDirectory = options.stateDirectory ?? null;
  const plans = [];
  const seen = new Set();

  for (const [index, entry] of filePlans.entries()) {
    const label = `file plan ${index}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw invalidJournal(`${label} must be a plain object`);
    }
    const rawTarget = entry.target ?? entry.path;
    if (typeof rawTarget !== "string" || rawTarget === "") throw invalidJournal(`${label} must record a path`);
    const target = path.resolve(rawTarget);
    if (seen.has(target)) throw invalidJournal("file plans must not repeat a target");
    seen.add(target);
    const role = entry.role;
    if (typeof role !== "string" || !FILE_ROLES.includes(role)) throw invalidJournal(`${label}.role is not a supported role`);
    if (controlDirectory && (target === controlDirectory || isInside(controlDirectory, target) || isInside(target, controlDirectory))) {
      throw invalidJournal("file target must not overlap the control directory", { path: target });
    }
    if (stateDirectory && (target === stateDirectory || isInside(stateDirectory, target) || isInside(target, stateDirectory))) {
      throw invalidJournal("file target must not overlap the state directory", { path: target });
    }

    const rawContent = entry.content ?? entry.afterBytes;
    if (rawContent === undefined || rawContent === null) throw invalidJournal(`${label} must record content`);
    const afterBytes = toBytes(rawContent, `${label}.content`);
    if (afterBytes.length > DEFAULT_MAX_FILE_BYTES) throw invalidJournal(`${label} exceeds the maximum payload size`);

    let expected = null;
    if (Object.hasOwn(entry, "expectedBefore")) {
      const value = entry.expectedBefore;
      if (value === null) expected = { exists: false, sha256: null };
      else if (typeof value === "string" || value instanceof Uint8Array) {
        expected = { exists: true, sha256: sha256Bytes(toBytes(value, `${label}.expectedBefore`)) };
      } else if (value && typeof value === "object" && typeof value.exists === "boolean") {
        if (!value.exists) {
          expected = { exists: false, sha256: null };
        } else if (typeof value.sha256 === "string" && SHA256_PATTERN.test(value.sha256)) {
          expected = { exists: true, sha256: value.sha256 };
        } else if (typeof value.sha256 === "string" || value.sha256 instanceof Uint8Array) {
          expected = { exists: true, sha256: sha256Bytes(toBytes(value.sha256, `${label}.expectedBefore.sha256`)) };
        } else {
          throw new TypeError(`${label}.expectedBefore.sha256 must be a digest, text, or bytes`);
        }
      } else {
        throw new TypeError(`${label}.expectedBefore must be null, text, bytes, or {exists, sha256}`);
      }
    }

    let targetBytes = null;
    try {
      targetBytes = await readRegularFileNoFollow(target, { maxBytes: DEFAULT_MAX_FILE_BYTES, allowMissing: true });
    } catch (error) {
      throw mapTargetReadError(error, target);
    }
    const beforeExists = targetBytes !== null;
    const beforeSha256 = beforeExists ? sha256Bytes(targetBytes) : null;
    if (expected) {
      const matches = expected.exists === beforeExists && (expected.exists === false || expected.sha256 === beforeSha256);
      if (!matches) {
        const describe = (value) => (value === null || value === undefined ? "no file" : `${value.length} bytes`);
        throw recoveryConflict(
          `Refusing to write ${target}: it no longer matches the bytes observed during planning ` +
            `(expected ${describe(beforeExists ? expected.sha256 : null)}, found ${describe(targetBytes)})`,
          { path: target },
        );
      }
    }

    const beforePayload = beforeExists ? payloadPathFor(target, transactionId, "before") : null;
    const afterPayload = payloadPathFor(target, transactionId, "after");
    const afterSha256 = sha256Bytes(afterBytes);
    plans.push(
      Object.freeze({
        target,
        role,
        record: Object.freeze({
          target,
          role,
          status: "prepared",
          before: Object.freeze({ exists: beforeExists, sha256: beforeSha256, payloadPath: beforePayload }),
          after: Object.freeze({ exists: true, sha256: afterSha256, payloadPath: afterPayload }),
        }),
        before: beforeExists
          ? Object.freeze({ path: beforePayload, bytes: Buffer.from(targetBytes), sha256: beforeSha256 })
          : null,
        after: Object.freeze({ path: afterPayload, bytes: Buffer.from(afterBytes), sha256: afterSha256 }),
      }),
    );
  }

  if (lease && typeof lease.assertHeld === "function") await lease.assertHeld();
  return Object.freeze(plans);
}

/**
 * B3: removes only the transient this call itself proved it created. The
 * derived pathname is never ownership: the caller must supply the exact
 * strong identity recorded at creation, and an entry whose identity this
 * filesystem cannot prove - or that differs from the recorded one - is
 * preserved, never deleted and never guessed at.
 */
async function removeTransientIfOwn(transient, expectedIdentity) {
  let stat;
  try {
    stat = await transactionInternals.lstat(transient);
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw recoveryConflict(`the payload transient at ${transient} is not a regular file`, { path: transient });
  }
  if (process.platform !== "win32") {
    if ((stat.mode & 0o077) !== 0) {
      throw recoveryConflict(`the payload transient at ${transient} is not owner-only`, { path: transient });
    }
    if (typeof process.getuid === "function" && Number(stat.uid) !== process.getuid()) {
      throw recoveryConflict(`the payload transient at ${transient} is not owned by the current user`, {
        path: transient,
      });
    }
  }
  const identity = fileIdentity(stat);
  if (!isIdentityAvailable(identity)) return;
  // Retain anything whose device OR inode differs from the file this call
  // created: a swap on either axis means the path no longer holds our bytes.
  if (!identitiesEqual(identity, expectedIdentity)) return;
  await durableUnlink(transient, identity);
}

/**
 * B8: prepares the target directory (and any missing parent) for payload
 * writes. The *nearest existing ancestor* is identity-preflighted before a
 * single `mkdir` runs, missing levels are created one at a time, and every
 * directory this call creates is itself verified to report a strong identity
 * before anything may be written into it. The `created` list records each
 * directory this call strongly created (with the identity verified at
 * creation) so a failure can remove exactly those, deepest first, and nothing
 * else.
 */
async function ensureDirectoryWithIdentitySupport(target, created) {
  const missing = [];
  let cursor = target;
  for (;;) {
    let stat;
    try {
      stat = await transactionInternals.lstat(cursor);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        missing.push(cursor);
        const parent = path.dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
        continue;
      }
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw recoveryConflict(`the payload directory ${cursor} is not a real directory`, { path: cursor });
    }
    if (!isIdentityAvailable(fileIdentity(stat))) {
      throw recoveryConflict(
        `no payload was written: the directory ${cursor} does not report a stable file identity`,
        { path: cursor },
      );
    }
    break;
  }

  for (const directory of missing.reverse()) {
    try {
      await mkdir(directory, { recursive: false });
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      // A concurrent creator: never adopt blindly - the directory itself must
      // still prove a strong identity before anything is written into it, and
      // it is never recorded as created by this call.
      const stat = await transactionInternals.lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory() || !isIdentityAvailable(fileIdentity(stat))) {
        throw recoveryConflict(`no payload was written: the directory ${directory} cannot be proven`, {
          path: directory,
        });
      }
      continue;
    }
    // Record immediately: the exclusive mkdir above is this call's creation
    // proof. The strong identity (when the filesystem reports one) is stored
    // for the removal-time re-proof below.
    const record = { directory, identity: null };
    created.push(record);
    const stat = await transactionInternals.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw recoveryConflict(
        `no payload was written: the directory ${directory} this call created is not a real directory`,
        { path: directory },
      );
    }
    if (!isIdentityAvailable(fileIdentity(stat))) {
      throw recoveryConflict(
        `no payload was written: the directory ${directory} this call created does not report a stable file identity`,
        { path: directory },
      );
    }
    record.identity = fileIdentity(stat);
  }
}

/**
 * B8/B5 cleanup: removes only the directories this call strongly created -
 * deepest first - and only while they are still empty (`rmdir` fails
 * otherwise, so a directory that gained an entry is preserved together with
 * every parent). Each directory is re-proven by the exact strong identity
 * recorded at its creation *immediately before* the `rmdir`; a directory whose
 * identity was never proven (unavailable at creation), that cannot be proven
 * now, changed type, or was replaced is never removed and never blocks the
 * cleanup of other created chains.
 */
async function removeCreatedDirectories(created) {
  for (const entry of [...created].reverse()) {
    // B5: an unprovable identity is never a removal authorization - a
    // null/unavailable identity means the directory survives.
    if (entry.identity === null || !isIdentityAvailable(entry.identity)) continue;
    try {
      const stat = await transactionInternals.lstat(entry.directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      if (!isIdentityAvailable(fileIdentity(stat))) continue;
      // Reprove the exact recorded identity immediately before the removal.
      if (!identitiesEqual(fileIdentity(stat), entry.identity)) continue;
      await rmdir(entry.directory);
    } catch {
      // A directory that is no longer empty, no longer ours, or raced away is
      // preserved; other created chains are still attempted.
      continue;
    }
  }
}

/**
 * Materializes the exact 0600 payload files for previously planned payloads.
 *
 * Each payload is written through the derived same-directory transient
 * `<payload>.tmp` (exclusive create, write, file fsync), and the transient is
 * published to the recorded payload path with a kernel no-clobber hard link
 * (B2/B3) after its strong identity and content digest are re-verified - so a
 * recorded payload path never holds partial content, a destination that
 * appears mid-write is never overwritten, and a transient this call cannot
 * attribute is preserved, never deleted. An already-present payload is adopted
 * only when it holds exactly the planned bytes; symlinks and non-regular
 * entries are refused. The lease is asserted before and after.
 *
 * This must run **after** the journal exists: the journal references every
 * payload path before any of them is written.
 */
export async function materializeFilePayloads(plans, options = {}) {
  if (!Array.isArray(plans)) throw new TypeError("materializeFilePayloads requires an array of plans");
  const lease = options.lease;
  if (lease && typeof lease.assertHeld === "function") await lease.assertHeld();

  // Payloads are written next to their targets, and a target directory that
  // does not exist yet (for example a fresh `.opencode/`) is created here —
  // exactly what the legacy atomic writer did, and only after planning and
  // journal creation have succeeded. B8: the nearest existing ancestor is
  // identity-preflighted before any mkdir, every created directory is itself
  // proven, and a preflight/verification failure removes only the directories
  // this call strongly created.
  const directories = new Set(plans.map((plan) => path.dirname(plan.target)));
  const createdDirectories = [];
  try {
    for (const directory of directories) {
      await ensureDirectoryWithIdentitySupport(directory, createdDirectories);
    }
  } catch (error) {
    await removeCreatedDirectories(createdDirectories);
    throw error;
  }

  const materialized = [];
  try {
    for (const plan of plans) {
      if (!plan || typeof plan !== "object" || !plan.record || !plan.after) {
        throw new TypeError("each plan must come from planFilePayloads");
      }
      if (plan.before) materialized.push(await materializePayload(plan.before));
      materialized.push(await materializePayload(plan.after));
    }
  } catch (error) {
    // B5: a later materialization failure also cleans the attributable empty
    // directories this call created (deepest first); anything that gained an
    // entry, was replaced, or cannot be proven survives untouched.
    await removeCreatedDirectories(createdDirectories);
    throw error;
  }

  if (lease && typeof lease.assertHeld === "function") await lease.assertHeld();
  return Object.freeze({ materialized: Object.freeze(materialized) });
}

/**
 * B3: observes one derived transient without ever trusting its pathname:
 * `absent`, `not-regular`, `linked` (more than one name - B4), `foreign`
 * (wrong mode/owner), `unprovable` (no strong identity), or `present` with
 * its strong tagged identity.
 */
async function observeTransient(transient) {
  let stat;
  try {
    stat = await transactionInternals.lstat(transient);
  } catch (error) {
    if (error && error.code === "ENOENT") return { status: "absent" };
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return { status: "not-regular" };
  if (Number(stat.nlink) !== 1) return { status: "linked" };
  if (process.platform !== "win32") {
    if ((stat.mode & 0o077) !== 0) return { status: "foreign" };
    if (typeof process.getuid === "function" && Number(stat.uid) !== process.getuid()) return { status: "foreign" };
  }
  const identity = fileIdentity(stat);
  if (!isIdentityAvailable(identity)) return { status: "unprovable" };
  return { status: "present", identity };
}

/** True only while the transient still holds exactly `digest` bytes. */
async function transientHoldsDigest(transient, digest) {
  let bytes;
  try {
    bytes = await readRegularFileNoFollow(transient, { maxBytes: DEFAULT_MAX_FILE_BYTES, allowMissing: true });
  } catch (error) {
    if (error && (error.code === "ELOOP" || error.code === "EFTYPE" || error.code === "EBUSY" || error.code === "EFBIG")) {
      return false;
    }
    throw error;
  }
  return bytes !== null && sha256Bytes(bytes) === digest;
}

/**
 * B3 re-verification immediately before publish: the transient must still be
 * the exact entry this call created (or proved) *and* still hold exactly the
 * planned bytes. Anything else fails closed with the transient preserved.
 */
async function verifyTransientForPublish(transient, expectedIdentity, digest) {
  const observed = await observeTransient(transient);
  if (observed.status !== "present" || !identitiesEqual(observed.identity, expectedIdentity)) {
    throw recoveryConflict(`the payload transient at ${transient} changed before it was published; it was preserved`, {
      path: transient,
    });
  }
  if (!(await transientHoldsDigest(transient, digest))) {
    throw recoveryConflict(`the payload transient at ${transient} does not hold the recorded bytes; it was preserved`, {
      path: transient,
    });
  }
  return observed.identity;
}

/**
 * B4: proves the second name of an interrupted publish pair - a regular,
 * owner-only, current-uid file whose strong identity equals the payload's.
 * Returns the tagged identity on success, `null` otherwise.
 */
async function provenPairMember(pairPath, expectedIdentity) {
  let stat;
  try {
    stat = await transactionInternals.lstat(pairPath);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return null;
  if (process.platform !== "win32") {
    if ((stat.mode & 0o077) !== 0) return null;
    if (typeof process.getuid === "function" && Number(stat.uid) !== process.getuid()) return null;
  }
  const identity = fileIdentity(stat);
  if (!isIdentityAvailable(identity) || !identitiesEqual(identity, expectedIdentity)) return null;
  return identity;
}

async function materializePayload(entry) {
  const transient = payloadTransientPath(entry.path);
  // B4: a payload is exactly one name (nlink 1) unless this call explicitly
  // proves the interrupted publish pair - the payload and its derived
  // transient, one inode, exactly two links.
  const existing = await readPayload(entry.path, { allowMissing: true, allowLinkedPair: transient });
  if (existing) {
    const stat = await transactionInternals.lstat(entry.path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw recoveryConflict(`the payload path ${entry.path} is occupied by a non-regular entry`, { path: entry.path });
    }
    if (existing.sha256 === entry.sha256) {
      if (Number(stat.nlink) === 2) {
        // Interrupted publish: finish it by consuming the proven pair member.
        // The pair member legitimately has two links, so it is proven
        // directly (type, owner, mode, strong identity equal to the payload)
        // rather than through the single-link transient observation.
        const pair = await provenPairMember(transient, existing.identity);
        if (pair === null) {
          throw recoveryConflict(`the payload at ${entry.path} has an unproven extra link; it was preserved`, {
            path: entry.path,
          });
        }
        await removeTransientIfOwn(transient, existing.identity);
        const finalStat = await transactionInternals.lstat(entry.path);
        if (
          finalStat.isSymbolicLink() ||
          !finalStat.isFile() ||
          Number(finalStat.nlink) !== 1 ||
          !identitiesEqual(fileIdentity(finalStat), existing.identity)
        ) {
          throw recoveryConflict(`the payload at ${entry.path} is not a single-linked verified file; it was preserved`, {
            path: entry.path,
          });
        }
      }
      return "adopted";
    }
    // Payload bytes only ever land at the final path through the verified
    // publish below, so a mismatching regular payload can never be an
    // interrupted write of ours - it is foreign content and is preserved byte
    // for byte, never replaced. A pre-existing transient at the derived path
    // is equally unattributed (B3: a pathname is not ownership) and is
    // preserved too, never deleted.
    throw recoveryConflict(
      `the payload at ${entry.path} already exists with different content; it was preserved`,
      { path: entry.path },
    );
  }

  // B3: the derived transient is either a complete interrupted write of
  // exactly these bytes - provable by its content digest - or something this
  // call cannot attribute. Only the proven form is adopted; a partial or
  // foreign transient fails closed and is preserved byte for byte.
  let createdIdentity = null;
  const observed = await observeTransient(transient);
  if (observed.status === "present") {
    if (!(await transientHoldsDigest(transient, entry.sha256))) {
      throw recoveryConflict(
        `the payload transient at ${transient} is not a proven write of the recorded bytes; it was preserved`,
        { path: transient },
      );
    }
    createdIdentity = observed.identity;
  } else if (observed.status !== "absent") {
    throw recoveryConflict(`the payload transient at ${transient} cannot be attributed; it was preserved`, {
      path: transient,
    });
  } else {
    let handle = null;
    try {
      handle = await open(transient, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, 0o600);
      createdIdentity = fileIdentity(await handle.stat());
      if (!isIdentityAvailable(createdIdentity)) {
        throw recoveryConflict(
          `no payload was written: the transient at ${transient} has no stable file identity`,
          { path: transient },
        );
      }
      if (typeof handle.chmod === "function") await handle.chmod(0o600);
      if (entry.bytes.length > 0) await durableFsInternals.writeAll(handle, entry.bytes);
      await durableFsInternals.syncFile(handle, transient);
      await durableFsInternals.closeHandle(handle);
      handle = null;
    } catch (error) {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // Best effort: the original failure is what the caller observes.
        }
      }
      if (createdIdentity) await removeTransientIfOwn(transient, createdIdentity);
      throw error;
    }
  }

  // Publish: identity and content are re-verified immediately before the
  // destination is touched, the destination must still be absent, and the
  // publish itself is a kernel no-clobber hard link - a replacement that
  // appears at the payload path is never overwritten, and the destination is
  // verified to hold exactly these bytes before the transient is removed.
  await verifyTransientForPublish(transient, createdIdentity, entry.sha256);
  let destination = null;
  try {
    destination = await transactionInternals.lstat(entry.path);
  } catch (error) {
    if (error && error.code === "ENOENT") destination = null;
    else throw error;
  }
  if (destination) {
    throw recoveryConflict(`the payload path ${entry.path} appeared while the payload was being written; it was preserved`, {
      path: entry.path,
    });
  }
  try {
    await transactionInternals.link(transient, entry.path);
  } catch (error) {
    if (error && error.code === "EEXIST") {
      throw recoveryConflict(
        `the payload path ${entry.path} appeared while the payload was being written; it was preserved`,
        { path: entry.path },
      );
    }
    throw error;
  }
  // B4 link topology: immediately after the publish the two exact names must
  // be one inode with exactly two links - an extra alias anywhere means
  // nothing may be removed and the write fails closed with everything
  // preserved.
  const linkedPayload = await transactionInternals.lstat(entry.path);
  const linkedTransient = await transactionInternals.lstat(transient);
  const linkedPairProven =
    !linkedPayload.isSymbolicLink()
    && linkedPayload.isFile()
    && !linkedTransient.isSymbolicLink()
    && linkedTransient.isFile()
    && identitiesEqual(fileIdentity(linkedPayload), createdIdentity)
    && identitiesEqual(fileIdentity(linkedTransient), createdIdentity)
    && Number(linkedPayload.nlink) === 2
    && Number(linkedTransient.nlink) === 2;
  if (!linkedPairProven) {
    throw recoveryConflict(
      `the published payload at ${entry.path} is not the exact two-link pair that was written; it was preserved`,
      { path: entry.path },
    );
  }
  const published = await readPayload(entry.path, { expectedSha256: entry.sha256, allowLinkedPair: transient });
  if (published === null || !identitiesEqual(published.identity, createdIdentity)) {
    throw recoveryConflict(`the payload at ${entry.path} is not the proven transient that was published`, {
      path: entry.path,
    });
  }
  await syncDirectory(path.dirname(entry.path));
  // Remove only the proven transient (identity- and content-verified above);
  // a leftover that cannot be proven is preserved and cleaned later by the
  // content-proven recovery cleanup, never guessed at here.
  try {
    await removeTransientIfOwn(transient, createdIdentity);
  } catch {
    // Best effort: the topology check below decides whether publication held.
  }
  // B4: with the proven transient consumed, the payload must be exactly one
  // name again - a surviving alias fails closed and preserves everything.
  const finalStat = await transactionInternals.lstat(entry.path);
  if (
    finalStat.isSymbolicLink() ||
    !finalStat.isFile() ||
    Number(finalStat.nlink) !== 1 ||
    !identitiesEqual(fileIdentity(finalStat), createdIdentity)
  ) {
    throw recoveryConflict(`the payload at ${entry.path} is not a single-linked verified file after publication`, {
      path: entry.path,
    });
  }
  return "created";
}

/* ================================================================== *
 * Phase 6 - shared journaled executor plumbing
 * ================================================================== */

/**
 * Optional operation-specific prior-state guard (Phase 7).
 *
 * `{assertSafe(), inspectState(directory)}` brackets the prior-state snapshot
 * of a journaled transaction: `assertSafe()` runs immediately before and
 * immediately after the snapshot, and `inspectState(directory)` takes the
 * snapshot itself. Operations use it to refuse a legacy request that an older
 * harness may have written after the command's own early preflight, and to
 * snapshot the prior state without ever reading or hashing the live request
 * files it could contain. Both callbacks may throw their own coded refusal;
 * because the guard runs before journal creation, such a refusal leaves no
 * journal, payload, stage, or backup behind.
 *
 * The default (`undefined`/`null`) keeps every Phase 6 caller byte-for-byte
 * equivalent: `assertSafe` is never called and the snapshot is the ordinary
 * `inspectStateTree(directory)`.
 */
function normalizePriorStateGuard(guard, api) {
  if (guard === undefined || guard === null) return null;
  if (typeof guard !== "object" || Array.isArray(guard)) {
    throw new TypeError(`${api} priorStateGuard must be an object`);
  }
  if (typeof guard.assertSafe !== "function") {
    throw new TypeError(`${api} priorStateGuard.assertSafe must be a function`);
  }
  if (typeof guard.inspectState !== "function") {
    throw new TypeError(`${api} priorStateGuard.inspectState must be a function`);
  }
  return guard;
}

function normalizeCommonOptions(options, kind, api) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError(`${api} requires an options object`);
  }
  const paths = options.paths;
  if (!paths || typeof paths !== "object") throw new TypeError(`${api} requires control paths`);
  const lease = options.lease;
  if (!lease || typeof lease.assertHeld !== "function") {
    throw new TypeError(`${api} requires a held mutation-lock lease`);
  }
  if (typeof options.root !== "string" || options.root === "") throw new TypeError(`${api} requires a root path`);
  if (options.scope !== "project" && options.scope !== "global") {
    throw new TypeError(`${api} requires scope "project" or "global"`);
  }
  const command = options.command;
  const allowed = kind === "managed" ? ["init", "add", "scan"] : ["uninstall"];
  if (!allowed.includes(command)) throw new TypeError(`${api} requires command ${allowed.join("|")}`);
  const now = options.now ?? Date.now;
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const transactionId = options.transactionId ?? randomBytes(32).toString("hex");
  if (typeof transactionId !== "string" || !SHA256_PATTERN.test(transactionId)) {
    throw new TypeError(`${api} transactionId must be a lowercase sha256 hex digest`);
  }
  const files = options.files ?? [];
  if (!Array.isArray(files)) throw new TypeError(`${api} files must be an array`);
  const stateDirectory = path.resolve(options.stateDirectory);
  const root = path.resolve(options.root);
  return {
    paths,
    lease,
    root,
    scope: options.scope,
    command,
    stateDirectory,
    transactionId,
    now,
    files,
    cwd: typeof options.cwd === "string" && options.cwd !== "" ? options.cwd : root,
    claudeExec: options.claudeExec,
    claudeEnv: options.claudeEnv,
    stagePath: stagePathFor(stateDirectory, transactionId),
    backupPath: backupPathFor(stateDirectory, transactionId),
    priorStateGuard: normalizePriorStateGuard(options.priorStateGuard, api),
    doc: null,
    committed: false,
    commitProven: false,
    plans: null,
  };
}

async function updateDoc(ctx, patchValue, { recovery = false } = {}) {
  ctx.doc = await updateJournal(ctx.paths, ctx.doc, patchValue, { lease: ctx.lease, now: ctx.now, recovery });
}

/** Durable intent marker immediately before a destructive step. */
async function intentBump(ctx) {
  await ctx.lease.assertHeld();
  await updateDoc(ctx, { state: ctx.doc.state });
}

async function assertNoPendingJournal(ctx) {
  const existing = await readJournal(ctx.paths, {
    allowMissing: true,
    root: ctx.root,
    scope: ctx.scope,
    stateDirectory: ctx.stateDirectory,
  });
  if (existing) {
    throw recoveryConflict(
      `a transaction journal already exists at ${ctx.paths.journalFile}; recover it before starting a new transaction`,
      { transactionId: existing.transactionId, path: ctx.paths.journalFile },
    );
  }
}

async function inspectOwnedState(ctx, { required }) {
  // A guarded transaction snapshots through the operation's own inspector so
  // live legacy request files are never read or hashed into the journaled
  // digest; the default remains the ordinary Phase 6 inspection.
  const inspect = ctx.priorStateGuard ? ctx.priorStateGuard.inspectState : inspectStateTree;
  const info = await inspect(ctx.stateDirectory);
  if (info.status === "absent") {
    if (required) throw recoveryConflict(`router state is absent at ${ctx.stateDirectory}`, { path: ctx.stateDirectory });
    return null;
  }
  if (info.status === "foreign") {
    throw recoveryConflict(
      `Refusing to replace unowned directory: ${ctx.stateDirectory} (${info.reason ?? "it is not attributable to this router"})`,
      { path: ctx.stateDirectory },
    );
  }
  // The prior state may only enter a journal - and later authorize a backup
  // rename or a destructive cleanup - with a strong, available file identity.
  if (!isIdentityAvailable(info.identity)) {
    throw recoveryConflict(
      `Refusing to journal a router state without a stable file identity: ${ctx.stateDirectory}`,
      { path: ctx.stateDirectory },
    );
  }
  return { identity: info.identity, digest: info.digest };
}

/**
 * The Phase 7 legacy-request bracket: the operation's guard runs immediately
 * before and immediately after the prior-state snapshot, so a request written
 * by an older harness at any point during planning or inspection refuses the
 * transaction before a journal, payload, stage, or backup can exist. Both the
 * guard and the refusal it throws are operation-supplied; without a guard this
 * is a no-op and Phase 6 callers are unchanged.
 */
async function guardedPriorState(ctx, { required }) {
  if (ctx.priorStateGuard) await ctx.priorStateGuard.assertSafe();
  const prior = await inspectOwnedState(ctx, { required });
  if (ctx.priorStateGuard) await ctx.priorStateGuard.assertSafe();
  return prior;
}

async function writeFilePlans(ctx) {
  for (const plan of ctx.plans) {
    const current = () => ctx.doc.files.find((entry) => entry.target === plan.target);
    if (current().status === "applied") continue;
    await faultStep("file-intent", { target: plan.target });
    await updateDoc(ctx, {
      files: ctx.doc.files.map((entry) => (entry.target === plan.target ? { ...entry, status: "intent" } : entry)),
    });
    await faultStep("file-write", { target: plan.target });
    const outcome = await applyFileFromPayload(ctx.doc, current(), { lease: ctx.lease });
    if (outcome === "applied") await faultStep("file-applied", { target: plan.target });
    await updateDoc(ctx, {
      files: ctx.doc.files.map((entry) => (entry.target === plan.target ? { ...entry, status: "applied" } : entry)),
    });
  }
}

async function cleanupCommittedArtifacts(ctx) {
  const backup = ctx.doc.state.backup;
  if (backup) {
    const before = { identity: backup.identity, digest: backup.digest };
    const backupClass = await classifyStateArtifact(backup.path, { before });
    if (backupClass === "expected-before") {
      // Claim-based cleanup: the observed backup is renamed to its exact
      // derived claim, identity and digest are re-verified there, and only
      // that claim is removed - never the classified path in place. The
      // helper fires the `cleanup:backup` fault step before the rename.
      await cleanupStateArtifactViaClaim({
        lease: ctx.lease,
        artifactPath: backup.path,
        transactionId: ctx.doc.transactionId,
        expectation: before,
        label: "backup",
      });
    } else if (backupClass !== "absent") {
      throw recoveryConflict(`the recorded backup at ${backup.path} is not the recorded prior state`, {
        path: backup.path,
      });
    }
  }
  if (ctx.doc.state.stage) {
    const stageClass = await classifyStateArtifact(ctx.doc.state.stage.path, {
      desired: ctx.doc.state.stage.digest
        ? {
            ...(ctx.doc.state.stage.identity ? { identity: ctx.doc.state.stage.identity } : {}),
            digest: ctx.doc.state.stage.digest,
          }
        : null,
    });
    if (stageClass !== "absent") {
      throw recoveryConflict(`the recorded stage at ${ctx.doc.state.stage.path} is still present after commit`, {
        path: ctx.doc.state.stage.path,
      });
    }
  }
  await faultStep("cleanup:payloads", {});
  await ctx.lease.assertHeld();
  await cleanupPayloadTransients(ctx.doc.files, { lease: ctx.lease });
  await cleanupPayloads(ctx.doc.files, { lease: ctx.lease });
}

/**
 * Settles a journaled executor failure. Before commit it durably switches the
 * journal to rollback mode and then runs the *same* recovery machine a later
 * process would, so in-process rollback and crash rollback are one code path
 * (resumable, observation-driven). After commit - and for an ambiguous rename -
 * the journal is left exactly as it is for later recovery; nothing is restored
 * or removed here.
 */
async function settleFailure(ctx, { error, journalCreated }) {
  if (!journalCreated) return error;
  if (ctx.committed || ctx.commitProven) return error;
  if (ctx.doc && JOURNAL_TERMINAL_PHASES.includes(ctx.doc.phase)) return error;
  if (error && error.code === JOURNAL_ERROR_CODES.RECOVERY_AMBIGUOUS) return error;

  try {
    if (ctx.doc.mode === "forward") {
      ctx.doc = await updateJournal(ctx.paths, ctx.doc, { mode: "rollback" }, {
        lease: ctx.lease,
        now: ctx.now,
        recovery: false,
      });
    }
    const recovery = await recoverPendingTransaction({
      paths: ctx.paths,
      lease: ctx.lease,
      root: ctx.root,
      scope: ctx.scope,
      stateDirectory: ctx.stateDirectory,
      claudeExec: ctx.claudeExec,
      claudeEnv: ctx.claudeEnv,
      cwd: ctx.cwd,
      now: ctx.now,
    });
    if (recovery && Array.isArray(recovery.conflicts) && recovery.conflicts.length > 0) {
      const combined = new Error(
        `${error.message}; rollback preserved concurrent edits in: ${recovery.conflicts.join(", ")}`,
      );
      combined.cause = error;
      if (error.code !== undefined) combined.code = error.code;
      combined.recovery = recovery;
      return combined;
    }
    if (error && typeof error === "object") error.recovery = recovery;
    return error;
  } catch (recoveryError) {
    const combined = new Error(`${error.message}; rollback failed: ${recoveryError.message}`);
    combined.cause = error;
    combined.recoveryError = recoveryError;
    if (error.code !== undefined) combined.code = error.code;
    return combined;
  }
}

function journalClaudeSection(ctx) {
  if (!ctx.claudeMetadata) return null;
  return { ...ctx.claudeMetadata, actions: [] };
}

function baseJournal(ctx, kind, state) {
  const stamp = new Date(ctx.now()).toISOString();
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    owner: JOURNAL_OWNER,
    transactionId: ctx.transactionId,
    revision: 0,
    kind,
    command: ctx.command,
    mode: "forward",
    phase: "prepared",
    scope: ctx.scope,
    root: ctx.root,
    controlDirectory: ctx.paths.controlDirectory,
    stateDirectory: ctx.stateDirectory,
    createdAt: stamp,
    updatedAt: stamp,
    state,
    files: ctx.plans.map((plan) => ({ ...plan.record })),
    claude: journalClaudeSection(ctx),
  };
}

/* ================================================================== *
 * Phase 6 - managed (init/add/scan) journaled execution
 * ================================================================== */

/**
 * Journaled managed regeneration.
 *
 * Order, with a durable journal update before every destructive step and a
 * lease assertion immediately before each one:
 *
 *   1. side-effect-free `planFilePayloads` (no-follow reads + CAS),
 *   2. inspect the current owned state (absent / prior / foreign),
 *   3. create the rev0 `prepared` journal referencing the exact stage and the
 *      optional backup artifact plus Claude prior/desired metadata,
 *   4. materialize the 0600 payloads (never before the journal exists),
 *   5. build the stage at the exact transaction-derived path and record its
 *      identity/digest,
 *   6. rename prior state to the exact backup, then stage onto the canonical
 *      path - reconciling a thrown rename from the observed endpoints,
 *   7. apply each file from its verified payload (intent -> applied),
 *   8. local verify, Claude mutation through the journal observer,
 *   9. mark `proven`, then `committed`,
 *  10. exact-clean the backup, payloads, and journal.
 *
 * Any failure before commit durably sets rollback mode and delegates to
 * `recoverPendingTransaction`, which restores the exact prior state (only
 * while targets still equal the recorded digests), preserves and reports
 * concurrent edits, reconciles Claude to its recorded prior, verifies, and
 * cleans exactly. Failures after commit leave the committed journal for later
 * recovery. Ambiguous endpoints raise `RECOVERY_AMBIGUOUS` untouched.
 *
 * `buildStage(exactPath)` must create the stage at exactly the given path
 * (for example by calling `stageManagedState(..., {stageDirectory: exactPath})`).
 * `claude` is `{metadata, apply}` where `metadata` is the journal's Claude
 * section fields and `apply({observer})` performs the registration.
 *
 * `priorStateGuard` is the optional Phase 7 legacy-request bracket
 * (`{assertSafe(), inspectState(directory)}`). When present, `assertSafe()`
 * runs immediately before and immediately after the prior-state snapshot of
 * step 2 and the snapshot itself goes through `inspectState`, so a live
 * legacy request file is refused before any journal, payload, stage, or backup
 * exists and is never read or hashed into the recorded digest. Absent, every
 * Phase 6 caller behaves exactly as before.
 */
export async function applyJournaledManagedTransaction(options = {}) {
  const ctx = normalizeCommonOptions(options, "managed", "applyJournaledManagedTransaction");
  if (typeof options.buildStage !== "function") {
    throw new TypeError("applyJournaledManagedTransaction requires buildStage(exactPath)");
  }
  if (options.verify !== undefined && typeof options.verify !== "function") {
    throw new TypeError("verify must be a function");
  }
  ctx.buildStage = options.buildStage;
  ctx.verify = options.verify;
  ctx.claudeMetadata = options.claude?.metadata ?? null;
  if (options.claude !== undefined && options.claude !== null) {
    if (typeof options.claude.apply !== "function") {
      throw new TypeError("claude.apply({observer}) must be a function when claude metadata is recorded");
    }
    ctx.applyClaude = options.claude.apply;
  }

  let journalCreated = false;
  try {
    await faultStep("plan", { kind: "managed" });
    await ctx.lease.assertHeld();
    await assertNoPendingJournal(ctx);
    ctx.plans = await planFilePayloads(ctx.transactionId, ctx.files, {
      lease: ctx.lease,
      controlDirectory: ctx.paths.controlDirectory,
      stateDirectory: ctx.stateDirectory,
    });

    await faultStep("inspect", { kind: "managed" });
    const prior = await guardedPriorState(ctx, { required: false });

    await faultStep("journal:create", { kind: "managed" });
    ctx.doc = await createJournal(
      ctx.paths,
      baseJournal(ctx, "managed", {
        stage: { path: ctx.stagePath, identity: null, marker: null, digest: null },
        backup: prior
          ? {
              path: ctx.backupPath,
              // The plain journal-record form only: `inspectOwnedState` has
              // already required a strong, available identity.
              identity: identityRecord(prior.identity),
              marker: STATE_MARKER_CONTENT,
              digest: prior.digest,
            }
          : null,
      }),
      { lease: ctx.lease, now: ctx.now },
    );
    journalCreated = true;

    await faultStep("payloads:materialize", { kind: "managed" });
    await materializeFilePayloads(ctx.plans, { lease: ctx.lease });

    await faultStep("journal:intent", { kind: "managed" });
    await updateDoc(ctx, { phase: "intent" });

    await faultStep("stage:build", { path: ctx.stagePath });
    await ctx.lease.assertHeld();
    await ctx.buildStage(ctx.stagePath);
    const staged = await inspectStateTree(ctx.stagePath);
    if (staged.status !== "owned") {
      throw recoveryConflict(
        `the staged state at ${ctx.stagePath} is not attributable to this transaction: ${staged.reason ?? staged.status}`,
        { path: ctx.stagePath },
      );
    }
    // The stage may only enter the journal with a strong, available identity:
    // it is what later recovery must re-verify before any destructive cleanup.
    const stagedIdentity = identityRecord(staged.identity);
    if (stagedIdentity === null) {
      throw recoveryConflict(`the staged state at ${ctx.stagePath} does not report a stable file identity`, {
        path: ctx.stagePath,
      });
    }

    await faultStep("stage:record", { path: ctx.stagePath });
    await updateDoc(ctx, {
      state: {
        stage: { path: ctx.stagePath, identity: stagedIdentity, marker: STATE_MARKER_CONTENT, digest: staged.digest },
        backup: ctx.doc.state.backup,
      },
    });

    await faultStep("journal:applying", { kind: "managed" });
    await updateDoc(ctx, { phase: "applying" });

    if (ctx.doc.state.backup) await renameManagedBackup(ctx);
    await renameManagedInstall(ctx);

    await writeFilePlans(ctx);

    await faultStep("verify", { kind: "managed" });
    await ctx.lease.assertHeld();
    if (ctx.verify) await ctx.verify();

    if (ctx.applyClaude) {
      await faultStep("claude", { kind: "managed" });
      const observer = createJournalClaudeObserver({
        holder: ctx,
        paths: ctx.paths,
        lease: ctx.lease,
        now: ctx.now,
      });
      await ctx.applyClaude({ observer });
    }

    await faultStep("journal:proven", { kind: "managed" });
    await updateDoc(ctx, { phase: "proven" });
    await faultStep("journal:commit", { kind: "managed" });
    await updateDoc(ctx, { mode: "committed", phase: "committed" });
    ctx.committed = true;

    await cleanupCommittedArtifacts(ctx);
    await faultStep("cleanup:journal", { kind: "managed" });
    await removeJournal(ctx.paths, ctx.doc, { lease: ctx.lease });
    return {
      status: "committed",
      transactionId: ctx.transactionId,
      kind: "managed",
      stateDirectory: ctx.stateDirectory,
    };
  } catch (error) {
    throw await settleFailure(ctx, { error, journalCreated });
  }
}

/**
 * B3: a state-rename destination must be provably absent immediately before
 * the rename. Node offers no no-clobber directory rename, so a present
 * destination (a foreign replacement or a leftover) fails closed with
 * everything preserved rather than risking an overwrite.
 */
async function assertStateRenameDestinationAbsent(destination, what) {
  const observed = await inspectStateTree(destination);
  if (observed.status !== "absent") {
    throw recoveryConflict(
      `the ${what} destination ${destination} is present; nothing was renamed and the replacement was preserved`,
      { path: destination },
    );
  }
}

async function renameManagedBackup(ctx) {
  const backup = ctx.doc.state.backup;
  const before = { identity: backup.identity, digest: backup.digest };
  await faultStep("state:backup", { path: backup.path });
  await intentBump(ctx);
  await ctx.lease.assertHeld();

  await assertStateRenameDestinationAbsent(backup.path, "state backup");
  let failure = null;
  try {
    await journaledTransactionInternals.rename(ctx.stateDirectory, backup.path);
  } catch (error) {
    failure = error;
  }
  let canonical;
  let moved;
  try {
    canonical = await classifyStateArtifact(ctx.stateDirectory, { before });
    moved = await classifyStateArtifact(backup.path, { before });
  } catch (error) {
    throw recoveryAmbiguous(
      `the state backup rename outcome could not be observed at ${ctx.stateDirectory}: ${error.message}; nothing further was touched`,
      { path: backup.path },
    );
  }
  if (failure) {
    if (canonical === "expected-before" && moved === "absent") throw failure;
    if (!(canonical === "absent" && moved === "expected-before")) {
      throw recoveryAmbiguous(
        `the state backup rename could not be reconciled: ${ctx.stateDirectory} is ${canonical} and ${backup.path} is ${moved}; ` +
          "nothing was renamed, restored, or compensated",
        { path: backup.path },
      );
    }
  } else if (canonical !== "absent" || moved !== "expected-before") {
    throw recoveryAmbiguous(
      `the state backup rename did not produce the recorded endpoints: ${ctx.stateDirectory} is ${canonical} and ${backup.path} is ${moved}`,
      { path: backup.path },
    );
  }
}

async function renameManagedInstall(ctx) {
  const stage = ctx.doc.state.stage;
  const desired = stage.digest
    ? { ...(stage.identity ? { identity: stage.identity } : {}), digest: stage.digest }
    : null;
  const before = ctx.doc.state.backup
    ? { identity: ctx.doc.state.backup.identity, digest: ctx.doc.state.backup.digest }
    : null;

  await faultStep("state:install", { path: ctx.stagePath });
  await intentBump(ctx);
  await ctx.lease.assertHeld();
  await assertStateRenameDestinationAbsent(ctx.stateDirectory, "state install");

  let failure = null;
  try {
    await journaledTransactionInternals.rename(ctx.stagePath, ctx.stateDirectory);
  } catch (error) {
    failure = error;
  }

  let canonical;
  let stageState;
  try {
    canonical = await classifyStateArtifact(ctx.stateDirectory, { before, desired });
    stageState = await classifyStateArtifact(ctx.stagePath, { desired });
  } catch (error) {
    throw recoveryAmbiguous(
      `the state install rename outcome could not be observed at ${ctx.stateDirectory}: ${error.message}; nothing further was touched`,
      { path: ctx.stagePath },
    );
  }
  if (failure) {
    const preCommit =
      stageState === "expected-desired" && (canonical === "absent" || canonical === "expected-before");
    if (preCommit) throw failure;
    if (!(canonical === "expected-desired" && stageState === "absent")) {
      throw recoveryAmbiguous(
        `the state install rename could not be reconciled: ${ctx.stateDirectory} is ${canonical} and ${ctx.stagePath} is ${stageState}; ` +
          "nothing was renamed, restored, or compensated",
        { path: ctx.stagePath },
      );
    }
  } else if (canonical !== "expected-desired" || stageState !== "absent") {
    throw recoveryAmbiguous(
      `the state install rename did not produce the recorded endpoints: ${ctx.stateDirectory} is ${canonical} and ${ctx.stagePath} is ${stageState}`,
      { path: ctx.stagePath },
    );
  }
}

/* ================================================================== *
 * Phase 6 - removal (uninstall) journaled execution
 * ================================================================== */

/**
 * Journaled removal. It preserves the Phase 5 ordering, compare-and-swap, and
 * blast-radius semantics exactly - snapshot/CAS before any write, local detach
 * and verification, external detach with re-observation, final integration
 * absence plus ownership revalidation - and wraps them in the journal:
 *
 *   PREPARED journal referencing payloads precedes every payload and OpenCode
 *   mutation; every local write and every Claude action is journaled (intent
 *   before the command, observed outcome after re-observation) with a global
 *   sequence; the exact same-parent state rename is the commit, and it is
 *   only attempted after durable `commit-ready` intent.
 *
 * Rename success (as proven by the observed endpoints) means committed:
 * afterwards nothing restores integrations or configuration - the exact
 * backup, payloads, and journal are validated and deleted. Before commit,
 * failures durably switch to rollback mode and run the recovery machine, which
 * restores the recorded bytes (only while targets still equal what this
 * transaction wrote), reconciles Claude to its recorded prior, verifies, and
 * cleans exactly. Ambiguous endpoints raise `RECOVERY_AMBIGUOUS` untouched.
 *
 * Hooks keep their Phase 5 shapes; mutating hooks additionally receive
 * `{observer}` so their Claude actions are journaled.
 */
export async function applyJournaledRemovalTransaction(options = {}) {
  const ctx = normalizeCommonOptions(options, "removal", "applyJournaledRemovalTransaction");
  ctx.stateIdentity = options.stateIdentity ?? null;
  ctx.verifyLocal = options.verifyLocal;
  ctx.applyExternal = options.applyExternal;
  ctx.verifyExternal = options.verifyExternal;
  ctx.verifyIntegrations = options.verifyIntegrations;
  ctx.revalidateOwned = options.revalidateOwned;
  ctx.claudeMetadata = options.claude?.metadata ?? null;

  let journalCreated = false;
  try {
    await faultStep("plan", { kind: "removal" });
    await ctx.lease.assertHeld();
    await assertNoPendingJournal(ctx);
    ctx.plans = await planFilePayloads(ctx.transactionId, ctx.files, {
      lease: ctx.lease,
      controlDirectory: ctx.paths.controlDirectory,
      stateDirectory: ctx.stateDirectory,
    });

    await faultStep("inspect", { kind: "removal" });
    const prior = await guardedPriorState(ctx, { required: true });
    if (ctx.stateIdentity) {
      if (
        typeof ctx.stateIdentity.path === "string" &&
        path.resolve(ctx.stateIdentity.path) !== ctx.stateDirectory
      ) {
        throw recoveryConflict("the recorded state identity belongs to another path", {
          path: ctx.stateDirectory,
        });
      }
      if (!stateIdentityMatches(ctx.stateIdentity, { dev: prior.identity.dev, ino: prior.identity.ino })) {
        throw recoveryConflict("the router state no longer matches the recorded device/inode identity", {
          path: ctx.stateDirectory,
        });
      }
    }

    await faultStep("journal:create", { kind: "removal" });
    ctx.doc = await createJournal(
      ctx.paths,
      baseJournal(ctx, "removal", {
        stage: null,
        backup: {
          path: ctx.backupPath,
          // The plain journal-record form only: `inspectOwnedState` has
          // already required a strong, available identity.
          identity: identityRecord(prior.identity),
          marker: STATE_MARKER_CONTENT,
          digest: prior.digest,
        },
      }),
      { lease: ctx.lease, now: ctx.now },
    );
    journalCreated = true;

    await faultStep("payloads:materialize", { kind: "removal" });
    await materializeFilePayloads(ctx.plans, { lease: ctx.lease });

    await faultStep("journal:intent", { kind: "removal" });
    await updateDoc(ctx, { phase: "intent" });

    await writeFilePlans(ctx);

    await faultStep("verify-local", { kind: "removal" });
    await ctx.lease.assertHeld();
    await ctx.verifyLocal?.({ phase: "detached" });

    await faultStep("journal:detaching", { kind: "removal" });
    await updateDoc(ctx, { phase: "detaching" });

    if (ctx.applyExternal) {
      await faultStep("claude-detach", { kind: "removal" });
      const observer = createJournalClaudeObserver({ holder: ctx, paths: ctx.paths, lease: ctx.lease, now: ctx.now });
      await ctx.applyExternal({ observer });
    }

    await faultStep("verify-external", { kind: "removal" });
    await ctx.lease.assertHeld();
    await ctx.verifyExternal?.();

    await faultStep("verify-integrations", { kind: "removal" });
    await ctx.lease.assertHeld();
    await ctx.verifyIntegrations?.();

    await faultStep("revalidate", { kind: "removal" });
    await ctx.lease.assertHeld();
    await assertCanonicalStillOwned(ctx);
    await ctx.revalidateOwned?.();

    await faultStep("journal:commit-ready", { kind: "removal" });
    await updateDoc(ctx, { phase: "commit-ready" });
    await renameRemovalCommit(ctx);

    await faultStep("journal:commit", { kind: "removal" });
    await updateDoc(ctx, { mode: "committed", phase: "committed" });
    ctx.committed = true;

    // Post-commit cleanup failures keep the Phase 5 contract: the uninstall
    // itself is durable, the committed journal stays behind for recovery, and
    // the caller receives the distinct committed-cleanup error that names the
    // exact backup path instead of a claim that anything was rolled back.
    try {
      await cleanupCommittedArtifacts(ctx);
    } catch (cause) {
      throw new UninstallCommittedCleanupError(ctx.doc.state.backup?.path ?? ctx.backupPath, cause);
    }
    await faultStep("cleanup:journal", { kind: "removal" });
    await removeJournal(ctx.paths, ctx.doc, { lease: ctx.lease });
    return {
      status: "committed",
      transactionId: ctx.transactionId,
      kind: "removal",
      stateDirectory: ctx.stateDirectory,
    };
  } catch (error) {
    throw await settleFailure(ctx, { error, journalCreated });
  }
}

async function assertCanonicalStillOwned(ctx) {
  const info = await inspectStateTree(ctx.stateDirectory);
  if (info.status !== "owned") {
    throw recoveryConflict(
      `the router state at ${ctx.stateDirectory} is no longer the owned state (${info.reason ?? info.status})`,
      { path: ctx.stateDirectory },
    );
  }
  const recorded = ctx.doc.state.backup;
  if (
    !isIdentityAvailable(info.identity)
    || !identitiesEqual(info.identity, recorded.identity)
  ) {
    throw recoveryConflict("the router state no longer matches the recorded device/inode identity", {
      path: ctx.stateDirectory,
    });
  }
  if (info.digest !== recorded.digest) {
    throw recoveryConflict("the router state changed while the removal was running", { path: ctx.stateDirectory });
  }
}

async function renameRemovalCommit(ctx) {
  const backup = ctx.doc.state.backup;
  const before = { identity: backup.identity, digest: backup.digest };

  await faultStep("state:rename", { path: backup.path });
  await intentBump(ctx);
  await ctx.lease.assertHeld();
  await assertStateRenameDestinationAbsent(backup.path, "commit");

  let failure = null;
  try {
    await journaledTransactionInternals.rename(ctx.stateDirectory, backup.path);
  } catch (error) {
    failure = error;
  }

  let canonical;
  let moved;
  try {
    canonical = await classifyStateArtifact(ctx.stateDirectory, { before });
    moved = await classifyStateArtifact(backup.path, { before });
  } catch (error) {
    throw recoveryAmbiguous(
      `the commit rename outcome could not be observed at ${ctx.stateDirectory}: ${error.message}; nothing was renamed, restored, or compensated`,
      { path: backup.path },
    );
  }

  if (failure) {
    if (canonical === "expected-before" && moved === "absent") throw failure;
    if (!(canonical === "absent" && moved === "expected-before")) {
      throw recoveryAmbiguous(
        `the commit rename could not be reconciled: ${ctx.stateDirectory} is ${canonical} and ${backup.path} is ${moved}; ` +
          "nothing was renamed, restored, or compensated",
        { path: backup.path },
      );
    }
  }
  // The observed endpoints prove the rename committed: from here on nothing
  // rolls back, even if a later verification or journal write fails.
  ctx.commitProven = true;

  await faultStep("state:verify", { path: backup.path });
  await ctx.lease.assertHeld();
  let verifiedCanonical;
  let verifiedBackup;
  try {
    verifiedCanonical = await classifyStateArtifact(ctx.stateDirectory, { before });
    verifiedBackup = await classifyStateArtifact(backup.path, { before });
  } catch (error) {
    throw recoveryAmbiguous(
      `the committed endpoints could not be verified: ${error.message}; nothing was restored or removed`,
      { path: backup.path },
    );
  }
  if (verifiedCanonical !== "absent" || verifiedBackup !== "expected-before") {
    throw recoveryAmbiguous(
      `the committed endpoints are not proven: ${ctx.stateDirectory} is ${verifiedCanonical} and ${backup.path} is ${verifiedBackup}; ` +
        "nothing was restored or removed",
      { path: backup.path },
    );
  }
}

async function snapshot(file) {
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Refusing to replace non-regular file: ${file}`);
    return await readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomic(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function applyManagedTransaction({ stateDirectory, stagedDirectory, files, verify, apply, compensate }) {
  const stateBackup = `${stateDirectory}.backup-${randomUUID()}`;
  let hadState = false;
  let installedState = false;
  let applyStarted = false;
  let backups = [];
  try {
    backups = await Promise.all(files.map(async (entry) => ({ ...entry, before: await snapshot(entry.path) })));
    await mkdir(path.dirname(stateDirectory), { recursive: true });
    let stateExists = false;
    try {
      await lstat(stateDirectory);
      stateExists = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (stateExists) {
      const stateStat = await lstat(stateDirectory);
      if (stateStat.isSymbolicLink() || !stateStat.isDirectory()) {
        throw new Error(`Refusing to replace non-directory router state: ${stateDirectory}`);
      }
      let marker;
      try {
        marker = await readFile(path.join(stateDirectory, ".skill-router-owned"), "utf8");
      } catch (error) {
        if (error.code === "ENOENT") throw new Error(`Refusing to replace unowned directory: ${stateDirectory}`);
        throw error;
      }
      if (marker.trim() !== "skill-router-state-v1") {
        throw new Error(`Refusing to replace unowned directory: ${stateDirectory}`);
      }
      await rename(stateDirectory, stateBackup);
      hadState = true;
    }
    await rename(stagedDirectory, stateDirectory);
    installedState = true;
    for (const entry of files) await writeAtomic(entry.path, entry.content);
    await verify?.();
    if (apply) {
      applyStarted = true;
      await apply();
    }
    await rm(stateBackup, { recursive: true, force: true });
  } catch (error) {
    // Filesystem and configuration state is restored first, so external
    // compensation runs against the pre-attempt router state it belongs to.
    let rollbackFailure = null;
    try {
      if (installedState) await rm(stateDirectory, { recursive: true, force: true });
      if (hadState) await rename(stateBackup, stateDirectory);
      for (const entry of backups.reverse()) {
        if (entry.before === null) await rm(entry.path, { force: true });
        else await writeAtomic(entry.path, entry.before);
      }
      await rm(stagedDirectory, { recursive: true, force: true });
    } catch (rollbackError) {
      rollbackFailure = rollbackError;
    }

    let compensationFailure = null;
    if (applyStarted && compensate) {
      try {
        await compensate(error);
      } catch (error) {
        compensationFailure = error;
      }
    }

    if (rollbackFailure || compensationFailure) {
      const details = [error.message];
      if (rollbackFailure) details.push(`rollback failed: ${rollbackFailure.message}`);
      if (compensationFailure) details.push(`compensation failed: ${compensationFailure.message}`);
      const combined = new Error(details.join("; "));
      combined.cause = error;
      throw combined;
    }
    throw error;
  }
}

/**
 * Narrow seams: `writeAtomic` is the legacy atomic writer; `lstat` is the
 * injected-testable observation used by payload-transient cleanup, so tests can
 * prove an entry with an unprovable file identity is preserved rather than
 * monkeypatching the global `node:fs` stat.
 */
export const transactionInternals = {
  writeAtomic,
  lstat: (target) => lstat(target),
  // The Node no-clobber publish primitive (B2/B3): `link` fails with EEXIST
  // instead of overwriting a destination that appeared in the meantime.
  link: (from, to) => link(from, to),
};

/**
 * Injection seams so tests can make the commit rename, the committed-state
 * verification, and the backup cleanup fail deterministically.
 */
export const removalTransactionInternals = {
  rename,
  rm,
  backupPath: (stateDirectory) => `${stateDirectory}.removal-backup-${randomUUID()}`,
  verifyCommit: async ({ stateDirectory, backupPath, stateIdentity }) => {
    await assertPathAbsent(stateDirectory, "Router state");
    const backupStat = await assertOwnedStateDirectory(backupPath, "state backup");
    assertRecordedIdentity(stateIdentity, backupStat, undefined, "State backup");
  },
};

/**
 * Thrown only after the commit rename and its verification succeeded. The
 * uninstall itself is durable; the leftover backup is a cleanup problem that
 * must be removed by hand at the reported path, so this error never
 * compensates external integrations or restores local files.
 */
export class UninstallCommittedCleanupError extends Error {
  constructor(backupPath, cause) {
    super(`Uninstall committed; failed to remove the state backup at ${backupPath}: ${cause.message}`);
    this.name = "UninstallCommittedCleanupError";
    this.code = "UNINSTALL_COMMITTED_BACKUP_CLEANUP_FAILED";
    this.committed = true;
    this.backupPath = backupPath;
    this.cause = cause;
  }
}

/**
 * Thrown when the commit rename itself failed and could not be reconciled to a
 * safe pre-commit rollback. The state directory may already have moved, so the
 * backup is left exactly where it is: nothing is renamed, restored, or
 * compensated, and the caller is told the outcome may already be committed.
 */
export class UninstallCommitUncertainError extends Error {
  constructor({ stateDirectory, backupPath, committed, cause }) {
    super(
      `Uninstall commit outcome is uncertain: ${cause.message}. ` +
        `Canonical state at ${stateDirectory} is ${committed ? "absent" : "present but not the recorded owned state"}; ` +
        `the backup at ${backupPath} was left untouched. Nothing was renamed, restored, or compensated, ` +
        `so inspect both paths before retrying.`,
    );
    this.name = "UninstallCommitUncertainError";
    this.code = "UNINSTALL_COMMIT_UNCERTAIN";
    this.uncertain = true;
    this.committed = committed;
    this.stateDirectory = stateDirectory;
    this.backupPath = backupPath;
    this.cause = cause;
  }
}

/**
 * Thrown when the rename succeeded — so the uninstall is committed — but the
 * committed backup could not be verified (original absence, backup ownership,
 * or recorded identity). The backup is left untouched and nothing is restored,
 * because reinstalling from a possibly wrong directory is never safe.
 */
export class UninstallCommittedVerificationError extends Error {
  constructor(backupPath, cause) {
    super(`Uninstall committed; the committed state backup could not be verified at ${backupPath}: ${cause.message}`);
    this.name = "UninstallCommittedVerificationError";
    this.code = "UNINSTALL_COMMITTED_VERIFICATION_FAILED";
    this.committed = true;
    this.backupPath = backupPath;
    this.cause = cause;
  }
}

async function assertPathAbsent(target, description) {
  try {
    await lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${description} is still present: ${target}`);
}

function assertRecordedIdentity(identity, stat, expectedPath, description) {
  if (!identity) return;
  if (expectedPath !== undefined) {
    if (typeof identity.path !== "string" || path.resolve(identity.path) !== expectedPath) {
      throw new Error(`${description} does not match the recorded state path: ${identity.path}`);
    }
  }
  if (!stateIdentityMatches(identity, stat)) {
    throw new Error(`${description} does not match the recorded device/inode identity`);
  }
}

async function assertCanonicalState(directory, identity) {
  const stat = await assertOwnedStateDirectory(directory, "router state");
  assertRecordedIdentity(identity, stat, directory, "Router state");
  return stat;
}

function toBuffer(value) {
  return Buffer.from(value);
}

function describeBytes(value) {
  return value === null ? "no file" : `${value.length} bytes`;
}

function normalizeExpected(value) {
  if (value === null) return null;
  if (typeof value === "string" || value instanceof Uint8Array) return toBuffer(value);
  throw new Error("expectedBefore must be null, text, or bytes");
}

/**
 * No-follow observation used only while reconciling a rename that threw:
 * `absent`, `owned` (non-symlink directory with the exact marker and, when an
 * identity is recorded, its recorded `dev`/`ino` and — for the canonical path —
 * its recorded path), or `foreign`. Nothing here writes or renames.
 */
async function observeOwnedTarget(directory, identity, expectedPath) {
  let stat;
  try {
    stat = await lstat(directory);
  } catch (error) {
    if (error.code === "ENOENT") return "absent";
    return "foreign";
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return "foreign";
  try {
    await assertOwnedStateDirectory(directory, "state");
  } catch {
    return "foreign";
  }
  if (!identity) return "owned";
  if (expectedPath !== null && (typeof identity.path !== "string" || path.resolve(identity.path) !== expectedPath)) {
    return "foreign";
  }
  if (!stateIdentityMatches(identity, stat)) return "foreign";
  return "owned";
}

/**
 * Reconciles a rename that reported an error by observing both endpoints:
 * - `committed`: the canonical path is gone and the backup is the recorded
 *   owned state, so the rename completed despite the error.
 * - `rollback`: the canonical path still holds the recorded owned state and no
 *   matching committed backup exists, so the commit never happened.
 * - `uncertain`: anything else. The caller must not rename, restore, or
 *   compensate; an unverified backup is never moved back to canonical.
 */
async function observeCommitOutcome(stateDirectory, backupPath, identity) {
  const canonical = await observeOwnedTarget(stateDirectory, identity, stateDirectory);
  const backup = await observeOwnedTarget(backupPath, identity, null);
  if (canonical === "absent" && backup === "owned") return { verdict: "committed", committed: true };
  if (canonical === "owned" && backup !== "owned") return { verdict: "rollback", committed: false };
  return { verdict: "uncertain", committed: canonical === "absent" };
}

/**
 * Removal transaction. Integration detach happens first, while the state
 * directory still sits at its canonical path, and the same-parent rename of
 * that state directory is the commit boundary:
 *
 *   1. snapshot every listed file byte-exactly (non-regular targets refuse) and
 *      compare each snapshot with the `expectedBefore` bytes recorded while
 *      planning, refusing before any write or hook on mismatch,
 *   2. write the local detach and verify it,
 *   3. apply and verify the external detach,
 *   4. run the final integration re-verification,
 *   5. revalidate ownership and state identity,
 *   6. rename state to a random backup — the rename is immediately committed —
 *      then verify the original is gone and the backup is still the owned
 *      directory it was, and delete the backup.
 *
 * Failures before the rename restore the bytes *this transaction wrote* (only
 * when the file still holds them; a concurrent edit is preserved and reported
 * as a rollback conflict), keep and revalidate the canonical state, run
 * external compensation only when an external mutation was started, verify the
 * restoration when `verifyLocal` is supplied, and aggregate every secondary
 * failure into one error.
 *
 * A successful rename is committed at once: nothing after it may roll back or
 * compensate. Backup verification failures raise
 * `UninstallCommittedVerificationError`, cleanup failures raise
 * `UninstallCommittedCleanupError`, and a rename that threw is reconciled by
 * observing both endpoints — rollback only when the canonical state is still
 * the recorded one and no matching backup exists, committed when the rename
 * completed despite the error, and `UninstallCommitUncertainError` otherwise.
 * Locks, journaling, and signal recovery are out of scope here (Phase 6).
 *
 * Hooks, in the only order they run:
 * - `verifyLocal({ phase })` proves the local detach with
 *   `phase: "detached"` and the restored bytes with `phase: "restored"`, so a
 *   supplied verifier must accept both phases.
 * - `applyExternal()` and `verifyExternal()` run while state is still
 *   canonical; `compensateExternal(error)` runs only when `applyExternal`
 *   was invoked, and only before commit.
 * - `verifyIntegrations()` re-checks every recorded integration after ordinary
 *   external verification and immediately before ownership revalidation and
 *   the commit rename, so a source or registration reintroduced during the
 *   run aborts pre-commit.
 * - `revalidateOwned()` re-reads ownership and identity while state is
 *   canonical: once before the commit rename, and again after a rollback has
 *   put the canonical state back.
 */
export async function applyRemovalTransaction({
  stateDirectory,
  stateIdentity = null,
  files = [],
  verifyLocal,
  applyExternal,
  verifyExternal,
  verifyIntegrations,
  compensateExternal,
  revalidateOwned,
} = {}) {
  if (typeof stateDirectory !== "string" || stateDirectory === "") {
    throw new Error("applyRemovalTransaction requires a state directory");
  }
  const resolvedState = path.resolve(stateDirectory);
  const entries = [];
  for (const [index, entry] of [...files].entries()) {
    if (!entry || typeof entry.path !== "string" || entry.path === "") {
      throw new Error(`Removal file entry ${index} must record a path`);
    }
    if (typeof entry.content !== "string" && !(entry.content instanceof Uint8Array)) {
      throw new Error(`Removal file entry ${index} must record text or byte content`);
    }
    const record = { path: entry.path, content: entry.content };
    if (Object.hasOwn(entry, "expectedBefore")) record.expectedBefore = normalizeExpected(entry.expectedBefore);
    entries.push(record);
  }

  // Snapshots happen before any mutation, so a non-regular target refuses
  // without leaving hooks, compensation, or half-written files behind. The
  // recorded `expectedBefore` bytes are compared with each snapshot next, so a
  // file that changed since planning refuses before anything is written and
  // before any hook can run.
  const snapshots = [];
  for (const entry of entries) {
    const before = await snapshot(entry.path);
    if (Object.hasOwn(entry, "expectedBefore")) {
      const expected = entry.expectedBefore;
      const matches = expected === null ? before === null : before !== null && Buffer.compare(before, expected) === 0;
      if (!matches) {
        throw new Error(
          `Refusing to write ${entry.path}: it no longer matches the bytes observed during planning ` +
            `(expected ${describeBytes(expected)}, found ${describeBytes(before)})`,
        );
      }
    }
    snapshots.push({ path: entry.path, content: entry.content, before, written: false });
  }

  const backup = removalTransactionInternals.backupPath(resolvedState);
  let externalStarted = false;
  let stage = "local";
  try {
    for (const entry of snapshots) {
      await transactionInternals.writeAtomic(entry.path, entry.content);
      entry.written = true;
    }
    await verifyLocal?.({ phase: "detached" });

    stage = "external";
    if (applyExternal) {
      externalStarted = true;
      await applyExternal();
    }
    await verifyExternal?.();

    stage = "integrations";
    await verifyIntegrations?.();

    stage = "revalidate";
    await assertCanonicalState(resolvedState, stateIdentity);
    await revalidateOwned?.();
  } catch (error) {
    await rollbackRemoval({
      error,
      stage,
      resolvedState,
      snapshots,
      externalStarted,
      stateIdentity,
      verifyLocal,
      compensateExternal,
      revalidateOwned,
    });
    throw error; // unreachable: rollbackRemoval always throws
  }

  // ---- Commit boundary: a successful rename is committed immediately. ----
  let renameError = null;
  try {
    await removalTransactionInternals.rename(resolvedState, backup);
  } catch (error) {
    renameError = error;
  }
  if (renameError) {
    const outcome = await observeCommitOutcome(resolvedState, backup, stateIdentity);
    if (outcome.verdict === "rollback") {
      await rollbackRemoval({
        error: renameError,
        stage: "commit",
        resolvedState,
        snapshots,
        externalStarted,
        stateIdentity,
        verifyLocal,
        compensateExternal,
        revalidateOwned,
      });
      throw renameError; // unreachable: rollbackRemoval always throws
    }
    if (outcome.verdict === "uncertain") {
      throw new UninstallCommitUncertainError({
        stateDirectory: resolvedState,
        backupPath: backup,
        committed: outcome.committed,
        cause: renameError,
      });
    }
    // `committed`: the rename completed despite the reported error.
  }

  // Post-commit. Nothing below rolls back, restores, or compensates.
  try {
    await removalTransactionInternals.verifyCommit({
      stateDirectory: resolvedState,
      backupPath: backup,
      stateIdentity,
    });
  } catch (error) {
    throw new UninstallCommittedVerificationError(backup, error);
  }
  try {
    await removalTransactionInternals.rm(backup, { recursive: true, force: true });
    await assertPathAbsent(backup, "State backup");
  } catch (cause) {
    throw new UninstallCommittedCleanupError(backup, cause);
  }
  return { status: "committed", stateDirectory: resolvedState };
}

async function rollbackRemoval({
  error,
  stage,
  resolvedState,
  snapshots,
  externalStarted,
  stateIdentity,
  verifyLocal,
  compensateExternal,
  revalidateOwned,
}) {
  const failures = [];

  // Restore only the bytes this transaction actually wrote, and only while the
  // file still holds exactly them. A concurrent edit — including a missing
  // replacement — is preserved untouched and reported as a rollback conflict
  // rather than being clobbered by the restoration.
  for (const entry of [...snapshots].reverse()) {
    if (!entry.written) continue;
    let current = null;
    let unreadable = null;
    try {
      current = await readFile(entry.path);
    } catch (readError) {
      if (readError.code === "ENOENT") current = null;
      else unreadable = readError;
    }
    if (unreadable) {
      failures.push(`rollback failed: ${unreadable.message}`);
      continue;
    }
    const wrote = toBuffer(entry.content);
    if (current === null || Buffer.compare(current, wrote) !== 0) {
      failures.push(
        `rollback conflict: ${entry.path} no longer holds the bytes this transaction wrote; ` +
          "the concurrent contents were preserved",
      );
      continue;
    }
    try {
      if (entry.before === null) await removalTransactionInternals.rm(entry.path, { force: true });
      else await transactionInternals.writeAtomic(entry.path, entry.before);
    } catch (restoreError) {
      failures.push(`rollback failed: ${restoreError.message}`);
    }
  }

  // The commit rename never happened, so the canonical state is still in place
  // and can be revalidated — except when that very revalidation just failed.
  if (stage !== "revalidate") {
    try {
      await assertCanonicalState(resolvedState, stateIdentity);
      await revalidateOwned?.();
    } catch (revalidationError) {
      failures.push(`revalidation failed: ${revalidationError.message}`);
    }
  }
  if (externalStarted && compensateExternal) {
    try {
      await compensateExternal(error);
    } catch (compensationError) {
      failures.push(`compensation failed: ${compensationError.message}`);
    }
  }
  if (verifyLocal) {
    try {
      await verifyLocal({ phase: "restored" });
    } catch (verificationError) {
      failures.push(`restoration verification failed: ${verificationError.message}`);
    }
  }

  if (failures.length === 0) throw error;
  const combined = new Error([error.message, ...failures].join("; "));
  combined.cause = error;
  throw combined;
}
