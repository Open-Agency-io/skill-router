// Phase 6 - the typed recovery machine: read-only inspection, decision rules
// (roll forward / roll back / committed / ambiguous), re-enterable recovery
// after interruption at every step, fail-closed inputs, and child-process
// SIGKILL fixtures for both transaction kinds.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  claimPathFor,
  createJournal,
  JOURNAL_ERROR_CODES,
  JOURNAL_SCHEMA_VERSION,
  payloadPathFor,
  prepareFilePayloads,
  readJournal,
  stagePathFor,
  updateJournal,
} from "../src/journal.js";
import { acquireMutationLock, CLAIM_PREFIX, controlPaths } from "../src/mutation-lock.js";
import { checkOperation, initOperation, recoverOperation } from "../src/operations.js";
import { inspectStateTree, stageManagedState } from "../src/managed-state.js";
import {
  applyFileFromPayload,
  attributeClaudeState,
  cleanupStateArtifactViaClaim,
  inspectRecoveryRequirement,
  journaledTransactionInternals,
  recoverPendingTransaction,
  restoreFileFromPayload,
} from "../src/recovery.js";
import {
  classifyClaudeUninstallState,
  claudeRegistrationPlan,
  detachClaude,
  inspectGeneratedClaudeRemovalSource,
  observeClaudeUninstallState,
  planClaudePlugin,
  registerClaude,
} from "../src/claude.js";
import { buildInstallation, claudeIdentity, STATE_MARKER_CONTENT, STATE_MARKER_FILE } from "../src/installation.js";
import { createFakeClaudeRunner } from "./fake-claude.js";
import {
  brokenLease,
  createProject,
  digestTree,
  exists,
  fakeLease,
  installStepFault,
  leftoverArtifacts,
  listEntries,
  NEW_CONFIG,
  OLD_CONFIG,
  modeTree,
  openCodePlan,
  runManagedTransaction,
  runRemovalTransaction,
  stageAt,
  withTemp,
} from "./journaled-harness.js";

// Defense in depth: no test in this file may reach a real Claude CLI.
process.env.SKILL_ROUTER_CLAUDE_BIN = "/nonexistent-claude-binary-for-tests";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "..", "src");
const TX = "ab".repeat(32);

/**
 * Host-independent OpenCode capability: this file inherits a fake `opencode`
 * that prints exactly one clean semantic version, so the bounded capability
 * probe resolves the same skills shape on every machine. Public-operation and
 * child-process recovery fixtures depend on the probe outcome (an unknown
 * shape defers the OpenCode config write), so the tests must never inherit
 * whatever OpenCode (or none) happens to be installed on the host.
 */
const openCodeProbeDirectory = await mkdtemp(path.join(os.tmpdir(), "skill-router-recovery-opencode-probe-"));
const openCodeProbeBin = path.join(openCodeProbeDirectory, "opencode");
await writeFile(openCodeProbeBin, "#!/bin/sh\nprintf '%s\\n' '2.0.0'\n", { mode: 0o755 });
const previousOpenCodeBin = process.env.SKILL_ROUTER_OPENCODE_BIN;
process.env.SKILL_ROUTER_OPENCODE_BIN = openCodeProbeBin;
after(async () => {
  if (previousOpenCodeBin === undefined) delete process.env.SKILL_ROUTER_OPENCODE_BIN;
  else process.env.SKILL_ROUTER_OPENCODE_BIN = previousOpenCodeBin;
  await rm(openCodeProbeDirectory, { recursive: true, force: true });
});

async function capture(run) {
  let caught = null;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "expected the operation to reject");
  return caught;
}

function projectRoot(project) {
  return path.dirname(project.paths.controlDirectory);
}

function recover(project, lease = project.lease, extra = {}) {
  return recoverPendingTransaction({
    paths: project.paths,
    lease,
    root: projectRoot(project),
    scope: "project",
    stateDirectory: project.stateDirectory,
    ...extra,
  });
}

/** Minimal valid managed journal used to stage a readable pending state. */
function managedDocument(project, transactionId = TX) {
  const stamp = new Date(Date.now()).toISOString();
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    owner: "skill-router",
    transactionId,
    revision: 0,
    kind: "managed",
    command: "scan",
    mode: "forward",
    phase: "prepared",
    scope: "project",
    root: projectRoot(project),
    controlDirectory: project.paths.controlDirectory,
    stateDirectory: project.stateDirectory,
    createdAt: stamp,
    updatedAt: stamp,
    state: {
      stage: { path: stagePathFor(project.stateDirectory, transactionId), identity: null, marker: null, digest: null },
      backup: null,
    },
    files: [],
    claude: null,
  };
}

/**
 * Drives an executor to a chosen durable step, leaves a journal on disk, and
 * (optionally) breaks the lease so the executor cannot durably record rollback
 * mode - the on-disk situation a killed process leaves behind.
 */
async function leavePendingJournal(project, { fault, breakLease = false, removal = false } = {}) {
  const lease = {
    paths: project.paths,
    broken: false,
    async assertHeld() {
      if (this.broken) {
        const error = new Error("lease lost");
        error.code = "LOCK_COMPROMISED";
        throw error;
      }
      return true;
    },
  };
  const original = journaledTransactionInternals.onStep;
  journaledTransactionInternals.onStep = async (name) => {
    if (fault.includes(name)) {
      if (breakLease) lease.broken = true;
      const error = new Error(`injected fault at ${name}`);
      error.injected = true;
      throw error;
    }
  };
  try {
    await capture(() => (removal ? runRemovalTransaction(project, { lease }) : runManagedTransaction(project, { lease })));
  } finally {
    journaledTransactionInternals.onStep = original;
    lease.broken = false;
  }
  return lease;
}

/* ================================================================== *
 * Read-only inspection
 * ================================================================== */

test("inspectRecoveryRequirement reports absent, pending, and invalid without mutating anything", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const project = await createProject(root);
    const paths = project.paths;

    assert.deepEqual(await inspectRecoveryRequirement({ paths, root }), { status: "absent" });

    await createJournal(paths, managedDocument(project), { lease: fakeLease(paths) });
    const snapshot = await digestTree(root);
    const pending = await inspectRecoveryRequirement({ paths, root, stateDirectory: project.stateDirectory });
    assert.equal(pending.status, "pending");
    assert.equal(pending.kind, "managed");
    assert.equal(pending.transactionId, TX);
    assert.equal(pending.mode, "forward");
    assert.equal(pending.phase, "prepared");
    assert.deepEqual(await digestTree(root), snapshot, "inspection is read-only");

    // Malformed bytes fail closed as invalid, never as pending.
    await writeFile(paths.journalFile, "{ not json");
    const invalid = await inspectRecoveryRequirement({ paths, root });
    assert.equal(invalid.status, "invalid");
    assert.equal(invalid.code, JOURNAL_ERROR_CODES.JOURNAL_INVALID);
    assert.equal(await readFile(paths.journalFile, "utf8"), "{ not json", "the invalid journal is untouched");

    // A journal bound to another control context is invalid for this one.
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere);
    const unbound = await inspectRecoveryRequirement({ paths, root: elsewhere });
    assert.equal(unbound.status, "invalid");

    // A malformed API call still throws.
    await assert.rejects(() => inspectRecoveryRequirement({}), TypeError);
  });
});

/* ================================================================== *
 * Decision rules and re-entry
 * ================================================================== */

test("recovery is idempotent and returns a bounded result", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const project = await createProject(root);
    const restore = installStepFault("cleanup:journal");
    await capture(() => runManagedTransaction(project)).finally(restore);

    const first = await recover(project);
    assert.deepEqual(Object.keys(first).sort(), ["kind", "outcome", "status", "transactionId"]);
    assert.equal(first.status, "recovered");
    assert.equal(first.kind, "managed");
    assert.equal(first.outcome, "committed");

    const second = await recover(project);
    assert.deepEqual(second, { status: "clean" });

    assert.equal(await readFile(project.configFile, "utf8"), NEW_CONFIG, "the committed state stands");
    assert.deepEqual(await leftoverArtifacts(root), []);
  });
});

test("a forward journal with proven desired canonical state rolls forward", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const project = await createProject(root);
    // The executor fails after the install rename and cannot durably record
    // rollback mode: exactly what a killed process leaves behind.
    const lease = await leavePendingJournal(project, { fault: ["file-write"], breakLease: true });

    const document = await readJournal(project.paths, { allowMissing: true });
    assert.ok(document, "the journal survives");
    assert.equal(document.mode, "forward", "rollback mode was never recorded");
    assert.equal(document.phase, "applying");

    const recovery = await recover(project, lease);
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "committed", "proven desired state means roll forward");

    assert.equal(await readFile(project.configFile, "utf8"), NEW_CONFIG, "the pending file write completed");
    const installed = JSON.parse(await readFile(path.join(project.stateDirectory, "registry.json"), "utf8"));
    assert.equal(installed.fingerprint, project.registry.fingerprint);
    assert.equal((await inspectStateTree(project.stateDirectory)).status, "owned");
    assert.deepEqual(await leftoverArtifacts(root), []);
    assert.equal(await readJournal(project.paths, { allowMissing: true }), null);
  });
});

test("a rollback-mode journal always rolls back to the recorded prior state", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const project = await createProject(root);
    const beforeState = await digestTree(project.stateDirectory);
    await leavePendingJournal(project, { fault: ["file-write", "recovery:files"] });

    const document = await readJournal(project.paths, { allowMissing: true });
    assert.equal(document.mode, "rollback", "rollback mode is durable before recovery runs");

    const recovery = await recover(project);
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "rolled-back");
    assert.equal(await readFile(project.configFile, "utf8"), OLD_CONFIG, "config restored byte for byte");
    assert.deepEqual(await digestTree(project.stateDirectory), beforeState, "prior state restored");
    assert.deepEqual(await leftoverArtifacts(root), []);
  });
});

const RECOVERY_ROLLBACK_STEPS = [
  "recovery:begin",
  "recovery:classify",
  "rollback:begin",
  "recovery:files",
  "file-restore-intent",
  "file-restored",
  "recovery:state",
  "recovery:claude",
  "recovery:verify",
  "recovery:terminal",
  "cleanup:payloads",
  "cleanup:journal",
  "recovery:journal",
];

for (const target of RECOVERY_ROLLBACK_STEPS) {
  test(`recovery interrupted at ${target} converges when it is re-entered`, async () => {
    await withTemp("skill-router-recovery-", async (root) => {
      const project = await createProject(root);
      const beforeState = await digestTree(project.stateDirectory);
      await leavePendingJournal(project, { fault: ["file-write", "recovery:files"] });

      // First recovery attempt dies exactly at the target step.
      const restore = installStepFault(target);
      const failure = await capture(() => recover(project)).finally(restore);
      assert.match(String(failure.message), /injected fault/, "the fault actually fired");
      assert.ok(await exists(project.paths.journalFile), "an interrupted recovery leaves the journal in place");

      // Re-entering completes the rollback idempotently.
      const recovery = await recover(project);
      assert.equal(recovery.status, "recovered");
      assert.equal(recovery.outcome, "rolled-back");
      assert.equal(await readFile(project.configFile, "utf8"), OLD_CONFIG);
      assert.deepEqual(await digestTree(project.stateDirectory), beforeState);
      assert.deepEqual(await leftoverArtifacts(root), []);
      assert.equal(await readJournal(project.paths, { allowMissing: true }), null);

      // And a third pass reports a clean control directory.
      assert.deepEqual(await recover(project), { status: "clean" });
    });
  });
}

test("recovery of a committed journal resumes its exact cleanup when interrupted", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const project = await createProject(root);
    const restore = installStepFault("cleanup:journal");
    await capture(() => runManagedTransaction(project)).finally(restore);
    assert.equal(await readJournal(project.paths, { allowMissing: true }).then((doc) => doc.mode), "committed");

    for (const target of ["cleanup:payloads", "cleanup:journal", "recovery:journal"]) {
      const interrupt = installStepFault(target);
      const failure = await capture(() => recover(project)).finally(interrupt);
      assert.match(String(failure.message), /injected fault/, `interrupted at ${target}`);
      assert.ok(await exists(project.paths.journalFile), "the committed journal survives interrupted cleanup");
    }

    const recovery = await recover(project);
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "committed");
    assert.deepEqual(await leftoverArtifacts(root), []);
    assert.equal(await readFile(project.configFile, "utf8"), NEW_CONFIG, "commit is never rolled back");
  });
});

/* ================================================================== *
 * Fail-closed inputs
 * ================================================================== */

test("a foreign canonical state during rollback raises RECOVERY_CONFLICT and is preserved", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const project = await createProject(root);
    const backupPath = path.join(root, ".skill-router.backup-any");
    await leavePendingJournal(project, { fault: ["file-write", "recovery:files"] });
    const document = await readJournal(project.paths, { allowMissing: true });
    const recordedBackup = document.state.backup.path;
    assert.equal(await exists(recordedBackup), true, "the prior state sits in the backup");

    // Someone replaces the desired canonical state with unattributable content.
    await rm(project.stateDirectory, { recursive: true, force: true });
    await mkdir(project.stateDirectory);
    await writeFile(path.join(project.stateDirectory, "user.txt"), "hands off");

    const failure = await capture(() => recover(project));
    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.equal(await readFile(path.join(project.stateDirectory, "user.txt"), "utf8"), "hands off");
    assert.equal(await exists(recordedBackup), true, "the recorded prior state is never deleted");
    assert.ok(await exists(project.paths.journalFile), "the journal stays for a human decision");
    assert.equal(await exists(backupPath), false, "nothing is created or removed by name guessing");
  });
});

test("a malformed journal fails closed with JOURNAL_INVALID and is left as it is", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const project = await createProject(root);
    await createJournal(project.paths, managedDocument(project), { lease: fakeLease(project.paths) });
    const garbage = '{"schemaVersion":1,"owner":"skill-router"}';
    await writeFile(project.paths.journalFile, garbage);

    const failure = await capture(() => recover(project));
    assert.equal(failure.code, JOURNAL_ERROR_CODES.JOURNAL_INVALID);
    assert.equal(await readFile(project.paths.journalFile, "utf8"), garbage, "the malformed journal is untouched");
    assert.equal((await inspectRecoveryRequirement({ paths: project.paths, root: projectRoot(project) })).status, "invalid");
  });
});

test("recovery requires a held lease and fails closed when it is compromised", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const project = await createProject(root);
    await leavePendingJournal(project, { fault: ["file-write", "recovery:files"] });
    const snapshot = await digestTree(root);

    const failure = await capture(() => recover(project, brokenLease(project.paths)));
    assert.match(failure.message, /lease lost/);
    assert.ok(await exists(project.paths.journalFile), "a compromised lease never advances recovery");
    assert.deepEqual(await digestTree(root), snapshot, "nothing changed");

    await assert.rejects(() => recoverPendingTransaction({ paths: project.paths }), TypeError, "a lease is required");
    await assert.rejects(
      () => recoverPendingTransaction({ paths: project.paths, lease: {} }),
      TypeError,
      "assertHeld is required",
    );
  });
});

test("a journal bound to another root or state directory never recovers", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const project = await createProject(root);
    await leavePendingJournal(project, { fault: ["file-write", "recovery:files"] });
    const failure = await capture(() =>
      recoverPendingTransaction({
        paths: project.paths,
        lease: project.lease,
        root: path.join(root, "other-root"),
        scope: "project",
        stateDirectory: project.stateDirectory,
      }),
    );
    assert.equal(failure.code, JOURNAL_ERROR_CODES.JOURNAL_INVALID);
    assert.ok(await exists(project.paths.journalFile));
  });
});

/* ================================================================== *
 * Child-process SIGKILL fixtures
 * ================================================================== */

function spawnNode(script, argument) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, argument], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("exit", (code, signal) => resolve({ code, signal, output }));
  });
}

const MANAGED_FIXTURE = `
import { writeFile } from "node:fs/promises";
import { applyJournaledManagedTransaction, journaledTransactionInternals } from ${JSON.stringify(path.join(SRC, "transaction.js"))};
import { stageManagedState } from ${JSON.stringify(path.join(SRC, "managed-state.js"))};
import { acquireMutationLock, controlPaths } from ${JSON.stringify(path.join(SRC, "mutation-lock.js"))};

const config = JSON.parse(process.argv[2]);
journaledTransactionInternals.onStep = async (step) => {
  if (step === config.targetStep) {
    await writeFile(config.reachedFile, step, "utf8");
    process.kill(process.pid, "SIGKILL");
  }
};
const paths = controlPaths({ root: config.root });
const lease = await acquireMutationLock(paths, { staleMs: 150, heartbeatMs: 50, timeoutMs: 10000 });
try {
  await applyJournaledManagedTransaction({
    paths,
    lease,
    command: "scan",
    root: config.root,
    scope: "project",
    stateDirectory: config.stateDirectory,
    files: [
      { role: "router-config", path: config.configFile, content: config.newConfig, expectedBefore: config.oldConfig },
    ],
    buildStage: (exact) =>
      stageManagedState(config.stateDirectory, config.registry, {
        stageDirectory: exact,
        installation: config.installation,
        requestDirectory: config.requestDirectory,
        global: false,
      }),
    verify: async () => {},
  });
  await writeFile(config.completedFile, "done", "utf8");
} finally {
  await lease.release();
}
`;

const REMOVAL_FIXTURE = `
import { writeFile } from "node:fs/promises";
import { applyJournaledRemovalTransaction, journaledTransactionInternals } from ${JSON.stringify(path.join(SRC, "transaction.js"))};
import { acquireMutationLock, controlPaths } from ${JSON.stringify(path.join(SRC, "mutation-lock.js"))};

const config = JSON.parse(process.argv[2]);
journaledTransactionInternals.onStep = async (step) => {
  if (step === config.targetStep) {
    await writeFile(config.reachedFile, step, "utf8");
    process.kill(process.pid, "SIGKILL");
  }
};
const paths = controlPaths({ root: config.root });
const lease = await acquireMutationLock(paths, { staleMs: 150, heartbeatMs: 50, timeoutMs: 10000 });
try {
  await applyJournaledRemovalTransaction({
    paths,
    lease,
    command: "uninstall",
    root: config.root,
    scope: "project",
    stateDirectory: config.stateDirectory,
    files: [
      { role: "opencode-config", path: config.openCodeConfig, content: config.detached, expectedBefore: config.attached },
    ],
    verifyLocal: async () => {},
  });
  await writeFile(config.completedFile, "done", "utf8");
} finally {
  await lease.release();
}
`;

async function reclaimLease(paths) {
  // The fixture died holding the lease; wait for the heartbeat to go stale,
  // then reclaim it through the production path (same host + ESRCH only).
  await new Promise((resolve) => setTimeout(resolve, 300));
  return acquireMutationLock(paths, { staleMs: 150, heartbeatMs: 50, timeoutMs: 10000 });
}

test("SIGKILL during a managed transaction is recovered by the next mutating run", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const project = await createProject(root);
    const script = path.join(root, "fixture-managed.mjs");
    await writeFile(script, MANAGED_FIXTURE);
    const reachedFile = path.join(root, "reached.txt");
    const completedFile = path.join(root, "completed.txt");
    const fixture = {
      root,
      targetStep: "file-intent",
      reachedFile,
      completedFile,
      stateDirectory: project.stateDirectory,
      configFile: project.configFile,
      registry: project.registry,
      installation: project.installation,
      requestDirectory: project.requestDirectory,
      newConfig: NEW_CONFIG,
      oldConfig: OLD_CONFIG,
    };

    const result = await spawnNode(script, JSON.stringify(fixture));
    assert.equal(result.signal, "SIGKILL", `fixture died by SIGKILL: ${result.output}`);
    assert.equal(await readFile(reachedFile, "utf8"), "file-intent", "the fixture reached the target step");
    assert.equal(await exists(completedFile), false, "the transaction never completed");

    const document = await readJournal(project.paths, { allowMissing: true });
    assert.ok(document, "the killed process left its journal behind");
    assert.equal(document.mode, "forward", "no rollback mode was recorded");

    const lease = await reclaimLease(project.paths);
    let recovery;
    try {
      recovery = await recover(project, lease);
    } finally {
      await lease.release();
    }
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "committed", "the desired canonical state was already proven");

    assert.equal(await readFile(project.configFile, "utf8"), NEW_CONFIG);
    const installed = JSON.parse(await readFile(path.join(project.stateDirectory, "registry.json"), "utf8"));
    assert.equal(installed.fingerprint, project.registry.fingerprint);
    assert.deepEqual(await leftoverArtifacts(root), []);
    assert.equal(await listEntries(project.paths.controlDirectory).then((entries) => entries.includes("mutation.lock")), false);
  });
});

/* ================================================================== *
 * Phase 7 - legacy broad-mode prior state across crash recovery
 * ================================================================== */

/** Rewrites an attributable state tree into legacy broad modes (0755/0644). */
async function broadenPriorState(directory) {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await broadenPriorState(absolute);
    else await chmod(absolute, 0o644);
  }
  return modeTree(directory);
}

test("a crash before the install rename recovers the exact prior 0755/0644 modes", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const project = await createProject(root);
    // Owner-safe but broad legacy modes: Phase 6 attribution still accepts
    // this state, and recovery must hand it back byte- and mode-exactly.
    const modesBefore = await broadenPriorState(project.stateDirectory);
    const bytesBefore = await digestTree(project.stateDirectory);
    const script = path.join(root, "fixture-managed.mjs");
    await writeFile(script, MANAGED_FIXTURE);
    const reachedFile = path.join(root, "reached.txt");
    const completedFile = path.join(root, "completed.txt");
    const fixture = {
      root,
      targetStep: "state:install",
      reachedFile,
      completedFile,
      stateDirectory: project.stateDirectory,
      configFile: project.configFile,
      registry: project.registry,
      installation: project.installation,
      requestDirectory: project.requestDirectory,
      newConfig: NEW_CONFIG,
      oldConfig: OLD_CONFIG,
    };

    const result = await spawnNode(script, JSON.stringify(fixture));
    assert.equal(result.signal, "SIGKILL", `fixture died by SIGKILL: ${result.output}`);
    assert.equal(
      await readFile(reachedFile, "utf8"),
      "state:install",
      "the fixture died with the prior backed up and the canonical tree gone",
    );

    const lease = await reclaimLease(project.paths);
    let recovery;
    try {
      recovery = await recover(project, lease);
    } finally {
      await lease.release();
    }
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "rolled-back", "the desired tree was never installed, so the prior returns");
    assert.deepEqual(
      await modeTree(project.stateDirectory),
      modesBefore,
      "the exact prior modes are restored, never silently normalized",
    );
    assert.deepEqual(await digestTree(project.stateDirectory), bytesBefore, "the prior bytes are unchanged too");
    assert.deepEqual(await leftoverArtifacts(root), []);
  });
});

