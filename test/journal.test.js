import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_MAX_FILE_BYTES, durableFsInternals, sha256Bytes } from "../src/durable-fs.js";
import {
  backupPathFor,
  classifyJournalFile,
  classifyJournalFileEntry,
  cleanupPayloads,
  cleanupPayloadTransients,
  CLAUDE_ACTION_TYPES,
  createJournal,
  FILE_ROLES,
  FILE_STATUSES,
  JOURNAL_COMMANDS,
  JOURNAL_ERROR_CODES,
  JOURNAL_KINDS,
  JOURNAL_MAX_BYTES,
  JOURNAL_MODES,
  JOURNAL_PHASE_ORDER,
  JOURNAL_SCHEMA_VERSION,
  JournalError,
  MAX_CLAUDE_ACTIONS,
  MAX_FILE_RECORDS,
  payloadPathFor,
  payloadTransientPath,
  prepareFilePayloads,
  readJournal,
  readPayload,
  removeJournal,
  serializeJournal,
  stagePathFor,
  updateJournal,
  validateJournal,
} from "../src/journal.js";
import { acquireMutationLock, controlPaths, MutationLockError } from "../src/mutation-lock.js";

const TX = "ab".repeat(32);
const OTHER_TX = "cd".repeat(32);
const DIGEST_OLD = "11".repeat(32);
const DIGEST_NEW = "22".repeat(32);
const NOW = "2026-10-08T10:00:00.000Z";
const SENTINEL = "SENTINEL-body-9f3b-must-not-reach-journal";

async function withTemp(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-journal-"));
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

function projectContext(root) {
  return {
    root,
    paths: controlPaths({ root }),
    stateDirectory: path.join(root, ".skill-router"),
    configTarget: path.join(root, ".skill-router.json"),
    opencodeTarget: path.join(root, "opencode.json"),
  };
}

/** Global-scope layout: control lives under home, project root below home. */
async function globalContext(root) {
  const home = root;
  const projectRoot = path.join(home, "project");
  await mkdir(projectRoot, { recursive: true });
  const paths = controlPaths({ home, global: true });
  await mkdir(paths.controlDirectory, { recursive: true, mode: 0o700 });
  return {
    root: projectRoot,
    home,
    paths,
    stateDirectory: path.join(home, ".skill-router"),
    configTarget: path.join(projectRoot, ".skill-router.json"),
  };
}

function recordFor(target, transactionId, options = {}) {
  const {
    role = "router-config",
    status = "prepared",
    beforeExists = true,
    beforeDigest = DIGEST_OLD,
    afterDigest = DIGEST_NEW,
  } = options;
  return {
    target,
    role,
    status,
    before: beforeExists
      ? { exists: true, sha256: beforeDigest, payloadPath: payloadPathFor(target, transactionId, "before") }
      : { exists: false, sha256: null, payloadPath: null },
    after: { exists: true, sha256: afterDigest, payloadPath: payloadPathFor(target, transactionId, "after") },
  };
}

function managedFixture(context, overrides = {}) {
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    owner: "skill-router",
    transactionId: TX,
    revision: 0,
    kind: "managed",
    command: "add",
    mode: "forward",
    phase: "prepared",
    scope: "project",
    root: context.root,
    controlDirectory: context.paths.controlDirectory,
    stateDirectory: context.stateDirectory,
    createdAt: NOW,
    updatedAt: NOW,
    state: { stage: null, backup: null },
    files: [],
    claude: null,
    ...overrides,
  };
}

function removalFixture(context, overrides = {}) {
  return managedFixture(context, {
    kind: "removal",
    command: "uninstall",
    files: [recordFor(context.opencodeTarget, TX, { role: "opencode-config" })],
    ...overrides,
  });
}

function claudeSection(context, overrides = {}) {
  const marketplace = `skill-router-${"ab".repeat(12)}`;
  const reference = `openagency-skill-router@${marketplace}`;
  const marketplaceRoot = path.join(context.stateDirectory, "claude");
  return {
    reference,
    scope: "local",
    marketplace,
    marketplaceRoot,
    version: "0.1.0",
    prior: "absent",
    desired: "healthy",
    actions: [
      {
        sequence: 1,
        id: `marketplace-add:local:${marketplace}`,
        type: "marketplace-add",
        scope: "local",
        status: "observed",
        marketplace,
        path: marketplaceRoot,
        outcome: { status: "succeeded" },
      },
      {
        sequence: 2,
        id: `plugin-install:local:${reference}`,
        type: "plugin-install",
        scope: "local",
        status: "observed",
        reference,
        marketplace,
        version: "0.1.0",
        outcome: { status: "succeeded" },
      },
    ],
    ...overrides,
  };
}

function expectCode(run, code, pattern) {
  let error = null;
  let pending = null;
  let returned;
  try {
    const result = run();
    if (result && typeof result.then === "function") pending = result;
    else returned = result;
  } catch (failure) {
    error = failure;
  }
  // Sync callbacks may hand back the document to validate instead of calling
  // validateJournal themselves.
  if (!error && !pending) {
    try {
      validateJournal(returned);
    } catch (failure) {
      error = failure;
    }
  }
  const check = (failure) => {
    assert.ok(failure, `expected ${code} but the call succeeded`);
    assert.equal(failure.code, code, `${failure.code}: ${failure.message}`);
    if (pattern) assert.match(failure.message, pattern);
  };
  if (error) {
    check(error);
    return undefined;
  }
  if (pending) {
    return pending.then(
      () => assert.fail(`expected ${code} but the call resolved`),
      check,
    );
  }
  return assert.fail(`expected ${code} but the call returned a valid journal`);
}

const expectInvalid = (run, pattern) => expectCode(run, JOURNAL_ERROR_CODES.JOURNAL_INVALID, pattern);
const expectConflict = (run, pattern) => expectCode(run, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT, pattern);

async function expectTypeError(run) {
  let error = null;
  try {
    const result = run();
    if (result && typeof result.then === "function") await result;
  } catch (failure) {
    error = failure;
  }
  assert.ok(error, "expected a TypeError");
  assert.ok(error instanceof TypeError, `expected TypeError, got ${error.name}: ${error.message}`);
}

function fakeLease({ failAt = [], paths = null } = {}) {
  const state = { calls: 0 };
  return {
    state,
    paths,
    async assertHeld() {
      state.calls += 1;
      if (failAt.includes(state.calls)) {
        throw new MutationLockError(JOURNAL_ERROR_CODES.JOURNAL_INVALID === "x" ? "x" : "LOCK_COMPROMISED", "lease lost", {});
      }
    },
  };
}

/** Counts every assertion; optionally breaks at exactly one position. */
function countingLease({ failAt = null, paths = null } = {}) {
  const state = { calls: 0 };
  return {
    state,
    paths,
    async assertHeld() {
      state.calls += 1;
      if (failAt !== null && state.calls === failAt) {
        throw new MutationLockError("LOCK_COMPROMISED", "lease lost", {});
      }
      return true;
    },
  };
}

async function seedJournal(context, document) {
  await mkdir(context.paths.controlDirectory, { recursive: true, mode: 0o700 });
  const created = await createJournal(context.paths, document, { lease: fakeLease() });
  return created;
}

/* ================================================================== *
 * Schema validation coverage
 * ================================================================== */

test("journal schema rejects non-objects, unknown keys, and prototype tricks", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const base = () => managedFixture(context);

    expectInvalid(() => null, /plain object/);
    expectInvalid(() => [], /plain object/);
    expectInvalid(() => "journal", /plain object/);
    expectInvalid(() => 7, /plain object/);

    expectInvalid(() => ({ ...base(), extra: 1 }), /unknown key: extra/);
    for (const key of ["body", "request", "env", "argv", "output", "secret"]) {
      expectInvalid(() => ({ ...base(), [key]: "x" }), /unknown key/);
    }
    expectInvalid(() => {
      const document = base();
      delete document.owner;
      return document;
    }, /missing required key: owner/);

    // Own "__proto__" key from parsed JSON is rejected by the closed schema.
    const raw = `${JSON.stringify(base()).slice(0, -1)},"__proto__":{"polluted":true}}`;
    const parsed = JSON.parse(raw);
    assert.deepEqual(Object.keys(parsed).includes("__proto__"), true, "fixture premise");
    expectInvalid(() => parsed, /unknown key/);
    assert.equal({}.polluted, undefined, "no prototype pollution");

    const withConstructor = { ...base(), constructor: {} };
    expectInvalid(() => withConstructor, /unknown key/);

    const inherited = Object.assign(Object.create({ inheritedField: 1 }), base());
    expectInvalid(() => inherited, /plain object/);

    const classInstance = Object.assign(new (class JournalDocument {})(), base());
    expectInvalid(() => classInstance, /plain object/);
  });
});

test("journal schema rejects bad identity, version, revision, kind, command, mode, scope, and phase", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const base = () => managedFixture(context);

    expectInvalid(() => ({ ...base(), schemaVersion: 0 }), /schemaVersion must be 1/);
    expectInvalid(() => ({ ...base(), schemaVersion: 2 }), /schemaVersion must be 1/);
    expectInvalid(() => ({ ...base(), schemaVersion: "1" }), /schemaVersion must be 1/);
    expectInvalid(() => ({ ...base(), owner: "skill-router-cli" }), /owner must be "skill-router"/);

    expectInvalid(() => ({ ...base(), transactionId: "ab".repeat(31) }), /transactionId/);
    expectInvalid(() => ({ ...base(), transactionId: "AB".repeat(32) }), /transactionId/);
    expectInvalid(() => ({ ...base(), transactionId: "zz".repeat(32) }), /transactionId/);
    expectInvalid(() => ({ ...base(), transactionId: 42 }), /transactionId/);

    expectInvalid(() => ({ ...base(), revision: -1 }), /revision/);
    expectInvalid(() => ({ ...base(), revision: 1.5 }), /revision/);
    expectInvalid(() => ({ ...base(), revision: "0" }), /revision/);
    expectInvalid(() => ({ ...base(), revision: 1e15 }), /revision/);

    expectInvalid(() => ({ ...base(), kind: "other" }), /kind must be managed or removal/);
    expectInvalid(() => ({ ...base(), command: "delete" }), /command is not supported/);
    expectInvalid(() => ({ ...base(), command: "uninstall" }), /not valid for a managed transaction/);
    expectInvalid(() => ({ ...base(), kind: "removal" }), /not valid for a removal transaction/);
    expectInvalid(() => removalFixture(context, { command: "init" }), /not valid for a removal transaction/);
    expectInvalid(() => ({ ...base(), mode: "sideways" }), /mode must be forward, rollback, or committed/);
    expectInvalid(() => ({ ...base(), scope: "team" }), /scope must be project or global/);

    expectInvalid(() => ({ ...base(), phase: "doing-stuff" }), /phase is not valid for a managed transaction/);
    expectInvalid(() => removalFixture(context, { phase: "applying" }), /phase is not valid for a removal transaction/);
    expectInvalid(() => managedFixture(context, { phase: "detaching" }), /phase is not valid for a managed transaction/);
    expectInvalid(() => ({ ...base(), phase: "committed", mode: "forward" }), /phase committed requires mode committed/);
    expectInvalid(() => ({ ...base(), mode: "committed" }), /mode committed requires phase committed/);
    expectInvalid(() => ({ ...base(), phase: "rolled-back", mode: "forward" }), /phase rolled-back requires mode rollback/);
    expectInvalid(() => ({ ...base(), mode: "committed", phase: "proven" }), /mode committed requires phase committed/);

    for (const kind of JOURNAL_KINDS) {
      for (const command of JOURNAL_COMMANDS) {
        const document = managedFixture(context, { kind, command });
        const legal = (kind === "managed" && command !== "uninstall") || (kind === "removal" && command === "uninstall");
        if (legal) validateJournal(document);
        else expectInvalid(() => document, /not valid for/);
      }
    }
    for (const mode of JOURNAL_MODES) {
      if (mode === "forward") validateJournal(managedFixture(context, { mode }));
    }
  });
});

