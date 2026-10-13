// Phase 6 - typed journaled transactions: payload planning/materialization,
// the managed and removal executors, and their failure behavior at every
// durable step. Recovery itself lives in test/recovery.test.js.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { payloadPathFor, JOURNAL_ERROR_CODES, readJournal } from "../src/journal.js";
import {
  journaledTransactionInternals,
  materializeFilePayloads,
  planFilePayloads,
  transactionInternals,
} from "../src/transaction.js";

// Safety net: every Claude interaction in this file goes through an injected
// fake executor, and this makes any accidental fall-back to the real Claude
// binary fail fast (ENOENT) instead of touching real user state.
process.env.SKILL_ROUTER_CLAUDE_BIN = "/nonexistent-claude-binary-for-tests";
import {
  classifyClaudeUninstallState,
  claudeRegistrationPlan,
  detachClaude,
  inspectGeneratedClaudeRemovalSource,
  observeClaudeUninstallState,
  planClaudePlugin,
  registerClaude,
} from "../src/claude.js";
import { buildInstallation, claudeIdentity } from "../src/installation.js";
import { inspectRecoveryRequirement, recoverPendingTransaction } from "../src/recovery.js";
import { stageManagedState } from "../src/managed-state.js";
import { createFakeClaudeRunner } from "./fake-claude.js";
import { inspectStateTree } from "../src/managed-state.js";
import {
  brokenLease,
  createProject,
  digestTree,
  exists,
  installRenameFault,
  installStepFault,
  leftoverArtifacts,
  modeTree,
  openCodePlan,
  runManagedTransaction,
  runRemovalTransaction,
  listEntries,
  OLD_CONFIG,
  NEW_CONFIG,
  stageAt,
  withTemp,
} from "./journaled-harness.js";

const TX = "11".repeat(32);

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

/* ================================================================== *
 * Payload planning and materialization
 * ================================================================== */

test("planFilePayloads is side-effect-free and records exact descriptors", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const project = await createProject(root);
    const before = await digestTree(root);

    const plans = await planFilePayloads(
      TX,
      [{ role: "router-config", path: project.configFile, content: NEW_CONFIG, expectedBefore: OLD_CONFIG }],
      { lease: project.lease, controlDirectory: project.paths.controlDirectory, stateDirectory: project.stateDirectory },
    );

    assert.deepEqual(await digestTree(root), before, "planning wrote nothing at all");
    assert.equal(plans.length, 1);
    const [plan] = plans;
    assert.equal(plan.target, project.configFile);
    assert.equal(plan.record.status, "prepared");
    assert.equal(plan.record.before.exists, true);
    assert.equal(plan.record.before.sha256, createHash("sha256").update(OLD_CONFIG).digest("hex"));
    assert.equal(plan.record.after.payloadPath, payloadPathFor(project.configFile, TX, "after"));
    assert.equal(plan.record.before.payloadPath, payloadPathFor(project.configFile, TX, "before"));
    assert.equal(plan.after.bytes.toString("utf8"), NEW_CONFIG, "bytes are retained in memory only");
    assert.equal(await exists(plan.after.path), false, "no payload exists after planning");
    assert.ok(Object.isFrozen(plans) && Object.isFrozen(plan) && Object.isFrozen(plan.record));

    // A missing target plans an absent before descriptor.
    const missing = path.join(root, "absent.json");
    const [created] = await planFilePayloads(TX, [{ role: "router-config", path: missing, content: "x" }], {
      lease: project.lease,
      controlDirectory: project.paths.controlDirectory,
      stateDirectory: project.stateDirectory,
    });
    assert.deepEqual({ ...created.record.before }, { exists: false, sha256: null, payloadPath: null });

    // An already-computed {exists, sha256} pair is accepted as a digest.
    const digest = createHash("sha256").update(OLD_CONFIG).digest("hex");
    const [digested] = await planFilePayloads(
      TX,
      [{ role: "router-config", path: project.configFile, content: NEW_CONFIG, expectedBefore: { exists: true, sha256: digest } }],
      {
        lease: project.lease,
        controlDirectory: project.paths.controlDirectory,
        stateDirectory: project.stateDirectory,
      },
    );
    assert.equal(digested.record.before.sha256, digest);
    await assert.rejects(
      () =>
        planFilePayloads(
          TX,
          [{ role: "router-config", path: project.configFile, content: NEW_CONFIG, expectedBefore: { exists: true, sha256: "ff".repeat(32) } }],
          {
            lease: project.lease,
            controlDirectory: project.paths.controlDirectory,
            stateDirectory: project.stateDirectory,
          },
        ),
      /no longer matches the bytes observed during planning/,
    );
  });
});

test("planFilePayloads refuses CAS mismatches, containment overlaps, and non-regular targets", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const project = await createProject(root);
    const options = {
      lease: project.lease,
      controlDirectory: project.paths.controlDirectory,
      stateDirectory: project.stateDirectory,
    };

    const stale = await capture(() =>
      planFilePayloads(TX, [{ role: "router-config", path: project.configFile, content: "x", expectedBefore: "other" }], options),
    );
    assert.equal(stale.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);

    const insideControl = await capture(() =>
      planFilePayloads(
        TX,
        [{ role: "router-config", path: path.join(project.paths.controlDirectory, "x.json"), content: "x" }],
        options,
      ),
    );
    assert.equal(insideControl.code, JOURNAL_ERROR_CODES.JOURNAL_INVALID);

    const insideState = await capture(() =>
      planFilePayloads(
        TX,
        [{ role: "router-config", path: path.join(project.stateDirectory, "x.json"), content: "x" }],
        options,
      ),
    );
    assert.equal(insideState.code, JOURNAL_ERROR_CODES.JOURNAL_INVALID);

    const target = path.join(root, "target.json");
    await writeFile(target, "real");
    await symlink(target, path.join(root, "linked.json"));
    const linked = await capture(() =>
      planFilePayloads(TX, [{ role: "router-config", path: path.join(root, "linked.json"), content: "x" }], options),
    );
    assert.equal(linked.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);

    await assert.rejects(() => planFilePayloads("not-a-digest", [], options), /transaction id/);
    const entry = { role: "router-config", path: project.configFile, content: NEW_CONFIG };
    await assert.rejects(() => planFilePayloads(TX, [entry, entry], options), /repeat a target/);
  });
});

