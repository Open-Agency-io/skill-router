// Phase 6 — controlled mutation/read/recovery runners.
//
// These three runners are the single controlled boundary every public command
// crosses, so they are also where the Phase 14 platform guard lives: an
// unsupported runtime (win32) is refused as the first statement of each runner,
// before the control context is resolved and before any mkdir, chmod, lock,
// journal, claim, anchor, or write can happen (`src/platform.js`). Help and
// version never reach a runner. On Linux and macOS nothing changes.
//
// Every public command reaches the filesystem through one of these wrappers so
// the ordering is always the same:
//
//   resolve control context (no config load) -> acquire the mutation lease at
//   the fixed control paths -> inspect the journal (strictly bound to this
//   context) -> validate the existing control anchor, or durably create one
//   only when a pending journal has proven its root/scope/control binding ->
//   (mutations) auto-recover -> build the full context under the lease ->
//   revalidate root/scope/control identity -> run the operation while holding
//   the lease -> assert the lease -> release. A control directory (or parent)
//   this run created is deliberately left in place: empty, owner-private, and
//   inert (R1), so no directory is ever removed by path.
//
// Anchor validation never runs after recovery: a malformed, symlinked,
// non-regular, foreign-root, wrong-scope, over-permissive, or wrong-owner
// anchor fails closed before any state, configuration, or Claude mutation.
//
// Dry runs and reads never recover: a valid pending journal raises the stable
// `RECOVERY_REQUIRED` code (or is delivered to an operation that reports it,
// as `check` does), and a malformed journal fails closed with the journal's
// stable code. Lock, journal, and anchor problems keep their existing stable
// codes; there is no force flag.
import path from "node:path";
import { controlPaths, LOCK_ERROR_CODES, MutationLockError, acquireMutationLock } from "./mutation-lock.js";
import {
  durableFsInternals,
  durableUnlink,
  fileIdentity,
  identitiesEqual,
  isIdentityAvailable,
} from "./durable-fs.js";
import { JOURNAL_ERROR_CODES, JournalError } from "./journal.js";
import { assertSupportedRuntimePlatform } from "./platform.js";
import { inspectRecoveryRequirement, recoverPendingTransaction } from "./recovery.js";
import {
  ensureControlAnchor,
  homeDirectory,
  readControlAnchor,
  resolveControlContext,
  createContext,
} from "./workspace.js";

/** Default wait targets: mutations 10s, reads 2s (see the lock contract). */
export const MUTATION_LOCK_TIMEOUT_MS = 10_000;
export const READ_LOCK_TIMEOUT_MS = 2_000;
export const MAX_LOCK_TIMEOUT_MS = 300_000;

const JOURNAL_CODES = new Set(Object.values(JOURNAL_ERROR_CODES));

/**
 * Stable, bounded refusal for a pending transaction: dry runs and reads never
 * recover on their own, so they surface this instead. `RECOVERY_REQUIRED` is
 * part of the accepted Phase 6 error set.
 */
export class RecoveryRequiredError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "RecoveryRequiredError";
    this.code = "RECOVERY_REQUIRED";
    if (details.transactionId !== undefined) this.transactionId = details.transactionId;
    if (details.kind !== undefined) this.kind = details.kind;
  }
}

/** Strict lock-timeout parsing shared by the CLI and the runners (0..300000). */
export function normalizeLockTimeout(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const numeric =
    typeof value === "number" ? value : typeof value === "string" && /^\d{1,6}$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > MAX_LOCK_TIMEOUT_MS) {
    throw new Error(`--lock-timeout must be an integer between 0 and ${MAX_LOCK_TIMEOUT_MS}`);
  }
  return numeric;
}

/**
 * Journal bindings for a control context. Project journals are bound to their
 * root (the control directory lives inside it); global journals are bound to
 * their scope only, because a global control directory serves every project
 * root a `--global` command may be invoked from.
 */
function journalBindings(controlContext) {
  return controlContext.scope === "project"
    ? { root: controlContext.root, scope: "project" }
    : { scope: "global" };
}

function invalidJournalError(requirement) {
  const code = JOURNAL_CODES.has(requirement?.code) ? requirement.code : JOURNAL_ERROR_CODES.JOURNAL_INVALID;
  return new JournalError(code, requirement?.message ?? "the transaction journal cannot be trusted");
}