test("journal schema rejects malformed, unnormalized, wildcard, and overlapping paths", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const base = () => managedFixture(context);

    for (const [label, bad] of [
      ["relative", "relative/path"],
      ["unnormalized", `${root}/sub/../x.json`],
      ["trailing slash", `${root}/`],
      ["wildcard", `${root}/*/config.json`],
      ["control character", `${root}/config${String.fromCharCode(7)}.json`],
      ["non-string", 42],
      ["too long", `/${"a".repeat(5000)}`],
      ["empty", ""],
    ]) {
      expectInvalid(() => ({ ...base(), root: bad }), /root must/, `${label}`);
      expectInvalid(() => ({ ...base(), stateDirectory: bad }), /stateDirectory must/, `${label}`);
    }

    expectInvalid(
      () => ({ ...base(), controlDirectory: path.join(root, "elsewhere-control") }),
      /controlDirectory must be <root>\/.skill-router-control/,
    );
    expectInvalid(
      () => ({ ...base(), controlDirectory: `${context.paths.controlDirectory}/` }),
      /controlDirectory must/,
    );
    expectInvalid(() => ({ ...base(), stateDirectory: context.paths.controlDirectory }), /disjoint/);
    expectInvalid(() => ({ ...base(), stateDirectory: path.join(context.paths.controlDirectory, "inside") }), /disjoint/);
    expectInvalid(() => ({ ...base(), stateDirectory: context.root }), /disjoint/);
    expectInvalid(
      () => ({ ...base(), controlDirectory: path.join(context.stateDirectory, "inside") }),
      /controlDirectory must be <root>\/.skill-router-control/,
    );

    const global = await globalContext(await mkdtemp(path.join(os.tmpdir(), "journal-global-")));
    try {
      validateJournal(managedFixture({ ...global, paths: global.paths }, { scope: "global" }));
      expectInvalid(
        () =>
          managedFixture({ ...global, paths: global.paths }, {
            scope: "global",
            controlDirectory: path.join(global.root, ".skill-router-control"),
          }),
        /must not use the project control layout/,
      );
    } finally {
      await rm(global.home, { recursive: true, force: true });
    }
  });
});

test("journal schema rejects bad timestamps and accepts canonical ISO pairs", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const base = () => managedFixture(context);
    expectInvalid(() => ({ ...base(), createdAt: "2026-10-08 10:00:00" }), /createdAt/);
    expectInvalid(() => ({ ...base(), updatedAt: "2026-10-08T10:00:00Z" }), /updatedAt/);
    expectInvalid(() => ({ ...base(), createdAt: 1759956000000 }), /createdAt/);
    expectInvalid(() => ({ ...base(), updatedAt: "2026-10-08T09:00:00.000Z" }), /updatedAt must not precede/);
    validateJournal({ ...base(), updatedAt: "2026-10-08T10:00:00.001Z" });
  });
});

test("journal schema validates transaction-derived state artifacts exactly", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const base = () => managedFixture(context);
    const stagePath = stagePathFor(context.stateDirectory, TX);
    const backupPath = backupPathFor(context.stateDirectory, TX);

    const valid = {
      stage: { path: stagePath, identity: { dev: 1, ino: 2 }, marker: "skill-router-state-v1", digest: DIGEST_OLD },
      backup: null,
    };
    validateJournal({ ...base(), state: { stage: null, backup: null } });
    validateJournal({ ...base(), state: valid });
    validateJournal({
      ...base(),
      state: {
        stage: null,
        backup: { path: backupPath, identity: null, marker: null, digest: null },
      },
    });

    expectInvalid(() => ({ ...base(), state: "no" }), /state must be a plain object/);
    expectInvalid(() => ({ ...base(), state: { stage: null } }), /missing required key: backup/);
    expectInvalid(() => ({ ...base(), state: { stage: null, backup: null, extra: 1 } }), /unknown key: extra/);

    expectInvalid(
      () => ({ ...base(), state: { stage: { ...valid.stage, path: `${stagePath}-extra` }, backup: null } }),
      /transaction-derived sibling/,
    );
    expectInvalid(
      () => ({ ...base(), state: { stage: { ...valid.stage, path: backupPath }, backup: null } }),
      /transaction-derived sibling/,
    );
    expectInvalid(
      () => ({ ...base(), state: { stage: { ...valid.stage, path: `${stagePath}/` }, backup: null } }),
      /normalized absolute path/,
    );
    expectInvalid(
      () => ({ ...base(), state: { stage: { path: stagePath, identity: { dev: 1, ino: -2 }, marker: null, digest: null }, backup: null } }),
      /identity.ino/,
    );
    expectInvalid(
      () => ({ ...base(), state: { stage: { path: stagePath, identity: { dev: 1 }, marker: null, digest: null }, backup: null } }),
      /missing required key: ino/,
    );
    expectInvalid(
      () => ({
        ...base(),
        state: { stage: { path: stagePath, identity: { dev: 1, ino: 2, uuid: "x" }, marker: null, digest: null }, backup: null },
      }),
      /unknown key: uuid/,
    );
    expectInvalid(
      () => ({ ...base(), state: { stage: { path: stagePath, identity: null, marker: "bad marker!", digest: null }, backup: null } }),
      /marker/,
    );
    expectInvalid(
      () => ({ ...base(), state: { stage: { path: stagePath, identity: null, marker: null, digest: "not-a-digest" }, backup: null } }),
      /digest/,
    );
    expectInvalid(
      () => ({ ...base(), state: { stage: { path: stagePath, identity: null, marker: null }, backup: null } }),
      /missing required key: digest/,
    );
  });
});

test("journal file records enforce roles, statuses, uniqueness, and exact payloads", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const base = () => managedFixture(context);

    validateJournal({
      ...base(),
      files: [recordFor(context.configTarget, TX)],
    });
    validateJournal({
      ...base(),
      files: [recordFor(context.configTarget, TX), recordFor(context.opencodeTarget, TX, { role: "opencode-config" })],
    });
    validateJournal({ ...base(), files: [recordFor(context.configTarget, TX, { beforeExists: false })] });

    expectInvalid(() => ({ ...base(), files: "none" }), /files must be an array/);
    expectInvalid(() => ({ ...base(), files: [recordFor(context.configTarget, TX), recordFor(context.configTarget, TX, { role: "opencode-config" })] }), /file targets must be unique/);
    expectInvalid(() => ({ ...base(), files: [recordFor(context.configTarget, TX, { role: "claude-config" })] }), /role is not a supported role/);
    expectInvalid(() => removalFixture(context, { files: [recordFor(context.configTarget, TX)] }), /not allowed for a removal transaction/);
    expectInvalid(() => ({ ...base(), files: [recordFor(context.configTarget, TX, { status: "finished" })] }), /status is not a supported status/);

    const many = [];
    for (let index = 0; index <= MAX_FILE_RECORDS; index += 1) {
      many.push(recordFor(path.join(root, `file-${index}.json`), TX, { role: FILE_ROLES[index % 2] }));
    }
    expectInvalid(() => ({ ...base(), files: many }), /at most 32 records/);

    for (const [label, badTarget] of [
      ["relative", "config.json"],
      ["unnormalized", `${root}/a/../config.json`],
      ["wildcard", `${root}/cfg*.json`],
      ["state overlap", context.stateDirectory],
      ["inside state", path.join(context.stateDirectory, "config.json")],
      ["inside control", path.join(context.paths.controlDirectory, "config.json")],
      ["control ancestor", context.root],
    ]) {
      expectInvalid(() => ({ ...base(), files: [recordFor(badTarget, TX)] }), /file target/, label);
    }

    const good = recordFor(context.configTarget, TX);
    expectInvalid(() => ({ ...base(), files: [{ ...good, target: 5 }] }), /file target must be/);
    expectInvalid(() => ({ ...base(), files: [{ ...good, role: 5 }] }), /file role/);
    expectInvalid(() => ({ ...base(), files: [{ ...good, extra: 1 }] }), /unknown key: extra/);
    expectInvalid(() => ({ ...base(), files: [{ ...good, status: undefined }] }), /status is not a supported status/);

    const beforeCases = [
      ["missing payloadPath", { ...good.before, payloadPath: undefined }, /payloadPath must be an exact payload path/],
      ["non-boolean exists", { ...good.before, exists: "yes" }, /exists must be a boolean/],
      ["null digest while exists", { ...good.before, sha256: null }, /sha256 must be a lowercase/],
      ["wrong payload name", { ...good.before, payloadPath: `${path.dirname(context.configTarget)}/.other.json.skill-router-${TX}.before` }, /exact transaction-derived payload/],
      ["wrong transaction", { ...good.before, payloadPath: payloadPathFor(context.configTarget, OTHER_TX, "before") }, /exact transaction-derived payload/],
      ["wrong directory", { ...good.before, payloadPath: path.join(root, "nested", `.${path.basename(context.configTarget)}.skill-router-${TX}.before`) }, /exact transaction-derived payload/],
      ["absent keeps digest", { exists: false, sha256: DIGEST_OLD, payloadPath: null }, /must be null when the file is absent/],
      ["absent keeps payload", { exists: false, sha256: null, payloadPath: good.before.payloadPath }, /payloadPath must be null/],
      ["extra key", { ...good.before, raw: "bytes" }, /unknown key: raw/],
      ["bad digest", { ...good.before, sha256: "ABC" }, /sha256 must be a lowercase/],
    ];
    for (const [label, before, pattern] of beforeCases) {
      expectInvalid(() => ({ ...base(), files: [{ ...good, before }] }), pattern, label);
    }

    const afterCases = [
      ["exists false", { ...good.after, exists: false }, /exists must be true/],
      ["null digest", { ...good.after, sha256: null }, /sha256 must be a lowercase/],
      ["null payload", { ...good.after, payloadPath: null }, /requires an exact payload path/],
      ["suffix typo", { ...good.after, payloadPath: good.after.payloadPath.replace(".after", ".post") }, /must be an exact payload path/],
      ["missing dot prefix", { ...good.after, payloadPath: good.after.payloadPath.replace("/.", "/") }, /payload name must be derived/],
      ["uppercase transaction", { ...good.after, payloadPath: payloadPathFor(context.configTarget, TX.toUpperCase(), "after") }, /must be an exact payload path/],
      ["missing key", { exists: true, sha256: DIGEST_NEW }, /requires an exact payload path/],
    ];
    for (const [label, after, pattern] of afterCases) {
      expectInvalid(() => ({ ...base(), files: [{ ...good, after }] }), pattern, label);
    }

    // A payload path may not collide with another record's target.
    const colliding = recordFor(context.configTarget, TX);
    const second = recordFor(colliding.after.payloadPath, TX, { role: "opencode-config" });
    expectInvalid(() => ({ ...base(), files: [colliding, second] }), /payload path must not collide/);

    for (const role of FILE_ROLES) validateJournal({ ...base(), files: [recordFor(context.configTarget, TX, { role })] });
    for (const status of FILE_STATUSES) {
      validateJournal({ ...base(), files: [recordFor(context.configTarget, TX, { status })] });
    }
  });
});

