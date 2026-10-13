import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildInstallation,
  CLAUDE_PLUGINS,
  claudeFingerprint,
  claudeIdentity,
  claudeMarketplaceName,
  DEFAULT_CLAUDE_VERSION,
  directoryExists,
  installationProblems,
  isOwnedMarkerContent,
  normalizeHarnesses,
  normalizeSemver,
  parseInstallation,
  readInstallation,
  readOwnedInstallationForRemoval,
  requestedHarnesses,
  resolveClaudeVersion,
  ROUTER_PACKAGE_VERSION,
  selectHarnesses,
  STATE_MARKER_CONTENT,
  STATE_MARKER_FILE,
  validateInstallation,
} from "../src/installation.js";

const PROJECT_STATE = "/srv/workspace/.skill-router";
const GLOBAL_STATE = "/home/agent/.local/share/skill-router";

test("explicit harness selections validate and expand before any union", () => {
  assert.deepEqual(requestedHarnesses(undefined), []);
  assert.deepEqual(requestedHarnesses("opencode"), ["opencode"]);
  assert.deepEqual(requestedHarnesses("claude"), ["claude"]);
  assert.deepEqual(requestedHarnesses("all"), ["opencode", "claude"]);
  assert.throws(() => requestedHarnesses("codex"), /Unsupported harness: codex/);
});

test("harness union is deterministic, additive, and defaults to OpenCode-only", () => {
  assert.deepEqual(selectHarnesses({}), ["opencode"]);
  assert.deepEqual(selectHarnesses({ requested: [] }), ["opencode"]);
  assert.deepEqual(selectHarnesses({ stateExists: true }), ["opencode"]);
  assert.deepEqual(selectHarnesses({ requested: ["claude"] }), ["claude"]);
  assert.deepEqual(selectHarnesses({ recorded: ["claude"], stateExists: true }), ["claude"]);
  assert.deepEqual(selectHarnesses({ recorded: ["opencode", "claude"] }), ["opencode", "claude"]);
  assert.deepEqual(selectHarnesses({ recorded: ["claude"], requested: ["opencode"] }), ["opencode", "claude"]);
  assert.deepEqual(selectHarnesses({ recorded: ["opencode"], requested: ["claude"] }), ["opencode", "claude"]);
  assert.throws(() => selectHarnesses({ requested: ["codex"] }), /Unsupported harness: codex/);
  assert.deepEqual(normalizeHarnesses(["claude", "opencode"]), ["opencode", "claude"]);
  assert.throws(() => normalizeHarnesses(["opencode", "opencode"]), /more than once/);
  assert.throws(() => normalizeHarnesses([]), /at least one harness/);
  assert.throws(() => normalizeHarnesses(["codex"]), /Unsupported harness: codex/);
});

test("marketplace identity is a stable hash of scope and canonical state path", () => {
  const project = claudeIdentity({ global: false, stateDirectory: PROJECT_STATE });
  const global = claudeIdentity({ global: true, stateDirectory: GLOBAL_STATE });
  assert.equal(project.scope, "project");
  assert.equal(project.claudeScope, "local");
  assert.equal(project.plugin, CLAUDE_PLUGINS.project);
  assert.equal(global.scope, "global");
  assert.equal(global.claudeScope, "user");
  assert.equal(global.plugin, CLAUDE_PLUGINS.global);
  assert.match(project.marketplace, /^skill-router-[0-9a-f]{24}$/);
  assert.notEqual(project.marketplace, global.marketplace);
  assert.equal(
    project.marketplace,
    claudeIdentity({ global: false, stateDirectory: `${PROJECT_STATE}/` }).marketplace,
    "the hash must survive trailing-path differences",
  );
  assert.notEqual(
    project.marketplace,
    claudeMarketplaceName("global", PROJECT_STATE),
    "the hash must depend on scope",
  );
  assert.notEqual(
    project.marketplace,
    claudeMarketplaceName("project", "/elsewhere/.skill-router"),
    "the hash must depend on the state path",
  );
});