test("materializeFilePayloads writes exact 0600 payloads, adopts, refuses foreign payloads and symlinks", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const project = await createProject(root);
    const options = {
      lease: project.lease,
      controlDirectory: project.paths.controlDirectory,
      stateDirectory: project.stateDirectory,
    };
    const plans = await planFilePayloads(
      TX,
      [{ role: "router-config", path: project.configFile, content: NEW_CONFIG, expectedBefore: OLD_CONFIG }],
      options,
    );

    const first = await materializeFilePayloads(plans, { lease: project.lease });
    assert.deepEqual([...first.materialized], ["created", "created"]);
    for (const entry of [plans[0].before, plans[0].after]) {
      const stat = await lstat(entry.path);
      assert.equal(stat.mode & 0o777, 0o600, "payloads are owner-only");
      assert.equal(await readFile(entry.path, "utf8"), entry.bytes.toString("utf8"));
      assert.equal(await exists(`${entry.path}.tmp`), false, "the transient does not survive a completed write");
    }

    // Re-running adopts exact payloads instead of rewriting them.
    const again = await materializeFilePayloads(plans, { lease: project.lease });
    assert.deepEqual([...again.materialized], ["adopted", "adopted"]);

    // A mismatching payload at an exact recorded path is foreign content (it
    // can never be an interrupted write of ours, because payloads only land at
    // the final path through the verified no-clobber publish): it is a
    // RECOVERY_CONFLICT and stays byte identical. A pre-existing transient is
    // never "owned" by its derived pathname (B3): a partial one is preserved,
    // never deleted.
    await writeFile(plans[0].after.path, "partial", { mode: 0o600 });
    await writeFile(`${plans[0].after.path}.tmp`, "half-written", { mode: 0o600 });
    const conflicted = await capture(() => materializeFilePayloads(plans, { lease: project.lease }));
    assert.equal(conflicted.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.match(conflicted.message, /it was preserved/);
    assert.equal(await readFile(plans[0].after.path, "utf8"), "partial", "the foreign payload is never replaced");
    assert.equal(
      await readFile(`${plans[0].after.path}.tmp`, "utf8"),
      "half-written",
      "the unprovable transient is preserved, never deleted",
    );
    assert.equal(await readFile(plans[0].before.path, "utf8"), OLD_CONFIG, "the matching payload is untouched");
    await rm(`${plans[0].after.path}.tmp`, { force: true });

    // Restoring the exact planned bytes makes materialization adopt again.
    await writeFile(plans[0].after.path, NEW_CONFIG, { mode: 0o600 });
    const adoptedAgain = await materializeFilePayloads(plans, { lease: project.lease });
    assert.deepEqual([...adoptedAgain.materialized], ["adopted", "adopted"]);

    // Symlinks and non-regular payloads are refused, never followed.
    const linkTarget = path.join(root, "elsewhere.json");
    await writeFile(linkTarget, "victim");
    await rm(plans[0].after.path);
    await symlink(linkTarget, plans[0].after.path);
    const symlinked = await capture(() => materializeFilePayloads(plans, { lease: project.lease }));
    assert.ok(symlinked.code === JOURNAL_ERROR_CODES.JOURNAL_INVALID || symlinked.code === JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.equal(await readFile(linkTarget, "utf8"), "victim", "the symlink target is untouched");
  });
});

/* ================================================================== *
 * Managed execution
 * ================================================================== */

test("a managed transaction commits, verifies, and removes every artifact", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const project = await createProject(root);
    const beforeState = await digestTree(project.stateDirectory);

    const result = await runManagedTransaction(project);

    assert.equal(result.status, "committed");
    assert.equal(result.kind, "managed");
    assert.equal(await readFile(project.configFile, "utf8"), NEW_CONFIG);
    const installed = JSON.parse(await readFile(path.join(project.stateDirectory, "registry.json"), "utf8"));
    assert.equal(installed.fingerprint, project.registry.fingerprint);
    assert.equal((await inspectStateTree(project.stateDirectory)).status, "owned");
    assert.deepEqual(await leftoverArtifacts(root), [], "no stage, backup, payload, or journal survives");
    assert.equal(await readJournal(project.paths, { allowMissing: true }), null);
    assert.deepEqual(await inspectRecoveryRequirement({ paths: project.paths, root: path.dirname(project.paths.controlDirectory) }), {
      status: "absent",
    });
    assert.notDeepEqual(await digestTree(project.stateDirectory), beforeState, "the state was regenerated");
    assert.deepEqual(await listEntries(project.paths.controlDirectory), [], "control data holds no leftovers");
  });
});

test("no payload predates its journal and journal bytes never carry config or skill bodies", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const project = await createProject(root);
    const restore = installStepFault("journal:create");
    try {
      await capture(() => runManagedTransaction(project));
    } finally {
      restore();
    }
    const payloads = await leftoverArtifacts(root);
    assert.deepEqual(payloads, [], "planning without a journal leaves no payload");
    assert.equal(await readJournal(project.paths, { allowMissing: true }), null);

    // With a journal but no materialization: capture the durable journal at
    // the moment the fault fires, then prove it carries no payload bytes.
    let journalBytes = null;
    const original = journaledTransactionInternals.onStep;
    journaledTransactionInternals.onStep = async (name) => {
      if (name === "payloads:materialize") {
        journalBytes = await readFile(project.paths.journalFile, "utf8");
        throw new Error("injected fault at payloads:materialize");
      }
    };
    try {
      await capture(() => runManagedTransaction(project));
    } finally {
      journaledTransactionInternals.onStep = original;
    }
    assert.ok(journalBytes, "the journal existed before any payload was written");
    assert.ok(journalBytes.includes('"kind":"managed"'));
    assert.equal(journalBytes.includes(NEW_CONFIG.trim()), false, "config bytes never reach the journal");
    assert.equal(journalBytes.includes("Demo body"), false, "skill bodies never reach the journal");
    assert.equal(journalBytes.includes(OLD_CONFIG.trim()), false);
    assert.deepEqual(await leftoverArtifacts(root), [], "recovery already cleaned the journal-only transaction");
  });
});

const MANAGED_CLEAN_STEPS = ["plan", "inspect", "journal:create"];
const MANAGED_COMMIT_STEPS = ["cleanup:backup", "cleanup:payloads", "cleanup:journal"];
const MANAGED_STEPS = [
  ...MANAGED_CLEAN_STEPS,
  "payloads:materialize",
  "journal:intent",
  "stage:build",
  "stage:record",
  "journal:applying",
  "state:backup",
  "state:install",
  "file-intent",
  "file-write",
  "file-applied",
  "verify",
  "journal:proven",
  "journal:commit",
  ...MANAGED_COMMIT_STEPS,
];

for (const target of MANAGED_STEPS) {
  const expected = MANAGED_CLEAN_STEPS.includes(target)
    ? "clean"
    : MANAGED_COMMIT_STEPS.includes(target)
      ? "committed"
      : "rolled-back";

  test(`managed failure at ${target} recovers to a proven ${expected} state`, async () => {
    await withTemp("skill-router-journaled-", async (root) => {
      const project = await createProject(root);
      const beforeState = await digestTree(project.stateDirectory);
      const restore = installStepFault(target);
      const failure = await capture(() => runManagedTransaction(project)).finally(restore);
      assert.match(String(failure.message), /injected fault/, "the fault actually fired");

      const recovery = await recoverPendingTransaction({
        paths: project.paths,
        lease: project.lease,
        root: path.dirname(project.paths.controlDirectory),
        scope: "project",
        stateDirectory: project.stateDirectory,
      });
      if (recovery.status !== "clean") assert.equal(recovery.outcome, expected);
      if (expected === "clean") assert.equal(recovery.status, "clean");

      if (expected === "clean") {
        assert.equal(await readFile(project.configFile, "utf8"), OLD_CONFIG, "planning leaves the config alone");
        assert.deepEqual(await digestTree(project.stateDirectory), beforeState, "prior state is untouched");
        assert.deepEqual(await leftoverArtifacts(root), []);
        return;
      }
      if (expected === "rolled-back") {
        assert.equal(await readFile(project.configFile, "utf8"), OLD_CONFIG, "config restored byte for byte");
        assert.deepEqual(await digestTree(project.stateDirectory), beforeState, "prior state restored");
        assert.equal(await exists(project.stateDirectory), true);
      } else {
        assert.equal(await readFile(project.configFile, "utf8"), NEW_CONFIG, "config holds the desired bytes");
        const installed = JSON.parse(await readFile(path.join(project.stateDirectory, "registry.json"), "utf8"));
        assert.equal(installed.fingerprint, project.registry.fingerprint, "desired state is installed");
      }
      assert.deepEqual(await leftoverArtifacts(root), [], "no artifact outlives recovery");
      assert.equal(await readJournal(project.paths, { allowMissing: true }), null);
    });
  });
}