test("a crash after install recovers by committing exactly owner-private 0700/0600 state", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const project = await createProject(root);
    await broadenPriorState(project.stateDirectory);
    const script = path.join(root, "fixture-managed.mjs");
    await writeFile(script, MANAGED_FIXTURE);
    const reachedFile = path.join(root, "reached.txt");
    const completedFile = path.join(root, "completed.txt");
    const fixture = {
      root,
      targetStep: "verify",
      reachedFile,
      completedFile,
      stateDirectory: project.stateDirectory,
      configFile: project.configFile,
      registry: project.registry,
      installation: project.installation,
      requestDirectory: project.requestDirectory,
      newConfig: NEW_CONFIG,
      oldConfig: OLD_CONFIG,
    };

    const result = await spawnNode(script, JSON.stringify(fixture));
    assert.equal(result.signal, "SIGKILL", `fixture died by SIGKILL: ${result.output}`);

    const lease = await reclaimLease(project.paths);
    let recovery;
    try {
      recovery = await recover(project, lease);
    } finally {
      await lease.release();
    }
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "committed", "the desired canonical state was already installed");
    for (const entry of await modeTree(project.stateDirectory)) {
      assert.equal(
        entry.mode,
        entry.kind === "directory" ? 0o700 : 0o600,
        `a committed install is exactly owner-only: ${entry.path} is ${entry.mode.toString(8)}`,
      );
    }
    assert.deepEqual(await leftoverArtifacts(root), []);
  });
});

test("SIGKILL during a removal transaction rolls back after lock reclamation", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const project = await createProject(root);
    const plan = await openCodePlan(project.stateDirectory);
    await writeFile(project.openCodeConfig, plan.withSource);
    const beforeState = await digestTree(project.stateDirectory);

    const script = path.join(root, "fixture-removal.mjs");
    await writeFile(script, REMOVAL_FIXTURE);
    const reachedFile = path.join(root, "reached.txt");
    const completedFile = path.join(root, "completed.txt");
    const fixture = {
      root,
      targetStep: "state:rename",
      reachedFile,
      completedFile,
      stateDirectory: project.stateDirectory,
      openCodeConfig: project.openCodeConfig,
      attached: plan.withSource,
      detached: plan.without,
    };

    const result = await spawnNode(script, JSON.stringify(fixture));
    assert.equal(result.signal, "SIGKILL", `fixture died by SIGKILL: ${result.output}`);
    assert.equal(await readFile(reachedFile, "utf8"), "state:rename");
    assert.equal(await exists(completedFile), false);

    const document = await readJournal(project.paths, { allowMissing: true });
    assert.ok(document, "the killed process left its journal behind");
    assert.equal(document.phase, "commit-ready");

    const lease = await reclaimLease(project.paths);
    let recovery;
    try {
      recovery = await recover(project, lease);
    } finally {
      await lease.release();
    }
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "rolled-back", "canonical exact plus absent backup means the rename never happened");

    assert.equal(await exists(project.stateDirectory), true, "state stays canonical");
    assert.deepEqual(await digestTree(project.stateDirectory), beforeState, "prior state untouched");
    assert.equal(await readFile(project.openCodeConfig, "utf8"), plan.withSource, "the detach write was undone");
    assert.deepEqual(await leftoverArtifacts(root), []);
    assert.equal(await readJournal(project.paths, { allowMissing: true }), null);
  });
});

/* ================================================================== *
 * Child-process SIGKILL through the public operation wrappers
 * ================================================================== */

const CRASH_FIXTURE = path.join(here, "fixtures", "crash-operation.mjs");
const CLI = path.join(here, "..", "src", "cli.js");

function spawnCommandLine(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function writeReleaseSkill(root) {
  const source = path.join(root, ".agents", "skills", "release", "SKILL.md");
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, "---\nname: Release\ndescription: Publish releases\n---\n\nRelease it.\n");
}

test("SIGKILL during a public init is recovered by the CLI recover command", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    await writeReleaseSkill(root);
    const reachedFile = path.join(root, "reached.txt");
    const completedFile = path.join(root, "completed.txt");

    const crash = await spawnNode(
      CRASH_FIXTURE,
      JSON.stringify({ operation: "init", root, targetStep: "file-write", reachedFile, completedFile }),
    );
    assert.equal(crash.signal, "SIGKILL", `the wrapper was killed: ${crash.output}`);
    assert.equal(await readFile(reachedFile, "utf8"), "file-write");
    assert.equal(await exists(completedFile), false, "the public operation never completed");

    const paths = controlPaths({ root });
    const document = await readJournal(paths, { allowMissing: true });
    assert.ok(document, "the killed process left its journal behind");
    assert.equal(document.mode, "forward");
    assert.equal(document.phase, "applying");
    assert.equal(await exists(path.join(root, ".skill-router-control", "control.json")), true, "the anchor precedes the journal");

    // Reclaim the dead holder's lease (and release ours again), then recover.
    const reclaimed = await reclaimLease(paths);
    await reclaimed.release();
    const cli = await spawnCommandLine(CLI, ["recover", "--root", root, "--json"]);
    assert.equal(cli.code, 0, cli.stderr);
    const result = JSON.parse(cli.stdout);
    assert.equal(result.command, "recover");
    assert.equal(result.status, "recovered");
    assert.equal(result.kind, "managed");
    assert.equal(result.outcome, "committed", "the desired canonical state was already proven");

    // Exact desired outcome, no unrelated changes, and no artifacts left.
    assert.equal(await exists(path.join(root, ".skill-router.json")), true, "the pending config write completed");
    const openCode = JSON.parse(await readFile(path.join(root, ".opencode", "opencode.json"), "utf8"));
    assert.ok(
      JSON.stringify(openCode).includes(path.join(root, ".skill-router", "opencode-skills")),
      "the OpenCode entry was applied by the roll-forward",
    );
    assert.equal((await inspectStateTree(path.join(root, ".skill-router"))).status, "owned");
    assert.deepEqual(await leftoverArtifacts(root), []);
    assert.equal(await exists(path.join(paths.journalFile)), false);
    const healthy = await checkOperation({ root });
    assert.equal(healthy.healthy, true, "the installation is healthy after recovery");

    // Repeated recovery reports clean — through the operation API this time.
    const again = await recoverOperation({ root });
    assert.deepEqual(again, { command: "recover", status: "clean" });
    assert.deepEqual(await leftoverArtifacts(root), []);
  });
});

test("SIGKILL during a public uninstall is rolled back by the operation recover API", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    await writeReleaseSkill(root);
    await initOperation({ root });
    const openCodeFile = path.join(root, ".opencode", "opencode.json");
    const stateDirectory = path.join(root, ".skill-router");
    const before = {
      openCode: await readFile(openCodeFile, "utf8"),
      state: await digestTree(stateDirectory),
    };
    const reachedFile = path.join(root, "reached.txt");
    const completedFile = path.join(root, "completed.txt");

    const crash = await spawnNode(
      CRASH_FIXTURE,
      JSON.stringify({ operation: "uninstall", root, targetStep: "state:rename", reachedFile, completedFile }),
    );
    assert.equal(crash.signal, "SIGKILL", `the wrapper was killed: ${crash.output}`);
    assert.equal(await readFile(reachedFile, "utf8"), "state:rename");
    assert.equal(await exists(completedFile), false);

    const paths = controlPaths({ root });
    const document = await readJournal(paths, { allowMissing: true });
    assert.ok(document, "the killed process left its journal behind");
    assert.equal(document.kind, "removal");
    assert.equal(document.phase, "commit-ready");
    assert.notEqual(await readFile(openCodeFile, "utf8"), before.openCode, "the local detach already landed");

    const reclaimed = await reclaimLease(paths);
    await reclaimed.release();
    const recovery = await recoverOperation({ root, lockTimeout: 8000 });
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.kind, "removal");
    assert.equal(recovery.outcome, "rolled-back", "canonical state plus absent backup means the rename never happened");

    assert.equal(await readFile(openCodeFile, "utf8"), before.openCode, "the OpenCode detach is undone byte for byte");
    assert.deepEqual(await digestTree(stateDirectory), before.state, "state is restored exactly");
    assert.equal(await exists(paths.journalFile), false);
    assert.deepEqual(await leftoverArtifacts(root), []);
    assert.equal((await checkOperation({ root })).healthy, true);

    // Repeated recovery through the CLI reports clean, in human output too.
    const again = await spawnCommandLine(CLI, ["recover", "--root", root, "--json"]);
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(JSON.parse(again.stdout), { command: "recover", status: "clean" });
    const human = await spawnCommandLine(CLI, ["recover", "--root", root]);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /recover: clean/);
  });
});

/* ================================================================== *
 * Gate 6 remediation fixtures (findings 2-7)
 * ================================================================== */

/**
 * A rollback-mode pending journal whose canonical tree is exactly the staged
 * desired state and whose backup holds the recorded prior - the state a
 * process leaves when it dies after the install rename but before rollback.
 */
async function pendingDesiredRollback(root) {
  const project = await createProject(root);
  await leavePendingJournal(project, { fault: ["file-write", "recovery:files"] });
  const document = await readJournal(project.paths, { allowMissing: true });
  assert.equal(document.mode, "rollback");
  const desired = await inspectStateTree(project.stateDirectory);
  assert.equal(desired.status, "owned");
  return { project, document, desired, backupPath: document.state.backup.path };
}

/**
 * Seeds a durably attributed claim (R3) exactly as the cleanup protocol
 * creates it: an exclusive owner-private 0700 container directory plus its
 * *external* sibling attribution record (0600) binding the transaction, kind,
 * container identity, and - when the artifact was moved - the moved child's
 * identity.
 */
async function seedClaimContainer(artifactPath, transactionId, { kind = "backup", move = true } = {}) {
  const containerPath = claimPathFor(artifactPath, transactionId);
  await mkdir(containerPath, { mode: 0o700 });
  if (process.platform !== "win32") await chmod(containerPath, 0o700);
  const stat = await lstat(containerPath);
  let movedPath = null;
  if (move) {
    movedPath = path.join(containerPath, `moved-${"ab".repeat(16)}`);
    await rename(artifactPath, movedPath);
  }
  const childStat = movedPath ? await lstat(movedPath) : null;
  await writeFile(
    `${containerPath}.json`,
    `${JSON.stringify({
      schema: 1,
      owner: "skill-router",
      transactionId,
      kind,
      container: { dev: Number(stat.dev), ino: Number(stat.ino) },
      ...(childStat ? { child: { dev: Number(childStat.dev), ino: Number(childStat.ino) } } : {}),
    })}\n`,
    { mode: 0o600 },
  );
  return { containerPath, movedPath };
}

function claimEntriesIn(directory) {
  return readdir(directory).then((names) => names.filter((name) => name.includes(".claim-")));
}

async function ownedMarkerTree(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, STATE_MARKER_FILE), `${STATE_MARKER_CONTENT}\n`, { mode: 0o600 });
  await writeFile(path.join(directory, "registry.json"), `${JSON.stringify({ skills: [] })}\n`, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
  return directory;
}

/* ================================================================== *
 * Finding 2 - managed rollback proves the exact prior backup first
 * ================================================================== */

test("managed rollback keeps the desired canonical tree when the recorded prior backup is missing", async () => {
  await withTemp("skill-router-remediation-", async (root) => {
    const { project, backupPath, desired } = await pendingDesiredRollback(root);
    await rm(backupPath, { recursive: true, force: true });

    const failure = await capture(() => recover(project));
    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_AMBIGUOUS);
    assert.match(failure.message, /left untouched/);

    const canonical = await inspectStateTree(project.stateDirectory);
    assert.equal(canonical.status, "owned");
    assert.equal(canonical.digest, desired.digest, "the desired canonical tree was never touched");
    assert.equal(await exists(backupPath), false, "nothing was invented at the backup path");
    assert.ok(await exists(project.paths.journalFile), "the journal stays for a human decision");
    assert.deepEqual(await claimEntriesIn(root), [], "no cleanup claim was created");
    assert.equal(await readFile(project.configFile, "utf8"), OLD_CONFIG, "configs are untouched");
  });
});

for (const variant of ["foreign", "changed", "symlink", "special"]) {
  test(`managed rollback refuses a ${variant} backup and preserves the desired canonical tree`, async () => {
    await withTemp("skill-router-remediation-", async (root) => {
      const { project, backupPath, desired } = await pendingDesiredRollback(root);
      await rm(backupPath, { recursive: true, force: true });
      if (variant === "foreign") {
        await mkdir(backupPath);
        await writeFile(path.join(backupPath, "hands-off.txt"), "keep");
      } else if (variant === "changed") {
        // Same directory identity, different tree: the recorded digest fails.
        await mkdir(backupPath);
        await writeFile(path.join(backupPath, STATE_MARKER_FILE), `${STATE_MARKER_CONTENT}\n`, { mode: 0o600 });
        await writeFile(path.join(backupPath, "registry.json"), "tampered\n", { mode: 0o600 });
      } else if (variant === "symlink") {
        const innocent = path.join(root, "innocent-tree");
        await ownedMarkerTree(innocent);
        await symlink(innocent, backupPath);
      } else {
        if (spawnSync("mkfifo", [backupPath]).status !== 0) return;
      }

      const failure = await capture(() => recover(project));
      assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
      assert.match(failure.message, /left untouched/);

      const canonical = await inspectStateTree(project.stateDirectory);
      assert.equal(canonical.status, "owned");
      assert.equal(canonical.digest, desired.digest, "the desired canonical tree was never touched");
      assert.ok(await exists(project.paths.journalFile), "the journal stays for a human decision");
      assert.deepEqual(await claimEntriesIn(root), [], "no cleanup claim was created");
      if (variant === "foreign") {
        assert.equal(await readFile(path.join(backupPath, "hands-off.txt"), "utf8"), "keep");
      }
      if (variant === "changed") {
        assert.equal(await readFile(path.join(backupPath, "registry.json"), "utf8"), "tampered\n");
      }
      if (variant === "symlink") {
        assert.equal((await lstat(backupPath)).isSymbolicLink(), true, "the symlink is preserved");
      }
    });
  });
}

/* ================================================================== *
 * Finding 6 - path-race-safe cleanup claims (recovery side)
 * ================================================================== */

test("an interrupted state-cleanup claim is recognized, proved, and finished on re-entry", async () => {
  await withTemp("skill-router-remediation-", async (root) => {
    // Committed managed journal whose backup cleanup died after the claim
    // rename: the backup sits at its exact derived claim path.
    const project = await createProject(root);
    const restore = installStepFault("cleanup:backup");
    const failure = await capture(() => runManagedTransaction(project)).finally(restore);
    assert.match(failure.message, /injected fault/);
    const document = await readJournal(project.paths, { allowMissing: true });
    assert.equal(document.mode, "committed");
    const backupPath = document.state.backup.path;
    const claimPath = claimPathFor(backupPath, document.transactionId);
    await seedClaimContainer(backupPath, document.transactionId, { kind: "backup" });
    assert.equal(await exists(backupPath), false);

    const recovery = await recover(project);
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "committed");
    assert.equal(await exists(claimPath), false, "the recognized claim is proved and finished");
    assert.equal(await exists(project.stateDirectory), true, "the canonical tree is untouched");
    assert.equal(await readFile(project.configFile, "utf8"), NEW_CONFIG, "commit is never rolled back");
    assert.deepEqual(await leftoverArtifacts(root), []);
    assert.equal(await readJournal(project.paths, { allowMissing: true }), null);
  });
});

test("rollback canonical removal is claim-based and re-enterable after a crash", async () => {
  await withTemp("skill-router-remediation-", async (root) => {
    const { project, document, backupPath } = await pendingDesiredRollback(root);
    const backupInfo = await inspectStateTree(backupPath);
    assert.equal(backupInfo.status, "owned");
    // Crash after the canonical desired tree was renamed to its cleanup claim.
    const canonicalClaim = claimPathFor(project.stateDirectory, document.transactionId);
    await seedClaimContainer(project.stateDirectory, document.transactionId, { kind: "canonical" });

    const recovery = await recover(project);
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "rolled-back");
    const restored = await inspectStateTree(project.stateDirectory);
    assert.equal(restored.status, "owned");
    assert.equal(restored.digest, backupInfo.digest, "the recorded prior state is back at the canonical path");
    assert.equal(await exists(canonicalClaim), false, "the recognized claim is proved and finished");
    assert.equal(await exists(backupPath), false, "the backup was restored, not left behind");
    assert.equal(await readFile(project.configFile, "utf8"), OLD_CONFIG);
    assert.deepEqual(await leftoverArtifacts(root), []);
  });
});

test("an original artifact and its cleanup claim together are ambiguous and untouched", async () => {
  await withTemp("skill-router-remediation-", async (root) => {
    const project = await createProject(root);
    const restore = installStepFault("cleanup:backup");
    await capture(() => runManagedTransaction(project)).finally(restore);
    const document = await readJournal(project.paths, { allowMissing: true });
    const backupPath = document.state.backup.path;
    const claimPath = claimPathFor(backupPath, document.transactionId);
    // Both the original backup and a claim exist at the same time.
    await ownedMarkerTree(claimPath);

    const failure = await capture(() => recover(project));
    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_AMBIGUOUS);
    assert.equal(await exists(backupPath), true, "the original backup is preserved");
    assert.equal(await exists(claimPath), true, "the claim is preserved");
    assert.ok(await exists(project.paths.journalFile), "the journal stays for a human decision");
  });
});

test("a foreign cleanup claim is preserved and never adopted", async () => {
  await withTemp("skill-router-remediation-", async (root) => {
    const project = await createProject(root);
    const restore = installStepFault("cleanup:backup");
    await capture(() => runManagedTransaction(project)).finally(restore);
    const document = await readJournal(project.paths, { allowMissing: true });
    const backupPath = document.state.backup.path;
    const claimPath = claimPathFor(backupPath, document.transactionId);
    await rm(backupPath, { recursive: true, force: true });
    // An owned tree at the claim path that is NOT the recorded prior state.
    await mkdir(claimPath, { mode: 0o700 });
    await writeFile(path.join(claimPath, STATE_MARKER_FILE), `${STATE_MARKER_CONTENT}\n`, { mode: 0o600 });
    await writeFile(path.join(claimPath, "registry.json"), "not-the-prior\n", { mode: 0o600 });
    if (process.platform !== "win32") await chmod(claimPath, 0o700);

    const failure = await capture(() => recover(project));
    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.match(failure.message, /preserved/);
    assert.equal(await exists(claimPath), true, "the foreign claim survives");
    assert.equal(await readFile(path.join(claimPath, "registry.json"), "utf8"), "not-the-prior\n");
    assert.ok(await exists(project.paths.journalFile), "the journal stays for a human decision");
  });
});

test("two concurrent artifact cleanups of the same tree resolve with exactly one winner", async () => {
  await withTemp("skill-router-remediation-", async (root) => {
    const lease = fakeLease(null);
    const artifact = await ownedMarkerTree(path.join(root, "artifact"));
    const info = await inspectStateTree(artifact);
    const expectation = { identity: info.identity, digest: info.digest };
    const options = { lease, artifactPath: artifact, transactionId: TX, expectation, label: "backup" };

    const [first, second] = await Promise.all([
      cleanupStateArtifactViaClaim(options),
      cleanupStateArtifactViaClaim(options),
    ]);
    assert.ok(["removed", "absent"].includes(first));
    assert.ok(["removed", "absent"].includes(second));
    assert.equal(await exists(artifact), false, "the artifact is gone");
    assert.deepEqual(await claimEntriesIn(root), [], "no claim or temporary directory remains");
    assert.equal(await cleanupStateArtifactViaClaim(options), "absent", "cleanup is idempotent");
  });
});

test("a cleanup claim replaced between rename and verification is preserved, never deleted", async () => {
  await withTemp("skill-router-remediation-", async (root) => {
    const lease = fakeLease(null);
    const artifact = await ownedMarkerTree(path.join(root, "artifact"));
    const info = await inspectStateTree(artifact);
    const expectation = { identity: info.identity, digest: info.digest };

    const originalRename = journaledTransactionInternals.claimRename;
    let swaps = 0;
    journaledTransactionInternals.claimRename = async (from, to) => {
      await originalRename(from, to);
      if (from === artifact && swaps === 0) {
        swaps += 1;
        await rm(to, { recursive: true, force: true });
        await ownedMarkerTree(to);
        await writeFile(path.join(to, "registry.json"), "replacement\n", { mode: 0o600 });
      }
    };
    let failure = null;
    try {
      failure = await capture(() =>
        cleanupStateArtifactViaClaim({ lease, artifactPath: artifact, transactionId: TX, expectation, label: "backup" }),
      );
    } finally {
      journaledTransactionInternals.claimRename = originalRename;
    }
    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.match(failure.message, /preserved/);
    assert.equal(swaps, 1, "the rename actually ran");
    const claimPath = claimPathFor(artifact, TX);
    assert.equal(await exists(claimPath), true, "the claim container is preserved at its derived path");
    const movedChild = (await readdir(claimPath)).find((name) => name.startsWith("moved-"));
    assert.equal(
      await readFile(path.join(claimPath, movedChild, "registry.json"), "utf8"),
      "replacement\n",
      "the replacement inside the claim is preserved byte for byte",
    );
    assert.equal(await exists(artifact), false, "nothing is adopted back at the original path");
  });
});

test("a group-writable canonical root fails rollback closed and is preserved", async () => {
  await withTemp("skill-router-remediation-", async (root) => {
    const { project, backupPath } = await pendingDesiredRollback(root);
    if (process.platform === "win32") return;
    await chmod(project.stateDirectory, 0o777);

    const failure = await capture(() => recover(project));
    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.equal((await lstat(project.stateDirectory)).mode & 0o777, 0o777, "the writable root is untouched");
    assert.equal((await inspectStateTree(backupPath)).status, "owned", "the recorded prior state is intact");
    assert.ok(await exists(project.paths.journalFile), "the journal stays for a human decision");
  });
});

/* ================================================================== *
 * Claude fixtures for remediation coverage (findings 3 and 4)
 * ================================================================== */

async function claudeFixture(root) {
  const project = await createProject(root);
  const identity = claudeIdentity({ global: false, stateDirectory: project.stateDirectory });
  const claudePlan = await planClaudePlugin({
    registry: project.registry,
    identity,
    stateDirectory: project.stateDirectory,
    requestDirectory: project.requestDirectory,
    recorded: null,
  });
  const installation = buildInstallation({
    global: false,
    stateDirectory: project.stateDirectory,
    harnesses: ["opencode", "claude"],
    claude: { fingerprint: claudePlan.fingerprint, version: claudePlan.version },
  });
  const registration = claudeRegistrationPlan({
    identity,
    stateDirectory: project.stateDirectory,
    version: claudePlan.version,
  });
  const runner = createFakeClaudeRunner();
  const env = {};
  const metadata = {
    reference: registration.reference,
    scope: registration.scope,
    marketplace: identity.marketplace,
    marketplaceRoot: path.join(project.stateDirectory, "claude"),
    version: claudePlan.version,
    prior: "absent",
    desired: "healthy",
  };
  const buildStage = stageAt(project.stateDirectory, project.registry, {
    global: false,
    installation,
    claudePlan,
    requestDirectory: project.requestDirectory,
  });
  return { ...project, identity, claudePlan, installation, registration, runner, env, metadata, buildStage, root };
}

