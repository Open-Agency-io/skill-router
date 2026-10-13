// Typed crash-recovery machine for Phase 6 journaled transactions.
//
// The journal's phase is a hint; observed endpoints are the authority. This
// module owns the two decisions every recovery makes:
//
//   - managed regeneration rolls forward only once the desired canonical state
//     is proven (canonical tree digest equals the recorded staged digest and
//     the stage directory is gone); before that it rolls back. A journal that
//     is already in `rollback` or `committed` mode always wins.
//   - removal commits only when the canonical state is absent while the exact
//     recorded backup is present (or the reverse means rollback); anything
//     else is `RECOVERY_AMBIGUOUS` and is left untouched.
//
// Everything here is idempotent and re-enterable: each durable step is
// observed before it acts, every recovery mutation is preceded by a journal
// update, and foreign/conflict artifacts raise a stable journal error without
// a destructive guess. File identity is the centralized tagged semantic from
// `src/durable-fs.js`: an artifact or claim that carries no strong, available
// identity - including a zero/invalid identity recorded by an old journal -
// is never a cleanup match and is never renamed-into-deletion or removed.
// Claude state is reconstructed only from the exact
// canonical/backup generated state and its installation metadata - never from
// original skill sources - through the Phase 5 observation, classification,
// registration, detach, and compensation seams.
import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  claimPathFor,
  classifyJournalFile,
  classifyJournalFileEntry,
  cleanupPayloads,
  cleanupPayloadTransients,
  JOURNAL_ERROR_CODES,
  JOURNAL_TERMINAL_PHASES,
  JournalError,
  MAX_CLAUDE_ACTIONS,
  readJournal,
  readPayload,
  removeJournal,
  updateJournal,
} from "./journal.js";
import {
  DEFAULT_MAX_FILE_BYTES,
  durableAtomicWrite,
  durableCreateFile,
  durableRename,
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
import { readInstallation } from "./installation.js";
import {
  classifyClaudeUninstallState,
  claudeRegistrationPlan,
  compensateClaude,
  observeClaudeUninstallState,
  registerClaude,
} from "./claude.js";

/* ------------------------------------------------------------------ *
 * Errors and the shared step seam
 * ------------------------------------------------------------------ */

const invalid = (message, details) => new JournalError(JOURNAL_ERROR_CODES.JOURNAL_INVALID, message, details);
const conflict = (message, details) => new JournalError(JOURNAL_ERROR_CODES.RECOVERY_CONFLICT, message, details);
const ambiguous = (message, details) => new JournalError(JOURNAL_ERROR_CODES.RECOVERY_AMBIGUOUS, message, details);

// Two verified cleaners may race the same artifact tree. The winner's
// progress is made of durable writes and directory fsyncs, each of which can
// take a long time on slow (network-backed CI) storage, so the loser's
// cooperative re-inspect windows below span several seconds rather than a few
// hundred milliseconds before a rival converges or a claim is called foreign.
// Every window stays bounded and fail-closed: an unattributed or
// mismatching claim is still refused, only after the wait.
const CONCURRENT_CLEANUP_WAIT_ATTEMPTS = 200;
const CONCURRENT_CLEANUP_WAIT_POLL_MS = 25;

const CONTROL_CHARACTERS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  "g",
);

function sanitizeText(value, limit) {
  return String(value).replace(CONTROL_CHARACTERS, " ").slice(0, limit);
}

function sanitizeCode(value) {
  const cleaned = String(value).replace(/[^\w.-]/g, "").slice(0, 64);
  return cleaned || "JOURNAL_FAILED";
}

/**
 * Narrow fault-injection seam shared by the journaled executors in
 * `src/transaction.js` and this recovery machine. It is awaited immediately
 * *before* each durable step, so a test (or a fixture process) can throw or
 * die at every journal, payload, stage, rename, file, Claude, verification,
 * commit, cleanup, rollback, and compensation point. Production code treats it
 * as a no-op.
 */
export const journaledTransactionInternals = {
  async onStep(step, context) {},
  // Injection seams so tests can reproduce rename and cleanup failures in the
  // journaled path exactly as they do in the legacy transactions.
  rename: durableRename,
  // Dedicated seam for the claim-protocol renames (container moves, deletion
  // moves, re-claims), so state-rename fault injection never intercepts the
  // claim machinery and vice versa.
  claimRename: durableRename,
  // Narrow seam for the claim-creation proof observation, so tests can
  // exercise the unprovable-container refusal deterministically.
  claimLstat: (target) => fsp.lstat(target),
  rm: async (target, options) => fsp.rm(target, options),
};

async function step(name, context) {
  await journaledTransactionInternals.onStep(name, context ?? {});
}

/* ------------------------------------------------------------------ *
 * Read-only inspection
 * ------------------------------------------------------------------ */

/**
 * Read-only recovery requirement. Never mutates anything and never throws for
 * a journal problem:
 *
 *   - `{status:'absent'}`  - no journal exists for these control paths,
 *   - `{status:'pending'}` - a valid journal exists (with its identity),
 *   - `{status:'invalid'}` - the journal exists but cannot be trusted
 *     (malformed, wrong type, wrong owner/mode, unbound to this context).
 *
 * A TypeError for a malformed API call (missing paths) still throws.
 */
export async function inspectRecoveryRequirement(options = {}) {
  const { paths, bindings } = normalizeInspectionOptions(options);
  try {
    const document = await readJournal(paths, { allowMissing: true, ...bindings });
    if (document === null) return Object.freeze({ status: "absent" });
    return Object.freeze({
      status: "pending",
      transactionId: document.transactionId,
      kind: document.kind,
      command: document.command,
      mode: document.mode,
      phase: document.phase,
      scope: document.scope,
      root: document.root,
      stateDirectory: document.stateDirectory,
    });
  } catch (error) {
    if (error instanceof JournalError) {
      return Object.freeze({ status: "invalid", code: error.code, message: sanitizeText(error.message, 400) });
    }
    throw error;
  }
}

function normalizeInspectionOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("recovery inspection requires an options object");
  }
  const paths = options.paths;
  if (!paths || typeof paths !== "object") throw new TypeError("recovery inspection requires control paths");
  return { paths, bindings: bindingFrom(options) };
}

function bindingFrom(options) {
  const bindings = {};
  if (typeof options.root === "string" && options.root !== "") bindings.root = path.resolve(options.root);
  if (typeof options.stateDirectory === "string" && options.stateDirectory !== "") {
    bindings.stateDirectory = path.resolve(options.stateDirectory);
  }
  if (options.scope !== undefined && options.scope !== null && options.scope !== "") bindings.scope = options.scope;
  if (typeof options.transactionId === "string" && options.transactionId !== "") {
    bindings.transactionId = options.transactionId;
  }
  return bindings;
}

/* ------------------------------------------------------------------ *
 * Recovery entry point
 * ------------------------------------------------------------------ */

/**
 * Recovers a pending journal under a held mutation lease and removes it.
 *
 * Inputs: `paths` and a held `lease` are required; `root`, `scope`, and
 * `stateDirectory` are read from the journal itself and, when supplied, must
 * match it (a mismatch fails closed as JOURNAL_INVALID). `claudeExec`,
 * `claudeEnv`, and `cwd` (defaulting to the journal root) are the Claude
 * observer context used whenever the journal records a Claude section.
 *
 * Returns a bounded result: `{status:'clean'}` when no journal exists, or
 * `{status:'recovered', transactionId, kind, outcome[, conflicts]}` where
 * `outcome` is `committed` or `rolled-back` and `conflicts` (only when
 * non-empty) lists the exact file targets whose concurrent edits were
 * preserved rather than restored. The call is idempotent: running it again
 * after success reports `clean`, and it can itself be interrupted at any step
 * and simply re-entered.
 */
export async function recoverPendingTransaction(options = {}) {
  const ctx = normalizeRecoveryContext(options);
  await ctx.lease.assertHeld();
  await step("recovery:begin", { paths: ctx.paths });

  const document = await readJournal(ctx.paths, { allowMissing: true, ...ctx.bindings });
  if (document === null) return Object.freeze({ status: "clean" });

  ctx.holder = { doc: document };
  const outcome = document.kind === "managed" ? await recoverManaged(ctx) : await recoverRemoval(ctx);
  const result = {
    status: "recovered",
    transactionId: document.transactionId,
    kind: document.kind,
    outcome,
  };
  if (ctx.conflicts && ctx.conflicts.size > 0) result.conflicts = [...ctx.conflicts];
  return Object.freeze(result);
}

function normalizeRecoveryContext(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("recoverPendingTransaction requires an options object");
  }
  const paths = options.paths;
  if (!paths || typeof paths !== "object") throw new TypeError("recoverPendingTransaction requires control paths");
  const lease = options.lease;
  if (!lease || typeof lease.assertHeld !== "function") {
    throw new TypeError("recoverPendingTransaction requires a held mutation-lock lease");
  }
  if (options.now !== undefined && typeof options.now !== "function") throw new TypeError("now must be a function");
  return {
    paths,
    lease,
    bindings: bindingFrom(options),
    claudeExec: options.claudeExec,
    claudeEnv: options.claudeEnv,
    cwd: typeof options.cwd === "string" && options.cwd !== "" ? options.cwd : undefined,
    now: options.now ?? Date.now,
    holder: null,
    conflicts: new Set(),
  };
}

/** Journal update used by recovery: phase skips and reversals are legal here. */
async function patch(ctx, document, patchValue) {
  return updateJournal(ctx.paths, document, patchValue, { lease: ctx.lease, now: ctx.now, recovery: true });
}

/* ------------------------------------------------------------------ *
 * Observation helpers
 * ------------------------------------------------------------------ */

function artifactExpectations(document) {
  const backup = document.state.backup;
  const stage = document.state.stage;
  return {
    canonicalPath: document.stateDirectory,
    before: backup ? { identity: backup.identity, digest: backup.digest } : null,
    desired:
      stage && stage.digest
        ? { ...(stage.identity ? { identity: stage.identity } : {}), digest: stage.digest }
        : null,
    backupPath: backup ? backup.path : null,
    stagePath: stage ? stage.path : null,
  };
}

/**
 * Attribution of the exact transaction-derived stage directory: absent, ours
 * (the recorded dev/ino, or an owned marker-bearing tree when the journal
 * never got to record one), or foreign. A foreign stage is never removed.
 */
async function attributeStage(document, expectations) {
  if (!expectations.stagePath) return "absent";
  const info = await inspectStateTree(expectations.stagePath);
  if (info.status === "absent") return "absent";
  if (info.status === "foreign") return "foreign";
  const recorded = document.state.stage.identity;
  if (!recorded) return "ours";
  // Recorded-but-unavailable (zero/invalid) identities never match a live
  // tree: they can only make the stage foreign, never authorize a deletion.
  if (identitiesEqual(info.identity, recorded)) return "ours";
  return "foreign";
}

/**
 * A claim is a verified cleanup copy of a recorded state artifact. It matches
 * when it still carries the recorded dev/ino identity (renames preserve it)
 * and the recorded tree digest; when the journal recorded neither, any
 * attributable owned marker tree matches - the journal crashed before it
 * could record more. In every combination the live claim must also carry a
 * strong, available identity: an artifact this filesystem cannot prove is
 * never a cleanup match and never deleted.
 */
function artifactMatchesExpectation(info, expectation) {
  if (!expectation || typeof expectation !== "object") return true;
  if (!isIdentityAvailable(info.identity)) return false;
  if (expectation.identity !== undefined && expectation.identity !== null) {
    // `identitiesEqual` also rejects a recorded zero/invalid pair, so an old
    // journal can never authorize recovery deletion through it.
    if (!identitiesEqual(info.identity, expectation.identity)) return false;
    return expectation.digest ? info.digest === expectation.digest : true;
  }
  if (expectation.digest) return info.digest === expectation.digest;
  return true;
}

/**
 * Path-race-safe removal of one transaction-owned state artifact (backup,
 * stage, or the canonical tree removed during rollback).
 *
 * The observed artifact is never recursively deleted in place and a derived
 * claim path is never rename-overwritten (B2/B3). The derived claim is an
 * exclusively created, owner-private container (`<artifact>.claim-<txid>`,
 * `mkdir` O_EXCL semantics) whose identity is proven before the artifact is
 * renamed into its absent `entry` child; a foreign file, an empty foreign
 * directory, or an unprovable container at the derived path is refused and
 * preserved. The claimed tree is verified against the recorded identity and
 * digest (type, marker, ownership, and owner-safe modes come from the strict
 * state-tree inspection), then moved to a *fresh, unpredictable* deletion
 * claim inside the proven container, reproved there, re-verified immediately
 * before removal (B1), and only then recursively removed. A crash after the
 * fresh deletion move is discoverable by its exact prefix and re-entered on
 * the next call; the bare claim shape an interrupted earlier run left behind
 * is still recognized as an exact resumable shape and never created anew. If
 * the original and its claim are both present the state is ambiguous and
 * nothing is touched; restoration after a removal failure only happens while
 * the original path is provably absent. There is no wildcard deletion
 * anywhere in this path.
 */
/**
 * Classifies a derived state-artifact claim against expectations. Only a fully
 * attributed container (B3) is ever a claim: anything else - a foreign file,
 * an empty unattributed directory, an unprovable container - is `foreign` and
 * is never removed; a container without its moved entry classifies as absent.
 */
async function classifyDerivedClaim(claimPath, expectations, binding) {
  const observed = await validateClaimContainer(claimPath, binding);
  if (observed.status === "absent" || observed.status === "record-only") return "absent";
  if (observed.status !== "ok") return "foreign";
  if (observed.movedPath === null) return "absent";
  return classifyStateArtifact(observed.movedPath, expectations);
}

/**
 * Finishes every *exposed* leftover inside an attributed container before the
 * main cleanup classifies anything (B2/B3). Deletion leftovers - `delete-*`
 * children and any attributed-unlink claim a failed removal left behind - are
 * each re-claimed to another fresh name, reproved against the recorded
 * artifact, and only then recursively removed. Anything unprovable fails
 * closed and is preserved. Returns the refreshed container observation.
 */