test("a managed rename that mutates then errors still commits through endpoint reconciliation", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const project = await createProject(root);
    const restore = installRenameFault();
    try {
      const result = await runManagedTransaction(project);
      assert.equal(result.status, "committed");
    } finally {
      restore();
    }
    assert.equal(await readFile(project.configFile, "utf8"), NEW_CONFIG);
    assert.equal((await inspectStateTree(project.stateDirectory)).status, "owned");
    assert.deepEqual(await leftoverArtifacts(root), []);
    assert.equal(await readJournal(project.paths, { allowMissing: true }), null);
  });
});

test("an unreconcilable managed rename raises RECOVERY_AMBIGUOUS and touches nothing", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const project = await createProject(root);
    const beforeState = await digestTree(project.stateDirectory);
    const original = journaledTransactionInternals.rename;
    const stray = [];
    journaledTransactionInternals.rename = async (from, to) => {
      const moved = `${to}.stray`;
      await original(from, moved);
      stray.push(moved);
      throw new Error("injected rename failure");
    };
    const failure = await capture(() => runManagedTransaction(project)).finally(() => {
      journaledTransactionInternals.rename = original;
    });

    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_AMBIGUOUS);
    const document = await readJournal(project.paths, { allowMissing: true });
    assert.ok(document, "the journal is left in place for manual repair");
    assert.equal(document.mode, "forward", "an ambiguous outcome never sets rollback");
    assert.equal(document.phase, "applying");
    assert.deepEqual(stray.length, 1);
    assert.equal(await exists(stray[0]), true, "the stray directory is not removed");
    assert.equal(await readFile(project.configFile, "utf8"), OLD_CONFIG, "config untouched");
    // Recovery refuses the same way instead of guessing.
    const recovery = await capture(() =>
      recoverPendingTransaction({
        paths: project.paths,
        lease: project.lease,
        root: path.dirname(project.paths.controlDirectory),
        scope: "project",
        stateDirectory: project.stateDirectory,
      }),
    );
    assert.ok(
      recovery.code === JOURNAL_ERROR_CODES.RECOVERY_CONFLICT || recovery.code === JOURNAL_ERROR_CODES.RECOVERY_AMBIGUOUS,
      `expected a stable recovery error, got ${recovery.code}`,
    );
    assert.equal(await exists(stray[0]), true, "recovery also leaves the stray artifact alone");
  });
});

test("concurrent config edits during rollback are preserved and reported", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const project = await createProject(root);
    const failure = await capture(() =>
      runManagedTransaction(project, {
        verify: async () => {
          // A concurrent writer lands after the transaction wrote its bytes.
          await writeFile(project.configFile, '{"concurrent":true}\n');
          throw new Error("verification failed");
        },
      }),
    );
    assert.match(failure.message, /verification failed/);

    const recovery =
      failure.recovery ??
      (await recoverPendingTransaction({
        paths: project.paths,
        lease: project.lease,
        root: path.dirname(project.paths.controlDirectory),
        scope: "project",
        stateDirectory: project.stateDirectory,
      }));
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "rolled-back");
    assert.deepEqual(recovery.conflicts, [project.configFile], "the conflict is reported by path");
    assert.equal(await readFile(project.configFile, "utf8"), '{"concurrent":true}\n', "the concurrent edit survives");
    assert.deepEqual(await leftoverArtifacts(root), [], "cleanup still completes exactly");
  });
});

test("a foreign canonical state refuses with RECOVERY_CONFLICT and is never touched", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const project = await createProject(root);
    await rm(project.stateDirectory, { recursive: true, force: true });
    await mkdir(project.stateDirectory);
    await writeFile(path.join(project.stateDirectory, "user-data.txt"), "hands off");

    const failure = await capture(() => runManagedTransaction(project));
    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.equal(await exists(path.join(project.stateDirectory, "user-data.txt")), true, "unowned content preserved");
    assert.equal(await exists(project.paths.journalFile), false, "no journal is created over foreign state");

    // The same refusal applies to a state directory replaced by a symlink.
    await rm(project.stateDirectory, { recursive: true, force: true });
    const real = path.join(root, "elsewhere");
    await mkdir(real);
    await writeFile(path.join(real, "keep.txt"), "keep");
    await symlink(real, project.stateDirectory);
    const symlinked = await capture(() => runManagedTransaction(project));
    assert.equal(symlinked.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.equal(await readFile(path.join(real, "keep.txt"), "utf8"), "keep");
  });
});

test("a compromised lease fails closed before any journaled mutation", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const project = await createProject(root);
    const beforeState = await digestTree(project.stateDirectory);
    const failure = await capture(() => runManagedTransaction(project, { lease: brokenLease(project.paths) }));
    assert.match(failure.message, /lease lost/);
    assert.equal(await readFile(project.configFile, "utf8"), OLD_CONFIG);
    assert.deepEqual(await digestTree(project.stateDirectory), beforeState);
    assert.deepEqual(await leftoverArtifacts(root), []);
  });
});

/* ================================================================== *
 * Removal execution
 * ================================================================== */

test("a removal transaction commits at the state rename and deletes the exact backup", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const project = await createProject(root);
    const plan = await openCodePlan(project.stateDirectory);
    await writeFile(project.openCodeConfig, plan.withSource);

    const result = await runRemovalTransaction(project);

    assert.equal(result.status, "committed");
    assert.equal(await exists(project.stateDirectory), false, "canonical state is gone");
    assert.equal(await readFile(project.openCodeConfig, "utf8"), plan.without, "the config keeps user fields");
    assert.equal(await exists(project.configFile), true, "the router config is preserved");
    assert.deepEqual(await leftoverArtifacts(root), [], "backup, payloads, and journal are deleted");
    assert.equal(await readJournal(project.paths, { allowMissing: true }), null);
  });
});

const REMOVAL_CLEAN_STEPS = ["plan", "inspect", "journal:create"];
const REMOVAL_COMMIT_STEPS = ["state:verify", "journal:commit", "cleanup:backup", "cleanup:payloads", "cleanup:journal"];
const REMOVAL_STEPS = [
  ...REMOVAL_CLEAN_STEPS,
  "payloads:materialize",
  "journal:intent",
  "file-intent",
  "file-write",
  "file-applied",
  "verify-local",
  "journal:detaching",
  "verify-external",
  "verify-integrations",
  "revalidate",
  "journal:commit-ready",
  "state:rename",
  ...REMOVAL_COMMIT_STEPS,
];

