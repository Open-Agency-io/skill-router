import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { durableFsInternals, fileIdentity, syncDirectory } from "../src/durable-fs.js";
import {
  acquireMutationLock,
  CLAIM_PREFIX,
  cleanupDeadClaimLeftovers,
  controlPaths,
  LOCK_ERROR_CODES,
  OWNER_FIELDS,
  OWNER_SCHEMA_VERSION,
} from "../src/mutation-lock.js";

const MUTATION_LOCK_MODULE = new URL("../src/mutation-lock.js", import.meta.url).href;
const REAL_HOSTNAME = os.hostname();
const POSIX = process.platform !== "win32";
const SENTINEL_ENV_KEY = "SKILL_ROUTER_LOCK_TEST_SENTINEL";
const SENTINEL_VALUE = "SENTINEL-a91f-lock-metadata-must-not-leak";

const CHILD_SCRIPT = `
import { acquireMutationLock, controlPaths } from ${JSON.stringify(MUTATION_LOCK_MODULE)};
const paths = controlPaths({ root: process.env.SR_LOCK_TEST_ROOT });
const holdMs = Number(process.env.SR_LOCK_TEST_HOLD_MS || "0");
const timeoutMs = Number(process.env.SR_LOCK_TEST_TIMEOUT_MS || "10000");
const heartbeatMs = Number(process.env.SR_LOCK_TEST_HEARTBEAT_MS || "2000");
const noRelease = process.env.SR_LOCK_TEST_NO_RELEASE === "1";
const stayAlive = process.env.SR_LOCK_TEST_STAY_ALIVE === "1";
try {
  const lease = await acquireMutationLock(paths, { timeoutMs, heartbeatMs });
  process.stdout.write("ACQUIRED " + lease.token + "\\n");
  if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
  if (stayAlive) setInterval(() => {}, 1000);
  if (!noRelease) {
    await lease.release();
    process.stdout.write("RELEASED\\n");
  }
} catch (error) {
  process.stdout.write("ERROR " + (error && error.code ? error.code : "UNKNOWN") + "\\n");
  process.exitCode = 3;
}
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withTemp(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-lock-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withInternals(overrides, run) {
  const saved = {};
  for (const key of Object.keys(overrides)) saved[key] = durableFsInternals[key];
  Object.assign(durableFsInternals, overrides);
  try {
    return await run();
  } finally {
    Object.assign(durableFsInternals, saved);
  }
}

function ownerDocument(overrides = {}) {
  const document = {
    schema: OWNER_SCHEMA_VERSION,
    owner: `${REAL_HOSTNAME}:987654`,
    token: "ab".repeat(32),
    hostname: REAL_HOSTNAME,
    platform: process.platform,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    pid: 987654,
    processStartedAt: 1700000000000,
    acquiredAt: 1700000000000,
  };
  return { ...document, ...overrides };
}

async function seedLock(paths, options = {}) {
  const {
    document = ownerDocument(),
    heartbeatAgeMs = 0,
    heartbeatContent,
    writeOwner = true,
    writeHeartbeat = true,
    lockMode = 0o700,
    controlMode = 0o700,
    ownerMode = 0o600,
    heartbeatMode = 0o600,
  } = options;
  await mkdir(paths.controlDirectory, { recursive: true, mode: controlMode });
  await mkdir(paths.lockDirectory, { recursive: true, mode: lockMode });
  await writeFile(`${paths.controlDirectory}/.keep`, "", { mode: 0o600 });
  if (writeOwner) {
    await writeFile(paths.ownerFile, `${JSON.stringify(document)}\n`, { mode: ownerMode });
    await chmod(paths.ownerFile, ownerMode);
  }
  if (writeHeartbeat) {
    const content = heartbeatContent ?? String(Date.now() - heartbeatAgeMs);
    await writeFile(paths.heartbeatFile, `${content}\n`, { mode: heartbeatMode });
    await chmod(paths.heartbeatFile, heartbeatMode);
  }
  if (POSIX) {
    await chmod(paths.controlDirectory, controlMode);
    await chmod(paths.lockDirectory, lockMode);
  }
}

async function claimEntries(paths) {
  const entries = await readdir(paths.controlDirectory);
  return entries.filter((name) => name.startsWith(CLAIM_PREFIX));
}

async function waitForLine(handle, needle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!handle.stdout.includes(needle)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${needle}; stdout=${JSON.stringify(handle.stdout)} stderr=${JSON.stringify(handle.stderr)}`);
    }
    await sleep(20);
  }
}

async function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function startChild(envOverrides) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD_SCRIPT], {
    env: { ...process.env, ...envOverrides },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const done = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    done,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

async function withChild(envOverrides, run) {
  const handle = startChild(envOverrides);
  try {
    return await run(handle);
  } finally {
    if (handle.child.exitCode === null && handle.child.signalCode === null) {
      handle.child.kill("SIGKILL");
      await handle.done.catch(() => {});
    }
  }
}

function codeIs(expected) {
  return (error) => error && error.code === expected;
}

test("controlPaths yields the fixed project and global control locations", async () => {
  const project = controlPaths({ root: "/projects/demo" });
  assert.equal(project.scope, "project");
  assert.equal(project.controlDirectory, path.join("/projects/demo", ".skill-router-control"));
  assert.equal(project.controlFile, path.join(project.controlDirectory, "control.json"));
  assert.equal(project.lockDirectory, path.join(project.controlDirectory, "mutation.lock"));
  assert.equal(project.ownerFile, path.join(project.lockDirectory, "owner.json"));
  assert.equal(project.heartbeatFile, path.join(project.lockDirectory, "heartbeat"));
  assert.equal(project.journalFile, path.join(project.controlDirectory, "transaction.json"));

  const global = controlPaths({ home: "/home/agent", global: true });
  assert.equal(global.scope, "global");
  assert.equal(
    global.controlDirectory,
    path.join("/home/agent", ".local", "share", "skill-router-control"),
  );
  assert.equal(global.lockDirectory, path.join(global.controlDirectory, "mutation.lock"));

  assert.throws(() => controlPaths({}), TypeError);
  assert.throws(() => controlPaths({ global: true }), TypeError);
  await assert.rejects(() => acquireMutationLock({ controlDirectory: "/x" }), TypeError);
  await assert.rejects(
    () =>
      acquireMutationLock({
        controlDirectory: "/x/c",
        lockDirectory: "/elsewhere/mutation.lock",
        ownerFile: "/x/c/mutation.lock/owner.json",
        heartbeatFile: "/x/c/mutation.lock/heartbeat",
      }),
    TypeError,
  );
});

test("acquire creates owner-only state with a closed v1 schema and leaks no sentinels", async () => {
  process.env[SENTINEL_ENV_KEY] = SENTINEL_VALUE;
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    const lease = await acquireMutationLock(paths, { heartbeatMs: 0 });
    try {
      const ownerText = await readFile(paths.ownerFile, "utf8");
      const heartbeatText = await readFile(paths.heartbeatFile, "utf8");
      const document = JSON.parse(ownerText);

      assert.deepEqual(Object.keys(document), [...OWNER_FIELDS], "the owner schema is closed");
      assert.equal(document.schema, OWNER_SCHEMA_VERSION);
      assert.match(document.token, /^[0-9a-f]{64}$/);
      assert.equal(document.token, lease.token);
      assert.equal(document.hostname, REAL_HOSTNAME);
      assert.equal(document.platform, process.platform);
      assert.equal(document.pid, process.pid);
      if (typeof process.getuid === "function") assert.equal(document.uid, process.getuid());
      assert.equal(Number.isInteger(document.processStartedAt), true);
      assert.equal(document.acquiredAt, lease.acquiredAt);
      assert.equal(heartbeatText, `${document.acquiredAt}\n`);
      assert.equal(document.owner, `${REAL_HOSTNAME}:${process.pid}`);

      assert.equal(ownerText.includes(SENTINEL_VALUE), false, "no env/secret content in owner metadata");
      assert.equal(heartbeatText.includes(SENTINEL_VALUE), false, "no env/secret content in heartbeat");
      assert.deepEqual(
        Object.keys(document).filter((key) => /body|env|request|secret|skill/i.test(key)),
        [],
        "no request/body fields",
      );

      if (POSIX) {
        assert.equal((await lstat(paths.controlDirectory)).mode & 0o777, 0o700);
        assert.equal((await lstat(paths.lockDirectory)).mode & 0o777, 0o700);
        assert.equal((await lstat(paths.ownerFile)).mode & 0o777, 0o600);
        assert.equal((await lstat(paths.heartbeatFile)).mode & 0o777, 0o600);
      } else {
        assert.equal((await lstat(paths.controlDirectory)).isDirectory(), true);
        assert.equal((await lstat(paths.ownerFile)).isSymbolicLink(), false);
      }
      assert.equal(paths.scope, "project");
    } finally {
      await lease.release();
      delete process.env[SENTINEL_ENV_KEY];
    }
    await assert.rejects(() => lstat(paths.lockDirectory), codeIs("ENOENT"));
    assert.deepEqual(await readdir(paths.controlDirectory), []);
  });
});