test("Claude fingerprints are deterministic over content and identity", () => {
  const identity = claudeIdentity({ global: false, stateDirectory: PROJECT_STATE });
  const entries = [
    { path: "claude/b.md", sha256: "b".repeat(64) },
    { path: "claude/a.md", sha256: "a".repeat(64) },
  ];
  const first = claudeFingerprint(identity, entries);
  assert.equal(first, claudeFingerprint(identity, [...entries].reverse()));
  assert.equal(first.length, 64);
  assert.notEqual(first, claudeFingerprint(identity, [{ path: "claude/a.md", sha256: "c".repeat(64) }]));
  assert.notEqual(first, claudeFingerprint(identity, [{ path: "claude/z.md", sha256: "a".repeat(64) }]));
  assert.notEqual(
    first,
    claudeFingerprint(claudeIdentity({ global: true, stateDirectory: PROJECT_STATE }), entries),
  );
});

test("plugin versions stay put for identical content and advance on change", () => {
  const fingerprint = "d".repeat(64);
  assert.equal(resolveClaudeVersion(null, fingerprint), ROUTER_PACKAGE_VERSION);
  assert.equal(resolveClaudeVersion(null, fingerprint, "2.3.4"), "2.3.4");
  assert.equal(resolveClaudeVersion(null, fingerprint, "2.3.4-rc.1+meta"), "2.3.4");
  assert.equal(resolveClaudeVersion(null, fingerprint, undefined), ROUTER_PACKAGE_VERSION);
  assert.equal(resolveClaudeVersion(null, fingerprint, DEFAULT_CLAUDE_VERSION), DEFAULT_CLAUDE_VERSION);
  assert.equal(resolveClaudeVersion(null, fingerprint, "not-a-version"), DEFAULT_CLAUDE_VERSION);
  assert.equal(resolveClaudeVersion({ fingerprint, version: "0.1.0" }, fingerprint), "0.1.0");
  assert.equal(resolveClaudeVersion({ fingerprint: "e".repeat(64), version: "0.1.0" }, fingerprint), "0.1.1");
  assert.equal(resolveClaudeVersion({ fingerprint: "e".repeat(64), version: "2.9.3" }, fingerprint), "2.9.4");
  assert.equal(resolveClaudeVersion({ fingerprint, version: "not-a-version" }, fingerprint), ROUTER_PACKAGE_VERSION);
});

test("the base plugin version is read from package.json, not hard-coded", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(ROUTER_PACKAGE_VERSION, packageJson.version);
  assert.match(ROUTER_PACKAGE_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(normalizeSemver("1.2.3-beta.4+build.5"), "1.2.3");
  assert.equal(normalizeSemver("0.1"), null);
  assert.equal(normalizeSemver(undefined), null);
  // The value is derived at runtime from the packaged manifest, so a version
  // bump in package.json cannot leave a stale literal behind.
  const source = await readFile(new URL("../src/installation.js", import.meta.url), "utf8");
  assert.match(source, /require\("\.\.\/package\.json"\)/);
  assert.doesNotMatch(source, /ROUTER_PACKAGE_VERSION = "\d+\.\d+\.\d+"/);
});

function projectInstallation(extra = {}) {
  const identity = claudeIdentity({ global: false, stateDirectory: PROJECT_STATE });
  return {
    schemaVersion: 1,
    owner: "skill-router",
    scope: "project",
    stateDirectory: PROJECT_STATE,
    harnesses: ["opencode", "claude"],
    claude: {
      scope: identity.claudeScope,
      plugin: identity.plugin,
      marketplace: identity.marketplace,
      fingerprint: "f".repeat(64),
      version: "0.1.0",
    },
    ...extra,
  };
}