test("journal claude section enforces identity, scope, intent, and action shape", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const base = () => managedFixture(context);
    const claude = (overrides = {}) => claudeSection(context, overrides);

    validateJournal({ ...base(), claude: claude() });
    validateJournal({ ...base(), claude: null });
    validateJournal(removalFixture(context, { claude: claudeSection(context, { prior: "healthy", desired: "absent" }) }));

    expectInvalid(() => ({ ...base(), claude: "yes" }), /claude must be a plain object/);
    expectInvalid(() => ({ ...base(), claude: [] }), /claude must be a plain object/);
    expectInvalid(() => ({ ...base(), claude: { ...claude(), extra: 1 } }), /unknown key: extra/);
    expectInvalid(() => {
      const section = claude();
      delete section.version;
      return { ...base(), claude: section };
    }, /missing required key: version/);

    expectInvalid(() => ({ ...base(), claude: claude({ scope: "user" }) }), /claude.scope must be local for a project journal/);
    expectInvalid(() => ({ ...base(), claude: claude({ scope: "team" }) }), /claude.scope is not supported/);
    expectInvalid(() => ({ ...base(), claude: claude({ marketplace: "bad name!" }) }), /claude.marketplace/);
    expectInvalid(() => ({ ...base(), claude: claude({ reference: "plugin-without-marketplace" }) }), /claude.reference/);
    expectInvalid(() => ({ ...base(), claude: claude({ reference: "other-plugin@other-market" }) }), /must end with @claude.marketplace/);
    expectInvalid(() => ({ ...base(), claude: claude({ marketplaceRoot: "relative/claude" }) }), /marketplaceRoot must be/);
    expectInvalid(() => ({ ...base(), claude: claude({ marketplaceRoot: context.stateDirectory }) }), /strictly inside the state directory/);
    expectInvalid(() => ({ ...base(), claude: claude({ marketplaceRoot: path.join(context.root, "claude") }) }), /strictly inside the state directory/);
    expectInvalid(() => ({ ...base(), claude: claude({ version: "1.0" }) }), /claude.version/);
    expectInvalid(() => ({ ...base(), claude: claude({ version: "v1.0.0" }) }), /claude.version/);
    expectInvalid(() => ({ ...base(), claude: claude({ prior: "stale" }) }), /claude.prior/);
    expectInvalid(() => ({ ...base(), claude: claude({ desired: "maybe" }) }), /claude.desired/);
    expectInvalid(() => ({ ...base(), claude: claude({ desired: "absent" }) }), /managed transaction requires claude.desired healthy/);
    expectInvalid(
      () => removalFixture(context, { claude: claudeSection(context, { prior: "healthy", desired: "healthy" }) }),
      /removal transaction requires claude.desired absent/,
    );
    expectInvalid(
      () => removalFixture(context, { claude: claudeSection(context, { prior: "absent", desired: "absent" }) }),
      /cannot both be absent/,
    );
    expectInvalid(() => ({ ...base(), claude: claude({ prior: "absent", desired: "absent" }) }), /requires claude.desired healthy/);

    expectInvalid(() => ({ ...base(), claude: claude({ actions: "none" }) }), /claude.actions must be an array/);
    const tooManyActions = Array.from({ length: MAX_CLAUDE_ACTIONS + 1 }, (_, index) => ({
      sequence: index + 1,
      id: `plugin-install:local:x@y`,
      type: "plugin-install",
      scope: "local",
      status: "intent",
      reference: claude().reference,
    }));
    expectInvalid(() => ({ ...base(), claude: claude({ actions: tooManyActions }) }), /at most 32 entries/);

    const section = claude();
    const [marketplaceAction, installAction] = section.actions;

    const dropKey = (object, key) => {
      const copy = { ...object };
      delete copy[key];
      return copy;
    };
    expectInvalid(
      () => ({ ...base(), claude: claude({ actions: [dropKey(installAction, "reference")] }) }),
      /missing required key: reference/,
    );
    expectInvalid(
      () => ({ ...base(), claude: claude({ actions: [dropKey(marketplaceAction, "path")] }) }),
      /missing required key: path/,
    );
    expectInvalid(
      () => ({ ...base(), claude: claude({ actions: [dropKey(installAction, "sequence")] }) }),
      /missing required key: sequence/,
    );
    expectInvalid(() => ({ ...base(), claude: claude({ actions: [{ ...marketplaceAction, version: "0.1.0" }] }) }), /unknown key: version/);
    expectInvalid(() => ({ ...base(), claude: claude({ actions: [{ ...installAction, path: "/tmp/x" }] }) }), /unknown key: path/);
    expectInvalid(() => ({ ...base(), claude: claude({ actions: [{ ...installAction, type: "plugin-delete" }] }) }), /type is not supported/);
    expectInvalid(() => ({ ...base(), claude: claude({ actions: [{ ...installAction, status: "running" }] }) }), /status is not supported/);
    expectInvalid(() => ({ ...base(), claude: claude({ actions: [{ ...installAction, sequence: 0 }] }) }), /positive integer/);
    expectInvalid(() => ({ ...base(), claude: claude({ actions: [{ ...installAction, sequence: 1.5 }] }) }), /positive integer/);
    expectInvalid(() => ({ ...base(), claude: claude({ actions: [{ ...installAction, sequence: "2" }] }) }), /positive integer/);
    expectInvalid(
      () => ({ ...base(), claude: claude({ actions: [{ ...installAction, sequence: 1 }, { ...marketplaceAction, sequence: 1 }] }) }),
      /strictly increasing/,
    );
    expectInvalid(
      () => ({ ...base(), claude: claude({ actions: [{ ...marketplaceAction, sequence: 1 }, { ...installAction, sequence: 1 }] }) }),
      /strictly increasing/,
    );
    expectInvalid(() => ({ ...base(), claude: claude({ actions: [{ ...installAction, id: "plugin-install:local:wrong@id" }] }) }), /derived as type:scope:target/);
    expectInvalid(() => ({ ...base(), claude: claude({ actions: [{ ...installAction, id: 5 }] }) }), /action id/);
    expectInvalid(() => ({ ...base(), claude: claude({ actions: [{ ...installAction, scope: "user" }] }) }), /scope must match claude.scope/);
    expectInvalid(() => ({ ...base(), claude: claude({ actions: [{ ...installAction, reference: "other@other-market" }] }) }), /reference must match/);
    expectInvalid(() => ({ ...base(), claude: claude({ actions: [{ ...installAction, marketplace: "other-market" }] }) }), /marketplace must match/);
    expectInvalid(() => ({ ...base(), claude: claude({ actions: [{ ...marketplaceAction, path: path.join(context.stateDirectory, "elsewhere") }] }) }), /path must match claude.marketplaceRoot/);
    expectInvalid(() => ({ ...base(), claude: claude({ actions: [{ ...installAction, version: "not-semver" }] }) }), /action version/);
    expectInvalid(() => ({ ...base(), claude: claude({ actions: [{ ...installAction, priorVersion: "1.0" }] }) }), /priorVersion/);
    expectInvalid(() => ({ ...base(), claude: claude({ actions: [{ ...installAction, sequence: 3, status: "intent", outcome: { status: "succeeded" } }] }) }), /outcome requires status observed/);
    expectInvalid(
      () => ({ ...base(), claude: claude({ actions: [{ ...installAction, outcome: { status: "unknown" } }] }) }),
      /outcome.status/,
    );
    expectInvalid(
      () => ({ ...base(), claude: claude({ actions: [{ ...installAction, outcome: { status: "failed", raw: "output" } }] }) }),
      /outcome has unknown key: raw/,
    );
    expectInvalid(
      () => ({ ...base(), claude: claude({ actions: [{ ...installAction, outcome: { status: "failed", errorCode: "bad code!" } }] }) }),
      /errorCode/,
    );
    expectInvalid(
      () => ({ ...base(), claude: claude({ actions: [{ ...installAction, outcome: { status: "failed", message: `line1${String.fromCharCode(10)}line2` } }] }) }),
      /control characters/,
    );
    expectInvalid(
      () => ({ ...base(), claude: claude({ actions: [{ ...installAction, outcome: { status: "failed", message: "x".repeat(401) } }] }) }),
      /message must be a string/,
    );
    expectInvalid(
      () => ({ ...base(), claude: claude({ actions: [{ ...installAction, outcome: { status: "failed", errorCode: "x".repeat(65) } }] }) }),
      /errorCode/,
    );

    for (const type of CLAUDE_ACTION_TYPES) assert.ok(CLAUDE_ACTION_TYPES.includes(type));
    const observed = claude({ actions: [{ ...installAction, outcome: { status: "failed", errorCode: "CLAUDE_FAILED", message: "install refused" } }] });
    const validated = validateJournal({ ...base(), claude: observed });
    assert.equal(validated.claude.actions[0].outcome.status, "failed");
    assert.ok(Object.isFrozen(validated.claude.actions[0].outcome));
  });
});

/* ================================================================== *
 * Normalization, binding, serialization
 * ================================================================== */

test("validateJournal deeply freezes its result without mutating the input", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const document = managedFixture(context, {
      files: [recordFor(context.configTarget, TX)],
      state: {
        stage: { path: stagePathFor(context.stateDirectory, TX), identity: null, marker: null, digest: null },
        backup: null,
      },
      claude: claudeSection(context),
    });
    const validated = validateJournal(document);
    assert.ok(Object.isFrozen(validated));
    assert.ok(Object.isFrozen(validated.files));
    assert.ok(Object.isFrozen(validated.files[0]));
    assert.ok(Object.isFrozen(validated.files[0].before));
    assert.ok(Object.isFrozen(validated.state));
    assert.ok(Object.isFrozen(validated.state.stage));
    assert.ok(Object.isFrozen(validated.claude));
    assert.ok(Object.isFrozen(validated.claude.actions));
    assert.ok(Object.isFrozen(validated.claude.actions[0]));
    assert.throws(() => {
      validated.phase = "intent";
    }, TypeError);
    assert.throws(() => {
      validated.files.push({});
    }, TypeError);
    assert.throws(() => {
      validated.claude.actions[0].status = "intent";
    }, TypeError);

    assert.equal(Object.isFrozen(document), false, "the caller's input is untouched");
    document.phase = "intent";
    assert.equal(validated.phase, "prepared", "the validated copy is independent");
  });
});

test("serializeJournal is deterministic and round-trips through validation", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const document = managedFixture(context, {
      files: [recordFor(context.configTarget, TX)],
      claude: claudeSection(context),
    });
    const first = serializeJournal(document);
    const second = serializeJournal(document);
    assert.ok(first.equals(second), "serialization is byte-stable");
    assert.equal(first.toString("utf8").endsWith("\n"), true, "newline terminated");
    const reparsed = validateJournal(JSON.parse(first.toString("utf8")));
    assert.ok(serializeJournal(reparsed).equals(first), "parse/serialize round-trips");
    const reordered = JSON.parse(first.toString("utf8"));
    const shuffled = {};
    for (const key of Object.keys(reordered).reverse()) shuffled[key] = reordered[key];
    assert.ok(serializeJournal(shuffled).equals(first), "key order cannot change the bytes");
  });
});

test("expected bindings tie reads to the caller control context", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    await seedJournal(context, managedFixture(context));

    const read = await readJournal(context.paths, {
      root: context.root,
      scope: "project",
      transactionId: TX,
      controlDirectory: context.paths.controlDirectory,
      stateDirectory: context.stateDirectory,
    });
    assert.equal(read.transactionId, TX);

    await expectInvalid(() => readJournal(context.paths, { root: path.join(root, "other") }), /expected root/);
    await expectInvalid(() => readJournal(context.paths, { scope: "global" }), /expected scope/);
    await expectInvalid(() => readJournal(context.paths, { transactionId: OTHER_TX }), /expected transaction/);
    await expectInvalid(
      () => readJournal(context.paths, { controlDirectory: path.join(root, "elsewhere") }),
      /expected control directory/,
    );
    await expectInvalid(
      () => readJournal(context.paths, { stateDirectory: path.join(root, "other-state") }),
      /expected state directory/,
    );
    await expectTypeError(() => readJournal(context.paths, { unknownBinding: 1 }));
    await expectTypeError(() => readJournal(context.paths, { allowMissing: "yes" }));
    await expectTypeError(() => validateJournal(managedFixture(context), { bogusBinding: 1 }));

    const global = await globalContext(await mkdtemp(path.join(os.tmpdir(), "journal-global-")));
    try {
      const normalized = validateJournal(managedFixture(global, { scope: "global" }));
      assert.equal(normalized.scope, "global");
      assert.equal(normalized.controlDirectory, global.paths.controlDirectory);
      assert.equal(normalized.root, global.root);
      await seedJournal(global, managedFixture(global, { scope: "global" }));
      const globalRead = await readJournal(global.paths, {
        scope: "global",
        controlDirectory: global.paths.controlDirectory,
      });
      assert.equal(globalRead.scope, "global");
      assert.equal(globalRead.controlDirectory.startsWith(global.home), true);
    } finally {
      await rm(global.home, { recursive: true, force: true });
    }
  });
});

/* ================================================================== *
 * createJournal
 * ================================================================== */

async function freshJournal(context, overrides = {}) {
  return seedJournal(context, managedFixture(context, overrides));
}

function err(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function payloadFilesIn(directory) {
  return readdir(directory).then((entries) => entries.filter((name) => name.includes(".skill-router-")));
}

test("createJournal exclusively creates a verified durable journal", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    await mkdir(context.paths.controlDirectory, { recursive: true, mode: 0o700 });
    const document = managedFixture(context, { files: [recordFor(context.configTarget, TX)] });
    const created = await createJournal(context.paths, document, { lease: fakeLease() });
    assert.ok(Object.isFrozen(created));
    const raw = await readFile(context.paths.journalFile, "utf8");
    assert.equal(raw, serializeJournal(document).toString("utf8"), "exact canonical bytes on disk");
    assert.equal(JSON.parse(raw).revision, 0);
    if (process.platform !== "win32") {
      assert.equal((await lstat(context.paths.journalFile)).mode & 0o777, 0o600);
    }
    const reread = await readJournal(context.paths);
    assert.deepEqual(reread.files[0].after, created.files[0].after);

    // Revision/phase/mode constraints on creation need fresh control dirs
    // because the live journal already occupies this one.
    const constrained = [
      [{ revision: 1 }, /revision 0/],
      [{ phase: "intent" }, /phase prepared/],
      [{ mode: "rollback" }, /mode forward/],
    ];
    for (const [overrides, pattern] of constrained) {
      const fresh = projectContext(path.join(root, `constrained-${overrides.phase ?? overrides.mode ?? "rev"}`));
      await mkdir(fresh.paths.controlDirectory, { recursive: true, mode: 0o700 });
      await expectInvalid(() => createJournal(fresh.paths, managedFixture(fresh, overrides), { lease: fakeLease() }), pattern);
      await assert.rejects(() => lstat(fresh.paths.journalFile), (error) => error.code === "ENOENT", "a failed create leaves nothing behind");
    }
  });
});