test("lease supports heartbeat updates, identity assertions, and exact release", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    const clock = { value: 1000000 };
    const renameCalls = [];
    const rmCalls = [];
    const lease = await acquireMutationLock(paths, {
      heartbeatMs: 0,
      now: () => clock.value,
      rename: async (from, to) => {
        renameCalls.push([from, to]);
        return rename(from, to);
      },
      rm: async (target, options) => {
        rmCalls.push(target);
        return rm(target, options);
      },
    });
    assert.equal(await lease.assertHeld(), true);
    assert.equal(await readFile(paths.heartbeatFile, "utf8"), "1000000\n");

    clock.value = 1005000;
    await lease.heartbeat();
    assert.equal(await readFile(paths.heartbeatFile, "utf8"), "1005000\n", "heartbeat writes the injected clock");

    await lease.release();
    assert.equal(renameCalls.length, 1, "release performs exactly one rename");
    assert.equal(renameCalls[0][0], paths.lockDirectory, "the fixed lock path is renamed, never deleted in place");
    assert.equal(path.basename(renameCalls[0][1]).startsWith(CLAIM_PREFIX), true);
    assert.equal(rmCalls.length, 1, "release deletes exactly one tree");
    assert.equal(rmCalls[0] !== paths.lockDirectory, true, "the fixed lock path is never passed to rm");
    assert.equal(path.basename(rmCalls[0]).startsWith(CLAIM_PREFIX), true, "only the verified claim is deleted");

    await assert.rejects(() => lstat(paths.lockDirectory), codeIs("ENOENT"));
    assert.equal((await lstat(paths.controlDirectory)).isDirectory(), true, "the control directory survives release");
    assert.deepEqual(await claimEntries(paths), [], "no claim leftovers");
    await lease.release();
    await assert.rejects(() => lease.assertHeld(), codeIs(LOCK_ERROR_CODES.LOCK_COMPROMISED));
    await assert.rejects(() => lease.heartbeat(), codeIs(LOCK_ERROR_CODES.LOCK_COMPROMISED));
  });
});

test("the automatic heartbeat refreshes the heartbeat file on its interval", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    const lease = await acquireMutationLock(paths, { heartbeatMs: 20 });
    try {
      const initial = Number(await readFile(paths.heartbeatFile, "utf8"));
      const deadline = Date.now() + 2000;
      let latest = initial;
      while (latest <= initial && Date.now() < deadline) {
        await sleep(30);
        latest = Number(await readFile(paths.heartbeatFile, "utf8"));
      }
      assert.ok(latest > initial, `heartbeat advanced from ${initial} to ${latest}`);
      assert.equal(await lease.assertHeld(), true);
    } finally {
      await lease.release();
    }
  });
});

test("a live lock holder is refused without reclamation and errors stay bounded", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    await seedLock(paths, { document: ownerDocument({ pid: process.pid }), heartbeatAgeMs: 0 });
    const before = await readFile(paths.ownerFile, "utf8");
    const error = await acquireMutationLock(paths, { timeoutMs: 120, heartbeatMs: 0 }).then(
      () => null,
      (failure) => failure,
    );
    assert.ok(error, "the lock is not acquired");
    assert.equal(error.code, LOCK_ERROR_CODES.MUTATION_LOCKED);
    assert.ok(error.message.includes(paths.lockDirectory), "message names the lock path");
    assert.ok(error.message.includes(String(process.pid)), "message may include the safe owner pid");
    assert.equal(error.message.includes(ownerDocument().token), false, "message never includes the token");
    assert.equal(error.message.includes(SENTINEL_VALUE), false);
    assert.equal(await readFile(paths.ownerFile, "utf8"), before, "the holder's metadata is untouched");
  });
});

test("stale heartbeats never reclaim a live or reused PID", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });

    // Stale heartbeat, but the recorded PID is genuinely alive (this process).
    await seedLock(paths, { document: ownerDocument({ pid: process.pid }), heartbeatAgeMs: 600000 });
    const before = await readFile(paths.ownerFile, "utf8");
    await assert.rejects(
      () => acquireMutationLock(paths, { timeoutMs: 120, heartbeatMs: 0 }),
      codeIs(LOCK_ERROR_CODES.MUTATION_LOCKED),
      "age alone never steals the lock",
    );
    assert.equal(await readFile(paths.ownerFile, "utf8"), before);

    // PID reuse: the recorded PID now belongs to some other live process.
    await seedLock(paths, { document: ownerDocument({ pid: 987654 }), heartbeatAgeMs: 600000 });
    const reused = await readFile(paths.ownerFile, "utf8");
    await assert.rejects(
      () => acquireMutationLock(paths, { timeoutMs: 120, heartbeatMs: 0, kill: () => undefined }),
      codeIs(LOCK_ERROR_CODES.MUTATION_LOCKED),
      "a reused live PID is never treated as dead",
    );
    assert.equal(await readFile(paths.ownerFile, "utf8"), reused);
  });
});

test("stale locks with EPERM or unknown kill outcomes are never reclaimed", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    const failing = [
      ["EPERM", Object.assign(new Error("operation not permitted"), { code: "EPERM" })],
      ["unknown", new Error("kill probe exploded")],
      ["unknown-code", Object.assign(new Error("odd"), { code: "EAGAIN" })],
    ];
    for (const [label, failure] of failing) {
      await seedLock(paths, { document: ownerDocument({ pid: 987654 }), heartbeatAgeMs: 600000 });
      const before = await readFile(paths.ownerFile, "utf8");
      await assert.rejects(
        () =>
          acquireMutationLock(paths, {
            timeoutMs: 100,
            heartbeatMs: 0,
            kill: () => {
              throw failure;
            },
          }),
        codeIs(LOCK_ERROR_CODES.MUTATION_LOCKED),
        `${label} is fail-closed`,
      );
      assert.equal(await readFile(paths.ownerFile, "utf8"), before);
    }
  });
});