test("installation metadata validates ownership, scope, and Claude identity", () => {
  assert.doesNotThrow(() => validateInstallation(projectInstallation()));
  assert.doesNotThrow(() =>
    validateInstallation({
      schemaVersion: 1,
      owner: "skill-router",
      scope: "project",
      stateDirectory: PROJECT_STATE,
      harnesses: ["opencode"],
    }),
  );

  const invalid = [
    [{ ...projectInstallation(), owner: "someone-else" }, /owner must be "skill-router"/],
    [{ ...projectInstallation(), schemaVersion: 2 }, /schemaVersion must be 1/],
    [{ ...projectInstallation(), harnesses: ["codex"] }, /Unsupported harness: codex/],
    [{ ...projectInstallation(), harnesses: ["claude", "claude"] }, /more than once/],
    [{ ...projectInstallation(), stateDirectory: "relative/state" }, /absolute path/],
    [{ ...projectInstallation(), extra: true }, /unknown key: extra/],
    [{ ...projectInstallation(), scope: "local" }, /scope must be project or global/],
    [projectInstallation({ claude: undefined }), /requires Claude plugin metadata|claude must be an object/],
    [
      projectInstallation({ claude: { ...projectInstallation().claude, plugin: "other-plugin" } }),
      /claude\.plugin must be "openagency-skill-router"/,
    ],
    [
      projectInstallation({ claude: { ...projectInstallation().claude, scope: "user" } }),
      /claude\.scope must be "local"/,
    ],
    [
      projectInstallation({ claude: { ...projectInstallation().claude, marketplace: "skill-router-000000000000000000000000" } }),
      /does not match the scoped state-path hash/,
    ],
    [
      projectInstallation({ claude: { ...projectInstallation().claude, fingerprint: "short" } }),
      /sha256 hex digest/,
    ],
    [
      projectInstallation({ claude: { ...projectInstallation().claude, version: "0.1" } }),
      /semantic version/,
    ],
    [
      projectInstallation({ claude: { ...projectInstallation().claude, hooks: {} } }),
      /unknown claude key: hooks/,
    ],
    [
      {
        schemaVersion: 1,
        owner: "skill-router",
        scope: "project",
        stateDirectory: PROJECT_STATE,
        harnesses: ["opencode"],
        claude: projectInstallation().claude,
      },
      /without the claude harness/,
    ],
  ];
  for (const [document, pattern] of invalid) {
    assert.throws(() => validateInstallation(document), pattern);
  }
});

test("buildInstallation writes canonical ownership metadata", () => {
  const document = buildInstallation({
    global: false,
    stateDirectory: `${PROJECT_STATE}/`,
    harnesses: ["claude", "opencode"],
    claude: { fingerprint: "f".repeat(64), version: "0.1.0" },
  });
  assert.deepEqual(document, projectInstallation());
  assert.doesNotThrow(() => validateInstallation(document));
  assert.throws(
    () =>
      buildInstallation({
        global: false,
        stateDirectory: PROJECT_STATE,
        harnesses: ["claude"],
      }),
    /requires Claude plugin metadata/,
  );
  assert.throws(
    () =>
      buildInstallation({
        global: false,
        stateDirectory: PROJECT_STATE,
        harnesses: ["opencode"],
        claude: { fingerprint: "a".repeat(64), version: "0.1.0" },
      }),
    /without the claude harness/,
  );
  const global = buildInstallation({
    global: true,
    stateDirectory: GLOBAL_STATE,
    harnesses: ["claude"],
    claude: { fingerprint: "b".repeat(64), version: "0.1.0" },
  });
  assert.equal(global.scope, "global");
  assert.equal(global.claude.scope, "user");
  assert.equal(global.claude.plugin, CLAUDE_PLUGINS.global);
});

test("installation documents parse strictly and report file-scoped errors", () => {
  const text = `${JSON.stringify(projectInstallation(), null, 2)}\n`;
  assert.equal(parseInstallation(text).schemaVersion, 1);
  assert.throws(() => parseInstallation("{", "installation.json"), /Invalid installation JSON at installation.json/);
  assert.throws(
    () => parseInstallation(JSON.stringify({ schemaVersion: 1 }), "installation.json"),
    /Invalid installation metadata at installation.json/,
  );
});