for (const target of REMOVAL_STEPS) {
  const expected = REMOVAL_CLEAN_STEPS.includes(target)
    ? "clean"
    : REMOVAL_COMMIT_STEPS.includes(target)
      ? "committed"
      : "rolled-back";

  test(`removal failure at ${target} recovers to a proven ${expected} state`, async () => {
    await withTemp("skill-router-journaled-", async (root) => {
      const project = await createProject(root);
      const plan = await openCodePlan(project.stateDirectory);
      await writeFile(project.openCodeConfig, plan.withSource);
      const beforeState = await digestTree(project.stateDirectory);

      const restore = installStepFault(target);
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
      assert.match(String(failure.message), /injected fault/, "the fault actually fired");

      const recovery = await recoverPendingTransaction({
        paths: project.paths,
        lease: project.lease,
        root: path.dirname(project.paths.controlDirectory),
        scope: "project",
        stateDirectory: project.stateDirectory,
      });
      if (recovery.status !== "clean") assert.equal(recovery.outcome, expected);
      if (expected === "clean") assert.equal(recovery.status, "clean");

      if (expected === "clean") {
        assert.equal(await readFile(project.openCodeConfig, "utf8"), plan.withSource, "nothing was written");
        assert.deepEqual(await digestTree(project.stateDirectory), beforeState);
        assert.deepEqual(await leftoverArtifacts(root), []);
        return;
      }
      if (expected === "rolled-back") {
        assert.equal(await exists(project.stateDirectory), true, "state stays canonical");
        assert.deepEqual(await digestTree(project.stateDirectory), beforeState, "state restored exactly");
        assert.equal(await readFile(project.openCodeConfig, "utf8"), plan.withSource, "config restored byte for byte");
      } else {
        assert.equal(await exists(project.stateDirectory), false, "committed removal leaves no canonical state");
        assert.equal(await readFile(project.openCodeConfig, "utf8"), plan.without);
      }
      assert.deepEqual(await leftoverArtifacts(root), []);
      assert.equal(await readJournal(project.paths, { allowMissing: true }), null);
    });
  });
}

test("a removal rename that mutates then errors still commits", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const project = await createProject(root);
    const plan = await openCodePlan(project.stateDirectory);
    await writeFile(project.openCodeConfig, plan.withSource);
    const restore = installRenameFault();
    try {
      const result = await runRemovalTransaction(project, {
        files: [
          { role: "opencode-config", path: project.openCodeConfig, content: plan.without, expectedBefore: plan.withSource },
        ],
      });
      assert.equal(result.status, "committed");
    } finally {
      restore();
    }
    assert.equal(await exists(project.stateDirectory), false);
    assert.deepEqual(await leftoverArtifacts(root), []);
    assert.equal(await readJournal(project.paths, { allowMissing: true }), null);
  });
});

test("an ambiguous removal rename raises RECOVERY_AMBIGUOUS and is left untouched", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const project = await createProject(root);
    const plan = await openCodePlan(project.stateDirectory);
    await writeFile(project.openCodeConfig, plan.withSource);
    const beforeState = await digestTree(project.stateDirectory);

    const original = journaledTransactionInternals.rename;
    journaledTransactionInternals.rename = async (from, to) => {
      // Moves the state somewhere else entirely, so neither endpoint proves
      // either a commit or a pre-commit rollback.
      await original(from, `${to}.stray`);
      throw new Error("injected rename failure");
    };
    const failure = await capture(() =>
      runRemovalTransaction(project, {
        files: [
          { role: "opencode-config", path: project.openCodeConfig, content: plan.without, expectedBefore: plan.withSource },
        ],
      }),
    ).finally(() => {
      journaledTransactionInternals.rename = original;
    });

    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_AMBIGUOUS);
    const document = await readJournal(project.paths, { allowMissing: true });
    assert.ok(document, "the journal survives for later recovery");
    assert.equal(document.mode, "forward");
    assert.equal(document.phase, "commit-ready");
    assert.equal(await exists(project.stateDirectory), false, "the state was moved by the injected rename");
    assert.equal(await exists(`${project.stateDirectory}.backup-${document.transactionId}.stray`), true, "the stray directory is left alone");
    assert.equal((await inspectStateTree(`${project.stateDirectory}.backup-${document.transactionId}.stray`)).status, "owned");
    // The local detach already happened before the commit rename; ambiguity
    // stops everything without restoring it.
    assert.equal(await readFile(project.openCodeConfig, "utf8"), plan.without, "nothing is restored after ambiguity");
    // The recorded prior bytes stay available so recovery can still act after
    // the ambiguity is resolved by hand.
    assert.equal(
      await exists(payloadPathFor(project.openCodeConfig, document.transactionId, "before")),
      true,
      "the before payload survives an ambiguous outcome",
    );
  });
});

test("a removal rollback after a CAS conflict preserves the concurrent config edit", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const project = await createProject(root);
    const plan = await openCodePlan(project.stateDirectory);
    await writeFile(project.openCodeConfig, plan.withSource);
    const concurrent = `${JSON.stringify({ $schema: "https://opencode.ai/schema.json", skill: { sources: ["user"] } }, null, 2)}\n`;

    const restore = installStepFault("verify-external");
    const failure = await capture(() =>
      runRemovalTransaction(project, {
        files: [
          { role: "opencode-config", path: project.openCodeConfig, content: plan.without, expectedBefore: plan.withSource },
        ],
        verifyLocal: async () => {
          // A concurrent writer rewrites the config after our detach write.
          await writeFile(project.openCodeConfig, concurrent);
          throw new Error("verification failed");
        },
      }),
    ).finally(restore);
    assert.match(failure.message, /verification failed/);

    const recovery =
      failure.recovery ??
      (await recoverPendingTransaction({
        paths: project.paths,
        lease: project.lease,
        root: path.dirname(project.paths.controlDirectory),
        scope: "project",
        stateDirectory: project.stateDirectory,
      }));
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "rolled-back");
    assert.deepEqual(recovery.conflicts, [project.openCodeConfig]);
    assert.equal(await readFile(project.openCodeConfig, "utf8"), concurrent, "concurrent contents preserved");
    assert.equal(await exists(project.stateDirectory), true, "state still canonical");
    assert.deepEqual(await leftoverArtifacts(root), []);
  });
});