test("createJournal never overwrites an existing journal or foreign entry", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    await freshJournal(context);
    const before = await readFile(context.paths.journalFile, "utf8");
    await expectConflict(() => createJournal(context.paths, managedFixture(context), { lease: fakeLease() }));
    assert.equal(await readFile(context.paths.journalFile, "utf8"), before, "existing journal untouched");

    const second = projectContext(path.join(root, "b"));
    await mkdir(second.paths.controlDirectory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(root, "innocent"), "keep");
    await symlink(path.join(root, "innocent"), second.paths.journalFile);
    await expectInvalid(() => createJournal(second.paths, managedFixture(second), { lease: fakeLease() }));
    assert.equal(await readFile(path.join(root, "innocent"), "utf8"), "keep");

    const third = projectContext(path.join(root, "c"));
    await mkdir(third.paths.controlDirectory, { recursive: true, mode: 0o700 });
    await mkdir(third.paths.journalFile);
    await expectInvalid(() => createJournal(third.paths, managedFixture(third), { lease: fakeLease() }));

    const fourth = projectContext(path.join(root, "d"));
    await mkdir(fourth.paths.controlDirectory, { recursive: true, mode: 0o700 });
    if (spawnSync("mkfifo", [fourth.paths.journalFile]).status === 0) {
      await expectInvalid(() => createJournal(fourth.paths, managedFixture(fourth), { lease: fakeLease() }));
      assert.equal((await lstat(fourth.paths.journalFile)).isFIFO(), true);
    }
  });
});

test("two concurrent createJournal calls produce exactly one winner", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    await mkdir(context.paths.controlDirectory, { recursive: true, mode: 0o700 });
    const results = await Promise.allSettled([
      createJournal(context.paths, managedFixture(context), { lease: fakeLease() }),
      createJournal(context.paths, managedFixture(context), { lease: fakeLease() }),
    ]);
    const winners = results.filter((result) => result.status === "fulfilled");
    const losers = results.filter((result) => result.status === "rejected");
    assert.equal(winners.length, 1, "exclusive create yields one winner");
    assert.equal(losers.length, 1);
    assert.equal(losers[0].reason.code, JOURNAL_ERROR_CODES.RECOVERY_CONFLICT);
    const readBack = await readJournal(context.paths);
    assert.equal(readBack.transactionId, TX);
    await expectInvalid(async () => readJournal(context.paths, { transactionId: OTHER_TX }));
  });
});

test("createJournal removes its own file on write or fsync failure", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    await mkdir(context.paths.controlDirectory, { recursive: true, mode: 0o700 });

    await withInternals(
      { syncFile: async () => { throw err("EIO", "injected fsync failure"); } },
      async () => {
        await expectCode(() => createJournal(context.paths, managedFixture(context), { lease: fakeLease() }), "EIO");
      },
    );
    await assert.rejects(() => lstat(context.paths.journalFile), (error) => error.code === "ENOENT");

    await withInternals(
      {
        writeChunk: async () => { throw err("ENOSPC", "no space left"); },
      },
      async () => {
        await expectCode(() => createJournal(context.paths, managedFixture(context), { lease: fakeLease() }), "ENOSPC");
      },
    );
    await assert.rejects(() => lstat(context.paths.journalFile), (error) => error.code === "ENOENT");
    assert.deepEqual(await readdir(context.paths.controlDirectory), [], "no partial journal remains");
  });
});

test("createJournal preserves a foreign file swapped in during a failed create", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    await mkdir(context.paths.controlDirectory, { recursive: true, mode: 0o700 });
    const movedPath = path.join(context.paths.controlDirectory, ".moved-aside");
    let swapped = false;
    await withInternals(
      {
        syncFile: async () => {
          if (!swapped) {
            swapped = true;
            await rename(context.paths.journalFile, movedPath);
            await writeFile(context.paths.journalFile, "foreign-content", { mode: 0o600 });
          }
          throw err("EIO", "injected fsync failure");
        },
      },
      async () => {
        await expectCode(() => createJournal(context.paths, managedFixture(context), { lease: fakeLease() }), "EIO");
      },
    );
    assert.equal(await readFile(context.paths.journalFile, "utf8"), "foreign-content", "identity-checked cleanup left the swapped file alone");
    await rm(movedPath, { force: true });
  });
});

test("createJournal tolerates unsupported parent syncs but propagates real ones", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    await mkdir(context.paths.controlDirectory, { recursive: true, mode: 0o700 });

    await withInternals(
      { syncDirectoryHandle: async () => { throw err("EINVAL", "directory fsync unsupported"); } },
      async () => {
        const created = await createJournal(context.paths, managedFixture(context), { lease: fakeLease() });
        assert.equal(created.revision, 0);
      },
    );

    const second = projectContext(path.join(root, "real-sync"));
    await mkdir(second.paths.controlDirectory, { recursive: true, mode: 0o700 });
    await withInternals(
      { syncDirectoryHandle: async () => { throw err("EIO", "directory io failure"); } },
      async () => {
        await expectCode(
          () => createJournal(second.paths, managedFixture(second), { lease: fakeLease() }),
          "EIO",
        );
      },
    );
    const readBack = await readJournal(second.paths);
    assert.equal(readBack.revision, 0, "the creation itself is committed before the parent sync");
  });
});

test("createJournal asserts the lease before and after the write", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    await mkdir(context.paths.controlDirectory, { recursive: true, mode: 0o700 });

    const early = fakeLease({ failAt: [1] });
    await expectCode(() => createJournal(context.paths, managedFixture(context), { lease: early }), "LOCK_COMPROMISED");
    await assert.rejects(() => lstat(context.paths.journalFile), (error) => error.code === "ENOENT");
    assert.equal(early.state.calls, 1);

    const preWrite = fakeLease({ failAt: [2] });
    await expectCode(() => createJournal(context.paths, managedFixture(context), { lease: preWrite }), "LOCK_COMPROMISED");
    await assert.rejects(() => lstat(context.paths.journalFile), (error) => error.code === "ENOENT");

    const postWrite = fakeLease({ failAt: [3] });
    await expectCode(() => createJournal(context.paths, managedFixture(context), { lease: postWrite }), "LOCK_COMPROMISED");
    assert.equal((await readJournal(context.paths)).revision, 0, "the write happened before the lease was lost");

    await expectTypeError(() => createJournal(context.paths, managedFixture(context), {}));
    await expectTypeError(() => createJournal(context.paths, managedFixture(context), { lease: {} }));
    await expectTypeError(() => createJournal(path.join(context.root, "x"), managedFixture(context), { lease: fakeLease() }));
  });
});

/* ================================================================== *
 * readJournal
 * ================================================================== */

test("readJournal fails closed for missing, wrong-type, overpermissive, oversize, and malformed journals", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    await mkdir(context.paths.controlDirectory, { recursive: true, mode: 0o700 });

    assert.equal(await readJournal(context.paths, { allowMissing: true }), null);
    await expectInvalid(() => readJournal(context.paths), /journal is missing/);

    await freshJournal(context);
    const good = await readFile(context.paths.journalFile, "utf8");

    // symlink
    await rm(context.paths.journalFile);
    await writeFile(path.join(context.root, "real-journal.json"), good, { mode: 0o600 });
    await symlink(path.join(context.root, "real-journal.json"), context.paths.journalFile);
    await expectInvalid(() => readJournal(context.paths), /symbolic link/);
    assert.equal(await readFile(path.join(context.root, "real-journal.json"), "utf8"), good, "symlink target untouched");
    await rm(context.paths.journalFile);

    // directory
    await mkdir(context.paths.journalFile);
    await expectInvalid(() => readJournal(context.paths), /not a regular file/);
    await rm(context.paths.journalFile, { recursive: true });

    // FIFO
    if (spawnSync("mkfifo", [context.paths.journalFile]).status === 0) {
      await expectInvalid(() => readJournal(context.paths), /not a regular file/);
      await rm(context.paths.journalFile, { force: true });
    }

    // overpermissive
    await writeFile(context.paths.journalFile, good, { mode: 0o600 });
    if (process.platform !== "win32") {
      await chmod(context.paths.journalFile, 0o644);
      await expectInvalid(() => readJournal(context.paths), /owner-only/);
    }

    const writeJournalRaw = async (content) => {
      await writeFile(context.paths.journalFile, content, { mode: 0o600 });
      if (process.platform !== "win32") await chmod(context.paths.journalFile, 0o600);
    };

    // oversize
    await writeJournalRaw("x".repeat(JOURNAL_MAX_BYTES + 1));
    await expectInvalid(() => readJournal(context.paths), /maximum journal size/);

    // malformed JSON
    await writeJournalRaw("{not json");
    await expectInvalid(() => readJournal(context.paths), /not valid JSON/);

    // schema violations surface through the read path (raw bytes, bypassing
    // serializeJournal's own validation on purpose)
    const writeInvalidJournal = async (mutate) => {
      const document = managedFixture(context);
      mutate(document);
      await writeJournalRaw(`${JSON.stringify(document)}\n`);
    };
    await writeInvalidJournal((document) => {
      document.owner = "evil";
    });
    await expectInvalid(() => readJournal(context.paths), /owner must be/);

    await writeInvalidJournal((document) => {
      document.schemaVersion = 99;
    });
    await expectInvalid(() => readJournal(context.paths), /schemaVersion must be/);
  });
});

/* ================================================================== *
 * updateJournal: transitions, patches, CAS, failures, lease
 * ================================================================== */

test("updateJournal advances revisions and timestamps monotonically", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const lease = fakeLease();
    let clock = Date.parse(NOW) + 5000;
    const now = () => clock;
    let current = await freshJournal(context);

    current = await updateJournal(context.paths, current, { phase: "intent" }, { lease, now });
    assert.equal(current.revision, 1);
    const firstUpdate = current.updatedAt;
    assert.equal(Date.parse(firstUpdate), Date.parse(NOW) + 5000);

    // The clock moves backwards; updatedAt still advances monotonically.
    clock = Date.parse(NOW);
    current = await updateJournal(context.paths, current, (document) => ({ phase: "applying" }), { lease, now });
    assert.equal(current.revision, 2);
    assert.equal(Date.parse(current.updatedAt), Date.parse(firstUpdate) + 1, "updatedAt is strictly increasing");

    // Same-phase updates (status/record changes) are legal.
    current = await updateJournal(context.paths, current, { mode: "forward" }, { lease, now });
    assert.equal(current.revision, 3);
    assert.equal(current.phase, "applying");

    current = await updateJournal(context.paths, current, { phase: "proven" }, { lease, now });
    current = await updateJournal(context.paths, current, { mode: "committed", phase: "committed" }, { lease, now });
    assert.equal(current.revision, 5);
    const onDisk = await readJournal(context.paths);
    assert.equal(onDisk.revision, 5);
    assert.equal(onDisk.updatedAt, current.updatedAt);

    await expectTypeError(() => updateJournal(context.paths, current, { phase: "proven" }, { lease, now: 5 }));
    await expectTypeError(() => updateJournal(context.paths, current, { phase: "proven" }, { lease, now, recovery: "yes" }));
  });
});

test("updateJournal enforces the explicit transition table and recovery overrides", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const lease = fakeLease();

    // prepared -> applying is a skip; intent -> prepared is backwards.
    let current = await freshJournal(context);
    await expectInvalid(() => updateJournal(context.paths, current, { phase: "applying" }, { lease }), /cannot skip ahead/);
    current = await updateJournal(context.paths, current, { phase: "intent" }, { lease });
    await expectInvalid(() => updateJournal(context.paths, current, { phase: "prepared" }, { lease }), /cannot move backwards/);

    // committed is only reachable from the final forward phase.
    await expectInvalid(
      () => updateJournal(context.paths, current, { mode: "committed", phase: "committed" }, { lease }),
      /only reachable from the final forward phase/,
    );

    // forward -> rollback from any phase, rollback keeps its phase, then finishes.
    current = await updateJournal(context.paths, current, { mode: "rollback" }, { lease });
    assert.equal(current.mode, "rollback");
    await expectInvalid(() => updateJournal(context.paths, current, { phase: "prepared" }, { lease }), /rollback keeps its phase/);
    await expectInvalid(
      () => updateJournal(context.paths, current, { mode: "committed", phase: "committed" }, { lease }),
      /only a forward journal can become committed/,
    );
    current = await updateJournal(context.paths, current, { mode: "forward" }, { lease, recovery: true });
    assert.equal(current.mode, "forward", "recovery may resume forward");
    current = await updateJournal(context.paths, current, { mode: "rollback" }, { lease });
    await expectInvalid(() => updateJournal(context.paths, current, { mode: "forward" }, { lease }), /cannot resume forward outside recovery/);
    current = await updateJournal(context.paths, current, { phase: "rolled-back" }, { lease });
    assert.equal(current.phase, "rolled-back");
    await expectInvalid(() => updateJournal(context.paths, current, { phase: "intent" }, { lease }), /terminal journal/);
    await expectInvalid(
      () => updateJournal(context.paths, current, { phase: "intent" }, { lease, recovery: true }),
      /terminal journal/,
    );

    // Recovery permits skips, backwards moves, and commit marking from any
    // forward phase, but never exits a terminal phase.
    const recoveryContext = projectContext(path.join(root, "recovery"));
    await mkdir(recoveryContext.paths.controlDirectory, { recursive: true, mode: 0o700 });
    const skipped = await seedJournal(recoveryContext, managedFixture(recoveryContext));
    const recovered = await updateJournal(recoveryContext.paths, skipped, { phase: "proven" }, { lease, recovery: true });
    assert.equal(recovered.phase, "proven");
    const backed = await updateJournal(recoveryContext.paths, recovered, { phase: "prepared" }, { lease, recovery: true });
    assert.equal(backed.phase, "prepared");
    const recoveredCommit = await updateJournal(
      recoveryContext.paths,
      backed,
      { mode: "committed", phase: "committed" },
      { lease, recovery: true },
    );
    assert.equal(recoveredCommit.phase, "committed");
    await expectInvalid(
      () => updateJournal(
        recoveryContext.paths,
        recoveredCommit,
        { mode: "committed", phase: "committed" },
        { lease, recovery: true },
      ),
      /terminal journal/,
    );

    // Removal machine phases (its own control directory: one journal each).
    const removalContext = projectContext(path.join(root, "removal"));
    await mkdir(removalContext.paths.controlDirectory, { recursive: true, mode: 0o700 });
    const removalLease = fakeLease();
    let removal = await seedJournal(removalContext, removalFixture(removalContext));
    removal = await updateJournal(removalContext.paths, removal, { phase: "intent" }, { lease: removalLease });
    removal = await updateJournal(removalContext.paths, removal, { phase: "detaching" }, { lease: removalLease });
    await expectInvalid(() => updateJournal(removalContext.paths, removal, { phase: "applying" }, { lease: removalLease }), /not valid for a removal/);
    removal = await updateJournal(removalContext.paths, removal, { phase: "commit-ready" }, { lease: removalLease });
    removal = await updateJournal(removalContext.paths, removal, { mode: "committed", phase: "committed" }, { lease: removalLease });
    assert.equal(removal.phase, "committed");
  });
});