function managedClaudeOptions(fixture, extra = {}) {
  const base = {
    buildStage: fixture.buildStage,
    claudeExec: fixture.runner,
    claudeEnv: fixture.env,
    cwd: fixture.root,
    claude: {
      metadata: fixture.metadata,
      apply: ({ observer }) =>
        registerClaude({
          plan: fixture.registration,
          exec: fixture.runner,
          actions: [],
          cwd: fixture.root,
          env: fixture.env,
          observer,
        }),
    },
  };
  return {
    ...base,
    ...extra,
    // Merge so overrides can adjust the recorded metadata without losing the
    // registration hook.
    claude: { ...base.claude, ...(extra.claude ?? {}) },
  };
}

async function leavePendingClaudeJournal(fixture, { fault, breakLease = false, overrides = {} }) {
  const lease = {
    paths: fixture.paths,
    broken: false,
    async assertHeld() {
      if (this.broken) {
        const error = new Error("lease lost");
        error.code = "LOCK_COMPROMISED";
        throw error;
      }
      return true;
    },
  };
  const original = journaledTransactionInternals.onStep;
  journaledTransactionInternals.onStep = async (name) => {
    if (fault.includes(name)) {
      if (breakLease) lease.broken = true;
      const error = new Error(`injected fault at ${name}`);
      error.injected = true;
      throw error;
    }
  };
  try {
    await capture(() => runManagedTransaction(fixture, { ...managedClaudeOptions(fixture, overrides), lease }));
  } finally {
    journaledTransactionInternals.onStep = original;
    lease.broken = false;
  }
  return lease;
}

function recoverClaudeFixture(fixture, extra = {}) {
  return recoverPendingTransaction({
    paths: fixture.paths,
    lease: extra.lease ?? fixture.lease,
    root: fixture.root,
    scope: "project",
    stateDirectory: fixture.stateDirectory,
    claudeExec: fixture.runner,
    claudeEnv: fixture.env,
    cwd: fixture.root,
  });
}

async function installClaudeState(fixture) {
  const exact = path.join(path.dirname(fixture.stateDirectory), ".state.stage-manual");
  await stageManagedState(fixture.stateDirectory, fixture.registry, {
    stageDirectory: exact,
    installation: fixture.installation,
    claudePlan: fixture.claudePlan,
    requestDirectory: fixture.requestDirectory,
    global: false,
  });
  await rm(fixture.stateDirectory, { recursive: true, force: true });
  await rename(exact, fixture.stateDirectory);
  await registerClaude({
    plan: fixture.registration,
    exec: fixture.runner,
    actions: [],
    cwd: fixture.root,
    env: fixture.env,
  });
  const stat = await lstat(fixture.stateDirectory);
  return { stateIdentity: { path: fixture.stateDirectory, ino: Number(stat.ino), dev: Number(stat.dev) } };
}

async function removalClaudeFixture(root) {
  const fixture = await claudeFixture(root);
  const { stateIdentity } = await installClaudeState(fixture);
  const opencodePlan = await openCodePlan(fixture.stateDirectory);
  await writeFile(fixture.openCodeConfig, opencodePlan.withSource);
  return { ...fixture, stateIdentity, opencodePlan };
}

function removalClaudeRun(fixture, overrides = {}) {
  const detachOptions = {
    plan: fixture.inspected ?? null,
    installation: fixture.installation,
    exec: fixture.runner,
    cwd: fixture.root,
    env: fixture.env,
  };
  return runRemovalTransaction(fixture, {
    stateIdentity: fixture.stateIdentity,
    files: [
      {
        role: "opencode-config",
        path: fixture.openCodeConfig,
        content: fixture.opencodePlan.without,
        expectedBefore: fixture.opencodePlan.withSource,
      },
    ],
    claudeExec: fixture.runner,
    claudeEnv: fixture.env,
    cwd: fixture.root,
    claude: { metadata: { ...fixture.metadata, prior: "healthy", desired: "absent" } },
    applyExternal: ({ observer }) => detachClaude({ ...detachOptions, observer }),
    ...overrides,
  });
}

/* ================================================================== *
 * Finding 3 - committed journals reverify every endpoint before cleanup
 * ================================================================== */

test("a committed managed journal reverifies the canonical tree and configs before any cleanup", async () => {
  const variants = ["canonical-mutated", "config-mutated", "canonical-removed"];
  for (const variant of variants) {
    await withTemp(`skill-router-committed-${variant}-`, async (root) => {
      const project = await createProject(root);
      const restore = installStepFault("cleanup:backup");
      const failure = await capture(() => runManagedTransaction(project)).finally(restore);
      assert.match(failure.message, /injected fault/);
      const document = await readJournal(project.paths, { allowMissing: true });
      assert.equal(document.mode, "committed", "the journal is committed with artifacts retained");
      const backupPath = document.state.backup.path;
      const canonicalBytes = await readFile(
        path.join(project.stateDirectory, "registry.json"),
        "utf8",
      );
      const configBytes = await readFile(project.configFile, "utf8");
      assert.equal(configBytes, NEW_CONFIG);

      // Mutate one recorded endpoint; recovery must refuse with zero mutations.
      let undo = async () => {};
      if (variant === "canonical-mutated") {
        const file = path.join(project.stateDirectory, "registry.json");
        await writeFile(file, `${canonicalBytes}tampered\n`);
        undo = () => writeFile(file, canonicalBytes);
      } else if (variant === "config-mutated") {
        await writeFile(project.configFile, '{"concurrent":true}\n');
        undo = () => writeFile(project.configFile, configBytes);
      } else {
        const aside = path.join(root, "canonical-aside");
        await rename(project.stateDirectory, aside);
        undo = () => rename(aside, project.stateDirectory);
      }

      const refused = await capture(() => recover(project));
      assert.equal(refused.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT, `${variant} fails closed`);
      assert.ok(await exists(project.paths.journalFile), "the committed journal is retained");
      assert.ok(await exists(backupPath), "the recorded backup is retained");
      const payloads = (await listEntries(root)).filter((name) => name.includes(".skill-router-"));
      assert.ok(payloads.length > 0, "the recorded payloads are retained");
      const entriesAfterFailure = await listEntries(root);
      assert.deepEqual(
        entriesAfterFailure.filter((name) => name.includes(".claim-")),
        [],
        "no cleanup claim is created when verification fails",
      );

      // Restoring the recorded endpoint lets committed cleanup finish.
      await undo();
      const recovery = await recover(project);
      assert.equal(recovery.status, "recovered");
      assert.equal(recovery.outcome, "committed");
      assert.deepEqual(await leftoverArtifacts(root), []);
      assert.equal(await readFile(project.configFile, "utf8"), NEW_CONFIG, "commit is never rolled back");
    });
  }
});

test("a committed managed journal reverifies the exact Claude registration before cleanup", async () => {
  const mutations = [
    ["wrong version", (state) => { state.plugins[0].version = "9.9.9"; }],
    ["wrong scope", (state) => { state.plugins[0].scope = "user"; }],
    ["disabled plugin", (state) => { state.plugins[0].enabled = false; }],
    ["duplicate plugin", (state) => { state.plugins.push({ ...state.plugins[0] }); }],
    [
      "extra marketplace plugin",
      (state) => { state.plugins.push({ id: `other@${state.marketplaces[0].name}`, scope: "local", version: "0.1.0" }); },
    ],
    ["wrong declaration path", (state, fixture) => { state.marketplaces[0].path = path.join(fixture.root, "elsewhere"); }],
  ];
  for (const [label, mutate] of mutations) {
    await withTemp(`skill-router-committed-claude-${label.replace(/ /g, "-")}-`, async (root) => {
      const fixture = await claudeFixture(root);
      const restore = installStepFault("cleanup:backup");
      const failure = await capture(() => runManagedTransaction(fixture, managedClaudeOptions(fixture))).finally(restore);
      assert.match(failure.message, /injected fault/);
      const document = await readJournal(fixture.paths, { allowMissing: true });
      assert.equal(document.mode, "committed");
      assert.ok(document.claude, "the committed journal records the Claude section");

      mutate(fixture.runner.state, fixture);
      const snapshot = JSON.stringify(fixture.runner.state);
      const refused = await capture(() => recoverClaudeFixture(fixture));
      assert.equal(refused.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT, `${label} fails closed`);
      assert.equal(JSON.stringify(fixture.runner.state), snapshot, "recovery issues zero Claude mutations");
      assert.ok(await exists(fixture.paths.journalFile), "the journal is retained");
      assert.ok(await exists(document.state.backup.path), "the backup is retained");

      // Repair the registration in place; committed cleanup then completes.
      const { state } = fixture.runner;
      if (label === "wrong declaration path") state.marketplaces[0].path = fixture.metadata.marketplaceRoot;
      else if (label === "duplicate plugin") state.plugins.pop();
      else if (label === "extra marketplace plugin") state.plugins.pop();
      else if (label === "wrong version") state.plugins[0].version = fixture.metadata.version;
      else if (label === "wrong scope") state.plugins[0].scope = fixture.metadata.scope;
      else if (label === "disabled plugin") state.plugins[0].enabled = true;

      const recovery = await recoverClaudeFixture(fixture);
      assert.equal(recovery.status, "recovered");
      assert.equal(recovery.outcome, "committed");
      assert.deepEqual(await leftoverArtifacts(root), []);
    });
  }
});

test("a committed removal journal reverifies absence and detachment before cleanup", async () => {
  for (const variant of ["canonical-recreated", "config-mutated"]) {
    await withTemp(`skill-router-committed-removal-${variant}-`, async (root) => {
      const project = await createProject(root);
      const plan = await openCodePlan(project.stateDirectory);
      await writeFile(project.openCodeConfig, plan.withSource);
      const restore = installStepFault("cleanup:backup");
      const failure = await capture(() =>
        runRemovalTransaction(project, {
          files: [
            {
              role: "opencode-config",
              path: project.openCodeConfig,
              content: plan.without,
              expectedBefore: plan.withSource,
            },
          ],
        }),
      ).finally(restore);
      assert.match(failure.message, /injected fault/);
      const document = await readJournal(project.paths, { allowMissing: true });
      assert.equal(document.mode, "committed");
      const backupPath = document.state.backup.path;
      assert.equal(await exists(project.stateDirectory), false, "the commit rename happened");

      let undo = async () => {};
      if (variant === "canonical-recreated") {
        await ownedMarkerTree(project.stateDirectory);
        undo = () => rm(project.stateDirectory, { recursive: true, force: true });
      } else {
        await writeFile(project.openCodeConfig, '{"reappeared":true}\n');
        undo = () => writeFile(project.openCodeConfig, plan.without);
      }

      const refused = await capture(() => recover(project));
      assert.equal(refused.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT, `${variant} fails closed`);
      assert.ok(await exists(project.paths.journalFile), "the journal is retained");
      assert.ok(await exists(backupPath), "the backup is retained");

      await undo();
      const recovery = await recover(project);
      assert.equal(recovery.status, "recovered");
      assert.equal(recovery.outcome, "committed");
      assert.deepEqual(await leftoverArtifacts(root), []);
    });
  }
});

test("a committed removal journal reverifies exact Claude absence with zero mutations", async () => {
  await withTemp("skill-router-committed-removal-claude-", async (root) => {
    const fixture = await removalClaudeFixture(root);
    const detachOptions = {
      plan: null,
      installation: fixture.installation,
      exec: fixture.runner,
      cwd: fixture.root,
      env: fixture.env,
    };
    // Inspect exactly like the removal planner does before detaching.
    const inspected = await inspectGeneratedClaudeRemovalSource({
      identity: fixture.identity,
      stateDirectory: fixture.stateDirectory,
      installation: fixture.installation,
      exec: fixture.runner,
      cwd: fixture.root,
      env: fixture.env,
    });
    fixture.inspected = inspected;
    detachOptions.plan = inspected;
    const observeAbsent = async () => {
      const observed = await observeClaudeUninstallState(detachOptions);
      const evaluated = classifyClaudeUninstallState(observed, inspected, fixture.installation);
      if (evaluated.classification !== "absent") throw new Error("Claude registration is not detached");
    };
    const restore = installStepFault("cleanup:backup");
    const failure = await capture(() =>
      removalClaudeRun(fixture, { verifyExternal: observeAbsent, verifyIntegrations: observeAbsent }),
    ).finally(restore);
    assert.match(failure.message, /injected fault/);
    const document = await readJournal(fixture.paths, { allowMissing: true });
    assert.equal(document.mode, "committed");
    assert.ok(document.claude);

    // The registration reappears against the moved state source (as a stale
    // re-run could): read-only verification must refuse cleanup with zero
    // mutations of the integration.
    const backupPath = document.state.backup.path;
    const backupRegistration = claudeRegistrationPlan({
      identity: fixture.identity,
      stateDirectory: backupPath,
      version: fixture.metadata.version,
    });
    await registerClaude({
      plan: backupRegistration,
      exec: fixture.runner,
      actions: [],
      cwd: fixture.root,
      env: fixture.env,
    });
    const snapshot = JSON.stringify(fixture.runner.state);
    const refused = await capture(() => recoverClaudeFixture(fixture));
    assert.equal(refused.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.equal(JSON.stringify(fixture.runner.state), snapshot, "post-commit recovery never mutates integrations");
    assert.ok(await exists(fixture.paths.journalFile), "the journal is retained");
    assert.ok(await exists(document.state.backup.path), "the backup is retained");

    // Detach the reappeared registration with the exact CLI steps the
    // adapter uses; committed cleanup then completes.
    await fixture.runner(["plugin", "uninstall", fixture.registration.reference, "--scope", "local"], {
      cwd: fixture.root,
      env: fixture.env,
    });
    await fixture.runner(["plugin", "marketplace", "remove", fixture.identity.marketplace, "--scope", "local"], {
      cwd: fixture.root,
      env: fixture.env,
    });
    const recovery = await recoverClaudeFixture(fixture);
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "committed");
    assert.deepEqual(await leftoverArtifacts(root), []);
  });
});

/* ================================================================== *
 * Finding 4 - action-aware Claude recovery
 * ================================================================== */

test("roll-forward accepts the exact desired registration without mutating it", async () => {
  await withTemp("skill-router-claude-desired-", async (root) => {
    const fixture = await claudeFixture(root);
    await leavePendingClaudeJournal(fixture, { fault: ["journal:proven"], breakLease: true });
    const document = await readJournal(fixture.paths, { allowMissing: true });
    assert.equal(document.mode, "forward");
    assert.equal(fixture.runner.state.plugins.length, 1, "the registration is fully healthy");

    const snapshot = JSON.stringify(fixture.runner.state);
    const recovery = await recoverClaudeFixture(fixture);
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "committed");
    assert.equal(JSON.stringify(fixture.runner.state), snapshot, "healthy state is accepted read-only");
    assert.deepEqual(await leftoverArtifacts(root), []);
  });
});

test("roll-forward registers from an exact absent state and journals the retry actions", async () => {
  await withTemp("skill-router-claude-absent-", async (root) => {
    const fixture = await claudeFixture(root);
    await leavePendingClaudeJournal(fixture, { fault: ["claude"], breakLease: true });
    const before = await readJournal(fixture.paths, { allowMissing: true });
    assert.equal(before.claude.actions.length, 0, "no Claude action was recorded before the crash");

    const recovery = await recoverClaudeFixture(fixture);
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "committed");
    assert.equal(fixture.runner.state.plugins.length, 1, "the exact plugin is registered");
    const after = await readJournal(fixture.paths, { allowMissing: true });
    assert.equal(after, null, "the recovered journal is removed");
    assert.deepEqual(await leftoverArtifacts(root), []);

    // The recovery run itself journaled durable intents and outcomes: run the
    // same scenario and inspect the journal mid-flight via a fault.
    const second = await claudeFixture(path.join(root, "again"));
    await leavePendingClaudeJournal(second, { fault: ["claude"], breakLease: true });
    const pending = await readJournal(second.paths, { allowMissing: true });
    assert.ok(pending, "a fresh pending journal exists");
    assert.equal(pending.claude.actions.length, 0);
    const intentFault = installStepFault("cleanup:journal");
    await capture(() => recoverClaudeFixture(second)).finally(intentFault);
    const mid = await readJournal(second.paths, { allowMissing: true });
    assert.ok(mid && mid.claude.actions.length >= 2, "the retry recorded durable intents and observed outcomes");
    const sequences = mid.claude.actions.map((entry) => entry.sequence);
    assert.deepEqual([...sequences].sort((a, b) => a - b), sequences, "sequences stay strictly ordered");
    assert.ok(mid.claude.actions.every((entry) => entry.status === "observed"));
    const finished = await recoverClaudeFixture(second);
    assert.equal(finished.status, "recovered");
  });
});

test("roll-forward reapplies a pending recorded action and journals the retry", async () => {
  await withTemp("skill-router-claude-partial-", async (root) => {
    const fixture = await claudeFixture(root);
    // Crash after the marketplace-add CLI ran but before its observed outcome
    // was journaled: the recorded action is a pending intent.
    await leavePendingClaudeJournal(fixture, { fault: ["claude-observed"], breakLease: true });
    const pending = await readJournal(fixture.paths, { allowMissing: true });
    assert.equal(pending.claude.actions.length, 1, "only the marketplace-add intent was journaled");
    assert.equal(pending.claude.actions[0].type, "marketplace-add");
    assert.equal(pending.claude.actions[0].status, "intent");
    assert.equal(fixture.runner.state.marketplaces.length, 1, "the marketplace landed");
    assert.equal(fixture.runner.state.plugins.length, 0, "the plugin never installed");

    // Recovery attributes the intermediate to the pending action and
    // re-applies only the remaining recorded work, journaling the retry.
    const intentFault = installStepFault("cleanup:journal");
    const failure = await capture(() => recoverClaudeFixture(fixture)).finally(intentFault);
    assert.match(String(failure.message), /injected fault/, "the fault actually fired");
    const mid = await readJournal(fixture.paths, { allowMissing: true });
    assert.ok(mid, "the interrupted recovery leaves the journal");
    const sequences = mid.claude.actions.map((entry) => entry.sequence);
    assert.deepEqual([...sequences].sort((a, b) => a - b), sequences, "sequences stay strictly ordered");
    assert.ok(
      mid.claude.actions.some((entry) => entry.type === "plugin-install" && entry.status === "observed"),
      "the retry journaled a durable intent and its observed outcome",
    );
    assert.equal(mid.claude.actions[0].status, "intent", "the original intent is retained");

    const recovery = await recoverClaudeFixture(fixture);
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "committed");
    assert.equal(fixture.runner.state.plugins.length, 1, "the exact plugin is installed");
    assert.equal(fixture.runner.state.marketplaces.length, 1, "the marketplace is not duplicated");
    assert.deepEqual(await leftoverArtifacts(root), []);
  });
});

test("a plugin missing with an absent recorded baseline is repaired by roll-forward", async () => {
  await withTemp("skill-router-claude-baseline-absent-", async (root) => {
    const fixture = await claudeFixture(root);
    await leavePendingClaudeJournal(fixture, { fault: ["journal:proven"], breakLease: true });
    const document = await readJournal(fixture.paths, { allowMissing: true });
    const install = document.claude.actions.find((entry) => entry.type === "plugin-install");
    assert.equal(install.status, "observed");
    assert.equal(install.outcome?.status, "succeeded", "the recorded action is proven");
    assert.equal(document.claude.prior, "absent", "the recorded baseline never held the plugin");

    // Absence is exact when the recorded baseline is absent, even after a
    // proven action: roll-forward repairs to the desired state.
    fixture.runner.state.plugins = [];
    const recovery = await recoverClaudeFixture(fixture);
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "committed");
    assert.equal(fixture.runner.state.plugins.length, 1, "the exact plugin is re-installed");
    assert.equal(fixture.runner.state.marketplaces.length, 1, "the marketplace is not duplicated");
    assert.deepEqual(await leftoverArtifacts(root), []);
  });
});

test("unrecorded Claude partial state is a zero-mutation conflict, absent state still registers", async () => {
  await withTemp("skill-router-claude-unrecorded-", async (root) => {
    const fixture = await claudeFixture(root);
    await leavePendingClaudeJournal(fixture, { fault: ["claude"], breakLease: true });
    // A marketplace declaration appears with no journal action recording it.
    await fixture.runner(
      [
        "plugin",
        "marketplace",
        "add",
        fixture.identity.marketplace,
        "--scope",
        "local",
        path.join(fixture.stateDirectory, "claude"),
      ],
      { cwd: fixture.root, env: fixture.env },
    );
    assert.equal(fixture.runner.state.marketplaces.length, 1);

    const snapshot = JSON.stringify(fixture.runner.state);
    const refused = await capture(() => recoverClaudeFixture(fixture));
    assert.equal(refused.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.match(refused.message, /cannot be attributed/);
    assert.equal(JSON.stringify(fixture.runner.state), snapshot, "zero mutations on unrecorded state");
    assert.ok(await exists(fixture.paths.journalFile), "the journal is retained");

    // Removing the unrecorded mutation makes the state exactly absent again,
    // which is the transaction's plain intent: registration proceeds.
    await fixture.runner(
      ["plugin", "marketplace", "remove", fixture.identity.marketplace, "--scope", "local"],
      { cwd: fixture.root, env: fixture.env },
    );
    const recovery = await recoverClaudeFixture(fixture);
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "committed");
    assert.equal(fixture.runner.state.plugins.length, 1);
    assert.deepEqual(await leftoverArtifacts(root), []);
  });
});

test("wrong path, version, scope, disabled, duplicate, and extra-plugin drift are zero-mutation conflicts", async () => {
  const drifts = [
    ["wrong declaration path", (state, fixture) => { state.marketplaces[0].path = path.join(fixture.root, "elsewhere"); }],
    ["wrong version", (state) => { state.plugins[0].version = "0.0.1"; }],
    ["wrong scope", (state) => { state.plugins[0].scope = "user"; }],
    ["disabled", (state) => { state.plugins[0].enabled = false; }],
    ["malformed enabled", (state) => { state.plugins[0].enabled = "yes"; }],
    ["contradictory marketplace", (state) => { state.plugins[0].marketplace = "wrong-market"; }],
    ["duplicate", (state) => { state.plugins.push({ ...state.plugins[0] }); }],
    [
      "extra owned plugin",
      (state) => { state.plugins.push({ id: `other@${state.marketplaces[0].name}`, scope: "local", version: "0.1.0" }); },
    ],
  ];
  for (const [label, mutate] of drifts) {
    await withTemp(`skill-router-claude-drift-${label.replace(/ /g, "-")}-`, async (root) => {
      const fixture = await claudeFixture(root);
      await leavePendingClaudeJournal(fixture, { fault: ["journal:proven"], breakLease: true });
      mutate(fixture.runner.state, fixture);
      const snapshot = JSON.stringify(fixture.runner.state);

      const refused = await capture(() => recoverClaudeFixture(fixture));
      assert.equal(refused.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT, `${label} fails closed`);
      assert.match(refused.message, /cannot be attributed/);
      assert.equal(JSON.stringify(fixture.runner.state), snapshot, `${label} mutates nothing`);
      assert.ok(await exists(fixture.paths.journalFile), "the journal is retained");
    });
  }
});