function recoveryRequiredError(requirement) {
  const kind = typeof requirement?.kind === "string" ? requirement.kind : "transaction";
  return new RecoveryRequiredError(
    `A pending ${kind} transaction must be recovered before this command can run; run skill-router recover`,
    { transactionId: requirement?.transactionId, kind: requirement?.kind },
  );
}

function foreignControl(message, paths) {
  return new MutationLockError(LOCK_ERROR_CODES.LOCK_FOREIGN, `control context at ${paths.controlDirectory} is foreign: ${message}`, {
    lockPath: paths.controlDirectory,
  });
}

/**
 * Refuses when the resolved control context and the full context built under
 * the lease disagree — a configuration or root change would otherwise move the
 * operation onto a different lock key than the one this run is holding.
 * Exported so the drift refusal itself can be asserted directly.
 */
export function assertControlContext(controlContext, context, paths) {
  if (context.root !== controlContext.root) {
    throw foreignControl(
      `the router root changed while the lock was held (expected ${controlContext.root}, found ${context.root})`,
      paths,
    );
  }
  if (Boolean(context.global) !== Boolean(controlContext.global)) {
    throw foreignControl(`the router scope changed while the lock was held`, paths);
  }
  const expected = controlContext.global
    ? controlPaths({ home: homeDirectory(), global: true })
    : controlPaths({ root: context.root });
  if (expected.controlDirectory !== paths.controlDirectory) {
    throw foreignControl(`the control directory changed while the lock was held`, paths);
  }
}

/** Control directories (and their missing parents) this run creates itself. */
// R1: control directories (and parents) created by this run are left in
// place — empty, owner-private, and inert. No automatic removal runs at the
// end of a run, so no directory is ever removed by path. Lock and anchor
// behaviour is unchanged; the attributed anchor drop still runs on failure.

/**
 * Undo an anchor this run created when nothing needs it any more: a failed
 * operation (or a recovery that finished the only journal) leaves the
 * installation exactly as it was, while an existing anchor or any pending
 * journal keeps its anchor. Removal is best effort and exact — only this
 * run's own, still-valid `control.json`.
 */
/**
 * Undo an anchor this run created when nothing needs it any more: a failed
 * operation (or a recovery that finished the only journal) leaves the
 * installation exactly as it was, while an existing anchor or any pending
 * journal keeps its anchor. Removal is best effort and exact: the anchor is
 * attributed to *this* entry around its validation - its strong identity is
 * observed immediately before the validation read and proved unchanged
 * immediately after - and `durableUnlink` then requires that exact identity
 * again, so a replacement that appears anywhere around (or after) the
 * validation is never removed and simply survives as valid control data.
 */
async function dropCreatedAnchor({ controlContext, created }) {
  if (!created) return;
  const paths = controlContext.paths;
  try {
    const requirement = await inspectRecoveryRequirement({
      paths,
      ...journalBindings(controlContext),
    });
    if (requirement.status === "pending") return;

    // Attribute the exact validated anchor (B1): one identity observation
    // before the validation read and one after it, which must agree and be
    // strong before any deletion can be attributed to this entry. Both go
    // through the durable-fs observation seam so the attribution window is
    // deterministically testable.
    let before;
    try {
      before = await durableFsInternals.lstat(paths.controlFile);
    } catch (error) {
      if (error && error.code === "ENOENT") return;
      throw error;
    }
    if (before.isSymbolicLink() || !before.isFile()) return;

    const anchor = await readControlAnchor(paths, {
      scope: controlContext.scope,
      root: controlContext.anchorRoot,
    });
    if (!anchor) return;

    const after = await durableFsInternals.lstat(paths.controlFile);
    const identity = fileIdentity(after);
    if (
      after.isSymbolicLink()
      || !after.isFile()
      || !isIdentityAvailable(identity)
      || !identitiesEqual(identity, fileIdentity(before))
    ) {
      // The entry changed around its validation: it is no longer the anchor
      // this run created or validated, so it is preserved untouched.
      return;
    }

    // Attributed removal: the first observation and every claim check inside
    // durableUnlink must still match this exact identity, so a replacement
    // that appears between the validation and here survives byte-identical.
    await durableUnlink(paths.controlFile, identity);
  } catch {
    // Best effort: a leftover anchor is valid control data, never a hazard.
  }
}

async function acquire(controlContext, timeoutMs) {
  return acquireMutationLock(controlContext.paths, { timeoutMs });
}