/* ================================================================== *
 * Phase 7 - exact owner-private modes across rollback and completion
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

test("rollback restores the exact prior 0755/0644 modes and a completed install is exactly 0700/0600", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const project = await createProject(root);
    // A legacy, owner-safe but broad-mode prior state. Phase 6 attribution
    // still accepts it, so a transaction may replace it — and rollback or
    // recovery must hand back exactly those modes, never a silent normalization.
    const modesBefore = await broadenPriorState(project.stateDirectory);
    const bytesBefore = await digestTree(project.stateDirectory);

    // Immediate rollback: the prior tree leaves and returns by rename, so the
    // original 0755 directory and 0644 files survive byte- and mode-exactly.
    const rollbackFault = installStepFault("verify");
    const rolled = await capture(() => runManagedTransaction(project)).finally(rollbackFault);
    assert.match(String(rolled.message), /injected fault/);
    const rollbackRecovery = await recoverPendingTransaction({
      paths: project.paths,
      lease: project.lease,
      root: path.dirname(project.paths.controlDirectory),
      scope: "project",
      stateDirectory: project.stateDirectory,
    });
    // A failure that still holds the lease settles its rollback inline, so a
    // "clean" recovery just confirms the rollback that already happened.
    if (rollbackRecovery.status !== "clean") assert.equal(rollbackRecovery.outcome, "rolled-back");
    assert.deepEqual(await modeTree(project.stateDirectory), modesBefore, "rollback restores the exact prior modes");
    assert.deepEqual(await digestTree(project.stateDirectory), bytesBefore, "the prior bytes are unchanged too");

    // Later recovery of a forward run that already committed but crashed
    // during cleanup: the surviving state is the newly installed tree, and it
    // is exactly owner-only — the broad prior modes are not carried forward.
    const commitFault = installStepFault("cleanup:backup");
    const crashed = await capture(() => runManagedTransaction(project)).finally(commitFault);
    assert.match(String(crashed.message), /injected fault/);
    const commitRecovery = await recoverPendingTransaction({
      paths: project.paths,
      lease: project.lease,
      root: path.dirname(project.paths.controlDirectory),
      scope: "project",
      stateDirectory: project.stateDirectory,
    });
    assert.equal(commitRecovery.status, "recovered");
    assert.equal(commitRecovery.outcome, "committed");
    const installed = await modeTree(project.stateDirectory);
    for (const entry of installed) {
      assert.equal(
        entry.mode,
        entry.kind === "directory" ? 0o700 : 0o600,
        `a completed install must be exactly owner-only: ${entry.path} is ${entry.mode.toString(8)}`,
      );
    }
    assert.deepEqual(await leftoverArtifacts(root), [], "no artifact outlives recovery");
    assert.equal(await readJournal(project.paths, { allowMissing: true }), null);
  });
});

/* ================================================================== *
 * Claude integration: durable intents, outcomes, and rollback
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

function managedClaudeOptions(fixture) {
  return {
    buildStage: fixture.buildStage,
    // The executor context carries the Claude runtime so an in-process
    // rollback recovery observes and compensates through the same fake CLI.
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
}

test("a managed transaction journals every Claude intent and outcome before committing", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const fixture = await claudeFixture(root);

    const result = await runManagedTransaction(fixture, managedClaudeOptions(fixture));

    assert.equal(result.status, "committed");
    const settings = JSON.parse(await readFile(path.join(root, ".claude", "settings.local.json"), "utf8"));
    assert.ok(settings.extraKnownMarketplaces[fixture.identity.marketplace], "the marketplace is declared");
    assert.deepEqual(
      fixture.runner.state.plugins.map((entry) => entry.id),
      [fixture.registration.reference],
      "the exact plugin is registered",
    );
    assert.deepEqual(await leftoverArtifacts(root), [], "the journal and payloads are removed after commit");
    assert.equal(await readJournal(fixture.paths, { allowMissing: true }), null);
  });
});

test("a managed failure after Claude registration compensates back to the recorded prior state", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const fixture = await claudeFixture(root);
    const beforeState = await digestTree(fixture.stateDirectory);

    const restore = installStepFault("journal:proven");
    const failure = await capture(() => runManagedTransaction(fixture, managedClaudeOptions(fixture))).finally(restore);
    assert.match(failure.message, /injected fault/);

    const recovery =
      failure.recovery ??
      (await recoverPendingTransaction({
        paths: fixture.paths,
        lease: fixture.lease,
        root,
        scope: "project",
        stateDirectory: fixture.stateDirectory,
        claudeExec: fixture.runner,
        claudeEnv: fixture.env,
        cwd: root,
      }));
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "rolled-back");

    assert.equal(fixture.runner.state.plugins.length, 0, "the plugin this transaction installed is gone");
    assert.equal(fixture.runner.state.marketplaces.length, 0, "the marketplace this transaction added is gone");
    assert.equal(await readFile(fixture.configFile, "utf8"), OLD_CONFIG, "config restored byte for byte");
    assert.deepEqual(await digestTree(fixture.stateDirectory), beforeState, "prior state restored exactly");
    assert.deepEqual(await leftoverArtifacts(root), []);
    assert.equal(await readJournal(fixture.paths, { allowMissing: true }), null);
  });
});

/** Installs a canonical state that carries the generated Claude tree. */
async function installClaudeState(fixture) {
  const exact = path.join(path.dirname(fixture.stateDirectory), ".state.stage-manual");
  const staged = await stageManagedState(fixture.stateDirectory, fixture.registry, {
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
  const stateIdentity = { path: fixture.stateDirectory, ino: Number(stat.ino), dev: Number(stat.dev) };
  const inspected = await inspectGeneratedClaudeRemovalSource({
    identity: fixture.identity,
    stateDirectory: fixture.stateDirectory,
    installation: fixture.installation,
    exec: fixture.runner,
    cwd: fixture.root,
    env: fixture.env,
  });
  return { stateIdentity, inspected };
}

function removalClaudeOptions(fixture, { inspected }) {
  const detachOptions = {
    plan: inspected,
    installation: fixture.installation,
    exec: fixture.runner,
    cwd: fixture.root,
    env: fixture.env,
  };
  const observeAbsent = async () => {
    const observed = await observeClaudeUninstallState(detachOptions);
    const evaluated = classifyClaudeUninstallState(observed, inspected, fixture.installation);
    if (evaluated.classification !== "absent") {
      throw new Error(`Claude registration is not detached: ${(evaluated.reasons ?? []).join("; ")}`);
    }
  };
  return {
    claudeExec: fixture.runner,
    claudeEnv: fixture.env,
    cwd: fixture.root,
    claude: {
      metadata: { ...fixture.metadata, prior: "healthy", desired: "absent" },
    },
    applyExternal: ({ observer }) => detachClaude({ ...detachOptions, observer }),
    verifyExternal: observeAbsent,
    verifyIntegrations: observeAbsent,
  };
}

test("a removal transaction journals the Claude detach and commits", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const fixture = await claudeFixture(root);
    const { stateIdentity, inspected } = await installClaudeState(fixture);
    assert.equal(fixture.runner.state.plugins.length, 1, "the fixture starts healthy");

    const result = await runRemovalTransaction(fixture, {
      stateIdentity,
      ...removalClaudeOptions(fixture, { inspected }),
    });

    assert.equal(result.status, "committed");
    assert.equal(fixture.runner.state.plugins.length, 0, "the plugin is unregistered");
    assert.equal(fixture.runner.state.marketplaces.length, 0, "the marketplace is removed");
    assert.equal(await exists(fixture.stateDirectory), false, "state renamed away by the commit");
    assert.deepEqual(await leftoverArtifacts(root), []);
    assert.equal(await readJournal(fixture.paths, { allowMissing: true }), null);
  });
});