test("a stale dead owner (ESRCH) is reclaimed atomically and reacquired", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    const staleToken = "ab".repeat(32);
    await seedLock(paths, { document: ownerDocument({ token: staleToken, pid: 987654 }), heartbeatAgeMs: 600000 });
    const lease = await acquireMutationLock(paths, {
      heartbeatMs: 0,
      kill: () => {
        const error = new Error("no such process");
        error.code = "ESRCH";
        throw error;
      },
    });
    assert.notEqual(lease.token, staleToken, "the reclaimed lock is owned by this lease");
    assert.equal((await lstat(paths.ownerFile)).isSymbolicLink(), false);
    assert.deepEqual(await claimEntries(paths), [], "the claim is deleted after verification");
    const entries = await readdir(paths.controlDirectory);
    assert.deepEqual(entries.sort(), [".keep", "mutation.lock"]);
    await lease.release();
    assert.deepEqual(await readdir(paths.controlDirectory), [".keep"]);
  });
});

test("an owner from a different host fails closed with LOCK_FOREIGN", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    await seedLock(paths, {
      document: ownerDocument({ hostname: "foreign-host.example", owner: "foreign-host.example:4242", pid: 4242 }),
      heartbeatAgeMs: 600000,
    });
    const before = await readFile(paths.ownerFile, "utf8");
    const error = await acquireMutationLock(paths, { timeoutMs: 200, heartbeatMs: 0 }).then(
      () => null,
      (failure) => failure,
    );
    assert.ok(error);
    assert.equal(error.code, LOCK_ERROR_CODES.LOCK_FOREIGN);
    assert.equal(error.ownerHost, "foreign-host.example");
    assert.equal(error.ownerPid, 4242);
    assert.equal(await readFile(paths.ownerFile, "utf8"), before, "foreign locks are never reclaimed");
  });
});

test("a crash between mkdir and metadata stays unclassifiable and fail-closed", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    await seedLock(paths, { writeOwner: false, writeHeartbeat: false });
    const old = new Date(Date.now() - 3600000);
    await utimes(paths.lockDirectory, old, old);

    let attempts = 0;
    const started = Date.now();
    const error = await acquireMutationLock(paths, {
      timeoutMs: 3000,
      initGraceMs: 50,
      heartbeatMs: 0,
      mkdir: async (target, options) => {
        attempts += 1;
        return mkdir(target, options);
      },
    }).then(
      () => null,
      (failure) => failure,
    );
    const elapsed = Date.now() - started;
    assert.ok(error);
    assert.equal(error.code, LOCK_ERROR_CODES.LOCK_FOREIGN, "missing metadata is foreign/invalid, not lock-aged");
    assert.ok(elapsed >= 40, `the initializing lock was briefly retried (${elapsed}ms)`);
    assert.ok(attempts >= 2, `retried before classifying (${attempts} attempts)`);
    assert.equal((await lstat(paths.lockDirectory)).isDirectory(), true, "age never reclaims missing metadata");
  });
});

test("missing heartbeat metadata fails closed with LOCK_FOREIGN", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    await seedLock(paths, { writeHeartbeat: false });
    const before = await readFile(paths.ownerFile, "utf8");
    const started = Date.now();
    await assert.rejects(
      () => acquireMutationLock(paths, { timeoutMs: 3000, initGraceMs: 50, heartbeatMs: 0 }),
      codeIs(LOCK_ERROR_CODES.LOCK_FOREIGN),
    );
    assert.ok(Date.now() - started >= 40, "brief retry before classifying");
    assert.equal(await readFile(paths.ownerFile, "utf8"), before);
    assert.equal((await lstat(paths.lockDirectory)).isDirectory(), true);
  });
});

test("malformed owner metadata fails closed with LOCK_COMPROMISED", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    const variants = [
      ["not JSON", "definitely-not-json"],
      ["array", "[]"],
      ["missing token", JSON.stringify({ ...ownerDocument(), token: undefined })],
      ["extra field", JSON.stringify({ ...ownerDocument(), request: "body-sentinel" })],
      ["bad token", JSON.stringify(ownerDocument({ token: "nope" }))],
      ["bad pid", JSON.stringify(ownerDocument({ pid: -1 }))],
      ["bad schema", JSON.stringify(ownerDocument({ schema: 2 }))],
      ["string timestamp", JSON.stringify(ownerDocument({ acquiredAt: "now" }))],
    ];
    for (const [label, content] of variants) {
      await seedLock(paths, { writeOwner: false, writeHeartbeat: true });
      await writeFile(paths.ownerFile, content, { mode: 0o600 });
      await assert.rejects(
        () => acquireMutationLock(paths, { timeoutMs: 100, heartbeatMs: 0 }),
        codeIs(LOCK_ERROR_CODES.LOCK_COMPROMISED),
        `${label} is fail-closed`,
      );
      assert.equal((await lstat(paths.lockDirectory)).isDirectory(), true, `${label} leaves the lock in place`);
    }
  });
});

test("symlinked, wrong-type, and special lock paths fail closed", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });

    // Lock path replaced by a symlink.
    const innocent = path.join(root, "innocent");
    await mkdir(innocent);
    await writeFile(path.join(innocent, "inside.txt"), "keep", { mode: 0o600 });
    await seedLock(paths);
    await rm(paths.lockDirectory, { recursive: true, force: true });
    await symlink(innocent, paths.lockDirectory);
    await assert.rejects(
      () => acquireMutationLock(paths, { timeoutMs: 100, heartbeatMs: 0 }),
      codeIs(LOCK_ERROR_CODES.LOCK_COMPROMISED),
    );
    assert.equal((await lstat(paths.lockDirectory)).isSymbolicLink(), true, "the symlink is untouched");
    assert.equal(await readFile(path.join(innocent, "inside.txt"), "utf8"), "keep");

    // Lock path replaced by a regular file.
    await rm(paths.lockDirectory, { force: true });
    await writeFile(paths.lockDirectory, "not-a-lock", { mode: 0o600 });
    await assert.rejects(
      () => acquireMutationLock(paths, { timeoutMs: 100, heartbeatMs: 0 }),
      codeIs(LOCK_ERROR_CODES.LOCK_COMPROMISED),
    );
    assert.equal(await readFile(paths.lockDirectory, "utf8"), "not-a-lock");

    // Lock path replaced by a FIFO (portable best effort).
    await rm(paths.lockDirectory, { force: true });
    const { spawnSync } = await import("node:child_process");
    if (spawnSync("mkfifo", [paths.lockDirectory]).status === 0) {
      await assert.rejects(
        () => acquireMutationLock(paths, { timeoutMs: 100, heartbeatMs: 0 }),
        codeIs(LOCK_ERROR_CODES.LOCK_COMPROMISED),
      );
      assert.equal((await lstat(paths.lockDirectory)).isFIFO(), true);
      await rm(paths.lockDirectory, { force: true });
    }
  });
});