test("rollback compensates attributable Claude state and refuses unattributable drift", async () => {
  await withTemp("skill-router-claude-rollback-", async (root) => {
    const fixture = await claudeFixture(root);
    await leavePendingClaudeJournal(fixture, { fault: ["journal:proven", "recovery:claude"] });
    const document = await readJournal(fixture.paths, { allowMissing: true });
    assert.equal(document.mode, "rollback");
    assert.equal(fixture.runner.state.plugins.length, 1, "the registration is present at rollback time");

    // Unattributable drift: a same-scope plugin at a wrong version.
    fixture.runner.state.plugins[0].version = "0.0.7";
    const snapshot = JSON.stringify(fixture.runner.state);
    const refused = await capture(() => recoverClaudeFixture(fixture));
    assert.equal(refused.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.equal(JSON.stringify(fixture.runner.state), snapshot, "zero mutations on unattributable drift");
    assert.ok(await exists(fixture.paths.journalFile));

    // Restore the recorded version: compensation is attributable again.
    fixture.runner.state.plugins[0].version = fixture.metadata.version;
    const recovery = await recoverClaudeFixture(fixture);
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "rolled-back");
    assert.equal(fixture.runner.state.plugins.length, 0, "the recorded prior (absent) is restored");
    assert.equal(fixture.runner.state.marketplaces.length, 0);
    assert.deepEqual(await leftoverArtifacts(root), []);
  });
});

test("rollback accepts a healthy prior registration read-only", async () => {
  await withTemp("skill-router-claude-prior-healthy-", async (root) => {
    const fixture = await claudeFixture(root);
    // Stage the generated plugin into the state, then start from a healthy
    // prior registration before the transaction runs.
    await installClaudeState(fixture);
    await registerClaude({
      plan: fixture.registration,
      exec: fixture.runner,
      actions: [],
      cwd: fixture.root,
      env: fixture.env,
    });
    await leavePendingClaudeJournal(
      fixture,
      {
        fault: ["journal:proven", "recovery:claude"],
        overrides: { claude: { metadata: { ...fixture.metadata, prior: "healthy" } } },
      },
    );
    // The managedClaudeOptions metadata override must carry prior: healthy;
    // leavePendingClaudeJournal merges overrides into the executor options.
    const document = await readJournal(fixture.paths, { allowMissing: true });
    assert.equal(document.claude.prior, "healthy");
    assert.equal(fixture.runner.state.plugins.length, 1);

    const snapshot = JSON.stringify(fixture.runner.state);
    const recovery = await recoverClaudeFixture(fixture);
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "rolled-back");
    assert.equal(fixture.runner.state.plugins.length, 1, "the healthy prior registration stays");
    assert.equal(JSON.stringify(fixture.runner.state), snapshot, "healthy prior state is accepted read-only");
    assert.deepEqual(await leftoverArtifacts(root), []);
  });
});

/* ================================================================== *
 * Finding 5 - the lease is asserted before every destructive step
 * ================================================================== */

function countingLease(paths, { failAt = null } = {}) {
  const state = { count: 0 };
  return {
    state,
    paths,
    async assertHeld() {
      state.count += 1;
      if (failAt !== null && state.count === failAt) {
        const error = new Error("lease lost");
        error.code = "LOCK_COMPROMISED";
        throw error;
      }
      return true;
    },
  };
}

test("removing the lock before the first destructive step fails closed and stays re-enterable", async () => {
  await withTemp("skill-router-lease-removed-", async (root) => {
    const project = await createProject(root);
    await leavePendingJournal(project, { fault: ["file-write", "recovery:files"] });
    const configBefore = await readFile(project.configFile, "utf8");
    const canonicalBefore = await digestTree(project.stateDirectory);
    const document = await readJournal(project.paths, { allowMissing: true });
    const priorTree = await digestTree(document.state.backup.path);

    const lease = await acquireMutationLock(project.paths, { heartbeatMs: 0 });
    const original = journaledTransactionInternals.onStep;
    journaledTransactionInternals.onStep = async (name) => {
      if (name === "file-restore-intent") {
        // The lock disappears right at the durable-intent seam: the next
        // per-mutation assertion must fail closed before any rename.
        await rm(project.paths.lockDirectory, { recursive: true, force: true });
      }
    };
    try {
      const failure = await capture(() => recover(project, lease));
      assert.equal(failure.code, "LOCK_COMPROMISED");
    } finally {
      journaledTransactionInternals.onStep = original;
      await lease.release().catch(() => {});
    }

    assert.ok(await exists(project.paths.journalFile), "the journal survives");
    assert.equal(await readFile(project.configFile, "utf8"), configBefore, "no config write happened");
    assert.deepEqual(await digestTree(project.stateDirectory), canonicalBefore, "canonical state is untouched");
    assert.deepEqual(await digestTree(document.state.backup.path), priorTree, "the backup is untouched");

    // A fresh lease completes the recovery idempotently.
    const fresh = await acquireMutationLock(project.paths, { heartbeatMs: 0, timeoutMs: 2000 });
    try {
      const recovery = await recover(project, fresh);
      assert.ok(["recovered", "clean"].includes(recovery.status));
      if (recovery.status === "recovered") assert.equal(recovery.outcome, "rolled-back");
    } finally {
      await fresh.release();
    }
    assert.equal(await readFile(project.configFile, "utf8"), OLD_CONFIG);
    assert.deepEqual(await digestTree(project.stateDirectory), priorTree, "the recorded prior state is restored");
    assert.deepEqual(await leftoverArtifacts(root), []);
  });
});

test("replacing the lock before a destructive step fails closed and stays re-enterable", async () => {
  await withTemp("skill-router-lease-replaced-", async (root) => {
    const project = await createProject(root);
    await leavePendingJournal(project, { fault: ["file-write", "recovery:files"] });
    const canonicalBefore = await digestTree(project.stateDirectory);
    const document = await readJournal(project.paths, { allowMissing: true });
    const priorTree = await digestTree(document.state.backup.path);

    const lease = await acquireMutationLock(project.paths, { heartbeatMs: 0 });
    const original = journaledTransactionInternals.onStep;
    journaledTransactionInternals.onStep = async (name) => {
      if (name === "recovery:state") {
        // The lock directory is replaced in place: the identity check must
        // fail the next assertion closed.
        await rm(project.paths.lockDirectory, { recursive: true, force: true });
        await mkdir(project.paths.lockDirectory, { mode: 0o700 });
        await writeFile(path.join(project.paths.lockDirectory, "owner.json"), "{replaced}", { mode: 0o600 });
      }
    };
    try {
      const failure = await capture(() => recover(project, lease));
      assert.equal(failure.code, "LOCK_COMPROMISED");
    } finally {
      journaledTransactionInternals.onStep = original;
      await lease.release().catch(() => {});
    }

    assert.ok(await exists(project.paths.journalFile), "the journal survives");
    assert.deepEqual(await digestTree(project.stateDirectory), canonicalBefore, "canonical state is untouched");
    assert.equal((await inspectStateTree(document.state.backup.path)).status, "owned", "the backup is untouched");

    // Clear the simulated attacker lock before re-acquiring.
    await rm(project.paths.lockDirectory, { recursive: true, force: true });
    const fresh = await acquireMutationLock(project.paths, { heartbeatMs: 0, timeoutMs: 2000 });
    try {
      const recovery = await recover(project, fresh);
      assert.ok(["recovered", "clean"].includes(recovery.status));
      if (recovery.status === "recovered") assert.equal(recovery.outcome, "rolled-back");
    } finally {
      await fresh.release().catch(() => {});
    }
    assert.deepEqual(await digestTree(project.stateDirectory), priorTree, "the recorded prior state is restored");
    assert.deepEqual(await leftoverArtifacts(root), []);
  });
});

test("a lease compromised at any assertion fails closed and recovery stays re-enterable", async () => {
  // Measure the assertion count of one full rollback recovery first.
  let total = 0;
  await withTemp("skill-router-lease-count-", async (root) => {
    const project = await createProject(root);
    await leavePendingJournal(project, { fault: ["file-write", "recovery:files"] });
    const counting = countingLease(project.paths);
    const recovery = await recover(project, counting);
    assert.equal(recovery.outcome, "rolled-back");
    total = counting.state.count;
  });
  assert.ok(total >= 12, `the recovery asserts its lease at least 12 times (saw ${total})`);

  for (let failAt = 1; failAt <= total; failAt += 1) {
    await withTemp(`skill-router-lease-sweep-${failAt}-`, async (root) => {
      const project = await createProject(root);
      await leavePendingJournal(project, { fault: ["file-write", "recovery:files"] });
      const document = await readJournal(project.paths, { allowMissing: true });
      const desiredTree = await digestTree(project.stateDirectory);
      const priorTree = await digestTree(document.state.backup.path);

      const failure = await capture(() => recover(project, countingLease(project.paths, { failAt })));
      assert.equal(failure.code, "LOCK_COMPROMISED", `assertion #${failAt} fails closed`);
      if (failAt < total) {
        // Only the final assertion runs after the journal unlink committed.
        assert.ok(await exists(project.paths.journalFile), `assertion #${failAt} keeps the journal`);
      }
      // The canonical tree is in one of the coherent intermediate states:
      // untouched desired, fully restored prior, or mid-claim (absent until
      // the claim is finished). Nothing else is acceptable.
      const midway = await digestTree(project.stateDirectory);
      const coherent =
        JSON.stringify(midway) === JSON.stringify(desiredTree) ||
        JSON.stringify(midway) === JSON.stringify(priorTree) ||
        midway === null;
      assert.ok(coherent, `assertion #${failAt} left a coherent canonical state`);

      const recovery = await recover(project);
      if (recovery.status !== "clean") assert.equal(recovery.outcome, "rolled-back", `assertion #${failAt} re-enters`);
      assert.equal(await readFile(project.configFile, "utf8"), OLD_CONFIG);
      assert.deepEqual(await digestTree(project.stateDirectory), priorTree);
      assert.deepEqual(await leftoverArtifacts(root), [], `assertion #${failAt} leaves no artifacts`);
    });
  }
});

test("a failed claim removal fails and preserves the re-claimed deletion claim for later recovery", async () => {
  await withTemp("skill-router-remediation-rm-", async (root) => {
    const project = await createProject(root);
    const restore = installStepFault("cleanup:backup");
    await capture(() => runManagedTransaction(project)).finally(restore);
    const document = await readJournal(project.paths, { allowMissing: true });
    const backupPath = document.state.backup.path;
    const backupDigest = (await inspectStateTree(backupPath)).digest;
    const claimPath = claimPathFor(backupPath, document.transactionId);

    // The final removal fails: B3 forbids any check-then-rename restoration,
    // so the cleanup fails and the re-claimed deletion claim is preserved for
    // explicit later recovery - the backup is never renamed back.
    const originalRm = journaledTransactionInternals.rm;
    journaledTransactionInternals.rm = async (target, options) => {
      if (String(target).includes("delete-")) throw new Error("cleanup refused");
      return originalRm(target, options);
    };
    const failure = await capture(() => recover(project)).finally(() => {
      journaledTransactionInternals.rm = originalRm;
    });
    assert.match(failure.message, /cleanup refused/);
    assert.ok(await exists(project.paths.journalFile), "the journal stays");
    assert.equal(await exists(backupPath), false, "nothing is renamed back over the recorded path");
    const containerNames = await readdir(claimPath);
    const deletionChild = containerNames.find((name) => /^delete-[0-9a-f]{32}$/.test(name));
    assert.ok(deletionChild, "the re-claimed deletion claim is preserved inside its container");
    assert.equal(
      (await inspectStateTree(path.join(claimPath, deletionChild))).digest,
      backupDigest,
      "the preserved deletion claim still holds the exact recorded artifact",
    );

    // Re-entered cleanup discovers the deletion leftover by its closed
    // grammar, re-claims it, and finishes once the removal succeeds.
    const recovery = await recover(project);
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "committed");
    assert.deepEqual(await leftoverArtifacts(root), []);
  });
});

/* ================================================================== *
 * Gate 6 attempt 3, finding B - baseline- and component-aware Claude
 * attribution
 * ================================================================== */

/** Removes the recorded Claude registration without any journaled action. */
async function disappearRegistration(fixture) {
  fixture.runner.state.plugins.length = 0;
  fixture.runner.state.marketplaces.length = 0;
  const settingsFile = path.join(fixture.root, ".claude", "settings.local.json");
  const settings = JSON.parse(await readFile(settingsFile, "utf8"));
  delete settings.extraKnownMarketplaces;
  await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
}

function settingsFileOf(fixture) {
  return path.join(fixture.root, ".claude", "settings.local.json");
}