test("a removal failure after detach restores the previously healthy registration", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const fixture = await claudeFixture(root);
    const { stateIdentity, inspected } = await installClaudeState(fixture);
    const beforeState = await digestTree(fixture.stateDirectory);
    const plan = await openCodePlan(fixture.stateDirectory);
    await writeFile(fixture.openCodeConfig, plan.withSource);

    const restore = installStepFault("revalidate");
    const failure = await capture(() =>
      runRemovalTransaction(fixture, {
        stateIdentity,
        files: [
          {
            role: "opencode-config",
            path: fixture.openCodeConfig,
            content: plan.without,
            expectedBefore: plan.withSource,
          },
        ],
        ...removalClaudeOptions(fixture, { inspected }),
      }),
    ).finally(restore);
    assert.match(failure.message, /injected fault/);

    const recovery =
      failure.recovery ??
      (await recoverPendingTransaction({
        paths: fixture.paths,
        lease: fixture.lease,
        root,
        scope: "project",
        stateDirectory: fixture.stateDirectory,
        claudeExec: fixture.runner,
        claudeEnv: fixture.env,
        cwd: root,
      }));
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "rolled-back");

    assert.equal(fixture.runner.state.plugins.length, 1, "the plugin is registered again");
    assert.equal(fixture.runner.state.marketplaces.length, 1, "the marketplace is declared again");
    assert.equal(fixture.runner.state.plugins[0].version, fixture.claudePlan.version, "at the recorded version");
    assert.deepEqual(await digestTree(fixture.stateDirectory), beforeState, "state restored exactly");
    assert.equal(await readFile(fixture.openCodeConfig, "utf8"), plan.withSource, "config restored byte for byte");
    assert.deepEqual(await leftoverArtifacts(root), []);
    assert.equal(await readJournal(fixture.paths, { allowMissing: true }), null);
  });
});

test("a failure at the Claude intent point issues no mutation and rolls back", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const fixture = await claudeFixture(root);
    const beforeState = await digestTree(fixture.stateDirectory);

    const restore = installStepFault("claude-intent");
    const failure = await capture(() => runManagedTransaction(fixture, managedClaudeOptions(fixture))).finally(restore);
    assert.match(failure.message, /injected fault/);

    const recovery =
      failure.recovery ??
      (await recoverPendingTransaction({
        paths: fixture.paths,
        lease: fixture.lease,
        root,
        scope: "project",
        stateDirectory: fixture.stateDirectory,
        claudeExec: fixture.runner,
        claudeEnv: fixture.env,
        cwd: root,
      }));
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "rolled-back");
    assert.equal(fixture.runner.state.marketplaces.length, 0, "a refused intent never mutates Claude state");
    assert.equal(fixture.runner.state.plugins.length, 0);
    assert.equal(await readFile(fixture.configFile, "utf8"), OLD_CONFIG);
    assert.deepEqual(await digestTree(fixture.stateDirectory), beforeState);
    assert.deepEqual(await leftoverArtifacts(root), []);
  });
});

test("a failure at the Claude outcome point leaves a journaled intent that recovery compensates", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const fixture = await claudeFixture(root);
    const beforeState = await digestTree(fixture.stateDirectory);

    const restore = installStepFault("claude-observed");
    const failure = await capture(() => runManagedTransaction(fixture, managedClaudeOptions(fixture))).finally(restore);
    assert.match(failure.message, /injected fault/);

    // The mutation landed and its durable intent is in the journal; only the
    // observed outcome is missing, and the outcome fault also interrupted the
    // in-process compensation on its way back.
    const pending = await readJournal(fixture.paths, { allowMissing: true });
    assert.ok(pending, "the journal survives the interrupted outcome");
    assert.equal(pending.mode, "rollback");
    assert.ok(
      pending.claude.actions.some((entry) => entry.type === "marketplace-add" && entry.status === "intent"),
      "an intent without an outcome is a legal pending journal state",
    );
    assert.equal(fixture.runner.state.marketplaces.length, 0, "compensation already ran before its own outcome fault");
    assert.ok(await exists(fixture.paths.journalFile), "the interrupted compensation leaves the journal in place");

    // Re-entering recovery completes the compensation idempotently.
    const recovery = await recoverPendingTransaction({
      paths: fixture.paths,
      lease: fixture.lease,
      root,
      scope: "project",
      stateDirectory: fixture.stateDirectory,
      claudeExec: fixture.runner,
      claudeEnv: fixture.env,
      cwd: root,
    });
    assert.equal(recovery.status, "recovered");
    assert.equal(recovery.outcome, "rolled-back");
    assert.equal(fixture.runner.state.marketplaces.length, 0, "the journaled intent is reconciled away");
    assert.equal(fixture.runner.state.plugins.length, 0);
    assert.equal(await readFile(fixture.configFile, "utf8"), OLD_CONFIG);
    assert.deepEqual(await digestTree(fixture.stateDirectory), beforeState);
    assert.deepEqual(await leftoverArtifacts(root), []);
    assert.equal(await readJournal(fixture.paths, { allowMissing: true }), null);
  });
});

test("a payload transient replaced mid-write is retained, never deleted as ours", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const project = await createProject(root);
    const { durableFsInternals } = await import("../src/durable-fs.js");
    const plans = await planFilePayloads(
      TX,
      [{ role: "router-config", path: project.configFile, content: NEW_CONFIG, expectedBefore: OLD_CONFIG }],
      { lease: project.lease, controlDirectory: project.paths.controlDirectory, stateDirectory: project.stateDirectory },
    );
    const beforeTransient = `${plans[0].before.path}.tmp`;
    const asideTransient = `${beforeTransient}.aside`;

    const originalSync = durableFsInternals.syncFile;
    let swapped = false;
    durableFsInternals.syncFile = async (handle, targetPath) => {
      if (!swapped) {
        swapped = true;
        // Same device, different inode: the path no longer holds the file
        // this call created. Identity-checked cleanup must retain it.
        await rename(targetPath, asideTransient);
        await writeFile(targetPath, "swapped-in", { mode: 0o600 });
      }
      throw Object.assign(new Error("injected fsync failure"), { code: "EIO" });
    };
    try {
      const failure = await capture(() => materializeFilePayloads(plans, { lease: project.lease }));
      assert.equal(failure.code, "EIO", "the injected failure surfaced");
    } finally {
      durableFsInternals.syncFile = originalSync;
    }

    assert.equal(
      await readFile(beforeTransient, "utf8"),
      "swapped-in",
      "the different-inode transient is preserved, not deleted as ours",
    );
    assert.equal(await exists(plans[0].before.path), false, "no payload lands at the recorded path");
    await rm(beforeTransient, { force: true });
    await rm(asideTransient, { force: true });
  });
});

/* ================================================================== *
 * Phase 14 - strong file identity for payload transients
 * ================================================================== */

test("payload transient cleanup preserves an entry whose identity cannot be proven", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const project = await createProject(root);
    const plans = await planFilePayloads(
      TX,
      [{ role: "router-config", path: project.configFile, content: NEW_CONFIG, expectedBefore: OLD_CONFIG }],
      { lease: project.lease, controlDirectory: project.paths.controlDirectory, stateDirectory: project.stateDirectory },
    );

    // A foreign payload beside a pre-existing transient at the derived path.
    // The payload is refused and preserved (B3: a pathname is not ownership),
    // and the unprovable transient is preserved too, never deleted.
    await writeFile(plans[0].after.path, "partial", { mode: 0o600 });
    const transientPath = `${plans[0].after.path}.tmp`;
    await writeFile(transientPath, "half-written", { mode: 0o600 });

    const originalLstat = transactionInternals.lstat;
    try {
      transactionInternals.lstat = async (target) => {
        const stat = await originalLstat(target);
        if (path.resolve(target) !== path.resolve(transientPath)) return stat;
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: 0 });
      };
      const failure = await capture(() => materializeFilePayloads(plans, { lease: project.lease }));
      assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
      assert.match(failure.message, /it was preserved/);
    } finally {
      transactionInternals.lstat = originalLstat;
    }

    assert.equal(await readFile(transientPath, "utf8"), "half-written", "the unprovable temp is preserved, not deleted");
    assert.equal(await readFile(plans[0].after.path, "utf8"), "partial", "the foreign payload is preserved");
    await rm(plans[0].after.path, { force: true });
    await rm(transientPath, { force: true });
  });
});