test("symlinked and wrong-type owner or heartbeat files fail closed", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    const secret = path.join(root, "secret.txt");
    await writeFile(secret, "do-not-read", { mode: 0o600 });

    await seedLock(paths);
    await rm(paths.ownerFile, { force: true });
    await symlink(secret, paths.ownerFile);
    await assert.rejects(
      () => acquireMutationLock(paths, { timeoutMs: 100, heartbeatMs: 0 }),
      codeIs(LOCK_ERROR_CODES.LOCK_COMPROMISED),
    );
    assert.equal(await readFile(secret, "utf8"), "do-not-read", "symlink targets are never followed or removed");

    await rm(paths.ownerFile, { force: true });
    await mkdir(paths.ownerFile);
    await assert.rejects(
      () => acquireMutationLock(paths, { timeoutMs: 100, heartbeatMs: 0 }),
      codeIs(LOCK_ERROR_CODES.LOCK_COMPROMISED),
    );
    await rm(paths.ownerFile, { recursive: true, force: true });

    await seedLock(paths, { writeOwner: true, writeHeartbeat: false });
    await rm(paths.heartbeatFile, { force: true });
    await symlink(secret, paths.heartbeatFile);
    await assert.rejects(
      () => acquireMutationLock(paths, { timeoutMs: 100, heartbeatMs: 0 }),
      codeIs(LOCK_ERROR_CODES.LOCK_COMPROMISED),
    );
    await rm(paths.heartbeatFile, { force: true });
    await mkdir(paths.heartbeatFile);
    await assert.rejects(
      () => acquireMutationLock(paths, { timeoutMs: 100, heartbeatMs: 0 }),
      codeIs(LOCK_ERROR_CODES.LOCK_COMPROMISED),
    );
  });
});

test("overpermissive control, lock, owner, and heartbeat modes fail closed", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    const cases = [
      [paths.controlDirectory, 0o777],
      [paths.lockDirectory, 0o755],
      [paths.ownerFile, 0o644],
      [paths.heartbeatFile, 0o666],
    ];
    await seedLock(paths);
    for (const [target, mode] of cases) {
      if (!POSIX) break;
      await chmod(target, mode);
      await assert.rejects(
        () => acquireMutationLock(paths, { timeoutMs: 100, heartbeatMs: 0 }),
        codeIs(LOCK_ERROR_CODES.LOCK_COMPROMISED),
        `${path.basename(target)} at ${mode.toString(8)} is fail-closed`,
      );
      await chmod(target, target === paths.controlDirectory || target === paths.lockDirectory ? 0o700 : 0o600);
    }
    // With correct modes the same lock is acquirable only after the holder is dead.
    await assert.rejects(
      () =>
        acquireMutationLock(paths, {
          timeoutMs: 100,
          heartbeatMs: 0,
          kill: () => {
            const error = new Error("no such process");
            error.code = "ESRCH";
            throw error;
          },
        }),
      codeIs(LOCK_ERROR_CODES.MUTATION_LOCKED),
      "seeded holder pid 987654 with a fresh heartbeat still refuses",
    );
  });
});

test("heartbeat file replacement compromises the held lease before any deletion", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    const lease = await acquireMutationLock(paths, { heartbeatMs: 0 });
    await rm(paths.heartbeatFile, { force: true });
    await writeFile(paths.heartbeatFile, `${Date.now()}\n`, { mode: 0o600 });

    await assert.rejects(() => lease.heartbeat(), codeIs(LOCK_ERROR_CODES.LOCK_COMPROMISED));
    await assert.rejects(() => lease.assertHeld(), codeIs(LOCK_ERROR_CODES.LOCK_COMPROMISED));
    await assert.rejects(() => lease.release(), codeIs(LOCK_ERROR_CODES.LOCK_COMPROMISED));
    assert.equal((await lstat(paths.lockDirectory)).isDirectory(), true, "release never deletes after compromise");
    assert.equal((await lstat(paths.ownerFile)).isFile(), true, "owner metadata survives");
  });
});

test("lock directory replacement compromises the held lease before any deletion", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    const lease = await acquireMutationLock(paths, { heartbeatMs: 0 });
    await rm(paths.lockDirectory, { recursive: true, force: true });
    await mkdir(paths.lockDirectory, { mode: 0o700 });
    const foreignOwner = JSON.stringify(ownerDocument({ token: "cd".repeat(32), pid: 4242 }));
    await writeFile(paths.ownerFile, `${foreignOwner}\n`, { mode: 0o600 });

    await assert.rejects(() => lease.assertHeld(), codeIs(LOCK_ERROR_CODES.LOCK_COMPROMISED));
    await assert.rejects(() => lease.heartbeat(), codeIs(LOCK_ERROR_CODES.LOCK_COMPROMISED));
    await assert.rejects(() => lease.release(), codeIs(LOCK_ERROR_CODES.LOCK_COMPROMISED));
    assert.equal(await readFile(paths.ownerFile, "utf8"), `${foreignOwner}\n`, "replacement content is untouched");
  });
});

test("release refuses after owner metadata is modified without destroying anything", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    const lease = await acquireMutationLock(paths, { heartbeatMs: 0 });
    const original = JSON.parse(await readFile(paths.ownerFile, "utf8"));
    const modified = { ...original, acquiredAt: original.acquiredAt + 1 };
    await writeFile(paths.ownerFile, `${JSON.stringify(modified)}\n`, { mode: 0o600 });

    await assert.rejects(() => lease.release(), codeIs(LOCK_ERROR_CODES.LOCK_COMPROMISED));
    assert.equal((await lstat(paths.lockDirectory)).isDirectory(), true);
    assert.deepEqual(JSON.parse(await readFile(paths.ownerFile, "utf8")), modified, "release leaves the state in place");
    await assert.rejects(() => lease.assertHeld(), codeIs(LOCK_ERROR_CODES.LOCK_COMPROMISED));
  });
});

test("two simultaneous reclaimers produce exactly one winner", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    await seedLock(paths, { document: ownerDocument({ pid: 987654 }), heartbeatAgeMs: 600000 });
    const kill = () => {
      const error = new Error("no such process");
      error.code = "ESRCH";
      throw error;
    };
    const options = { timeoutMs: 400, staleMs: 1000, initGraceMs: 40, heartbeatMs: 0, kill };
    const results = await Promise.allSettled([
      acquireMutationLock(paths, { ...options }),
      acquireMutationLock(paths, { ...options }),
    ]);
    const winners = results.filter((result) => result.status === "fulfilled");
    const losers = results.filter((result) => result.status === "rejected");
    assert.equal(winners.length, 1, "exactly one reclaimer wins");
    assert.equal(losers.length, 1, "the other reclaimer fails closed");
    assert.equal(losers[0].reason.code, LOCK_ERROR_CODES.MUTATION_LOCKED);

    const lease = winners[0].value;
    assert.equal(await lease.assertHeld(), true);
    await lease.release();
    assert.deepEqual(await claimEntries(paths), [], "all claim trees are removed");
    assert.equal((await lstat(paths.controlDirectory)).isDirectory(), true);
  });
});