async function readSettingsOrNull(fixture) {
  try {
    return await readFile(settingsFileOf(fixture), "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

test("an unexplained zero-action disappearance of a healthy registration conflicts in both directions", async () => {
  for (const rollback of [false, true]) {
    await withTemp(`skill-router-claude-zero-action-${rollback ? "rollback" : "forward"}-`, async (root) => {
      const fixture = await claudeFixture(root);
      await installClaudeState(fixture);
      const faults = rollback ? ["claude", "recovery:claude"] : ["claude"];
      await leavePendingClaudeJournal(fixture, {
        fault: faults,
        breakLease: !rollback,
        overrides: { claude: { metadata: { ...fixture.metadata, prior: "healthy" } } },
      });
      const document = await readJournal(fixture.paths, { allowMissing: true });
      assert.equal(document.claude.prior, "healthy");
      assert.equal(document.claude.actions.length, 0, "no Claude action was recorded");
      if (rollback) assert.equal(document.mode, "rollback");
      assert.equal(fixture.runner.state.plugins.length, 1, "the registration is recorded as healthy");

      // The registration disappears with no recorded detach action at all.
      await disappearRegistration(fixture);
      const stateSnapshot = JSON.stringify(fixture.runner.state);
      const settingsSnapshot = await readFile(settingsFileOf(fixture), "utf8");

      const refused = await capture(() => recoverClaudeFixture(fixture));
      assert.equal(refused.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT, `${rollback ? "rollback" : "forward"} fails closed`);
      assert.match(refused.message, /cannot be attributed/);
      assert.equal(JSON.stringify(fixture.runner.state), stateSnapshot, "zero Claude mutations");
      assert.equal(await readFile(settingsFileOf(fixture), "utf8"), settingsSnapshot, "settings are untouched");
      assert.ok(await exists(fixture.paths.journalFile), "the journal is retained");
    });
  }
});

test("declaration, marketplace, and plugin components each require their own recorded action", async () => {
  const scenarios = [
    [
      "declaration only",
      async (fixture) => {
        const settingsFile = settingsFileOf(fixture);
        await mkdir(path.dirname(settingsFile), { recursive: true });
        const settings = {
          extraKnownMarketplaces: {
            [fixture.identity.marketplace]: {
              source: { source: "directory", path: path.join(fixture.stateDirectory, "claude") },
            },
          },
        };
        await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
      },
    ],
    [
      "visible marketplace only",
      async (fixture) => {
        fixture.runner.state.marketplaces.push({
          name: fixture.identity.marketplace,
          path: path.join(fixture.stateDirectory, "claude"),
          scope: "local",
        });
      },
    ],
    [
      "plugin only without its marketplace",
      async (fixture) => {
        fixture.runner.state.plugins.push({
          id: fixture.registration.reference,
          scope: fixture.registration.scope,
          version: fixture.metadata.version,
        });
      },
    ],
  ];
  for (const [label, plant] of scenarios) {
    await withTemp(`skill-router-claude-component-${label.replace(/ /g, "-")}-`, async (root) => {
      const fixture = await claudeFixture(root);
      await leavePendingClaudeJournal(fixture, { fault: ["claude"], breakLease: true });
      await plant(fixture);
      const stateSnapshot = JSON.stringify(fixture.runner.state);
      const settingsSnapshot = await readSettingsOrNull(fixture);

      const refused = await capture(() => recoverClaudeFixture(fixture));
      assert.equal(refused.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT, `${label} fails closed`);
      assert.match(refused.message, /cannot be attributed/);
      assert.equal(JSON.stringify(fixture.runner.state), stateSnapshot, "zero Claude mutations");
      assert.equal(await readSettingsOrNull(fixture), settingsSnapshot, "settings are untouched");
      assert.ok(await exists(fixture.paths.journalFile), "the journal is retained");
    });
  }
});

test("rollback cannot explain a disappearance with only add-type actions", async () => {
  await withTemp("skill-router-claude-wrong-direction-", async (root) => {
    const fixture = await claudeFixture(root);
    await installClaudeState(fixture);
    await leavePendingClaudeJournal(fixture, {
      fault: ["journal:proven", "recovery:claude"],
      overrides: { claude: { metadata: { ...fixture.metadata, prior: "healthy" } } },
    });
    const document = await readJournal(fixture.paths, { allowMissing: true });
    assert.equal(document.mode, "rollback");
    assert.ok(
      document.claude.actions.some((entry) => entry.type === "plugin-update" && entry.status === "observed"),
      "only add-type actions were recorded",
    );
    assert.equal(document.claude.actions.some((entry) => entry.type === "plugin-uninstall"), false);

    // The registration disappears although the last recorded action only
    // re-registered it: no detach action can explain the absence.
    await disappearRegistration(fixture);
    const stateSnapshot = JSON.stringify(fixture.runner.state);
    const refused = await capture(() => recoverClaudeFixture(fixture));
    assert.equal(refused.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.match(refused.message, /cannot be attributed/);
    assert.equal(JSON.stringify(fixture.runner.state), stateSnapshot, "zero Claude mutations");
    assert.ok(await exists(fixture.paths.journalFile), "the journal is retained");
  });
});

test("a real-shaped null-scope marketplace listing is accepted only with the exact declaration", async () => {
  await withTemp("skill-router-claude-null-scope-", async (root) => {
    const fixture = await claudeFixture(root);
    await leavePendingClaudeJournal(fixture, { fault: ["journal:proven"], breakLease: true });
    // Real Claude marketplace lists can report `scope: null`; the exact
    // scope-owned declaration independently proves scope and path.
    fixture.runner.state.marketplaces[0].scope = null;
    const snapshot = JSON.stringify(fixture.runner.state);
    const recovery = await recoverClaudeFixture(fixture);
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "committed");
    assert.equal(JSON.stringify(fixture.runner.state), snapshot, "healthy null-scope state is accepted read-only");
    assert.deepEqual(await leftoverArtifacts(root), []);
  });

  await withTemp("skill-router-claude-null-scope-no-declaration-", async (root) => {
    const fixture = await claudeFixture(root);
    await leavePendingClaudeJournal(fixture, { fault: ["journal:proven"], breakLease: true });
    fixture.runner.state.marketplaces[0].scope = null;
    // Without the exact declaration the null scope proves nothing.
    const settingsFile = settingsFileOf(fixture);
    const settings = JSON.parse(await readFile(settingsFile, "utf8"));
    delete settings.extraKnownMarketplaces;
    await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
    const stateSnapshot = JSON.stringify(fixture.runner.state);
    const settingsSnapshot = await readFile(settingsFile, "utf8");

    const refused = await capture(() => recoverClaudeFixture(fixture));
    assert.equal(refused.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.match(refused.message, /cannot be attributed/);
    assert.equal(JSON.stringify(fixture.runner.state), stateSnapshot, "zero Claude mutations");
    assert.equal(await readFile(settingsFile, "utf8"), settingsSnapshot);
    assert.ok(await exists(fixture.paths.journalFile), "the journal is retained");
  });
});

/* ================================================================== *
 * Gate 6 attempt 3, finding A - the interrupted desired cleanup claim
 * never predates the prior-backup proof
 * ================================================================== */

/** Canonical desired tree already renamed to its interrupted cleanup claim. */
async function interruptedDesiredClaim(root) {
  const { project, document, desired, backupPath } = await pendingDesiredRollback(root);
  const seeded = await seedClaimContainer(project.stateDirectory, document.transactionId, { kind: "canonical" });
  assert.equal((await inspectStateTree(seeded.movedPath)).digest, desired.digest);
  return { project, document, desired, backupPath, canonicalClaim: seeded.containerPath, canonicalTree: seeded.movedPath };
}

for (const variant of ["missing", "changed", "foreign-owned", "symlink", "special"]) {
  test(`an interrupted desired claim is preserved when its ${variant} backup cannot prove the prior`, async () => {
    await withTemp(`skill-router-claim-proof-${variant}-`, async (root) => {
      const { project, document, backupPath, canonicalClaim, canonicalTree } = await interruptedDesiredClaim(root);
      const claimDigest = (await inspectStateTree(canonicalTree)).digest;
      const configBefore = await readFile(project.configFile, "utf8");

      if (variant === "missing") {
        await rm(backupPath, { recursive: true, force: true });
      } else if (variant === "changed") {
        await rm(backupPath, { recursive: true, force: true });
        await mkdir(backupPath, { mode: 0o700 });
        await writeFile(path.join(backupPath, STATE_MARKER_FILE), `${STATE_MARKER_CONTENT}\n`, { mode: 0o600 });
        await writeFile(path.join(backupPath, "registry.json"), "tampered\n", { mode: 0o600 });
        if (process.platform !== "win32") await chmod(backupPath, 0o700);
      } else if (variant === "foreign-owned") {
        await rm(backupPath, { recursive: true, force: true });
        await mkdir(backupPath);
        await writeFile(path.join(backupPath, "hands-off.txt"), "keep");
      } else if (variant === "symlink") {
        await rm(backupPath, { recursive: true, force: true });
        const innocent = path.join(root, "innocent-prior");
        await mkdir(innocent);
        await writeFile(path.join(innocent, STATE_MARKER_FILE), `${STATE_MARKER_CONTENT}\n`, { mode: 0o600 });
        await writeFile(path.join(innocent, "registry.json"), "prior\n", { mode: 0o600 });
        await symlink(innocent, backupPath);
      } else {
        if (spawnSync("mkfifo", [backupPath]).status !== 0) return;
      }

      const failure = await capture(() => recover(project));
      const expected = variant === "missing" ? JOURNAL_ERROR_CODES.RECOVERY_AMBIGUOUS : JOURNAL_ERROR_CODES.RECOVERY_CONFLICT;
      assert.equal(failure.code, expected, `${variant} backup fails closed`);
      assert.match(failure.message, /left untouched/);

      // The interrupted desired claim, the journal, and every other artifact
      // are preserved byte for byte; no new claim was created.
      const claimInfo = await inspectStateTree(canonicalTree);
      assert.equal(claimInfo.status, "owned");
      assert.equal(claimInfo.digest, claimDigest, "the desired claim is byte-for-byte intact");
      const reread = await readJournal(project.paths, { allowMissing: true });
      assert.equal(reread.transactionId, document.transactionId, "the journal is retained");
      assert.equal(await readFile(project.configFile, "utf8"), configBefore, "configs are untouched");
      assert.deepEqual(
        (await claimEntriesIn(root)).sort(),
        [path.basename(canonicalClaim), `${path.basename(canonicalClaim)}.json`].sort(),
        "only the claim container and its external attribution record exist",
      );
      if (variant === "foreign-owned") {
        assert.equal(await readFile(path.join(backupPath, "hands-off.txt"), "utf8"), "keep");
      }
      if (variant === "changed") {
        assert.equal(await readFile(path.join(backupPath, "registry.json"), "utf8"), "tampered\n");
      }
      if (variant === "symlink") {
        assert.equal((await lstat(backupPath)).isSymbolicLink(), true, "the symlink is preserved");
      }
    });
  });
}

test("an interrupted desired claim with a recorded Claude section never mutates Claude on proof failure", async () => {
  await withTemp("skill-router-claim-proof-claude-", async (root) => {
    const fixture = await claudeFixture(root);
    // The executor crashes after the Claude section and its actions were
    // recorded, but the inline rollback dies before it could touch the state:
    // the desired tree is still at the canonical path and the backup still
    // holds the recorded prior.
    await leavePendingClaudeJournal(fixture, { fault: ["journal:proven", "recovery:files"] });
    const document = await readJournal(fixture.paths, { allowMissing: true });
    assert.equal(document.mode, "rollback");
    const seeded = await seedClaimContainer(fixture.stateDirectory, document.transactionId, { kind: "canonical" });
    const canonicalClaim = seeded.containerPath;
    const canonicalTree = seeded.movedPath;
    assert.equal(
      (await inspectStateTree(canonicalTree)).digest,
      document.state.stage.digest,
      "the claim holds the exact recorded desired tree",
    );
    await rm(document.state.backup.path, { recursive: true, force: true });

    const stateSnapshot = JSON.stringify(fixture.runner.state);
    const settingsSnapshot = await readFile(settingsFileOf(fixture), "utf8");
    const failure = await capture(() => recoverClaudeFixture(fixture));
    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_AMBIGUOUS);
    assert.match(failure.message, /left untouched/);
    assert.equal(JSON.stringify(fixture.runner.state), stateSnapshot, "zero Claude mutations");
    assert.equal(await readFile(settingsFileOf(fixture), "utf8"), settingsSnapshot, "settings are untouched");
    assert.equal((await inspectStateTree(canonicalTree)).status, "owned", "the desired claim survives");
    assert.ok(await exists(fixture.paths.journalFile), "the journal is retained");
  });
});

test("an interrupted canonical claim with a valid prior backup re-enters and completes", async () => {
  await withTemp("skill-router-claim-proof-valid-", async (root) => {
    const { project, document, backupPath, canonicalClaim } = await interruptedDesiredClaim(root);
    const priorDigest = (await inspectStateTree(backupPath)).digest;

    const recovery = await recover(project);
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "rolled-back");
    assert.equal((await inspectStateTree(project.stateDirectory)).digest, priorDigest, "the prior is restored");
    assert.equal(await exists(canonicalClaim), false, "the interrupted claim is finished");
    assert.deepEqual(await leftoverArtifacts(root), []);
  });
});

/* ================================================================== *
 * Post-gate remediation, finding A - the proof preflight runs before
 * ANY durable or external rollback mutation
 * ================================================================== */

/**
 * A rollback pending state whose config write genuinely landed: the journal
 * records the file as applied, the after-state config bytes are in place,
 * and the payloads exist on disk.
 */
async function appliedPendingRollback(root) {
  const project = await createProject(root);
  await leavePendingJournal(project, { fault: ["journal:proven", "recovery:files"] });
  const document = await readJournal(project.paths, { allowMissing: true });
  assert.equal(document.mode, "rollback");
  assert.equal(document.files[0].status, "applied", "the config write landed before the crash");
  assert.equal(await readFile(project.configFile, "utf8"), NEW_CONFIG, "the after-state config is in place");
  return { project, document };
}

function root0(project) {
  return path.dirname(project.paths.controlDirectory);
}

async function readIfPresent(target) {
  try {
    return await readFile(target);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

/** Every artifact a refusal must leave byte-for-byte untouched. */
async function rollbackSnapshots(project, document, canonicalPath = project.stateDirectory) {
  const payloadPaths = document.files.flatMap((file) => [file.before.payloadPath, file.after.payloadPath].filter(Boolean));
  return {
    journalBytes: await readFile(project.paths.journalFile),
    configBytes: await readFile(project.configFile),
    canonicalDigest: (await inspectStateTree(canonicalPath))?.digest ?? null,
    payloadBytes: await Promise.all(payloadPaths.map((payloadPath) => readIfPresent(payloadPath))),
    rootEntries: (await listEntries(root0(project))).sort(),
    controlEntries: (await listEntries(project.paths.controlDirectory)).sort(),
  };
}

async function assertSnapshotsIntact(project, document, snapshots, canonicalPath = project.stateDirectory) {
  assert.deepEqual(await readFile(project.paths.journalFile), snapshots.journalBytes, "journal bytes are identical");
  assert.equal(await readFile(project.configFile, "utf8"), snapshots.configBytes.toString("utf8"), "config bytes are identical");
  const canonical = await inspectStateTree(canonicalPath);
  assert.equal(canonical?.digest ?? null, snapshots.canonicalDigest, "the canonical tree or claim is untouched");
  const payloadPaths = document.files.flatMap((file) => [file.before.payloadPath, file.after.payloadPath].filter(Boolean));
  const payloadBytes = await Promise.all(payloadPaths.map((payloadPath) => readIfPresent(payloadPath)));
  assert.deepEqual(payloadBytes, snapshots.payloadBytes, "payload bytes are identical");
  assert.deepEqual((await listEntries(root0(project))).sort(), snapshots.rootEntries, "the artifact inventory is unchanged");
  assert.deepEqual(
    (await listEntries(project.paths.controlDirectory)).sort(),
    snapshots.controlEntries,
    "the control inventory is unchanged",
  );
  const reread = await readJournal(project.paths, { allowMissing: true });
  assert.equal(reread.transactionId, document.transactionId, "the same journal is retained");
  assert.equal(reread.revision, document.revision, "the journal revision is unchanged");
  assert.equal(reread.mode, document.mode, "the journal mode is unchanged");
  assert.equal(reread.files[0].status, document.files[0].status, "the file statuses are unchanged");
}

for (const form of ["canonical", "claim"]) {
  for (const variant of ["missing", "changed", "foreign-owned", "symlink", "special", "wrong-mode"]) {
    test(`applied-config rollback with a ${variant} backup refuses before any mutation (${form} form)`, async () => {
      await withTemp(`skill-router-preflight-${form}-${variant}-`, async (root) => {
        const { project, document } = await appliedPendingRollback(root);
        const backupPath = document.state.backup.path;
        let canonicalPath = project.stateDirectory;
        if (form === "claim") {
          canonicalPath = claimPathFor(project.stateDirectory, document.transactionId);
          await seedClaimContainer(project.stateDirectory, document.transactionId, { kind: "canonical" });
        }

        // Hostile backup, applied first; snapshots capture the exact state
        // recovery must not change.
        if (variant === "missing") {
          await rm(backupPath, { recursive: true, force: true });
        } else if (variant === "changed") {
          await rm(backupPath, { recursive: true, force: true });
          await mkdir(backupPath, { mode: 0o700 });
          await writeFile(path.join(backupPath, STATE_MARKER_FILE), `${STATE_MARKER_CONTENT}\n`, { mode: 0o600 });
          await writeFile(path.join(backupPath, "registry.json"), "tampered\n", { mode: 0o600 });
          if (process.platform !== "win32") await chmod(backupPath, 0o700);
        } else if (variant === "foreign-owned") {
          await rm(backupPath, { recursive: true, force: true });
          await mkdir(backupPath);
          await writeFile(path.join(backupPath, "hands-off.txt"), "keep");
        } else if (variant === "symlink") {
          await rm(backupPath, { recursive: true, force: true });
          const innocent = path.join(root, "innocent-prior");
          await mkdir(innocent);
          await writeFile(path.join(innocent, STATE_MARKER_FILE), `${STATE_MARKER_CONTENT}\n`, { mode: 0o600 });
          await writeFile(path.join(innocent, "registry.json"), "prior\n", { mode: 0o600 });
          await symlink(innocent, backupPath);
        } else if (variant === "wrong-mode") {
          // The exact recorded prior, but group/other-writable: never proof.
          if (process.platform === "win32") return;
          await chmod(backupPath, 0o777);
        } else {
          if (spawnSync("mkfifo", [backupPath]).status !== 0) return;
        }
        const snapshots = await rollbackSnapshots(project, document, canonicalPath);

        const failure = await capture(() => recover(project));
        const expected = variant === "missing"
          ? JOURNAL_ERROR_CODES.RECOVERY_AMBIGUOUS
          : JOURNAL_ERROR_CODES.RECOVERY_CONFLICT;
        assert.equal(failure.code, expected, `${variant} backup fails closed`);
        assert.match(failure.message, /left untouched/);

        // Nothing durable or external happened before the refusal: every
        // snapshot - journal bytes (revision/mode/status), after-state
        // config, payloads, canonical tree or claim, and the artifact
        // inventories - is byte-for-byte identical.
        await assertSnapshotsIntact(project, document, snapshots, canonicalPath);

        // The hostile backup itself is preserved exactly as the test left it.
        if (variant === "missing") {
          assert.equal(await exists(backupPath), false, "nothing is invented at the backup path");
        } else if (variant === "changed") {
          assert.equal(await readFile(path.join(backupPath, "registry.json"), "utf8"), "tampered\n");
        } else if (variant === "foreign-owned") {
          assert.equal(await readFile(path.join(backupPath, "hands-off.txt"), "utf8"), "keep");
        } else if (variant === "symlink") {
          assert.equal((await lstat(backupPath)).isSymbolicLink(), true, "the symlink survives");
        } else if (variant === "wrong-mode") {
          assert.equal((await lstat(backupPath)).mode & 0o777, 0o777, "the wrong mode survives");
        } else {
          assert.equal((await lstat(backupPath)).isFIFO(), true, "the special file survives");
        }
      });
    });
  }
}

test("an applied-config Claude rollback with a hostile backup makes zero CLI calls", async () => {
  await withTemp("skill-router-preflight-claude-", async (root) => {
    const fixture = await claudeFixture(root);
    // The executor crashes after the config write landed but before the
    // rollback touched anything: the journal is rollback-mode with the file
    // still recorded as applied.
    await leavePendingClaudeJournal(fixture, { fault: ["journal:proven", "file-restore-intent"] });
    const document = await readJournal(fixture.paths, { allowMissing: true });
    assert.equal(document.mode, "rollback");
    assert.equal(document.files[0].status, "applied", "the config write landed");
    assert.equal(await readFile(fixture.configFile, "utf8"), NEW_CONFIG);

    const snapshots = {
      journalBytes: await readFile(fixture.paths.journalFile),
      configBytes: await readFile(fixture.configFile),
      stateSnapshot: JSON.stringify(fixture.runner.state),
      logLength: fixture.runner.log.length,
      settingsBytes: await readFile(settingsFileOf(fixture), "utf8"),
    };
    await rm(document.state.backup.path, { recursive: true, force: true });

    const failure = await capture(() => recoverClaudeFixture(fixture));
    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_AMBIGUOUS);
    assert.match(failure.message, /left untouched/);

    assert.deepEqual(await readFile(fixture.paths.journalFile), snapshots.journalBytes, "journal bytes are identical");
    assert.equal(await readFile(fixture.configFile, "utf8"), snapshots.configBytes.toString("utf8"), "config is untouched");
    assert.equal(JSON.stringify(fixture.runner.state), snapshots.stateSnapshot, "Claude state is untouched");
    assert.equal(fixture.runner.log.length, snapshots.logLength, "zero CLI calls were issued");
    assert.equal(await readFile(settingsFileOf(fixture), "utf8"), snapshots.settingsBytes, "settings are untouched");
    assert.equal((await inspectStateTree(document.state.backup.path)).status, "absent", "the backup stays missing");
  });
});

test("an applied-config rollback with a valid prior backup still rolls back", async () => {
  await withTemp("skill-router-preflight-valid-", async (root) => {
    const { project, document } = await appliedPendingRollback(root);
    const priorDigest = (await inspectStateTree(document.state.backup.path)).digest;

    const recovery = await recover(project);
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "rolled-back");
    assert.equal(await readFile(project.configFile, "utf8"), OLD_CONFIG, "the applied config is restored");
    assert.equal((await inspectStateTree(project.stateDirectory)).digest, priorDigest, "the prior state is back");
    assert.equal(await readJournal(project.paths, { allowMissing: true }), null);
    assert.deepEqual(await leftoverArtifacts(root), []);
  });
});

/* ================================================================== *
 * Post-gate remediation, finding B - independent declaration and
 * visible-marketplace attribution
 * ================================================================== */

/**
 * A rollback pending state from a healthy prior registration whose file
 * restores already completed: the next recovery attempt only has the Claude
 * reconciliation left, so a Claude refusal must leave the journal bytes
 * identical.
 */
async function healthyBaselineRollback(root) {
  const fixture = await claudeFixture(root);
  await installClaudeState(fixture);
  await leavePendingClaudeJournal(fixture, {
    fault: ["journal:proven", "recovery:claude"],
    overrides: { claude: { metadata: { ...fixture.metadata, prior: "healthy" } } },
  });
  const document = await readJournal(fixture.paths, { allowMissing: true });
  assert.equal(document.mode, "rollback");
  assert.equal(document.claude.prior, "healthy");
  assert.equal(document.files[0].status, "restored", "the file restore already completed");
  return { fixture, document };
}

/**
 * A forward pending state from a healthy prior registration with zero
 * recorded Claude actions; roll-forward skips the applied files and reaches
 * the Claude reconciliation without any journal patch.
 */
async function healthyBaselineForward(root) {
  const fixture = await claudeFixture(root);
  await installClaudeState(fixture);
  await leavePendingClaudeJournal(fixture, {
    fault: ["claude"],
    breakLease: true,
    overrides: { claude: { metadata: { ...fixture.metadata, prior: "healthy" } } },
  });
  const document = await readJournal(fixture.paths, { allowMissing: true });
  assert.equal(document.mode, "forward");
  assert.equal(document.claude.prior, "healthy");
  assert.equal(document.claude.actions.length, 0, "no Claude action was recorded");
  assert.equal(fixture.runner.state.plugins.length, 1, "the registration is healthy");
  return { fixture, document };
}

const EXTERNAL_MUTATION = /^plugin (?:uninstall|install|update|marketplace add|marketplace remove)\b/;

function mutationsOf(runner) {
  return runner.log.filter((line) => EXTERNAL_MUTATION.test(line));
}

async function removeSettingsDeclaration(fixture) {
  const settingsFile = settingsFileOf(fixture);
  const settings = JSON.parse(await readFile(settingsFile, "utf8"));
  delete settings.extraKnownMarketplaces;
  await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
}

function claudeSnapshots(fixture) {
  return {
    stateSnapshot: JSON.stringify(fixture.runner.state),
    mutationLines: [...mutationsOf(fixture.runner)],
  };
}

for (const direction of ["rollback", "forward"]) {
  test(`a declaration disappearing while listing and plugin remain is a zero-mutation conflict (${direction})`, async () => {
    await withTemp(`skill-router-component-declaration-${direction}-`, async (root) => {
      const { fixture, document } = direction === "rollback"
        ? await healthyBaselineRollback(root)
        : await healthyBaselineForward(root);
      const journalBytes = await readFile(fixture.paths.journalFile);
      const configBytes = await readFile(fixture.configFile);
      await removeSettingsDeclaration(fixture); // listing + plugin remain
      assert.equal(fixture.runner.state.marketplaces.length, 1);
      assert.equal(fixture.runner.state.plugins.length, 1);
      const snapshots = { ...claudeSnapshots(fixture), settingsBytes: await readFile(settingsFileOf(fixture), "utf8") };

      const refused = await capture(() => recoverClaudeFixture(fixture));
      assert.equal(refused.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT, "the missing declaration fails closed");
      assert.match(refused.message, /cannot be attributed/);

      assert.deepEqual(await readFile(fixture.paths.journalFile), journalBytes, "journal bytes are identical");
      assert.equal(await readFile(fixture.configFile, "utf8"), configBytes.toString("utf8"), "config is untouched");
      assert.equal(JSON.stringify(fixture.runner.state), snapshots.stateSnapshot, "zero fake mutations");
      assert.deepEqual(mutationsOf(fixture.runner), snapshots.mutationLines, "zero mutating CLI calls");
      assert.equal(await readFile(settingsFileOf(fixture), "utf8"), snapshots.settingsBytes, "settings are untouched");
      assert.equal((await readJournal(fixture.paths, { allowMissing: true })).transactionId, document.transactionId, "journal retained");
    });
  });

  test(`the visible marketplace disappearing while declaration and plugin remain is a zero-mutation conflict (${direction})`, async () => {
    await withTemp(`skill-router-component-listing-${direction}-`, async (root) => {
      const { fixture, document } = direction === "rollback"
        ? await healthyBaselineRollback(root)
        : await healthyBaselineForward(root);
      const journalBytes = await readFile(fixture.paths.journalFile);
      const settingsBytes = await readFile(settingsFileOf(fixture), "utf8");
      fixture.runner.state.marketplaces.length = 0; // declaration + plugin remain
      assert.equal(fixture.runner.state.plugins.length, 1);
      const snapshots = claudeSnapshots(fixture);

      const refused = await capture(() => recoverClaudeFixture(fixture));
      assert.equal(refused.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT, "the missing listing fails closed");
      assert.match(refused.message, /cannot be attributed/);

      assert.deepEqual(await readFile(fixture.paths.journalFile), journalBytes, "journal bytes are identical");
      assert.equal(JSON.stringify(fixture.runner.state), snapshots.stateSnapshot, "zero fake mutations");
      assert.deepEqual(mutationsOf(fixture.runner), snapshots.mutationLines, "zero mutating CLI calls");
      assert.equal(await readFile(settingsFileOf(fixture), "utf8"), settingsBytes, "settings are untouched");
      assert.equal((await readJournal(fixture.paths, { allowMissing: true })).transactionId, document.transactionId, "journal retained");
    });
  });

  test(`duplicate visible marketplace entries conflict even when one exact entry exists (${direction})`, async () => {
    await withTemp(`skill-router-component-duplicate-${direction}-`, async (root) => {
      const { fixture, document } = direction === "rollback"
        ? await healthyBaselineRollback(root)
        : await healthyBaselineForward(root);
      const journalBytes = await readFile(fixture.paths.journalFile);
      fixture.runner.state.marketplaces.push({ ...fixture.runner.state.marketplaces[0] });
      assert.equal(fixture.runner.state.marketplaces.length, 2);
      const snapshots = claudeSnapshots(fixture);

      const refused = await capture(() => recoverClaudeFixture(fixture));
      assert.equal(refused.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT, "duplicates fail closed");
      assert.match(refused.message, /cannot be attributed/);

      assert.deepEqual(await readFile(fixture.paths.journalFile), journalBytes, "journal bytes are identical");
      assert.equal(JSON.stringify(fixture.runner.state), snapshots.stateSnapshot, "zero fake mutations");
      assert.deepEqual(mutationsOf(fixture.runner), snapshots.mutationLines, "zero mutating CLI calls");
      assert.ok(await exists(fixture.paths.journalFile), "journal retained");
      assert.equal(document.claude.prior, "healthy");
    });
  });
}

test("a pending marketplace-add explains the declaration independently of the listing", async () => {
  await withTemp("skill-router-component-matching-transition-", async (root) => {
    const fixture = await claudeFixture(root);
    // Crash after the marketplace-add CLI ran but before its observed
    // outcome was journaled: a pending intent explains both components.
    await leavePendingClaudeJournal(fixture, { fault: ["claude-observed"], breakLease: true });
    const pending = await readJournal(fixture.paths, { allowMissing: true });
    assert.equal(pending.claude.actions.length, 1);
    assert.equal(pending.claude.actions[0].type, "marketplace-add");
    assert.equal(pending.claude.actions[0].status, "intent");
    assert.equal(fixture.runner.state.marketplaces.length, 1);

    // Only the declaration is missing (the listing landed): the pending
    // marketplace-add explains the declaration's deviation on its own.
    await removeSettingsDeclaration(fixture);
    assert.equal(fixture.runner.state.marketplaces.length, 1);

    const recovery = await recoverClaudeFixture(fixture);
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "committed");
    assert.equal(fixture.runner.state.marketplaces.length, 1, "the marketplace is not duplicated");
    assert.equal(fixture.runner.state.plugins.length, 1, "the exact plugin is installed");
    const settings = JSON.parse(await readFile(settingsFileOf(fixture), "utf8"));
    assert.ok(settings.extraKnownMarketplaces?.[fixture.identity.marketplace], "the declaration was re-added");
    assert.deepEqual(await leftoverArtifacts(root), []);
  });
});

/* ================================================================== *
 * Gate 6 blocker B - direction provenance precedes outcome semantics,
 * per component, in both recovery directions
 * ================================================================== */

/** Durably replaces the journal's recorded Claude action chain (CAS-checked). */
async function setClaudeActions(fixture, actions) {
  const document = await readJournal(fixture.paths, { allowMissing: true });
  await updateJournal(
    fixture.paths,
    document,
    { claude: { ...document.claude, actions } },
    { lease: fixture.lease, recovery: true },
  );
}

/** Puts an action in one of the two unproven states: intent, or failed. */
function unproven(action, outcome) {
  if (outcome === "intent") return { ...action, status: "intent" };
  return {
    ...action,
    status: "observed",
    outcome: { status: "failed", errorCode: "injected-claude-failure", message: "the mutation did not complete" },
  };
}

/** The same recorded action, stripped of any outcome, then made unproven. */
function unprovenRecorded(action, outcome) {
  const rest = { ...action };
  delete rest.outcome;
  return unproven(rest, outcome);
}

/** A recorded detach action for one component, in an unproven state. */
function detachAction(fixture, component, outcome, sequence) {
  const scope = fixture.registration.scope;
  const action =
    component === "plugin"
      ? { sequence, type: "plugin-uninstall", scope, reference: fixture.registration.reference }
      : {
          sequence,
          type: "marketplace-remove",
          scope,
          marketplace: fixture.identity.marketplace,
          path: path.join(fixture.stateDirectory, "claude"),
        };
  action.id = `${action.type}:${scope}:${component === "plugin" ? action.reference : action.marketplace}`;
  return unproven(action, outcome);
}

/**
 * A pending journal whose registration genuinely recorded its ADD actions
 * against a recorded-healthy baseline, in either recovery direction.
 */
async function healthyAddJournal(root, direction) {
  const fixture = await claudeFixture(root);
  await leavePendingClaudeJournal(fixture, {
    fault: direction === "forward" ? ["journal:proven"] : ["journal:proven", "recovery:claude"],
    breakLease: direction === "forward",
    overrides: { claude: { metadata: { ...fixture.metadata, prior: "healthy" } } },
  });
  const document = await readJournal(fixture.paths, { allowMissing: true });
  assert.equal(document.mode, direction === "forward" ? "forward" : "rollback");
  assert.equal(document.claude.prior, "healthy", "the recorded baseline is healthy");
  assert.deepEqual(
    document.claude.actions.map((entry) => entry.type),
    ["marketplace-add", "plugin-install"],
    "only add-type actions were recorded",
  );
  assert.ok(
    document.claude.actions.every((entry) => entry.status === "observed" && entry.outcome?.status === "succeeded"),
    "every recorded add is proven",
  );
  assert.equal(fixture.runner.state.marketplaces.length, 1);
  assert.equal(fixture.runner.state.plugins.length, 1);
  assert.ok(await readSettingsOrNull(fixture), "the declaration landed");
  return { fixture, document };
}

/**
 * A pending journal from an absent baseline whose registration recorded its
 * ADD actions, in either recovery direction.
 */
async function absentBaselineJournal(root, direction) {
  const fixture = await claudeFixture(root);
  await leavePendingClaudeJournal(fixture, {
    fault: direction === "forward" ? ["journal:proven"] : ["journal:proven", "recovery:claude"],
    breakLease: direction === "forward",
  });
  const document = await readJournal(fixture.paths, { allowMissing: true });
  assert.equal(document.mode, direction === "forward" ? "forward" : "rollback");
  assert.equal(document.claude.prior, "absent", "the recorded baseline is absent");
  assert.deepEqual(
    document.claude.actions.map((entry) => entry.type),
    ["marketplace-add", "plugin-install"],
    "only add-type actions were recorded",
  );
  assert.equal(fixture.runner.state.plugins.length, 1);
  return { fixture, document };
}

/** Deviates exactly one component away from a recorded-healthy baseline. */
async function deviateFromHealthy(fixture, component) {
  if (component === "declaration") await removeSettingsDeclaration(fixture);
  else if (component === "marketplace") fixture.runner.state.marketplaces.length = 0;
  else fixture.runner.state.plugins.length = 0;
}

/** Leaves exactly one component present against an absent baseline. */
async function keepOnlyPresent(fixture, component) {
  if (component === "declaration") {
    fixture.runner.state.marketplaces.length = 0;
    fixture.runner.state.plugins.length = 0;
  } else if (component === "marketplace") {
    await removeSettingsDeclaration(fixture);
    fixture.runner.state.plugins.length = 0;
  }
  // "plugin": the declaration and listing stay present so they keep their own
  // marketplace-add provenance; only the plugin deviates on its own.
}

async function directionSnapshots(fixture) {
  return {
    journalBytes: await readFile(fixture.paths.journalFile),
    configBytes: await readFile(fixture.configFile),
    settingsBytes: await readSettingsOrNull(fixture),
    ...claudeSnapshots(fixture),
  };
}

async function refuseWithoutMutating(fixture, snapshots, expectation) {
  const failure = await capture(() => recoverClaudeFixture(fixture));
  assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT, expectation);
  assert.match(failure.message, /cannot be attributed/);
  assert.deepEqual(await readFile(fixture.paths.journalFile), snapshots.journalBytes, "journal bytes are identical");
  assert.equal(
    await readFile(fixture.configFile, "utf8"),
    snapshots.configBytes.toString("utf8"),
    "config bytes are identical",
  );
  assert.equal(await readSettingsOrNull(fixture), snapshots.settingsBytes, "settings are untouched");
  assert.equal(JSON.stringify(fixture.runner.state), snapshots.stateSnapshot, "zero fake mutations");
  assert.deepEqual(mutationsOf(fixture.runner), snapshots.mutationLines, "zero mutating CLI calls");
  assert.ok(await exists(fixture.paths.journalFile), "the journal is retained");
}