test("updateJournal rejects reserved and non-plain patches", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const lease = fakeLease();
    const current = await freshJournal(context);

    for (const patch of [
      { revision: 9 },
      { updatedAt: "2030-01-01T00:00:00.000Z" },
      { createdAt: "2030-01-01T00:00:00.000Z" },
      { transactionId: OTHER_TX },
      { kind: "removal" },
      { command: "uninstall" },
      { scope: "global" },
      { root: "/somewhere" },
      { controlDirectory: "/somewhere" },
      { stateDirectory: "/somewhere" },
      { schemaVersion: 2 },
      { owner: "evil" },
      { extra: 1 },
    ]) {
      await expectInvalid(
        () => updateJournal(context.paths, current, patch, { lease }),
        /update patch may only set/,
      );
    }

    await expectInvalid(() => updateJournal(context.paths, current, null, { lease }), /plain object/);
    await expectInvalid(() => updateJournal(context.paths, current, [], { lease }), /plain object/);
    await expectInvalid(() => updateJournal(context.paths, current, undefined, { lease }), /plain object/);
    await expectInvalid(
      () => updateJournal(context.paths, current, () => ({ ...current, phase: "intent" }), { lease }),
      /update patch may only set/,
    );
    await expectTypeError(() => updateJournal(context.paths, current, { phase: "intent" }, { lease: null }));

    const unchanged = await readJournal(context.paths);
    assert.equal(unchanged.revision, 0, "rejected patches never touch the journal");
  });
});

test("updateJournal fails closed on compare-and-swap drift", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const lease = fakeLease();
    const current = await freshJournal(context);

    // (a) trailing byte tamper
    await writeFile(context.paths.journalFile, `${await readFile(context.paths.journalFile, "utf8")} `, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(context.paths.journalFile, 0o600);
    await expectConflict(() => updateJournal(context.paths, current, { phase: "intent" }, { lease }), /differs from the supplied/);
    await expectConflict(() => removeJournal(context.paths, current, { lease }), /differs from the supplied/);

    // (b) a valid but newer document on disk
    const onDisk = await readJournal(context.paths, { allowMissing: true });
    const rewritten = { ...current, revision: current.revision + 1, phase: "intent" };
    await writeFile(context.paths.journalFile, serializeJournal(rewritten), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(context.paths.journalFile, 0o600);
    assert.ok(onDisk);
    await expectConflict(() => updateJournal(context.paths, current, { phase: "applying" }, { lease }), /revision on disk/);

    // (c) missing journal
    await rm(context.paths.journalFile);
    await expectConflict(() => updateJournal(context.paths, current, { phase: "intent" }, { lease }), /journal is missing/);
    await expectConflict(() => removeJournal(context.paths, current, { lease }), /journal is missing/);

    // (d) a different valid transaction as `current`
    await freshJournal(context);
    const foreign = managedFixture(context, { transactionId: OTHER_TX });
    await expectConflict(() => updateJournal(context.paths, foreign, { phase: "intent" }, { lease }), /different transaction/);

    // (e) symlink swap of the journal path
    const realJournal = path.join(root, "elsewhere.json");
    await writeFile(realJournal, "keep", { mode: 0o600 });
    await rm(context.paths.journalFile);
    await symlink(realJournal, context.paths.journalFile);
    await expectInvalid(() => updateJournal(context.paths, current, { phase: "intent" }, { lease }), /symbolic link/);
    assert.equal(await readFile(realJournal, "utf8"), "keep");
  });
});

test("updateJournal write failures leave the previous journal intact", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const lease = fakeLease();
    const current = await freshJournal(context);
    const before = await readFile(context.paths.journalFile, "utf8");

    await withInternals(
      { rename: async () => { throw err("EXDEV", "rename refused"); } },
      async () => {
        await expectCode(() => updateJournal(context.paths, current, { phase: "intent" }, { lease }), "EXDEV");
      },
    );
    assert.equal(await readFile(context.paths.journalFile, "utf8"), before, "journal unchanged after rename failure");

    await withInternals(
      { syncFile: async () => { throw err("EIO", "fsync refused"); } },
      async () => {
        await expectCode(() => updateJournal(context.paths, current, { phase: "intent" }, { lease }), "EIO");
      },
    );
    assert.equal(await readFile(context.paths.journalFile, "utf8"), before, "journal unchanged after fsync failure");
    assert.equal((await readJournal(context.paths)).revision, 0);
    assert.deepEqual(await payloadFilesIn(context.paths.controlDirectory), [], "no temp files remain");
  });
});

test("updateJournal asserts the lease before and after the write", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const current = await freshJournal(context);
    const before = await readFile(context.paths.journalFile, "utf8");

    const early = fakeLease({ failAt: [1] });
    await expectCode(() => updateJournal(context.paths, current, { phase: "intent" }, { lease: early }), "LOCK_COMPROMISED");
    assert.equal(await readFile(context.paths.journalFile, "utf8"), before);

    const preWrite = fakeLease({ failAt: [2] });
    await expectCode(() => updateJournal(context.paths, current, { phase: "intent" }, { lease: preWrite }), "LOCK_COMPROMISED");
    assert.equal(await readFile(context.paths.journalFile, "utf8"), before, "no write happened after the pre-write check");

    const postWrite = fakeLease({ failAt: [3] });
    await expectCode(() => updateJournal(context.paths, current, { phase: "intent" }, { lease: postWrite }), "LOCK_COMPROMISED");
    assert.equal((await readJournal(context.paths)).revision, 1, "the update was written before the lease was lost");
  });
});

/* ================================================================== *
 * removeJournal
 * ================================================================== */

async function committedJournal(context, overrides = {}) {
  let document = await seedJournal(context, managedFixture(context, overrides));
  const lease = fakeLease();
  document = await updateJournal(context.paths, document, { phase: "intent" }, { lease });
  document = await updateJournal(context.paths, document, { phase: "applying" }, { lease });
  document = await updateJournal(context.paths, document, { phase: "proven" }, { lease });
  document = await updateJournal(context.paths, document, { mode: "committed", phase: "committed" }, { lease });
  assert.equal(document.phase, "committed");
  return document;
}

test("removeJournal only removes terminal cleanup-complete journals", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const lease = fakeLease();
    let current = await freshJournal(context, { files: [recordFor(context.configTarget, TX)] });

    current = await updateJournal(context.paths, current, { phase: "intent" }, { lease });
    current = await updateJournal(context.paths, current, {
      state: {
        stage: { path: stagePathFor(context.stateDirectory, TX), identity: null, marker: null, digest: null },
        backup: null,
      },
    }, { lease });

    // Not terminal yet: refused, journal intact.
    await expectInvalid(() => removeJournal(context.paths, current, { lease }), /not terminal/);
    assert.equal((await readJournal(context.paths)).revision, current.revision);

    current = await updateJournal(context.paths, current, { phase: "applying" }, { lease });
    current = await updateJournal(context.paths, current, { phase: "proven" }, { lease });
    current = await updateJournal(context.paths, current, { mode: "committed", phase: "committed" }, { lease });

    // A recorded payload that still exists blocks removal.
    const payloadPath = current.files[0].after.payloadPath;
    await writeFile(payloadPath, "payload-bytes", { mode: 0o600 });
    if (process.platform !== "win32") await chmod(payloadPath, 0o600);
    await expectInvalid(() => removeJournal(context.paths, current, { lease }), /live artifact or payload/);
    assert.equal(await readFile(payloadPath, "utf8"), "payload-bytes", "live payload untouched");
    assert.equal((await readJournal(context.paths)).phase, "committed", "journal survives the refusal");

    await rm(payloadPath);

    // A recorded staging directory that still exists blocks removal.
    const stagePath = current.state.stage.path;
    await mkdir(stagePath);
    await expectInvalid(() => removeJournal(context.paths, current, { lease }), /live artifact or payload/);
    assert.equal((await lstat(stagePath)).isDirectory(), true, "live artifact untouched");
    await rm(stagePath, { recursive: true, force: true });

    // Terminal with every recorded path gone: removed exactly.
    await removeJournal(context.paths, current, { lease });
    assert.equal(await readJournal(context.paths, { allowMissing: true }), null);
    assert.equal((await lstat(context.paths.controlDirectory)).isDirectory(), true, "control directory survives");
    assert.deepEqual(await payloadFilesIn(context.paths.controlDirectory), []);
  });
});

test("removeJournal enforces CAS, inode identity, and the lease", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const lease = fakeLease();
    const current = await committedJournal(context);
    const goodBytes = await readFile(context.paths.journalFile);

    // Lease loss before any work.
    const early = fakeLease({ failAt: [1] });
    await expectCode(() => removeJournal(context.paths, current, { lease: early }), "LOCK_COMPROMISED");
    assert.equal((await lstat(context.paths.journalFile)).isFile(), true);

    // Lease loss after the liveness checks, before the unlink.
    const preUnlink = fakeLease({ failAt: [2] });
    await expectCode(() => removeJournal(context.paths, current, { lease: preUnlink }), "LOCK_COMPROMISED");
    assert.equal((await lstat(context.paths.journalFile)).isFile(), true, "journal survives a pre-unlink lease loss");

    // A swap between this call's reread and its unlink (detected through the
    // pre-unlink lease assertion) is drift even when the bytes are identical.
    // The swap renames the old journal aside instead of deleting it: an inode
    // allocator with eager reuse (ext4 on the Linux runner) can give the
    // replacement the same dev/ino the deleted file just freed, which would
    // make the swap invisible to the identity check. Renaming keeps the old
    // inode allocated, so the replacement always differs on every platform.
    await rename(context.paths.journalFile, `${context.paths.journalFile}.pinned`);
    await writeFile(context.paths.journalFile, goodBytes, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(context.paths.journalFile, 0o600);
    let swaps = 0;
    const swappingLease = {
      async assertHeld() {
        swaps += 1;
        if (swaps === 2) {
          await rename(context.paths.journalFile, `${context.paths.journalFile}.swapped`);
          await writeFile(context.paths.journalFile, goodBytes, { mode: 0o600 });
          if (process.platform !== "win32") await chmod(context.paths.journalFile, 0o600);
        }
      },
    };
    await expectConflict(() => removeJournal(context.paths, current, { lease: swappingLease }), /changed before removal/);
    assert.equal((await lstat(context.paths.journalFile)).isFile(), true, "the swapped journal survives");

    // Byte tampering is CAS drift.
    await writeFile(context.paths.journalFile, Buffer.concat([goodBytes, Buffer.from(" ")]), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(context.paths.journalFile, 0o600);
    await expectConflict(() => removeJournal(context.paths, current, { lease }), /differs from the supplied/);

    // Lease loss at the immediate pre-unlink assertion: the journal survives;
    // only a loss after the committed unlink leaves it gone.
    await writeFile(context.paths.journalFile, goodBytes, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(context.paths.journalFile, 0o600);
    const preUnlinkLate = fakeLease({ failAt: [3] });
    await expectCode(() => removeJournal(context.paths, current, { lease: preUnlinkLate }), "LOCK_COMPROMISED");
    assert.equal((await lstat(context.paths.journalFile)).isFile(), true, "the journal survives the pre-unlink loss");

    const postUnlink = fakeLease({ failAt: [4] });
    await expectCode(() => removeJournal(context.paths, current, { lease: postUnlink }), "LOCK_COMPROMISED");
    assert.equal(await readJournal(context.paths, { allowMissing: true }), null, "the unlink completed");

    // Missing journal.
    await expectConflict(() => removeJournal(context.paths, current, { lease }), /journal is missing/);

    // Symlinked journal path fails closed before any unlink.
    const keeper = path.join(root, "keeper.json");
    await writeFile(keeper, "keep", { mode: 0o600 });
    await symlink(keeper, context.paths.journalFile);
    await expectInvalid(() => removeJournal(context.paths, current, { lease }), /symbolic link/);
    assert.equal(await readFile(keeper, "utf8"), "keep");
    await rm(context.paths.journalFile);
  });
});