test("materializeFilePayloads refuses a directory without stable file identity before any transient exists", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const project = await createProject(root);
    const plans = await planFilePayloads(
      TX,
      [{ role: "router-config", path: project.configFile, content: NEW_CONFIG, expectedBefore: OLD_CONFIG }],
      { lease: project.lease, controlDirectory: project.paths.controlDirectory, stateDirectory: project.stateDirectory },
    );

    // B8: the directory identity preflight runs before any payload or
    // transient can exist.
    const directory = path.dirname(project.configFile);
    const realLstat = transactionInternals.lstat;
    try {
      transactionInternals.lstat = async (target) => {
        const stat = await realLstat(target);
        if (path.resolve(target) !== path.resolve(directory)) return stat;
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: 0 });
      };
      const failure = await capture(() => materializeFilePayloads(plans, { lease: project.lease }));
      assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
      assert.match(failure.message, /stable file identity/);
    } finally {
      transactionInternals.lstat = realLstat;
    }

    assert.equal(await exists(plans[0].before.path), false, "no payload was written");
    assert.equal(await exists(plans[0].after.path), false, "no payload was written");
    assert.equal(await exists(`${plans[0].before.path}.tmp`), false, "no transient was created");
    assert.equal(await exists(`${plans[0].after.path}.tmp`), false, "no transient was created");
  });
});

test("B8/B5: a weak newly created directory is preserved and leaves no payload or transient", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const project = await createProject(root);
    const nestedTarget = path.join(root, ".opencode", "opencode.json");
    const createdDirectory = path.dirname(nestedTarget);
    assert.equal(await exists(createdDirectory), false, "the target directory starts absent");
    const plans = await planFilePayloads(
      TX,
      [{ role: "opencode-config", path: nestedTarget, content: NEW_CONFIG }],
      { lease: project.lease, controlDirectory: project.paths.controlDirectory, stateDirectory: project.stateDirectory },
    );

    // B8: the directory this call creates must itself report a strong
    // identity; when it does not, the failure removes only what this call
    // created - so weak-identity storage with a missing target leaves nothing.
    const realLstat = transactionInternals.lstat;
    try {
      transactionInternals.lstat = async (target) => {
        const stat = await realLstat(target);
        if (path.resolve(target) !== path.resolve(createdDirectory)) return stat;
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: 0 });
      };
      const failure = await capture(() => materializeFilePayloads(plans, { lease: project.lease }));
      assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
      assert.match(failure.message, /stable file identity/);
    } finally {
      transactionInternals.lstat = realLstat;
    }

    // B5: an identity that could never be proven is never a removal
    // authorization - the directory this call created survives, unprovable.
    assert.equal((await lstat(createdDirectory)).isDirectory(), true, "the unprovable directory is preserved");
    assert.equal((await readdir(root)).includes(".opencode"), true);
    assert.equal(await exists(payloadPathFor(nestedTarget, TX, "after")), false, "no payload was written");
    assert.equal(await exists(`${payloadPathFor(nestedTarget, TX, "after")}.tmp`), false, "no transient was created");
  });
});

/* ================================================================== *
 * Phase 14 / B3 - a derived transient pathname is never ownership
 * ================================================================== */

test("B3: a pre-created transient holding the recorded bytes is proven, published, and consumed", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const project = await createProject(root);
    const plans = await planFilePayloads(
      TX,
      [{ role: "router-config", path: project.configFile, content: NEW_CONFIG, expectedBefore: OLD_CONFIG }],
      { lease: project.lease, controlDirectory: project.paths.controlDirectory, stateDirectory: project.stateDirectory },
    );

    // Exactly what an interrupted materialization leaves behind: complete
    // transients holding the planned bytes.
    await writeFile(`${plans[0].before.path}.tmp`, OLD_CONFIG, { mode: 0o600 });
    await writeFile(`${plans[0].after.path}.tmp`, NEW_CONFIG, { mode: 0o600 });

    const result = await materializeFilePayloads(plans, { lease: project.lease });
    assert.deepEqual([...result.materialized], ["created", "created"]);
    assert.equal(await readFile(plans[0].before.path, "utf8"), OLD_CONFIG);
    assert.equal(await readFile(plans[0].after.path, "utf8"), NEW_CONFIG);
    assert.equal((await lstat(plans[0].after.path)).mode & 0o777, 0o600, "published payloads stay owner-only");
    assert.equal(await exists(`${plans[0].before.path}.tmp`), false, "the proven transient is consumed");
    assert.equal(await exists(`${plans[0].after.path}.tmp`), false, "the proven transient is consumed");
  });
});

test("B3: a pre-created partial transient fails closed and is preserved byte for byte", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const project = await createProject(root);
    const plans = await planFilePayloads(
      TX,
      [{ role: "router-config", path: project.configFile, content: NEW_CONFIG, expectedBefore: OLD_CONFIG }],
      { lease: project.lease, controlDirectory: project.paths.controlDirectory, stateDirectory: project.stateDirectory },
    );

    // A partial write of an interrupted materialization (or a foreign file at
    // the derived name): a pathname is not ownership, so it is preserved.
    const transientPath = `${plans[0].after.path}.tmp`;
    await writeFile(transientPath, "partial-write", { mode: 0o600 });
    const failure = await capture(() => materializeFilePayloads(plans, { lease: project.lease }));
    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.match(failure.message, /not a proven write of the recorded bytes/);
    assert.equal(await readFile(transientPath, "utf8"), "partial-write", "the unattributable transient is preserved");
    assert.equal(await exists(plans[0].after.path), false, "nothing was published");
    await rm(transientPath, { force: true });
  });
});

/* ================================================================== *
 * Phase 14 / B4 - payload link topology, and B5 created-directory cleanup
 * ================================================================== */

test("B4: a matching-digest hardlink alias of a payload is refused and preserved", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const project = await createProject(root);
    const plans = await planFilePayloads(
      TX,
      [{ role: "router-config", path: project.configFile, content: NEW_CONFIG, expectedBefore: OLD_CONFIG }],
      { lease: project.lease, controlDirectory: project.paths.controlDirectory, stateDirectory: project.stateDirectory },
    );
    await materializeFilePayloads(plans, { lease: project.lease });

    // A second name for the recorded payload: it can no longer be attributed
    // to this journal, so re-running refuses and preserves both names.
    const alias = path.join(root, "alias.bin");
    await link(plans[0].after.path, alias);
    const failure = await capture(() => materializeFilePayloads(plans, { lease: project.lease }));
    assert.equal(failure.code, JOURNAL_ERROR_CODES.JOURNAL_INVALID);
    assert.match(failure.message, /unproven extra link/);
    assert.equal(await readFile(alias, "utf8"), NEW_CONFIG, "the alias survives");
    assert.equal(await readFile(plans[0].after.path, "utf8"), NEW_CONFIG, "the payload survives");
    await rm(alias, { force: true });
  });
});