/**
 * Run one mutating command under the mutation lease.
 *
 * - Non-dry runs first inspect the journal strictly bound to this control
 *   context, then validate the existing control anchor (or create one only
 *   when that pending journal has proven the root/scope/control binding it
 *   would record, exactly like explicit `recover`). Only then does the
 *   automatic recovery run — so a foreign anchor fails closed before any
 *   state, configuration, or Claude mutation — and afterwards a fresh
 *   location establishes its anchor for the actual mutation. A malformed
 *   journal fails closed with its stable journal code.
 * - Dry runs never recover: a pending journal raises `RECOVERY_REQUIRED`, a
 *   malformed journal raises its stable journal code, and no anchor or journal
 *   is ever created.
 * - The lease is asserted before the result is returned and released in
 *   `finally`; a control directory or missing parent created by the run is
 *   intentionally left owner-private and inert rather than removed by path.
 */
export async function runControlledMutation({ command, options = {}, operation } = {}) {
  // Phase 14 platform boundary: an unsupported runtime (win32) is refused as
  // the very first statement, before the control context is resolved and long
  // before any mkdir, chmod, lock, journal, claim, anchor, or write.
  assertSupportedRuntimePlatform();
  if (typeof command !== "string" || command === "") throw new TypeError("runControlledMutation requires a command");
  if (typeof operation !== "function") throw new TypeError("runControlledMutation requires an operation");
  const dryRun = options.dryRun === true;
  const timeoutMs = normalizeLockTimeout(options.lockTimeout, MUTATION_LOCK_TIMEOUT_MS);
  const controlContext = await resolveControlContext(options);
  const paths = controlContext.paths;
  let lease = null;
  let primaryError = null;
  let anchorCreated = false;
  try {
    lease = await acquire(controlContext, timeoutMs);
    const bindings = journalBindings(controlContext);
    if (dryRun) {
      const requirement = await inspectRecoveryRequirement({ paths, ...bindings });
      if (requirement.status === "invalid") throw invalidJournalError(requirement);
      if (requirement.status === "pending") throw recoveryRequiredError(requirement);
      await readControlAnchor(paths, { scope: controlContext.scope, root: controlContext.anchorRoot });
    } else {
      // Strict bound inspection first: it proves the journal belongs to this
      // root/scope/control directory (or fails closed), which is the proof a
      // missing anchor needs before it may be created for a pending journal.
      const requirement = await inspectRecoveryRequirement({ paths, ...bindings });
      if (requirement.status === "invalid") throw invalidJournalError(requirement);

      // Validate-or-prove the anchor *before* recovery can mutate anything.
      // An existing anchor must already be exactly ours; it is never
      // overwritten or replaced from journal content. Creation races keep the
      // exclusive-create + read-back behaviour of `ensureControlAnchor`.
      let anchor = await ensureControlAnchor({
        paths,
        scope: controlContext.scope,
        root: controlContext.anchorRoot,
        allowCreate: requirement.status === "pending",
      });
      anchorCreated = anchor.created;

      // Automatic recovery runs only after that validation/proof.
      await recoverPendingTransaction({
        paths,
        lease,
        ...bindings,
        claudeExec: options.claudeExec,
        claudeEnv: options.claudeEnv,
      });

      if (!anchor.present) {
        // Fresh location with nothing pending: establish the anchor for this
        // actual mutation (and keep the failed-run cleanup contract).
        anchor = await ensureControlAnchor({
          paths,
          scope: controlContext.scope,
          root: controlContext.anchorRoot,
          allowCreate: true,
        });
        anchorCreated = anchorCreated || anchor.created;
      }
    }
    const context = await createContext(options, { controlContext });
    assertControlContext(controlContext, context, paths);
    const result = await operation({ command, options, context, controlContext, paths, lease, dryRun });
    await lease.assertHeld();
    return result;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      if (lease) await lease.release();
    } catch (releaseError) {
      if (!primaryError) throw releaseError;
    } finally {
      if (primaryError) await dropCreatedAnchor({ controlContext, created: anchorCreated });
    }
  }
}

/**
 * Run one read-only command under the same lease, with the read timeout
 * (2s unless `options.lockTimeout` says otherwise) and **no** automatic
 * recovery. A valid pending journal raises `RECOVERY_REQUIRED` (or is handed
 * to `onPending`, which is how `check` reports it as an unhealthy result), a
 * malformed journal raises its stable journal code (or `onInvalid`), and a
 * live lock waits and then raises `MUTATION_LOCKED` (or `onLockTimeout`, which
 * is how `check` reports a `mutation-locked` diagnostic). The lease is held for
 * the entire read, including request-file consumption.
 */