test("failed setup cleans only the exact lock identity this process created", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    const renameCalls = [];
    const rmCalls = [];
    await withInternals(
      {
        syncFile: async () => {
          const error = new Error("injected fsync failure");
          error.code = "EIO";
          throw error;
        },
      },
      async () => {
        await assert.rejects(
          () =>
            acquireMutationLock(paths, {
              heartbeatMs: 0,
              rename: async (from, to) => {
                renameCalls.push([from, to]);
                return rename(from, to);
              },
              rm: async (target, options) => {
                rmCalls.push(target);
                return rm(target, options);
              },
            }),
          codeIs("EIO"),
        );
      },
    );
    assert.equal(renameCalls.length, 1, "cleanup renames the created lock to a claim");
    assert.equal(renameCalls[0][0], paths.lockDirectory);
    assert.equal(path.basename(renameCalls[0][1]).startsWith(CLAIM_PREFIX), true);
    assert.equal(rmCalls.length, 1, "cleanup deletes exactly the claim it verified");
    assert.equal(path.basename(rmCalls[0]).startsWith(CLAIM_PREFIX), true);
    await assert.rejects(() => lstat(paths.lockDirectory), codeIs("ENOENT"));
    assert.deepEqual(await claimEntries(paths), [], "no claim leftovers");
    assert.equal((await lstat(paths.controlDirectory)).isDirectory(), true, "the control directory survives");
  });
});

test("failed setup preserves a lock directory swapped by someone else", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    const renameCalls = [];
    const rmCalls = [];
    let swapped = false;
    await withInternals(
      {
        syncFile: async () => {
          const error = new Error("injected fsync failure");
          error.code = "EIO";
          throw error;
        },
      },
      async () => {
        await assert.rejects(
          () =>
            acquireMutationLock(paths, {
              heartbeatMs: 0,
              rename: async (from, to) => {
                if (from === paths.lockDirectory && !swapped) {
                  swapped = true;
                  const fsp = await import("node:fs/promises");
                  // Rename the original lock aside instead of deleting it: an
                  // inode allocator with eager reuse (ext4 on the Linux
                  // runner) can give the replacement directory the same
                  // dev/ino the deleted one just freed, making the swap
                  // invisible to the identity recheck.
                  await fsp.rename(paths.lockDirectory, `${paths.lockDirectory}.pinned`);
                  await fsp.mkdir(paths.lockDirectory, { mode: 0o700 });
                  await writeFile(path.join(paths.lockDirectory, "foreign.txt"), "keep-me", { mode: 0o600 });
                }
                renameCalls.push([from, to]);
                return rename(from, to);
              },
              rm: async (target, options) => {
                rmCalls.push(target);
                return rm(target, options);
              },
            }),
          codeIs("EIO"),
        );
      },
    );
    assert.equal(rmCalls.length, 0, "a foreign directory is never deleted");
    assert.equal(renameCalls.length, 1);
    const claimPath = renameCalls[0][1];
    assert.equal(await readFile(path.join(claimPath, "foreign.txt"), "utf8"), "keep-me", "foreign content preserved");
    assert.equal((await lstat(paths.controlDirectory)).isDirectory(), true);
  });
});

test("a crash after claim rename never blocks acquisition and dead claims are cleaned exactly", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    await mkdir(paths.controlDirectory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(paths.controlDirectory, ".keep"), "", { mode: 0o600 });

    const deadClaim = path.join(paths.controlDirectory, `${CLAIM_PREFIX}dead01`);
    const liveClaim = path.join(paths.controlDirectory, `${CLAIM_PREFIX}live01`);
    await seedClaimTree(deadClaim, { heartbeatAgeMs: 600000 });
    await seedClaimTree(liveClaim, { heartbeatAgeMs: 0 });
    await mkdir(path.join(paths.controlDirectory, "mutation.lock.old"));
    await writeFile(path.join(paths.controlDirectory, "unrelated.txt"), "keep", { mode: 0o600 });

    // The explicit helper removes only the verified dead claim, through a
    // rename-and-reverify transition; live and unrelated entries survive.
    const result = await cleanupDeadClaimLeftovers(paths, {
      staleMs: 1000,
      heartbeatMs: 0,
      kill: () => {
        const error = new Error("no such process");
        error.code = "ESRCH";
        throw error;
      },
    });
    assert.deepEqual(result.removed, [deadClaim], "only the verified dead claim is removed");
    assert.equal(result.skipped.some((entry) => entry.path === liveClaim), true, "live claims are kept");
    await assert.rejects(() => lstat(deadClaim), codeIs("ENOENT"));
    assert.equal((await lstat(liveClaim)).isDirectory(), true, "no wildcard deletion");
    assert.equal((await lstat(path.join(paths.controlDirectory, "mutation.lock.old"))).isDirectory(), true);
    assert.equal(await readFile(path.join(paths.controlDirectory, "unrelated.txt"), "utf8"), "keep");

    // The fixed lock path is free, so acquisition succeeds despite leftovers.
    const lease = await acquireMutationLock(paths, { heartbeatMs: 0, timeoutMs: 500 });
    await lease.release();
    assert.equal((await lstat(liveClaim)).isDirectory(), true, "a live claim never blocks or is swept");
    assert.equal(await readFile(path.join(paths.controlDirectory, "unrelated.txt"), "utf8"), "keep");
  });
});

test("production acquisition sweeps verified dead lock claims and preserves foreign ones", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    // The exact crash-after-claim-rename state: no fixed lock, only leftovers
    // from a holder that died between its rename-to-claim and the removal.
    const deadClaim = path.join(paths.controlDirectory, `${CLAIM_PREFIX}killed01`);
    const malformedClaim = path.join(paths.controlDirectory, `${CLAIM_PREFIX}broken01`);
    const liveClaim = path.join(paths.controlDirectory, `${CLAIM_PREFIX}live01`);
    await mkdir(paths.controlDirectory, { recursive: true, mode: 0o700 });
    await seedClaimTree(deadClaim, { heartbeatAgeMs: 600000 });
    await seedClaimTree(liveClaim, { heartbeatAgeMs: 0 });
    await mkdir(malformedClaim, { mode: 0o700 });
    await writeFile(path.join(malformedClaim, "owner.json"), "{not json", { mode: 0o600 });

    const lease = await acquireMutationLock(paths, {
      heartbeatMs: 0,
      timeoutMs: 500,
      staleMs: 1000,
      kill: () => {
        const error = new Error("no such process");
        error.code = "ESRCH";
        throw error;
      },
    });
    assert.equal(await lease.assertHeld(), true, "the sweep never weakens acquisition");
    await assert.rejects(() => lstat(deadClaim), codeIs("ENOENT"), "the verified dead claim is swept");
    assert.equal((await lstat(malformedClaim)).isDirectory(), true, "malformed claims survive");
    assert.equal((await lstat(liveClaim)).isDirectory(), true, "live claims survive");
    await lease.release();

    // The explicit helper agrees: nothing else is removable.
    const again = await cleanupDeadClaimLeftovers(paths, {
      staleMs: 1000,
      heartbeatMs: 0,
      kill: () => {
        const error = new Error("no such process");
        error.code = "ESRCH";
        throw error;
      },
    });
    assert.deepEqual(again.removed, []);
    assert.equal(again.skipped.some((entry) => entry.path === malformedClaim), true);
    assert.equal(again.skipped.some((entry) => entry.path === liveClaim), true);
  });
});