for (const direction of ["forward", "rollback"]) {
  for (const component of ["declaration", "marketplace", "plugin"]) {
    for (const outcome of ["intent", "failed"]) {
      test(`a healthy baseline ${component} disappearing with only an add ${outcome} conflicts (${direction})`, async () => {
        await withTemp(`skill-router-direction-healthy-${component}-${outcome}-${direction}-`, async (root) => {
          const { fixture, document } = await healthyAddJournal(root, direction);
          const addType = component === "plugin" ? "plugin-install" : "marketplace-add";
          await setClaudeActions(
            fixture,
            document.claude.actions.map((entry) => (entry.type === addType ? unprovenRecorded(entry, outcome) : entry)),
          );
          await deviateFromHealthy(fixture, component);

          const snapshots = await directionSnapshots(fixture);
          await refuseWithoutMutating(fixture, snapshots, "an add can never explain a disappearance");
        });
      });

      test(`an absent baseline ${component} appearing with only a remove ${outcome} conflicts (${direction})`, async () => {
        await withTemp(`skill-router-direction-absent-${component}-${outcome}-${direction}-`, async (root) => {
          const { fixture, document } = await absentBaselineJournal(root, direction);
          // The chain keeps the other component's genuine add (so rollback
          // still has compensatable work) while the deviating component only
          // ever recorded a detach in the direction that cannot explain it.
          const addOf = (type) => ({ ...document.claude.actions.find((entry) => entry.type === type), sequence: 1 });
          await setClaudeActions(
            fixture,
            component === "plugin"
              ? [addOf("marketplace-add"), detachAction(fixture, "plugin", outcome, 2)]
              : [addOf("plugin-install"), detachAction(fixture, "marketplace", outcome, 2)],
          );
          await keepOnlyPresent(fixture, component);

          const snapshots = await directionSnapshots(fixture);
          await refuseWithoutMutating(fixture, snapshots, "a remove can never explain an appearance");
        });
      });
    }
  }
}

for (const outcome of ["intent", "failed"]) {
  test(`a healthy baseline plugin disappearance explained by a recorded remove ${outcome} is repaired`, async () => {
    await withTemp(`skill-router-direction-same-remove-${outcome}-`, async (root) => {
      const { fixture } = await healthyAddJournal(root, "forward");
      await setClaudeActions(fixture, [detachAction(fixture, "plugin", outcome, 1)]);
      fixture.runner.state.plugins.length = 0;
      const mutationsBefore = mutationsOf(fixture.runner).length;

      const recovery = await recoverClaudeFixture(fixture);
      assert.equal(recovery.status, "recovered");
      assert.equal(recovery.outcome, "committed");
      assert.equal(fixture.runner.state.plugins.length, 1, "the disappearance was repaired");
      assert.equal(fixture.runner.state.marketplaces.length, 1, "the marketplace is not disturbed");
      assert.ok(mutationsOf(fixture.runner).length > mutationsBefore, "the repair actually re-registered");
      assert.deepEqual(await leftoverArtifacts(root), []);
    });
  });
}

test("a same-direction failed add outcome still explains an absent-baseline appearance", async () => {
  await withTemp("skill-router-direction-same-add-failed-", async (root) => {
    const { fixture, document } = await absentBaselineJournal(root, "forward");
    await setClaudeActions(
      fixture,
      document.claude.actions.map((entry) => unprovenRecorded(entry, "failed")),
    );
    fixture.runner.state.plugins.length = 0;
    const mutationsBefore = mutationsOf(fixture.runner).length;

    const recovery = await recoverClaudeFixture(fixture);
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "committed");
    assert.equal(fixture.runner.state.plugins.length, 1, "the missing plugin was repaired");
    assert.equal(fixture.runner.state.marketplaces.length, 1, "the marketplace is not duplicated");
    assert.ok(mutationsOf(fixture.runner).length > mutationsBefore, "the repair actually re-registered");
    assert.deepEqual(await leftoverArtifacts(root), []);
  });
});

/* ================================================================== *
 * Gate 6 final review - plugin version provenance uses exactly the
 * direction-filtered capable plugin ADD action
 * ================================================================== */

/**
 * The recorded-observed absent-baseline journal (proven marketplace-add and
 * plugin-install) with a later plugin-uninstall appended in either recovery
 * direction, so the install is never the last plugin action in the chain.
 */
async function absentBaselineWithLaterUninstall(root, direction, outcome) {
  const { fixture, document } = await absentBaselineJournal(root, direction);
  const install = document.claude.actions.find((entry) => entry.type === "plugin-install");
  assert.equal(install?.status, "observed", "the install is recorded");
  assert.equal(install.outcome?.status, "succeeded", "the install is proven");
  const sequence = Math.max(...document.claude.actions.map((entry) => entry.sequence)) + 1;
  await setClaudeActions(fixture, [...document.claude.actions, detachAction(fixture, "plugin", outcome, sequence)]);
  const journal = await readJournal(fixture.paths, { allowMissing: true });
  const last = journal.claude.actions.at(-1);
  assert.equal(last.type, "plugin-uninstall", "a later remove follows the install");
  assert.equal(last.status, outcome === "intent" ? "intent" : "observed");
  if (outcome === "failed") assert.equal(last.outcome?.status, "failed");
  return { fixture, journal, install };
}

/** The recorded detach action of `component`, observed to have succeeded. */
function provenDetachAction(fixture, component, sequence) {
  const entry = { ...detachAction(fixture, component, "intent", sequence) };
  delete entry.outcome;
  entry.status = "observed";
  entry.outcome = { status: "succeeded" };
  return entry;
}

/** Builds a synthetic but journal-valid chain over an absent-baseline journal. */
async function versionProvenanceJournal(root, direction, build) {
  const { fixture, document } = await absentBaselineJournal(root, direction);
  const install = document.claude.actions.find((entry) => entry.type === "plugin-install");
  assert.ok(install?.version, "the recorded install carries the version it produced");
  const max = Math.max(...document.claude.actions.map((entry) => entry.sequence));
  await setClaudeActions(fixture, build({ fixture, document, install, next: (offset) => max + offset }));
  return { fixture, install };
}

/** The pure attribution verdict for the fixture's live Claude observation. */
async function attributeFixture(fixture, direction) {
  const observation = await observeClaudeUninstallState({
    plan: fixture.registration,
    exec: fixture.runner,
    cwd: fixture.root,
    env: fixture.env,
  });
  const journal = await readJournal(fixture.paths, { allowMissing: true });
  return attributeClaudeState(observation, journal.claude, direction === "forward" ? "desired" : "prior");
}

for (const direction of ["forward", "rollback"]) {
  for (const outcome of ["intent", "failed"]) {
    test(`a later plugin-uninstall ${outcome} never masks a foreign plugin version (${direction})`, async () => {
      await withTemp(`skill-router-version-pin-${direction}-${outcome}-`, async (root) => {
        const { fixture, install } = await absentBaselineWithLaterUninstall(root, direction, outcome);
        // The observed plugin sits at a foreign version the install never
        // produced; the later remove must not hide that from provenance.
        assert.notEqual(fixture.runner.state.plugins[0].version, "9.9.9", "the foreign version is planted");
        fixture.runner.state.plugins[0].version = "9.9.9";

        const attribution = await attributeFixture(fixture, direction);
        assert.equal(attribution.attributable, false, "a foreign observed version is never attributable");
        assert.match(attribution.reason, /version 9\.9\.9/);
        assert.match(
          attribution.reason,
          new RegExp(`recorded plugin-install action produced ${install.version.replace(/\./g, "\\.")}`),
          "the capable install action pins the expected version, not the later remove",
        );

        const snapshots = await directionSnapshots(fixture);
        await refuseWithoutMutating(fixture, snapshots, "the later remove never hides the expected version");
      });
    });
  }
}

/**
 * The recorded version is accepted only when the action ordering and outcomes
 * make the present plugin truly attributable to the capable add action; any
 * other reading of the same chain at the very same version conflicts.
 */
for (const direction of ["forward", "rollback"]) {
  const accept = (label, build) => {
    test(`an absent-baseline appearance at the recorded version is accepted ${label} (${direction})`, async () => {
      await withTemp(`skill-router-version-accept-${direction}-`, async (root) => {
        const { fixture, install } = await versionProvenanceJournal(root, direction, build);
        assert.equal(fixture.runner.state.plugins[0].version, install.version, "the observed version is the recorded one");

        assert.equal((await attributeFixture(fixture, direction)).attributable, true, "the chain is attributable");

        const recovery = await recoverClaudeFixture(fixture);
        assert.equal(recovery.status, "recovered");
        assert.equal(recovery.outcome, direction === "forward" ? "committed" : "rolled-back");
        if (direction === "forward") {
          assert.equal(fixture.runner.state.plugins.length, 1, "the registration stands");
          assert.equal(fixture.runner.state.plugins[0].version, install.version, "at the recorded version");
        } else {
          assert.equal(fixture.runner.state.plugins.length, 0, "the recorded prior (absent) is restored");
          assert.equal(fixture.runner.state.marketplaces.length, 0, "the marketplace is detached too");
        }
        assert.deepEqual(await leftoverArtifacts(root), []);
      });
    });
  };

  const refuse = (label, build, expectation) => {
    test(`an incoherent appearance at the recorded version conflicts ${label} (${direction})`, async () => {
      await withTemp(`skill-router-version-conflict-${direction}-`, async (root) => {
        const { fixture, install } = await versionProvenanceJournal(root, direction, build);
        fixture.runner.state.plugins[0].version = install.version;

        const attribution = await attributeFixture(fixture, direction);
        assert.equal(attribution.attributable, false, expectation);
        assert.match(attribution.reason, /plugin-uninstall/);

        const snapshots = await directionSnapshots(fixture);
        await refuseWithoutMutating(fixture, snapshots, expectation);
      });
    });
  };

  // A later remove that is only an intent or an observed failure may not have
  // landed, so the plugin can still sit exactly where the proven install left
  // it - at the version that install produced.
  for (const outcome of ["intent", "failed"]) {
    accept(`when the later uninstall ${outcome} is unproven`, ({ fixture, document, next }) => [
      ...document.claude.actions,
      detachAction(fixture, "plugin", outcome, next(1)),
    ]);
  }

  // A proven later remove landed after the proven install: presence at any
  // version - including the install's own - has no coherent reading.
  refuse("when a proven uninstall follows the proven install", ({ fixture, document, next }) => [
    ...document.claude.actions,
    provenDetachAction(fixture, "plugin", next(1)),
  ], "a proven remove after the capable install contradicts the observed presence");

  // Remove then re-add: the latest overall action is again a capable add at
  // the same version, which is exactly what the observation shows.
  accept("when a proven re-install follows the proven uninstall", ({ fixture, document, install, next }) => [
    ...document.claude.actions,
    provenDetachAction(fixture, "plugin", next(1)),
    { ...install, sequence: next(2) },
  ]);

  // The opposite ordering: the install is only a durable intent while a later
  // proven remove landed - presence can never be attributed, and the version
  // check is never reached as a licence to accept it.
  refuse("when a proven uninstall follows an install intent", ({ fixture, document, install, next }) => [
    ...document.claude.actions.filter((entry) => entry.type !== "plugin-install"),
    unprovenRecorded(install, "intent"),
    provenDetachAction(fixture, "plugin", next(1)),
  ], "a proven remove after an unproven install contradicts the observed presence");
}

/* ================================================================== *
 * Gate 6 blocker A - the deterministic desired-state cleanup claim is
 * classified read-only, before any journal/config/payload/Claude/fs mutation
 * ================================================================== */

/**
 * A rollback pending state whose after-state config genuinely landed, whose
 * canonical tree is exactly the recorded desired state, whose backup holds
 * the exact recorded prior, and whose journal records a Claude section. Any
 * preflight refusal must leave all of it - including the Claude state and the
 * whole CLI log - untouched, because the claim proof runs before the Claude
 * observer is ever entered.
 */
async function appliedClaudeRollback(root) {
  const fixture = await claudeFixture(root);
  await leavePendingClaudeJournal(fixture, { fault: ["journal:proven", "recovery:files"] });
  const document = await readJournal(fixture.paths, { allowMissing: true });
  assert.equal(document.mode, "rollback");
  assert.equal(document.files[0].status, "applied", "the config write landed before the crash");
  assert.equal(await readFile(fixture.configFile, "utf8"), NEW_CONFIG, "the after-state config is in place");
  assert.ok(document.claude, "the journal records a Claude section");
  assert.equal(fixture.runner.state.plugins.length, 1, "the registration is healthy");
  return { fixture, document };
}

async function treeShape(target) {
  const info = await inspectStateTree(target);
  return { status: info.status, digest: info.digest ?? null, reason: info.reason ?? null };
}

function recordedPayloadPaths(document) {
  return document.files.flatMap((file) => [file.before.payloadPath, file.after.payloadPath].filter(Boolean));
}

/** Exact journal/config/payload/Claude/artifact state a refusal must preserve. */
async function preflightSnapshots(fixture, document) {
  const journal = await readJournal(fixture.paths, { allowMissing: true });
  return {
    journalBytes: await readFile(fixture.paths.journalFile),
    revision: journal.revision,
    mode: journal.mode,
    phase: journal.phase,
    fileStatuses: journal.files.map((entry) => entry.status),
    configBytes: await readFile(fixture.configFile),
    payloadBytes: await Promise.all(recordedPayloadPaths(document).map((payloadPath) => readIfPresent(payloadPath))),
    canonical: await treeShape(fixture.stateDirectory),
    claim: await treeShape(claimPathFor(fixture.stateDirectory, document.transactionId)),
    backup: await treeShape(document.state.backup.path),
    rootEntries: (await listEntries(root0(fixture))).sort(),
    controlEntries: (await listEntries(fixture.paths.controlDirectory)).sort(),
    claudeState: JSON.stringify(fixture.runner.state),
    cliLog: [...fixture.runner.log],
    settingsBytes: await readSettingsOrNull(fixture),
  };
}

async function assertPreflightSnapshotsIntact(fixture, document, snapshots) {
  assert.deepEqual(await readFile(fixture.paths.journalFile), snapshots.journalBytes, "journal bytes are identical");
  const journal = await readJournal(fixture.paths, { allowMissing: true });
  assert.equal(journal.revision, snapshots.revision, "the journal revision is unchanged");
  assert.equal(journal.mode, snapshots.mode, "the journal mode is unchanged");
  assert.equal(journal.phase, snapshots.phase, "the journal phase is unchanged");
  assert.deepEqual(
    journal.files.map((entry) => entry.status),
    snapshots.fileStatuses,
    "the file statuses are unchanged",
  );
  assert.equal(
    await readFile(fixture.configFile, "utf8"),
    snapshots.configBytes.toString("utf8"),
    "the after-state config is identical",
  );
  assert.deepEqual(
    await Promise.all(recordedPayloadPaths(document).map((payloadPath) => readIfPresent(payloadPath))),
    snapshots.payloadBytes,
    "payload bytes are identical",
  );
  assert.deepEqual(await treeShape(fixture.stateDirectory), snapshots.canonical, "the canonical tree is untouched");
  assert.deepEqual(
    await treeShape(claimPathFor(fixture.stateDirectory, document.transactionId)),
    snapshots.claim,
    "the cleanup claim is untouched",
  );
  assert.deepEqual(await treeShape(document.state.backup.path), snapshots.backup, "the recorded backup is untouched");
  assert.deepEqual(
    (await listEntries(root0(fixture))).sort(),
    snapshots.rootEntries,
    "the artifact inventory is unchanged",
  );
  assert.deepEqual(
    (await listEntries(fixture.paths.controlDirectory)).sort(),
    snapshots.controlEntries,
    "the control inventory is unchanged",
  );
  assert.equal(JSON.stringify(fixture.runner.state), snapshots.claudeState, "Claude state is untouched");
  assert.deepEqual([...fixture.runner.log], snapshots.cliLog, "zero CLI calls were issued");
  assert.equal(await readSettingsOrNull(fixture), snapshots.settingsBytes, "settings are untouched");
}

/**
 * Plants a hostile tree at the derived cleanup claim path: a different owned
 * tree, an unattributable directory, a symlink, a special file, or an
 * owner-unsafe mode. Returns false when the platform cannot express the
 * variant, in which case the caller skips the case.
 */
async function plantHostileClaim(root, claimPath, variant) {
  if (variant === "changed") {
    await mkdir(claimPath, { mode: 0o700 });
    await writeFile(path.join(claimPath, STATE_MARKER_FILE), `${STATE_MARKER_CONTENT}\n`, { mode: 0o600 });
    await writeFile(path.join(claimPath, "registry.json"), "not-the-desired-tree\n", { mode: 0o600 });
    if (process.platform !== "win32") await chmod(claimPath, 0o700);
    return true;
  }
  if (variant === "foreign") {
    await mkdir(claimPath);
    await writeFile(path.join(claimPath, "hands-off.txt"), "keep");
    return true;
  }
  if (variant === "symlink") {
    const innocent = path.join(root, "innocent-claim-target");
    await ownedMarkerTree(innocent);
    await symlink(innocent, claimPath);
    return true;
  }
  if (variant === "wrong-mode") {
    if (process.platform === "win32") return false;
    await ownedMarkerTree(claimPath);
    await chmod(claimPath, 0o777);
    return true;
  }
  return spawnSync("mkfifo", [claimPath]).status === 0;
}

for (const form of ["canonical", "claim"]) {
  for (const variant of ["changed", "foreign", "symlink", "special", "wrong-mode"]) {
    test(`a ${variant} cleanup claim refuses rollback before any mutation or CLI call (${form} form)`, async () => {
      await withTemp(`skill-router-claim-hostile-${form}-${variant}-`, async (root) => {
        const { fixture, document } = await appliedClaudeRollback(root);
        const claimPath = claimPathFor(fixture.stateDirectory, document.transactionId);
        if (form === "claim") {
          // The desired tree already moved to its derived claim (an
          // interrupted cleanup); the hostile replacement stands in for a
          // claim recovery must never adopt or finish.
          await rename(fixture.stateDirectory, claimPath);
          await rm(claimPath, { recursive: true, force: true });
          assert.equal(await exists(fixture.stateDirectory), false, "the canonical path is absent");
        }
        if (!(await plantHostileClaim(root, claimPath, variant))) return;

        const snapshots = await preflightSnapshots(fixture, document);
        assert.equal(snapshots.canonical.status, form === "canonical" ? "owned" : "absent");

        const failure = await capture(() => recoverClaudeFixture(fixture));
        assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT, `${variant} claim fails closed`);
        assert.match(failure.message, /left untouched/);

        await assertPreflightSnapshotsIntact(fixture, document, snapshots);

        // The hostile claim itself is preserved exactly as the test left it.
        if (variant === "changed") {
          assert.equal(await readFile(path.join(claimPath, "registry.json"), "utf8"), "not-the-desired-tree\n");
        } else if (variant === "foreign") {
          assert.equal(await readFile(path.join(claimPath, "hands-off.txt"), "utf8"), "keep");
        } else if (variant === "symlink") {
          assert.equal((await lstat(claimPath)).isSymbolicLink(), true, "the symlink survives");
        } else if (variant === "special") {
          assert.equal((await lstat(claimPath)).isFIFO(), true, "the special file survives");
        } else {
          assert.equal((await lstat(claimPath)).mode & 0o777, 0o777, "the wrong mode survives");
        }
        // Exactly one claim exists: nothing else was renamed or invented
        // (a hostile claim carries no external attribution record).
        assert.deepEqual((await claimEntriesIn(root)).sort(), [path.basename(claimPath)]);
      });
    });
  }
}