test("legacy state infers OpenCode-only and ownership problems are reported", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-installation-"));
  const state = path.join(root, ".skill-router");
  const installation = buildInstallation({
    global: false,
    stateDirectory: state,
    harnesses: ["opencode", "claude"],
    claude: { fingerprint: "f".repeat(64), version: "0.1.0" },
  });
  try {
    await mkdir(state, { recursive: true });
    assert.equal(await readInstallation(state), null);
    assert.equal(await directoryExists(state), true);
    const legacy = await installationProblems(state, { global: false });
    assert.equal(legacy.legacy, true);
    assert.deepEqual(legacy.problems, []);
    assert.equal(legacy.installation, null);

    await writeFile(path.join(state, "installation.json"), `${JSON.stringify(installation, null, 2)}\n`);
    const recorded = await installationProblems(state, { global: false });
    assert.equal(recorded.legacy, false);
    assert.deepEqual(recorded.problems, []);

    const wrongScope = await installationProblems(state, { global: true });
    assert.match(wrongScope.problems.join("\n"), /scope is project, expected global/);

    await writeFile(path.join(state, "installation.json"), "{ nope");
    const broken = await installationProblems(state, { global: false });
    assert.match(broken.problems.join("\n"), /Invalid installation JSON/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installation metadata never loads through a symlink", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-installation-"));
  const state = path.join(root, "state");
  const target = path.join(root, "installation.json");
  try {
    await mkdir(state, { recursive: true });
    await writeFile(target, `${JSON.stringify(projectInstallation(), null, 2)}\n`);
    await symlink(target, path.join(state, "installation.json"));
    await assert.rejects(() => readInstallation(state), /not a regular file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function removalState(root, { marker = `${STATE_MARKER_CONTENT}\n`, name = ".skill-router" } = {}) {
  const state = path.join(root, name);
  await mkdir(state, { recursive: true });
  if (marker !== null) await writeFile(path.join(state, STATE_MARKER_FILE), marker);
  return state;
}

test("removal inspection reports absent only when the state path truly does not exist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-removal-"));
  try {
    assert.deepEqual(await readOwnedInstallationForRemoval(path.join(root, "missing"), { global: false }), {
      status: "absent",
    });

    const fileState = path.join(root, "file-state");
    await writeFile(fileState, "not a directory");
    await assert.rejects(() => readOwnedInstallationForRemoval(fileState, { global: false }), /not a directory/);

    const linkState = path.join(root, "link-state");
    await symlink(path.join(root, "dangling-target"), linkState);
    await assert.rejects(() => readOwnedInstallationForRemoval(linkState, { global: false }), /symlink/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removal inspection refuses missing, symlinked, padded, and foreign ownership markers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-removal-"));
  try {
    const unowned = await removalState(root, { marker: null });
    await assert.rejects(() => readOwnedInstallationForRemoval(unowned, { global: false }), /Refusing unowned router state/);

    const foreign = await removalState(root, { name: "foreign", marker: "someone-else-state-v1" });
    await assert.rejects(() => readOwnedInstallationForRemoval(foreign, { global: false }), /does not match the recorded content/);

    const padded = await removalState(root, { name: "padded", marker: `  ${STATE_MARKER_CONTENT}  \n` });
    await assert.rejects(() => readOwnedInstallationForRemoval(padded, { global: false }), /does not match the recorded content/);

    const extended = await removalState(root, { name: "extended", marker: `${STATE_MARKER_CONTENT}\nextra\n` });
    await assert.rejects(() => readOwnedInstallationForRemoval(extended, { global: false }), /does not match the recorded content/);

    const state = await removalState(root, { name: "linked-marker", marker: null });
    const target = path.join(root, "marker-target");
    await writeFile(target, `${STATE_MARKER_CONTENT}\n`);
    await symlink(target, path.join(state, STATE_MARKER_FILE));
    await assert.rejects(() => readOwnedInstallationForRemoval(state, { global: false }), /not a regular file/);

    assert.equal(isOwnedMarkerContent(STATE_MARKER_CONTENT), true);
    assert.equal(isOwnedMarkerContent(`${STATE_MARKER_CONTENT}\n`), true);
    assert.equal(isOwnedMarkerContent(`${STATE_MARKER_CONTENT}\r\n`), false);
    assert.equal(isOwnedMarkerContent(undefined), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy marker-owned state is reported as OpenCode-only with a stable state identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-removal-"));
  try {
    const state = await removalState(root);
    const owned = await readOwnedInstallationForRemoval(state, { global: false });
    assert.equal(owned.status, "owned");
    assert.equal(owned.legacy, true);
    assert.equal(owned.installation, null);
    assert.deepEqual(owned.harnesses, ["opencode"]);
    const stateStat = await stat(state);
    if (stateStat.ino === 0) {
      assert.deepEqual(owned.stateIdentity, { path: path.resolve(state) });
    } else {
      assert.deepEqual(owned.stateIdentity, { path: path.resolve(state), dev: stateStat.dev, ino: stateStat.ino });
    }
    assert.deepEqual(await readOwnedInstallationForRemoval(`${state}/`, { global: false }), owned);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removal inspection requires metadata that matches the scope and the resolved state path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-removal-"));
  try {
    const state = await removalState(root);
    const installation = buildInstallation({
      global: false,
      stateDirectory: `${state}/`,
      harnesses: ["claude", "opencode"],
      claude: { fingerprint: "f".repeat(64), version: "0.1.0" },
    });
    await writeFile(path.join(state, "installation.json"), `${JSON.stringify(installation, null, 2)}\n`);

    const owned = await readOwnedInstallationForRemoval(state, { global: false });
    assert.equal(owned.legacy, false);
    assert.deepEqual(owned.harnesses, ["opencode", "claude"]);
    assert.equal(owned.installation.scope, "project");
    assert.equal(owned.stateIdentity.path, path.resolve(state));

    await assert.rejects(() => readOwnedInstallationForRemoval(state, { global: true }), /scope is project, expected global/);

    const foreignPath = buildInstallation({
      global: false,
      stateDirectory: path.join(root, "elsewhere"),
      harnesses: ["opencode"],
    });
    await writeFile(path.join(state, "installation.json"), `${JSON.stringify(foreignPath, null, 2)}\n`);
    await assert.rejects(() => readOwnedInstallationForRemoval(state, { global: false }), /stateDirectory does not match/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removal inspection refuses malformed and symlinked installation metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-removal-"));
  try {
    const state = await removalState(root);
    const file = path.join(state, "installation.json");

    await writeFile(file, "{ nope");
    await assert.rejects(() => readOwnedInstallationForRemoval(state, { global: false }), /Invalid installation/);

    await rm(file, { force: true });
    const target = path.join(root, "installation-target.json");
    await writeFile(
      target,
      `${JSON.stringify(buildInstallation({ global: false, stateDirectory: state, harnesses: ["opencode"] }), null, 2)}\n`,
    );
    await symlink(target, file);
    await assert.rejects(() => readOwnedInstallationForRemoval(state, { global: false }), /not a regular file/);

    await rm(file, { force: true });
    await writeFile(
      file,
      `${JSON.stringify({ ...buildInstallation({ global: false, stateDirectory: state, harnesses: ["opencode"] }), extra: true }, null, 2)}\n`,
    );
    await assert.rejects(() => readOwnedInstallationForRemoval(state, { global: false }), /unknown key: extra/);

    await rm(file, { force: true });
    await mkdir(file);
    await assert.rejects(() => readOwnedInstallationForRemoval(state, { global: false }), /not a regular file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