test("two concurrent dead-claim cleaners remove exactly one winner", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    const deadClaim = path.join(paths.controlDirectory, `${CLAIM_PREFIX}race01`);
    await mkdir(paths.controlDirectory, { recursive: true, mode: 0o700 });
    await seedClaimTree(deadClaim, { heartbeatAgeMs: 600000 });
    const kill = () => {
      const error = new Error("no such process");
      error.code = "ESRCH";
      throw error;
    };
    const [first, second] = await Promise.all([
      cleanupDeadClaimLeftovers(paths, { staleMs: 1000, heartbeatMs: 0, kill }),
      cleanupDeadClaimLeftovers(paths, { staleMs: 1000, heartbeatMs: 0, kill }),
    ]);
    assert.equal(first.removed.length + second.removed.length, 1, "exactly one cleaner removes the claim");
    await assert.rejects(() => lstat(deadClaim), codeIs("ENOENT"));
    assert.deepEqual((await readdir(paths.controlDirectory)).sort(), [], "no claim or temp directory remains");
  });
});

test("a dead claim replaced after its cleanup rename is preserved, never deleted", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    const deadClaim = path.join(paths.controlDirectory, `${CLAIM_PREFIX}swap01`);
    await mkdir(paths.controlDirectory, { recursive: true, mode: 0o700 });
    await seedClaimTree(deadClaim, { heartbeatAgeMs: 600000 });

    let swaps = 0;
    const result = await cleanupDeadClaimLeftovers(paths, {
      staleMs: 1000,
      heartbeatMs: 0,
      kill: () => {
        const error = new Error("no such process");
        error.code = "ESRCH";
        throw error;
      },
      rename: async (from, to) => {
        await rename(from, to);
        if (from.includes(CLAIM_PREFIX) && swaps === 0) {
          swaps += 1;
          // Someone replaces the renamed claim before verification.
          await rm(to, { recursive: true, force: true });
          await mkdir(to, { mode: 0o700 });
          await writeFile(path.join(to, "owner.json"), "{replaced}", { mode: 0o600 });
        }
      },
    });
    assert.deepEqual(result.removed, [], "a replaced claim is never removed");
    assert.equal(result.skipped.length, 1, "the replacement is preserved and reported");
    assert.equal(result.skipped[0].path.startsWith(path.join(paths.controlDirectory, CLAIM_PREFIX)), true);
    assert.equal(await readFile(path.join(result.skipped[0].path, "owner.json"), "utf8"), "{replaced}");
    assert.equal(swaps, 1);
  });
});

async function seedClaimTree(claimPath, options) {
  const { heartbeatAgeMs } = options;
  await mkdir(claimPath, { mode: 0o700 });
  await writeFile(path.join(claimPath, "owner.json"), `${JSON.stringify(ownerDocument())}\n`, { mode: 0o600 });
  await writeFile(path.join(claimPath, "heartbeat"), `${String(Date.now() - heartbeatAgeMs)}\n`, { mode: 0o600 });
  if (POSIX) {
    await chmod(claimPath, 0o700);
    await chmod(path.join(claimPath, "owner.json"), 0o600);
    await chmod(path.join(claimPath, "heartbeat"), 0o600);
  }
}

test("acquire retries with jittered backoff until the timeout expires", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    await seedLock(paths, { document: ownerDocument({ pid: process.pid }), heartbeatAgeMs: 0 });
    let attempts = 0;
    const started = Date.now();
    const error = await acquireMutationLock(paths, {
      timeoutMs: 320,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 40,
      heartbeatMs: 0,
      mkdir: async (target, options) => {
        attempts += 1;
        return mkdir(target, options);
      },
    }).then(
      () => null,
      (failure) => failure,
    );
    const elapsed = Date.now() - started;
    assert.ok(error);
    assert.equal(error.code, LOCK_ERROR_CODES.MUTATION_LOCKED);
    assert.ok(elapsed >= 320, `waited for the timeout (${elapsed}ms)`);
    assert.ok(attempts >= 2, `retried instead of failing immediately (${attempts} attempts)`);
    assert.ok(error.message.includes("held by pid"), "the timeout names the safe owner pid");
  });
});

test("global control paths create nested owner-only state and release cleanly", async () => {
  await withTemp(async (root) => {
    const home = path.join(root, "home");
    const paths = controlPaths({ home, global: true });
    assert.equal(paths.controlDirectory, path.join(home, ".local", "share", "skill-router-control"));
    const lease = await acquireMutationLock(paths, { heartbeatMs: 0 });
    assert.equal((await lstat(paths.lockDirectory)).isDirectory(), true);
    if (POSIX) {
      assert.equal((await lstat(paths.controlDirectory)).mode & 0o777, 0o700);
      assert.equal((await lstat(paths.ownerFile)).mode & 0o777, 0o600);
    }
    await lease.release();
    await assert.rejects(() => lstat(paths.lockDirectory), codeIs("ENOENT"));
    assert.equal((await lstat(paths.controlDirectory)).isDirectory(), true);
  });
});

test("an injected heartbeat failure marks the lease compromised", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    const lease = await acquireMutationLock(paths, {
      heartbeatMs: 0,
      heartbeat: async () => {
        throw new Error("injected heartbeat failure");
      },
    });
    await assert.rejects(() => lease.heartbeat(), codeIs(LOCK_ERROR_CODES.LOCK_COMPROMISED));
    await assert.rejects(() => lease.assertHeld(), codeIs(LOCK_ERROR_CODES.LOCK_COMPROMISED));
    await assert.rejects(() => lease.release(), codeIs(LOCK_ERROR_CODES.LOCK_COMPROMISED));
    assert.equal((await lstat(paths.lockDirectory)).isDirectory(), true, "a compromised lease never deletes");
  });
});

test("two child processes contend exclusively for the same lock", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    await withChild(
      { SR_LOCK_TEST_ROOT: root, SR_LOCK_TEST_HOLD_MS: "1500", SR_LOCK_TEST_TIMEOUT_MS: "10000" },
      async (holder) => {
        await waitForLine(holder, "ACQUIRED", 20000);
        await withChild(
          { SR_LOCK_TEST_ROOT: root, SR_LOCK_TEST_HOLD_MS: "0", SR_LOCK_TEST_TIMEOUT_MS: "400" },
          async (contender) => {
            const result = await withTimeout(contender.done, 10000, "contender exit");
            assert.equal(result.code, 3, `contender failed closed: ${contender.stdout}${contender.stderr}`);
            assert.match(contender.stdout, /ERROR MUTATION_LOCKED/);
            assert.equal(contender.stdout.includes("ACQUIRED"), false, "only one process holds the lock");
          },
        );
        const holderResult = await withTimeout(holder.done, 20000, "holder exit");
        assert.equal(holderResult.code, 0, `holder exited cleanly: ${holder.stdout}${holder.stderr}`);
        assert.match(holder.stdout, /RELEASED/);
        assert.equal((holder.stdout.match(/ACQUIRED /g) || []).length, 1);
      },
    );
    await assert.rejects(() => lstat(paths.lockDirectory), codeIs("ENOENT"));
    assert.deepEqual(await claimEntries(paths), []);
  });
});