export async function runControlledRead({ command, options = {}, operation, onPending, onInvalid, onLockTimeout } = {}) {
  // Phase 14 platform boundary: refused before the lock, journal inspection,
  // anchor read, or (for `route --request-token`) any request-spool
  // consumption can touch the filesystem.
  assertSupportedRuntimePlatform();
  if (typeof command !== "string" || command === "") throw new TypeError("runControlledRead requires a command");
  if (typeof operation !== "function") throw new TypeError("runControlledRead requires an operation");
  const timeoutMs = normalizeLockTimeout(options.lockTimeout, READ_LOCK_TIMEOUT_MS);
  const controlContext = await resolveControlContext(options);
  const paths = controlContext.paths;
  let lease = null;
  let primaryError = null;
  try {
    try {
      lease = await acquire(controlContext, timeoutMs);
    } catch (error) {
      if (onLockTimeout && error instanceof MutationLockError && error.code === LOCK_ERROR_CODES.MUTATION_LOCKED) {
        return await onLockTimeout({ error, controlContext, paths });
      }
      throw error;
    }
    const bindings = journalBindings(controlContext);
    const requirement = await inspectRecoveryRequirement({ paths, ...bindings });
    if (requirement.status === "invalid") {
      if (onInvalid) return await onInvalid({ requirement, controlContext, paths });
      throw invalidJournalError(requirement);
    }
    if (requirement.status === "pending") {
      if (onPending) return await onPending({ requirement, controlContext, paths });
      throw recoveryRequiredError(requirement);
    }
    // Reads never create an anchor, but a present one must still be ours.
    await readControlAnchor(paths, { scope: controlContext.scope, root: controlContext.anchorRoot });
    const context = await createContext(options, { controlContext });
    assertControlContext(controlContext, context, paths);
    const result = await operation({ command, options, context, controlContext, paths, lease, requirement });
    await lease.assertHeld();
    return result;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      if (lease) await lease.release();
    } catch (releaseError) {
      if (!primaryError) throw releaseError;
    } finally {
    }
  }
}

/**
 * `skill-router recover`: acquire the lease, validate an existing anchor (or
 * create the one a pending journal needs to stay bound), run only
 * `recoverPendingTransaction`, and release. No normal mutation happens here,
 * so a clean recovery never leaves an anchor, journal, or control directory
 * behind on a fresh location.
 *
 * Returns the bounded recovery result plus `command: 'recover'`.
 */
export async function runRecoveryOperation({ command = "recover", options = {} } = {}) {
  // Phase 14 platform boundary: recovery is refused before the lock, journal,
  // anchor, or any artifact it could claim or delete.
  assertSupportedRuntimePlatform();
  const timeoutMs = normalizeLockTimeout(options.lockTimeout, MUTATION_LOCK_TIMEOUT_MS);
  const controlContext = await resolveControlContext(options);
  const paths = controlContext.paths;
  let lease = null;
  let primaryError = null;
  let anchorCreated = false;
  try {
    lease = await acquire(controlContext, timeoutMs);
    const bindings = journalBindings(controlContext);
    const requirement = await inspectRecoveryRequirement({ paths, ...bindings });
    if (requirement.status === "invalid") throw invalidJournalError(requirement);
    const anchor = await ensureControlAnchor({
      paths,
      scope: controlContext.scope,
      root: controlContext.anchorRoot,
      allowCreate: requirement.status === "pending",
    });
    anchorCreated = anchor.created;
    const recovery = await recoverPendingTransaction({
      paths,
      lease,
      ...bindings,
      claudeExec: options.claudeExec,
      claudeEnv: options.claudeEnv,
    });
    await lease.assertHeld();
    const result = { command, status: recovery.status };
    for (const key of ["transactionId", "kind", "outcome", "conflicts"]) {
      if (recovery[key] !== undefined) result[key] = recovery[key];
    }
    return result;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      if (lease) await lease.release();
    } catch (releaseError) {
      if (!primaryError) throw releaseError;
    } finally {
      // A recovery that consumed the only journal leaves a location that never
      // had an anchor looking exactly as it did before.
      await dropCreatedAnchor({ controlContext, created: anchorCreated });
    }
  }
}