test("removeJournal surfaces parent sync failures after the unlink committed", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const lease = fakeLease();
    const current = await committedJournal(context);
    await withInternals(
      { syncDirectoryHandle: async () => { throw err("EIO", "directory io failure"); } },
      async () => {
        await expectCode(() => removeJournal(context.paths, current, { lease }), "EIO");
      },
    );
    assert.equal(await readJournal(context.paths, { allowMissing: true }), null, "the unlink itself committed");
  });
});

/* ================================================================== *
 * Payload preparation, reading, classification, cleanup
 * ================================================================== */

test("prepareFilePayloads creates exact durable adjacent payloads", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const lease = fakeLease({ paths: context.paths });
    const routerBefore = Buffer.from(`{"sentinel":"${SENTINEL}","old":true}`);
    const routerAfter = Buffer.from(`{"sentinel":"${SENTINEL}","new":true}`);
    const opencodeBefore = Buffer.from('{"skills":{"paths":["a"]}}');
    const opencodeAfter = Buffer.from('{"skills":["a"]}');
    const missingTarget = path.join(root, "generated.json");
    await writeFile(context.configTarget, routerBefore, { mode: 0o600 });
    await writeFile(context.opencodeTarget, opencodeBefore, { mode: 0o600 });

    const records = await prepareFilePayloads(
      TX,
      [
        { target: context.configTarget, role: "router-config", afterBytes: routerAfter },
        {
          target: context.opencodeTarget,
          role: "opencode-config",
          afterBytes: opencodeAfter,
          expectedBefore: { exists: true, sha256: sha256Bytes(opencodeBefore) },
        },
        { target: missingTarget, role: "opencode-config", afterBytes: Buffer.from("{}") },
      ],
      { lease },
    );

    assert.equal(records.length, 3);
    assert.ok(Object.isFrozen(records));
    assert.ok(Object.isFrozen(records[0]));
    assert.equal(records[0].status, "prepared");
    assert.equal(records[0].before.exists, true);
    assert.equal(records[0].before.sha256, sha256Bytes(routerBefore));
    assert.equal(records[0].before.payloadPath, payloadPathFor(context.configTarget, TX, "before"));
    assert.equal(records[0].after.payloadPath, payloadPathFor(context.configTarget, TX, "after"));
    assert.equal(records[0].after.sha256, sha256Bytes(routerAfter));

    // Absent target: null before descriptor, no before payload.
    const absent = records[2];
    assert.deepEqual(absent.before, { exists: false, sha256: null, payloadPath: null });
    assert.equal(absent.before.payloadPath, null);
    await lstat(absent.after.payloadPath);

    // Payloads hold the exact bytes; the records never do.
    const beforePayload = await readPayload(records[0].before.payloadPath, { expectedSha256: records[0].before.sha256 });
    assert.ok(beforePayload.bytes.equals(routerBefore));
    const afterPayload = await readPayload(records[0].after.payloadPath, { expectedSha256: records[0].after.sha256 });
    assert.ok(afterPayload.bytes.equals(routerAfter));
    const serializedRecords = JSON.stringify(records);
    assert.equal(serializedRecords.includes(SENTINEL), false, "no raw bytes in records");
    assert.equal(serializedRecords.includes(routerBefore.toString("utf8")), false);

    // Modes and untouched targets.
    if (process.platform !== "win32") {
      assert.equal((await lstat(records[0].before.payloadPath)).mode & 0o777, 0o600);
      assert.equal((await lstat(records[0].after.payloadPath)).mode & 0o777, 0o600);
    }
    assert.ok((await readFile(context.configTarget)).equals(routerBefore), "the target itself is never written");
    assert.ok((await readFile(context.opencodeTarget)).equals(opencodeBefore));

    // The records are journal-ready.
    const journal = validateJournal(managedFixture(context, { files: records }));
    assert.equal(journal.files.length, 3);
  });
});

test("prepareFilePayloads enforces plans and observed before state", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const lease = fakeLease({ paths: context.paths });
    const content = Buffer.from("original-content");
    await writeFile(context.configTarget, content, { mode: 0o600 });
    const plan = { target: context.configTarget, role: "router-config", afterBytes: Buffer.from("next") };
    const wrongDigest = "00".repeat(32);

    // expectedBefore mismatches refuse before writing anything.
    await expectConflict(
      () => prepareFilePayloads(TX, [{ ...plan, expectedBefore: { exists: true, sha256: wrongDigest } }], { lease }),
      /changed since it was last observed/,
    );
    assert.deepEqual(await payloadFilesIn(root), [], "no payloads after a refused plan");
    await expectConflict(
      () => prepareFilePayloads(TX, [{ ...plan, expectedBefore: { exists: false, sha256: null } }], { lease }),
      /changed since it was last observed/,
    );
    assert.deepEqual(await payloadFilesIn(root), []);
    await expectConflict(
      () =>
        prepareFilePayloads(
          TX,
          [{ target: path.join(root, "absent.json"), role: "router-config", afterBytes: Buffer.from("x"), expectedBefore: { exists: true, sha256: wrongDigest } }],
          { lease },
        ),
      /changed since it was last observed/,
    );
    assert.deepEqual(await payloadFilesIn(root), []);

    // Matching expectation succeeds.
    const ok = await prepareFilePayloads(
      TX,
      [{ ...plan, expectedBefore: { exists: true, sha256: sha256Bytes(content) } }],
      { lease },
    );
    assert.equal(ok.length, 1);
    for (const gone of ok.flatMap((record) => [record.before.payloadPath, record.after.payloadPath])) {
      await rm(gone, { force: true });
    }

    // Plan shape failures.
    await expectInvalid(() => prepareFilePayloads(TX, [{ ...plan, target: context.configTarget }, plan], { lease }), /must not repeat a target/);
    await expectInvalid(() => prepareFilePayloads(TX, [{ ...plan, role: "claude-config" }], { lease }), /role is not a supported role/);
    await expectInvalid(() => prepareFilePayloads(TX, [{ ...plan, extra: 1 }], { lease }), /unknown key: extra/);
    await expectInvalid(() => prepareFilePayloads(TX, [{ ...plan, target: "relative.json" }], { lease }), /absolute path/);
    await expectInvalid(() => prepareFilePayloads(TX, [{ ...plan, target: `${root}/*.json` }], { lease }), /wildcard/);
    await expectInvalid(() => prepareFilePayloads("not-a-digest", [plan], { lease }), /transactionId/);
    await expectInvalid(() => prepareFilePayloads(TX, [{ ...plan, expectedBefore: { exists: true } }], { lease }), /missing required key: sha256/);
    await expectInvalid(
      () => prepareFilePayloads(TX, [{ ...plan, expectedBefore: { exists: false, sha256: wrongDigest } }], { lease }),
      /must be null when the file is absent/,
    );
    await expectInvalid(
      () => prepareFilePayloads(TX, [{ ...plan, expectedBefore: { exists: true, sha256: wrongDigest, raw: 1 } }], { lease }),
      /unknown key: raw/,
    );
    await expectInvalid(
      () => prepareFilePayloads(TX, [{ ...plan, afterBytes: new Uint8Array(DEFAULT_MAX_FILE_BYTES + 1) }], { lease }),
      /maximum payload size/,
    );
    await expectTypeError(() => prepareFilePayloads(TX, [{ ...plan, afterBytes: "string" }], { lease }));
    await expectTypeError(() => prepareFilePayloads(TX, "not-an-array", { lease }));
    assert.deepEqual(await payloadFilesIn(root), [], "shape failures never write payloads");

    // Targets inside the control directory are refused when the lease knows it.
    await expectInvalid(
      () =>
        prepareFilePayloads(
          TX,
          [{ target: path.join(context.paths.controlDirectory, "x.json"), role: "router-config", afterBytes: Buffer.from("x") }],
          { lease },
        ),
      /overlap the control directory/,
    );
  });
});

test("prepareFilePayloads adopts matching payloads and refuses foreign ones", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const lease = fakeLease();
    const content = Buffer.from("target-content");
    const next = Buffer.from("next-content");
    await writeFile(context.configTarget, content, { mode: 0o600 });
    const plan = { target: context.configTarget, role: "router-config", afterBytes: next };
    const afterPath = payloadPathFor(context.configTarget, TX, "after");

    // A leftover payload with the exact planned bytes is adopted, not replaced.
    await writeFile(afterPath, next, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(afterPath, 0o600);
    const adopted = await prepareFilePayloads(TX, [plan], { lease });
    assert.equal(adopted[0].after.payloadPath, afterPath);
    await lstat(afterPath);

    // A leftover payload with different bytes fails closed and is preserved.
    await rm(adopted[0].before.payloadPath);
    await rm(afterPath);
    await writeFile(afterPath, "foreign-bytes", { mode: 0o600 });
    if (process.platform !== "win32") await chmod(afterPath, 0o600);
    await expectConflict(() => prepareFilePayloads(TX, [plan], { lease }), /does not match the planned content/);
    assert.equal(await readFile(afterPath, "utf8"), "foreign-bytes", "foreign payload preserved");
    await assert.rejects(() => lstat(payloadPathFor(context.configTarget, TX, "before")), (error) => error.code === "ENOENT");

    // A symlink at a payload path is never adopted.
    await rm(afterPath);
    const target = path.join(root, "elsewhere.txt");
    await writeFile(target, "keep", { mode: 0o600 });
    await symlink(target, afterPath);
    await expectInvalid(() => prepareFilePayloads(TX, [plan], { lease }), /symbolic link/);
    assert.equal(await readFile(target, "utf8"), "keep");
    await rm(afterPath);
  });
});

test("prepareFilePayloads cleans only the payloads it created", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const lease = fakeLease();
    const content = Buffer.from("target-content");
    await writeFile(context.configTarget, content, { mode: 0o600 });
    const plan = { target: context.configTarget, role: "router-config", afterBytes: Buffer.from("next-content") };
    const beforePath = payloadPathFor(context.configTarget, TX, "before");
    const afterPath = payloadPathFor(context.configTarget, TX, "after");

    // Failure on the after payload removes the before payload this call created.
    let writes = 0;
    const original = durableFsInternals.writeChunk;
    await withInternals(
      {
        writeChunk: async (handle, buffer, offset) => {
          writes += 1;
          if (writes >= 2) throw err("ENOSPC", "no space left");
          return original(handle, buffer, offset);
        },
      },
      async () => {
        await expectCode(() => prepareFilePayloads(TX, [plan], { lease }), "ENOSPC");
      },
    );
    assert.deepEqual(await payloadFilesIn(root), [], "created payloads are rolled back");
    assert.equal(writes >= 2, true);

    // An adopted before payload is NOT this call's to delete.
    await writeFile(beforePath, content, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(beforePath, 0o600);
    await withInternals(
      {
        writeChunk: async () => { throw err("ENOSPC", "no space left"); },
      },
      async () => {
        await expectCode(() => prepareFilePayloads(TX, [plan], { lease }), "ENOSPC");
      },
    );
    assert.equal(await lstat(beforePath).then(() => true, () => false), true, "the adopted payload survives the rollback");
    await assert.rejects(() => lstat(afterPath), (error) => error.code === "ENOENT");
    await rm(beforePath);

    // A file swapped into a created payload's path during failure is
    // preserved only when its identity changes; identity-checked cleanup
    // removes a same-inode overwrite because this call still owns that file.
    await rm(beforePath, { force: true });
    const asidePath = path.join(root, ".payload-aside");
    let swappedIn = false;
    await withInternals(
      {
        syncFile: async () => {
          if (!swappedIn) {
            swappedIn = true;
            await rename(beforePath, asidePath);
            await writeFile(beforePath, "foreign-content", { mode: 0o600 });
          }
          throw err("EIO", "injected fsync failure");
        },
      },
      async () => {
        await expectCode(() => prepareFilePayloads(TX, [plan], { lease }), "EIO");
      },
    );
    assert.equal(await readFile(beforePath, "utf8"), "foreign-content", "swapped file is preserved");
    await assert.rejects(() => lstat(afterPath), (error) => error.code === "ENOENT");
    await rm(asidePath, { force: true });
  });
});