test("a canonical tree and its exact cleanup claim together are ambiguous and untouched", async () => {
  await withTemp("skill-router-claim-both-present-", async (root) => {
    const { fixture, document } = await appliedClaudeRollback(root);
    const claimPath = claimPathFor(fixture.stateDirectory, document.transactionId);
    const backupPath = document.state.backup.path;
    const priorDigest = (await inspectStateTree(backupPath)).digest;

    // Canonical holds the recorded prior while the exact desired tree sits at
    // its durably attributed cleanup claim: neither endpoint can be trusted
    // without guessing.
    const seeded = await seedClaimContainer(fixture.stateDirectory, document.transactionId, { kind: "canonical" });
    await rename(backupPath, fixture.stateDirectory);
    assert.equal((await inspectStateTree(fixture.stateDirectory)).digest, priorDigest, "the prior is at canonical");
    assert.equal((await inspectStateTree(seeded.movedPath)).digest, document.state.stage.digest, "the claim is exact");

    const snapshots = await preflightSnapshots(fixture, document);

    const failure = await capture(() => recoverClaudeFixture(fixture));
    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_AMBIGUOUS, "both endpoints fail closed");
    assert.match(failure.message, /left untouched/);

    await assertPreflightSnapshotsIntact(fixture, document, snapshots);
    assert.equal((await inspectStateTree(fixture.stateDirectory)).digest, priorDigest, "the canonical prior survives");
    assert.equal((await inspectStateTree(seeded.movedPath)).digest, document.state.stage.digest, "the claim survives");
    assert.deepEqual(
      (await claimEntriesIn(root)).sort(),
      [path.basename(claimPath), `${path.basename(claimPath)}.json`].sort(),
    );
  });
});

/* ================================================================== *
 * Phase 14 - an unprovable recorded identity never authorizes deletion
 * ================================================================== */

test("a journal that recorded a zero/invalid artifact identity never authorizes recovery deletion", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const project = await createProject(root);
    // Interrupt after the install rename: this rollback must prove the
    // recorded prior state before it may clean the desired tree and backup.
    await leavePendingJournal(project, { fault: ["file-write", "recovery:files"] });

    const document = await readJournal(project.paths, { allowMissing: true });
    const backupPath = document.state.backup.path;
    assert.equal(await exists(backupPath), true, "the recorded backup exists");
    const backupBefore = await digestTree(backupPath);
    const canonicalBefore = await digestTree(project.stateDirectory);

    // Older journals could record a zero/invalid dev/ino pair. The schema
    // accepts it, but it must never authorize a destructive cleanup - even
    // though the recorded digest still matches the backup tree exactly.
    const patched = await updateJournal(
      project.paths,
      document,
      {
        state: {
          stage: document.state.stage,
          backup: { ...document.state.backup, identity: { dev: 0, ino: 0 } },
        },
      },
      { lease: project.lease, recovery: true },
    );
    assert.deepEqual(patched.state.backup.identity, { dev: 0, ino: 0 }, "the invalid identity is exactly as recorded");

    const failure = await capture(() => recover(project));
    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.match(failure.message, /not the recorded prior state/);

    assert.equal(await exists(backupPath), true, "the backup is preserved");
    assert.deepEqual(await digestTree(backupPath), backupBefore, "the backup is untouched");
    assert.equal(await exists(project.stateDirectory), true, "the desired canonical tree is preserved");
    assert.deepEqual(await digestTree(project.stateDirectory), canonicalBefore, "the canonical tree is untouched");
    assert.equal(await exists(project.paths.journalFile), true, "the journal stays for a human decision");
  });
});

/* ================================================================== *
 * Phase 14 / B2 - claim-and-publish file application and restoration
 * ================================================================== */

const B2_TX = "ef".repeat(32);

/** Target holding `targetBytes`, plus its prepared before/after payloads. */
async function b2Fixture(root, project0, targetBytes) {
  const project = project0 ?? (await createProject(root));
  await writeFile(project.configFile, targetBytes, { mode: 0o600 });
  const records = await prepareFilePayloads(
    B2_TX,
    [{ target: project.configFile, role: "router-config", afterBytes: Buffer.from(NEW_CONFIG) }],
    { lease: project.lease },
  );
  return { project, record: records[0], document: { transactionId: B2_TX } };
}

/** Lease whose Nth assertHeld runs the injected hook (deterministic swap seam). */
function scriptedLease(paths, hooks) {
  let calls = 0;
  return {
    paths,
    async assertHeld() {
      calls += 1;
      const hook = hooks[calls];
      if (hook) await hook();
      return true;
    },
  };
}

test("B2: a replacement that appears at the target is never overwritten and the claim is preserved", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const { project, record, document } = await b2Fixture(root, null, OLD_CONFIG);
    const claimPath = claimPathFor(record.target, B2_TX);
    // assertHeld #1 precedes the move-aside, #2 precedes the publish.
    const lease = scriptedLease(project.paths, {
      2: async () => {
        await writeFile(record.target, "foreign-replacement", { mode: 0o600 });
      },
    });

    const failure = await capture(() => applyFileFromPayload(document, record, { lease }));
    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.match(failure.message, /replaced while the payload was being written/);
    assert.equal(await readFile(record.target, "utf8"), "foreign-replacement", "the replacement is never overwritten");
    const movedChild = (await readdir(claimPath)).find((name) => name.startsWith("moved-"));
    assert.ok(movedChild, "the claim container holds its moved child");
    assert.equal(await readFile(path.join(claimPath, movedChild), "utf8"), OLD_CONFIG, "the claim preserves the classified entry");
    assert.equal(await readFile(record.after.payloadPath, "utf8"), NEW_CONFIG, "the payload is not consumed");
  });
});

test("B2: a payload swapped after it was read is preserved and never consumed", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const { project, record, document } = await b2Fixture(root, null, OLD_CONFIG);
    const claimPath = claimPathFor(record.target, B2_TX);
    const lease = scriptedLease(project.paths, {
      2: async () => {
        // Rename the consumed payload aside instead of deleting it: an inode
        // allocator with eager reuse (ext4 on the Linux runner) can give the
        // replacement the same dev/ino the deleted file just freed, which
        // would make the swap invisible to the identity recheck. Renaming
        // keeps the old inode allocated, so the replacement always differs.
        await rename(record.after.payloadPath, `${record.after.payloadPath}.pinned`);
        await writeFile(record.after.payloadPath, "swapped-payload", { mode: 0o600 });
      },
    });

    const failure = await capture(() => applyFileFromPayload(document, record, { lease }));
    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.match(failure.message, /replaced while it was being consumed/);
    assert.equal(await readFile(record.target, "utf8"), NEW_CONFIG, "the target holds the verified in-memory bytes");
    assert.equal(
      await readFile(record.after.payloadPath, "utf8"),
      "swapped-payload",
      "the swapped payload is preserved, never deleted",
    );
    const movedChild = (await readdir(claimPath)).find((name) => name.startsWith("moved-"));
    assert.equal(await readFile(path.join(claimPath, movedChild), "utf8"), OLD_CONFIG, "the claim is preserved");
  });
});

test("B2: an interrupted apply resumes from its derived claim and finishes exactly", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const { record, document } = await b2Fixture(root, null, OLD_CONFIG);
    const claimPath = claimPathFor(record.target, B2_TX);
    // The crash: the classified prior entry was moved into its durably
    // attributed claim container, the publish never ran.
    await seedClaimContainer(record.target, B2_TX, { kind: "file" });

    const outcome = await applyFileFromPayload(document, record, {});
    assert.equal(outcome, "applied");
    assert.equal(await readFile(record.target, "utf8"), NEW_CONFIG, "the payload is published");
    assert.equal(await exists(claimPath), false, "the claim is consumed after the publish");
    assert.equal(await exists(record.after.payloadPath), false, "the payload is consumed");
  });
});

test("B2: an interrupted restore resumes from its derived claim and finishes exactly", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const project = await createProject(root);
    const { record, document } = await b2Fixture(root, project, OLD_CONFIG);
    const claimPath = claimPathFor(record.target, B2_TX);
    // The apply completed, then a restore moved the current entry into its
    // derived claim container and crashed before publishing the prior bytes.
    await writeFile(record.target, NEW_CONFIG, { mode: 0o600 });
    await seedClaimContainer(record.target, B2_TX, { kind: "file" });

    const outcome = await restoreFileFromPayload(document, record, {});
    assert.equal(outcome, "restored");
    assert.equal(await readFile(record.target, "utf8"), OLD_CONFIG, "the prior bytes are restored");
    assert.equal(await exists(claimPath), false, "the claim is consumed");
    assert.equal(await exists(record.before.payloadPath), false, "the prior payload is consumed");
    assert.equal(await readFile(record.after.payloadPath, "utf8"), NEW_CONFIG, "the after payload is untouched");
  });
});

test("B2: a foreign replacement at the target during rollback is preserved, never overwritten", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const { project, record, document } = await b2Fixture(root, null, OLD_CONFIG);
    const claimPath = claimPathFor(record.target, B2_TX);
    await writeFile(record.target, NEW_CONFIG, { mode: 0o600 });
    // assertHeld #1 precedes the move-aside: the classified entry is swapped
    // for a foreign file right before it is moved, so the claimed entry can
    // never be proven to be the classified one.
    const lease = scriptedLease(project.paths, {
      1: async () => {
        // Rename the classified entry aside instead of deleting it: an inode
        // allocator with eager reuse (ext4 on the Linux runner) can give the
        // replacement the same dev/ino the deleted file just freed, which
        // would make the swap invisible to the identity check. Renaming keeps
        // the old inode allocated, so the replacement always differs.
        await rename(record.target, `${record.target}.pinned`);
        await writeFile(record.target, "foreign-replacement", { mode: 0o600 });
      },
    });

    const failure = await capture(() => restoreFileFromPayload(document, record, { lease }));
    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.match(failure.message, /not the entry that was classified/);
    const movedChild = (await readdir(claimPath)).find((name) => name.startsWith("moved-"));
    assert.equal(
      await readFile(path.join(claimPath, movedChild), "utf8"),
      "foreign-replacement",
      "the foreign replacement is preserved at the claim",
    );
    assert.equal(await exists(record.target), false, "the destination stays absent; nothing was overwritten");
    assert.equal(await readFile(record.before.payloadPath, "utf8"), OLD_CONFIG, "the prior payload is untouched");
  });
});

test("B2: a rollback of an apply interrupted at its claim restores the prior bytes exactly", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const { record, document } = await b2Fixture(root, null, OLD_CONFIG);
    const claimPath = claimPathFor(record.target, B2_TX);
    // Interrupted apply: the prior entry sits inside the durably attributed
    // claim container. The rollback must recognize it (it holds the recorded
    // prior bytes) rather than refuse.
    await seedClaimContainer(record.target, B2_TX, { kind: "file" });

    const outcome = await restoreFileFromPayload(document, record, {});
    assert.equal(outcome, "restored");
    assert.equal(await readFile(record.target, "utf8"), OLD_CONFIG, "the prior bytes are restored");
    assert.equal(await exists(claimPath), false, "the claim is consumed");
    assert.equal(await exists(record.before.payloadPath), false, "the prior payload is consumed");
  });
});

test("B1: a cleanup claim replaced after its final verification is preserved, never recursively deleted", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const lease = fakeLease(null);
    const artifact = await ownedMarkerTree(path.join(root, "artifact"));
    const info = await inspectStateTree(artifact);
    const expectation = { identity: info.identity, digest: info.digest };
    const claimPath = claimPathFor(artifact, TX);

    let removals = 0;
    const originalRm = journaledTransactionInternals.rm;
    const originalStep = journaledTransactionInternals.onStep;
    journaledTransactionInternals.rm = async (target, options) => {
      removals += 1;
      return originalRm(target, options);
    };
    journaledTransactionInternals.onStep = async (name) => {
      if (name === "cleanup:backup:recheck") {
        // B1 injection: the claim is replaced after its final verification and
        // immediately before the destructive removal.
        await rm(claimPath, { recursive: true, force: true });
        await mkdir(claimPath, { recursive: true });
        await writeFile(path.join(claimPath, "registry.json"), "replacement\n", { mode: 0o600 });
      }
    };
    let failure = null;
    try {
      failure = await capture(() =>
        cleanupStateArtifactViaClaim({ lease, artifactPath: artifact, transactionId: TX, expectation, label: "backup" }),
      );
    } finally {
      journaledTransactionInternals.rm = originalRm;
      journaledTransactionInternals.onStep = originalStep;
    }

    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.match(failure.message, /changed before it was removed; it was preserved/);
    assert.equal(removals, 0, "no recursive deletion ran");
    assert.equal(await readFile(path.join(claimPath, "registry.json"), "utf8"), "replacement\n", "the replacement survives");
    assert.equal(await exists(artifact), false, "the original path stays absent");
  });
});

/* ================================================================== *
 * Phase 14 / B2+B3 remediation - claim containers, deletion claims,
 * and no-overwrite restoration
 * ================================================================== */

test("B3: a foreign file at the derived state-claim path is never overwritten and is preserved", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const lease = fakeLease(null);
    const artifact = await ownedMarkerTree(path.join(root, "artifact"));
    const info = await inspectStateTree(artifact);
    const expectation = { identity: info.identity, digest: info.digest };
    const claimPath = claimPathFor(artifact, TX);
    await writeFile(claimPath, "foreign-claim", { mode: 0o600 });

    const failure = await capture(() =>
      cleanupStateArtifactViaClaim({ lease, artifactPath: artifact, transactionId: TX, expectation, label: "backup" }),
    );
    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_AMBIGUOUS);
    assert.match(failure.message, /both present/);
    assert.equal(await readFile(claimPath, "utf8"), "foreign-claim", "the foreign claim is preserved byte-identical");
    assert.equal((await lstat(artifact)).isDirectory(), true, "the artifact is untouched");
  });
});

test("B3: an empty directory at the derived state-claim path is never overwritten and is preserved", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const lease = fakeLease(null);
    const artifact = await ownedMarkerTree(path.join(root, "artifact"));
    const info = await inspectStateTree(artifact);
    const expectation = { identity: info.identity, digest: info.digest };
    const claimPath = claimPathFor(artifact, TX);
    await mkdir(claimPath, { mode: 0o700 });

    const failure = await capture(() =>
      cleanupStateArtifactViaClaim({ lease, artifactPath: artifact, transactionId: TX, expectation, label: "backup" }),
    );
    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_AMBIGUOUS);
    assert.match(failure.message, /both present/);
    assert.equal((await lstat(claimPath)).isDirectory(), true, "the empty foreign directory is preserved");
    assert.equal((await readdir(claimPath)).length, 0, "nothing was renamed into it");
    assert.equal((await lstat(artifact)).isDirectory(), true, "the artifact is untouched");
  });
});

test("B2: an interrupted deletion claim is discovered and finished on re-entry", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const lease = fakeLease(null);
    const artifact = await ownedMarkerTree(path.join(root, "artifact"));
    const info = await inspectStateTree(artifact);
    const expectation = { identity: info.identity, digest: info.digest };
    const claimPath = claimPathFor(artifact, TX);
    // The crash after the fresh, unpredictable deletion move: the durably
    // attributed container holds the deletion claim, the original path is
    // absent.
    const seeded = await seedClaimContainer(artifact, TX, { kind: "backup", move: false });
    await rename(artifact, path.join(seeded.containerPath, `delete-${"ab".repeat(16)}`));

    const result = await cleanupStateArtifactViaClaim({
      lease,
      artifactPath: artifact,
      transactionId: TX,
      expectation,
      label: "backup",
    });
    assert.ok(["absent", "removed"].includes(result));
    assert.deepEqual(await readdir(root), [], "the deletion claim and its container are gone");
  });
});

test("B3: restoration refuses to rename over a replacement and preserves the backup", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const project = await createProject(root);
    await leavePendingJournal(project, { fault: ["file-write", "recovery:files"] });
    const document = await readJournal(project.paths, { allowMissing: true });
    const backupPath = document.state.backup.path;
    assert.equal(await exists(backupPath), true, "the recorded backup exists");

    // Simulate an interrupted canonical cleanup: the desired tree sits at its
    // derived claim and the canonical path is absent.
    const canonicalClaim = claimPathFor(project.stateDirectory, document.transactionId);
    await seedClaimContainer(project.stateDirectory, document.transactionId, { kind: "canonical" });

    // A hostile replacement reappears at the canonical path right after the
    // canonical claim cleanup (its final recheck step) and before the
    // restore rename; restoration must refuse rather than overwrite it.
    const originalStep = journaledTransactionInternals.onStep;
    journaledTransactionInternals.onStep = async (name) => {
      if (name === "cleanup:canonical:recheck") {
        await mkdir(project.stateDirectory, { recursive: true, mode: 0o700 });
        await writeFile(path.join(project.stateDirectory, "intruder.txt"), "survives", { mode: 0o600 });
      }
    };
    let failure = null;
    try {
      failure = await capture(() => recover(project));
    } finally {
      journaledTransactionInternals.onStep = originalStep;
    }

    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.match(failure.message, /is present; the recorded backup was preserved/);
    assert.equal(await exists(backupPath), true, "the recorded backup (the restoration claim) is preserved");
    assert.equal(
      await readFile(path.join(project.stateDirectory, "intruder.txt"), "utf8"),
      "survives",
      "the replacement at the canonical path is never overwritten",
    );
    assert.ok(await exists(project.paths.journalFile), "the journal stays for a human decision");
  });
});

/* ================================================================== *
 * Phase 14 / B3 remediation - attributed containers, closed-grammar
 * children, and no unsafe restoration
 * ================================================================== */

test("B3: a foreign child inside an attributed container refuses cleanup and is preserved", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const lease = fakeLease(null);
    const artifact = await ownedMarkerTree(path.join(root, "artifact"));
    const info = await inspectStateTree(artifact);
    const expectation = { identity: info.identity, digest: info.digest };
    const seeded = await seedClaimContainer(artifact, TX, { kind: "backup" });
    await writeFile(path.join(seeded.containerPath, "intruder.txt"), "keep", { mode: 0o600 });

    const failure = await capture(() =>
      cleanupStateArtifactViaClaim({ lease, artifactPath: artifact, transactionId: TX, expectation, label: "backup" }),
    );
    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.match(failure.message, /unattributable entry|not an attributed claim/);
    assert.equal(await readFile(path.join(seeded.containerPath, "intruder.txt"), "utf8"), "keep", "the foreign child survives");
    assert.equal(
      (await inspectStateTree(seeded.movedPath)).digest,
      info.digest,
      "the moved artifact inside the container is preserved",
    );
  });
});

test("B3: a container replaced before its final drop is preserved, never removed", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const lease = fakeLease(null);
    const artifact = await ownedMarkerTree(path.join(root, "artifact"));
    const info = await inspectStateTree(artifact);
    const expectation = { identity: info.identity, digest: info.digest };
    const claimPath = claimPathFor(artifact, TX);

    const originalRm = journaledTransactionInternals.rm;
    journaledTransactionInternals.rm = async (target, options) => {
      const result = await originalRm(target, options);
      // The container is replaced right after the verified deletion removal
      // and before the attributed container drop.
      await rm(claimPath, { recursive: true, force: true });
      await mkdir(claimPath, { mode: 0o700 });
      if (process.platform !== "win32") await chmod(claimPath, 0o700);
      await writeFile(path.join(claimPath, "intruder.txt"), "survives", { mode: 0o600 });
      return result;
    };
    let result = null;
    try {
      result = await cleanupStateArtifactViaClaim({ lease, artifactPath: artifact, transactionId: TX, expectation, label: "backup" });
    } finally {
      journaledTransactionInternals.rm = originalRm;
    }
    assert.equal(result, "removed", "the proven artifact removal completed");
    assert.equal(
      await readFile(path.join(claimPath, "intruder.txt"), "utf8"),
      "survives",
      "the replaced container survives, never removed by an unprovable drop",
    );
    assert.equal(await exists(artifact), false, "the artifact itself was removed through its proven claim");
  });
});

test("B3: a deletion claim replaced after its reproof is preserved and never recursively deleted", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const lease = fakeLease(null);
    const artifact = await ownedMarkerTree(path.join(root, "artifact"));
    const info = await inspectStateTree(artifact);
    const expectation = { identity: info.identity, digest: info.digest };
    const claimPath = claimPathFor(artifact, TX);

    const originalRename = journaledTransactionInternals.claimRename;
    let swaps = 0;
    journaledTransactionInternals.claimRename = async (from, to) => {
      await originalRename(from, to);
      // The re-claim rename (delete-* -> delete-*) is the last fresh name
      // before the recursive removal: replace its destination.
      if (/\/delete-[0-9a-f]{32}$/.test(String(from)) && /\/delete-[0-9a-f]{32}$/.test(String(to)) && swaps === 0) {
        swaps += 1;
        await rm(to, { recursive: true, force: true });
        await ownedMarkerTree(to);
        await writeFile(path.join(to, "registry.json"), "replacement\n", { mode: 0o600 });
      }
    };
    let removals = 0;
    const originalRm = journaledTransactionInternals.rm;
    journaledTransactionInternals.rm = async (target, options) => {
      removals += 1;
      return originalRm(target, options);
    };
    let failure = null;
    try {
      failure = await capture(() =>
        cleanupStateArtifactViaClaim({ lease, artifactPath: artifact, transactionId: TX, expectation, label: "backup" }),
      );
    } finally {
      journaledTransactionInternals.claimRename = originalRename;
      journaledTransactionInternals.rm = originalRm;
    }
    assert.equal(swaps, 1, "the re-claim rename actually ran");
    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.match(failure.message, /re-claimed deletion claim .* could not be verified; it was preserved/);
    assert.equal(removals, 0, "no recursive deletion ran");
    const replacementChild = (await readdir(claimPath)).find((name) => /^delete-[0-9a-f]{32}$/.test(name));
    assert.ok(replacementChild, "the replacement survives at the re-claimed name");
    assert.equal(
      await readFile(path.join(claimPath, replacementChild, "registry.json"), "utf8"),
      "replacement\n",
      "the replacement is preserved byte for byte",
    );
  });
});

test("B3: a container created but never moved into is resumed and finished on re-entry", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const lease = fakeLease(null);
    const artifact = await ownedMarkerTree(path.join(root, "artifact"));
    const info = await inspectStateTree(artifact);
    const expectation = { identity: info.identity, digest: info.digest };
    const seeded = await seedClaimContainer(artifact, TX, { kind: "backup", move: false });

    const result = await cleanupStateArtifactViaClaim({
      lease,
      artifactPath: artifact,
      transactionId: TX,
      expectation,
      label: "backup",
    });
    assert.equal(result, "removed");
    assert.equal(await exists(seeded.containerPath), false, "the resumed container is dropped after the removal");
    assert.equal(await exists(artifact), false);
    assert.deepEqual(await readdir(root), [], "nothing is left behind");
  });
});

