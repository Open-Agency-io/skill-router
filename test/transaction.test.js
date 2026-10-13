import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readOwnedInstallationForRemoval, STATE_MARKER_CONTENT, STATE_MARKER_FILE } from "../src/installation.js";
import {
  applyManagedTransaction,
  applyRemovalTransaction,
  removalTransactionInternals,
  transactionInternals,
  UninstallCommitUncertainError,
  UninstallCommittedCleanupError,
  UninstallCommittedVerificationError,
} from "../src/transaction.js";

test("rolls back state and files when verification fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-transaction-"));
  const state = path.join(root, "state");
  const staged = path.join(root, "staged");
  const config = path.join(root, "config.json");
  await mkdir(state);
  await mkdir(staged);
  await writeFile(path.join(state, ".skill-router-owned"), "skill-router-state-v1\n");
  await writeFile(path.join(state, "value"), "old-state");
  await writeFile(path.join(staged, "value"), "new-state");
  await writeFile(config, "old-config");

  try {
    await assert.rejects(
      () =>
        applyManagedTransaction({
          stateDirectory: state,
          stagedDirectory: staged,
          files: [{ path: config, content: "new-config" }],
          verify: () => {
            throw new Error("verification failed");
          },
        }),
      /verification failed/,
    );
    assert.equal(await readFile(path.join(state, "value"), "utf8"), "old-state");
    assert.equal(await readFile(config, "utf8"), "old-config");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects symlinked configuration without removing staged or existing user data incorrectly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-transaction-"));
  const state = path.join(root, "state");
  const staged = path.join(root, "staged");
  const target = path.join(root, "target.json");
  const link = path.join(root, "config.json");
  await mkdir(staged);
  await writeFile(path.join(staged, ".skill-router-owned"), "skill-router-state-v1\n");
  await writeFile(target, "user-data");
  await symlink(target, link);
  try {
    await assert.rejects(
      () => applyManagedTransaction({ stateDirectory: state, stagedDirectory: staged, files: [{ path: link, content: "new" }] }),
      /non-regular file/,
    );
    assert.equal(await readFile(target, "utf8"), "user-data");
    await assert.rejects(() => access(staged), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runs external apply hooks after verification and skips compensation on success", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-transaction-"));
  const state = path.join(root, "state");
  const staged = path.join(root, "staged");
  const config = path.join(root, "config.json");
  await mkdir(state);
  await mkdir(staged);
  await writeFile(path.join(state, ".skill-router-owned"), "skill-router-state-v1\n");
  await writeFile(path.join(state, "value"), "old-state");
  await writeFile(path.join(staged, "value"), "new-state");
  await writeFile(config, "old-config");
  const order = [];

  try {
    await applyManagedTransaction({
      stateDirectory: state,
      stagedDirectory: staged,
      files: [{ path: config, content: "new-config" }],
      verify: () => order.push("verify"),
      apply: async () => order.push("apply"),
      compensate: () => order.push("compensate"),
    });
    assert.deepEqual(order, ["verify", "apply"]);
    assert.equal(await readFile(path.join(state, "value"), "utf8"), "new-state");
    assert.equal(await readFile(config, "utf8"), "new-config");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restores router state and compensates external actions when apply fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-transaction-"));
  const state = path.join(root, "state");
  const staged = path.join(root, "staged");
  const config = path.join(root, "config.json");
  await mkdir(state);
  await mkdir(staged);
  await writeFile(path.join(state, ".skill-router-owned"), "skill-router-state-v1\n");
  await writeFile(path.join(state, "value"), "old-state");
  await writeFile(path.join(staged, "value"), "new-state");
  await writeFile(config, "old-config");
  const compensated = [];

  try {
    await assert.rejects(
      () =>
        applyManagedTransaction({
          stateDirectory: state,
          stagedDirectory: staged,
          files: [{ path: config, content: "new-config" }],
          apply: async () => {
            throw new Error("registration refused");
          },
          compensate: async (error) => compensated.push(error.message),
        }),
      /registration refused/,
    );
    assert.deepEqual(compensated, ["registration refused"]);
    assert.equal(await readFile(path.join(state, "value"), "utf8"), "old-state");
    assert.equal(await readFile(config, "utf8"), "old-config");
    await assert.rejects(() => access(staged), /ENOENT/);
    assert.deepEqual((await readdir(root)).sort(), ["config.json", "state"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports compensation failures alongside the original error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-transaction-"));
  const state = path.join(root, "state");
  const staged = path.join(root, "staged");
  await mkdir(state);
  await mkdir(staged);
  await writeFile(path.join(state, ".skill-router-owned"), "skill-router-state-v1\n");
  await writeFile(path.join(staged, "value"), "new-state");

  try {
    await assert.rejects(
      () =>
        applyManagedTransaction({
          stateDirectory: state,
          stagedDirectory: staged,
          files: [],
          apply: async () => {
            throw new Error("registration refused");
          },
          compensate: async () => {
            throw new Error("compensation refused");
          },
        }),
      /registration refused; compensation failed: compensation refused/,
    );
    assert.deepEqual((await readdir(root)).sort(), ["state"]);
    await assert.rejects(() => access(path.join(state, "value")), /ENOENT/);
    assert.match(
      await readFile(path.join(state, ".skill-router-owned"), "utf8"),
      /skill-router-state-v1/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function removalFixture(root) {
  const state = path.join(root, "state");
  const config = path.join(root, "opencode.json");
  await mkdir(state, { recursive: true });
  await writeFile(path.join(state, STATE_MARKER_FILE), `${STATE_MARKER_CONTENT}\n`);
  await writeFile(path.join(state, "value"), "old-state");
  await writeFile(config, "old-config");
  const owned = await readOwnedInstallationForRemoval(state, { global: false });
  assert.equal(owned.status, "owned");
  return { state, config, identity: owned.stateIdentity };
}

function removalInternals() {
  const real = {
    rename: removalTransactionInternals.rename,
    rm: removalTransactionInternals.rm,
    verifyCommit: removalTransactionInternals.verifyCommit,
    writeAtomic: transactionInternals.writeAtomic,
  };
  return {
    real,
    restore() {
      removalTransactionInternals.rename = real.rename;
      removalTransactionInternals.rm = real.rm;
      removalTransactionInternals.verifyCommit = real.verifyCommit;
      transactionInternals.writeAtomic = real.writeAtomic;
    },
  };
}

async function ownedState(state, { global = false } = {}) {
  return readOwnedInstallationForRemoval(state, { global });
}

test("removal transaction detaches first, renames last, and commits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-removal-"));
  const { state, config, identity } = await removalFixture(root);
  const internals = removalInternals();
  const order = [];
  let compensated = 0;
  removalTransactionInternals.rename = async (from, to) => {
    order.push("rename");
    return internals.real.rename(from, to);
  };
  removalTransactionInternals.rm = async (target, options) => {
    order.push("cleanup");
    return internals.real.rm(target, options);
  };
  transactionInternals.writeAtomic = async (file, content) => {
    order.push("write");
    return internals.real.writeAtomic(file, content);
  };
  try {
    const result = await applyRemovalTransaction({
      stateDirectory: state,
      stateIdentity: identity,
      files: [{ path: config, content: "new-config" }],
      verifyLocal: ({ phase }) => order.push(`local:${phase}`),
      applyExternal: () => order.push("apply"),
      verifyExternal: () => order.push("external-verify"),
      revalidateOwned: () => order.push("revalidate"),
      compensateExternal: () => {
        compensated += 1;
        order.push("compensate");
      },
    });
    assert.deepEqual(order, ["write", "local:detached", "apply", "external-verify", "revalidate", "rename", "cleanup"]);
    assert.deepEqual(result, { status: "committed", stateDirectory: path.resolve(state) });
    assert.equal(compensated, 0, "a committed uninstall never compensates");
    assert.equal(await readFile(config, "utf8"), "new-config");
    await assert.rejects(() => access(state), /ENOENT/);
    assert.deepEqual((await readdir(root)).sort(), ["opencode.json"], "no backup may survive a committed cleanup");
    assert.deepEqual(await ownedState(state), { status: "absent" });
  } finally {
    internals.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("removal transaction stops before external detach when local verification fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-removal-"));
  const { state, config, identity } = await removalFixture(root);
  const internals = removalInternals();
  const phases = [];
  let applied = 0;
  let externallyVerified = 0;
  let compensated = 0;
  let revalidated = 0;
  try {
    await assert.rejects(
      () =>
        applyRemovalTransaction({
          stateDirectory: state,
          stateIdentity: identity,
          files: [{ path: config, content: "new-config" }],
          verifyLocal: ({ phase }) => {
            phases.push(phase);
            if (phase === "detached") throw new Error("local verification failed");
          },
          applyExternal: () => {
            applied += 1;
          },
          verifyExternal: () => {
            externallyVerified += 1;
          },
          revalidateOwned: () => {
            revalidated += 1;
          },
          compensateExternal: () => {
            compensated += 1;
          },
        }),
      { message: "local verification failed" },
    );
    assert.deepEqual(phases, ["detached", "restored"], "the supplied verifier also proves the restoration");
    assert.equal(applied, 0, "external mutation must never start after a local failure");
    assert.equal(externallyVerified, 0);
    assert.equal(compensated, 0, "compensation runs only when an external mutation started");
    assert.equal(revalidated, 1, "the canonical state is revalidated on the way out");
    assert.equal(await readFile(config, "utf8"), "old-config");
    assert.equal((await ownedState(state)).status, "owned");
    assert.deepEqual((await readdir(root)).sort(), ["opencode.json", "state"]);
  } finally {
    internals.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("removal transaction restores local files and compensates when the external detach fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-removal-"));
  const { state, config, identity } = await removalFixture(root);
  const internals = removalInternals();
  const order = [];
  const compensated = [];
  try {
    await assert.rejects(
      () =>
        applyRemovalTransaction({
          stateDirectory: state,
          stateIdentity: identity,
          files: [{ path: config, content: "new-config" }],
          verifyLocal: ({ phase }) => order.push(`local:${phase}`),
          applyExternal: () => {
            order.push("apply");
            throw new Error("external detach failed");
          },
          verifyExternal: () => order.push("external-verify"),
          revalidateOwned: () => order.push("revalidate"),
          compensateExternal: async (error) => {
            compensated.push(error.message);
            order.push("compensate");
          },
        }),
      { message: "external detach failed" },
    );
    assert.deepEqual(order, ["local:detached", "apply", "revalidate", "compensate", "local:restored"]);
    assert.deepEqual(compensated, ["external detach failed"]);
    assert.equal(await readFile(config, "utf8"), "old-config");
    assert.equal(await readFile(path.join(state, "value"), "utf8"), "old-state");
    assert.equal((await ownedState(state)).status, "owned");
    assert.deepEqual((await readdir(root)).sort(), ["opencode.json", "state"], "no backup may survive a rollback");
  } finally {
    internals.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("removal transaction rolls back when the commit rename fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-removal-"));
  const { state, config, identity } = await removalFixture(root);
  const internals = removalInternals();
  const order = [];
  let renames = 0;
  const compensated = [];
  removalTransactionInternals.rename = async (from, to) => {
    renames += 1;
    if (from === path.resolve(state)) throw new Error("rename refused");
    return internals.real.rename(from, to);
  };
  try {
    await assert.rejects(
      () =>
        applyRemovalTransaction({
          stateDirectory: state,
          stateIdentity: identity,
          files: [{ path: config, content: "new-config" }],
          verifyLocal: ({ phase }) => order.push(`local:${phase}`),
          applyExternal: () => order.push("apply"),
          revalidateOwned: () => order.push("revalidate"),
          compensateExternal: async (error) => {
            compensated.push(error.message);
            order.push("compensate");
          },
        }),
      { message: "rename refused" },
    );
    assert.equal(renames, 1, "only the commit rename is attempted before it fails");
    assert.deepEqual(order, ["local:detached", "apply", "revalidate", "revalidate", "compensate", "local:restored"]);
    assert.deepEqual(compensated, ["rename refused"]);
    assert.equal(await readFile(config, "utf8"), "old-config");
    assert.equal((await ownedState(state)).status, "owned");
    assert.deepEqual((await readdir(root)).sort(), ["opencode.json", "state"]);
  } finally {
    internals.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("removal transaction refuses recorded state identity drift before the commit rename", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-removal-"));
  const { state, config, identity } = await removalFixture(root);
  const internals = removalInternals();
  if (identity.ino === undefined) {
    t.skip("the platform reports no meaningful inode");
    await rm(root, { recursive: true, force: true });
    return;
  }
  const compensated = [];
  let renames = 0;
  removalTransactionInternals.rename = async (...args) => {
    renames += 1;
    return internals.real.rename(...args);
  };
  try {
    await assert.rejects(
      () =>
        applyRemovalTransaction({
          stateDirectory: state,
          stateIdentity: { ...identity, ino: identity.ino + 1 },
          files: [{ path: config, content: "new-config" }],
          applyExternal: () => {},
          compensateExternal: async (error) => compensated.push(error.message),
        }),
      /device\/inode identity/,
    );
    assert.equal(renames, 0, "a drifted state directory is never renamed");
    assert.deepEqual(compensated, ["Router state does not match the recorded device/inode identity"]);
    assert.equal(await readFile(config, "utf8"), "old-config");
    assert.equal((await ownedState(state)).status, "owned");
  } finally {
    internals.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("removal transaction refuses a recorded identity from another path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-removal-"));
  const { state, config } = await removalFixture(root);
  const internals = removalInternals();
  const compensated = [];
  try {
    await assert.rejects(
      () =>
        applyRemovalTransaction({
          stateDirectory: state,
          stateIdentity: { path: path.join(root, "elsewhere") },
          files: [{ path: config, content: "new-config" }],
          applyExternal: () => {},
          compensateExternal: async (error) => compensated.push(error.message),
        }),
      /recorded state path/,
    );
    assert.equal(compensated.length, 1);
    assert.equal(await readFile(config, "utf8"), "old-config");
    assert.equal((await ownedState(state)).status, "owned");
  } finally {
    internals.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("removal transaction refuses to commit when the ownership hook reports drift", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-removal-"));
  const { state, config, identity } = await removalFixture(root);
  const internals = removalInternals();
  const phases = [];
  const compensated = [];
  try {
    await assert.rejects(
      () =>
        applyRemovalTransaction({
          stateDirectory: state,
          stateIdentity: identity,
          files: [{ path: config, content: "new-config" }],
          verifyLocal: ({ phase }) => phases.push(phase),
          applyExternal: () => {},
          revalidateOwned: () => {
            throw new Error("ownership changed since planning");
          },
          compensateExternal: async (error) => compensated.push(error.message),
        }),
      { message: "ownership changed since planning" },
    );
    assert.deepEqual(compensated, ["ownership changed since planning"]);
    assert.deepEqual(phases, ["detached", "restored"]);
    assert.equal(await readFile(config, "utf8"), "old-config");
    assert.equal((await ownedState(state)).status, "owned");
  } finally {
    internals.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("backup cleanup failure reports a committed uninstall and never compensates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-removal-"));
  const { state, config, identity } = await removalFixture(root);
  const internals = removalInternals();
  let compensated = 0;
  let backupPath = null;
  removalTransactionInternals.rm = async (target, options) => {
    if (String(target).includes(".removal-backup-")) throw new Error("cleanup refused");
    return internals.real.rm(target, options);
  };
  try {
    await assert.rejects(
      () =>
        applyRemovalTransaction({
          stateDirectory: state,
          stateIdentity: identity,
          files: [{ path: config, content: "new-config" }],
          verifyLocal: () => {},
          applyExternal: () => {},
          revalidateOwned: () => {},
          compensateExternal: () => {
            compensated += 1;
          },
        }),
      (error) => {
        assert.ok(error instanceof UninstallCommittedCleanupError, "cleanup failure is a distinct error");
        assert.equal(error.committed, true);
        assert.equal(error.name, "UninstallCommittedCleanupError");
        assert.match(error.message, /Uninstall committed/);
        assert.match(error.message, /\.removal-backup-/);
        backupPath = error.backupPath;
        assert.ok(error.message.includes(backupPath), "the message names the exact backup cleanup path");
        return true;
      },
    );
    assert.equal(compensated, 0, "a committed uninstall never compensates");
    assert.equal(await readFile(config, "utf8"), "new-config", "a committed local detach is never restored");
    assert.deepEqual(await ownedState(state), { status: "absent" });

    const backupStat = await lstat(backupPath);
    assert.ok(backupStat.isDirectory() && !backupStat.isSymbolicLink(), "the backup is still an owned directory");
    assert.equal(await readFile(path.join(backupPath, "value"), "utf8"), "old-state");
    assert.equal(
      await readFile(path.join(backupPath, STATE_MARKER_FILE), "utf8"),
      `${STATE_MARKER_CONTENT}\n`,
    );
    const entries = (await readdir(root)).sort();
    assert.deepEqual(entries, ["opencode.json", path.basename(backupPath)]);
  } finally {
    internals.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("removal transaction aggregates compensation, rollback, and verification failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-removal-"));
  const { state, config, identity } = await removalFixture(root);
  const internals = removalInternals();
  try {
    await assert.rejects(
      () =>
        applyRemovalTransaction({
          stateDirectory: state,
          stateIdentity: identity,
          files: [{ path: config, content: "new-config" }],
          verifyLocal: ({ phase }) => {
            if (phase === "restored") throw new Error("restoration refused");
          },
          applyExternal: () => {
            throw new Error("external refused");
          },
          compensateExternal: () => {
            throw new Error("compensation refused");
          },
        }),
      { message: "external refused; compensation failed: compensation refused; restoration verification failed: restoration refused" },
    );
    assert.equal(await readFile(config, "utf8"), "old-config");
    assert.equal((await ownedState(state)).status, "owned");
  } finally {
    internals.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("removal transaction aggregates a failed file restoration with the original error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-removal-"));
  const { state, config, identity } = await removalFixture(root);
  const internals = removalInternals();
  const compensated = [];
  transactionInternals.writeAtomic = async (file, content) => {
    // Snapshot bytes come back as a Buffer only when a restoration rewrites them.
    if (Buffer.isBuffer(content)) throw new Error("restore refused");
    return internals.real.writeAtomic(file, content);
  };
  try {
    await assert.rejects(
      () =>
        applyRemovalTransaction({
          stateDirectory: state,
          stateIdentity: identity,
          files: [{ path: config, content: "new-config" }],
          applyExternal: () => {
            throw new Error("external refused");
          },
          compensateExternal: async (error) => compensated.push(error.message),
        }),
      { message: "external refused; rollback failed: restore refused" },
    );
    assert.deepEqual(compensated, ["external refused"], "compensation still runs after a failed restoration");
    assert.equal(await readFile(config, "utf8"), "new-config", "the restoration really did fail");
    assert.equal((await ownedState(state)).status, "owned");
  } finally {
    internals.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("removal transaction refuses non-regular targets before any mutation or hook runs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-removal-"));
  const { state, identity } = await removalFixture(root);
  const internals = removalInternals();
  const target = path.join(root, "target.json");
  const link = path.join(root, "linked.json");
  await writeFile(target, "user-data");
  await symlink(target, link);
  let hooks = 0;
  try {
    await assert.rejects(
      () =>
        applyRemovalTransaction({
          stateDirectory: state,
          stateIdentity: identity,
          files: [{ path: link, content: "new" }],
          verifyLocal: () => {
            hooks += 1;
          },
          applyExternal: () => {
            hooks += 1;
          },
          revalidateOwned: () => {
            hooks += 1;
          },
          compensateExternal: () => {
            hooks += 1;
          },
        }),
      /non-regular file/,
    );
    assert.equal(hooks, 0, "a refused snapshot runs no hook at all");
    assert.equal(await readFile(target, "utf8"), "user-data");
    assert.equal((await ownedState(state)).status, "owned");
    assert.deepEqual((await readdir(root)).sort(), ["linked.json", "opencode.json", "state", "target.json"]);
  } finally {
    internals.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("removal transaction removes files it created when the external detach fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-removal-"));
  const { state, config, identity } = await removalFixture(root);
  const internals = removalInternals();
  const created = path.join(root, "created.json");
  const compensated = [];
  try {
    await assert.rejects(
      () =>
        applyRemovalTransaction({
          stateDirectory: state,
          stateIdentity: identity,
          files: [
            { path: config, content: "new-config" },
            { path: created, content: "created" },
          ],
          applyExternal: () => {
            throw new Error("external detach failed");
          },
          compensateExternal: async (error) => compensated.push(error.message),
        }),
      { message: "external detach failed" },
    );
    assert.equal(compensated.length, 1);
    await assert.rejects(() => access(created), /ENOENT/);
    assert.equal(await readFile(config, "utf8"), "old-config");
    assert.equal((await ownedState(state)).status, "owned");
  } finally {
    internals.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("removal transaction commits an already-detached local configuration without writing it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-removal-"));
  const { state, config, identity } = await removalFixture(root);
  const internals = removalInternals();
  const order = [];
  removalTransactionInternals.rename = async (from, to) => {
    order.push("rename");
    return internals.real.rename(from, to);
  };
  removalTransactionInternals.rm = async (target, options) => {
    order.push("cleanup");
    return internals.real.rm(target, options);
  };
  try {
    const result = await applyRemovalTransaction({
      stateDirectory: state,
      stateIdentity: identity,
      files: [],
      verifyLocal: ({ phase }) => order.push(`local:${phase}`),
      applyExternal: () => order.push("apply"),
      verifyExternal: () => order.push("external-verify"),
      revalidateOwned: () => order.push("revalidate"),
      compensateExternal: () => order.push("compensate"),
    });
    assert.deepEqual(order, ["local:detached", "apply", "external-verify", "revalidate", "rename", "cleanup"]);
    assert.equal(result.status, "committed");
    assert.equal(await readFile(config, "utf8"), "old-config", "an absent plan writes nothing");
    assert.deepEqual((await readdir(root)).sort(), ["opencode.json"]);
    assert.deepEqual(await ownedState(state), { status: "absent" });
  } finally {
    internals.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("removal transaction validates its inputs before touching the filesystem", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-removal-"));
  const { state, identity } = await removalFixture(root);
  try {
    await assert.rejects(() => applyRemovalTransaction({}), /state directory/);
    await assert.rejects(
      () => applyRemovalTransaction({ stateDirectory: state, files: [{ path: "", content: "x" }] }),
      /must record a path/,
    );
    await assert.rejects(
      () => applyRemovalTransaction({ stateDirectory: state, files: [{ path: path.join(root, "x") }] }),
      /text or byte content/,
    );
    assert.equal((await ownedState(state)).status, "owned");
    assert.ok(identity.path.endsWith("state"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the final integration verification runs immediately before revalidation and the rename", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-removal-"));
  const { state, config, identity } = await removalFixture(root);
  const internals = removalInternals();
  const order = [];
  removalTransactionInternals.rename = async (from, to) => {
    order.push("rename");
    return internals.real.rename(from, to);
  };
  removalTransactionInternals.verifyCommit = async (options) => {
    order.push("verify-commit");
    return internals.real.verifyCommit(options);
  };
  removalTransactionInternals.rm = async (target, options) => {
    order.push("cleanup");
    return internals.real.rm(target, options);
  };
  transactionInternals.writeAtomic = async (file, content) => {
    order.push("write");
    return internals.real.writeAtomic(file, content);
  };
  try {
    await applyRemovalTransaction({
      stateDirectory: state,
      stateIdentity: identity,
      files: [{ path: config, content: "new-config", expectedBefore: "old-config" }],
      verifyLocal: ({ phase }) => order.push(`local:${phase}`),
      applyExternal: () => order.push("apply"),
      verifyExternal: () => order.push("external-verify"),
      verifyIntegrations: () => order.push("integrations"),
      revalidateOwned: () => order.push("revalidate"),
      compensateExternal: () => order.push("compensate"),
    });
    assert.deepEqual(order, [
      "write",
      "local:detached",
      "apply",
      "external-verify",
      "integrations",
      "revalidate",
      "rename",
      "verify-commit",
      "cleanup",
    ]);
    assert.equal(await readFile(config, "utf8"), "new-config");
  } finally {
    internals.restore();
    await rm(root, { recursive: true, force: true });
  }
});

async function removalCase() {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-removal-case-"));
  const fixture = await removalFixture(root);
  const internals = removalInternals();
  return {
    root,
    ...fixture,
    internals,
    cleanup: async () => {
      internals.restore();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("a failed committed-backup verification never rolls back or compensates", async () => {
  const fx = await removalCase();
  let compensated = 0;
  let renames = 0;
  removalTransactionInternals.rename = async (from, to) => {
    renames += 1;
    return fx.internals.real.rename(from, to);
  };
  removalTransactionInternals.verifyCommit = async () => {
    throw new Error("backup verification refused");
  };
  let backupPath = null;
  try {
    await assert.rejects(
      () =>
        applyRemovalTransaction({
          stateDirectory: fx.state,
          stateIdentity: fx.identity,
          files: [{ path: fx.config, content: "new-config", expectedBefore: "old-config" }],
          verifyLocal: () => {},
          applyExternal: () => {},
          compensateExternal: () => {
            compensated += 1;
          },
        }),
      (error) => {
        assert.ok(error instanceof UninstallCommittedVerificationError, "verification failure is a distinct committed error");
        assert.equal(error.committed, true);
        assert.equal(error.uncertain, undefined);
        assert.equal(error.code, "UNINSTALL_COMMITTED_VERIFICATION_FAILED");
        backupPath = error.backupPath;
        assert.ok(error.message.includes(backupPath), "the message names the backup it could not verify");
        assert.match(error.message, /could not be verified/);
        return true;
      },
    );
    assert.equal(renames, 1, "the committed state is never renamed back");
    assert.equal(compensated, 0, "post-commit failures never compensate");
    assert.equal(await readFile(fx.config, "utf8"), "new-config", "local files are not restored after commit");
    await assert.rejects(() => access(fx.state), /ENOENT/, "the canonical state stays removed");

    const backupStat = await lstat(backupPath);
    assert.ok(backupStat.isDirectory() && !backupStat.isSymbolicLink(), "the backup is left untouched");
    assert.equal(await readFile(path.join(backupPath, "value"), "utf8"), "old-state");
    assert.equal(
      await readFile(path.join(backupPath, STATE_MARKER_FILE), "utf8"),
      `${STATE_MARKER_CONTENT}\n`,
      "the unverified backup still carries its ownership marker",
    );
    assert.equal((await readdir(fx.root)).filter((entry) => entry.startsWith("state.removal-backup-")).length, 1);
  } finally {
    await fx.cleanup();
  }
});

test("a rename that completed despite its error is reconciled as committed", async () => {
  const fx = await removalCase();
  let renames = 0;
  let compensated = 0;
  removalTransactionInternals.rename = async (from, to) => {
    renames += 1;
    await fx.internals.real.rename(from, to);
    throw new Error("rename reported failure after moving the directory");
  };
  try {
    const result = await applyRemovalTransaction({
      stateDirectory: fx.state,
      stateIdentity: fx.identity,
      files: [{ path: fx.config, content: "new-config", expectedBefore: "old-config" }],
      verifyLocal: () => {},
      applyExternal: () => {},
      compensateExternal: () => {
        compensated += 1;
      },
    });
    assert.deepEqual(result, { status: "committed", stateDirectory: path.resolve(fx.state) });
    assert.equal(renames, 1, "the rename is not repeated once it is observed as completed");
    assert.equal(compensated, 0, "a reconciled commit never compensates");
    assert.equal(await readFile(fx.config, "utf8"), "new-config");
    await assert.rejects(() => access(fx.state), /ENOENT/);
    assert.deepEqual((await readdir(fx.root)).sort(), ["opencode.json"], "the backup is cleaned up");
  } finally {
    await fx.cleanup();
  }
});

test("an unreconcilable rename outcome is reported as uncertain and touches nothing", async () => {
  const fx = await removalCase();
  let renames = 0;
  let compensated = 0;
  let backupPath = null;
  removalTransactionInternals.rename = async (from, to) => {
    renames += 1;
    await fx.internals.real.rename(from, to);
    // The backup is gone again and a foreign directory took its place: the
    // rename cannot be attributed to this transaction either way.
    await fx.internals.real.rm(to, { recursive: true, force: true });
    await mkdir(to);
    throw new Error("rename reported failure");
  };
  try {
    await assert.rejects(
      () =>
        applyRemovalTransaction({
          stateDirectory: fx.state,
          stateIdentity: fx.identity,
          files: [{ path: fx.config, content: "new-config", expectedBefore: "old-config" }],
          verifyLocal: () => {},
          applyExternal: () => {},
          compensateExternal: () => {
            compensated += 1;
          },
        }),
      (error) => {
        assert.ok(error instanceof UninstallCommitUncertainError, "ambiguity is a distinct error");
        assert.equal(error.uncertain, true);
        assert.equal(error.committed, true, "the canonical state is gone, so the outcome may already be committed");
        assert.equal(error.code, "UNINSTALL_COMMIT_UNCERTAIN");
        assert.match(error.message, /outcome is uncertain/);
        assert.match(error.message, /left untouched/);
        assert.match(error.message, /Nothing was renamed, restored, or compensated/);
        backupPath = error.backupPath;
        assert.ok(error.message.includes(backupPath), "the message names the backup to inspect");
        return true;
      },
    );
    assert.equal(renames, 1, "an unverified backup is never renamed back to the canonical path");
    assert.equal(compensated, 0, "an uncertain outcome never compensates");
    assert.equal(await readFile(fx.config, "utf8"), "new-config", "an uncertain outcome never restores local files");
    await assert.rejects(() => access(fx.state), /ENOENT/, "nothing recreates the canonical state");
    const backupStat = await lstat(backupPath);
    assert.ok(backupStat.isDirectory(), "the foreign backup is left exactly where it is");
    await assert.rejects(() => access(path.join(backupPath, STATE_MARKER_FILE)), /ENOENT/);
  } finally {
    await fx.cleanup();
  }
});

test("an ambiguous outcome with a present but foreign canonical state touches nothing", async () => {
  const fx = await removalCase();
  let renames = 0;
  let compensated = 0;
  removalTransactionInternals.rename = async (from, to) => {
    renames += 1;
    await fx.internals.real.rm(from, { recursive: true, force: true });
    await mkdir(from);
    throw new Error("rename reported failure");
  };
  try {
    await assert.rejects(
      () =>
        applyRemovalTransaction({
          stateDirectory: fx.state,
          stateIdentity: fx.identity,
          files: [{ path: fx.config, content: "new-config", expectedBefore: "old-config" }],
          applyExternal: () => {},
          compensateExternal: () => {
            compensated += 1;
          },
        }),
      (error) => {
        assert.ok(error instanceof UninstallCommitUncertainError);
        assert.equal(error.uncertain, true);
        assert.equal(error.committed, false, "a foreign canonical state is not claimed as committed");
        return true;
      },
    );
    assert.equal(renames, 1, "an unverified backup is never renamed back to the canonical path");
    assert.equal(compensated, 0);
    assert.equal(await readFile(fx.config, "utf8"), "new-config", "local files are left alone");
    assert.ok(await existsPath(fx.state), "the foreign canonical entry is not deleted either");
    await assert.rejects(() => access(path.join(fx.state, STATE_MARKER_FILE)), /ENOENT/);
  } finally {
    await fx.cleanup();
  }
});

test("a rename that leaves a foreign backup beside an intact canonical state rolls back", async () => {
  const fx = await removalCase();
  let renames = 0;
  let compensated = 0;
  let foreign = null;
  removalTransactionInternals.rename = async (from, to) => {
    renames += 1;
    foreign = to;
    await mkdir(to);
    throw new Error("rename refused");
  };
  try {
    await assert.rejects(
      () =>
        applyRemovalTransaction({
          stateDirectory: fx.state,
          stateIdentity: fx.identity,
          files: [{ path: fx.config, content: "new-config", expectedBefore: "old-config" }],
          verifyLocal: () => {},
          applyExternal: () => {},
          compensateExternal: () => {
            compensated += 1;
          },
        }),
      { message: "rename refused" },
    );
    assert.equal(renames, 1, "rollback never renames an unverified backup into the canonical path");
    assert.equal(compensated, 1, "an intact canonical state is still a pre-commit failure");
    assert.equal(await readFile(fx.config, "utf8"), "old-config", "local files are restored");
    assert.equal((await ownedState(fx.state)).status, "owned", "the canonical state is untouched");
    assert.equal(await readFile(path.join(fx.state, "value"), "utf8"), "old-state");
    assert.ok(await existsPath(foreign), "the unverified backup is never adopted");
  } finally {
    await fx.cleanup();
  }
});

async function existsPath(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

test("a file that changed since planning refuses before any write or hook", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-removal-"));
  const { state, config, identity } = await removalFixture(root);
  const internals = removalInternals();
  const hooks = [];
  try {
    await assert.rejects(
      () =>
        applyRemovalTransaction({
          stateDirectory: state,
          stateIdentity: identity,
          files: [{ path: config, content: "new-config", expectedBefore: "planned-bytes" }],
          verifyLocal: () => hooks.push("verify"),
          applyExternal: () => hooks.push("apply"),
          verifyExternal: () => hooks.push("verify-external"),
          verifyIntegrations: () => hooks.push("integrations"),
          revalidateOwned: () => hooks.push("revalidate"),
          compensateExternal: () => hooks.push("compensate"),
        }),
      /no longer matches the bytes observed during planning \(expected 13 bytes, found 10 bytes\)/,
    );
    assert.deepEqual(hooks, [], "no hook runs after a compare-and-swap mismatch");
    assert.equal(await readFile(config, "utf8"), "old-config", "the file is left untouched");
    assert.equal((await ownedState(state)).status, "owned");

    // A recorded expectation of "no file" only matches a missing target.
    await assert.rejects(
      () =>
        applyRemovalTransaction({
          stateDirectory: state,
          stateIdentity: identity,
          files: [{ path: config, content: "new-config", expectedBefore: null }],
        }),
      /expected no file, found 10 bytes/,
    );

    await assert.rejects(
      () =>
        applyRemovalTransaction({
          stateDirectory: state,
          stateIdentity: identity,
          files: [{ path: config, content: 3 }],
        }),
      /must record text or byte content/,
    );
    await assert.rejects(
      () =>
        applyRemovalTransaction({
          stateDirectory: state,
          stateIdentity: identity,
          files: [{ path: config, content: "x", expectedBefore: 42 }],
        }),
      /expectedBefore must be null, text, or bytes/,
    );

    // ... and a matching expectation of "no file" commits the write.
    const created = path.join(root, "created.json");
    const result = await applyRemovalTransaction({
      stateDirectory: state,
      stateIdentity: identity,
      files: [{ path: created, content: "created", expectedBefore: null }],
      revalidateOwned: () => {},
    });
    assert.equal(result.status, "committed");
    assert.equal(await readFile(created, "utf8"), "created", "a null expectation matches a missing file");
  } finally {
    internals.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("a concurrent edit during rollback is preserved and reported as a conflict", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-removal-"));
  const { state, config, identity } = await removalFixture(root);
  const internals = removalInternals();
  let compensated = 0;
  try {
    await assert.rejects(
      () =>
        applyRemovalTransaction({
          stateDirectory: state,
          stateIdentity: identity,
          files: [{ path: config, content: "new-config", expectedBefore: "old-config" }],
          applyExternal: async () => {
            await writeFile(config, "concurrent-edit");
            throw new Error("external refused");
          },
          compensateExternal: () => {
            compensated += 1;
          },
        }),
      (error) => {
        assert.match(error.message, /^external refused/);
        assert.match(error.message, /rollback conflict: .*concurrent contents were preserved/);
        return true;
      },
    );
    assert.equal(await readFile(config, "utf8"), "concurrent-edit", "the concurrent writer's bytes win");
    assert.equal(compensated, 1, "compensation still runs after a conflict");
    assert.equal((await ownedState(state)).status, "owned");
    assert.deepEqual((await readdir(root)).sort(), ["opencode.json", "state"]);
  } finally {
    internals.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("a concurrent deletion during rollback is preserved and reported as a conflict", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-removal-"));
  const { state, config, identity } = await removalFixture(root);
  const internals = removalInternals();
  try {
    await assert.rejects(
      () =>
        applyRemovalTransaction({
          stateDirectory: state,
          stateIdentity: identity,
          files: [{ path: config, content: "new-config", expectedBefore: "old-config" }],
          applyExternal: async () => {
            await rm(config, { force: true });
            throw new Error("external refused");
          },
        }),
      /rollback conflict: .*concurrent contents were preserved/,
    );
    await assert.rejects(() => access(config), /ENOENT/, "the missing replacement is not resurrected");
    assert.equal((await ownedState(state)).status, "owned");
  } finally {
    internals.restore();
    await rm(root, { recursive: true, force: true });
  }
});