test("SIGKILL leaves a stale-dead lock that is reclaimed via a real ESRCH probe", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    await withChild(
      {
        SR_LOCK_TEST_ROOT: root,
        SR_LOCK_TEST_NO_RELEASE: "1",
        SR_LOCK_TEST_STAY_ALIVE: "1",
        SR_LOCK_TEST_HEARTBEAT_MS: "0",
        SR_LOCK_TEST_TIMEOUT_MS: "10000",
      },
      async (child) => {
        await waitForLine(child, "ACQUIRED", 20000);
        const match = child.stdout.match(/ACQUIRED ([0-9a-f]{64})/);
        assert.ok(match, `child did not report a token: ${child.stdout}`);
        const staleToken = match[1];
        child.child.kill("SIGKILL");
        const exit = await withTimeout(child.done, 10000, "killed child exit");
        assert.equal(exit.signal, "SIGKILL");
        await sleep(250);

        const lease = await acquireMutationLock(paths, { staleMs: 100, timeoutMs: 5000, heartbeatMs: 0 });
        assert.notEqual(lease.token, staleToken, "the dead holder is replaced");
        assert.equal(await lease.assertHeld(), true);
        await lease.release();
        await assert.rejects(() => lstat(paths.lockDirectory), codeIs("ENOENT"));
        assert.deepEqual(await claimEntries(paths), []);
      },
    );
  });
});

test("the automatic heartbeat timer does not keep an idle holder process alive", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    await withChild(
      {
        SR_LOCK_TEST_ROOT: root,
        SR_LOCK_TEST_NO_RELEASE: "1",
        SR_LOCK_TEST_HEARTBEAT_MS: "40",
        SR_LOCK_TEST_TIMEOUT_MS: "10000",
      },
      async (child) => {
        await waitForLine(child, "ACQUIRED", 20000);
        const exit = await withTimeout(child.done, 6000, "unref heartbeat timer must not block process exit");
        assert.equal(exit.code, 0, `child exited on its own: ${child.stdout}${child.stderr}`);
        assert.equal(exit.signal, null);

        // The holder died without releasing; reclaim is still possible because
        // the stale heartbeat plus a real ESRCH probe authorizes it.
        assert.equal((await lstat(paths.lockDirectory)).isDirectory(), true, "the abandoned lock remains");
        await sleep(250);
        const lease = await acquireMutationLock(paths, { staleMs: 100, timeoutMs: 5000, heartbeatMs: 0 });
        assert.equal(await lease.assertHeld(), true);
        await lease.release();
        assert.deepEqual(await claimEntries(paths), []);
      },
    );
  });
});

test("cleanupDeadClaimLeftovers asserts the lease immediately before each claim rename", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    const deadClaim = path.join(paths.controlDirectory, `${CLAIM_PREFIX}lease01`);
    await mkdir(paths.controlDirectory, { recursive: true, mode: 0o700 });
    await seedClaimTree(deadClaim, { heartbeatAgeMs: 600000 });
    const before = await readdir(deadClaim);

    let calls = 0;
    const broken = {
      paths,
      async assertHeld() {
        calls += 1;
        throw new MutationLockError("LOCK_COMPROMISED", "lease lost", {});
      },
    };
    const result = await cleanupDeadClaimLeftovers(paths, {
      staleMs: 1000,
      heartbeatMs: 0,
      lease: broken,
      kill: () => {
        const error = new Error("no such process");
        error.code = "ESRCH";
        throw error;
      },
    });
    assert.ok(calls >= 1, "the lease was asserted");
    assert.deepEqual(result.removed, [], "a lost lease removes nothing");
    assert.equal(result.skipped.length, 1, "the claim is reported and preserved");
    assert.deepEqual((await readdir(deadClaim)).sort(), [...before].sort(), "the claim is byte-for-byte intact");

    // A valid lease retry completes the verified cleanup.
    const again = await cleanupDeadClaimLeftovers(paths, {
      staleMs: 1000,
      heartbeatMs: 0,
      kill: () => {
        const error = new Error("no such process");
        error.code = "ESRCH";
        throw error;
      },
    });
    assert.deepEqual(again.removed, [deadClaim]);
    await assert.rejects(() => lstat(deadClaim), codeIs("ENOENT"));
  });
});

/* ================================================================== *
 * Phase 14 - strong file identity for lock creation, reclaim, release
 * ================================================================== */

const UNAVAILABLE_IDENTITY = Object.freeze({ status: "unavailable", dev: null, ino: null });

test("a filesystem without stable file identity refuses lock creation before any mkdir", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    let mkdirs = 0;
    const error = await acquireMutationLock(paths, {
      heartbeatMs: 0,
      timeoutMs: 100,
      identityOf: () => UNAVAILABLE_IDENTITY,
      mkdir: async (target, options) => {
        mkdirs += 1;
        return mkdir(target, options);
      },
    }).then(
      () => null,
      (failure) => failure,
    );
    assert.ok(error, "acquisition refused before the filesystem was touched");
    assert.equal(error.code, LOCK_ERROR_CODES.LOCK_COMPROMISED);
    assert.match(error.message, /stable file identity/);
    assert.equal(mkdirs, 0, "neither the control nor the lock directory was created");
    await assert.rejects(() => lstat(paths.controlDirectory), codeIs("ENOENT"));
    await assert.rejects(() => lstat(paths.lockDirectory), codeIs("ENOENT"));
  });
});

test("release never recursively deletes a lock whose identity became unprovable", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    let unavailable = false;
    let removals = 0;
    const lease = await acquireMutationLock(paths, {
      heartbeatMs: 0,
      identityOf: (stat) => (unavailable ? UNAVAILABLE_IDENTITY : fileIdentity(stat)),
      rm: async (target, options) => {
        removals += 1;
        return rm(target, options);
      },
    });

    unavailable = true;
    const error = await lease.release().then(
      () => null,
      (failure) => failure,
    );
    assert.ok(error, "release refused");
    assert.equal(error.code, LOCK_ERROR_CODES.LOCK_COMPROMISED);
    assert.match(error.message, /identity changed/);
    assert.equal(removals, 0, "no recursive deletion ran");
    assert.equal((await lstat(paths.lockDirectory)).isDirectory(), true, "the lock directory is preserved");
    assert.equal((await lstat(paths.ownerFile)).isFile(), true, "the owner metadata is preserved");
  });
});

test("reclamation never recursively deletes a claim whose identity became unprovable", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    await seedLock(paths, { document: ownerDocument({ pid: 987654 }), heartbeatAgeMs: 600000 });
    let unavailable = false;
    let removals = 0;
    const error = await acquireMutationLock(paths, {
      heartbeatMs: 0,
      timeoutMs: 500,
      kill: () => {
        const failure = new Error("no such process");
        failure.code = "ESRCH";
        throw failure;
      },
      identityOf: (stat) => (unavailable ? UNAVAILABLE_IDENTITY : fileIdentity(stat)),
      rm: async (target, options) => {
        removals += 1;
        return rm(target, options);
      },
      // The fsync that follows the claim rename is exactly where this fixture
      // makes the claimed lock's identity unprovable.
      fsync: async (target) => {
        unavailable = true;
        return syncDirectory(target);
      },
    }).then(
      () => null,
      (failure) => failure,
    );
    assert.ok(error, "reclamation refused");
    assert.equal(error.code, LOCK_ERROR_CODES.LOCK_COMPROMISED);
    assert.match(error.message, /identity does not match/);
    assert.equal(removals, 0, "no recursive deletion ran");
    const claims = await claimEntries(paths);
    assert.equal(claims.length, 1, "the unprovable claim is preserved for a later verified cleanup");
    assert.equal((await lstat(paths.controlDirectory)).isDirectory(), true);
  });
});