async function finishInterruptedContainerClaims({ lease, claimPath, expectation, transactionId, kind }) {
  const observed = await validateClaimContainer(claimPath, { transactionId, kind });
  if (observed.status === "absent") return observed;
  if (observed.status === "record-only") {
    // The container removal committed and only the external record remains:
    // consume it attributed, then the claim is fully finished.
    await consumeClaimRecord(observed.record);
    return validateClaimContainer(claimPath, { transactionId, kind });
  }
  if (observed.status !== "ok") return observed;
  const leftovers = [...observed.deletePaths, ...observed.durableClaims];
  for (const leftover of leftovers) {
    const tree = await inspectStateTree(leftover);
    if (tree.status === "absent") continue;
    // R3: a recorded recursive-deletion intent authorizes continuation of a
    // *partially removed* tree by its stable no-follow root strong identity
    // alone - the ownership marker and the original digest may already be
    // gone once the rm has started, and every re-claim moves the child to a
    // new name, so identity (never a name) is the binding. A foreign root
    // replacement (different identity) is never authorized.
    let authorizedByIntent = false;
    if (observed.record.deletion !== null && exactIdentityPair(observed.record.deletion.identity)) {
      const rootIdentity = await claimRootIdentity(leftover);
      authorizedByIntent = rootIdentity !== null && identitiesEqual(rootIdentity, observed.record.deletion.identity);
    }
    if (
      !authorizedByIntent
      && (tree.status !== "owned"
        || !isIdentityAvailable(tree.identity)
        || !artifactMatchesExpectation(tree, expectation))
    ) {
      throw conflict(`a deletion claim at ${leftover} could not be verified; it was preserved`, { path: leftover });
    }
    const preClaimRoot = await claimRootIdentity(leftover);
    if (preClaimRoot === null) {
      throw conflict(`a deletion claim at ${leftover} cannot be proven; it was preserved`, { path: leftover });
    }
    await lease.assertHeld();
    // B3: any exposed deletion leftover is re-claimed to another fresh name
    // and reproved there before the recursive removal.
    const reclaimed = path.join(claimPath, freshClaimChild("delete"));
    let renameError = null;
    try {
      await journaledTransactionInternals.claimRename(leftover, reclaimed);
    } catch (error) {
      renameError = error;
    }
    if (renameError) {
      const still = await inspectStateTree(leftover);
      if (still.status === "absent") {
        throw conflict(`the deletion claim at ${leftover} changed before it was re-claimed; it was preserved`, {
          path: leftover,
        });
      }
      throw renameError;
    }
    await syncDirectory(claimPath);
    const reclaimedRoot = await claimRootIdentity(reclaimed);
    const reprovedOk =
      reclaimedRoot !== null
      && identitiesEqual(reclaimedRoot, preClaimRoot)
      && (authorizedByIntent
        || ((await inspectStateTree(reclaimed)).status === "owned"
          && artifactMatchesExpectation(await inspectStateTree(reclaimed), expectation)));
    if (!reprovedOk) {
      throw conflict(`the re-claimed deletion claim at ${reclaimed} could not be verified; it was preserved`, {
        path: reclaimed,
      });
    }
    await lease.assertHeld();
    // R3: after EVERY deletion re-claim the intent is durably re-bound to the
    // new child name (and its stable root identity) before the recursive rm,
    // so a crash inside the rm is continued by identity on the next run.
    await rewriteClaimRecord(claimPath, { transactionId, kind }, {
      deletion: { child: path.basename(reclaimed), identity: reclaimedRoot },
    });
    try {
      await journaledTransactionInternals.rm(reclaimed, { recursive: true, force: false });
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
    await syncDirectory(claimPath);
  }
  return validateClaimContainer(claimPath, { transactionId, kind });
}

export async function cleanupStateArtifactViaClaim({ lease, artifactPath, transactionId, expectation = null, label }) {
  if (!lease || typeof lease.assertHeld !== "function") {
    throw new TypeError("cleanupStateArtifactViaClaim requires a held lease");
  }
  if (typeof artifactPath !== "string" || artifactPath === "") {
    throw new TypeError("cleanupStateArtifactViaClaim requires an artifact path");
  }
  const claimPath = claimPathFor(artifactPath, transactionId);
  if (claimPath !== claimPathFor(artifactPath, transactionId)) {
    throw new Error(`refusing to delete outside the claim namespace: ${claimPath}`);
  }
  const binding = { transactionId, kind: label };

  const inspect = async (target) => {
    const info = await inspectStateTree(target);
    if (info.status === "absent") return "absent";
    if (info.status === "foreign") return "foreign";
    return artifactMatchesExpectation(info, expectation) ? "expected" : "foreign";
  };

  // B2/B3: finish exposed deletion leftovers first - a crash after any fresh
  // deletion move is discoverable inside the attributed container and is
  // re-entered right here.
  let claimState = await finishInterruptedContainerClaims({ lease, claimPath, expectation, ...binding });

  let original = await inspect(artifactPath);
  let claimedTree = claimState.status === "ok" ? claimState.movedPath : null;
  let claimPresent = claimState.status === "foreign" || claimedTree !== null;
  if (original !== "absent" && claimPresent) {
    // Re-inspect: a concurrent verified cleaner may be mid-move; only a state
    // that stays doubled after the bounded re-inspect is ambiguous.
    for (let attempt = 0; attempt < CONCURRENT_CLEANUP_WAIT_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, CONCURRENT_CLEANUP_WAIT_POLL_MS);
      });
      original = await inspect(artifactPath);
      claimState = await validateClaimContainer(claimPath, binding);
      claimedTree = claimState.status === "ok" ? claimState.movedPath : null;
      claimPresent = claimState.status === "foreign" || claimedTree !== null;
      if (original === "absent" || !claimPresent) break;
    }
  }
  if (claimState.status === "foreign" && original === "absent") {
    throw conflict(
      `the cleanup claim at ${claimPath} could not be verified (${claimState.reason}); it was preserved`,
      { path: claimPath },
    );
  }
  if (original === "absent" && !claimPresent) {
    // An attributed container left empty by a finished cleanup is removed;
    // anything unprovable is preserved by the helper itself.
    await removeAttributedClaimContainer(claimPath, binding);
    return "absent";
  }
  if (original !== "absent" && claimPresent) {
    throw ambiguous(
      `the recorded ${label} at ${artifactPath} and its cleanup claim at ${claimPath} are both present; nothing was renamed, removed, or adopted`,
      { path: artifactPath },
    );
  }
  if (original === "foreign") {
    throw conflict(`the recorded ${label} at ${artifactPath} is not the recorded artifact`, { path: artifactPath });
  }
  if (original === "expected") {
    await step(`cleanup:${label}`, { path: artifactPath });
    await lease.assertHeld();
    // B3: the derived claim is an exclusively created, durably attributed
    // owner-private container; the artifact is renamed into a *fresh,
    // unpredictable* child, so a foreign file, an empty foreign directory, or
    // an unprovable container at the derived path is refused and preserved -
    // never overwritten.
    const created = await createAttributedClaimContainer(claimPath, binding);
    if (created.status === "exists") {
      // A concurrent verified cleaner may be creating or using this container:
      // re-inspect for a fully attributed claim before deciding. A container
      // that is gone ("absent") is terminal too — it means the concurrent
      // cleaner finished the whole removal, which is the idempotent outcome
      // this call was racing for — so the loop stops on it rather than waiting
      // out the full window and then misreporting "absent" as a conflict.
      for (let attempt = 0; attempt < CONCURRENT_CLEANUP_WAIT_ATTEMPTS; attempt += 1) {
        claimState = await validateClaimContainer(claimPath, binding);
        if (claimState.status === "ok" || claimState.status === "absent") break;
        await new Promise((resolve) => {
          setTimeout(resolve, CONCURRENT_CLEANUP_WAIT_POLL_MS);
        });
      }
      if (claimState.status === "absent") {
        // The claim container vanished while this call waited: the concurrent
        // verified cleaner completed the removal. Reconcile from the observed
        // endpoints — an absent artifact means the removal is done.
        const originalNow = await inspectStateTree(artifactPath);
        if (originalNow.status === "absent") {
          await removeAttributedClaimContainer(claimPath, binding);
          return "absent";
        }
        throw conflict(
          `the cleanup claim at ${claimPath} vanished while it was being cleaned; the ${label} at ${artifactPath} is preserved`,
          { path: claimPath },
        );
      }
      if (claimState.status !== "ok") {
        throw conflict(
          `the cleanup claim at ${claimPath} is not an attributed claim (${claimState.reason}); it was preserved`,
          { path: claimPath },
        );
      }
      if (claimState.movedPath !== null) {
        // A concurrent verified cleaner (or an interrupted earlier attempt)
        // already moved the artifact: resume from its moved entry.
        claimedTree = claimState.movedPath;
      }
      // Otherwise the container is the exact resumable crash-after-create
      // shape (durably attributed, no moved entry yet): the fresh move below
      // resumes into it.
    } else if (created.status !== "created") {
      throw conflict(`the cleanup claim at ${claimPath} could not be proven; nothing was moved`, { path: claimPath });
    }
    if (claimedTree === null) {
      const entryPath = path.join(claimPath, freshClaimChild("moved"));
      const raced = await inspect(entryPath);
      if (raced !== "absent") {
        throw conflict(`the cleanup claim at ${claimPath} already holds an entry; nothing was moved`, { path: entryPath });
      }
      // A rename that throws is reconciled from the observed endpoints: a
      // completed move is recognized and verified below; a rename that never
      // moved anything rethrows without touching the claim.
      let renameError = null;
      try {
        await journaledTransactionInternals.claimRename(artifactPath, entryPath);
      } catch (error) {
        renameError = error;
      }
      await syncDirectory(path.dirname(artifactPath));
      try {
        await syncDirectory(claimPath);
      } catch (error) {
        // The claim directory can vanish between the observation that named a
        // resumable container and this fsync: a concurrent verified cleaner
        // that owned the same claim finishes the whole removal, rmdir included.
        // That is the idempotent "absent" outcome for this race, reconciled
        // from the observed endpoints (the same idiom the rename reconciliation
        // above uses) rather than surfaced as a spurious ENOENT.
        if (error?.code === "ENOENT") {
          const originalNow = await inspectStateTree(artifactPath);
          if (originalNow.status === "absent") {
            await removeAttributedClaimContainer(claimPath, binding);
            return "absent";
          }
        }
        throw error;
      }
      if (renameError) {
        const afterOriginal = await inspectStateTree(artifactPath);
        if (afterOriginal.status !== "absent") throw renameError;
      }
      // R3: persist the child identity in the external record so re-entry
      // never has to trust a bare name or shape. A move that did not land
      // (a concurrent cleaner moved the artifact first) records nothing; the
      // verification phase below observes the actual state.
      const movedIdentity = await movedChildIdentity(entryPath);
      if (movedIdentity !== null) {
        await recordClaimChild(claimPath, binding, movedIdentity);
      }
      claimedTree = entryPath;
    }
  }

  // Verify the claimed tree - freshly moved, left behind by an interrupted
  // cleanup, or already being removed by a concurrent cleaner - against the
  // recorded identity and digest before removing it. A tree that converges to
  // absent is idempotently done; anything unprovable is preserved.
  let claimed = await inspectStateTree(claimedTree);
  if (claimed.status === "absent") {
    await removeAttributedClaimContainer(claimPath, binding);
    return "absent";
  }
  const unverified = () =>
    claimed.status !== "owned"
    || !isIdentityAvailable(claimed.identity)
    || !artifactMatchesExpectation(claimed, expectation);
  for (let attempt = 0; unverified() && attempt < CONCURRENT_CLEANUP_WAIT_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, CONCURRENT_CLEANUP_WAIT_POLL_MS);
    });
    claimed = await inspectStateTree(claimedTree);
    if (claimed.status === "absent") {
      await removeAttributedClaimContainer(claimPath, binding);
      return "absent";
    }
  }
  if (unverified()) {
    throw conflict(
      `the cleanup claim at ${claimedTree} could not be verified (${claimed.status === "foreign" ? claimed.reason : "it does not match the recorded artifact"}); it was preserved`,
      { path: claimedTree },
    );
  }
  await lease.assertHeld();

  // B2: the verified tree is never recursively deleted in place. It moves to
  // a fresh unpredictable deletion child, is reproved, re-claimed to another
  // fresh name (B3), reproved again, re-verified immediately before removal
  // (B1), and only then recursively removed. A crash after any move is
  // discoverable by the closed child grammar and re-entered above. There is
  // no rename-back restoration: a failed removal fails and preserves the
  // claim for explicit later recovery.
  const deletePath = path.join(claimPath, freshClaimChild("delete"));
  await step(`cleanup:${label}:deletion-move`, { path: deletePath });
  await lease.assertHeld();
  let deletionMoveError = null;
  try {
    await journaledTransactionInternals.claimRename(claimedTree, deletePath);
  } catch (error) {
    deletionMoveError = error;
  }
  await syncDirectory(claimPath);
  if (deletionMoveError) {
    const stillThere = await inspectStateTree(claimedTree);
    if (stillThere.status !== "absent") throw deletionMoveError;
  }
  const verifiedDeletion = (info) =>
    info.status === "owned"
    && isIdentityAvailable(info.identity)
    && artifactMatchesExpectation(info, expectation);

  let toRemove = await inspectStateTree(deletePath);
  if (toRemove.status === "absent") {
    await removeAttributedClaimContainer(claimPath, binding);
    return "removed";
  }
  if (!verifiedDeletion(toRemove)) {
    throw conflict(`the deletion claim at ${deletePath} could not be verified; it was preserved`, { path: deletePath });
  }

  // B1: re-verify immediately before the re-claim and removal.
  await step(`cleanup:${label}:recheck`, { path: deletePath });
  toRemove = await inspectStateTree(deletePath);
  if (!verifiedDeletion(toRemove)) {
    throw conflict(`the deletion claim at ${deletePath} changed before it was removed; it was preserved`, {
      path: deletePath,
    });
  }
  await lease.assertHeld();
  const finalPath = path.join(claimPath, freshClaimChild("delete"));
  let reclaimError = null;
  try {
    await journaledTransactionInternals.claimRename(deletePath, finalPath);
  } catch (error) {
    reclaimError = error;
  }
  await syncDirectory(claimPath);
  if (reclaimError) {
    const still = await inspectStateTree(deletePath);
    if (still.status === "absent") {
      throw conflict(`the deletion claim at ${deletePath} changed before it was re-claimed; it was preserved`, {
        path: deletePath,
      });
    }
    throw reclaimError;
  }
  toRemove = await inspectStateTree(finalPath);
  if (!verifiedDeletion(toRemove)) {
    throw conflict(`the re-claimed deletion claim at ${finalPath} could not be verified; it was preserved`, {
      path: finalPath,
    });
  }
  // R3: persist the recursive-deletion intent *after* the final re-claim and
  // immediately before the destructive step, bound to the new child name and
  // its stable root identity, so an interrupted partial removal is continued
  // by identity on re-entry - and a foreign root replacement is never
  // authorized.
  const finalRoot = await claimRootIdentity(finalPath);
  if (finalRoot === null || !identitiesEqual(finalRoot, toRemove.identity)) {
    throw conflict(`the re-claimed deletion claim at ${finalPath} cannot be proven; it was preserved`, {
      path: finalPath,
    });
  }
  await step(`cleanup:${label}:intent`, { path: finalPath });
  await lease.assertHeld();
  await recordClaimDeletionIntent(claimPath, binding, {
    child: path.basename(finalPath),
    identity: finalRoot,
  });
  try {
    await journaledTransactionInternals.rm(finalPath, { recursive: true, force: false });
  } catch (rmError) {
    // B3: no check-then-rename restoration. A failed removal fails and
    // preserves the re-claimed deletion claim for explicit later recovery
    // (it is re-entered by the scan at the top of this function).
    if (rmError && rmError.code === "ENOENT") {
      await syncDirectory(claimPath);
      await removeAttributedClaimContainer(claimPath, binding);
      return "removed";
    }
    throw rmError;
  }
  await syncDirectory(claimPath);
  await removeAttributedClaimContainer(claimPath, binding);
  return "removed";
}

/**
 * Runs a rename and reconciles a thrown error from the observed endpoints:
 * `done` when both endpoints prove completion, `untouched` when both prove the
 * rename never happened, otherwise `null` (ambiguous - the caller must not
 * guess).
 */