test("B3: an emptied attributed container left by an interrupted cleanup is removed on re-entry", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const lease = fakeLease(null);
    const artifact = await ownedMarkerTree(path.join(root, "artifact"));
    const info = await inspectStateTree(artifact);
    const expectation = { identity: info.identity, digest: info.digest };
    const seeded = await seedClaimContainer(artifact, TX, { kind: "backup", move: false });
    // The crash: the artifact was already removed, only the attributed
    // container (its record included) remains.
    await rm(artifact, { recursive: true, force: true });

    const result = await cleanupStateArtifactViaClaim({
      lease,
      artifactPath: artifact,
      transactionId: TX,
      expectation,
      label: "backup",
    });
    assert.equal(result, "absent");
    assert.equal(await exists(seeded.containerPath), false, "the emptied proven container is removed");
    assert.deepEqual(await readdir(root), []);
  });
});

test("B3: a destination replacement before the final reservation re-proof is caught and the backup is preserved", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const project = await createProject(root);
    await leavePendingJournal(project, { fault: ["file-write", "recovery:files"] });
    const document = await readJournal(project.paths, { allowMissing: true });
    const backupPath = document.state.backup.path;
    assert.equal(await exists(backupPath), true, "the recorded backup exists");
    const canonicalClaim = claimPathFor(project.stateDirectory, document.transactionId);
    await seedClaimContainer(project.stateDirectory, document.transactionId, { kind: "canonical" });

    // A hostile replacement lands inside the reservation window, right after
    // the `restore:reserve` step and before the final re-proof.
    const originalStep = journaledTransactionInternals.onStep;
    journaledTransactionInternals.onStep = async (name, context) => {
      if (name === "restore:reserve" && context && context.path === project.stateDirectory) {
        await writeFile(path.join(project.stateDirectory, "intruder.txt"), "survives", { mode: 0o600 });
      }
    };
    let failure = null;
    try {
      failure = await capture(() => recover(project));
    } finally {
      journaledTransactionInternals.onStep = originalStep;
    }
    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.match(failure.message, /replaced during restoration; the recorded backup was preserved/);
    assert.equal(await exists(backupPath), true, "the recorded backup is preserved for explicit later recovery");
    assert.equal(
      await readFile(path.join(project.stateDirectory, "intruder.txt"), "utf8"),
      "survives",
      "the replacement at the destination is never overwritten",
    );
    assert.ok(await exists(project.paths.journalFile), "the journal stays for a human decision");
    assert.equal(await exists(canonicalClaim), false, "the canonical claim cleanup itself had completed before the reservation");
  });
});

/* ================================================================== *
 * Phase 14 / R3+R4 - deletion intent and restoration reservation records
 * ================================================================== */

/** Overwrites a claim's external record with child + deletion-intent fields. */
async function writeClaimRecordWithIntent(containerPath, transactionId, kind, { child, deletion }) {
  const stat = await lstat(containerPath);
  await writeFile(
    `${containerPath}.json`,
    `${JSON.stringify({
      schema: 1,
      owner: "skill-router",
      transactionId,
      kind,
      container: { dev: Number(stat.dev), ino: Number(stat.ino) },
      child: { dev: Number(child.dev), ino: Number(child.ino) },
      deletion: { child: deletion.child, identity: { dev: Number(deletion.identity.dev), ino: Number(deletion.identity.ino) } },
    })}\n`,
    { mode: 0o600 },
  );
}

test("R3: a recorded deletion intent continues a partially removed tree by root identity", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const lease = fakeLease(null);
    const artifact = await ownedMarkerTree(path.join(root, "artifact"));
    const info = await inspectStateTree(artifact);
    const expectation = { identity: info.identity, digest: info.digest };
    const seeded = await seedClaimContainer(artifact, TX, { kind: "backup" });

    // Simulate the crash mid-removal: the tree was renamed to its deletion
    // child, the intent was recorded, and the recursive rm was interrupted
    // after removing one entry (the recorded digest no longer matches).
    const deleteChild = path.join(seeded.containerPath, `delete-${"ab".repeat(16)}`);
    await rename(seeded.movedPath, deleteChild);
    await rm(path.join(deleteChild, "registry.json"), { force: true });
    const partial = await inspectStateTree(deleteChild);
    assert.equal(partial.status, "owned", "the partial tree is still an owned marker tree");
    assert.notEqual(partial.digest, info.digest, "the partial tree no longer matches the recorded digest");
    await writeClaimRecordWithIntent(seeded.containerPath, TX, "backup", {
      child: partial.identity,
      deletion: { child: path.basename(deleteChild), identity: partial.identity },
    });

    const result = await cleanupStateArtifactViaClaim({
      lease,
      artifactPath: path.join(root, "artifact"),
      transactionId: TX,
      expectation,
      label: "backup",
    });
    assert.ok(["absent", "removed"].includes(result));
    assert.equal(await exists(seeded.containerPath), false, "the claim and its record are finished");
    assert.deepEqual(await readdir(root), [], "the partially removed tree is completed and nothing is left");
  });
});

test("R3: a foreign root replacement of a recorded deletion claim is never authorized", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const lease = fakeLease(null);
    const artifact = await ownedMarkerTree(path.join(root, "artifact"));
    const info = await inspectStateTree(artifact);
    const expectation = { identity: info.identity, digest: info.digest };
    const seeded = await seedClaimContainer(artifact, TX, { kind: "backup" });

    const deleteChild = path.join(seeded.containerPath, `delete-${"ab".repeat(16)}`);
    await rename(seeded.movedPath, deleteChild);
    const original = await inspectStateTree(deleteChild);
    await writeClaimRecordWithIntent(seeded.containerPath, TX, "backup", {
      child: original.identity,
      deletion: { child: path.basename(deleteChild), identity: original.identity },
    });
    // A foreign root replacement: same shape, different identity. The
    // original is renamed aside, out of the claim container, rather than
    // deleted: an inode allocator with eager reuse (ext4 on the Linux
    // runner) can give the replacement tree the same dev/ino the deleted one
    // just freed, which would make the replacement indistinguishable from
    // the recorded deletion claim.
    await rename(deleteChild, path.join(root, "pinned-delete-child"));
    await ownedMarkerTree(deleteChild);
    const replacement = await readFile(path.join(deleteChild, STATE_MARKER_FILE), "utf8");

    const failure = await capture(() =>
      cleanupStateArtifactViaClaim({
        lease,
        artifactPath: path.join(root, "artifact"),
        transactionId: TX,
        expectation,
        label: "backup",
      }),
    );
    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.match(failure.message, /could not be verified; it was preserved/);
    assert.equal(await readFile(path.join(deleteChild, STATE_MARKER_FILE), "utf8"), replacement, "the replacement survives");
    assert.ok(await exists(`${seeded.containerPath}.json`), "the attribution record is preserved");
  });
});

test("R4: an exact recorded reservation from an interrupted restore is removed and the restore completes", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const project = await createProject(root);
    await leavePendingJournal(project, { fault: ["file-write", "recovery:files"] });
    const document = await readJournal(project.paths, { allowMissing: true });
    const backupPath = document.state.backup.path;
    const beforeState = await digestTree(document.state.backup.path);

    // Simulate the crash point: the canonical claim cleanup completed and the
    // restore left an empty reservation plus its durable record.
    await rm(project.stateDirectory, { recursive: true, force: true });
    await mkdir(project.stateDirectory, { mode: 0o700 });
    if (process.platform !== "win32") await chmod(project.stateDirectory, 0o700);
    const reservationStat = await lstat(project.stateDirectory);
    const reserveRecord = path.join(`${project.stateDirectory}.reserve-${document.transactionId}.json`);
    await writeFile(
      reserveRecord,
      `${JSON.stringify({
        schema: 1,
        owner: "skill-router",
        transactionId: document.transactionId,
        kind: "restore-reserve",
        reservation: { dev: Number(reservationStat.dev), ino: Number(reservationStat.ino) },
      })}\n`,
      { mode: 0o600 },
    );

    const recovery = await recover(project);
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "rolled-back");
    assert.equal(await exists(reserveRecord), false, "the reservation record is consumed");
    assert.deepEqual(await digestTree(project.stateDirectory), beforeState, "the restore completed exactly");
    assert.deepEqual(await leftoverArtifacts(root), []);
  });
});

test("R4: a destination replacement with a recorded reservation is refused and everything is preserved", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const project = await createProject(root);
    await leavePendingJournal(project, { fault: ["file-write", "recovery:files"] });
    const document = await readJournal(project.paths, { allowMissing: true });
    const backupPath = document.state.backup.path;
    const backupBefore = await digestTree(backupPath);

    // The recorded reservation exists, but the destination was replaced by a
    // foreign directory that does not match the record.
    await rm(project.stateDirectory, { recursive: true, force: true });
    await mkdir(project.stateDirectory, { mode: 0o700 });
    if (process.platform !== "win32") await chmod(project.stateDirectory, 0o700);
    await writeFile(path.join(project.stateDirectory, "intruder.txt"), "survives", { mode: 0o600 });
    const foreignIdentity = await lstat(project.stateDirectory);
    const reserveRecord = path.join(`${project.stateDirectory}.reserve-${document.transactionId}.json`);
    await writeFile(
      reserveRecord,
      `${JSON.stringify({
        schema: 1,
        owner: "skill-router",
        transactionId: document.transactionId,
        kind: "restore-reserve",
        // The record binds a *different* (the original) reservation identity.
        reservation: { dev: Number(foreignIdentity.dev), ino: Number(foreignIdentity.ino) + 1 },
      })}\n`,
      { mode: 0o600 },
    );

    const failure = await capture(() => recover(project));
    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.match(failure.message, /occupied by a replacement; the recorded backup and the reservation record were preserved/);
    assert.deepEqual(await digestTree(backupPath), backupBefore, "the recorded backup is preserved");
    assert.equal(await readFile(path.join(project.stateDirectory, "intruder.txt"), "utf8"), "survives", "the replacement survives");
    assert.ok(await exists(reserveRecord), "the reservation record is preserved");
  });
});

test("R4: a crash after the reservation mkdir but before its record fails closed and preserves both", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const project = await createProject(root);
    await leavePendingJournal(project, { fault: ["file-write", "recovery:files"] });

    // An empty directory at the canonical path with no record: unprovable as
    // an own reservation, so recovery refuses rather than guessing.
    await rm(project.stateDirectory, { recursive: true, force: true });
    await mkdir(project.stateDirectory, { mode: 0o700 });
    if (process.platform !== "win32") await chmod(project.stateDirectory, 0o700);

    const failure = await capture(() => recover(project));
    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.equal((await lstat(project.stateDirectory)).isDirectory(), true, "the unprovable directory survives");
    assert.ok(await exists(project.paths.journalFile), "the journal stays for a human decision");
  });
});

/* ================================================================== *
 * Phase 14 / R3+R4 - repeated deletion crashes, record CAS, and
 * reservation endpoint reconciliation
 * ================================================================== */

test("R3: a double crash mid-removal is continued by identity until the third run finishes", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const lease = fakeLease(null);
    const artifact = await ownedMarkerTree(path.join(root, "artifact"));
    const info = await inspectStateTree(artifact);
    const expectation = { identity: info.identity, digest: info.digest };
    const seeded = await seedClaimContainer(artifact, TX, { kind: "backup" });

    // Interrupted state: the tree was renamed to its deletion child, the
    // intent was recorded, and the first rm was interrupted after deleting
    // one entry (the recorded digest no longer matches).
    const deleteChild = path.join(seeded.containerPath, `delete-${"ab".repeat(16)}`);
    await rename(seeded.movedPath, deleteChild);
    await rm(path.join(deleteChild, "registry.json"), { force: true });
    const partial = await inspectStateTree(deleteChild);
    await writeClaimRecordWithIntent(seeded.containerPath, TX, "backup", {
      child: partial.identity,
      deletion: { child: path.basename(deleteChild), identity: partial.identity },
    });

    // First run: the intent authorizes continuation, the tree is re-claimed
    // and the intent re-bound, but the recursive removal dies partway.
    const originalRm = journaledTransactionInternals.rm;
    let attempts = 0;
    journaledTransactionInternals.rm = async (target, options) => {
      attempts += 1;
      if (attempts === 1) {
        // The rm removes one more entry, then the process "dies".
        const entries = await readdir(target);
        if (entries.length > 0) await rm(path.join(target, entries[0]), { force: true });
        throw new Error("injected crash inside the recursive removal");
      }
      return originalRm(target, options);
    };
    const failure = await capture(() =>
      cleanupStateArtifactViaClaim({
        lease,
        artifactPath: path.join(root, "artifact"),
        transactionId: TX,
        expectation,
        label: "backup",
      }),
    );
    assert.match(failure.message, /injected crash inside the recursive removal/);
    // The intent now names the re-claimed child, so the next run continues by
    // root identity alone (the marker and the original digest are gone).
    const midContainer = (await readdir(seeded.containerPath)).filter((name) => name !== "claim.json");
    assert.equal(midContainer.length, 1, "exactly the re-claimed deletion child remains");

    // Third run: finishes by identity, without the original digest.
    let result = null;
    try {
      result = await cleanupStateArtifactViaClaim({
        lease,
        artifactPath: path.join(root, "artifact"),
        transactionId: TX,
        expectation,
        label: "backup",
      });
    } finally {
      journaledTransactionInternals.rm = originalRm;
    }
    assert.ok(["absent", "removed"].includes(result));
    assert.deepEqual(await readdir(root), [], "the repeated crash chain is completed and nothing is left");
  });
});

test("R3: a claim record replaced before its intent rewrite is preserved, never overwritten", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const lease = fakeLease(null);
    const artifact = await ownedMarkerTree(path.join(root, "artifact"));
    const info = await inspectStateTree(artifact);
    const expectation = { identity: info.identity, digest: info.digest };
    const seeded = await seedClaimContainer(artifact, TX, { kind: "backup" });
    const recordPath = `${seeded.containerPath}.json`;

    const deleteChild = path.join(seeded.containerPath, `delete-${"ab".repeat(16)}`);
    await rename(seeded.movedPath, deleteChild);
    const original = await inspectStateTree(deleteChild);
    await writeClaimRecordWithIntent(seeded.containerPath, TX, "backup", {
      child: original.identity,
      deletion: { child: path.basename(deleteChild), identity: original.identity },
    });

    // The record is replaced right after the re-claim rename and before the
    // CAS-bound intent rewrite: the rewrite must refuse and preserve it.
    const originalRename = journaledTransactionInternals.claimRename;
    let swapped = false;
    journaledTransactionInternals.claimRename = async (from, to) => {
      await originalRename(from, to);
      if (!swapped) {
        swapped = true;
        await writeFile(recordPath, "{ foreign }\n", { mode: 0o600 });
      }
    };
    let failure = null;
    try {
      failure = await capture(() =>
        cleanupStateArtifactViaClaim({
          lease,
          artifactPath: path.join(root, "artifact"),
          transactionId: TX,
          expectation,
          label: "backup",
        }),
      );
    } finally {
      journaledTransactionInternals.claimRename = originalRename;
    }
    assert.equal(swapped, true, "the re-claim rename actually ran");
    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.equal(await readFile(recordPath, "utf8"), "{ foreign }\n", "the replaced record survives byte-identical");
  });
});

test("R3: a deletion intent with an unprovable identity makes the whole record foreign and everything survives", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const lease = fakeLease(null);
    const artifact = await ownedMarkerTree(path.join(root, "artifact"));
    const info = await inspectStateTree(artifact);
    const expectation = { identity: info.identity, digest: info.digest };
    const seeded = await seedClaimContainer(artifact, TX, { kind: "backup" });
    const deleteChild = path.join(seeded.containerPath, `delete-${"ab".repeat(16)}`);
    await rename(seeded.movedPath, deleteChild);
    const original = await inspectStateTree(deleteChild);
    await writeClaimRecordWithIntent(seeded.containerPath, TX, "backup", {
      child: original.identity,
      // A zero/invalid identity is never an authorization.
      deletion: { child: path.basename(deleteChild), identity: { dev: 0, ino: 0 } },
    });

    const failure = await capture(() =>
      cleanupStateArtifactViaClaim({
        lease,
        artifactPath: path.join(root, "artifact"),
        transactionId: TX,
        expectation,
        label: "backup",
      }),
    );
    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.equal((await lstat(deleteChild)).isDirectory(), true, "the deletion child survives");
    assert.equal(await exists(`${seeded.containerPath}.json`), true, "the record survives");
  });
});

test("R3: a record-only claim (crash after the container rmdir) consumes its record and finishes", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const lease = fakeLease(null);
    const artifact = await ownedMarkerTree(path.join(root, "artifact"));
    const info = await inspectStateTree(artifact);
    const expectation = { identity: info.identity, digest: info.digest };
    // Crash after the container removal: only the external record remains.
    const containerPath = claimPathFor(artifact, TX);
    const stat = await lstat(path.dirname(artifact));
    await writeFile(
      `${containerPath}.json`,
      `${JSON.stringify({
        schema: 1,
        owner: "skill-router",
        transactionId: TX,
        kind: "backup",
        container: { dev: Number(stat.dev), ino: Number(stat.ino) },
      })}\n`,
      { mode: 0o600 },
    );
    await rm(artifact, { recursive: true, force: true });

    const result = await cleanupStateArtifactViaClaim({
      lease,
      artifactPath: artifact,
      transactionId: TX,
      expectation,
      label: "backup",
    });
    assert.equal(result, "absent");
    assert.equal(await exists(`${containerPath}.json`), false, "the record is consumed attributed");
    assert.deepEqual(await readdir(root), []);
  });
});

test("R4: a crash immediately after the durable restore rename is reconciled and finishes", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const project = await createProject(root);
    await leavePendingJournal(project, { fault: ["file-write", "recovery:files"] });
    const document = await readJournal(project.paths, { allowMissing: true });
    const beforeState = await digestTree(document.state.backup.path);

    // Crash state: the canonical claim cleanup completed, the restore rename
    // itself committed (canonical = the recorded prior, backup gone), and the
    // reservation record was never deleted.
    await rm(project.stateDirectory, { recursive: true, force: true });
    await rename(document.state.backup.path, project.stateDirectory);
    const stat = await lstat(project.stateDirectory);
    const reserveRecord = path.join(`${project.stateDirectory}.reserve-${document.transactionId}.json`);
    // The record binds the *reservation* identity (the now-replaced empty
    // directory), not the restored tree: only the endpoint reconciliation can
    // recognize that the rename committed.
    await writeFile(
      reserveRecord,
      `${JSON.stringify({
        schema: 1,
        owner: "skill-router",
        transactionId: document.transactionId,
        kind: "restore-reserve",
        reservation: { dev: Number(stat.dev), ino: Number(stat.ino) + 1 },
      })}\n`,
      { mode: 0o600 },
    );

    const recovery = await recover(project);
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "rolled-back");
    assert.equal(await exists(reserveRecord), false, "the reservation record is consumed");
    assert.deepEqual(await digestTree(project.stateDirectory), beforeState, "the committed restore stands");
    assert.deepEqual(await leftoverArtifacts(root), []);
  });
});

/* ================================================================== *
 * Phase 14 / R5 - preserved unprovable containers, terminal record
 * consumption, and reservation rmdir reconciliation
 * ================================================================== */

test("R5: an unprovable claim container is preserved — the creator never rmdirs", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const lease = fakeLease(null);
    const artifact = await ownedMarkerTree(path.join(root, "artifact"));
    const info = await inspectStateTree(artifact);
    const expectation = { identity: info.identity, digest: info.digest };
    const claimPath = claimPathFor(artifact, TX);

    // The freshly created container looks owner-unprovable (group/other
    // writable) at the moment of the creation proof.
    const originalLstat = journaledTransactionInternals.claimLstat;
    journaledTransactionInternals.claimLstat = async (target) => {
      const stat = await originalLstat(target);
      if (!stat.isSymbolicLink() && path.resolve(target) === path.resolve(claimPath)) {
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { mode: Number(stat.mode) | 0o077 });
      }
      return stat;
    };
    let failure = null;
    try {
      failure = await capture(() =>
        cleanupStateArtifactViaClaim({
          lease,
          artifactPath: path.join(root, "artifact"),
          transactionId: TX,
          expectation,
          label: "backup",
        }),
      );
    } finally {
      journaledTransactionInternals.claimLstat = originalLstat;
    }
    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.match(failure.message, /could not be proven/);
    // "rmdir spy 0" by construction: the creator contains no rmdir at all,
    // and the freshly created container survives exactly as created.
    assert.equal((await lstat(claimPath)).isDirectory(), true, "the unprovable container is preserved");
    assert.deepEqual(await readdir(claimPath), [], "it is empty and untouched");
    assert.equal((await lstat(path.join(root, "artifact"))).isDirectory(), true, "the artifact is untouched");
  });
});

test("R3: external record consumption is a direct terminal unlink with no hidden claim", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const lease = fakeLease(null);
    const artifact = await ownedMarkerTree(path.join(root, "artifact"));
    const info = await inspectStateTree(artifact);
    const expectation = { identity: info.identity, digest: info.digest };

    const result = await cleanupStateArtifactViaClaim({
      lease,
      artifactPath: artifact,
      transactionId: TX,
      expectation,
      label: "backup",
    });
    assert.ok(["absent", "removed"].includes(result));
    const names = await readdir(root);
    assert.deepEqual(names, [], "the claim, its record, and every child are gone");
    assert.equal(
      names.some((name) => name.includes(".delete-")),
      false,
      "record consumption creates no hidden durableUnlink claim",
    );
  });
});

test("R4: a crash after the reservation rmdir is reconciled and the restoration completes", async () => {
  await withTemp("skill-router-recovery-", async (root) => {
    const project = await createProject(root);
    await leavePendingJournal(project, { fault: ["file-write", "recovery:files"] });
    const document = await readJournal(project.paths, { allowMissing: true });
    const backupPath = document.state.backup.path;
    const beforeState = await digestTree(backupPath);

    // Crash state: the canonical claim cleanup completed, the reservation was
    // created and rmdir'd (its fsync committed), and only the record
    // consumption was interrupted.
    await rm(project.stateDirectory, { recursive: true, force: true });
    const rootStat = await lstat(root);
    const reserveRecord = path.join(`${project.stateDirectory}.reserve-${document.transactionId}.json`);
    await writeFile(
      reserveRecord,
      `${JSON.stringify({
        schema: 1,
        owner: "skill-router",
        transactionId: document.transactionId,
        kind: "restore-reserve",
        // The record binds the (now removed) reservation's identity.
        reservation: { dev: Number(rootStat.dev), ino: Number(rootStat.ino) + 1 },
      })}\n`,
      { mode: 0o600 },
    );

    const recovery = await recover(project);
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "rolled-back");
    assert.equal(await exists(reserveRecord), false, "the reservation record is consumed");
    assert.deepEqual(await digestTree(project.stateDirectory), beforeState, "the restoration completed");
    const names = await readdir(root);
    assert.equal(
      names.some((name) => name.includes(".delete-") || name.includes(".reserve-")),
      false,
      "no hidden claim or stale reservation record remains",
    );
    assert.deepEqual(await leftoverArtifacts(root), []);
  });
});