/* ================================================================== *
 * Phase 14 / B1 - a claim replaced after verification is never
 * recursively deleted
 * ================================================================== */

test("B1: release never recursively deletes a claim replaced after its verification", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    let releaseStarted = false;
    let releaseFsyncs = 0;
    let swappedClaim = null;
    let removals = 0;
    const originalSync = syncDirectory;
    const lease = await acquireMutationLock(paths, {
      heartbeatMs: 0,
      rm: async (target, options) => {
        removals += 1;
        return rm(target, options);
      },
      fsync: async (target) => {
        if (releaseStarted) {
          releaseFsyncs += 1;
          if (releaseFsyncs === 2) {
            // Replace the claim after its first verification and immediately
            // before the recheck that guards the destructive removal. The
            // original claim is renamed aside rather than deleted: an inode
            // allocator with eager reuse (ext4 on the Linux runner) can give
            // the replacement directory the same dev/ino the deleted one just
            // freed, which would make the swap invisible to the identity
            // recheck. Renaming keeps that inode allocated, so the
            // replacement provably differs on every platform.
            const entries = await readdir(paths.controlDirectory);
            const claim = entries.find((name) => name.startsWith(CLAIM_PREFIX));
            assert.ok(claim, "the release renamed the lock to a claim");
            swappedClaim = path.join(paths.controlDirectory, claim);
            await rename(swappedClaim, `${swappedClaim}.pinned`);
            await mkdir(swappedClaim, { recursive: true, mode: 0o700 });
            if (POSIX) await chmod(swappedClaim, 0o700);
            await writeFile(path.join(swappedClaim, "foreign.json"), "{}\n", { mode: 0o600 });
          }
        }
        return originalSync(target);
      },
    });

    releaseStarted = true;
    const error = await lease.release().then(
      () => null,
      (failure) => failure,
    );
    assert.ok(error, "release refused");
    assert.equal(error.code, LOCK_ERROR_CODES.LOCK_COMPROMISED);
    assert.match(error.message, /identity changed/);
    assert.equal(removals, 0, "no recursive deletion ran");
    assert.ok(swappedClaim, "the replacement actually landed at the claim");
    assert.equal(await readFile(path.join(swappedClaim, "foreign.json"), "utf8"), "{}\n", "the replacement survives");
  });
});

test("B1: reclamation never recursively deletes a claim replaced after its verification", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    await seedLock(paths, { document: ownerDocument({ pid: 987654 }), heartbeatAgeMs: 600000 });
    let claimRenamed = false;
    let reclaimFsyncs = 0;
    let swappedClaim = null;
    let removals = 0;
    const originalSync = syncDirectory;
    const originalRename = (from, to) => rename(from, to);
    const error = await acquireMutationLock(paths, {
      heartbeatMs: 0,
      timeoutMs: 500,
      kill: () => {
        const failure = new Error("no such process");
        failure.code = "ESRCH";
        throw failure;
      },
      rm: async (target, options) => {
        removals += 1;
        return rm(target, options);
      },
      rename: async (from, to) => {
        await originalRename(from, to);
        if (path.resolve(from) === path.resolve(paths.lockDirectory)) claimRenamed = true;
      },
      fsync: async (target) => {
        if (claimRenamed) {
          reclaimFsyncs += 1;
          if (reclaimFsyncs === 2) {
            // Replace the claim after its first verification and immediately
            // before the recheck that guards the destructive removal. The
            // original claim is renamed aside rather than deleted: an inode
            // allocator with eager reuse (ext4 on the Linux runner) can give
            // the replacement directory the same dev/ino the deleted one just
            // freed, which would make the swap invisible to the identity
            // recheck. Renaming keeps that inode allocated, so the
            // replacement provably differs on every platform.
            const entries = await readdir(paths.controlDirectory);
            const claim = entries.find((name) => name.startsWith(CLAIM_PREFIX));
            assert.ok(claim, "the reclaimed lock is at its claim path");
            swappedClaim = path.join(paths.controlDirectory, claim);
            await rename(swappedClaim, `${swappedClaim}.pinned`);
            await mkdir(swappedClaim, { recursive: true, mode: 0o700 });
            if (POSIX) await chmod(swappedClaim, 0o700);
            await writeFile(path.join(swappedClaim, "foreign.json"), "{}\n", { mode: 0o600 });
          }
        }
        return originalSync(target);
      },
    }).then(
      () => null,
      (failure) => failure,
    );
    assert.ok(error, "reclamation refused");
    assert.equal(error.code, LOCK_ERROR_CODES.LOCK_COMPROMISED);
    assert.match(error.message, /identity does not match/);
    assert.equal(removals, 0, "no recursive deletion ran");
    assert.ok(swappedClaim, "the replacement actually landed at the claim");
    assert.equal(await readFile(path.join(swappedClaim, "foreign.json"), "utf8"), "{}\n", "the replacement survives");
  });
});

test("B1: dead-claim cleanup never recursively deletes a claim replaced after its verification", async () => {
  await withTemp(async (root) => {
    const paths = controlPaths({ root });
    await mkdir(paths.controlDirectory, { recursive: true, mode: 0o700 });
    const deadClaim = path.join(paths.controlDirectory, `${CLAIM_PREFIX}dead01`);
    await seedClaimTree(deadClaim, { heartbeatAgeMs: 600000 });

    let fsyncs = 0;
    let swappedClaim = null;
    let removals = 0;
    const originalSync = syncDirectory;
    const result = await cleanupDeadClaimLeftovers(paths, {
      staleMs: 1000,
      heartbeatMs: 0,
      kill: () => {
        const error = new Error("no such process");
        error.code = "ESRCH";
        throw error;
      },
      rm: async (target, options) => {
        removals += 1;
        return rm(target, options);
      },
      fsync: async (target) => {
        fsyncs += 1;
        if (fsyncs === 2) {
          // Replace the renamed claim after its first verification and
          // immediately before the recheck that guards the removal.
          const entries = await readdir(paths.controlDirectory);
          const claim = entries.find((name) => name.startsWith(CLAIM_PREFIX));
          assert.ok(claim, "the dead claim was renamed to a fresh claim");
          swappedClaim = path.join(paths.controlDirectory, claim);
          // Pin the original aside rather than deleting it: an inode
          // allocator with eager reuse (ext4 on the Linux runner) can give the
          // replacement directory the same dev/ino the deleted one just freed,
          // which would make the swap invisible to the identity recheck.
          await rename(swappedClaim, `${swappedClaim}.pinned`);
          await mkdir(swappedClaim, { recursive: true, mode: 0o700 });
          if (POSIX) await chmod(swappedClaim, 0o700);
          await writeFile(path.join(swappedClaim, "foreign.json"), "{}\n", { mode: 0o600 });
        }
        return originalSync(target);
      },
    });
    assert.equal(result.removed.length, 0, "nothing was removed");
    assert.ok(result.skipped.some((entry) => entry.path === swappedClaim), "the replacement is reported as skipped");
    assert.equal(removals, 0, "no recursive deletion ran");
    assert.ok(swappedClaim, "the replacement actually landed at the claim");
    assert.equal(await readFile(path.join(swappedClaim, "foreign.json"), "utf8"), "{}\n", "the replacement survives");
  });
});