test("two concurrent prepareFilePayloads runs share exactly one payload set", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const lease = fakeLease();
    const content = Buffer.from("target-content");
    const next = Buffer.from("next-content");
    await writeFile(context.configTarget, content, { mode: 0o600 });
    const plans = [{ target: context.configTarget, role: "router-config", afterBytes: next }];

    const [first, second] = await Promise.all([
      prepareFilePayloads(TX, plans, { lease }),
      prepareFilePayloads(TX, plans, { lease }),
    ]);
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    const payloads = await payloadFilesIn(root);
    assert.equal(payloads.length, 2, "exactly one before and one after payload exist");
    const after = await readPayload(payloadPathFor(context.configTarget, TX, "after"), {
      expectedSha256: sha256Bytes(next),
    });
    assert.ok(after.bytes.equals(next));
  });
});

test("prepareFilePayloads asserts the lease immediately before each payload create", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    await writeFile(context.configTarget, "content", { mode: 0o600 });
    const plans = [{ target: context.configTarget, role: "router-config", afterBytes: Buffer.from("next") }];

    const early = fakeLease({ failAt: [1] });
    await expectCode(() => prepareFilePayloads(TX, plans, { lease: early }), "LOCK_COMPROMISED");
    assert.deepEqual(await payloadFilesIn(root), [], "no payloads after a pre-flight lease loss");

    // Count the assertions of one full preparation: the first payload create
    // asserts immediately before it runs.
    const measure = countingLease();
    await prepareFilePayloads(TX, plans, { lease: measure });
    const total = measure.state.calls;
    assert.ok(total >= 3, `start, per-create, and final assertions (saw ${total})`);
    for (const gone of await payloadFilesIn(root)) await rm(path.join(root, gone), { force: true });

    // Losing the lease at the first per-create assertion creates nothing...
    const beforeCreate = countingLease({ failAt: 2 });
    await expectCode(() => prepareFilePayloads(TX, plans, { lease: beforeCreate }), "LOCK_COMPROMISED");
    assert.deepEqual(await payloadFilesIn(root), [], "a payload lost immediately before its create is never created");

    // ...while a loss at the final assertion happens after every create.
    const afterCreates = countingLease({ failAt: total });
    await expectCode(() => prepareFilePayloads(TX, plans, { lease: afterCreates }), "LOCK_COMPROMISED");
    assert.equal((await payloadFilesIn(root)).length, 2, "every payload was created before the final loss");

    // A valid lease retry completes idempotently.
    for (const gone of await payloadFilesIn(root)) await rm(path.join(root, gone), { force: true });
    const records = await prepareFilePayloads(TX, plans, { lease: countingLease() });
    assert.equal(records.length, 1);
    assert.equal((await payloadFilesIn(root)).length, 2);
  });
});

test("readPayload verifies names, types, modes, sizes, and digests", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const payloadPath = payloadPathFor(context.configTarget, TX, "after");
    const content = Buffer.from("payload-content");
    await writeFile(payloadPath, content, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(payloadPath, 0o600);

    const read = await readPayload(payloadPath, { expectedSha256: sha256Bytes(content) });
    assert.ok(read.bytes.equals(content));
    assert.equal(read.sha256, sha256Bytes(content));
    assert.ok(Object.isFrozen(read));

    await expectConflict(() => readPayload(payloadPath, { expectedSha256: "00".repeat(32) }), /recorded digest/);
    const missingName = payloadPathFor(context.configTarget, OTHER_TX, "after");
    assert.equal(await readPayload(missingName, { allowMissing: true }), null);
    await expectInvalid(() => readPayload(missingName), /payload is missing/);
    await expectInvalid(() => readPayload(path.join(root, "evil.txt")), /exact payload path/);
    await expectInvalid(() => readPayload(`${root}/./${path.basename(payloadPath)}`), /normalized absolute path/);
    await expectInvalid(() => readPayload(path.join(root, "*.after")), /wildcard/);
    await expectInvalid(() => readPayload(payloadPath, { maxBytes: 4 }), /maximum payload size/);

    // type and permission failures
    await rm(payloadPath);
    await mkdir(payloadPath);
    await expectInvalid(() => readPayload(payloadPath), /not a regular file/);
    await rm(payloadPath, { recursive: true });
    await writeFile(payloadPath, content, { mode: 0o600 });
    if (process.platform !== "win32") {
      await chmod(payloadPath, 0o644);
      await expectInvalid(() => readPayload(payloadPath), /owner-only/);
      await chmod(payloadPath, 0o600);
    }
    await rm(payloadPath);
    const keeper = path.join(root, "keeper.txt");
    await writeFile(keeper, "keep", { mode: 0o600 });
    await symlink(keeper, payloadPath);
    await expectInvalid(() => readPayload(payloadPath), /symbolic link/);
    assert.equal(await readFile(keeper, "utf8"), "keep");
    await expectTypeError(() => readPayload(42, {}));
  });
});

test("classifyJournalFile classifies target content against the record", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const before = Buffer.from("OLD-CONTENT");
    const after = Buffer.from("NEW-CONTENT");
    const record = recordFor(context.configTarget, TX, {
      beforeDigest: sha256Bytes(before),
      afterDigest: sha256Bytes(after),
    });

    await writeFile(context.configTarget, before, { mode: 0o600 });
    assert.equal(await classifyJournalFile(record), "before");
    await writeFile(context.configTarget, after, { mode: 0o600 });
    assert.equal(await classifyJournalFile(record), "after");
    await writeFile(context.configTarget, "CONCURRENT-EDIT", { mode: 0o600 });
    assert.equal(await classifyJournalFile(record), "conflict");
    await rm(context.configTarget);
    assert.equal(await classifyJournalFile(record), "absent");

    // Absent before, present after.
    const fresh = recordFor(context.configTarget, TX, { beforeExists: false, afterDigest: sha256Bytes(after) });
    await writeFile(context.configTarget, after, { mode: 0o600 });
    assert.equal(await classifyJournalFile(fresh), "after");
    await writeFile(context.configTarget, "other", { mode: 0o600 });
    assert.equal(await classifyJournalFile(fresh), "conflict");

    // Identical before/after digests classify as the desired state.
    const identical = recordFor(context.configTarget, TX, {
      beforeDigest: sha256Bytes(after),
      afterDigest: sha256Bytes(after),
    });
    await writeFile(context.configTarget, after, { mode: 0o600 });
    assert.equal(await classifyJournalFile(identical), "after");

    // Non-regular or unreadable targets are conflicts, never guesses.
    await rm(context.configTarget);
    await symlink(path.join(root, "elsewhere"), context.configTarget);
    assert.equal(await classifyJournalFile(record), "conflict");
    await rm(context.configTarget);
    await mkdir(context.configTarget);
    assert.equal(await classifyJournalFile(record), "conflict");
    await rm(context.configTarget, { recursive: true });
    if (spawnSync("mkfifo", [context.configTarget]).status === 0) {
      assert.equal(await classifyJournalFile(record), "conflict");
      await rm(context.configTarget, { force: true });
    }

    // Oversize targets cannot be verified and classify as conflicts.
    await writeFile(context.configTarget, Buffer.alloc(DEFAULT_MAX_FILE_BYTES + 1, 0x61), { mode: 0o600 });
    assert.equal(await classifyJournalFile(record), "conflict");
    await rm(context.configTarget);

    // Malformed records are rejected outright.
    await expectInvalid(() => classifyJournalFile({ ...record, role: "bogus" }), /role is not a supported role/);
    await expectInvalid(
      () => classifyJournalFile({ ...record, after: { ...record.after, payloadPath: path.join(root, "bad.json") } }),
      /must be an exact payload path/,
    );
    await expectInvalid(() => classifyJournalFile(null), /plain object/);
  });
});

test("cleanupPayloads deletes only verified exact payloads", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const lease = fakeLease();
    const content = Buffer.from("target-content");
    await writeFile(context.configTarget, content, { mode: 0o600 });
    const plans = [
      { target: context.configTarget, role: "router-config", afterBytes: Buffer.from("next-content") },
      { target: path.join(root, "other.json"), role: "opencode-config", afterBytes: Buffer.from("{}") },
    ];
    await writeFile(path.join(root, "other.json"), "other", { mode: 0o600 });
    const records = await prepareFilePayloads(TX, plans, { lease });
    assert.equal((await payloadFilesIn(root)).length, 4);

    // Altering a recorded payload refuses cleanup and keeps it.
    await writeFile(records[0].before.payloadPath, "tampered", { mode: 0o600 });
    if (process.platform !== "win32") await chmod(records[0].before.payloadPath, 0o600);
    await expectConflict(() => cleanupPayloads([records[0]], { lease }), /altered/);
    assert.equal(await readFile(records[0].before.payloadPath, "utf8"), "tampered", "altered payload is never deleted");
    assert.equal((await lstat(records[0].after.payloadPath)).isFile(), true);
    await writeFile(records[0].before.payloadPath, content, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(records[0].before.payloadPath, 0o600);

    // A symlinked payload refuses cleanup and is left alone.
    await rm(records[0].before.payloadPath);
    const keeper = path.join(root, "keeper.txt");
    await writeFile(keeper, "keep", { mode: 0o600 });
    await symlink(keeper, records[0].before.payloadPath);
    await expectInvalid(() => cleanupPayloads([records[0]], { lease }), /not a regular file/);
    assert.equal(await readFile(keeper, "utf8"), "keep");
    await rm(records[0].before.payloadPath);

    // Overpermissive payloads refuse cleanup.
    await writeFile(records[0].before.payloadPath, content, { mode: 0o600 });
    if (process.platform !== "win32") {
      await chmod(records[0].before.payloadPath, 0o644);
      await expectInvalid(() => cleanupPayloads([records[0]], { lease }), /owner-only/);
      assert.equal((await lstat(records[0].before.payloadPath)).isFile(), true, "overpermissive payload kept");
      await chmod(records[0].before.payloadPath, 0o600);
    }

    // Mixed transaction ids and duplicate targets refuse before deleting.
    await expectInvalid(() => cleanupPayloads([records[0], recordFor(path.join(root, "third.json"), OTHER_TX, { role: "opencode-config" })], { lease }), /different transactions/);
    await expectInvalid(() => cleanupPayloads([records[0], { ...records[0], role: "opencode-config" }], { lease }), /repeat a target/);
    await expectInvalid(() => cleanupPayloads([{ ...records[0], role: "bogus" }], { lease }), /role is not a supported role/);
    assert.equal((await payloadFilesIn(root)).length, 4, "refusals delete nothing");

    // Already-absent payloads are skipped; the rest are removed.
    await rm(records[0].before.payloadPath);
    const result = await cleanupPayloads(records, { lease });
    assert.equal(result.removed.length, 3);
    assert.deepEqual(await payloadFilesIn(root), []);

    // Idempotent second run.
    const again = await cleanupPayloads(records, { lease });
    assert.deepEqual(again.removed, []);

    // Lease assertions: every destructive unlink asserts immediately before
    // it, so a late loss never deletes all payloads - only an assertion after
    // the final unlink runs past a fully cleaned state.
    const freshRecords = await prepareFilePayloads(TX, plans, { lease });
    const early = fakeLease({ failAt: [1] });
    await expectCode(() => cleanupPayloads(freshRecords, { lease: early }), "LOCK_COMPROMISED");
    assert.equal((await payloadFilesIn(root)).length, 4, "no deletion after a pre-flight lease loss");

    const measure = countingLease();
    await cleanupPayloads(freshRecords, { lease: measure });
    const total = measure.state.calls;
    assert.ok(total >= 6, `start, per-unlink, and final assertions (saw ${total})`);

    for (let failAt = 1; failAt <= total; failAt += 1) {
      const records = await prepareFilePayloads(TX, plans, { lease: countingLease() });
      assert.equal((await payloadFilesIn(root)).length, 4);
      const broken = countingLease({ failAt });
      await expectCode(() => cleanupPayloads(records, { lease: broken }), "LOCK_COMPROMISED");
      const remaining = (await payloadFilesIn(root)).length;
      if (failAt === total) {
        assert.equal(remaining, 0, "the final assertion runs after every unlink");
      } else {
        assert.ok(remaining >= 1, `assertion #${failAt} left the next payload intact`);
      }
      // A valid lease retry always finishes the cleanup.
      await cleanupPayloads(records, { lease: countingLease() });
      assert.deepEqual(await payloadFilesIn(root), [], `retry after #${failAt} completes`);
    }
    await expectTypeError(() => cleanupPayloads("not-an-array", { lease }));
  });
});