async function reconcileRename(action, observe) {
  let error = null;
  try {
    await action();
  } catch (caught) {
    error = caught;
  }
  const outcome = await observe();
  if (outcome === "done") return { completed: true, error: null };
  if (outcome === "untouched") return { completed: false, error };
  return { completed: null, error };
}

/* ------------------------------------------------------------------ *
 * File payload application and restoration
 * ------------------------------------------------------------------ */

function fileMatchesBefore(record, classification) {
  if (!record.before.exists) return classification === "absent";
  if (classification === "before") return true;
  return record.before.sha256 === record.after.sha256 && classification === "after";
}

function fileMatchesAfter(record, classification) {
  return classification === "after";
}

/* ------------------------------------------------------------------ *
 * B2 - claim-and-publish helpers (no raw rename-overwrite, ever)
 * ------------------------------------------------------------------ */

/**
 * Observes one entry for the claim/publish steps: `absent`, `not-regular`,
 * `unprovable` (no strong identity), or `ok` with its strong tagged identity.
 */
async function observeRegularFileEntry(target) {
  let stat;
  try {
    stat = await fsp.lstat(target);
  } catch (error) {
    if (error && error.code === "ENOENT") return { status: "absent" };
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return { status: "not-regular" };
  const identity = fileIdentity(stat);
  if (!isIdentityAvailable(identity)) return { status: "unprovable" };
  return { status: "ok", identity };
}

/** True only when the derived claim still holds exactly `digest` bytes. */
async function claimHoldsDigest(claimPath, digest) {
  let bytes;
  try {
    bytes = await readRegularFileNoFollow(claimPath, { maxBytes: DEFAULT_MAX_FILE_BYTES, allowMissing: true });
  } catch (error) {
    if (error && (error.code === "ELOOP" || error.code === "EFTYPE" || error.code === "EBUSY" || error.code === "EFBIG")) {
      return false;
    }
    throw error;
  }
  return bytes !== null && sha256Bytes(bytes) === digest;
}

/* ------------------------------------------------------------------ *
 * R3 - attributed claim containers with external records
 *
 * A derived claim is a container directory created exclusively (mkdir O_EXCL,
 * exact 0700) and proven owner-private with a strong identity, paired with an
 * *external sibling attribution record* (`<claim>.json`, 0600, nlink 1) that
 * survives container deletion and binds the transaction, kind, container
 * identity, moved-child identity, and recursive-deletion intent. The source is
 * renamed into a *fresh, unpredictable* child with a closed grammar
 * (`moved-<32hex>`), never a fixed name; deletion happens only at another
 * fresh name (`delete-<32hex>`), authorized by a recorded deletion intent
 * (stable root identity) when a recursive removal was interrupted, and itself
 * re-proved after a further fresh re-claim. Re-entry trusts only a valid
 * record plus its matching container and children (bounded streaming child
 * scan with a post-open identity recheck): a container without a valid record
 * - including an empty foreign lookalike - is never removed, any unprovable or
 * foreign-shaped container is preserved and fails closed, and every removal is
 * identity-bound; unavailable identities are never removed. The external
 * record outlives the container and is consumed only after the container
 * rmdir commits.
 *
 * Residual trust boundary (documented, not claimable away): this defends
 * ordinary concurrency, crashes, and persistent replacements. Node cannot
 * bind an fd to unlink(2)/rmdir(2)/rename(2), so the final pathname syscall
 * windows - and a hostile *same-UID* process racing the freshly created
 * private container between the child-absence check and the rename - are not
 * absolutely excluded; the moved child is re-proven against the classified
 * identity immediately afterwards, so such a race can never authorize a
 * deletion.
 * ------------------------------------------------------------------ */

/**
 * Publishes verified in-memory payload bytes at the target through the
 * kernel's exclusive-create primitive (`durableCreateFile`, O_CREAT|O_EXCL):
 * a replacement that appears at the target can never be overwritten, and no
 * raw rename-overwrite of the destination ever happens (B2).
 */
async function publishPayloadBytes(record, payload) {
  try {
    await durableCreateFile(record.target, payload.bytes, { mode: 0o600 });
  } catch (error) {
    if (error && error.code === "EEXIST") {
      throw conflict(`${record.target} was replaced while the payload was being written; nothing was overwritten`, {
        path: record.target,
      });
    }
    if (error && (error.code === "ELOOP" || error.code === "EFTYPE")) {
      throw conflict(`${record.target} is no longer a regular file; nothing was overwritten`, { path: record.target });
    }
    if (error && error.code === "ENOTSUP") {
      throw conflict(`${record.target} cannot be written on a filesystem without stable file identity`, {
        path: record.target,
      });
    }
    throw error;
  }
}

/**
 * Removes a proven recorded entry and only that entry: the path must still
 * resolve to the exact strong identity this call read/proved (B2/B3), so a
 * replacement that appears after the read is preserved, never deleted. An
 * already-vanished path is fine; the removal itself is claim-based (B1).
 */
async function consumeProvenEntry(entryPath, expectedIdentity) {
  const observed = await observeRegularFileEntry(entryPath);
  if (observed.status === "absent") return;
  if (observed.status !== "ok" || !identitiesEqual(observed.identity, expectedIdentity)) {
    throw conflict(`the recorded entry at ${entryPath} was replaced while it was being consumed; it was preserved`, {
      path: entryPath,
    });
  }
  try {
    await durableUnlink(entryPath, expectedIdentity);
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
}

/**
 * Exact external-record file invariants (R3/R4): mode 0600, current uid,
 * nlink 1, a strong identity that is stable across the path observation and
 * the bounded read handle, and a bounded read. Returns `{ identity, bytes }`
 * or null for any foreign/unprovable record file (never touched).
 */
async function readExternalRecordFile(recordPath) {
  let stat;
  try {
    stat = await fsp.lstat(recordPath);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return null;
  if (process.platform !== "win32") {
    if ((Number(stat.mode) & 0o777) !== 0o600) return null;
    if (typeof process.getuid === "function" && Number(stat.uid) !== process.getuid()) return null;
  }
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
  return { identity: fileIdentity(stat), bytes: read.bytes };
}

/** Exact closed identity schema: a plain {dev, ino} pair, strong. */
function exactIdentityPair(value) {
  return (
    value !== null
    && typeof value === "object"
    && Object.keys(value).sort().join(",") === "dev,ino"
    && isIdentityAvailable(value)
  );
}

/** Streaming one-entry emptiness check (never a full readdir). */
async function directoryIsEmpty(target) {
  let handle;
  try {
    handle = await fsp.opendir(target);
  } catch {
    return false;
  }
  try {
    return (await handle.read()) === null;
  } catch {
    return false;
  } finally {
    try {
      await handle.close();
    } catch {
      // Closing is best effort.
    }
  }
}

/** No-follow strong root identity of a claim child (directory or file). */
async function claimRootIdentity(target) {
  let stat;
  try {
    stat = await fsp.lstat(target);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink()) return null;
  const identity = fileIdentity(stat);
  return isIdentityAvailable(identity) ? identity : null;
}

const CLAIM_RECORD_SCHEMA = 1;
const CLAIM_CONTAINER_KINDS = new Set(["stage", "backup", "canonical", "file"]);
const CLAIM_NONCE_PATTERN = /^[0-9a-f]{32}$/;
const MOVED_PATTERN = /^moved-[0-9a-f]{32}$/;
const DELETE_PATTERN = /^delete-[0-9a-f]{32}$/;
// durableUnlink's own in-container claims (a failed attributed unlink).
const DURABLE_CLAIM_PATTERN = /^\..+\.delete-[0-9a-f]{32}$/;
// Bounded child scan: a valid container holds at most a handful of children;
// anything beyond this bound is refused rather than enumerated.
const CLAIM_CHILD_BOUND = 16;

function claimNonce() {
  return randomBytes(16).toString("hex");
}

function freshClaimChild(prefix) {
  return `${prefix}-${claimNonce()}`;
}

function claimRecordPath(containerPath) {
  return `${containerPath}.json`;
}

function serializeClaimRecord({ transactionId, kind, identity, child = null, deletion = null }) {
  const payload = {
    schema: CLAIM_RECORD_SCHEMA,
    owner: "skill-router",
    transactionId,
    kind,
    container: identityRecord(identity),
  };
  if (child !== null) payload.child = identityRecord(child);
  if (deletion !== null) {
    payload.deletion = { child: deletion.child, identity: identityRecord(deletion.identity) };
  }
  return Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
}

function claimContainerForeign(reason) {
  return { status: "foreign", reason };
}

/**
 * Strictly validates the *external* claim attribution record - a sibling file
 * that survives container deletion and binds the transaction, kind, container
 * identity, moved-child identity, and recursive-deletion intent to this claim.
 * The record itself must be a regular, owner-only (0600), current-uid,
 * single-link file with a strong identity. Returns the validated record, or
 * null (foreign/unprovable - never touched).
 */
async function readValidatedClaimRecord(recordPath, { transactionId, kind }) {
  const observed = await readExternalRecordFile(recordPath);
  if (observed === null) return null;
  const bytes = observed.bytes;
  let record;
  try {
    record = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const keys = Object.keys(record).sort();
  const base = ["container", "kind", "owner", "schema", "transactionId"];
  // `child` and `deletion` are each independently optional; when present they
  // must appear together with a closed shape (validated below).
  const expected = [...base];
  if (Object.hasOwn(record, "child")) expected.push("child");
  if (Object.hasOwn(record, "deletion")) expected.push("deletion");
  if (JSON.stringify(keys) !== JSON.stringify(expected.sort())) return null;
  if (
    record.schema !== CLAIM_RECORD_SCHEMA
    || record.owner !== "skill-router"
    || record.transactionId !== transactionId
    || record.kind !== kind
  ) {
    return null;
  }
  if (!exactIdentityPair(record.container)) return null;
  if (Object.hasOwn(record, "child")) {
    if (!exactIdentityPair(record.child)) return null;
  }
  if (Object.hasOwn(record, "deletion")) {
    const deletion = record.deletion;
    if (!deletion || typeof deletion !== "object") return null;
    if (typeof deletion.child !== "string" || !DELETE_PATTERN.test(deletion.child)) return null;
    if (!exactIdentityPair(deletion.identity)) return null;
  }
  return {
    path: recordPath,
    identity: observed.identity,
    transactionId,
    kind,
    container: record.container,
    child: Object.hasOwn(record, "child") ? record.child : null,
    deletion: Object.hasOwn(record, "deletion") ? record.deletion : null,
  };
}

/**
 * Bounded, streaming child scan of a claim container with a post-open
 * identity recheck: the scan only ever runs for the exact container that was
 * validated, and an overflow is refused rather than enumerated.
 */
async function scanClaimChildren(containerPath, expectedIdentity) {
  let handle;
  try {
    handle = await fsp.opendir(containerPath);
  } catch {
    return null;
  }
  const names = [];
  try {
    // Post-open recheck: a swap between the validated observation and the
    // open is refused before a single child name is observed.
    let reopened;
    try {
      reopened = await fsp.lstat(containerPath);
    } catch {
      return null;
    }
    if (
      reopened.isSymbolicLink()
      || !reopened.isDirectory()
      || !identitiesEqual(fileIdentity(reopened), expectedIdentity)
    ) {
      return null;
    }
    for (;;) {
      const entry = await handle.read();
      if (entry === null) break;
      names.push(entry.name);
      if (names.length > CLAIM_CHILD_BOUND) return null;
    }
  } catch {
    return null;
  } finally {
    try {
      await handle.close();
    } catch {
      // Closing is best effort.
    }
  }
  return names;
}

/** Observes the identity of a container child (a moved file or tree). */
async function movedChildIdentity(childPath) {
  let stat;
  try {
    stat = await fsp.lstat(childPath);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) return null;
  const identity = fileIdentity(stat);
  return isIdentityAvailable(identity) ? identity : null;
}

/**
 * Validates one claim in full: the external attribution record (bound to this
 * transaction/kind and to the container's own recorded identity), an
 * exact-0700 owner-private container directory whose identity matches the
 * record, only closed-grammar children (bounded streaming scan), and - when
 * recorded - a moved child whose identity matches the record. Returns
 * `{status:"absent"|"record-only"|"foreign"|"ok"}`.
 */
async function validateClaimContainer(containerPath, { transactionId, kind }) {
  if (!CLAIM_CONTAINER_KINDS.has(kind)) throw new TypeError(`unsupported claim container kind: ${String(kind)}`);
  const record = await readValidatedClaimRecord(claimRecordPath(containerPath), { transactionId, kind });
  let stat;
  try {
    stat = await fsp.lstat(containerPath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      // No container: either nothing happened, or the container removal
      // committed and only the (still-authorizing) record remains.
      return record === null ? { status: "absent" } : { status: "record-only", record };
    }
    throw error;
  }
  if (record === null) {
    return claimContainerForeign("the claim attribution record is missing or invalid");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return claimContainerForeign("the claim is not a real directory");
  if (!isIdentityAvailable(fileIdentity(stat))) return claimContainerForeign("the claim identity cannot be proven");
  if (process.platform !== "win32") {
    if ((Number(stat.mode) & 0o777) !== 0o700) return claimContainerForeign("the claim is not exactly 0700");
    if (typeof process.getuid === "function" && Number(stat.uid) !== process.getuid()) {
      return claimContainerForeign("the claim is not owned by the current user");
    }
  }
  if (!identitiesEqual(fileIdentity(stat), record.container)) {
    return claimContainerForeign("the claim container identity does not match its record");
  }
  const children = await scanClaimChildren(containerPath, fileIdentity(stat));
  if (children === null) return claimContainerForeign("the claim is unreadable");
  const moved = [];
  const deletePaths = [];
  const durableClaims = [];
  for (const name of children) {
    if (MOVED_PATTERN.test(name)) moved.push(path.join(containerPath, name));
    else if (DELETE_PATTERN.test(name)) deletePaths.push(path.join(containerPath, name));
    else if (DURABLE_CLAIM_PATTERN.test(name)) durableClaims.push(path.join(containerPath, name));
    else return claimContainerForeign("the claim holds an unattributable entry");
  }
  if (moved.length > 1) return claimContainerForeign("the claim holds more than one moved entry");
  const movedPath = moved.length === 1 ? moved[0] : null;
  if (record.child !== null) {
    if (movedPath !== null) {
      const childIdentity = await movedChildIdentity(movedPath);
      if (childIdentity === null || !identitiesEqual(childIdentity, record.child)) {
        return claimContainerForeign("the claim child identity does not match its record");
      }
    }
    // A recorded child that is *absent* is the legitimate post-consumption
    // state (it was renamed into a deletion claim or removed through an
    // attributed unlink): the record remains the authorizing attribution and
    // is re-checked at every point of use.
  } else if (movedPath !== null) {
    return claimContainerForeign("the claim holds a child without a recorded identity");
  }
  return { status: "ok", identity: fileIdentity(stat), record, movedPath, deletePaths, durableClaims };
}

/**
 * Exclusive creation of an attributed claim (R3): the container directory is
 * created with mkdir O_EXCL (exact 0700), proven owner-private with a strong
 * identity, and the *external* sibling attribution record - binding the
 * transaction, kind, and the container identity - is durably written before
 * anything may be moved inside. An existing path returns `exists` (never
 * overwritten); an unprovable leftover is preserved.
 */
async function createAttributedClaimContainer(containerPath, { transactionId, kind }) {
  if (!CLAIM_CONTAINER_KINDS.has(kind)) throw new TypeError(`unsupported claim container kind: ${String(kind)}`);
  try {
    await fsp.mkdir(containerPath, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (!error || error.code !== "EEXIST") throw error;
    return { status: "exists" };
  }
  let stat;
  try {
    stat = await journaledTransactionInternals.claimLstat(containerPath);
  } catch (error) {
    if (error && error.code === "ENOENT") return { status: "unprovable" };
    throw error;
  }
  const proven =
    !stat.isSymbolicLink()
    && stat.isDirectory()
    && isIdentityAvailable(fileIdentity(stat))
    && (process.platform === "win32" || ((Number(stat.mode) & 0o777) === 0o700
      && (typeof process.getuid !== "function" || Number(stat.uid) === process.getuid())));
  if (!proven) {
    // R5 fix: an unprovable container is *preserved* exactly as it stands -
    // this function performs no rmdir at all, ever. It fails closed at every
    // later validation and needs explicit manual recovery.
    return { status: "unprovable" };
  }
  try {
    await durableCreateFile(
      claimRecordPath(containerPath),
      serializeClaimRecord({ transactionId, kind, identity: fileIdentity(stat) }),
      { mode: 0o600 },
    );
  } catch (error) {
    // The container is still empty (the exclusive record create failed) and
    // is preserved untouched; surface the error.
    throw error;
  }
  await syncDirectory(path.dirname(containerPath));
  return { status: "created", identity: fileIdentity(stat) };
}

/**
 * CAS-bound rewrite of an external claim record (R3): the record is validated,
 * its identity is re-proven immediately before the atomic rewrite (a replaced
 * record is never overwritten), and the rewritten record must validate afresh
 * afterwards. A malicious final-pathname race on the record file itself is the
 * documented residual (excluded by threat model, like every Node pathname
 * syscall window).
 */
async function rewriteClaimRecord(containerPath, binding, fields) {
  const recordPath = claimRecordPath(containerPath);
  const record = await readValidatedClaimRecord(recordPath, binding);
  if (record === null) {
    throw conflict(`the claim attribution record at ${recordPath} cannot be verified; it was preserved`, {
      path: recordPath,
    });
  }
  let stat;
  try {
    stat = await fsp.lstat(recordPath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw conflict(`the claim attribution record at ${recordPath} vanished; the claim was preserved`, {
        path: recordPath,
      });
    }
    throw error;
  }
  if (!identitiesEqual(fileIdentity(stat), record.identity)) {
    throw conflict(`the claim attribution record at ${recordPath} changed before it was updated; it was preserved`, {
      path: recordPath,
    });
  }
  await durableAtomicWrite(
    recordPath,
    serializeClaimRecord({
      transactionId: binding.transactionId,
      kind: binding.kind,
      identity: record.container,
      child: Object.hasOwn(fields, "child") ? fields.child : record.child,
      deletion: Object.hasOwn(fields, "deletion") ? fields.deletion : record.deletion,
    }),
    { mode: 0o600 },
  );
  await syncDirectory(path.dirname(recordPath));
  // Post-check: the rewritten record must validate afresh.
  const after = await readValidatedClaimRecord(recordPath, binding);
  if (after === null) {
    throw conflict(`the claim attribution record at ${recordPath} could not be re-validated after the update; it was preserved`, {
      path: recordPath,
    });
  }
  return after;
}

/** Durably records the moved child's identity in the external record. */
async function recordClaimChild(containerPath, binding, childIdentity) {
  await rewriteClaimRecord(containerPath, binding, { child: childIdentity });
}

/** Durably records the recursive-deletion intent (root identity) in the record. */
async function recordClaimDeletionIntent(containerPath, binding, deletion) {
  await rewriteClaimRecord(containerPath, binding, { deletion });
}

/**
 * Terminal consumption of a validated external record: an immediate identity
 * reproof (exact invariants: 0600, uid, nlink 1, stable strong identity)
 * followed by the *direct* unlink of that one recorded path and a parent
 * fsync. Terminal records are consumed only after their claim has committed,
 * so no hidden claim is created and a crash before the unlink is simply
 * re-entered by the record-only path. Residual (documented, excluded by
 * threat model): the final pathname syscall window of this direct unlink.
 */
async function consumeExternalRecordDirect(record) {
  const observed = await readExternalRecordFile(record.path);
  if (observed === null || !identitiesEqual(observed.identity, record.identity)) return false;
  try {
    await fsp.unlink(record.path);
  } catch {
    return false;
  }
  await syncDirectory(path.dirname(record.path));
  return true;
}

/** Attributed removal of a validated external claim record (itself re-proven). */
async function consumeClaimRecord(record) {
  // Revalidate every record invariant immediately before the terminal
  // removal (R3): exact 0600, current uid, nlink 1, same strong identity.
  return consumeExternalRecordDirect(record);
}

/**
 * Removes an attributed claim - and only one. Everything inside must already
 * be consumed; the container is removed with a non-recursive rmdir and only
 * then is the external record consumed by an attributed removal (the record
 * outlives the container, so a crash between the two resumes). Foreign,
 * unprovable, or non-empty claims are preserved and reported as not removed.
 */
async function removeAttributedClaimContainer(containerPath, { transactionId, kind }) {
  const observed = await validateClaimContainer(containerPath, { transactionId, kind });
  if (observed.status === "record-only") {
    return consumeClaimRecord(observed.record);
  }
  if (observed.status !== "ok") return false;
  if (observed.movedPath !== null || observed.deletePaths.length > 0 || observed.durableClaims.length > 0) {
    return false;
  }
  // Never rmdir an unprovable container (defensive: status "ok" already
  // guarantees a strong, recorded identity).
  if (!isIdentityAvailable(observed.identity)) return false;
  try {
    await fsp.rmdir(containerPath);
  } catch {
    return false;
  }
  await syncDirectory(path.dirname(containerPath));
  return consumeClaimRecord(observed.record);
}

/**
 * Locates (or refuses) the moved file entry inside an attributed container.
 * Only a fully attributed container with exactly one moved child can hold a
 * claim entry; anything else is surfaced as `absent` (nothing to resume) or
 * `foreign` (preserved, never touched).
 */
async function locateFileClaimEntry(containerPath, transactionId) {
  const observed = await validateClaimContainer(containerPath, { transactionId, kind: "file" });
  if (observed.status === "absent") {
    return { entryPath: null, observed: { status: "absent" }, container: null };
  }
  if (observed.status !== "ok") {
    return { entryPath: null, observed: { status: "foreign", reason: observed.reason }, container: null };
  }
  if (observed.movedPath === null) {
    return { entryPath: null, observed: { status: "absent" }, container: observed };
  }
  return {
    entryPath: observed.movedPath,
    observed: await observeRegularFileEntry(observed.movedPath),
    container: observed,
  };
}

/**
 * Moves the exact current target aside into its durably attributed claim
 * container (B3): the container is created exclusively and attributed before
 * the rename into a fresh unpredictable `moved-*` child, and the claimed
 * entry is re-proven against the classified identity. Anything already at the
 * derived path - a foreign file, an empty foreign directory, an unprovable or
 * wrongly-attributed container - is refused and preserved, never overwritten.
 */
async function moveClassifiedEntryAside(record, document, classified) {
  const containerPath = claimPathFor(record.target, document.transactionId);
  const binding = { transactionId: document.transactionId, kind: "file" };
  const created = await createAttributedClaimContainer(containerPath, binding);
  let entryPath;
  if (created.status === "exists") {
    const observed = await validateClaimContainer(containerPath, binding);
    if (observed.status !== "ok" || observed.movedPath !== null) {
      throw conflict(`the cleanup claim at ${containerPath} already exists; nothing was touched`, {
        path: containerPath,
      });
    }
    entryPath = path.join(containerPath, freshClaimChild("moved"));
  } else if (created.status === "created") {
    entryPath = path.join(containerPath, freshClaimChild("moved"));
  } else {
    throw conflict(`the cleanup claim at ${containerPath} could not be proven; nothing was touched`, {
      path: containerPath,
    });
  }
  const raced = await observeRegularFileEntry(entryPath);
  if (raced.status !== "absent") {
    throw conflict(`the cleanup claim at ${containerPath} already holds an entry; nothing was touched`, {
      path: entryPath,
    });
  }
  await journaledTransactionInternals.claimRename(record.target, entryPath);
  const claimed = await observeRegularFileEntry(entryPath);
  if (claimed.status !== "ok" || !identitiesEqual(claimed.identity, classified.identity)) {
    throw conflict(
      `the entry moved aside for ${record.target} is not the entry that was classified; it was preserved at its cleanup claim`,
      { path: entryPath },
    );
  }
  // R3: persist the child identity in the external record so re-entry never
  // has to trust a bare name or shape.
  await recordClaimChild(containerPath, binding, claimed.identity);
  await syncDirectory(path.dirname(record.target));
  await syncDirectory(containerPath);
  return { claimPath: containerPath, entryPath, identity: claimed.identity, shape: "container" };
}

/**
 * Finishes an interrupted apply/restore: a moved entry - or an
 * attributed-unlink claim left by a failed consumption - inside the durably
 * attributed container is removed only while it still holds exactly the
 * digest the journal recorded; then the emptied proven container is dropped.
 * Anything else is preserved without failing the already-proven outcome.
 */
async function finishInterruptedClaim(record, document, expectedDigest) {
  const containerPath = claimPathFor(record.target, document.transactionId);
  const binding = { transactionId: document.transactionId, kind: "file" };
  const containerState = await validateClaimContainer(containerPath, binding);
  if (containerState.status === "record-only") {
    await consumeClaimRecord(containerState.record);
    return true;
  }
  if (containerState.status === "foreign") return false;
  const located = await locateFileClaimEntry(containerPath, document.transactionId);
  if (located.observed.status === "foreign") return false;
  let consumed = false;
  if (located.observed.status === "ok" && (await claimHoldsDigest(located.entryPath, expectedDigest))) {
    await consumeProvenEntry(located.entryPath, located.observed.identity);
    consumed = true;
  }
  if (located.container) {
    for (const claimFile of located.container.durableClaims) {
      if (!(await claimHoldsDigest(claimFile, expectedDigest))) continue;
      const claimEntry = await observeRegularFileEntry(claimFile);
      if (claimEntry.status !== "ok") continue;
      await consumeProvenEntry(claimFile, claimEntry.identity);
      consumed = true;
    }
  }
  if (consumed) {
    await removeAttributedClaimContainer(containerPath, binding);
    await syncDirectory(path.dirname(record.target));
  }
  return consumed;
}

/**
 * Applies one journaled file record without ever renaming over the target
 * (B2). The exact `after` payload is read once - digest-verified, with its
 * strong identity carried through application - the target is CAS-checked
 * against the planned `before` state (an interrupted earlier attempt resumes
 * from its derived claim), the classified prior entry is moved aside to that
 * claim and re-proven there, and the verified payload bytes are published at
 * the target through an exclusive create. The payload is never a rename source:
 * a swap of the payload or a replacement of the target immediately before the
 * publish fails closed and preserves everything. No journal update happens
 * here - callers durably record intent before and the applied status after.
 *
 * Returns `"applied"` when the write happened or `"already"` when the target
 * already holds the desired bytes. Throws RECOVERY_CONFLICT on a CAS mismatch,
 * a replaced payload/target, or an entry that is not the recorded regular file.
 */
export async function applyFileFromPayload(document, record, options = {}) {
  const lease = options.lease && typeof options.lease.assertHeld === "function" ? options.lease : null;
  const classified = await classifyJournalFileEntry(record);
  if (fileMatchesAfter(record, classified.status)) {
    if (record.before.exists) {
      await finishInterruptedClaim(record, document, record.before.sha256);
    }
    return "already";
  }
  if (record.before.exists && record.before.sha256 === record.after.sha256) return "already";

  // Stage 1: establish the prior-entry claim (or resume an interrupted one).
  const claimPath = claimPathFor(record.target, document.transactionId);
  let claimedPrior = null;
  let staleDesired = null;
  if (record.before.exists) {
    if (classified.status === "before") {
      if (lease) await lease.assertHeld();
      claimedPrior = await moveClassifiedEntryAside(record, document, classified);
    } else if (classified.status === "absent") {
      // Re-entry: an earlier attempt - of this apply, or of a rollback that
      // interrupted an even earlier apply - may have moved an entry to the
      // derived claim (container `entry` child or bare claim). Both recorded
      // digests are recognized; anything else fails closed and is preserved.
      const located = await locateFileClaimEntry(claimPath, document.transactionId);
      if (located.observed.status === "foreign") {
        throw conflict(
          `the cleanup claim at ${claimPath} is not an attributed claim (${located.observed.reason}); it was preserved`,
          { path: claimPath },
        );
      }
      if (located.observed.status === "ok" && (await claimHoldsDigest(located.entryPath, record.before.sha256))) {
        claimedPrior = { ...located, identity: located.observed.identity };
      } else if (located.observed.status === "ok" && (await claimHoldsDigest(located.entryPath, record.after.sha256))) {
        staleDesired = { ...located, identity: located.observed.identity };
      } else if (located.observed.status === "absent") {
        throw conflict(`refusing to write ${record.target}: it no longer matches the bytes observed while planning`, {
          path: record.target,
        });
      } else {
        throw conflict(
          `the cleanup claim at ${located.entryPath} does not hold the recorded prior bytes; it was preserved`,
          { path: located.entryPath },
        );
      }
    } else {
      throw conflict(`refusing to write ${record.target}: it no longer matches the bytes observed while planning`, {
        path: record.target,
      });
    }
  } else if (classified.status !== "absent") {
    throw conflict(`refusing to write ${record.target}: it no longer matches the bytes observed while planning`, {
      path: record.target,
    });
  }

  // Stage 2: read the payload once; its strong identity travels with the
  // bytes through the publish and the consumption below.
  const payload = await readPayload(record.after.payloadPath, { expectedSha256: record.after.sha256 });
  if (payload === null) {
    throw conflict(`the recorded payload for ${record.target} is missing`, { path: record.after.payloadPath });
  }
  if (!isIdentityAvailable(payload.identity)) {
    throw conflict(`the recorded payload for ${record.target} cannot be proven; nothing was written`, {
      path: record.after.payloadPath,
    });
  }

  // Stage 3: publish (never clobbering) and verify.
  if (lease) await lease.assertHeld();
  await publishPayloadBytes(record, payload);
  const published = await classifyJournalFileEntry(record);
  if (published.status !== "after") {
    throw conflict(`${record.target} does not hold the applied payload bytes after the write`, { path: record.target });
  }
  await syncDirectory(path.dirname(record.target));

  // Stage 4: consume the proven payload, then the proven claim entry - each
  // only while it still resolves to the exact identity that was read/proved,
  // so a swap is preserved and fails closed instead of being deleted. An
  // emptied proven container is dropped (non-recursive, empty only).
  await consumeProvenEntry(record.after.payloadPath, payload.identity);
  const consumedClaim = claimedPrior ?? staleDesired;
  if (consumedClaim) {
    await consumeProvenEntry(consumedClaim.entryPath, consumedClaim.identity);
    await removeAttributedClaimContainer(claimPath, { transactionId: document.transactionId, kind: "file" });
  }
  await syncDirectory(path.dirname(record.target));
  return "applied";
}

/**
 * Restores one journaled file record to its recorded `before` state - but only
 * while the target still equals the `after` digest this transaction wrote (or
 * already equals the prior bytes). Anything else is a concurrent edit: it is
 * preserved untouched and reported, never clobbered. The current entry is
 * moved aside to its derived claim and re-proven there, and the prior payload
 * bytes are published with the same no-clobber exclusive create as the apply
 * direction; an interrupted restore resumes from its claim. A foreign
 * replacement at the destination is never overwritten, and a claimed entry
 * that is not the classified one is preserved and fails closed.
 *
 * Returns `"restored"` (a write happened), `"already"` (already prior), or
 * `"conflict"` (concurrent contents preserved and reported).
 */
export async function restoreFileFromPayload(document, record, options = {}) {
  const lease = options.lease && typeof options.lease.assertHeld === "function" ? options.lease : null;
  const classified = await classifyJournalFileEntry(record);
  if (fileMatchesBefore(record, classified.status)) {
    await finishInterruptedClaim(record, document, record.after.sha256);
    return "already";
  }
  if (classified.status === "conflict") return "conflict";

  if (!record.before.exists) {
    if (lease) await lease.assertHeld();
    // Only the classified current entry is ever removed: a replacement that
    // appears between the classification and this point is preserved (B2).
    const current = await observeRegularFileEntry(record.target);
    if (current.status !== "ok" || !identitiesEqual(current.identity, classified.identity)) {
      throw conflict(`${record.target} changed before it was removed during rollback; it was preserved`, {
        path: record.target,
      });
    }
    await durableUnlink(record.target, current.identity);
    const after = await classifyJournalFileEntry(record);
    if (after.status !== "absent") {
      throw conflict(`${record.target} could not be removed during rollback`, { path: record.target });
    }
    return "restored";
  }

  const payload = await readPayload(record.before.payloadPath, { expectedSha256: record.before.sha256 });
  if (payload === null) {
    throw conflict(`the recorded prior bytes for ${record.target} are missing`, { path: record.before.payloadPath });
  }
  if (!isIdentityAvailable(payload.identity)) {
    throw conflict(`the recorded prior bytes for ${record.target} cannot be proven; nothing was written`, {
      path: record.before.payloadPath,
    });
  }

  const claimPath = claimPathFor(record.target, document.transactionId);
  let claimedCurrent = null;
  if (classified.status === "after") {
    if (lease) await lease.assertHeld();
    claimedCurrent = await moveClassifiedEntryAside(record, document, classified);
  } else {
    // Re-entry: an earlier attempt - of this rollback, or of an apply that a
    // rollback interrupted - may have moved an entry to the derived claim
    // (container `entry` child or bare claim). The claim holds either the
    // discarded desired entry (interrupted restore) or the discarded prior
    // entry (interrupted apply); both are recognized by their recorded digest
    // and consumed after the prior bytes are published.
    const located = await locateFileClaimEntry(claimPath, document.transactionId);
      if (located.observed.status === "foreign") {
        throw conflict(
          `the cleanup claim at ${claimPath} is not an attributed claim (${located.observed.reason}); it was preserved`,
          { path: claimPath },
        );
      }
    if (located.observed.status === "ok" && (await claimHoldsDigest(located.entryPath, record.after.sha256))) {
      claimedCurrent = { ...located, identity: located.observed.identity };
    } else if (located.observed.status === "ok" && (await claimHoldsDigest(located.entryPath, record.before.sha256))) {
      claimedCurrent = { ...located, identity: located.observed.identity };
    } else if (located.observed.status === "absent") {
      throw conflict(`${record.target} is absent and its recorded prior bytes were not restored`, { path: record.target });
    } else {
      throw conflict(`the cleanup claim at ${located.entryPath} does not hold the bytes it discarded; it was preserved`, {
        path: located.entryPath,
      });
    }
  }

  if (lease) await lease.assertHeld();
  await publishPayloadBytes(record, payload);
  const restored = await classifyJournalFileEntry(record);
  if (!fileMatchesBefore(record, restored.status)) {
    throw conflict(`${record.target} does not hold its recorded prior bytes after restoration`, { path: record.target });
  }
  await syncDirectory(path.dirname(record.target));

  await consumeProvenEntry(record.before.payloadPath, payload.identity);
  if (claimedCurrent) {
    await consumeProvenEntry(claimedCurrent.entryPath, claimedCurrent.identity);
    await removeAttributedClaimContainer(claimPath, { transactionId: document.transactionId, kind: "file" });
  }
  await syncDirectory(path.dirname(record.target));
  return "restored";
}

/** Durable file rollback: intent status, restore, observed outcome. */
async function rollbackFiles(ctx) {
  for (const snapshot of [...ctx.holder.doc.files].reverse()) {
    const record = ctx.holder.doc.files.find((entry) => entry.target === snapshot.target);
    if (record.status === "restored") continue;
    await step("file-restore-intent", { target: record.target });
    ctx.holder.doc = await patch(ctx, ctx.holder.doc, {
      files: ctx.holder.doc.files.map((entry) =>
        entry.target === record.target ? { ...entry, status: "intent" } : entry,
      ),
    });
    const outcome = await restoreFileFromPayload(ctx.holder.doc, record, { lease: ctx.lease });
    if (outcome === "conflict") {
      // A concurrent edit is preserved and reported, never marked restored:
      // a re-entered recovery must observe and report it again.
      ctx.conflicts.add(record.target);
      continue;
    }
    await step("file-restored", { target: record.target });
    ctx.holder.doc = await patch(ctx, ctx.holder.doc, {
      files: ctx.holder.doc.files.map((entry) =>
        entry.target === record.target ? { ...entry, status: "restored" } : entry,
      ),
    });
  }
}

/** Durable forward file application used by roll-forward recovery. */
async function forwardFiles(ctx) {
  for (const snapshot of [...ctx.holder.doc.files]) {
    const record = ctx.holder.doc.files.find((entry) => entry.target === snapshot.target);
    if (record.status === "applied") continue;
    await step("file-intent", { target: record.target });
    ctx.holder.doc = await patch(ctx, ctx.holder.doc, {
      files: ctx.holder.doc.files.map((entry) =>
        entry.target === record.target ? { ...entry, status: "intent" } : entry,
      ),
    });
    const outcome = await applyFileFromPayload(ctx.holder.doc, record, { lease: ctx.lease });
    if (outcome === "applied") await step("file-applied", { target: record.target });
    ctx.holder.doc = await patch(ctx, ctx.holder.doc, {
      files: ctx.holder.doc.files.map((entry) =>
        entry.target === record.target ? { ...entry, status: "applied" } : entry,
      ),
    });
  }
}

async function verifyFilesFor(ctx, target, conflicts) {
  for (const record of ctx.holder.doc.files) {
    if (conflicts && conflicts.has(record.target)) continue;
    const classification = await classifyJournalFile(record);
    const matches =
      target === "before" ? fileMatchesBefore(record, classification) : fileMatchesAfter(record, classification);
    if (!matches) {
      throw conflict(`${record.target} does not hold its recorded ${target} bytes`, { path: record.target });
    }
  }
}

/* ------------------------------------------------------------------ *
 * Claude reconciliation
 * ------------------------------------------------------------------ */

function claudeHandle(document) {
  const section = document.claude;
  if (!section) return null;
  const at = section.reference.lastIndexOf("@");
  if (at <= 0) throw invalid("the journal's Claude reference is malformed");
  const identity = {
    plugin: section.reference.slice(0, at),
    marketplace: section.marketplace,
    claudeScope: section.scope,
    stateDirectory: document.stateDirectory,
  };
  return {
    section,
    identity,
    plan: claudeRegistrationPlan({
      identity,
      stateDirectory: document.stateDirectory,
      version: section.version,
    }),
  };
}

function claudeCwd(ctx, document) {
  const cwd = ctx.cwd ?? document.root;
  if (typeof cwd !== "string" || cwd === "") {
    throw invalid("Claude recovery requires an explicit router root as cwd");
  }
  return cwd;
}

/**
 * Journal observer that durably appends every Claude intent and observed
 * outcome with a strictly increasing global sequence before/after the CLI
 * runs. `holder.doc` is kept current so compare-and-swap updates always use
 * the latest revision.
 */
export function createJournalClaudeObserver({ holder, paths, lease, now = Date.now }) {
  const baseSequence = (holder.doc.claude?.actions ?? []).at(-1)?.sequence ?? 0;
  const rebuild = (patchValue) => updateJournal(paths, holder.doc, patchValue, { lease, now, recovery: true });

  const sanitizeAction = (action, status) => {
    const entry = { sequence: action.sequence, id: action.id, type: action.type, scope: action.scope, status };
    for (const key of ["reference", "marketplace", "path", "version", "priorVersion"]) {
      if (action[key] !== undefined && action[key] !== null && action[key] !== "") entry[key] = action[key];
    }
    return entry;
  };

  return {
    baseSequence,
    async beforeMutation(action) {
      await step("claude-intent", { type: action?.type, id: action?.id });
      const section = holder.doc.claude;
      if (!section) throw invalid("a Claude mutation requires a recorded Claude section in the journal");
      if (action.scope !== section.scope) throw invalid("a Claude action scope does not match the journal");
      if (section.actions.length >= MAX_CLAUDE_ACTIONS) throw invalid("the journal cannot record more Claude actions");
      if (section.actions.some((entry) => entry.sequence === action.sequence)) {
        throw invalid("Claude action sequences must be unique");
      }
      holder.doc = await rebuild({
        claude: { ...section, actions: [...section.actions, sanitizeAction(action, "intent")] },
      });
    },
    async afterMutation(action, outcome) {
      await step("claude-observed", { type: action?.type, id: action?.id });
      const section = holder.doc.claude;
      if (!section) throw invalid("a Claude mutation requires a recorded Claude section in the journal");
      const index = section.actions.findIndex(
        (entry) => entry.sequence === action.sequence && entry.id === action.id && entry.status === "intent",
      );
      if (index === -1) throw invalid("a Claude outcome has no matching durable intent in the journal");
      const rebuilt = [...section.actions];
      rebuilt[index] = {
        ...rebuilt[index],
        status: "observed",
        outcome: {
          status: outcome?.status === "failed" ? "failed" : "succeeded",
          ...(outcome?.errorCode ? { errorCode: sanitizeCode(outcome.errorCode) } : {}),
          ...(outcome?.message ? { message: sanitizeText(outcome.message, 400) } : {}),
        },
      };
      holder.doc = await rebuild({ claude: { ...section, actions: rebuilt } });
    },
  };
}

/** Journal Claude actions mapped onto the Phase 5 compensation vocabulary. */
export function journalClaudeActions(section) {
  const actions = [];
  for (const entry of section.actions) {
    if (entry.type === "marketplace-add") {
      actions.push({ type: "marketplace-add", scope: entry.scope, name: entry.marketplace, path: entry.path });
    } else if (entry.type === "plugin-install") {
      actions.push({ type: "plugin-install", scope: entry.scope, reference: entry.reference });
    } else if (entry.type === "plugin-update") {
      actions.push({
        type: "plugin-update",
        scope: entry.scope,
        reference: entry.reference,
        priorVersion: entry.priorVersion ?? null,
        priorScope: entry.scope,
      });
    }
  }
  return actions;
}

async function observeClaude(ctx, document, handle, installation) {
  const cwd = claudeCwd(ctx, document);
  const observation = await observeClaudeUninstallState({
    plan: handle.plan,
    exec: ctx.claudeExec,
    cwd,
    env: ctx.claudeEnv,
  });
  const classification = classifyClaudeUninstallState(observation, handle.plan, installation);
  return { classification: classification.classification, reasons: classification.reasons, observation };
}

/** Best-effort realpath equality for Claude-stored paths (tmpdir symlinks). */
async function pathsMatch(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left === "" || right === "") return false;
  if (path.resolve(left) === path.resolve(right)) return true;
  try {
    return (await fsp.realpath(left)) === (await fsp.realpath(right));
  } catch {
    return false;
  }
}

const MARKETPLACE_ADD_TYPES = new Set(["marketplace-add"]);
const MARKETPLACE_REMOVE_TYPES = new Set(["marketplace-remove"]);
const PLUGIN_ADD_TYPES = new Set(["plugin-install", "plugin-update"]);
const PLUGIN_REMOVE_TYPES = new Set(["plugin-uninstall"]);

/** A recorded action whose mutation is proven to have completed. */
function actionWasProven(action) {
  return action.status === "observed" && action.outcome?.status === "succeeded";
}

/**
 * Baseline- and component-aware attribution of an observed Claude
 * registration against the journal's recorded Claude section (Gate 6
 * attempt-3 finding B).
 *
 * Declaration presence and visible-marketplace presence are INDEPENDENT
 * components (never collapsed with OR), alongside the installed plugin. For a
 * recorded-healthy baseline each component must be present and exact unless
 * its own latest applicable ordered action OF THE CAPABLE DIRECTION (a
 * disappearance needs a remove action, an appearance needs an add action,
 * each with intent/observed outcome semantics) explains the deviation; for an
 * absent baseline each present component independently needs matching add
 * provenance. Add/remove directions and statuses never substitute for each
 * other: an add action never explains a disappearance and a remove action
 * never explains an appearance, whatever their status or outcome; a
 * declaration disappearing while the visible marketplace and plugin remain,
 * or the visible marketplace disappearing while the declaration and plugin
 * remain, with no relevant recorded action is a conflict. Duplicate visible
 * entries always conflict, even when one entry is exact.
 *
 * Components (marketplace declaration + visible marketplace entry, and the
 * installed plugin) are attributed against the direction's recorded
 * baseline - the `prior` state for both roll-forward and rollback:
 *
 *   - any present-but-wrong component (wrong path/scope/reference/version,
 *     disabled, duplicated, malformed, contradictory ownership, or an extra
 *     marketplace-owned plugin) is never attributable;
 *   - a component that matches the recorded prior baseline needs no action;
 *   - a component that deviates from the baseline is explainable only by its
 *     specific recorded action chain, and only in the direction that could
 *     have produced the deviation: a healthy baseline that disappeared needs
 *     a remove-type action (marketplace-remove / plugin-uninstall), an absent
 *     baseline that appeared needs an add-type action (marketplace-add /
 *     plugin-install / plugin-update). An action of the opposite direction
 *     can NEVER explain the deviation - not as a durable intent, not as an
 *     observed failure, and not as a proven success - so it is never consulted;
 *     the LAST action of the capable direction decides. Within that direction
 *     the outcome semantics apply: a proven-succeeded action whose effect is
 *     observably undone is a conflict, while an attempted-but-unproven action
 *     (intent or failed outcome, i.e. mutate-then-error) may have landed or
 *     not. Absence is therefore exact and unconditional only when the
 *     direction's recorded baseline (or target) is absent; an unexplained
 *     disappearance of a recorded-healthy registration is a conflict in both
 *     directions, and "any action exists" is never sufficient;
 *   - a deviating plugin in the roll-forward direction must also sit at the
 *     version the recorded install/update action produced - exactly the
 *     direction-filtered CAPABLE add action component attribution selected for
 *     the appearance, never a later remove action, so a later remove intent or
 *     observed failure can never mask the expected version;
 *   - a later opposite-direction action that is proven to have landed makes an
 *     otherwise explainable observation incoherent (it would have undone the
 *     capable action while the component still sits where that action left
 *     it), which is a conflict - version validation is never dropped;
 *   - a plugin present while its marketplace is absent requires a recorded
 *     marketplace-add (incoherent intermediates are conflicts).
 *
 * A real Claude marketplace listing may carry `scope: null`; that is accepted
 * only when the exact enabled scope-owned declaration independently proves the
 * intended scope and path. Anything unattributable raises RECOVERY_CONFLICT
 * with zero mutations.
 */
export async function attributeClaudeState(observation, section, target = "desired") {
  const visible = Array.isArray(observation?.marketplaces) ? observation.marketplaces : null;
  const references = Array.isArray(observation?.plugins) ? observation.plugins : null;
  const owned = Array.isArray(observation?.marketplacePlugins) ? observation.marketplacePlugins : null;
  if (visible === null || references === null || owned === null) {
    return { attributable: false, reason: "the Claude observation is incomplete" };
  }
  const attempted = (type) => section.actions.some((entry) => entry.type === type);

  const foreignOwned = owned.filter((entry) => entry?.id !== section.reference);
  if (foreignOwned.length > 0) {
    return { attributable: false, reason: "another plugin from this marketplace is installed" };
  }

  // Marketplace component: exactness first.
  let declarationExact = false;
  const declaration = observation.declaration ?? null;
  const declarationPresent = Boolean(declaration && declaration.path !== null && declaration.path !== undefined);
  if (declarationPresent) {
    const exactPath = await pathsMatch(declaration.path, section.marketplaceRoot);
    const exactScope = (declaration.scope ?? null) === section.scope;
    if (!exactPath || !exactScope) {
      return { attributable: false, reason: "the marketplace declaration does not match the recorded path or scope" };
    }
    declarationExact = true;
  }
  for (const entry of visible) {
    if (!(await pathsMatch(entry.path, section.marketplaceRoot))) {
      return { attributable: false, reason: "the visible marketplace does not match the recorded path" };
    }
    if (entry.scope === section.scope) continue;
    if (entry.scope === null || entry.scope === undefined) {
      // Real marketplace listings can omit the scope; the exact scope-owned
      // declaration must independently prove the intended scope and path.
      if (!declarationExact) {
        return {
          attributable: false,
          reason: "a marketplace listing without a scope requires the exact scope-owned declaration",
        };
      }
      continue;
    }
    return { attributable: false, reason: "the visible marketplace does not match the recorded scope" };
  }
  if (visible.length > 1) {
    // Even when one entry is exact, duplicates are never attributable.
    return { attributable: false, reason: "the visible marketplace is listed more than once" };
  }
  const visiblePresent = visible.length > 0;

  // Plugin component: exactness first (version exactness is direction and
  // provenance dependent and checked below).
  const atScope = [];
  for (const entry of references) {
    if (entry?.id !== section.reference) continue;
    if (entry.scope !== section.scope) {
      return { attributable: false, reason: `the plugin is installed at ${entry.scope ?? "an unknown"} scope` };
    }
    if (entry.enabled === false) return { attributable: false, reason: "the plugin is disabled" };
    if (entry.enabled === null) return { attributable: false, reason: "the plugin carries a malformed enabled value" };
    if (entry.marketplaceValid === false) {
      return { attributable: false, reason: "the plugin carries contradictory marketplace ownership" };
    }
    if (typeof entry.marketplace === "string") {
      const at = typeof entry.id === "string" ? entry.id.lastIndexOf("@") : -1;
      const suffix = at > 0 ? entry.id.slice(at + 1) : null;
      if (suffix !== null && suffix !== entry.marketplace) {
        return { attributable: false, reason: "the plugin carries contradictory marketplace ownership" };
      }
    }
    if (typeof entry.version !== "string" || entry.version === "") {
      return { attributable: false, reason: "the plugin carries an unreadable version" };
    }
    atScope.push(entry);
  }
  if (atScope.length > 1) {
    return { attributable: false, reason: "the plugin is duplicated at the recorded scope" };
  }
  const pluginPresent = atScope.length === 1;
  const observedPluginVersion = pluginPresent ? atScope[0].version : null;

  // Cross-component coherence: a plugin present with no declaration, no
  // visible marketplace, and no recorded marketplace-add is an unrecorded,
  // incoherent intermediate.
  if (pluginPresent && !declarationPresent && !visiblePresent && !attempted("marketplace-add")) {
    return { attributable: false, reason: "the plugin is present without its marketplace and no recorded marketplace-add" };
  }

  // The recorded baseline for both directions is the prior state.
  const baselinePresent = section.prior === "healthy";

  // Direction first, outcome second. A component's deviation has exactly one
  // direction that could have produced it: a recorded-healthy baseline that
  // disappeared needs a REMOVE action, an absent baseline that appeared needs
  // an ADD action. An action of the opposite direction can never explain the
  // deviation - regardless of whether it is a durable `intent` or an
  // `observed` outcome, and regardless of whether that outcome succeeded or
  // failed - so it is never even considered as an explanation.
  //
  // On success the check exposes the exact action it chose: the latest
  // CAPABLE-direction action for the observed deviation (null when the
  // component sits at the recorded baseline and needs no action). Every
  // direction-dependent follow-up - today the plugin version pin - consumes
  // that returned action instead of re-selecting from the unfiltered
  // add/remove list, so a later opposite-direction action can never reselect
  // (and thereby mask) the expected outcome or version.
  const componentCheck = (name, observedPresent, addTypes, removeTypes) => {
    if (observedPresent === baselinePresent) return { ok: true, action: null };
    const actions = section.actions.filter((entry) => addTypes.has(entry.type) || removeTypes.has(entry.type));
    if (actions.length === 0) {
      return {
        ok: false,
        reason: `${name} differs from the recorded prior state with no recorded ${name} action`,
      };
    }
    const capable = observedPresent ? addTypes : removeTypes;
    const applicable = actions.filter((entry) => capable.has(entry.type));
    if (applicable.length === 0) {
      return {
        ok: false,
        reason: observedPresent
          ? `${name} appeared although no recorded ${name} action adds it (only ${actions.map((entry) => entry.type).join(", ")})`
          : `${name} disappeared although no recorded ${name} action removes it (only ${actions.map((entry) => entry.type).join(", ")})`,
      };
    }
    // Ordered latest action of the capable direction wins.
    const last = applicable[applicable.length - 1];
    const expectsPresent = addTypes.has(last.type);
    const proven = actionWasProven(last);
    // Outcome semantics apply only inside the correct direction: a proven
    // success must match its expected observed effect, while an attempted but
    // unproven action (durable intent, or a mutate-then-error failed outcome)
    // may or may not have landed.
    if (proven && observedPresent !== expectsPresent) {
      return {
        ok: false,
        reason: `${name} is ${observedPresent ? "present" : "missing"} although the last recorded ${last.type} action ${
          expectsPresent ? "added" : "removed"
        } it successfully`,
      };
    }
    // A LATER action of the opposite direction that is proven to have landed
    // leaves no reading under which the observation is coherent: it would have
    // undone the capable action (or undone its undoing) while the component
    // still sits exactly where the capable action left it. Fail closed here
    // instead of letting the later action silently drop version validation.
    const laterOpposite = section.actions
      .slice(section.actions.indexOf(last) + 1)
      .find(
        (entry) =>
          (addTypes.has(entry.type) || removeTypes.has(entry.type)) &&
          actionWasProven(entry) &&
          addTypes.has(entry.type) !== observedPresent,
      );
    if (laterOpposite) {
      return {
        ok: false,
        reason: `${name} is ${observedPresent ? "present" : "missing"} although the later recorded ${
          laterOpposite.type
        } action ${addTypes.has(laterOpposite.type) ? "added" : "removed"} it successfully`,
      };
    }
    return { ok: true, action: last };
  };

  const declarationCheck = componentCheck(
    "the marketplace declaration",
    declarationPresent,
    MARKETPLACE_ADD_TYPES,
    MARKETPLACE_REMOVE_TYPES,
  );
  if (!declarationCheck.ok) return { attributable: false, reason: declarationCheck.reason };

  const visibleCheck = componentCheck(
    "the visible marketplace",
    visiblePresent,
    MARKETPLACE_ADD_TYPES,
    MARKETPLACE_REMOVE_TYPES,
  );
  if (!visibleCheck.ok) return { attributable: false, reason: visibleCheck.reason };

  const pluginCheck = componentCheck("the plugin", pluginPresent, PLUGIN_ADD_TYPES, PLUGIN_REMOVE_TYPES);
  if (!pluginCheck.ok) return { attributable: false, reason: pluginCheck.reason };

  // Version provenance for a deviating plugin: it must sit at the version the
  // recorded install/update action produced. The action is exactly the one
  // component attribution selected above - the latest direction-filtered
  // CAPABLE plugin add action explaining the absent-baseline appearance - so a
  // later remove action can never reselect (and skip) the pin: an unproven
  // later remove only narrows what may be observed, and a proven later remove
  // already failed the coherence check above. (A plugin that matches the
  // recorded prior baseline needs no pin: the journal never records the
  // prior version.)
  if (pluginPresent && !baselinePresent) {
    const last = pluginCheck.action;
    if (!last || !PLUGIN_ADD_TYPES.has(last.type)) {
      return {
        attributable: false,
        reason: "the plugin appeared although no recorded plugin add action pins its version",
      };
    }
    const expectedVersion = last.version ?? section.version;
    if (observedPluginVersion !== expectedVersion) {
      return {
        attributable: false,
        reason: `the plugin is at version ${observedPluginVersion}, but the recorded ${last.type} action produced ${expectedVersion}`,
      };
    }
  }

  return { attributable: true, reason: null };
}

/**
 * Reconciles Claude state to `target` (`"prior"` for rollback, `"desired"`
 * for roll-forward) using only the journal's recorded identity plus the exact
 * installation metadata in the canonical state directory - never original
 * skill sources. Mutations run only when `attributeClaudeState` proves the
 * observed state is the exact prior/desired state or a narrowly
 * journal-attributable intermediate; anything else raises RECOVERY_CONFLICT
 * with zero mutations. Every mutation runs through the observer seam and
 * lands durably in the journal.
 */
async function reconcileClaude(ctx, target) {
  const handle = claudeHandle(ctx.holder.doc);
  if (!handle) return null;
  const { section } = handle;
  const document = ctx.holder.doc;
  await step("recovery:claude-observe", { target });

  const installation = await readInstallation(document.stateDirectory);
  const expectAbsent = target === "prior" && section.prior === "absent";
  const classInstallation = expectAbsent ? null : installation;
  let observed = await observeClaude(ctx, document, handle, classInstallation);
  const attribution = await attributeClaudeState(observed.observation, section, target);
  const conflictReason = () =>
    conflict(
      `Claude state cannot be attributed to this journal's recorded actions: ` +
        `${(observed.reasons ?? []).join("; ") || attribution.reason || "unattributable state"}`,
    );
  if (!attribution.attributable) throw conflictReason();

  const register = async () => {
    await step("recovery:claude-register", { target });
    const observer = createJournalClaudeObserver({
      holder: ctx.holder,
      paths: ctx.paths,
      lease: ctx.lease,
      now: ctx.now,
    });
    await registerClaude({
      plan: handle.plan,
      exec: ctx.claudeExec,
      cwd: claudeCwd(ctx, document),
      env: ctx.claudeEnv,
      observer,
    });
    observed = await observeClaude(ctx, document, handle, classInstallation);
    return observed;
  };

  if (target === "desired") {
    if (observed.classification === "healthy") return observed;
    const after = await register();
    if (after.classification !== "healthy") {
      throw conflict(`Claude registration is not healthy after recovery: ${(after.reasons ?? []).join("; ")}`);
    }
    return after;
  }

  if (expectAbsent) {
    if (observed.classification === "absent") return observed;
    if (journalClaudeActions(section).length === 0) throw conflictReason();
    await step("recovery:claude-compensate", { target });
    const observer = createJournalClaudeObserver({
      holder: ctx.holder,
      paths: ctx.paths,
      lease: ctx.lease,
      now: ctx.now,
    });
    await compensateClaude({
      actions: journalClaudeActions(section),
      plan: handle.plan,
      exec: ctx.claudeExec,
      cwd: claudeCwd(ctx, document),
      env: ctx.claudeEnv,
      observer,
    });
    observed = await observeClaude(ctx, document, handle, classInstallation);
    if (observed.classification !== "absent") {
      throw conflict(`Claude registration is not absent after rollback: ${(observed.reasons ?? []).join("; ")}`);
    }
    return observed;
  }

  if (observed.classification === "healthy") return observed;
  const after = await register();
  if (after.classification !== "healthy") {
    throw conflict(`Claude registration is not healthy after rollback: ${(after.reasons ?? []).join("; ")}`);
  }
  return after;
}

async function verifyClaudePrior(ctx, classification) {
  const document = ctx.holder.doc;
  if (!document.claude) return;
  if (classification === null) throw conflict("Claude state was not observed during rollback");
  const expected = document.claude.prior;
  const actual = classification.classification;
  const ok = expected === "absent" ? actual === "absent" : actual === "healthy";
  if (!ok) throw conflict(`Claude registration is not restored to its recorded prior state (${actual})`);
}

/* ------------------------------------------------------------------ *
 * Cleanup
 * ------------------------------------------------------------------ */

async function cleanupArtifacts(ctx, outcome) {
  const document = ctx.holder.doc;
  const expectations = artifactExpectations(document);

  // Stage: renamed to its exact derived claim, verified there, then removed -
  // never deleted in place, never wildcard-deleted.
  if (expectations.stagePath) {
    await cleanupStateArtifactViaClaim({
      lease: ctx.lease,
      artifactPath: expectations.stagePath,
      transactionId: document.transactionId,
      expectation: expectations.desired ?? null,
      label: "stage",
    });
  }

  // Backup: deleted only when committed (and only the recorded prior state),
  // never while rolling back (it must already be back at the canonical path).
  if (expectations.backupPath) {
    if (outcome === "committed") {
      await cleanupStateArtifactViaClaim({
        lease: ctx.lease,
        artifactPath: expectations.backupPath,
        transactionId: document.transactionId,
        expectation: expectations.before,
        label: "backup",
      });
    } else {
      const backupClass = await classifyStateArtifact(expectations.backupPath, { before: expectations.before });
      if (backupClass !== "absent") {
        throw conflict(`the recorded backup at ${expectations.backupPath} is still present after a rollback`, {
          path: expectations.backupPath,
        });
      }
    }
  }

  await step("cleanup:payloads", {});
  await cleanupPayloadTransients(document.files, { lease: ctx.lease });
  await cleanupPayloads(document.files, { lease: ctx.lease });
}

/**
 * Read-only proof that every recorded endpoint still holds before a committed
 * journal's backup, payloads, or the journal itself are deleted. A committed
 * journal is never permission to clean blindly: the canonical tree, every
 * config's recorded after digest, and (when recorded) the exact Claude
 * registration must all still be observable. Anything different or
 * unobservable retains every recovery artifact and raises RECOVERY_CONFLICT;
 * this path never mutates an integration.
 */
async function verifyCommittedEndpoints(ctx) {
  const document = ctx.holder.doc;
  const expectations = artifactExpectations(document);
  await step("commit:reverify", { kind: document.kind });

  if (document.kind === "managed") {
    const canonicalClass = await classifyStateArtifact(document.stateDirectory, {
      before: expectations.before,
      desired: expectations.desired,
    });
    if (canonicalClass !== "expected-desired") {
      throw conflict(`the canonical state is not the recorded desired tree (${canonicalClass}) before committed cleanup`, {
        path: document.stateDirectory,
      });
    }
  } else {
    const canonicalClass = await classifyStateArtifact(document.stateDirectory, { before: expectations.before });
    if (canonicalClass !== "absent") {
      throw conflict(`the router state at ${document.stateDirectory} is not absent before committed cleanup (${canonicalClass})`, {
        path: document.stateDirectory,
      });
    }
  }

  await verifyFilesFor(ctx, "after", null);

  if (document.claude) {
    await step("recovery:claude-observe", { target: "committed" });
    const handle = claudeHandle(document);
    const installation =
      document.kind === "managed"
        ? await readInstallation(document.stateDirectory)
        : await readInstallation(expectations.backupPath);
    let observed;
    try {
      observed = await observeClaude(ctx, document, handle, installation);
    } catch (error) {
      throw conflict(`Claude state could not be re-observed before committed cleanup: ${error.message}`);
    }
    const wanted = document.kind === "managed" ? "healthy" : "absent";
    if (observed.classification !== wanted) {
      throw conflict(
        `the Claude registration is not ${wanted} before committed cleanup: ${(observed.reasons ?? []).join("; ")}`,
      );
    }
  }
}

async function finishJournal(ctx, phase) {
  if (ctx.holder.doc.phase !== phase) {
    await step("recovery:terminal", { phase });
    ctx.holder.doc = await patch(ctx, ctx.holder.doc, { phase });
  }
  if (phase === "committed") await verifyCommittedEndpoints(ctx);
  await step("cleanup:journal", {});
  await cleanupArtifacts(ctx, phase === "committed" ? "committed" : "rolled-back");
  await step("recovery:journal", {});
  await removeJournal(ctx.paths, ctx.holder.doc, { lease: ctx.lease });
  return phase === "committed" ? "committed" : "rolled-back";
}

/* ------------------------------------------------------------------ *
 * Managed recovery
 * ------------------------------------------------------------------ */

async function recoverManaged(ctx) {
  const document = ctx.holder.doc;

  // Terminal journals only finish their exact cleanup.
  if (JOURNAL_TERMINAL_PHASES.includes(document.phase)) {
    return finishJournal(ctx, document.phase);
  }

  await step("recovery:classify", { kind: "managed" });
  const expectations = artifactExpectations(document);
  const canonicalClass = await classifyStateArtifact(document.stateDirectory, {
    before: expectations.before,
    desired: expectations.desired,
  });
  const stageAttribution = await attributeStage(document, expectations);
  const backupClass = expectations.backupPath
    ? await classifyStateArtifact(expectations.backupPath, { before: expectations.before })
    : "absent";

  let plan;
  if (document.mode === "rollback") plan = "rollback";
  else if (backupClass !== "absent" && backupClass !== "expected-before") {
    throw conflict(`the recorded backup at ${expectations.backupPath} is not the recorded prior state`, {
      path: expectations.backupPath,
    });
  } else if (canonicalClass === "expected-desired" && stageAttribution === "absent") plan = "forward";
  else plan = "rollback";

  if (plan === "forward") return rollForwardManaged(ctx, expectations);
  return rollBackManaged(ctx, expectations);
}

/**
 * Side-effect-free managed-rollback preflight (post-gate finding A).
 *
 * Runs at the very start of managed rollback - before the durable
 * rollback-mode patch, before any config restore, Claude observer action, or
 * filesystem mutation - and read-only classifies BOTH the canonical tree and
 * the deterministic desired-state cleanup claim derived through the
 * `claimPathFor(canonical, transactionId)` contract. The claim is inspected
 * no-follow against the exact recorded desired identity, digest, type,
 * ownership, and mode, giving exactly these combinations:
 *
 *   - canonical expected-desired + claim absent: a normal candidate;
 *   - canonical absent + claim exactly the recorded desired state: an
 *     interrupted cleanup candidate;
 *   - canonical absent + claim absent: acceptable only because no desired
 *     tree is left to discard - the recorded prior (when any) is then proved
 *     below, and anything unprovable is refused by the existing state
 *     machine rather than guessed;
 *   - canonical and claim both present: RECOVERY_AMBIGUOUS, untouched;
 *   - a claim that is foreign, changed, symlinked, special, or wrong-moded:
 *     RECOVERY_CONFLICT, untouched.
 *
 * Whenever the rollback could discard the desired tree - at the canonical
 * path or at its interrupted cleanup claim - and a prior state is recorded,
 * the exact recorded prior backup is proved right here in the same
 * preflight: missing => RECOVERY_AMBIGUOUS, anything that is not the
 * recorded prior (changed, foreign, symlinked, special, wrong-mode) =>
 * RECOVERY_CONFLICT. On refusal nothing durable or external has happened yet:
 * the journal bytes, configs, payloads, Claude state, and artifact inventory
 * are untouched. The canonical, claim, and backup classifications are all
 * carried into `restoreManagedState`, so no precondition is ever classified
 * a second, racy time after mutations; only the endpoint re-observation
 * around the actual restore rename stays live.
 */
async function preflightManagedRollback(ctx, expectations) {
  const document = ctx.holder.doc;
  const canonicalPath = document.stateDirectory;
  const claimPath = claimPathFor(canonicalPath, document.transactionId);

  const canonicalClass = await classifyStateArtifact(canonicalPath, {
    before: expectations.before,
    desired: expectations.desired,
  });
  if (canonicalClass === "foreign") {
    throw conflict(
      `the router state at ${canonicalPath} is neither the recorded prior state nor the desired state`,
      { path: canonicalPath },
    );
  }

  // The cleanup claim is only ever the exact recorded desired tree: anything
  // else at that path (a different tree, a symlink, a special file, or an
  // owner-unsafe mode) is preserved untouched, never adopted and never
  // finished.
  const claimClass = await classifyDerivedClaim(claimPath, { desired: expectations.desired }, {
    transactionId: document.transactionId,
    kind: "canonical",
  });
  if (claimClass !== "absent" && claimClass !== "expected-desired") {
    throw conflict(
      `the cleanup claim at ${claimPath} is not the recorded desired state (${claimClass}); it was preserved and recovery was left untouched`,
      { path: claimPath },
    );
  }
  if (claimClass !== "absent" && canonicalClass !== "absent") {
    throw ambiguous(
      `the router state at ${canonicalPath} and its cleanup claim at ${claimPath} are both present; recovery was left untouched`,
      { path: canonicalPath },
    );
  }

  const backupClass = expectations.backupPath
    ? await classifyStateArtifact(expectations.backupPath, { before: expectations.before })
    : "absent";

  if (expectations.before && canonicalClass !== "expected-before") {
    await provePriorBackupForRollback(ctx, expectations, backupClass);
    return { canonicalClass, claimClass, backupClass };
  }
  if (backupClass !== "absent") {
    throw conflict(
      `both the canonical state at ${canonicalPath} and its recorded backup at ${expectations.backupPath} are present; recovery was left untouched`,
      { path: expectations.backupPath },
    );
  }
  return { canonicalClass, claimClass, backupClass };
}

async function rollBackManaged(ctx, expectations) {
  // R4: an interrupted restore's exact recorded reservation (and its durable
  // record) is recognized and removed before any classification, so it never
  // blocks re-entry; a replacement there fails closed with everything
  // preserved.
  await consumeRecordedReservation(ctx, expectations);

  // Finding A: the side-effect-free proof preflight runs before anything
  // durable (mode/revision patches), external (Claude), or local (file
  // restores) happens in this rollback.
  const preflight = await preflightManagedRollback(ctx, expectations);

  await step("rollback:begin", { kind: "managed" });
  if (ctx.holder.doc.mode !== "rollback") {
    ctx.holder.doc = await patch(ctx, ctx.holder.doc, { mode: "rollback" });
  }

  await step("recovery:files", {});
  await rollbackFiles(ctx);

  await step("recovery:state", {});
  await restoreManagedState(ctx, expectations, preflight);

  await step("recovery:claude", {});
  const claudeClassification = await reconcileClaude(ctx, "prior");

  await step("recovery:verify", {});
  await verifyManagedRollback(ctx, expectations, claudeClassification);

  return finishJournal(ctx, "rolled-back");
}

/**
 * Shared rollback precondition (Gate 6 finding 2 and attempt-3 finding A):
 * whenever rolling back can discard the desired canonical tree - it sits at
 * the canonical path, or its interrupted cleanup claim holds it while the
 * canonical path is absent - the exact recorded prior must first be proven at
 * the backup path. A missing prior is RECOVERY_AMBIGUOUS; anything that is
 * not the recorded prior state (foreign, changed, symlinked, special, or
 * wrong-mode) is RECOVERY_CONFLICT. The classification is the one the
 * side-effect-free preflight already observed, so no later second proof can
 * race it inconsistently, and every failure path leaves the desired tree or
 * claim, the journal, and all other artifacts untouched.
 */
async function provePriorBackupForRollback(ctx, expectations, backupClass) {
  if (!expectations.backupPath) {
    throw ambiguous(
      "the journal records a prior state but no backup path; the desired canonical state and its cleanup claim were left untouched",
      { path: ctx.holder.doc.stateDirectory },
    );
  }
  if (backupClass === "absent") {
    throw ambiguous(
      `the recorded prior state is missing at ${expectations.backupPath}; the desired canonical state and its cleanup claim were left untouched`,
      { path: expectations.backupPath },
    );
  }
  if (backupClass !== "expected-before") {
    throw conflict(
      `the recorded backup at ${expectations.backupPath} is not the recorded prior state; the desired canonical state and its cleanup claim were left untouched`,
      { path: expectations.backupPath },
    );
  }
  return backupClass;
}

async function restoreManagedState(ctx, expectations, preflight) {
  const document = ctx.holder.doc;
  if (
    !preflight ||
    typeof preflight.canonicalClass !== "string" ||
    typeof preflight.claimClass !== "string" ||
    typeof preflight.backupClass !== "string"
  ) {
    throw new TypeError("restoreManagedState requires the rollback preflight classifications");
  }
  // The canonical, claim, and prior-backup classifications all come from the
  // side-effect-free preflight; no second, racy precondition classification
  // happens after the config, payload, Claude, or filesystem mutations.
  const { canonicalClass, backupClass } = preflight;

  // The durable state intent is written immediately before the first state
  // mutation of this restore - never up front - so a rollback whose preflight
  // refuses, or which has nothing left to restore, never bumps the journal.
  let intentWritten = false;
  const durableStateIntent = async () => {
    if (intentWritten) return;
    await ctx.lease.assertHeld();
    ctx.holder.doc = await patch(ctx, ctx.holder.doc, { state: ctx.holder.doc.state });
    intentWritten = true;
  };

  if (canonicalClass === "expected-before") {
    if (backupClass !== "absent") {
      throw conflict("both the canonical state and its recorded backup are present", {
        path: expectations.backupPath,
      });
    }
  } else if (canonicalClass === "expected-desired") {
    // Claim-based removal of the desired tree: rename to the derived claim,
    // verify identity and digest there, assert the lease, delete only claim.
    // The preflight already proved the exact recorded prior backup.
    await durableStateIntent();
    await cleanupStateArtifactViaClaim({
      lease: ctx.lease,
      artifactPath: document.stateDirectory,
      transactionId: document.transactionId,
      expectation: expectations.desired ?? null,
      label: "canonical",
    });
    await restoreBackupIntoPlace(ctx, expectations, preflight);
  } else if (canonicalClass === "absent") {
    // The desired tree may be sitting at its derived cleanup claim (a crash
    // between the claim rename and its removal): prove and finish exactly
    // that claim before the prior state is restored into place. The preflight
    // already proved the prior backup and proved this claim to be the exact
    // recorded desired state.
    await durableStateIntent();
    await cleanupStateArtifactViaClaim({
      lease: ctx.lease,
      artifactPath: document.stateDirectory,
      transactionId: document.transactionId,
      expectation: expectations.desired ?? null,
      label: "canonical",
    });
    await restoreBackupIntoPlace(ctx, expectations, preflight);
  }

  if (expectations.stagePath) {
    const stageInfo = await inspectStateTree(expectations.stagePath);
    if (stageInfo.status !== "absent") {
      await durableStateIntent();
      await cleanupStateArtifactViaClaim({
        lease: ctx.lease,
        artifactPath: expectations.stagePath,
        transactionId: document.transactionId,
        expectation: expectations.desired ?? null,
        label: "stage",
      });
    }
  }
}

/* ------------------------------------------------------------------ *
 * R4 - durable restoration reservation record
 *
 * The state-directory restore reserves its destination with an exclusive
 * mkdir and, before the crash window, durably records that reservation in an
 * external sibling record (`.skill-router.reserve-<txid>.json`) binding the
 * transaction and the reservation's exact identity. Re-entry recognizes the
 * *exact recorded* empty reservation and removes it safely (then consumes the
 * record) before reserving afresh; a replacement at the destination that does
 * not match the record fails closed with the backup and the record preserved.
 * Residual (documented, not claimable away): between the final reservation
 * re-proof and the rename syscall there is a single-syscall window a same-UID
 * process could still race - impossible to close in Node.
 * ------------------------------------------------------------------ */

const RESERVATION_SCHEMA = 1;

function reservationRecordPath(canonicalPath, transactionId) {
  return `${canonicalPath}.reserve-${transactionId}.json`;
}

function serializeReservationRecord({ transactionId, reservation }) {
  return Buffer.from(
    `${JSON.stringify({
      schema: RESERVATION_SCHEMA,
      owner: "skill-router",
      transactionId,
      kind: "restore-reserve",
      reservation: identityRecord(reservation),
    })}\n`,
    "utf8",
  );
}

/** Strictly validates a restoration reservation record (closed schema). */
async function readValidatedReservationRecord(recordPath, transactionId) {
  const observed = await readExternalRecordFile(recordPath);
  if (observed === null) return null;
  const bytes = observed.bytes;
  let record;
  try {
    record = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 5
    || record.schema !== RESERVATION_SCHEMA
    || record.owner !== "skill-router"
    || record.transactionId !== transactionId
    || record.kind !== "restore-reserve"
    || !exactIdentityPair(record.reservation)
  ) {
    return null;
  }
  return { path: recordPath, identity: observed.identity, transactionId, reservation: record.reservation };
}

/** Attributed removal of a validated reservation record (itself re-proven). */
async function consumeReservationRecord(record) {
  // Terminal direct unlink after the immediate invariant reproof (R4); see
  // consumeExternalRecordDirect for the residual.
  return consumeExternalRecordDirect(record);
}

/**
 * Recognizes and safely removes the exact *recorded* reservation left by an
 * interrupted restore of this transaction (R4), consuming its durable record;
 * a replacement at the destination that does not match the record fails closed
 * with the backup and the record preserved. Foreign (unvalidated) reservation
 * records are never adopted or removed. Runs before the rollback preflight so
 * an interrupted restore's reservation never blocks re-entry, and again
 * immediately before a fresh reservation (idempotent).
 */
async function consumeRecordedReservation(ctx, expectations) {
  const reserveRecordPath = reservationRecordPath(expectations.canonicalPath, ctx.holder.doc.transactionId);
  const leftover = await readValidatedReservationRecord(reserveRecordPath, ctx.holder.doc.transactionId);
  if (leftover === null) {
    if (await fsp.lstat(reserveRecordPath).then(() => true, () => false)) {
      throw conflict(
        `the reservation record at ${reserveRecordPath} is not an attributed record of this transaction; it was preserved and nothing was restored`,
        { path: reserveRecordPath },
      );
    }
    return false;
  }
  const observed = await fsp.lstat(expectations.canonicalPath).catch(() => null);
  const stillOurs =
    observed !== null
    && !observed.isSymbolicLink()
    && observed.isDirectory()
    && isIdentityAvailable(fileIdentity(observed))
    && identitiesEqual(fileIdentity(observed), leftover.reservation);
  if (!stillOurs) {
    // R4 endpoint reconciliation: the restore rename may already have
    // committed before the crash - the canonical then holds the recorded
    // prior state and the backup is gone. In that case consume the record
    // and let the rollback finish; anything else is a replacement that fails
    // closed with the backup and the record preserved.
    const canonicalClass = await classifyStateArtifact(expectations.canonicalPath, { before: expectations.before });
    const backupClass = await classifyStateArtifact(expectations.backupPath, { before: expectations.before });
    if (canonicalClass === "expected-before" && backupClass === "absent") {
      // The restore rename itself committed before the crash.
      await consumeReservationRecord(leftover);
      return "committed";
    }
    if (canonicalClass === "absent" && backupClass === "expected-before") {
      // The reservation rmdir (and its fsync) committed and only the record
      // consumption was interrupted: consume it and let the caller reserve
      // afresh, so the restoration completes.
      await consumeReservationRecord(leftover);
      return "retry";
    }
    throw conflict(
      `the canonical path at ${expectations.canonicalPath} is occupied by a replacement; the recorded backup and the reservation record were preserved and nothing was restored`,
      { path: expectations.canonicalPath },
    );
  }
  // Streaming one-entry emptiness: never a full readdir.
  if (!(await directoryIsEmpty(expectations.canonicalPath))) {
    throw conflict(
      `the recorded reservation at ${expectations.canonicalPath} was refilled; the recorded backup and the reservation record were preserved and nothing was restored`,
      { path: expectations.canonicalPath },
    );
  }
  try {
    await fsp.rmdir(expectations.canonicalPath);
  } catch {
    throw conflict(
      `the recorded reservation at ${expectations.canonicalPath} could not be removed; the recorded backup and the reservation record were preserved and nothing was restored`,
      { path: expectations.canonicalPath },
    );
  }
  await syncDirectory(path.dirname(expectations.canonicalPath));
  await consumeReservationRecord(leftover);
  return "retry";
}

async function restoreBackupIntoPlace(ctx, expectations, preflight) {
  if (!expectations.backupPath) return;
  // The backup classification and its proof come from the side-effect-free
  // preflight: there is no second precondition classification after the
  // config, payload, Claude, or claim mutations this rollback already made.
  const backupClass = preflight.backupClass;
  if (backupClass === "absent") {
    if (expectations.before) {
      throw conflict("the recorded prior state is missing: neither the canonical path nor the backup holds it", {
        path: expectations.backupPath,
      });
    }
    return;
  }
  if (backupClass !== "expected-before") {
    throw conflict(`the recorded backup at ${expectations.backupPath} is not the recorded prior state`, {
      path: expectations.backupPath,
    });
  }
  // B3: no check-then-rename overwrite. Node has no portable no-clobber
  // directory rename, so the destination is *reserved* with an exclusive
  // mkdir (O_EXCL semantics) and that reservation is re-proven immediately
  // before the rename: the rename can only replace our own empty
  // reservation, never a pre-existing replacement. Anything already at the
  // canonical path - or a replacement of the reservation itself - fails
  // closed with the recorded backup (the restoration claim) preserved for
  // explicit later recovery. Residual (documented, not removable in Node):
  // between the final reservation re-proof and the rename syscall there is a
  // single-syscall window a same-user process could still race into.
  // R4: recognize an exact *recorded* reservation left by an interrupted
  // earlier attempt of this same transaction (idempotent with the pre-preflight
  // pass in rollBackManaged).
  await consumeRecordedReservation(ctx, expectations);
  try {
    await fsp.mkdir(expectations.canonicalPath, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error && error.code === "EEXIST") {
      throw conflict(
        `the canonical state at ${expectations.canonicalPath} is present; the recorded backup was preserved and nothing was restored`,
        { path: expectations.canonicalPath },
      );
    }
    throw error;
  }
  let reservationStat;
  try {
    reservationStat = await fsp.lstat(expectations.canonicalPath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw conflict(
        `the canonical reservation at ${expectations.canonicalPath} vanished; the recorded backup was preserved and nothing was restored`,
        { path: expectations.canonicalPath },
      );
    }
    throw error;
  }
  const reservationProven =
    !reservationStat.isSymbolicLink()
    && reservationStat.isDirectory()
    && isIdentityAvailable(fileIdentity(reservationStat))
    && (await directoryIsEmpty(expectations.canonicalPath));
  if (!reservationProven) {
    throw conflict(
      `the canonical reservation at ${expectations.canonicalPath} could not be proven; the recorded backup was preserved and nothing was restored`,
      { path: expectations.canonicalPath },
    );
  }
  const reservationIdentity = fileIdentity(reservationStat);
  // R4: durably record the reservation *before* the crash window, binding the
  // transaction and this exact reservation identity.
  const reserveRecordPath = reservationRecordPath(expectations.canonicalPath, ctx.holder.doc.transactionId);
  await durableCreateFile(
    reserveRecordPath,
    serializeReservationRecord({ transactionId: ctx.holder.doc.transactionId, reservation: reservationIdentity }),
    { mode: 0o600 },
  );
  await syncDirectory(path.dirname(expectations.canonicalPath));
  // B3: any failure after the reservation was created removes exactly our own
  // empty reservation (non-recursive, identity-proven) before propagating, so
  // an interrupted restoration never leaves an unattributable directory at
  // the canonical path.
  const observeOwnReservation = async () => {
    try {
      const current = await fsp.lstat(expectations.canonicalPath);
      if (
        current.isSymbolicLink()
        || !current.isDirectory()
        || !identitiesEqual(fileIdentity(current), reservationIdentity)
      ) {
        return null;
      }
      if (!(await directoryIsEmpty(expectations.canonicalPath))) return null;
      return current;
    } catch {
      return null;
    }
  };
  const reservationRecord = await readValidatedReservationRecord(reserveRecordPath, ctx.holder.doc.transactionId);
  const dropReservation = async () => {
    if (await observeOwnReservation()) {
      try {
        await fsp.rmdir(expectations.canonicalPath);
        await syncDirectory(path.dirname(expectations.canonicalPath));
      } catch {
        // Preserved.
      }
    }
    // The reservation record authorizes re-entry until the reservation itself
    // is gone; consume it attributed once the reservation is dropped.
    if (reservationRecord !== null) await consumeReservationRecord(reservationRecord);
  };
  let result = null;
  try {
    await step("restore:reserve", { path: expectations.canonicalPath });
    await ctx.lease.assertHeld();
    // Final re-proof, immediately before the rename: the destination must
    // still be exactly the empty reservation this run created.
    let finalStat;
    try {
      finalStat = await fsp.lstat(expectations.canonicalPath);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        throw conflict(
          `the canonical reservation at ${expectations.canonicalPath} vanished; the recorded backup was preserved and nothing was restored`,
          { path: expectations.canonicalPath },
        );
      }
      throw error;
    }
    const reservationStillOurs =
      !finalStat.isSymbolicLink()
      && finalStat.isDirectory()
      && identitiesEqual(fileIdentity(finalStat), reservationIdentity)
      && (await directoryIsEmpty(expectations.canonicalPath));
    if (!reservationStillOurs) {
      throw conflict(
        `the canonical path at ${expectations.canonicalPath} was replaced during restoration; the recorded backup was preserved and nothing was restored`,
        { path: expectations.canonicalPath },
      );
    }
    await ctx.lease.assertHeld();
  ctx.holder.doc = await patch(ctx, ctx.holder.doc, { state: ctx.holder.doc.state });
  result = await reconcileRename(
    async () => {
      await ctx.lease.assertHeld();
      await journaledTransactionInternals.rename(expectations.backupPath, expectations.canonicalPath);
    },
    async () => {
      const canonical = await classifyStateArtifact(expectations.canonicalPath, { before: expectations.before });
      const backup = await classifyStateArtifact(expectations.backupPath, { before: expectations.before });
      if (canonical === "expected-before" && backup === "absent") return "done";
      // "Untouched" includes this run's own empty reservation standing at the
      // destination: the rename never happened.
      const ownReservation = (await observeOwnReservation()) !== null;
      if ((canonical === "absent" || ownReservation) && backup === "expected-before") return "untouched";
      return "uncertain";
    },
  );
  } catch (error) {
    await dropReservation();
    throw error;
  }
  if (result.completed === null) {
    // The rename never completed (or cannot be proven): drop our own empty
    // reservation if it is still standing (a no-op once the rename landed,
    // because the destination then holds the restored tree, not the
    // reservation).
    await dropReservation();
    throw ambiguous(
      `the state restore rename at ${expectations.canonicalPath} could not be reconciled; nothing further was touched`,
      { path: expectations.canonicalPath },
    );
  }
  if (result.completed === false) {
    await dropReservation();
    if (result.error) throw result.error;
  }
  // R4 commit: the restore landed (the reservation was replaced by the
  // restored tree); consume the reservation record, which authorizes re-entry
  // until this point.
  const committedRecord = await readValidatedReservationRecord(reserveRecordPath, ctx.holder.doc.transactionId);
  if (committedRecord !== null) await consumeReservationRecord(committedRecord);
}

async function verifyManagedRollback(ctx, expectations, claudeClassification) {
  const document = ctx.holder.doc;
  const canonicalClass = await classifyStateArtifact(document.stateDirectory, {
    before: expectations.before,
    desired: expectations.desired,
  });
  const expectedCanonical = expectations.before ? "expected-before" : "absent";
  if (canonicalClass !== expectedCanonical) {
    throw conflict(`the router state at ${document.stateDirectory} was not restored (${canonicalClass})`, {
      path: document.stateDirectory,
    });
  }
  if (expectations.backupPath) {
    const backupClass = await classifyStateArtifact(expectations.backupPath, { before: expectations.before });
    if (backupClass !== "absent") {
      throw conflict(`the recorded backup at ${expectations.backupPath} is still present`, {
        path: expectations.backupPath,
      });
    }
  }
  if (expectations.stagePath) {
    const attribution = await attributeStage(document, expectations);
    if (attribution !== "absent") throw conflict("the recorded stage directory is still present after rollback");
  }
  await verifyFilesFor(ctx, "before", ctx.conflicts);
  await verifyClaudePrior(ctx, claudeClassification);
}

async function rollForwardManaged(ctx, expectations) {
  await step("rollforward:begin", { kind: "managed" });
  await step("recovery:files", {});
  await forwardFiles(ctx);

  await step("recovery:claude", {});
  await reconcileClaude(ctx, "desired");

  await step("recovery:verify", {});
  const canonicalClass = await classifyStateArtifact(ctx.holder.doc.stateDirectory, {
    before: expectations.before,
    desired: expectations.desired,
  });
  if (canonicalClass !== "expected-desired") {
    throw conflict("the desired canonical state is no longer proven", { path: ctx.holder.doc.stateDirectory });
  }
  await verifyFilesFor(ctx, "after", null);

  if (ctx.holder.doc.phase !== "proven") ctx.holder.doc = await patch(ctx, ctx.holder.doc, { phase: "proven" });
  return finishManagedCommitted(ctx);
}

async function finishManagedCommitted(ctx) {
  if (ctx.holder.doc.mode !== "committed") {
    await step("journal:commit", { kind: "managed" });
    ctx.holder.doc = await patch(ctx, ctx.holder.doc, { mode: "committed", phase: "committed" });
  }
  return finishJournal(ctx, "committed");
}

/* ------------------------------------------------------------------ *
 * Removal recovery
 * ------------------------------------------------------------------ */

async function recoverRemoval(ctx) {
  const document = ctx.holder.doc;

  if (JOURNAL_TERMINAL_PHASES.includes(document.phase)) {
    return finishJournal(ctx, document.phase);
  }

  await step("recovery:classify", { kind: "removal" });
  const expectations = artifactExpectations(document);
  if (!expectations.backupPath) throw invalid("a removal journal must record its state backup");
  const canonicalClass = await classifyStateArtifact(document.stateDirectory, { before: expectations.before });
  const backupClass = await classifyStateArtifact(expectations.backupPath, { before: expectations.before });

  let plan;
  if (document.mode === "rollback") plan = "rollback";
  else if (canonicalClass === "absent" && backupClass === "expected-before") plan = "commit";
  else if (canonicalClass === "expected-before" && backupClass === "absent") plan = "rollback";
  else {
    throw ambiguous(
      `the removal commit outcome cannot be reconciled: the state at ${document.stateDirectory} is ${canonicalClass} ` +
        `and the backup at ${expectations.backupPath} is ${backupClass}; nothing was renamed, restored, or removed`,
      { path: document.stateDirectory },
    );
  }

  if (plan === "commit") return finishRemovalCommitted(ctx, expectations);
  return rollBackRemoval(ctx, expectations);
}

async function rollBackRemoval(ctx, expectations) {
  await step("rollback:begin", { kind: "removal" });
  if (ctx.holder.doc.mode !== "rollback") {
    ctx.holder.doc = await patch(ctx, ctx.holder.doc, { mode: "rollback" });
  }

  await step("recovery:files", {});
  await rollbackFiles(ctx);

  await step("recovery:state", {});
  const canonicalClass = await classifyStateArtifact(ctx.holder.doc.stateDirectory, { before: expectations.before });
  if (canonicalClass !== "expected-before") {
    throw conflict(
      `the router state at ${ctx.holder.doc.stateDirectory} is not the recorded owned state (${canonicalClass})`,
      { path: ctx.holder.doc.stateDirectory },
    );
  }
  const backupClass = await classifyStateArtifact(expectations.backupPath, { before: expectations.before });
  if (backupClass !== "absent") {
    throw conflict(`the recorded backup at ${expectations.backupPath} is present before the commit rename`, {
      path: expectations.backupPath,
    });
  }

  await step("recovery:claude", {});
  const claudeClassification = await reconcileClaude(ctx, "prior");

  await step("recovery:verify", {});
  await verifyFilesFor(ctx, "before", ctx.conflicts);
  await verifyClaudePrior(ctx, claudeClassification);

  return finishJournal(ctx, "rolled-back");
}

async function finishRemovalCommitted(ctx, expectations) {
  // Post-commit never restores integrations or configuration. The observed
  // commit endpoints were already proven by the classifier; the shared
  // read-only committed verification (canonical absent, every config at its
  // recorded after digest, Claude exactly absent with no drift or extra
  // marketplace plugin) runs in finishJournal before any artifact is deleted.
  if (ctx.holder.doc.mode !== "committed") {
    await step("journal:commit", { kind: "removal" });
    ctx.holder.doc = await patch(ctx, ctx.holder.doc, { mode: "committed", phase: "committed" });
  }
  return finishJournal(ctx, "committed");
}