test("B4: an extra link on the transient before publication fails closed and preserves everything", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const project = await createProject(root);
    const plans = await planFilePayloads(
      TX,
      [{ role: "router-config", path: project.configFile, content: NEW_CONFIG, expectedBefore: OLD_CONFIG }],
      { lease: project.lease, controlDirectory: project.paths.controlDirectory, stateDirectory: project.stateDirectory },
    );

    const transientPath = `${plans[0].after.path}.tmp`;
    await writeFile(transientPath, NEW_CONFIG, { mode: 0o600 });
    const alias = path.join(root, "alias.bin");
    await link(transientPath, alias);

    const failure = await capture(() => materializeFilePayloads(plans, { lease: project.lease }));
    assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    assert.match(failure.message, /cannot be attributed/);
    assert.equal(await readFile(alias, "utf8"), NEW_CONFIG, "the alias survives");
    assert.equal(await readFile(transientPath, "utf8"), NEW_CONFIG, "the transient survives");
    assert.equal(await exists(plans[0].after.path), false, "nothing was published");
    await rm(alias, { force: true });
    await rm(transientPath, { force: true });
  });
});

test("B4: an interrupted publish pair resumes exactly: adopted, pair consumed, payload single-linked", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const project = await createProject(root);
    const plans = await planFilePayloads(
      TX,
      [{ role: "router-config", path: project.configFile, content: NEW_CONFIG, expectedBefore: OLD_CONFIG }],
      { lease: project.lease, controlDirectory: project.paths.controlDirectory, stateDirectory: project.stateDirectory },
    );

    // The crash after the publish link, before the transient removal: both
    // exact names hold one inode with exactly two links.
    for (const entry of [plans[0].before, plans[0].after]) {
      await writeFile(`${entry.path}.tmp`, entry.bytes, { mode: 0o600 });
      await link(`${entry.path}.tmp`, entry.path);
    }
    const result = await materializeFilePayloads(plans, { lease: project.lease });
    assert.deepEqual([...result.materialized], ["adopted", "adopted"]);
    assert.equal(await readFile(plans[0].after.path, "utf8"), NEW_CONFIG);
    assert.equal((await lstat(plans[0].after.path)).nlink, 1, "the payload is a single name again");
    assert.equal((await lstat(plans[0].before.path)).nlink, 1, "the payload is a single name again");
    assert.equal(await exists(`${plans[0].after.path}.tmp`), false, "the proven pair member is consumed");
    assert.equal(await exists(`${plans[0].before.path}.tmp`), false, "the proven pair member is consumed");
  });
});

test("B5: a created directory whose identity is unprovable immediately after mkdir survives", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const project = await createProject(root);
    const nestedTarget = path.join(root, ".opencode", "opencode.json");
    const createdDirectory = path.dirname(nestedTarget);
    const plans = await planFilePayloads(
      TX,
      [{ role: "opencode-config", path: nestedTarget, content: NEW_CONFIG }],
      { lease: project.lease, controlDirectory: project.paths.controlDirectory, stateDirectory: project.stateDirectory },
    );

    const realLstat = transactionInternals.lstat;
    try {
      transactionInternals.lstat = async (target) => {
        const stat = await realLstat(target);
        if (path.resolve(target) !== path.resolve(createdDirectory)) return stat;
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: 0 });
      };
      const failure = await capture(() => materializeFilePayloads(plans, { lease: project.lease }));
      assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
      assert.match(failure.message, /stable file identity/);
    } finally {
      transactionInternals.lstat = realLstat;
    }

    // B5: an identity that could never be proven is never a removal
    // authorization - the directory this call created survives.
    assert.equal((await lstat(createdDirectory)).isDirectory(), true, "the unprovable directory survives");
    assert.equal(await exists(payloadPathFor(nestedTarget, TX, "after")), false, "no payload was written");
  });
});

test("B5: a created directory replaced before the failure cleanup survives", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const project = await createProject(root);
    const nestedTarget = path.join(root, ".opencode", "opencode.json");
    const createdDirectory = path.dirname(nestedTarget);
    const plans = await planFilePayloads(
      TX,
      [{ role: "opencode-config", path: nestedTarget, content: NEW_CONFIG }],
      { lease: project.lease, controlDirectory: project.paths.controlDirectory, stateDirectory: project.stateDirectory },
    );

    // The payload fails (partial transient), and the created directory is
    // swapped for a different one before the failure cleanup re-proves it.
    const transientPath = `${payloadPathFor(nestedTarget, TX, "after")}.tmp`;
    const realLstat = transactionInternals.lstat;
    let planted = false;
    try {
      transactionInternals.lstat = async (target) => {
        if (path.resolve(target) === path.resolve(transientPath) && !planted) {
          // Simulate the partial transient of a crashed write.
          planted = true;
          await writeFile(transientPath, "partial", { mode: 0o600 });
        }
        const stat = await realLstat(target);
        if (path.resolve(target) === path.resolve(createdDirectory) && planted) {
          // The cleanup-time reproof observes a *different* directory.
          return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: Number(stat.ino) + 1 });
        }
        return stat;
      };
      const failure = await capture(() => materializeFilePayloads(plans, { lease: project.lease }));
      assert.equal(failure.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
      assert.match(failure.message, /not a proven write of the recorded bytes/);
    } finally {
      transactionInternals.lstat = realLstat;
    }

    assert.equal((await lstat(createdDirectory)).isDirectory(), true, "the replaced directory survives");
    assert.deepEqual((await readdir(root)).includes(".opencode"), true);
    await rm(createdDirectory, { recursive: true, force: true });
  });
});

test("B5: a first-payload failure removes the attributable empty created directory", async () => {
  await withTemp("skill-router-journaled-", async (root) => {
    const project = await createProject(root);
    const nestedTarget = path.join(root, ".opencode", "opencode.json");
    const createdDirectory = path.dirname(nestedTarget);
    const plans = await planFilePayloads(
      TX,
      [{ role: "opencode-config", path: nestedTarget, content: NEW_CONFIG }],
      { lease: project.lease, controlDirectory: project.paths.controlDirectory, stateDirectory: project.stateDirectory },
    );

    // The failure lands while the only payload is still being observed - the
    // created directory is still empty - so the attributable directory is
    // removed (deepest first) together with everything this call created.
    const transientPath = `${payloadPathFor(nestedTarget, TX, "after")}.tmp`;
    const realLstat = transactionInternals.lstat;
    try {
      transactionInternals.lstat = async (target) => {
        if (path.resolve(target) === path.resolve(transientPath)) {
          const error = new Error("injected transient observation failure");
          error.code = "EIO";
          throw error;
        }
        return realLstat(target);
      };
      const failure = await capture(() => materializeFilePayloads(plans, { lease: project.lease }));
      assert.equal(failure.code, "EIO", "the injected first-payload failure surfaced");
    } finally {
      transactionInternals.lstat = realLstat;
    }

    assert.equal((await readdir(root)).includes(".opencode"), false, "the empty created directory was removed");
    assert.equal(await exists(transientPath), false, "no transient was left inside a removed directory");
  });
});