test("cleanupPayloadTransients removes only content-proven transients, asserting the lease before each unlink", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const priorBytes = Buffer.from("content");
    await writeFile(context.configTarget, priorBytes, { mode: 0o600 });
    const plans = [{ target: context.configTarget, role: "router-config", afterBytes: Buffer.from("next") }];
    const records = await prepareFilePayloads(TX, plans, { lease: countingLease() });
    // B3: two transients holding exactly the recorded payload bytes - the only
    // form this cleanup can ever prove and remove.
    await writeFile(`${records[0].before.payloadPath}.tmp`, priorBytes, { mode: 0o600 });
    await writeFile(`${records[0].after.payloadPath}.tmp`, Buffer.from("next"), { mode: 0o600 });

    const measure = countingLease();
    const cleaned = await cleanupPayloadTransients(records, { lease: measure });
    assert.equal(cleaned.removed.length, 2, "both content-proven transients are removed");
    const total = measure.state.calls;
    assert.ok(total >= 4, `start, per-unlink, and final assertions (saw ${total})`);

    for (let failAt = 1; failAt < total; failAt += 1) {
      await writeFile(`${records[0].before.payloadPath}.tmp`, priorBytes, { mode: 0o600 });
      await writeFile(`${records[0].after.payloadPath}.tmp`, Buffer.from("next"), { mode: 0o600 });
      const broken = countingLease({ failAt });
      await expectCode(() => cleanupPayloadTransients(records, { lease: broken }), "LOCK_COMPROMISED");
      const remaining = (await payloadFilesIn(root)).filter((name) => name.endsWith(".tmp")).length;
      assert.ok(remaining >= 1, `assertion #${failAt} left a transient intact`);
      await cleanupPayloadTransients(records, { lease: countingLease() });
      assert.deepEqual(
        (await payloadFilesIn(root)).filter((name) => name.endsWith(".tmp")),
        [],
        `retry after #${failAt} completes`,
      );
    }

    // B3: a partial (interrupted-write) or content-foreign transient is never
    // "owned" by its derived pathname: it is preserved, and the cleanup still
    // succeeds for everything else.
    await writeFile(`${records[0].before.payloadPath}.tmp`, Buffer.from("half"), { mode: 0o600 });
    await writeFile(`${records[0].after.payloadPath}.tmp`, Buffer.from("not-the-recorded-bytes"), { mode: 0o600 });
    const preserved = await cleanupPayloadTransients(records, { lease: countingLease() });
    assert.deepEqual(preserved.removed, [], "nothing unproven is removed");
    assert.equal(await readFile(`${records[0].before.payloadPath}.tmp`, "utf8"), "half", "the partial transient is preserved");
    assert.equal(
      await readFile(`${records[0].after.payloadPath}.tmp`, "utf8"),
      "not-the-recorded-bytes",
      "the content-foreign transient is preserved",
    );
    await rm(`${records[0].before.payloadPath}.tmp`, { force: true });
    await rm(`${records[0].after.payloadPath}.tmp`, { force: true });
  });
});

/* ================================================================== *
 * Privacy and real-lease integration
 * ================================================================== */

test("journal bytes never contain payload bodies or environment sentinels", async () => {
  await withTemp(async (root) => {
    process.env.SKILL_ROUTER_JOURNAL_SENTINEL = "SENTINEL-env-77aa";
    try {
      const context = projectContext(root);
      const lease = fakeLease();
      const before = Buffer.from(`{"skill":"${SENTINEL}"}`);
      const after = Buffer.from(`{"skill":"${SENTINEL}","v":2}`);
      await writeFile(context.configTarget, before, { mode: 0o600 });

      const records = await prepareFilePayloads(
        TX,
        [{ target: context.configTarget, role: "router-config", afterBytes: after }],
        { lease },
      );
      let journal = await seedJournal(context, managedFixture(context, { files: records, claude: claudeSection(context) }));
      journal = await updateJournal(context.paths, journal, {
        phase: "intent",
        files: journal.files.map((file) => ({ ...file, status: "intent" })),
      }, { lease });

      const onDisk = await readFile(context.paths.journalFile, "utf8");
      const serialized = serializeJournal(journal).toString("utf8");
      for (const text of [onDisk, serialized]) {
        assert.equal(text.includes(SENTINEL), false, "payload body never reaches the journal");
        assert.equal(text.includes("SENTINEL-env-77aa"), false, "environment never reaches the journal");
        assert.equal(text.includes(before.toString("utf8")), false);
      }
      // The payload itself still holds the exact bytes.
      const payload = await readFile(records[0].before.payloadPath, "utf8");
      assert.ok(payload.includes(SENTINEL), "payloads are the only place bodies live");
    } finally {
      delete process.env.SKILL_ROUTER_JOURNAL_SENTINEL;
    }
  });
});

test("the full journal lifecycle works under a real mutation-lock lease", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const lease = await acquireMutationLock(context.paths, { heartbeatMs: 0 });
    try {
      const before = Buffer.from("old-config");
      const after = Buffer.from("new-config");
      await writeFile(context.configTarget, before, { mode: 0o600 });

      const records = await prepareFilePayloads(
        TX,
        [{ target: context.configTarget, role: "router-config", afterBytes: after }],
        { lease },
      );
      let journal = await createJournal(context.paths, managedFixture(context, { files: records }), { lease });
      assert.equal(journal.revision, 0);
      journal = await updateJournal(context.paths, journal, { phase: "intent" }, { lease });
      journal = await updateJournal(context.paths, journal, { phase: "applying" }, { lease });
      await writeFile(context.configTarget, after, { mode: 0o600 });
      journal = await updateJournal(context.paths, journal, { phase: "proven" }, { lease });
      journal = await updateJournal(context.paths, journal, { mode: "committed", phase: "committed" }, { lease });

      assert.equal(await classifyJournalFile(journal.files[0]), "after");
      const cleanup = await cleanupPayloads(journal.files, { lease });
      assert.equal(cleanup.removed.length, 2);

      await removeJournal(context.paths, journal, { lease });
      assert.equal(await readJournal(context.paths, { allowMissing: true }), null);
      assert.deepEqual(await payloadFilesIn(context.paths.controlDirectory), []);
      assert.equal((await lstat(context.paths.controlDirectory)).isDirectory(), true);
    } finally {
      await lease.release();
    }
    await assert.rejects(() => lstat(context.paths.lockDirectory), (error) => error.code === "ENOENT");
  });
});



/* ================================================================== *
 * Phase 6 integration: durable Claude intents (journal.js extension)
 * ================================================================== */

test("journal Claude actions accept a durable intent recorded before its outcome", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const section = claudeSection(context);
    const intent = section.actions.map((action) => {
      const copy = { ...action };
      delete copy.outcome;
      copy.status = "intent";
      return copy;
    });

    // An intent is a legal journal state: the observer must durably record it
    // before the Claude command runs, when no outcome exists yet.
    const pending = managedFixture(context, { claude: { ...section, actions: intent } });
    const validated = validateJournal(pending);
    assert.deepEqual(
      validated.claude.actions.map((entry) => [entry.sequence, entry.status, entry.outcome]),
      [
        [1, "intent", undefined],
        [2, "intent", undefined],
      ],
    );
    assert.ok(Object.isFrozen(validated.claude.actions[0]), "intent actions are rebuilt and frozen");

    // An intent still refuses to carry an outcome...
    expectInvalid(
      () =>
        managedFixture(context, {
          claude: { ...section, actions: [intent[0], { ...intent[1], outcome: { status: "succeeded" } }] },
        }),
      /outcome requires status observed/,
    );
    // ...and an observed action keeps its recorded outcome.
    const observed = validateJournal(managedFixture(context, { claude: section }));
    assert.equal(observed.claude.actions[1].status, "observed");
    assert.equal(observed.claude.actions[1].outcome.status, "succeeded");
  });
});

/* ================================================================== *
 * Phase 14 - a journal is never created where identity cannot be proven
 * ================================================================== */

test("createJournal refuses a filesystem without stable file identity before the journal exists", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    await mkdir(context.paths.controlDirectory, { recursive: true, mode: 0o700 });
    const lease = fakeLease();
    const realLstat = durableFsInternals.lstat;
    await withInternals(
      {
        lstat: async (target) => {
          const stat = await realLstat(target);
          if (path.resolve(target) !== path.resolve(context.paths.controlDirectory)) return stat;
          return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: 0 });
        },
      },
      async () => {
        await expectConflict(
          () => createJournal(context.paths, managedFixture(context), { lease }),
          /stable file identity/,
        );
      },
    );
    assert.deepEqual(await readdir(context.paths.controlDirectory), [], "no journal or payload was created");
    assert.equal(await readJournal(context.paths, { allowMissing: true }), null);
  });
});

/* ================================================================== *
 * Phase 14 / B1 - exact deletion never trusts a path that was verified
 * one step earlier
 * ================================================================== */

test("cleanupPayloads preserves a payload replaced after its final verification (B1)", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const lease = fakeLease();
    const content = Buffer.from("target-content");
    await writeFile(context.configTarget, content, { mode: 0o600 });
    const plans = [{ target: context.configTarget, role: "router-config", afterBytes: Buffer.from("next-content") }];
    const records = await prepareFilePayloads(TX, plans, { lease });
    const payloadPath = records[0].before.payloadPath;

    const realRename = durableFsInternals.rename;
    let swappedClaim = null;
    await withInternals(
      {
        rename: async (from, to) => {
          await realRename(from, to);
          if (path.resolve(from) === path.resolve(payloadPath)) {
            // B1 injection: a hostile same-user replacement appears at the
            // fresh claim right after the rename that created it - the final
            // verification must refuse and the replacement must survive. The
            // claim is renamed aside, not deleted: an inode allocator with
            // eager reuse (ext4 on the Linux runner) can give the replacement
            // the same dev/ino the deleted claim just freed, which would make
            // the swap invisible to the identity recheck.
            swappedClaim = to;
            await rename(to, `${to}.pinned`);
            await writeFile(to, "swapped", { mode: 0o600 });
          }
        },
      },
      async () => {
        await expectConflict(() => cleanupPayloads([records[0]], { lease }), /replaced while it was being removed/);
      },
    );
    assert.ok(swappedClaim, "the removal actually reached the claim rename");
    assert.equal(await readFile(swappedClaim, "utf8"), "swapped", "the replacement survives the refusal");
    assert.equal((await lstat(swappedClaim)).isFile(), true, "nothing was recursively deleted");
    await rm(swappedClaim, { force: true });
  });
});

test("readPayload carries the strong identity of the exact bytes it read (B2/B3)", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const payloadPath = payloadPathFor(context.configTarget, TX, "after");
    const content = Buffer.from("identity-carrying-bytes");
    await writeFile(payloadPath, content, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(payloadPath, 0o600);

    const read = await readPayload(payloadPath, { expectedSha256: sha256Bytes(content) });
    assert.equal(read.identity.status, "available", "the tagged identity travels with the bytes");
    const stat = await lstat(payloadPath);
    assert.equal(read.identity.ino, Number(stat.ino));
    assert.equal(read.identity.dev, Number(stat.dev));

    // classifyJournalFileEntry exposes the same bound identity for CAS use.
    await writeFile(context.configTarget, content, { mode: 0o600 });
    const record = recordFor(context.configTarget, TX, {
      afterDigest: sha256Bytes(content),
      beforeExists: false,
    });
    const classified = await classifyJournalFileEntry(record);
    assert.equal(classified.status, "after");
    assert.equal(classified.identity.status, "available", "classification binds the identity of the bytes it read");
    const targetStat = await lstat(context.configTarget);
    assert.equal(classified.identity.ino, Number(targetStat.ino));
    assert.equal((await classifyJournalFile(record)), "after", "the status-only contract is unchanged");
  });
});

/* ================================================================== *
 * Phase 14 / B4 - payload link topology
 * ================================================================== */

test("B4: readPayload refuses multi-link payloads unless the exact interrupted pair is proven", async () => {
  await withTemp(async (root) => {
    const context = projectContext(root);
    const payloadPath = payloadPathFor(context.configTarget, TX, "after");
    const content = Buffer.from("pair-bytes");
    await writeFile(payloadPath, content, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(payloadPath, 0o600);
    const digest = sha256Bytes(content);

    // A matching-digest hardlink alias that is NOT the derived transient: the
    // payload can no longer be attributed to this journal and is refused (and
    // preserved).
    const alias = path.join(root, "alias.txt");
    await link(payloadPath, alias);
    await expectInvalid(() => readPayload(payloadPath, { expectedSha256: digest }), /exactly one link/);
    // Even the explicit pair allowance accepts only the derived transient.
    await expectInvalid(
      () => readPayload(payloadPath, { expectedSha256: digest, allowLinkedPair: alias }),
      /unproven extra link/,
    );
    await rm(alias, { force: true });

    // The proven interrupted publish pair: payload + its derived transient,
    // one inode, exactly two links - accepted only through the allowance.
    const transient = payloadTransientPath(payloadPath);
    await link(payloadPath, transient);
    await expectInvalid(() => readPayload(payloadPath, { expectedSha256: digest }), /exactly one link/);
    const pair = await readPayload(payloadPath, { expectedSha256: digest, allowLinkedPair: transient });
    assert.ok(pair.bytes.equals(content), "the proven pair member reads exactly");
    assert.equal(pair.identity.status, "available");

    // Aliasing mutation: writing through either name mutates the shared bytes,
    // and the recorded digest then refuses the payload for every caller.
    await writeFile(transient, "mutated-through-the-alias", { mode: 0o600 });
    await expectConflict(
      () => readPayload(payloadPath, { expectedSha256: digest, allowLinkedPair: transient }),
      /recorded digest/,
    );
  });
});
