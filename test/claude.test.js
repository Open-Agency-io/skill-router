// MUST stay the first import: ES modules evaluate imports in source order, so
// this side-effect module snapshots the host Claude files and replaces
// HOME/USERPROFILE/CLAUDE_CONFIG_DIR (and the other ambient roots) with a
// private temp directory before any other import body or test in this file
// runs. See `test/claude-test-isolation.mjs`.
import { claudeTestIsolation, isInsidePath } from "./claude-test-isolation.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  boundClaudeMessage,
  captureClaudeState,
  claudeBinary,
  claudeMarketplaceSettingsFile,
  claudeRegistrationPlan,
  claudeRemovalPlan,
  classifyClaudeUninstallState,
  compensateClaude,
  detachClaude,
  execClaude,
  fileModeBitsMeaningful,
  FINGERPRINT_SIDECAR,
  FINGERPRINT_SIDECAR_LIMITS,
  FINGERPRINT_SIDECAR_MODE,
  fingerprintSidecarText,
  inspectGeneratedClaudeRemovalSource,
  MANAGED_REGISTRY_ID_ERROR,
  observeClaudeUninstallState,
  parseFingerprintSidecar,
  planClaudePlugin,
  readFingerprintSidecar,
  registerClaude,
  restoreClaudeAfterDetach,
  stageClaudePlugin,
  claudeInternals,
  verifyClaudePluginFiles,
  verifyClaudeRegistration,
} from "../src/claude.js";
import { parse, parseDocument } from "yaml";
import { buildInstallation, claudeFingerprint, claudeIdentity, ROUTER_PACKAGE_VERSION } from "../src/installation.js";
import { parseFrontmatter } from "../src/frontmatter.js";
import { splitSkillDocument } from "../src/skill-document.js";
import { createFakeClaudeRunner, pluginBelongsToMarketplace, writeFakeClaudeBin } from "./fake-claude.js";

const PLUGIN = "openagency-skill-router";

/**
 * Stable absolute request spool path embedded in every generated router
 * instruction in these tests. Planning never touches it: it is only ever
 * rendered into the generated skill text (and therefore the fingerprint).
 */
const REQUEST_DIRECTORY = path.join(path.resolve(os.tmpdir()), "skill-router-requests");

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "skill-router-claude-"));
  const state = path.join(directory, ".skill-router");
  await mkdir(state, { recursive: true });
  return { directory, state };
}

async function writeSkill(directory, id, frontmatter, body = `${id} instructions.\n`) {
  const file = path.join(directory, `${id}.md`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `---\n${frontmatter}---\n\n${body}`);
  return file;
}

function skillEntry(id, source, description, extra = {}) {
  return { id, description, source, enabled: true, ...extra };
}

test("plans an inert plugin with an exact marketplace layout", async () => {
  const { directory, state } = await fixture();
  try {
    const source = await writeSkill(
      directory,
      "release",
      "name: Release Display\ndescription: Publish a release\nlicense: MIT\nmetadata:\n  opencode/autoinvoke: false\n",
    );
    const identity = claudeIdentity({ global: false, stateDirectory: state });
    const plan = await planClaudePlugin({
      requestDirectory: REQUEST_DIRECTORY,
      registry: { skills: [skillEntry("release", source, "Publish a release")] },
      identity,
      stateDirectory: state,
    });

    assert.deepEqual(
      plan.entries.map((entry) => entry.path).sort(),
      [
        `claude/.claude-plugin/marketplace.json`,
        `claude/plugins/${PLUGIN}/.claude-plugin/plugin.json`,
        `claude/plugins/${PLUGIN}/skills/release/SKILL.md`,
        `claude/plugins/${PLUGIN}/skills/skill-router/SKILL.md`,
      ].sort(),
    );

    const pluginManifest = JSON.parse(
      plan.entries.find((entry) => entry.path.endsWith("plugin.json")).content,
    );
    assert.deepEqual(Object.keys(pluginManifest).sort(), ["author", "description", "name", "version"]);
    assert.equal(pluginManifest.name, PLUGIN);
    assert.equal(pluginManifest.version, ROUTER_PACKAGE_VERSION);
    assert.deepEqual(pluginManifest.author, { name: "skill-router" });
    for (const forbidden of [
      "hooks",
      "mcpServers",
      "commands",
      "agents",
      "dependencies",
      "scripts",
      "executable",
      "source",
      "path",
      "settings",
    ]) {
      assert.equal(Object.hasOwn(pluginManifest, forbidden), false, `${forbidden} must not be declared`);
    }

    const marketplace = JSON.parse(
      plan.entries.find((entry) => entry.path.endsWith("marketplace.json")).content,
    );
    assert.deepEqual(Object.keys(marketplace).sort(), ["description", "name", "owner", "plugins"]);
    assert.equal(marketplace.name, identity.marketplace);
    assert.equal(marketplace.plugins.length, 1);
    assert.deepEqual(marketplace.plugins[0], {
      name: PLUGIN,
      source: `./plugins/${PLUGIN}`,
      version: ROUTER_PACKAGE_VERSION,
      description: pluginManifest.description,
    });

    assert.match(plan.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(plan.skills.length, 1);
    assert.equal(plan.skills[0].namespaced, `${PLUGIN}:release`);
    assert.equal(plan.registration.reference, `${PLUGIN}@${identity.marketplace}`);
    assert.equal(plan.registration.scope, "local");

    await stageClaudePlugin(plan, state);
    assert.deepEqual(await verifyClaudePluginFiles({ plan, stateDirectory: state }), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("renders Claude skills from source documents with preserved semantics", async () => {
  const { directory, state } = await fixture();
  try {
    const source = path.join(directory, "review", "SKILL.md");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(
      source,
      [
        "---",
        "# retained comment",
        "name: Review Display Name",
        'description: "Review code carefully"',
        "license: Apache-2.0",
        "allowed-tools: [Read, Grep]",
        "metadata:",
        "  opencode/autoinvoke: false",
        "  tier: 2",
        "---",
        "",
        "Review it line by line.",
        "",
        "## Details",
        "",
        "Keep this body byte for byte.",
        "",
      ].join("\n"),
    );
    const identity = claudeIdentity({ global: false, stateDirectory: state });
    const plan = await planClaudePlugin({
      requestDirectory: REQUEST_DIRECTORY,
      registry: { skills: [skillEntry("review", source, "Effective routing description")] },
      identity,
      stateDirectory: state,
    });

    const rendered = plan.entries.find(
      (entry) => entry.path === `claude/plugins/${PLUGIN}/skills/review/SKILL.md`,
    ).content;
    const parsed = parseFrontmatter(rendered);
    assert.equal(parsed.attributes.name, "review");
    assert.equal(parsed.attributes.description, "Effective routing description");
    assert.equal(parsed.attributes.license, "Apache-2.0");
    assert.deepEqual(parse(splitSkillDocument(rendered).yaml)["allowed-tools"], ["Read", "Grep"]);
    assert.deepEqual({ ...parsed.attributes.metadata }, { "opencode/autoinvoke": false, tier: 2 });
    assert.match(rendered, /# retained comment/);
    assert.equal(parsed.body, "\nReview it line by line.\n\n## Details\n\nKeep this body byte for byte.\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects incompatible, symlinked, and special skill sources", async () => {
  const { directory, state } = await fixture();
  try {
    const identity = claudeIdentity({ global: false, stateDirectory: state });
    const disabled = await writeSkill(
      directory,
      "disabled",
      "name: Disabled\ndescription: Cannot be invoked\nmetadata:\n  tier: 1\ndisable-model-invocation: true\n",
    );
    await assert.rejects(
      planClaudePlugin({
        requestDirectory: REQUEST_DIRECTORY,
        registry: { skills: [skillEntry("disabled", disabled, "Cannot be invoked")] },
        identity,
        stateDirectory: state,
      }),
      /disable-model-invocation: true, which is incompatible/,
    );
    const linkTarget = await writeSkill(directory, "linked", "name: Linked\ndescription: Linked skill\n");
    const link = path.join(directory, "linked-skill.md");
    await symlink(linkTarget, link);
    await assert.rejects(
      planClaudePlugin({
        requestDirectory: REQUEST_DIRECTORY,
        registry: { skills: [skillEntry("linked", link, "Linked skill")] },
        identity,
        stateDirectory: state,
      }),
      /must not be a symlink/,
    );

    const skillDirectory = path.join(directory, "tree", "SKILL.md");
    await mkdir(path.dirname(skillDirectory), { recursive: true });
    await writeFile(skillDirectory, "---\nname: Tree\ndescription: Support tree\n---\n\nBody.\n");
    await writeFile(path.join(directory, "tree", "reference.md"), "keep\n");
    await symlink(path.join(directory, "tree", "reference.md"), path.join(directory, "tree", "alias.md"));
    await assert.rejects(
      planClaudePlugin({
        requestDirectory: REQUEST_DIRECTORY,
        registry: { skills: [skillEntry("tree", skillDirectory, "Support tree")] },
        identity,
        stateDirectory: state,
      }),
      /Support file must not be a symlink/,
    );
    await rm(path.join(directory, "tree", "alias.md"));

    const fifoSupported = spawnSync("mkfifo", [path.join(directory, "tree", "pipe")]).status === 0;
    if (fifoSupported) {
      await assert.rejects(
        planClaudePlugin({
          requestDirectory: REQUEST_DIRECTORY,
          registry: { skills: [skillEntry("tree", skillDirectory, "Support tree")] },
          identity,
          stateDirectory: state,
        }),
        /Unsupported support file/,
      );
      await rm(path.join(directory, "tree", "pipe"));
    }

    const staged = await planClaudePlugin({
      requestDirectory: REQUEST_DIRECTORY,
      registry: { skills: [skillEntry("tree", skillDirectory, "Support tree")] },
      identity,
      stateDirectory: state,
    });
    await stageClaudePlugin(staged, state);
    assert.deepEqual(await verifyClaudePluginFiles({ plan: staged, stateDirectory: state }), []);
    const copied = await readFile(
      path.join(state, `claude/plugins/${PLUGIN}/skills/tree/reference.md`),
      "utf8",
    );
    assert.equal(copied, "keep\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("maps bare route IDs and workflow steps into the plugin namespace", async () => {
  const { directory, state } = await fixture();
  try {
    const release = await writeSkill(directory, "release", "name: Release\ndescription: Publish\n");
    const review = await writeSkill(directory, "review", "name: Review\ndescription: Review\n");
    const registry = {
      skills: [skillEntry("release", release, "Publish"), skillEntry("review", review, "Review")],
      workflows: [{ id: "ship", steps: [{ skill: "release" }, { skill: "review" }] }],
    };
    const project = await planClaudePlugin({
      requestDirectory: REQUEST_DIRECTORY,
      registry,
      identity: claudeIdentity({ global: false, stateDirectory: state }),
      stateDirectory: state,
    });
    const projectRouter = project.entries.find((entry) => entry.path.endsWith("skills/skill-router/SKILL.md"))
      .content;
    assert.match(projectRouter, /`skill-router route --json --root \./);
    assert.match(projectRouter, /- `release` → `openagency-skill-router:release`/);
    assert.match(projectRouter, /- `review` → `openagency-skill-router:review`/);
    assert.match(projectRouter, /`steps\[\]\.skillId` with the\nsame `openagency-skill-router:` prefix/);
    assert.match(projectRouter, /- `select`: load `openagency-skill-router:<skillId>`/);
    assert.match(projectRouter, /Never auto-follow `handoffs`/);
    for (const outcome of ["select", "sequence", "advise", "clarify", "none"]) {
      assert.ok(projectRouter.includes(`\`${outcome}\``), `router skill must document ${outcome}`);
    }

    const globalPlan = await planClaudePlugin({
      requestDirectory: REQUEST_DIRECTORY,
      registry,
      identity: claudeIdentity({ global: true, stateDirectory: state }),
      stateDirectory: state,
    });
    const globalRouter = globalPlan.entries.find((entry) =>
      entry.path.endsWith("skills/skill-router/SKILL.md"),
    ).content;
    assert.match(globalRouter, /`skill-router route --json --global/);
    assert.match(globalRouter, /- `release` → `openagency-skill-router-global:release`/);
    assert.equal(globalPlan.identity.plugin, "openagency-skill-router-global");
    assert.equal(globalPlan.registration.scope, "user");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("planning is deterministic and only content changes advance the version", async () => {
  const { directory, state } = await fixture();
  try {
    const source = await writeSkill(directory, "release", "name: Release\ndescription: Publish\n");
    const identity = claudeIdentity({ global: false, stateDirectory: state });
    const registry = () => ({ skills: [skillEntry("release", source, "Publish")] });

    const first = await planClaudePlugin({ requestDirectory: REQUEST_DIRECTORY, registry: registry(), identity, stateDirectory: state });
    const repeat = await planClaudePlugin({ requestDirectory: REQUEST_DIRECTORY, registry: registry(), identity, stateDirectory: state });
    assert.equal(first.fingerprint, repeat.fingerprint);
    assert.equal(first.version, ROUTER_PACKAGE_VERSION, "a fresh plugin starts at the package version");

    const withRecord = await planClaudePlugin({
      requestDirectory: REQUEST_DIRECTORY,
      registry: registry(),
      identity,
      stateDirectory: state,
      recorded: { fingerprint: first.fingerprint, version: "0.1.0" },
    });
    assert.equal(withRecord.version, "0.1.0");

    await writeFile(source, "---\nname: Release\ndescription: Publish now\n---\n\nBody v2.\n");
    const changed = await planClaudePlugin({
      requestDirectory: REQUEST_DIRECTORY,
      registry: registry(),
      identity,
      stateDirectory: state,
      recorded: { fingerprint: first.fingerprint, version: "0.1.0" },
    });
    assert.notEqual(changed.fingerprint, first.fingerprint);
    assert.equal(changed.version, "0.1.1");

    const recordedView = await planClaudePlugin({
      requestDirectory: REQUEST_DIRECTORY,
      registry: registry(),
      identity,
      stateDirectory: state,
      recorded: { fingerprint: first.fingerprint, version: "0.1.0" },
      versionMode: "recorded",
    });
    assert.equal(recordedView.version, "0.1.0");
    await assert.rejects(
      planClaudePlugin({
        requestDirectory: REQUEST_DIRECTORY,
        registry: registry(),
        identity,
        stateDirectory: state,
        recorded: null,
        versionMode: "recorded",
      }),
      /version is missing or invalid/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("single-file skills become skill directories without a support tree", async () => {
  const { directory, state } = await fixture();
  try {
    const source = await writeSkill(directory, "solo", "name: Solo\ndescription: Solo skill\n");
    const plan = await planClaudePlugin({
      requestDirectory: REQUEST_DIRECTORY,
      registry: { skills: [skillEntry("solo", source, "Solo skill")] },
      identity: claudeIdentity({ global: false, stateDirectory: state }),
      stateDirectory: state,
    });
    assert.deepEqual(plan.entries.map((entry) => entry.path).sort(), [
      `claude/.claude-plugin/marketplace.json`,
      `claude/plugins/${PLUGIN}/.claude-plugin/plugin.json`,
      `claude/plugins/${PLUGIN}/skills/skill-router/SKILL.md`,
      `claude/plugins/${PLUGIN}/skills/solo/SKILL.md`,
    ].sort());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * Mirror of the scope-owned declaration file the fake CLI writes.
 *
 * The document is published with a `rename` over the target, never with an
 * in-place truncate/write, so a reader that runs while a rewrite is in
 * flight — including the next step of the refusal loop below — observes
 * either the previous complete document or the new one, never a half-written
 * file (which parses as "not valid JSON"). `beforePublish` is a test-only
 * observation point between the fully written temporary file and the rename.
 */
let declarationWrites = 0;
async function writeDeclaration(cwd, name, directory, { beforePublish } = {}) {
  const file = path.join(cwd, ".claude", "settings.local.json");
  await mkdir(path.dirname(file), { recursive: true });
  const document = `${JSON.stringify({ extraKnownMarketplaces: { [name]: { source: { source: "directory", path: directory } } } }, null, 2)}\n`;
  const temporary = path.join(path.dirname(file), `settings.local.json.${process.pid}-${++declarationWrites}.tmp`);
  await writeFile(temporary, document);
  try {
    await beforePublish?.();
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function declarationPath(cwd) {
  try {
    const document = JSON.parse(await readFile(path.join(cwd, ".claude", "settings.local.json"), "utf8"));
    const entry = document.extraKnownMarketplaces?.[Object.keys(document.extraKnownMarketplaces ?? {})[0]];
    return entry?.source?.path ?? null;
  } catch {
    return null;
  }
}

test("registers through exact commands with an explicit root cwd", async () => {
  const { directory, state } = await fixture();
  try {
    const source = await writeSkill(directory, "release", "name: Release\ndescription: Publish\n");
    const identity = claudeIdentity({ global: false, stateDirectory: state });
    const plan = await planClaudePlugin({
      requestDirectory: REQUEST_DIRECTORY,
      registry: { skills: [skillEntry("release", source, "Publish")] },
      identity,
      stateDirectory: state,
    });
    await stageClaudePlugin(plan, state);
    const root = path.join(directory, "router-root");
    await mkdir(root, { recursive: true });

    const runner = createFakeClaudeRunner();
    const actions = [];
    await registerClaude({ plan: plan.registration, exec: runner, actions, cwd: root });

    // Every command runs with cwd = the explicit router root, never the
    // caller's cwd, so local scope lands in the requested project.
    assert.ok(runner.calls.length > 0, "the adapter issued commands");
    for (const call of runner.calls) assert.equal(call.cwd, root, "every Claude command uses the router root as cwd");
    assert.deepEqual(runner.log, [
      "plugin validate --strict " + path.join(state, `claude/plugins/${PLUGIN}`),
      "plugin validate --strict " + path.join(state, "claude"),
      `plugin marketplace add --scope local ${path.join(state, "claude")}`,
      "plugin list --json",
      `plugin install ${PLUGIN}@${identity.marketplace} --scope local`,
      "plugin list --json",
    ]);
    assert.deepEqual(actions, [
      {
        type: "marketplace-add",
        name: identity.marketplace,
        scope: "local",
        path: path.join(state, "claude"),
      },
      { type: "plugin-install", reference: `${PLUGIN}@${identity.marketplace}`, scope: "local" },
    ]);
    assert.equal(
      await declarationPath(root),
      path.join(state, "claude"),
      "the scope-owned declaration was written under the router root",
    );

    // An exact name+path+scope declaration skips the marketplace command, and
    // an already installed reference is refreshed through `update`.
    runner.log.length = 0;
    const refreshActions = [];
    await registerClaude({ plan: plan.registration, exec: runner, actions: refreshActions, cwd: root });
    assert.deepEqual(runner.log, [
      "plugin validate --strict " + path.join(state, `claude/plugins/${PLUGIN}`),
      "plugin validate --strict " + path.join(state, "claude"),
      "plugin list --json",
      `plugin update ${PLUGIN}@${identity.marketplace} --scope local`,
      "plugin list --json",
    ]);
    assert.deepEqual(refreshActions, [
      {
        type: "plugin-update",
        reference: `${PLUGIN}@${identity.marketplace}`,
        scope: "local",
        priorVersion: ROUTER_PACKAGE_VERSION,
        priorScope: "local",
      },
    ]);

    // A declaration that points anywhere else is drift: registration fails
    // closed before any marketplace or plugin mutation, records no action, and
    // leaves the conflicting declaration exactly as it was.
    await writeDeclaration(root, identity.marketplace, path.join(directory, "elsewhere"));
    runner.log.length = 0;
    const conflict = [];
    await assert.rejects(
      registerClaude({ plan: plan.registration, exec: runner, actions: conflict, cwd: root }),
      /already declared at local scope with a different path; refusing to replace it/,
    );
    assert.deepEqual(conflict, [], "a refused registration records no compensation action");
    assert.deepEqual(
      runner.log,
      [
        "plugin validate --strict " + path.join(state, `claude/plugins/${PLUGIN}`),
        "plugin validate --strict " + path.join(state, "claude"),
      ],
      "only read-only validation ran: no marketplace or plugin command was issued",
    );
    assert.equal(
      await declarationPath(root),
      path.join(directory, "elsewhere"),
      "the conflicting declaration is untouched",
    );

    await assert.rejects(
      registerClaude({ plan: plan.registration, exec: runner, actions: [] }),
      /explicit cwd/,
      "an adapter call without an explicit root cwd is rejected",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("registration failures compensate exactly the actions of this attempt", async () => {
  const { directory, state } = await fixture();
  try {
    const source = await writeSkill(directory, "release", "name: Release\ndescription: Publish\n");
    const identity = claudeIdentity({ global: false, stateDirectory: state });
    const plan = await planClaudePlugin({
      requestDirectory: REQUEST_DIRECTORY,
      registry: { skills: [skillEntry("release", source, "Publish")] },
      identity,
      stateDirectory: state,
    });
    await stageClaudePlugin(plan, state);
    const root = path.join(directory, "router-root");
    await mkdir(root, { recursive: true });

    const runner = createFakeClaudeRunner();
    runner.failOn(
      `plugin install ${PLUGIN}@${identity.marketplace} --scope local`,
      "install refused",
    );
    const actions = [];
    await assert.rejects(
      registerClaude({ plan: plan.registration, exec: runner, actions, cwd: root }),
      /install refused/,
    );
    assert.deepEqual(actions.map((action) => action.type), ["marketplace-add", "plugin-install"]);
    assert.equal(
      await declarationPath(root),
      path.join(state, "claude"),
      "the failed attempt still left its declaration behind",
    );

    runner.log.length = 0;
    await compensateClaude({ actions, exec: runner, cwd: root });
    // Compensation re-observes first: the plugin was never installed, so only
    // the marketplace this attempt created is removed — nothing else is touched.
    assert.deepEqual(runner.log, [
      "plugin list --json",
      `plugin marketplace remove ${identity.marketplace} --scope local`,
    ]);
    assert.equal(await declarationPath(root), null, "the declaration created by this attempt is gone");
    assert.equal(runner.state.marketplaces.length, 0);
    assert.equal(runner.state.plugins.length, 0);

    const ordered = createFakeClaudeRunner();
    const history = [
      { type: "marketplace-add", name: identity.marketplace, scope: "local", path: path.join(state, "claude") },
      { type: "plugin-install", reference: `${PLUGIN}@${identity.marketplace}`, scope: "local" },
    ];
    ordered.state.marketplaces.push({ name: identity.marketplace, path: path.join(state, "claude"), scope: "local" });
    ordered.state.plugins.push({ id: `${PLUGIN}@${identity.marketplace}`, version: "0.1.0", scope: "local", enabled: true });
    await writeDeclaration(root, identity.marketplace, path.join(state, "claude"));
    await compensateClaude({ actions: history, exec: ordered, cwd: root });
    assert.deepEqual(ordered.log, [
      "plugin list --json",
      `plugin uninstall ${PLUGIN}@${identity.marketplace} --scope local`,
      "plugin list --json",
      `plugin marketplace remove ${identity.marketplace} --scope local`,
    ]);
    assert.equal(await declarationPath(root), null);

    // A marketplace this attempt did not write (a conflicting prior path) is
    // never removed by compensation either.
    const foreign = createFakeClaudeRunner();
    await writeDeclaration(root, identity.marketplace, path.join(directory, "foreign"));
    const foreignActions = [
      { type: "marketplace-add", name: identity.marketplace, scope: "local", path: path.join(state, "claude") },
    ];
    await compensateClaude({ actions: foreignActions, exec: foreign, cwd: root });
    assert.deepEqual(foreign.log, [], "a foreign declaration is left untouched");
    assert.equal(await declarationPath(root), path.join(directory, "foreign"));

    const untouched = createFakeClaudeRunner();
    await compensateClaude({ actions: [], exec: untouched, cwd: root });
    assert.deepEqual(untouched.log, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("removal plans use only exact references", () => {
  const identity = claudeIdentity({ global: true, stateDirectory: "/srv/router" });
  const plan = claudeRegistrationPlan({ identity, stateDirectory: "/srv/router", version: "0.1.0" });
  const removal = claudeRemovalPlan({ identity, stateDirectory: "/srv/router" });
  assert.deepEqual(plan.install, [
    "plugin",
    "install",
    `${identity.plugin}@${identity.marketplace}`,
    "--scope",
    "user",
  ]);
  assert.deepEqual(removal.uninstall, [
    "plugin",
    "uninstall",
    `${identity.plugin}@${identity.marketplace}`,
    "--scope",
    "user",
  ]);
  assert.deepEqual(removal.marketplaceRemove, [
    "plugin",
    "marketplace",
    "remove",
    identity.marketplace,
    "--scope",
    "user",
  ]);
  assert.equal(removal.reference, plan.reference);
  assert.equal(removal.scope, "user");
});

test("file verification detects missing, extra, symlinked, and drifted content", async () => {
  const { directory, state } = await fixture();
  try {
    const source = await writeSkill(directory, "release", "name: Release\ndescription: Publish\n");
    const plan = await planClaudePlugin({
      requestDirectory: REQUEST_DIRECTORY,
      registry: { skills: [skillEntry("release", source, "Publish")] },
      identity: claudeIdentity({ global: false, stateDirectory: state }),
      stateDirectory: state,
    });
    await stageClaudePlugin(plan, state);
    const skillFile = path.join(state, `claude/plugins/${PLUGIN}/skills/release/SKILL.md`);

    await rm(skillFile);
    let diagnostics = await verifyClaudePluginFiles({ plan, stateDirectory: state });
    assert.deepEqual(
      diagnostics.map((item) => item.code),
      ["claude-skill-missing"],
    );
    assert.equal(diagnostics[0].skillId, "release");

    await writeFile(path.join(state, `claude/plugins/${PLUGIN}/skills/release/SKILL.md`), "drift\n");
    diagnostics = await verifyClaudePluginFiles({ plan, stateDirectory: state });
    assert.deepEqual(
      diagnostics.map((item) => item.code),
      ["claude-file-drift", "claude-mode-drift"],
      "the recreated file differs in content and in mode",
    );

    await rm(skillFile);
    await stageClaudePlugin(plan, state);
    assert.deepEqual(
      (await verifyClaudePluginFiles({ plan, stateDirectory: state })).map((item) => item.code),
      [],
      "staging restores the exact bytes and modes",
    );
    await writeFile(path.join(state, "claude", "extra.md"), "unexpected\n");
    diagnostics = await verifyClaudePluginFiles({ plan, stateDirectory: state });
    assert.deepEqual(
      diagnostics.map((item) => item.code),
      ["claude-layout-invalid"],
    );
    await rm(path.join(state, "claude", "extra.md"));

    const routerFile = path.join(state, `claude/plugins/${PLUGIN}/skills/skill-router/SKILL.md`);
    await rm(routerFile);
    await symlink(skillFile, routerFile);
    diagnostics = await verifyClaudePluginFiles({ plan, stateDirectory: state });
    assert.ok(diagnostics.some((item) => item.code === "claude-layout-invalid" && /symlink/.test(item.message)));
    await rm(routerFile, { force: true });
    await stageClaudePlugin(plan, state);

    // The root itself is rejected before traversal: a symlinked or
    // non-directory state root never gets walked.
    await rm(path.join(state, "claude"), { recursive: true, force: true });
    diagnostics = await verifyClaudePluginFiles({ plan, stateDirectory: state });
    assert.deepEqual(
      diagnostics.map((item) => item.code),
      ["claude-state-missing"],
    );

    const elsewhere = path.join(directory, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(path.join(elsewhere, "keep.txt"), "keep\n");
    await symlink(elsewhere, path.join(state, "claude"));
    diagnostics = await verifyClaudePluginFiles({ plan, stateDirectory: state });
    assert.deepEqual(
      diagnostics.map((item) => item.code),
      ["claude-layout-invalid"],
    );
    assert.match(diagnostics[0].message, /must not be a symlink/);
    await rm(path.join(state, "claude"), { force: true });

    await writeFile(path.join(state, "claude"), "not a directory\n");
    diagnostics = await verifyClaudePluginFiles({ plan, stateDirectory: state });
    assert.deepEqual(
      diagnostics.map((item) => item.code),
      ["claude-layout-invalid"],
    );
    assert.match(diagnostics[0].message, /is not a directory/);
    await rm(path.join(state, "claude"), { force: true });
    await stageClaudePlugin(plan, state);
    assert.deepEqual(
      (await verifyClaudePluginFiles({ plan, stateDirectory: state })).map((item) => item.code),
      [],
      "the tree is healthy again after the root checks",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("registration verification never reports missing state as healthy", async () => {
  const { directory, state } = await fixture();
  try {
    const source = await writeSkill(directory, "release", "name: Release\ndescription: Publish\n");
    const identity = claudeIdentity({ global: false, stateDirectory: state });
    const plan = await planClaudePlugin({
      requestDirectory: REQUEST_DIRECTORY,
      registry: { skills: [skillEntry("release", source, "Publish")] },
      identity,
      stateDirectory: state,
    });
    await stageClaudePlugin(plan, state);
    const registration = plan.registration;
    const root = path.join(directory, "router-root");
    await mkdir(root, { recursive: true });

    const empty = createFakeClaudeRunner();
    const missing = await verifyClaudeRegistration({
      plan: registration,
      installation: { claude: { version: ROUTER_PACKAGE_VERSION } },
      exec: empty,
      cwd: root,
    });
    assert.deepEqual(
      missing.map((item) => item.code),
      ["claude-marketplace-missing", "claude-registration-missing"],
      "an unreadable/absent scope declaration and a missing plugin are both reported",
    );
    for (const call of empty.calls) assert.equal(call.cwd, root, "inspection uses the router root as cwd");

    const runner = createFakeClaudeRunner();
    await registerClaude({ plan: registration, exec: runner, actions: [], cwd: root });
    const healthy = await verifyClaudeRegistration({
      plan: registration,
      installation: { claude: { version: ROUTER_PACKAGE_VERSION } },
      exec: runner,
      cwd: root,
    });
    assert.deepEqual(healthy, []);

    runner.state.plugins[0].version = "0.0.9";
    const stale = await verifyClaudeRegistration({
      plan: registration,
      installation: { claude: { version: ROUTER_PACKAGE_VERSION } },
      exec: runner,
      cwd: root,
    });
    assert.deepEqual(
      stale.map((item) => item.code),
      ["claude-registration-stale"],
    );

    runner.state.plugins[0].enabled = false;
    const disabled = await verifyClaudeRegistration({
      plan: registration,
      installation: { claude: { version: "0.0.9" } },
      exec: runner,
      cwd: root,
    });
    assert.deepEqual(
      disabled.map((item) => item.code),
      ["claude-registration-disabled"],
    );

    // A declaration that moved away from the generated marketplace is not
    // healthy even while the CLI still lists the plugin.
    runner.state.plugins[0].enabled = true;
    await writeDeclaration(root, identity.marketplace, path.join(directory, "moved"));
    const moved = await verifyClaudeRegistration({
      plan: registration,
      installation: { claude: { version: "0.0.9" } },
      exec: runner,
      cwd: root,
    });
    assert.deepEqual(
      moved.map((item) => item.code),
      ["claude-marketplace-missing"],
    );

    const broken = createFakeClaudeRunner();
    broken.failOn("plugin validate --strict " + path.join(state, `claude/plugins/${PLUGIN}`), "bad manifest");
    const invalid = await verifyClaudeRegistration({
      plan: registration,
      installation: { claude: { version: "0.1.0" } },
      exec: broken,
      cwd: root,
    });
    assert.equal(invalid.filter((item) => item.code === "claude-validation-failed").length, 1);

    const unavailable = async () => {
      const error = new Error("Claude CLI is unavailable: claude");
      error.code = "ENOENT";
      throw error;
    };
    const diagnostic = await verifyClaudeRegistration({
      plan: registration,
      installation: { claude: { version: "0.1.0" } },
      exec: unavailable,
      cwd: root,
    });
    assert.deepEqual(
      diagnostic.map((item) => item.code),
      ["claude-cli-unavailable"],
    );
    await assert.rejects(
      verifyClaudeRegistration({ plan: registration, installation: {}, exec: runner }),
      /explicit cwd/,
      "verification without an explicit root cwd is rejected",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("execFile execution stays shell-free and bounds failure output", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "skill-router-claude-bin-"));
  try {
    const { bin } = await writeFakeClaudeBin(directory);
    const state = path.join(directory, "state");
    const identity = claudeIdentity({ global: false, stateDirectory: state });
    const source = await writeSkill(directory, "release", "name: Release\ndescription: Publish\n");
    const plan = await planClaudePlugin({
      requestDirectory: REQUEST_DIRECTORY,
      registry: { skills: [skillEntry("release", source, "Publish")] },
      identity,
      stateDirectory: state,
    });
    await stageClaudePlugin(plan, state);
    const validated = await execClaude(["plugin", "validate", "--strict", path.join(state, "claude")], { bin });
    assert.match(validated.stdout, /Validation passed/);
    await assert.rejects(
      execClaude(["plugin", "validate", "--strict", directory], { bin }),
      /validation failed/,
    );

    const echo = path.join(directory, "echo-argv.mjs");
    await writeFile(echo, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`, {
      mode: 0o755,
    });
    const marker = path.join(directory, "shell-was-used");
    const argv = await execClaude(["plugin", "list", "--json", `;touch ${marker};`], { bin: echo });
    assert.deepEqual(JSON.parse(argv.stdout), ["plugin", "list", "--json", `;touch ${marker};`]);
    await assert.rejects(() => readFile(marker), /ENOENT/);

    await assert.rejects(
      execClaude(["plugin", "list", "--json"], { bin: path.join(directory, "missing-claude") }),
      /Claude CLI is unavailable/,
    );

    assert.equal(claudeBinary({}), "claude");
    assert.equal(claudeBinary({ SKILL_ROUTER_CLAUDE_BIN: "/opt/claude" }), "/opt/claude");
    assert.equal(boundClaudeMessage(`\u001b[31mboom\u001b[0m\n`), "boom");
    assert.equal(boundClaudeMessage(`line1\nline2\ttab`), "line1 line2 tab");
    assert.equal(boundClaudeMessage(""), "Claude CLI failed without output");
    const long = boundClaudeMessage("x".repeat(1000), 10);
    assert.equal(long.length, 11);
    assert.ok(long.endsWith("…"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects every YAML value Claude treats as true for disable-model-invocation", async () => {
  const { directory, state } = await fixture();
  try {
    const identity = claudeIdentity({ global: false, stateDirectory: state });
    const source = path.join(directory, "invocation.md");
    const render = async (raw) => {
      await writeFile(
        source,
        `---\nname: invocation\ndescription: Invocation flag\ndisable-model-invocation: ${raw}\n---\n\nBody.\n`,
      );
      return planClaudePlugin({
        requestDirectory: REQUEST_DIRECTORY,
        registry: { skills: [skillEntry("invocation", source, "Invocation flag")] },
        identity,
        stateDirectory: state,
      });
    };

    // YAML 1.2 booleans, YAML 1.1 true tokens (y/yes/on in any case), and the
    // numeric 1 are all values Claude resolves as "true" and must be rejected.
    for (const raw of ["true", "True", "TRUE", '"true"', "yes", "Yes", "YES", "y", "Y", "on", "ON", "1", "'1'", "  yes  "]) {
      await assert.rejects(() => render(raw), /disable-model-invocation: true, which is incompatible/, `${raw} must be rejected`);
    }
    // The false side stays accepted so a source skill may state it explicitly.
    for (const raw of ["false", "False", "no", "NO", "off", "0", "null"]) {
      const plan = await render(raw);
      assert.ok(plan.entries.some((entry) => entry.path.endsWith("skills/invocation/SKILL.md")), `${raw} must render`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a freshly generated plugin version comes from the package version and is injectable", async () => {
  const { directory, state } = await fixture();
  try {
    const source = await writeSkill(directory, "release", "name: Release\ndescription: Publish\n");
    const identity = claudeIdentity({ global: false, stateDirectory: state });
    const registry = () => ({ skills: [skillEntry("release", source, "Publish")] });
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );

    assert.equal(ROUTER_PACKAGE_VERSION, packageJson.version, "the base version tracks package.json");
    assert.match(ROUTER_PACKAGE_VERSION, /^\d+\.\d+\.\d+$/, "the base version stays a plain semantic version");

    const fresh = await planClaudePlugin({ requestDirectory: REQUEST_DIRECTORY, registry: registry(), identity, stateDirectory: state });
    assert.equal(fresh.version, ROUTER_PACKAGE_VERSION);
    assert.equal(
      JSON.parse(
        planEntry(fresh, `claude/plugins/${PLUGIN}/.claude-plugin/plugin.json`),
      ).version,
      ROUTER_PACKAGE_VERSION,
    );

    const injected = await planClaudePlugin({
      requestDirectory: REQUEST_DIRECTORY,
      registry: registry(),
      identity,
      stateDirectory: state,
      packageVersion: "7.8.9",
    });
    assert.equal(injected.version, "7.8.9");
    assert.equal(
      await planClaudePlugin({
        requestDirectory: REQUEST_DIRECTORY,
        registry: registry(),
        identity,
        stateDirectory: state,
        packageVersion: "7.9.0-rc.1+build.2",
      }).then((plan) => plan.version),
      "7.9.0",
      "prerelease and build suffixes are normalized away",
    );

    // An already-installed plugin keeps its recorded version for identical
    // content, whatever the package version says today.
    const stable = await planClaudePlugin({
      requestDirectory: REQUEST_DIRECTORY,
      registry: registry(),
      identity,
      stateDirectory: state,
      recorded: { fingerprint: fresh.fingerprint, version: "0.4.2" },
      packageVersion: "9.9.9",
    });
    assert.equal(stable.version, "0.4.2");

    await writeFile(source, "---\nname: Release\ndescription: Publish now\n---\n\nBody v2.\n");
    const bumped = await planClaudePlugin({
      requestDirectory: REQUEST_DIRECTORY,
      registry: registry(),
      identity,
      stateDirectory: state,
      recorded: { fingerprint: fresh.fingerprint, version: "0.4.2" },
      packageVersion: "9.9.9",
    });
    assert.equal(bumped.version, "0.4.3", "content change still bumps the recorded version");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function planEntry(plan, relative) {
  const entry = plan.entries.find((candidate) => candidate.path === relative);
  assert.ok(entry, `planned file missing: ${relative}`);
  return entry.content;
}

test("mutate-then-throw CLI failures are reconciled from observed state", async () => {
  const { directory, state } = await fixture();
  try {
    const source = await writeSkill(directory, "release", "name: Release\ndescription: Publish\n");
    const identity = claudeIdentity({ global: false, stateDirectory: state });
    const registry = { skills: [skillEntry("release", source, "Publish")] };
    const plan = await planClaudePlugin({ requestDirectory: REQUEST_DIRECTORY, registry, identity, stateDirectory: state });
    await stageClaudePlugin(plan, state);
    const root = path.join(directory, "router-root");
    await mkdir(root, { recursive: true });
    const reference = `${PLUGIN}@${identity.marketplace}`;
    const marketplaceRoot = path.join(state, "claude");

    // (a) marketplace add mutates and then exits non-zero.
    const addRunner = createFakeClaudeRunner();
    addRunner.failOn(`plugin marketplace add --scope local ${marketplaceRoot}`, "add exploded", { mutate: true });
    const addActions = [];
    await assert.rejects(
      registerClaude({ plan: plan.registration, exec: addRunner, actions: addActions, cwd: root }),
      /add exploded/,
    );
    assert.deepEqual(addActions.map((action) => action.type), ["marketplace-add"]);
    assert.equal(addActions[0].observed?.declaration?.path, marketplaceRoot, "observed state was re-listed after the failure");
    assert.equal(addActions[0].observed?.declaration?.scope, "local", "the observed declaration carries its scope");
    addRunner.log.length = 0;
    await compensateClaude({ actions: addActions, exec: addRunner, cwd: root });
    assert.deepEqual(addRunner.log, [`plugin marketplace remove ${identity.marketplace} --scope local`]);
    assert.equal(await declarationPath(root), null, "the declaration this attempt created is gone");

    // (b) plugin install mutates and then exits non-zero.
    const installRunner = createFakeClaudeRunner();
    installRunner.failOn(`plugin install ${reference} --scope local`, "install exploded", { mutate: true });
    const installActions = [];
    await assert.rejects(
      registerClaude({ plan: plan.registration, exec: installRunner, actions: installActions, cwd: root }),
      /install exploded/,
    );
    assert.deepEqual(installActions.map((action) => action.type), ["marketplace-add", "plugin-install"]);
    assert.equal(installActions[1].observed?.plugin?.version, ROUTER_PACKAGE_VERSION, "the observed plugin version was captured");
    assert.equal(installActions[1].observed?.plugin?.scope, "local", "the observed plugin scope was captured");
    await compensateClaude({ actions: installActions, exec: installRunner, cwd: root });
    assert.ok(
      installRunner.log.includes(`plugin uninstall ${reference} --scope local`),
      "the observed installation is removed",
    );
    assert.ok(
      installRunner.log.includes(`plugin marketplace remove ${identity.marketplace} --scope local`),
      "only the marketplace this attempt created is removed",
    );
    assert.equal(await declarationPath(root), null);
    const afterInstall = await captureClaudeState({ plan: plan.registration, exec: installRunner, cwd: root });
    assert.equal(afterInstall.plugin, null, "the newly installed reference is provably absent");

    // (c) plugin update mutates and then exits non-zero.
    const updateRunner = createFakeClaudeRunner();
    await registerClaude({ plan: plan.registration, exec: updateRunner, actions: [], cwd: root });
    const nextPlan = await planClaudePlugin({
      requestDirectory: REQUEST_DIRECTORY,
      registry,
      identity,
      stateDirectory: state,
      packageVersion: "0.1.1",
    });
    assert.equal(nextPlan.version, "0.1.1");
    // The regenerated content is what the marketplace now carries, so the
    // update really moves the installed version forward.
    await stageClaudePlugin(nextPlan, state);
    updateRunner.failOn(`plugin update ${reference} --scope local`, "update exploded", { mutate: true });
    const updateActions = [];
    await assert.rejects(
      registerClaude({ plan: nextPlan.registration, exec: updateRunner, actions: updateActions, cwd: root }),
      /update exploded/,
    );
    assert.deepEqual(updateActions.map((action) => action.type), ["plugin-update"]);
    assert.equal(updateActions[0].priorVersion, ROUTER_PACKAGE_VERSION, "the prior version was captured before the mutation");
    assert.equal(updateActions[0].priorScope, "local");
    assert.equal(updateActions[0].observed?.plugin?.version, "0.1.1", "the mutated version was observed");
    // The router transaction restores its own state before compensating, so
    // the marketplace content is the prior version again when rollback runs.
    await stageClaudePlugin(plan, state);
    await compensateClaude({ actions: updateActions, exec: updateRunner, cwd: root });
    const restored = await captureClaudeState({ plan: plan.registration, exec: updateRunner, cwd: root });
    assert.equal(restored.plugin?.version, ROUTER_PACKAGE_VERSION, "the exact prior version is restored");
    assert.equal(restored.plugin?.scope, "local", "the exact prior scope is restored");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed compensation verification is reported instead of swallowed", async () => {
  const { directory, state } = await fixture();
  try {
    const source = await writeSkill(directory, "release", "name: Release\ndescription: Publish\n");
    const identity = claudeIdentity({ global: false, stateDirectory: state });
    const plan = await planClaudePlugin({
      requestDirectory: REQUEST_DIRECTORY,
      registry: { skills: [skillEntry("release", source, "Publish")] },
      identity,
      stateDirectory: state,
    });
    await stageClaudePlugin(plan, state);
    const root = path.join(directory, "router-root");
    await mkdir(root, { recursive: true });
    const reference = `${PLUGIN}@${identity.marketplace}`;

    const runner = createFakeClaudeRunner();
    await registerClaude({ plan: plan.registration, exec: runner, actions: [], cwd: root });
    // Compensation walks the recorded registration log in reverse, so the exact
    // plugin reference is uninstalled before the marketplace is removed. Both
    // steps are made to refuse, leaving observable state that must be reported
    // instead of swallowed.
    const actions = [
      { type: "marketplace-add", name: identity.marketplace, scope: "local", path: path.join(state, "claude") },
      { type: "plugin-install", reference, scope: "local" },
    ];
    runner.failOn(`plugin uninstall ${reference} --scope local`, "uninstall refused");
    runner.failOn(`plugin marketplace remove ${identity.marketplace} --scope local`, "marketplace removal refused");
    await assert.rejects(
      compensateClaude({ actions, exec: runner, cwd: root }),
      /Claude compensation failed: uninstall refused/,
    );
    const observed = await captureClaudeState({ plan: plan.registration, exec: runner, cwd: root });
    assert.ok(observed.plugin, "the unverifiable rollback left observable state behind, and that is reported");

    await assert.rejects(
      compensateClaude({ actions: [{ type: "plugin-install", reference, scope: "local" }] }),
      /explicit cwd/,
      "compensation of real actions requires an explicit root cwd",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("normalized file modes are fingerprinted, staged exactly, and verified", async () => {
  const { directory, state } = await fixture();
  try {
    const skillDirectory = path.join(directory, "tree");
    await mkdir(path.join(skillDirectory, "references"), { recursive: true });
    await writeFile(path.join(skillDirectory, "SKILL.md"), "---\nname: Tree\ndescription: Support tree\n---\n\nBody.\n");
    const supportFile = path.join(skillDirectory, "references", "steps.md");
    await writeFile(supportFile, "# steps\n");
    const supportMode = (await stat(supportFile)).mode & 0o777;
    const identity = claudeIdentity({ global: false, stateDirectory: state });
    const registry = { skills: [skillEntry("tree", path.join(skillDirectory, "SKILL.md"), "Support tree")] };

    const plan = await planClaudePlugin({ requestDirectory: REQUEST_DIRECTORY, registry, identity, stateDirectory: state });
    const skillPath = `claude/plugins/${PLUGIN}/skills/tree/SKILL.md`;
    const supportPath = `claude/plugins/${PLUGIN}/skills/tree/references/steps.md`;
    assert.equal(planEntry(plan, skillPath).includes("name: tree"), true);
    const plannedSkill = plan.entries.find((entry) => entry.path === skillPath);
    const plannedSupport = plan.entries.find((entry) => entry.path === supportPath);
    // Installed mode and fingerprint mode are separate, explicit fields: every
    // file installs owner-only, while a support file's fingerprint mode is the
    // normalized source mode that a chmod-only change must still move.
    assert.equal(plannedSkill.installedMode, 0o600, "generated documents install owner-only");
    assert.equal(plannedSkill.fingerprintMode, 0o600, "generated documents are fingerprinted at 0600");
    assert.equal(plannedSupport.installedMode, 0o600, "support files install owner-only");
    assert.equal(plannedSupport.fingerprintMode, supportMode, "support files are fingerprinted at their source mode");
    assert.ok(
      plan.entries.every((entry) => Number.isInteger(entry.installedMode)),
      "every planned entry carries an explicit installed mode",
    );
    assert.ok(
      plan.entries
        .filter((entry) => entry.path.endsWith(".json"))
        .every((entry) => entry.fingerprintMode === undefined),
      "the version-bearing manifests are never fingerprint inputs",
    );
    assert.ok(
      plan.entries
        .filter((entry) => !entry.path.endsWith(".json"))
        .every((entry) => Number.isInteger(entry.fingerprintMode)),
      "every fingerprint-bearing entry carries an explicit fingerprint mode",
    );
    assert.ok(
      plan.entries.every((entry) => entry.mode === undefined),
      "no single mode field silently serves both purposes",
    );

    if (fileModeBitsMeaningful()) {
      // A chmod-only change to a source file alters the fingerprint and the version.
      const otherMode = supportMode === 0o600 ? 0o644 : 0o600;
      await chmod(supportFile, otherMode);
      const rechmod = await planClaudePlugin({
        requestDirectory: REQUEST_DIRECTORY,
        registry,
        identity,
        stateDirectory: state,
        recorded: { fingerprint: plan.fingerprint, version: "0.1.0" },
      });
      assert.notEqual(rechmod.fingerprint, plan.fingerprint, "a chmod-only change alters the fingerprint");
      assert.equal(rechmod.version, "0.1.1", "a chmod-only change advances the version");
      assert.equal(
        rechmod.entries.find((entry) => entry.path === supportPath).installedMode,
        0o600,
        "a chmod-only source change never changes the installed mode",
      );
      await chmod(supportFile, supportMode);
      const restoredPlan = await planClaudePlugin({
        requestDirectory: REQUEST_DIRECTORY,
        registry,
        identity,
        stateDirectory: state,
        recorded: { fingerprint: "0".repeat(64), version: "0.1.0" },
      });
      assert.equal(restoredPlan.fingerprint, plan.fingerprint, "restoring the mode restores the fingerprint");

      // Staging produces the exact planned installed modes: 0600 everywhere.
      await stageClaudePlugin(plan, state);
      assert.equal((await stat(path.join(state, skillPath))).mode & 0o777, 0o600);
      assert.equal((await stat(path.join(state, supportPath))).mode & 0o777, 0o600);
      assert.deepEqual((await verifyClaudePluginFiles({ plan, stateDirectory: state })).map((item) => item.code), []);

      // A chmod-only change to a generated file is unhealthy even though the
      // bytes are unchanged.
      await chmod(path.join(state, skillPath), 0o644);
      const drift = await verifyClaudePluginFiles({ plan, stateDirectory: state });
      assert.deepEqual(drift.map((item) => item.code), ["claude-mode-drift"]);
      assert.match(drift[0].message, /permissions are stale/);
      await chmod(path.join(state, skillPath), 0o600);
      assert.deepEqual((await verifyClaudePluginFiles({ plan, stateDirectory: state })).map((item) => item.code), []);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("execClaude runs with the caller's explicit cwd and passes argv untouched", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "skill-router-claude-cwd-"));
  try {
    const probe = path.join(directory, "probe.mjs");
    await writeFile(
      probe,
      `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));\n`,
      { mode: 0o755 },
    );
    const probeCwd = path.join(directory, "somewhere-else");
    await mkdir(probeCwd, { recursive: true });
    // macOS tmp paths are symlinked (/var → /private/var); the child reports
    // the resolved path, so compare against the real path.
    const expectedCwd = realpathSync(probeCwd);
    assert.notEqual(expectedCwd, process.cwd());

    const observed = await execClaude(["plugin", "list", "--json"], { bin: probe, cwd: probeCwd });
    const payload = JSON.parse(observed.stdout);
    assert.equal(payload.cwd, expectedCwd, "the child cwd is the explicit root, not the caller's cwd");
    assert.deepEqual(payload.argv, ["plugin", "list", "--json"]);

    const inherited = await execClaude([], { bin: probe });
    assert.equal(JSON.parse(inherited.stdout).cwd, process.cwd(), "without an explicit cwd the caller's cwd is inherited");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude copies keep source fields and never gain an OpenCode marker", async () => {
  const { directory, state } = await fixture();
  try {
    const identity = claudeIdentity({ global: false, stateDirectory: state });
    const planFor = (id, source) =>
      planClaudePlugin({
        requestDirectory: REQUEST_DIRECTORY,
        registry: { skills: [skillEntry(id, source, "Effective description")] },
        identity,
        stateDirectory: state,
      });
    const contentOf = (plan, id) => plan.entries.find((entry) => entry.path.endsWith(`skills/${id}/SKILL.md`)).content;

    // (a) A source without the marker: every field survives and no OpenCode
    // marker is injected anywhere in the Claude copy.
    const plain = path.join(directory, "plain", "SKILL.md");
    await mkdir(path.dirname(plain), { recursive: true });
    await writeFile(
      plain,
      [
        "---",
        "name: Release Display Name",
        'description: "Original description"',
        "license: MIT",
        "allowed-tools: [Read, Grep]",
        "disallowed-tools: [Write]",
        "invocation: explicit-only",
        "model: claude-sonnet-4",
        "metadata:",
        "  tier: 2",
        "unknown-harness-field: keep-me",
        "---",
        "",
        "Body stays verbatim.",
        "",
      ].join("\n"),
    );
    const plainText = contentOf(await planFor("plain", plain), "plain");
    const plainData = parse(splitSkillDocument(plainText).yaml);
    assert.equal(plainData.name, "plain", "canonical name overrides the display name");
    assert.equal(plainData.description, "Effective description", "effective registry description wins");
    assert.equal(plainData.license, "MIT");
    assert.deepEqual(plainData["allowed-tools"], ["Read", "Grep"]);
    assert.deepEqual(plainData["disallowed-tools"], ["Write"]);
    assert.equal(plainData.invocation, "explicit-only");
    assert.equal(plainData.model, "claude-sonnet-4");
    assert.deepEqual(plainData.metadata, { tier: 2 }, "existing metadata survives without any OpenCode marker");
    assert.equal(plainData["unknown-harness-field"], "keep-me", "unknown harness fields survive");
    assert.equal(plainText.includes("opencode/autoinvoke"), false, "no OpenCode marker is injected");
    assert.equal(
      splitSkillDocument(plainText).body,
      splitSkillDocument(await readFile(plain, "utf8")).body,
      "the body stays verbatim",
    );

    // (b) A source that already carries the marker keeps it: Claude preserves
    // source fields rather than rewriting them.
    const marked = path.join(directory, "marked", "SKILL.md");
    await mkdir(path.dirname(marked), { recursive: true });
    await writeFile(
      marked,
      [
        "---",
        "name: Marked Display",
        "description: Original",
        "metadata:",
        "  tier: 3",
        "  opencode/autoinvoke: false",
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
    );
    const markedText = contentOf(await planFor("marked", marked), "marked");
    const markedData = parse(splitSkillDocument(markedText).yaml);
    assert.equal(markedData.name, "marked");
    assert.deepEqual(
      markedData.metadata,
      { tier: 3, "opencode/autoinvoke": false },
      "a marker present in the source is retained unchanged",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude synthesizes canonical identity for sources without frontmatter", async () => {
  const { directory, state } = await fixture();
  try {
    const source = path.join(directory, "plain-body.md");
    const body = "# Instructions only\n\nNo frontmatter here.\n";
    await writeFile(source, body);
    const plan = await planClaudePlugin({
      requestDirectory: REQUEST_DIRECTORY,
      registry: { skills: [skillEntry("plain-body", source, "Effective description")] },
      identity: claudeIdentity({ global: false, stateDirectory: state }),
      stateDirectory: state,
    });
    const text = plan.entries.find((entry) => entry.path.endsWith("skills/plain-body/SKILL.md")).content;
    const yaml = splitSkillDocument(text).yaml;
    assert.deepEqual(parse(yaml), {
      name: "plain-body",
      description: "Effective description",
    });
    assert.equal(yaml.includes("metadata"), false, "Claude synthesizes no metadata at all");
    assert.equal(splitSkillDocument(text).body, body, "the original content is retained as the body");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude generation gates the effective disable-model-invocation value", async () => {
  const { directory, state } = await fixture();
  try {
    const identity = claudeIdentity({ global: false, stateDirectory: state });
    const source = path.join(directory, "release.md");
    const generate = () =>
      planClaudePlugin({
        requestDirectory: REQUEST_DIRECTORY,
        registry: { skills: [skillEntry("release", source, "Effective description")] },
        identity,
        stateDirectory: state,
      });
    const skillText = (plan) =>
      plan.entries.find((entry) => entry.path.endsWith("skills/release/SKILL.md")).content;
    const document = (frontmatter) => `---\n${frontmatter}---\nBody\n`;

    // (a) A truthy value inherited through a merge is rejected during
    // generation even though the source never states it explicitly.
    await writeFile(
      source,
      document("defaults: &d\n  disable-model-invocation: true\nname: Release\n<<: *d\n"),
    );
    await assert.rejects(
      generate(),
      /disable-model-invocation: true, which is incompatible/,
      "inherited truthy values are rejected",
    );

    // (b) An explicit false wins under YAML semantics: generation succeeds,
    // the value is preserved, and no OpenCode marker is injected.
    await writeFile(
      source,
      document("defaults: &d\n  disable-model-invocation: true\nname: Release\n<<: *d\ndisable-model-invocation: false\n"),
    );
    const allowed = skillText(await generate());
    const allowedData = parse(splitSkillDocument(allowed).yaml);
    assert.equal(allowedData["disable-model-invocation"], false, "the explicit false value survives generation");
    assert.equal(allowed.includes("opencode/autoinvoke"), false, "no OpenCode marker is injected");
    assert.ok(allowed.includes("<<: *d"), "the merge construct outside metadata survives");

    // (c) Merge-derived metadata reaches the Claude copy intact: inherited
    // keys are visible and the OpenCode marker is never added.
    await writeFile(
      source,
      document("base: &b\n  tier: 2\ndefaults: &d\n  metadata: *b\nname: Release\n<<: *d\n"),
    );
    const merged = skillText(await generate());
    const mergedData = parseDocument(splitSkillDocument(merged).yaml, { merge: true }).toJS();
    assert.equal(mergedData.metadata.tier, 2, "inherited metadata reaches the Claude copy");
    assert.equal(Object.hasOwn(mergedData.metadata, "opencode/autoinvoke"), false, "Claude never adds the marker");
    assert.ok(merged.includes("<<: *d"), "the merge construct is preserved verbatim");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * Phase 5, Lane B — generated-source validation, uninstall observation,
 * classification, exact detach, and exact restore.
 * ------------------------------------------------------------------ */

const MUTATION_PATTERN = /^plugin (?:uninstall|install|update|marketplace add|marketplace remove)\b/;

function mutationsOf(runner) {
  return runner.log.filter((line) => MUTATION_PATTERN.test(line));
}

/**
 * Registered, installation-recorded Claude state at project scope (or global
 * scope under a temporary CLAUDE_CONFIG_DIR — never the real HOME).
 */
async function detachFixture(options = {}) {
  const fx = await stagedFixture(options);
  await registerClaude({
    plan: fx.registration,
    exec: fx.runner,
    actions: [],
    cwd: fx.root,
    env: fx.env,
  });
  fx.runner.log.length = 0;
  return fx;
}

/** The same fixture before any Claude registration. */
async function stagedFixture({ global = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "skill-router-claude-detach-"));
  const state = path.join(directory, ".skill-router");
  await mkdir(state, { recursive: true });
  const root = path.join(directory, "router-root");
  await mkdir(root, { recursive: true });
  const source = await writeSkill(directory, "release", "name: Release\ndescription: Publish a release\n");
  const identity = claudeIdentity({ global, stateDirectory: state });
  const plan = await planClaudePlugin({
    requestDirectory: REQUEST_DIRECTORY,
    registry: { skills: [skillEntry("release", source, "Publish a release")] },
    identity,
    stateDirectory: state,
  });
  await stageClaudePlugin(plan, state);
  const installation = buildInstallation({
    global,
    stateDirectory: state,
    harnesses: ["claude"],
    claude: { fingerprint: plan.fingerprint, version: plan.version },
  });
  const env = global
    ? {
        HOME: path.join(directory, "home"),
        CLAUDE_CONFIG_DIR: path.join(directory, "claude-config"),
      }
    : undefined;
  if (env) {
    await mkdir(env.HOME, { recursive: true });
    await mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true });
  }
  const runner = createFakeClaudeRunner();
  return {
    directory,
    state,
    root,
    identity,
    plan,
    installation,
    runner,
    env,
    registration: plan.registration,
    scope: identity.claudeScope,
    reference: `${identity.plugin}@${identity.marketplace}`,
    marketplaceRoot: path.join(state, "claude"),
    pluginRoot: path.join(state, "claude", "plugins", identity.plugin),
    declarationFile: claudeMarketplaceSettingsFile(identity.claudeScope, { cwd: root, env: env ?? process.env }),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function inspectFixture(fx, overrides = {}) {
  return inspectGeneratedClaudeRemovalSource({
    identity: fx.identity,
    stateDirectory: fx.state,
    installation: fx.installation,
    exec: createFakeClaudeRunner(),
    cwd: fx.root,
    ...overrides,
  });
}

test("generated removal source inspection is strict without rereading skill sources", async () => {
  const fx = await detachFixture();
  try {
    // The original skill document disappears after staging: inspection reads
    // only the generated tree and the recorded installation metadata.
    await rm(path.join(fx.directory, "release.md"), { force: true });
    const runner = createFakeClaudeRunner();
    const inspected = await inspectGeneratedClaudeRemovalSource({
      identity: fx.identity,
      stateDirectory: fx.state,
      installation: fx.installation,
      exec: runner,
      cwd: fx.root,
    });

    assert.equal(inspected.validated, true);
    assert.equal(inspected.version, fx.installation.claude.version);
    assert.equal(inspected.fingerprint, fx.installation.claude.fingerprint);
    assert.equal(inspected.reference, fx.reference);
    assert.equal(inspected.scope, fx.scope);
    assert.equal(inspected.marketplaceRoot, fx.marketplaceRoot);
    assert.equal(inspected.pluginRoot, fx.pluginRoot);
    assert.deepEqual(inspected.removal.uninstall, ["plugin", "uninstall", fx.reference, "--scope", fx.scope]);
    assert.deepEqual(inspected.removal.marketplaceRemove, [
      "plugin",
      "marketplace",
      "remove",
      fx.identity.marketplace,
      "--scope",
      fx.scope,
    ]);
    assert.equal(inspected.registration.reference, fx.reference);
    assert.deepEqual(inspected.registration.validate, [
      ["plugin", "validate", "--strict", fx.pluginRoot],
      ["plugin", "validate", "--strict", fx.marketplaceRoot],
    ]);
    assert.deepEqual(runner.log, [
      `plugin validate --strict ${fx.pluginRoot}`,
      `plugin validate --strict ${fx.marketplaceRoot}`,
    ]);
    for (const call of runner.calls) assert.equal(call.cwd, fx.root, "strict validation runs at the router root");

    // The inspection result is a first-class plan for the lifecycle seams.
    const observed = await observeClaudeUninstallState({ plan: inspected, exec: fx.runner, cwd: fx.root });
    assert.equal(classifyClaudeUninstallState(observed, inspected, fx.installation).classification, "healthy");
  } finally {
    await fx.cleanup();
  }
});

test("generated removal source rejects content, mode, and layout tampering", async () => {
  const fx = await detachFixture();
  try {
    const claudeRoot = path.join(fx.state, "claude");
    const skillFile = path.join(fx.pluginRoot, "skills", "release", "SKILL.md");
    const routerFile = path.join(fx.pluginRoot, "skills", "skill-router", "SKILL.md");
    const stray = path.join(claudeRoot, "notes.md");
    const loose = path.join(fx.pluginRoot, "skills", "loose.md");
    const extra = path.join(claudeRoot, "plugins", "extra-plugin");

    // Content tamper with the recorded mode preserved.
    await writeFile(skillFile, "tampered\n");
    await assert.rejects(
      inspectFixture(fx),
      (error) => error.code === "claude-generated-fingerprint" && /fingerprint/.test(error.message),
    );
    await stageClaudePlugin(fx.plan, fx.state);

    // Mode-only tamper on a generated skill document (platform aware).
    if (fileModeBitsMeaningful()) {
      await chmod(skillFile, 0o644);
      await assert.rejects(inspectFixture(fx), (error) => error.code === "claude-generated-mode");
      await chmod(skillFile, 0o600);
      assert.equal((await inspectFixture(fx)).validated, true, "the tree validates once the mode is restored");
    }

    // The router skill is a required generated entry.
    await rm(routerFile);
    await assert.rejects(inspectFixture(fx), (error) => error.code === "claude-generated-missing");
    await stageClaudePlugin(fx.plan, fx.state);

    // A stray file beside the marketplace manifest.
    await writeFile(stray, "stray\n");
    await assert.rejects(
      inspectFixture(fx),
      (error) => error.code === "claude-generated-layout" && /unexpected file/.test(error.message),
    );
    await rm(stray);

    // An extra plugin directory inside the generated marketplace.
    await mkdir(path.join(extra, ".claude-plugin"), { recursive: true });
    await writeFile(path.join(extra, ".claude-plugin", "plugin.json"), "{}\n");
    await assert.rejects(
      inspectFixture(fx),
      (error) => error.code === "claude-generated-layout" && /unexpected plugin entry/.test(error.message),
    );
    await rm(extra, { recursive: true, force: true });

    // A file directly under skills/ is not a generated entry either.
    await writeFile(loose, "loose\n");
    await assert.rejects(
      inspectFixture(fx),
      (error) => error.code === "claude-generated-layout" && /unexpected file/.test(error.message),
    );
    await rm(loose);

    assert.equal((await inspectFixture(fx)).validated, true, "the generated source is healthy again");
  } finally {
    await fx.cleanup();
  }
});

test("generated removal source rejects symlinks, special files, and manifest drift", async () => {
  const fx = await detachFixture();
  try {
    const claudeRoot = path.join(fx.state, "claude");
    const releaseDir = path.join(fx.pluginRoot, "skills", "release");
    const pluginManifest = path.join(fx.pluginRoot, ".claude-plugin", "plugin.json");
    const marketplaceManifest = path.join(claudeRoot, ".claude-plugin", "marketplace.json");

    // A symlink anywhere under the generated tree is refused before content.
    const outside = path.join(fx.directory, "outside.md");
    await writeFile(outside, "outside\n");
    const link = path.join(releaseDir, "linked.md");
    await symlink(outside, link);
    await assert.rejects(
      inspectFixture(fx),
      (error) => error.code === "claude-generated-layout" && /symlink/.test(error.message),
    );
    await rm(link);

    // A special file is refused too (portable best effort).
    const fifo = path.join(releaseDir, "pipe");
    if (spawnSync("mkfifo", [fifo]).status === 0) {
      await assert.rejects(
        inspectFixture(fx),
        (error) => error.code === "claude-generated-layout" && /special file/.test(error.message),
      );
      await rm(fifo, { force: true });
    }

    // A symlinked generated root is never traversed.
    await rm(claudeRoot, { recursive: true, force: true });
    const elsewhere = path.join(fx.directory, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(path.join(elsewhere, "keep.txt"), "keep\n");
    await symlink(elsewhere, claudeRoot);
    await assert.rejects(
      inspectFixture(fx),
      (error) => error.code === "claude-generated-layout" && /must not be a symlink/.test(error.message),
    );
    await rm(claudeRoot, { force: true });
    await stageClaudePlugin(fx.plan, fx.state);

    // Recorded version in the plugin manifest.
    const original = await readFile(pluginManifest, "utf8");
    await writeFile(
      pluginManifest,
      original.replace(JSON.stringify(fx.installation.claude.version), JSON.stringify("9.9.9")),
    );
    await assert.rejects(
      inspectFixture(fx),
      (error) => error.code === "claude-generated-manifest" && /expected the recorded version/.test(error.message),
    );

    // A non-inert key makes the manifest dangerous, not just stale.
    await writeFile(pluginManifest, `${JSON.stringify({ ...JSON.parse(original), hooks: {} }, null, 2)}\n`);
    await assert.rejects(
      inspectFixture(fx),
      (error) => error.code === "claude-generated-manifest" && /non-inert key/.test(error.message),
    );

    // Byte-exact inert manifest, not merely an equivalent document.
    await writeFile(pluginManifest, `${JSON.stringify(JSON.parse(original))}\n`);
    await assert.rejects(
      inspectFixture(fx),
      (error) => error.code === "claude-generated-manifest" && /byte for byte/.test(error.message),
    );
    await writeFile(pluginManifest, original);

    // The marketplace lists exactly the one expected plugin.
    const marketplaceOriginal = await readFile(marketplaceManifest, "utf8");
    const marketplaceDocument = JSON.parse(marketplaceOriginal);
    marketplaceDocument.plugins.push({
      name: "second",
      source: "./plugins/second",
      version: fx.installation.claude.version,
    });
    await writeFile(marketplaceManifest, `${JSON.stringify(marketplaceDocument, null, 2)}\n`);
    await assert.rejects(
      inspectFixture(fx),
      (error) => error.code === "claude-generated-manifest" && /exactly one plugin/.test(error.message),
    );

    const wrongSource = JSON.parse(marketplaceOriginal);
    wrongSource.plugins[0] = { ...wrongSource.plugins[0], source: "./plugins/elsewhere" };
    await writeFile(marketplaceManifest, `${JSON.stringify(wrongSource, null, 2)}\n`);
    await assert.rejects(
      inspectFixture(fx),
      (error) => error.code === "claude-generated-manifest" && /unexpected plugin source/.test(error.message),
    );
    await writeFile(marketplaceManifest, marketplaceOriginal);

    assert.equal((await inspectFixture(fx)).validated, true, "the generated source is healthy again");
  } finally {
    await fx.cleanup();
  }
});

test("generated removal source runs strict CLI validation and keeps its guards", async () => {
  const fx = await detachFixture();
  try {
    const failing = createFakeClaudeRunner();
    failing.failOn(`plugin validate --strict ${fx.pluginRoot}`, "strict validation refused");
    await assert.rejects(
      inspectFixture(fx, { exec: failing }),
      (error) => error.code === "claude-validation-failed" && /strict validation refused/.test(error.message),
    );
    assert.deepEqual(mutationsOf(failing), [], "read-only validation never mutates");

    const unavailable = async () => {
      const error = new Error("Claude CLI is unavailable: claude");
      error.code = "ENOENT";
      throw error;
    };
    await assert.rejects(
      inspectFixture(fx, { exec: unavailable }),
      (error) => error.code === "claude-cli-unavailable",
    );

    // Ownership problems are reported before the filesystem or the CLI.
    await assert.rejects(
      inspectFixture(fx, { installation: {} }),
      (error) => error.code === "claude-installation-mismatch",
    );
    await assert.rejects(
      inspectFixture(fx, {
        installation: { ...fx.installation, stateDirectory: path.join(fx.directory, "other-state") },
      }),
      (error) => error.code === "claude-installation-mismatch",
    );
    await assert.rejects(inspectFixture(fx, { cwd: "" }), /explicit cwd/);
    await assert.rejects(inspectFixture(fx, { stateDirectory: "" }), /state directory/);

    // Fully absent external state never weakens the inspection.
    assert.equal((await inspectFixture(fx)).validated, true);
  } finally {
    await fx.cleanup();
  }
});

test("uninstall observation keeps every matching marketplace and plugin entry", async () => {
  const fx = await detachFixture();
  try {
    const observed = await observeClaudeUninstallState({ plan: fx.registration, exec: fx.runner, cwd: fx.root });
    assert.equal(observed.scope, fx.scope);
    assert.equal(observed.reference, fx.reference);
    assert.equal(observed.declaration.path, fx.marketplaceRoot);
    assert.equal(observed.declaration.scope, fx.scope);
    assert.equal(observed.marketplaces.length, 1);
    assert.equal(observed.plugins.length, 1);
    assert.equal(observed.marketplacePlugins.length, 1);
    for (const call of fx.runner.calls) assert.equal(call.cwd, fx.root, "observation runs at the router root");

    // Real CLI list shapes that omit `scope` still adapt faithfully.
    const [visible] = fx.runner.state.marketplaces;
    const recordedScope = visible.scope;
    delete visible.scope;
    const adapted = await observeClaudeUninstallState({ plan: fx.registration, exec: fx.runner, cwd: fx.root });
    assert.equal(adapted.marketplaces[0].scope, null);
    assert.equal(adapted.marketplaces[0].path, fx.marketplaceRoot);
    assert.equal(
      classifyClaudeUninstallState(adapted, fx.registration, fx.installation).classification,
      "healthy",
      "an unreported scope never becomes drift",
    );
    visible.scope = recordedScope;

    // Wrong scope, duplicates, extra marketplace plugins, and unrelated
    // plugins are all visible: observation never filters for the caller.
    fx.runner.state.marketplaces.push({
      name: fx.identity.marketplace,
      path: fx.marketplaceRoot,
      scope: "user",
    });
    fx.runner.state.plugins.push({
      id: fx.reference,
      version: fx.installation.claude.version,
      scope: "user",
      enabled: true,
    });
    fx.runner.state.plugins.push({
      id: `helper@${fx.identity.marketplace}`,
      version: "9.9.9",
      scope: "local",
      enabled: true,
    });
    fx.runner.state.plugins.push({ id: "unrelated@elsewhere", version: "1.0.0", scope: "local", enabled: true });

    const complete = await observeClaudeUninstallState({ plan: fx.registration, exec: fx.runner, cwd: fx.root });
    assert.equal(complete.marketplaces.length, 2, "the duplicate visible entry is retained");
    assert.equal(complete.plugins.length, 2, "the same reference at another scope is retained");
    assert.deepEqual(
      complete.marketplacePlugins.map((entry) => entry.id).sort(),
      [fx.reference, fx.reference, `helper@${fx.identity.marketplace}`].sort(),
      "every plugin of this marketplace is retained, across scopes",
    );
    assert.equal(
      complete.plugins.some((entry) => entry.id === "unrelated@elsewhere"),
      false,
      "unrelated plugins are outside the observation",
    );
  } finally {
    await fx.cleanup();
  }
});

test("uninstall classification separates healthy, absent, and every drift shape", () => {
  const stateDirectory = path.join(os.tmpdir(), "skill-router-claude-classify");
  const identity = claudeIdentity({ global: false, stateDirectory });
  const plan = claudeRegistrationPlan({ identity, stateDirectory, version: "0.1.0" });
  const installation = buildInstallation({
    global: false,
    stateDirectory,
    harnesses: ["claude"],
    claude: { fingerprint: "0".repeat(64), version: "0.1.0" },
  });
  const healthyObservation = () => ({
    declaration: {
      scope: "local",
      file: path.join(stateDirectory, ".claude", "settings.local.json"),
      exists: true,
      path: plan.marketplaceRoot,
    },
    marketplaces: [{ name: identity.marketplace, path: plan.marketplaceRoot, scope: "local" }],
    plugins: [{ id: plan.reference, scope: "local", version: "0.1.0", enabled: true }],
    marketplacePlugins: [{ id: plan.reference, scope: "local", version: "0.1.0", enabled: true }],
  });
  const absentObservation = () => ({
    declaration: {
      scope: "local",
      file: path.join(stateDirectory, ".claude", "settings.local.json"),
      exists: false,
      path: null,
    },
    marketplaces: [],
    plugins: [],
    marketplacePlugins: [],
  });
  const classify = (observation, withInstallation = installation) =>
    classifyClaudeUninstallState(observation, plan, withInstallation);

  assert.deepEqual(classify(healthyObservation()), { classification: "healthy", reasons: [] });
  assert.deepEqual(classify(absentObservation()), { classification: "absent", reasons: [] });

  const driftCases = [
    ["declaration at a wrong path", (obs) => { obs.declaration.path = "/srv/elsewhere/claude"; }, /declared at a different path/],
    ["missing declaration", (obs) => { obs.declaration.path = null; }, /not declared at local scope/],
    ["declaration read from another scope file", (obs) => { obs.declaration.scope = "user"; }, /observed at the user scope/],
    ["marketplace visible at a wrong path", (obs) => { obs.marketplaces[0].path = "/srv/elsewhere/claude"; }, /listed at a different path/],
    ["marketplace visible for another scope", (obs) => { obs.marketplaces[0].scope = "user"; }, /listed for the user scope/],
    ["marketplace listed without a path", (obs) => { delete obs.marketplaces[0].path; }, /without a usable path/],
    ["duplicate visible marketplace", (obs) => { obs.marketplaces.push({ ...obs.marketplaces[0] }); }, /visible 2 times/],
    ["no visible marketplace", (obs) => { obs.marketplaces = []; }, /not registered with the Claude CLI/],
    ["missing plugin", (obs) => { obs.plugins = []; obs.marketplacePlugins = []; }, /not installed at local scope/],
    ["plugin at another scope", (obs) => { obs.plugins.push({ id: plan.reference, scope: "user", version: "0.1.0", enabled: true }); obs.marketplacePlugins.push({ id: plan.reference, scope: "user", version: "0.1.0", enabled: true }); }, /also installed at user scope/],
    ["wrong version", (obs) => { obs.plugins[0].version = "0.0.9"; }, /at version 0.0.9, expected 0.1.0/],
    ["disabled plugin", (obs) => { obs.plugins[0].enabled = false; }, /disabled at local scope/],
    ["duplicate reference at the recorded scope", (obs) => { obs.plugins.push({ id: plan.reference, scope: "local", version: "0.1.0", enabled: true }); obs.marketplacePlugins.push({ id: plan.reference, scope: "local", version: "0.1.0", enabled: true }); }, /visible 2 times at local scope/],
    ["extra plugin from this marketplace", (obs) => { obs.marketplacePlugins.push({ id: `helper@${identity.marketplace}`, scope: "local", version: "1.0.0", enabled: true }); }, /helper@.* is installed at local scope/],
    ["extra plugin from this marketplace at another scope", (obs) => { obs.marketplacePlugins.push({ id: `helper@${identity.marketplace}`, scope: "user", version: "1.0.0", enabled: true }); }, /helper@.* is installed at user scope/],
    ["unreadable plugin version", (obs) => { delete obs.plugins[0].version; }, /unreadable version/],
    ["malformed observation", (obs) => { delete obs.marketplacePlugins; }, /was not observed/],
  ];
  for (const [name, mutate, pattern] of driftCases) {
    const observation = healthyObservation();
    mutate(observation);
    const result = classify(observation);
    assert.equal(result.classification, "drift", name);
    assert.ok(
      result.reasons.some((reason) => pattern.test(reason)),
      `${name}: expected ${pattern} in ${result.reasons.join(" | ")}`,
    );
  }

  // Every partially absent shape is drift, never absent.
  const partialAbsent = [
    ["marketplace visible without a declaration", (obs) => { obs.marketplaces = [{ name: identity.marketplace, path: plan.marketplaceRoot, scope: "local" }]; }],
    ["plugin installed without a declaration", (obs) => { obs.plugins = [{ id: plan.reference, scope: "local", version: "0.1.0", enabled: true }]; obs.marketplacePlugins = [{ id: plan.reference, scope: "local", version: "0.1.0", enabled: true }]; }],
    ["only an extra plugin of this marketplace remains", (obs) => { obs.marketplacePlugins = [{ id: `helper@${identity.marketplace}`, scope: "local", version: "1.0.0", enabled: true }]; }],
    ["declared but not visible", (obs) => { obs.declaration.path = plan.marketplaceRoot; }],
    ["declaration object missing", (obs) => { delete obs.declaration; }],
  ];
  for (const [name, mutate] of partialAbsent) {
    const observation = absentObservation();
    mutate(observation);
    assert.equal(classify(observation).classification, "drift", name);
  }

  // Missing or conflicting installation metadata never reports healthy.
  assert.equal(
    classify(healthyObservation(), { claude: { version: "9.9.9", plugin: identity.plugin, marketplace: identity.marketplace, scope: "local" } }).classification,
    "drift",
    "a version conflict is drift",
  );
  assert.equal(
    classify(healthyObservation(), { claude: { version: "0.1.0", plugin: "other-plugin", marketplace: identity.marketplace, scope: "local" } }).classification,
    "drift",
    "an identity conflict is drift",
  );
  assert.equal(
    classify(healthyObservation(), null).classification,
    "healthy",
    "the plan's recorded version is the fallback",
  );

  // The exact removal plan classifies identically to the registration plan.
  const removal = claudeRemovalPlan({ identity, stateDirectory });
  assert.equal(classifyClaudeUninstallState(healthyObservation(), removal, installation).classification, "healthy");
  assert.equal(classifyClaudeUninstallState(absentObservation(), removal, installation).classification, "absent");
});

test("detach removes exactly the recorded registration and ends fully absent", async () => {
  const fx = await detachFixture();
  try {
    // Unrelated registrations that must survive untouched.
    fx.runner.state.marketplaces.push({
      name: "foreign-market",
      path: path.join(fx.directory, "foreign"),
      scope: "user",
    });
    fx.runner.state.plugins.push({ id: "foreign-plugin@foreign-market", version: "1.0.0", scope: "user", enabled: true });

    const result = await detachClaude({
      plan: fx.registration,
      installation: fx.installation,
      exec: fx.runner,
      cwd: fx.root,
      env: fx.env,
    });
    assert.equal(result.classification, "absent");
    assert.equal(result.alreadyAbsent, false);
    assert.equal(result.prior.classification, "healthy");
    assert.equal(result.prior.observation.marketplaces.length, 1);
    assert.deepEqual(
      result.actions.map((action) => action.type),
      ["plugin-uninstall", "marketplace-remove"],
      "both intents are recorded before their mutations",
    );
    assert.deepEqual(result.actions.map((action) => action.scope), [fx.scope, fx.scope]);
    assert.equal(result.actions[0].reference, fx.reference);
    assert.equal(result.actions[1].path, fx.marketplaceRoot);
    assert.deepEqual(
      fx.runner.log,
      [
        "plugin marketplace list --json",
        "plugin list --json",
        `plugin uninstall ${fx.reference} --scope ${fx.scope}`,
        "plugin marketplace list --json",
        "plugin list --json",
        `plugin marketplace remove ${fx.identity.marketplace} --scope ${fx.scope}`,
        "plugin marketplace list --json",
        "plugin list --json",
      ],
      "each command is bracketed by observation",
    );

    assert.deepEqual(fx.runner.state.plugins.filter((entry) => entry.id === fx.reference), []);
    assert.deepEqual(
      fx.runner.state.marketplaces.filter((entry) => entry.name === fx.identity.marketplace),
      [],
    );
    const settings = JSON.parse(await readFile(fx.declarationFile, "utf8"));
    assert.equal(settings.extraKnownMarketplaces?.[fx.identity.marketplace], undefined);
    assert.equal(
      JSON.stringify(fx.runner.state.marketplaces),
      JSON.stringify([{ name: "foreign-market", path: path.join(fx.directory, "foreign"), scope: "user" }]),
      "the unrelated marketplace is untouched",
    );
    assert.deepEqual(fx.runner.state.plugins.map((entry) => entry.id), ["foreign-plugin@foreign-market"]);

    // A second detach is an idempotent no-op.
    fx.runner.log.length = 0;
    const again = await detachClaude({
      plan: fx.registration,
      installation: fx.installation,
      exec: fx.runner,
      cwd: fx.root,
      env: fx.env,
    });
    assert.equal(again.alreadyAbsent, true);
    assert.equal(again.prior.classification, "absent");
    assert.deepEqual(again.actions, []);
    assert.deepEqual(mutationsOf(fx.runner), []);

    // The prior snapshot restores the exact registration afterwards.
    const restored = await restoreClaudeAfterDetach({
      plan: fx.registration,
      installation: fx.installation,
      prior: result.prior,
      exec: fx.runner,
      cwd: fx.root,
      env: fx.env,
    });
    assert.equal(restored.classification, "healthy");
    assert.deepEqual(restored.restored, { marketplace: true, plugin: true });
    assert.deepEqual(
      restored.actions.map((action) => action.type),
      ["marketplace-add", "plugin-install"],
    );
    assert.equal(
      mutationsOf(fx.runner).some((line) => /uninstall|marketplace remove/.test(line)),
      false,
      "restore never removes anything",
    );
    const observed = await observeClaudeUninstallState({
      plan: fx.registration,
      exec: fx.runner,
      cwd: fx.root,
      env: fx.env,
    });
    assert.equal(observed.plugins[0].version, fx.installation.claude.version);
    assert.equal(observed.plugins[0].enabled, true);
    assert.equal(
      JSON.stringify(fx.runner.state.plugins.map((entry) => entry.id).sort()),
      JSON.stringify([fx.reference, "foreign-plugin@foreign-market"].sort()),
    );
  } finally {
    await fx.cleanup();
  }
});

test("detach refuses drifted registration before any mutation", async () => {
  const fx = await detachFixture();
  try {
    const detach = () =>
      detachClaude({ plan: fx.registration, installation: fx.installation, exec: fx.runner, cwd: fx.root, env: fx.env });

    // Extra plugin owned by this marketplace — the marketplace removal would
    // take it with us, so classification refuses before any command.
    fx.runner.state.plugins.push({
      id: `helper@${fx.identity.marketplace}`,
      version: "9.9.9",
      scope: "local",
      enabled: true,
    });
    fx.runner.log.length = 0;
    await assert.rejects(detach(), (error) => error.code === "claude-detach-drift" && /helper@/.test(error.message));
    assert.deepEqual(mutationsOf(fx.runner), [], "no mutation ran");
    assert.deepEqual(fx.runner.log, ["plugin marketplace list --json", "plugin list --json"]);
    fx.runner.state.plugins.pop();

    // Declaration at a different path.
    await writeDeclaration(fx.root, fx.identity.marketplace, path.join(fx.directory, "elsewhere"));
    fx.runner.log.length = 0;
    await assert.rejects(
      detach(),
      (error) => error.code === "claude-detach-drift" && /different path/.test(error.message),
    );
    assert.deepEqual(mutationsOf(fx.runner), []);
    await writeDeclaration(fx.root, fx.identity.marketplace, fx.marketplaceRoot);

    // Wrong version.
    fx.runner.state.plugins[0].version = "0.0.9";
    fx.runner.log.length = 0;
    await assert.rejects(detach(), (error) => error.code === "claude-detach-drift" && /expected/.test(error.message));
    assert.deepEqual(mutationsOf(fx.runner), []);
    fx.runner.state.plugins[0].version = fx.installation.claude.version;

    // Disabled plugin.
    fx.runner.state.plugins[0].enabled = false;
    fx.runner.log.length = 0;
    await assert.rejects(detach(), (error) => error.code === "claude-detach-drift" && /disabled/.test(error.message));
    assert.deepEqual(mutationsOf(fx.runner), []);
    fx.runner.state.plugins[0].enabled = true;

    // Duplicate visible marketplace entry.
    fx.runner.state.marketplaces.push({ name: fx.identity.marketplace, path: fx.marketplaceRoot, scope: "user" });
    fx.runner.log.length = 0;
    await assert.rejects(
      detach(),
      (error) => error.code === "claude-detach-drift" && /visible 2 times/.test(error.message),
    );
    assert.deepEqual(mutationsOf(fx.runner), []);
    fx.runner.state.marketplaces.pop();

    // Same reference at another scope.
    fx.runner.state.plugins.push({
      id: fx.reference,
      version: fx.installation.claude.version,
      scope: "user",
      enabled: true,
    });
    fx.runner.log.length = 0;
    await assert.rejects(
      detach(),
      (error) => error.code === "claude-detach-drift" && /also installed at user scope/.test(error.message),
    );
    assert.deepEqual(mutationsOf(fx.runner), []);

    // A healthy registration is still intact under all those refusals.
    fx.runner.state.plugins.pop();
    const healthy = await observeClaudeUninstallState({ plan: fx.registration, exec: fx.runner, cwd: fx.root });
    assert.equal(classifyClaudeUninstallState(healthy, fx.registration, fx.installation).classification, "healthy");

    // Guards: explicit cwd and a validated installation document.
    await assert.rejects(
      detachClaude({ plan: fx.registration, installation: fx.installation, exec: fx.runner, cwd: "" }),
      /explicit cwd/,
    );
    await assert.rejects(
      detachClaude({ plan: fx.registration, installation: {}, exec: fx.runner, cwd: fx.root }),
      (error) => error.code === "claude-installation-mismatch",
    );
    await assert.rejects(
      observeClaudeUninstallState({ plan: fx.registration, exec: fx.runner, cwd: "" }),
      /explicit cwd/,
    );
    await assert.rejects(
      restoreClaudeAfterDetach({
        plan: fx.registration,
        installation: fx.installation,
        prior: { classification: "healthy" },
        exec: fx.runner,
        cwd: "",
      }),
      /explicit cwd/,
    );
  } finally {
    await fx.cleanup();
  }
});

test("detach reconciles fail-before-mutation and mutate-then-error outcomes", async () => {
  const uninstallCommand = (fx) => `plugin uninstall ${fx.reference} --scope ${fx.scope}`;
  const removeCommand = (fx) => `plugin marketplace remove ${fx.identity.marketplace} --scope ${fx.scope}`;

  // (a) Uninstall refuses before mutating: unchanged state is a rollback no-op.
  const fxA = await detachFixture();
  try {
    fxA.runner.failOn(uninstallCommand(fxA), "uninstall refused");
    let failure = null;
    try {
      await detachClaude({
        plan: fxA.registration,
        installation: fxA.installation,
        exec: fxA.runner,
        cwd: fxA.root,
        env: fxA.env,
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, "the detach fails");
    assert.equal(failure.code, "claude-detach-unchanged");
    assert.match(failure.message, /uninstall refused/);
    assert.match(failure.message, /no-op/);
    assert.equal(failure.prior.classification, "healthy", "the prior snapshot travels on the error");
    assert.deepEqual(failure.actions.map((action) => action.type), ["plugin-uninstall"]);
    assert.equal(fxA.runner.state.plugins.length, 1, "nothing mutated");
    assert.equal(fxA.runner.state.marketplaces.length, 1);

    // Compensation from that snapshot is a verified no-op.
    fxA.runner.log.length = 0;
    const restoredA = await restoreClaudeAfterDetach({
      plan: fxA.registration,
      installation: fxA.installation,
      prior: failure.prior,
      exec: fxA.runner,
      cwd: fxA.root,
      env: fxA.env,
    });
    assert.equal(restoredA.classification, "healthy");
    assert.deepEqual(restoredA.restored, { marketplace: false, plugin: false });
    assert.deepEqual(mutationsOf(fxA.runner), []);
  } finally {
    await fxA.cleanup();
  }

  // (b) Uninstall mutates and then errors: the observed transition wins.
  const fxB = await detachFixture();
  try {
    fxB.runner.failOn(uninstallCommand(fxB), "uninstall exploded", { mutate: true });
    const result = await detachClaude({
      plan: fxB.registration,
      installation: fxB.installation,
      exec: fxB.runner,
      cwd: fxB.root,
      env: fxB.env,
    });
    assert.equal(result.classification, "absent");
    assert.equal(result.actions[0].error, "uninstall exploded", "the command failure is recorded, not trusted");
    assert.equal(fxB.runner.state.plugins.length, 0);
    assert.equal(fxB.runner.state.marketplaces.length, 0);
  } finally {
    await fxB.cleanup();
  }

  // (c) Marketplace removal refuses before mutating: a plugin-only detach.
  const fxC = await detachFixture();
  try {
    fxC.runner.failOn(removeCommand(fxC), "remove refused");
    let failure = null;
    try {
      await detachClaude({
        plan: fxC.registration,
        installation: fxC.installation,
        exec: fxC.runner,
        cwd: fxC.root,
        env: fxC.env,
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, "the detach fails");
    assert.equal(failure.code, "claude-detach-unchanged");
    assert.match(failure.message, /marketplace removal/);
    assert.deepEqual(
      failure.actions.map((action) => action.type),
      ["plugin-uninstall", "marketplace-remove"],
    );
    assert.equal(fxC.runner.state.plugins.length, 0, "the exact plugin is gone");
    assert.equal(fxC.runner.state.marketplaces.length, 1, "the marketplace survived the refusal");

    fxC.runner.log.length = 0;
    const restored = await restoreClaudeAfterDetach({
      plan: fxC.registration,
      installation: fxC.installation,
      prior: failure.prior,
      exec: fxC.runner,
      cwd: fxC.root,
      env: fxC.env,
    });
    assert.equal(restored.classification, "healthy");
    assert.deepEqual(restored.restored, { marketplace: false, plugin: true }, "only the plugin is installed");
    assert.deepEqual(
      mutationsOf(fxC.runner),
      [`plugin install ${fxC.reference} --scope ${fxC.scope}`],
      "the existing marketplace declaration is never re-added",
    );
    const observed = await observeClaudeUninstallState({ plan: fxC.registration, exec: fxC.runner, cwd: fxC.root });
    assert.equal(classifyClaudeUninstallState(observed, fxC.registration, fxC.installation).classification, "healthy");
  } finally {
    await fxC.cleanup();
  }

  // (d) Marketplace removal mutates and then errors: fully absent wins.
  const fxD = await detachFixture();
  try {
    fxD.runner.failOn(removeCommand(fxD), "remove exploded", { mutate: true });
    const result = await detachClaude({
      plan: fxD.registration,
      installation: fxD.installation,
      exec: fxD.runner,
      cwd: fxD.root,
      env: fxD.env,
    });
    assert.equal(result.classification, "absent");
    assert.equal(result.actions[1].error, "remove exploded");
    assert.equal(fxD.runner.state.plugins.length, 0);
    assert.equal(fxD.runner.state.marketplaces.length, 0);
  } finally {
    await fxD.cleanup();
  }
});

test("detach reports mixed post-mutation state as drift with compensation data", async () => {
  const fx = await detachFixture();
  try {
    const removeCommand = `plugin marketplace remove ${fx.identity.marketplace} --scope ${fx.scope}`;
    const emptySettings = `${JSON.stringify({ extraKnownMarketplaces: {} }, null, 2)}\n`;
    const partial = async (argv, options = {}) => {
      if (argv.join(" ") === removeCommand) {
        // The CLI drops our declaration, keeps the visible entry, then fails.
        await writeFile(fx.declarationFile, emptySettings);
        const error = new Error("marketplace removal exploded mid-way");
        error.code = "CLAUDE_FAILED";
        throw error;
      }
      return fx.runner(argv, options);
    };

    let failure = null;
    try {
      await detachClaude({
        plan: fx.registration,
        installation: fx.installation,
        exec: partial,
        cwd: fx.root,
        env: fx.env,
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, "a mixed state never reports success");
    assert.equal(failure.code, "claude-detach-drift");
    assert.match(failure.message, /not declared at local scope/);
    assert.equal(failure.prior.classification, "healthy");
    assert.deepEqual(failure.actions.map((action) => action.type), ["plugin-uninstall", "marketplace-remove"]);
    assert.ok(failure.observation, "the mixed observation is reported");
    assert.equal(failure.reasons.length > 0, true);

    // No cleanup ran behind the caller's back.
    assert.equal(fx.runner.state.marketplaces.length, 1, "the visible entry was not force-removed");
    assert.equal(fx.runner.state.plugins.length, 0);

    // The prior snapshot still repairs this state.
    const restored = await restoreClaudeAfterDetach({
      plan: fx.registration,
      installation: fx.installation,
      prior: failure.prior,
      exec: fx.runner,
      cwd: fx.root,
      env: fx.env,
    });
    assert.equal(restored.classification, "healthy");
    assert.deepEqual(restored.restored, { marketplace: true, plugin: true });
  } finally {
    await fx.cleanup();
  }
});

test("detach verifies the final observation instead of trusting the exit status", async () => {
  const fx = await detachFixture();
  try {
    const removeCommand = `plugin marketplace remove ${fx.identity.marketplace} --scope ${fx.scope}`;
    const inert = async (argv, options = {}) => {
      if (argv.join(" ") === removeCommand) return { stdout: "ok\n", stderr: "" }; // exits 0, mutates nothing
      return fx.runner(argv, options);
    };
    let failure = null;
    try {
      await detachClaude({
        plan: fx.registration,
        installation: fx.installation,
        exec: inert,
        cwd: fx.root,
        env: fx.env,
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, "final success requires the fully absent state");
    assert.equal(failure.code, "claude-detach-unchanged");
    assert.match(failure.message, /marketplace removal/);
    assert.equal(failure.prior.classification, "healthy");
    assert.equal(fx.runner.state.marketplaces.length, 1, "the registration is still observable");

    // The recorded prior repairs the plugin-only state that step one left.
    const restored = await restoreClaudeAfterDetach({
      plan: fx.registration,
      installation: fx.installation,
      prior: failure.prior,
      exec: fx.runner,
      cwd: fx.root,
      env: fx.env,
    });
    assert.equal(restored.classification, "healthy");
    assert.deepEqual(restored.restored, { marketplace: false, plugin: true });
  } finally {
    await fx.cleanup();
  }
});

test("restore refuses drifted registrations without mutating anything", async () => {
  const fx = await detachFixture();
  try {
    const restore = () =>
      restoreClaudeAfterDetach({
        plan: fx.registration,
        installation: fx.installation,
        prior: { classification: "healthy", observation: null, reasons: [] },
        exec: fx.runner,
        cwd: fx.root,
        env: fx.env,
      });
    const expectRefusal = async (pattern, undo) => {
      fx.runner.log.length = 0;
      await assert.rejects(
        restore(),
        (error) => {
          assert.equal(error.code, "claude-restore-drift", error.message);
          assert.match(error.message, pattern);
          assert.equal(error.prior.classification, "healthy");
          return true;
        },
        String(pattern),
      );
      assert.deepEqual(mutationsOf(fx.runner), [], "a refused restore never mutates");
      // Awaited: the rollback rewrites the declaration file, and the next
      // `restore()` reads it. Without this the next step could observe the
      // file mid-write and report "Claude local settings are not valid JSON"
      // instead of the drift refusal this test asserts.
      await undo?.();
    };

    // Wrong declaration path: never overwritten.
    await writeDeclaration(fx.root, fx.identity.marketplace, path.join(fx.directory, "elsewhere"));
    await expectRefusal(/refusing to overwrite/, () =>
      writeDeclaration(fx.root, fx.identity.marketplace, fx.marketplaceRoot),
    );

    // Wrong-scope visible entry.
    fx.runner.state.marketplaces.push({ name: fx.identity.marketplace, path: fx.marketplaceRoot, scope: "user" });
    await expectRefusal(/refusing to overwrite/, () => fx.runner.state.marketplaces.pop());

    // Wrong version.
    fx.runner.state.plugins[0].version = "0.0.9";
    await expectRefusal(/restore only installs a missing exact reference/, () => {
      fx.runner.state.plugins[0].version = fx.installation.claude.version;
    });

    // Disabled plugin.
    fx.runner.state.plugins[0].enabled = false;
    await expectRefusal(/restore only installs a missing exact reference/, () => {
      fx.runner.state.plugins[0].enabled = true;
    });

    // Duplicate reference at the recorded scope.
    fx.runner.state.plugins.push({
      id: fx.reference,
      version: fx.installation.claude.version,
      scope: "local",
      enabled: true,
    });
    await expectRefusal(/restore only installs a missing exact reference/, () => fx.runner.state.plugins.pop());

    // Same reference at another scope.
    fx.runner.state.plugins.push({
      id: fx.reference,
      version: fx.installation.claude.version,
      scope: "user",
      enabled: true,
    });
    await expectRefusal(/restore only installs a missing exact reference/, () => fx.runner.state.plugins.pop());

    // Extra plugin owned by this marketplace.
    fx.runner.state.plugins.push({
      id: `helper@${fx.identity.marketplace}`,
      version: "9.9.9",
      scope: "local",
      enabled: true,
    });
    await expectRefusal(/restore only installs a missing exact reference/, () => fx.runner.state.plugins.pop());

    // A snapshot that was never healthy is refused before any command.
    fx.runner.log.length = 0;
    await assert.rejects(
      restoreClaudeAfterDetach({
        plan: fx.registration,
        installation: fx.installation,
        prior: { classification: "absent" },
        exec: fx.runner,
        cwd: fx.root,
        env: fx.env,
      }),
      (error) => error.code === "claude-restore-refused" && /previously healthy/.test(error.message),
    );
    assert.deepEqual(fx.runner.log, [], "the precondition is checked before anything runs");

    // Still healthy after all refusals.
    const observed = await observeClaudeUninstallState({ plan: fx.registration, exec: fx.runner, cwd: fx.root });
    assert.equal(classifyClaudeUninstallState(observed, fx.registration, fx.installation).classification, "healthy");
  } finally {
    await fx.cleanup();
  }
});

// --- Parallel-suite regressions ------------------------------------------------
// The refusal loop above failed only under a parallel full-suite run with
// "Claude local settings are not valid JSON": the rollback thunk was not
// awaited, so the next `restore()` read the declaration while it was being
// rewritten. These three tests pin the fix, the atomic publish it relies on,
// and this file's isolation from host Claude state.

test("declaration replacement publishes atomically, so a mid-rewrite reader never sees partial JSON", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "skill-router-claude-atomic-"));
  try {
    const cwd = path.join(base, "root");
    await mkdir(cwd, { recursive: true });
    const file = path.join(cwd, ".claude", "settings.local.json");
    const first = path.join(base, "first");
    const second = path.join(base, "second");
    await writeDeclaration(cwd, "market", first);

    let observed = null;
    let observationCount = 0;
    await writeDeclaration(cwd, "market", second, {
      beforePublish: async () => {
        observationCount += 1;
        observed = await readFile(file, "utf8");
      },
    });

    assert.equal(
      observationCount,
      1,
      "the pre-publish observation point must run: a declaration rewrite is published atomically, not in place",
    );
    const during = JSON.parse(observed); // throws if the document was ever partial
    assert.equal(
      during.extraKnownMarketplaces.market.source.path,
      first,
      "a reader that runs while a rewrite is in flight still sees the previous complete document",
    );
    const after = JSON.parse(await readFile(file, "utf8"));
    assert.equal(after.extraKnownMarketplaces.market.source.path, second, "the new document replaces it completely");
    assert.deepEqual(
      await readdir(path.dirname(file)),
      ["settings.local.json"],
      "no temporary publish file may survive the rewrite",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("the refusal rollback awaits its undo before the next restore reads the declaration", () => {
  const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.ok(
    source.includes("await undo?.();"),
    "expectRefusal must await the rollback thunk: an unawaited rewrite lets the next restore() read a half-written declaration and report 'not valid JSON' instead of the drift refusal",
  );
  assert.ok(
    !/^[ \t]*undo\?\.\(\);[ \t]*$/m.test(source),
    "a bare undo?.(); call is exactly the torn-read regression this file used to hit under a parallel suite",
  );
});

test("this file resolves Claude state from its private home, never the host paths", () => {
  assert.ok(claudeTestIsolation?.installed, "the isolation helper must be installed before this file's imports/tests run");
  const isolation = claudeTestIsolation;

  assert.ok(isInsidePath(process.env.HOME, isolation.root), `HOME must live inside ${isolation.root}`);
  assert.equal(process.env.USERPROFILE, process.env.HOME, "USERPROFILE follows the private home");
  assert.ok(isInsidePath(process.env.XDG_CONFIG_HOME, isolation.root), "XDG config must stay inside the private root");
  assert.ok(isInsidePath(process.env.SKILL_ROUTER_HOME, isolation.root), "router home must stay inside the private root");
  if (isolation.original.CLAUDE_CONFIG_DIR) {
    assert.ok(isInsidePath(process.env.CLAUDE_CONFIG_DIR, isolation.root), "a host CLAUDE_CONFIG_DIR is redirected");
    assert.notEqual(process.env.CLAUDE_CONFIG_DIR, isolation.original.CLAUDE_CONFIG_DIR);
  } else {
    assert.equal(
      process.env.CLAUDE_CONFIG_DIR,
      undefined,
      "an unset CLAUDE_CONFIG_DIR stays unset so the $HOME/.claude fallback keeps resolving inside the private home",
    );
  }

  const userFile = claudeMarketplaceSettingsFile("user", { cwd: process.cwd(), env: process.env });
  const userRoot = path.resolve(process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME, ".claude"));
  assert.equal(path.dirname(path.resolve(userFile)), userRoot, "user-scope settings resolve inside the private root");
  assert.ok(!isInsidePath(userFile, isolation.hostHomedir), "the host home must not be the user-scope target");

  for (const entry of isolation.hostFiles) {
    assert.ok(!isInsidePath(entry.file, isolation.root), `${entry.file} must be outside the private root`);
  }
  assert.doesNotThrow(
    () => isolation.assertHostClaudeStateUnchanged(),
    "no host Claude file this file could otherwise reach may have changed",
  );
});

test("restore reconciles mutate-then-error outcomes and refuses an invalid source", async () => {
  // (a) Marketplace add mutates and then errors.
  const fxA = await detachFixture();
  try {
    const detached = await detachClaude({
      plan: fxA.registration,
      installation: fxA.installation,
      exec: fxA.runner,
      cwd: fxA.root,
      env: fxA.env,
    });
    fxA.runner.log.length = 0;
    fxA.runner.failOn(`plugin marketplace add --scope ${fxA.scope} ${fxA.marketplaceRoot}`, "add exploded", {
      mutate: true,
    });
    const restored = await restoreClaudeAfterDetach({
      plan: fxA.registration,
      installation: fxA.installation,
      prior: detached.prior,
      exec: fxA.runner,
      cwd: fxA.root,
      env: fxA.env,
    });
    assert.equal(restored.classification, "healthy");
    assert.deepEqual(restored.restored, { marketplace: true, plugin: true });
    assert.equal(restored.actions[0].error, "add exploded", "observation, not the exit status, decides");
  } finally {
    await fxA.cleanup();
  }

  // (b) Plugin install mutates and then errors.
  const fxB = await detachFixture();
  try {
    const detached = await detachClaude({
      plan: fxB.registration,
      installation: fxB.installation,
      exec: fxB.runner,
      cwd: fxB.root,
      env: fxB.env,
    });
    fxB.runner.failOn(`plugin install ${fxB.reference} --scope ${fxB.scope}`, "install exploded", { mutate: true });
    const restored = await restoreClaudeAfterDetach({
      plan: fxB.registration,
      installation: fxB.installation,
      prior: detached.prior,
      exec: fxB.runner,
      cwd: fxB.root,
      env: fxB.env,
    });
    assert.equal(restored.classification, "healthy");
    assert.deepEqual(restored.restored, { marketplace: true, plugin: true });
    assert.equal(restored.actions[1].error, "install exploded");
    assert.equal(fxB.runner.state.plugins[0].version, fxB.installation.claude.version);
  } finally {
    await fxB.cleanup();
  }

  // (c) Plugin install refuses before mutating: reported, with the marketplace
  // that restore legitimately added still observable.
  const fxC = await detachFixture();
  try {
    const detached = await detachClaude({
      plan: fxC.registration,
      installation: fxC.installation,
      exec: fxC.runner,
      cwd: fxC.root,
      env: fxC.env,
    });
    fxC.runner.failOn(`plugin install ${fxC.reference} --scope ${fxC.scope}`, "install refused");
    await assert.rejects(
      restoreClaudeAfterDetach({
        plan: fxC.registration,
        installation: fxC.installation,
        prior: detached.prior,
        exec: fxC.runner,
        cwd: fxC.root,
        env: fxC.env,
      }),
      (error) => error.code === "claude-restore-failed" && /install refused/.test(error.message),
    );
    assert.equal(fxC.runner.state.plugins.length, 0, "the failed install is reported, not assumed");
    assert.equal(fxC.runner.state.marketplaces.length, 1, "the marketplace this restore added remains observable");
  } finally {
    await fxC.cleanup();
  }

  // (d) The canonical generated source is no longer restorable.
  const fxD = await detachFixture();
  try {
    const detached = await detachClaude({
      plan: fxD.registration,
      installation: fxD.installation,
      exec: fxD.runner,
      cwd: fxD.root,
      env: fxD.env,
    });
    const pluginManifest = path.join(fxD.pluginRoot, ".claude-plugin", "plugin.json");
    const document = JSON.parse(await readFile(pluginManifest, "utf8"));
    delete document.version;
    await writeFile(pluginManifest, `${JSON.stringify(document, null, 2)}\n`);
    fxD.runner.log.length = 0;
    await assert.rejects(
      restoreClaudeAfterDetach({
        plan: fxD.registration,
        installation: fxD.installation,
        prior: detached.prior,
        exec: fxD.runner,
        cwd: fxD.root,
        env: fxD.env,
      }),
      (error) => error.code === "claude-restore-source-invalid" && /plugin\.json/.test(error.message),
    );
    assert.deepEqual(mutationsOf(fxD.runner), [], "an invalid source blocks restore before any mutation");
    assert.equal(fxD.runner.state.marketplaces.length, 0);
    assert.equal(fxD.runner.state.plugins.length, 0);
  } finally {
    await fxD.cleanup();
  }
});

test("the fake CLI models marketplace removal as uninstalling every plugin it owns", async () => {
  const fx = await detachFixture();
  try {
    const marketplace = fx.identity.marketplace;
    fx.runner.state.marketplaces.push({
      name: "foreign-market",
      path: path.join(fx.directory, "foreign"),
      scope: "user",
    });
    // Either signal joins the blast radius — including the contradictory
    // suffix-owned plugin exact detach must refuse to expose to removal.
    fx.runner.state.plugins.push(
      { id: "helper@other-market", version: "1.0.0", scope: "local", enabled: true },
      { id: `helper@${marketplace}`, version: "1.0.0", scope: "user", enabled: true },
      { id: "explicit-tool", marketplace, version: "1.0.0", scope: "local", enabled: true },
      { id: `contradict-tool@${marketplace}`, marketplace: "other-market", version: "1.0.0", scope: "local", enabled: true },
      { id: "foreign-explicit", marketplace: "other-market", version: "1.0.0", scope: "local", enabled: true },
    );

    await fx.runner(["plugin", "marketplace", "remove", marketplace, "--scope", fx.scope], {
      cwd: fx.root,
      env: fx.env ?? process.env,
    });

    const ids = fx.runner.state.plugins.map((entry) => entry.id);
    assert.equal(ids.includes(fx.reference), false, "the registered plugin leaves with its marketplace");
    assert.equal(
      ids.includes(`helper@${marketplace}`),
      false,
      "an extra plugin of this marketplace leaves too, at any scope",
    );
    assert.equal(
      ids.includes("explicit-tool"),
      false,
      "explicit-marketplace ownership alone puts a plugin in the blast radius",
    );
    assert.equal(
      ids.includes(`contradict-tool@${marketplace}`),
      false,
      "a contradictory explicit field would not have hidden a suffix-owned plugin",
    );
    assert.equal(ids.includes("helper@other-market"), true, "plugins of other marketplaces survive");
    assert.equal(ids.includes("foreign-explicit"), true, "explicit ownership of another marketplace survives");
    assert.deepEqual(fx.runner.state.marketplaces.map((entry) => entry.name), ["foreign-market"]);

    // Membership accepts either signal and nothing else.
    assert.equal(pluginBelongsToMarketplace({ id: `team-tools@${marketplace}` }, marketplace), true);
    assert.equal(pluginBelongsToMarketplace({ id: "team-tools", marketplace }, marketplace), true);
    assert.equal(
      pluginBelongsToMarketplace({ id: `team-tools@${marketplace}`, marketplace: "other-market" }, marketplace),
      true,
      "a contradictory explicit field never hides suffix ownership",
    );
    assert.equal(
      pluginBelongsToMarketplace({ id: "team-tools@other-market", marketplace }, marketplace),
      true,
      "an explicit field claims a plugin whose id suffix disagrees",
    );
    assert.equal(pluginBelongsToMarketplace({ id: "team-tools", marketplace: "other-market" }, marketplace), false);
    assert.equal(pluginBelongsToMarketplace({ id: "team-tools@other-market" }, marketplace), false);
    assert.equal(pluginBelongsToMarketplace({}, marketplace), false);
    assert.equal(pluginBelongsToMarketplace(null, marketplace), false);
  } finally {
    await fx.cleanup();
  }
});

test("detach and restore work at user scope under a temporary Claude config", async () => {
  const fx = await detachFixture({ global: true });
  try {
    assert.equal(fx.scope, "user");
    assert.equal(fx.identity.plugin, "openagency-skill-router-global");
    assert.ok(
      fx.declarationFile.startsWith(fx.directory),
      "the declaration lives in the temporary CLAUDE_CONFIG_DIR, never the real HOME",
    );

    const detached = await detachClaude({
      plan: fx.registration,
      installation: fx.installation,
      exec: fx.runner,
      cwd: fx.root,
      env: fx.env,
    });
    assert.equal(detached.classification, "absent");
    const afterDetach = JSON.parse(await readFile(fx.declarationFile, "utf8"));
    assert.equal(afterDetach.extraKnownMarketplaces?.[fx.identity.marketplace], undefined);
    assert.deepEqual(mutationsOf(fx.runner), [
      `plugin uninstall ${fx.reference} --scope user`,
      `plugin marketplace remove ${fx.identity.marketplace} --scope user`,
    ]);

    fx.runner.log.length = 0;
    const restored = await restoreClaudeAfterDetach({
      plan: fx.registration,
      installation: fx.installation,
      prior: detached.prior,
      exec: fx.runner,
      cwd: fx.root,
      env: fx.env,
    });
    assert.equal(restored.classification, "healthy");
    assert.deepEqual(mutationsOf(fx.runner), [
      `plugin marketplace add --scope user ${fx.marketplaceRoot}`,
      `plugin install ${fx.reference} --scope user`,
    ]);
    assert.equal(fx.runner.state.plugins[0].scope, "user");
    const afterRestore = JSON.parse(await readFile(fx.declarationFile, "utf8"));
    assert.equal(afterRestore.extraKnownMarketplaces?.[fx.identity.marketplace]?.source?.path, fx.marketplaceRoot);

    // Every command still ran at the router root, never the caller's cwd.
    for (const call of fx.runner.calls) assert.equal(call.cwd, fx.root);
  } finally {
    await fx.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * Gate 5 finding 5 — marketplace membership uses either ownership
 * signal, and contradictory/malformed ownership or enabled facts are
 * retained by observation and classified as drift.
 * ------------------------------------------------------------------ */

test("ownership and enabled suspects are never classified healthy or absent", () => {
  const stateDirectory = path.join(os.tmpdir(), "skill-router-claude-classify-suspects");
  const identity = claudeIdentity({ global: false, stateDirectory });
  const plan = claudeRegistrationPlan({ identity, stateDirectory, version: "0.1.0" });
  const installation = buildInstallation({
    global: false,
    stateDirectory,
    harnesses: ["claude"],
    claude: { fingerprint: "0".repeat(64), version: "0.1.0" },
  });
  const { normalizePluginEntry } = claudeInternals;
  const healthyDeclaration = () => ({
    scope: "local",
    file: path.join(stateDirectory, ".claude", "settings.local.json"),
    exists: true,
    path: plan.marketplaceRoot,
  });
  const absentObservation = () => ({
    declaration: {
      scope: "local",
      file: path.join(stateDirectory, ".claude", "settings.local.json"),
      exists: false,
      path: null,
    },
    marketplaces: [],
    plugins: [],
    marketplacePlugins: [],
  });
  const visibleMarketplace = () => ({
    name: identity.marketplace,
    path: plan.marketplaceRoot,
    scope: "local",
  });
  const classify = (observation) => classifyClaudeUninstallState(observation, plan, installation);
  // Reasons a fully absent registration already produces, which a retained
  // suspect entry must not replace or downgrade to `absent`.
  const absentSideReasons = () => [
    `marketplace ${identity.marketplace} is not declared at local scope`,
    `marketplace ${identity.marketplace} is not registered with the Claude CLI`,
    `plugin ${plan.reference} is not installed at local scope`,
  ];

  // A contradictory exact reference is retained and never healthy.
  const contradictory = normalizePluginEntry({
    id: plan.reference,
    scope: "local",
    version: "0.1.0",
    enabled: true,
    marketplace: "elsewhere",
  });
  assert.deepEqual(
    classify({
      declaration: healthyDeclaration(),
      marketplaces: [visibleMarketplace()],
      plugins: [contradictory],
      marketplacePlugins: [contradictory],
    }),
    {
      classification: "drift",
      reasons: [
        `plugin ${plan.reference} declares marketplace elsewhere but its id belongs to ${identity.marketplace}`,
      ],
    },
  );

  // A suspect suffix-owned entry keeps a partially absent state out of absent.
  const partial = absentObservation();
  partial.marketplacePlugins = [
    normalizePluginEntry({
      id: `team-tools@${identity.marketplace}`,
      marketplace: 42,
      enabled: "yes",
      scope: "local",
      version: "1.0.0",
    }),
  ];
  assert.deepEqual(classify(partial), {
    classification: "drift",
    reasons: [
      ...absentSideReasons(),
      `plugin team-tools@${identity.marketplace} from marketplace ${identity.marketplace} is installed at local scope`,
      `plugin team-tools@${identity.marketplace} carries a malformed explicit marketplace field`,
      `plugin team-tools@${identity.marketplace} carries a malformed enabled value`,
    ],
  });

  // An owned entry without a usable id is retained as a suspect, not dropped.
  const orphan = absentObservation();
  orphan.marketplacePlugins = [
    normalizePluginEntry({ marketplace: identity.marketplace, scope: "local", version: "1.0.0", enabled: true }),
  ];
  assert.deepEqual(classify(orphan), {
    classification: "drift",
    reasons: [
      ...absentSideReasons(),
      `plugin unknown from marketplace ${identity.marketplace} is installed at local scope`,
      `a plugin owned by ${identity.marketplace} carries a malformed id`,
    ],
  });

  // Consistent signals and legitimately omitted optional fields stay healthy.
  for (const exact of [
    normalizePluginEntry({
      id: plan.reference,
      scope: "local",
      version: "0.1.0",
      enabled: true,
      marketplace: identity.marketplace,
    }),
    normalizePluginEntry({ id: plan.reference, scope: "local", version: "0.1.0", enabled: true }),
    normalizePluginEntry({ id: plan.reference, scope: "local", version: "0.1.0" }),
  ]) {
    assert.deepEqual(
      classify({
        declaration: healthyDeclaration(),
        marketplaces: [visibleMarketplace()],
        plugins: [exact],
        marketplacePlugins: [exact],
      }),
      { classification: "healthy", reasons: [] },
    );
  }
});

test("contradictory and malformed signals on the exact reference refuse detach and restore", async () => {
  const fx = await detachFixture();
  try {
    // Unrelated registrations that must survive every refusal.
    fx.runner.state.marketplaces.push({
      name: "foreign-market",
      path: path.join(fx.directory, "foreign"),
      scope: "user",
    });
    fx.runner.state.plugins.push({ id: "foreign-plugin@foreign-market", version: "1.0.0", scope: "user", enabled: true });
    const marketplacesBefore = JSON.stringify(fx.runner.state.marketplaces);
    const pluginsBefore = JSON.stringify(fx.runner.state.plugins);
    const exact = () => fx.runner.state.plugins.find((entry) => entry.id === fx.reference);
    const observe = () =>
      observeClaudeUninstallState({ plan: fx.registration, exec: fx.runner, cwd: fx.root, env: fx.env });
    const classify = async () =>
      classifyClaudeUninstallState(await observe(), fx.registration, fx.installation);
    const detach = () =>
      detachClaude({ plan: fx.registration, installation: fx.installation, exec: fx.runner, cwd: fx.root, env: fx.env });
    const restore = () =>
      restoreClaudeAfterDetach({
        plan: fx.registration,
        installation: fx.installation,
        prior: { classification: "healthy", observation: null, reasons: [] },
        exec: fx.runner,
        cwd: fx.root,
        env: fx.env,
      });
    const malformedMarketplace = `plugin ${fx.reference} carries a malformed explicit marketplace field`;
    const malformedEnabled = `plugin ${fx.reference} carries a malformed enabled value`;
    const contradiction = `plugin ${fx.reference} declares marketplace other-market but its id belongs to ${fx.identity.marketplace}`;
    const dropField = (field) => (entry) => {
      delete entry[field];
    };

    const cases = [
      {
        name: "contradictory explicit marketplace",
        mutate: (entry) => { entry.marketplace = "other-market"; },
        reset: dropField("marketplace"),
        reasons: [contradiction],
      },
      {
        name: "numeric explicit marketplace",
        mutate: (entry) => { entry.marketplace = 42; },
        reset: dropField("marketplace"),
        reasons: [malformedMarketplace],
        expect: (normalized) => {
          assert.equal(normalized.marketplacePresent, true, "presence is retained");
          assert.equal(normalized.marketplaceValid, false, "malformed presence is distinguished from omission");
          assert.equal(normalized.marketplace, null);
        },
      },
      {
        name: "null explicit marketplace",
        mutate: (entry) => { entry.marketplace = null; },
        reset: dropField("marketplace"),
        reasons: [malformedMarketplace],
        expect: (normalized) => {
          assert.equal(normalized.marketplacePresent, true, "null presence is not read as omission");
          assert.equal(normalized.marketplaceValid, false);
        },
      },
      {
        name: "object explicit marketplace",
        mutate: (entry) => { entry.marketplace = { name: "elsewhere" }; },
        reset: dropField("marketplace"),
        reasons: [malformedMarketplace],
      },
      {
        name: "string enabled value",
        mutate: (entry) => { entry.enabled = "yes"; },
        reset: dropField("enabled"),
        reasons: [malformedEnabled],
        expect: (normalized) => {
          assert.equal(normalized.enabledPresent, true);
          assert.equal(normalized.enabledValid, false, "a present non-boolean is never coerced");
          assert.equal(normalized.enabled, null);
        },
      },
      {
        name: "numeric enabled value",
        mutate: (entry) => { entry.enabled = 1; },
        reset: dropField("enabled"),
        reasons: [malformedEnabled],
      },
      {
        name: "null enabled value",
        mutate: (entry) => { entry.enabled = null; },
        reset: dropField("enabled"),
        reasons: [malformedEnabled],
      },
      {
        name: "object enabled value",
        mutate: (entry) => { entry.enabled = {}; },
        reset: dropField("enabled"),
        reasons: [malformedEnabled],
      },
    ];

    for (const scenario of cases) {
      scenario.mutate(exact());
      const observed = await observe();
      assert.equal(observed.plugins.length, 1, `${scenario.name}: the exact reference is observed`);
      assert.equal(
        observed.marketplacePlugins.length,
        1,
        `${scenario.name}: suffix ownership still retains the entry`,
      );
      scenario.expect?.(observed.plugins[0]);

      const verdict = classifyClaudeUninstallState(observed, fx.registration, fx.installation);
      assert.equal(verdict.classification, "drift", scenario.name);
      assert.deepEqual(verdict.reasons, scenario.reasons, scenario.name);

      fx.runner.log.length = 0;
      let failure = null;
      try {
        await detach();
      } catch (error) {
        failure = error;
      }
      assert.ok(failure, `${scenario.name}: detach fails`);
      assert.equal(failure.code, "claude-detach-drift", scenario.name);
      for (const reason of scenario.reasons) {
        assert.ok(failure.message.includes(reason), `${scenario.name}: ${failure.message}`);
      }
      assert.deepEqual(mutationsOf(fx.runner), [], `${scenario.name}: no mutation before refusal`);
      scenario.reset(exact());
    }

    // A real boolean false still reads as disabled, never malformed.
    exact().enabled = false;
    assert.equal((await observe()).plugins[0].enabled, false, "boolean false is preserved");
    assert.deepEqual(await classify(), {
      classification: "drift",
      reasons: [`plugin ${fx.reference} is disabled at ${fx.scope} scope`],
    });
    fx.runner.log.length = 0;
    await assert.rejects(detach(), (error) => error.code === "claude-detach-drift" && /disabled/.test(error.message));
    assert.deepEqual(mutationsOf(fx.runner), []);
    exact().enabled = true;

    // Both ownership signals present and consistent stay healthy.
    exact().marketplace = fx.identity.marketplace;
    const consistent = await classify();
    assert.deepEqual(consistent, { classification: "healthy", reasons: [] });
    assert.equal((await observe()).plugins[0].marketplaceValid, true);
    delete exact().marketplace;

    // Restore refuses the contradictory state instead of installing over it.
    exact().marketplace = "other-market";
    fx.runner.log.length = 0;
    await assert.rejects(
      restore(),
      (error) =>
        error.code === "claude-restore-drift" &&
        /restore only installs a missing exact reference/.test(error.message),
    );
    assert.deepEqual(mutationsOf(fx.runner), [], "a refused restore never mutates");
    delete exact().marketplace;

    // Unrelated state and the registration itself survived every refusal.
    assert.equal(JSON.stringify(fx.runner.state.marketplaces), marketplacesBefore);
    assert.equal(JSON.stringify(fx.runner.state.plugins), pluginsBefore);
    const declaration = JSON.parse(await readFile(fx.declarationFile, "utf8"));
    assert.equal(
      declaration.extraKnownMarketplaces?.[fx.identity.marketplace]?.source?.path,
      fx.marketplaceRoot,
      "the scope-owned declaration is untouched",
    );
    assert.deepEqual(await classify(), { classification: "healthy", reasons: [] });
  } finally {
    await fx.cleanup();
  }
});

test("extra plugins keep either ownership signal and block detach before any mutation", async () => {
  const fx = await detachFixture();
  try {
    fx.runner.state.marketplaces.push({
      name: "foreign-market",
      path: path.join(fx.directory, "foreign"),
      scope: "user",
    });
    fx.runner.state.plugins.push({ id: "foreign-plugin@foreign-market", version: "1.0.0", scope: "user", enabled: true });
    const marketplacesBefore = JSON.stringify(fx.runner.state.marketplaces);
    const pluginsBefore = JSON.stringify(fx.runner.state.plugins);
    const marketplace = fx.identity.marketplace;
    const ownedBase = (entry) => ({ version: "1.0.0", scope: "local", enabled: true, ...entry });
    const ownedReason = (id) => `plugin ${id} from marketplace ${marketplace} is installed at local scope`;

    const cases = [
      {
        name: "suffix-owned extra with a contradicting explicit marketplace",
        entry: ownedBase({ id: `team-tools@${marketplace}`, marketplace: "other-market" }),
        reasons: [
          ownedReason(`team-tools@${marketplace}`),
          `plugin team-tools@${marketplace} declares marketplace other-market but its id belongs to ${marketplace}`,
        ],
        expect: (normalized) => {
          assert.equal(normalized.marketplace, "other-market", "the contradictory field is retained");
        },
      },
      {
        name: "suffix-owned extra with a malformed explicit marketplace",
        entry: ownedBase({ id: `team-tools@${marketplace}`, marketplace: 42 }),
        reasons: [
          ownedReason(`team-tools@${marketplace}`),
          `plugin team-tools@${marketplace} carries a malformed explicit marketplace field`,
        ],
        expect: (normalized) => {
          assert.equal(normalized.marketplacePresent, true);
          assert.equal(normalized.marketplaceValid, false);
        },
      },
      {
        name: "explicit-only extra without a marketplace suffix",
        entry: ownedBase({ id: "team-tools", marketplace }),
        reasons: [ownedReason("team-tools")],
        expect: (normalized) => {
          assert.equal(normalized.marketplace, marketplace, "explicit membership keeps the entry");
        },
      },
      {
        name: "owned extra with a missing id",
        entry: ownedBase({ id: null, marketplace }),
        reasons: [
          `plugin unknown from marketplace ${marketplace} is installed at local scope`,
          `a plugin owned by ${marketplace} carries a malformed id`,
        ],
      },
      {
        name: "owned extra with a malformed enabled value",
        entry: ownedBase({ id: `team-tools@${marketplace}`, enabled: "yes" }),
        reasons: [
          ownedReason(`team-tools@${marketplace}`),
          `plugin team-tools@${marketplace} carries a malformed enabled value`,
        ],
      },
      {
        name: "owned extra at another scope",
        entry: ownedBase({ id: `team-tools@${marketplace}`, scope: "user" }),
        reasons: [`plugin team-tools@${marketplace} from marketplace ${marketplace} is installed at user scope`],
      },
    ];

    for (const scenario of cases) {
      fx.runner.state.plugins.push(scenario.entry);
      const observed = await observeClaudeUninstallState({
        plan: fx.registration,
        exec: fx.runner,
        cwd: fx.root,
        env: fx.env,
      });
      const retained = observed.marketplacePlugins.find((entry) => entry.id === scenario.entry.id);
      assert.ok(retained, `${scenario.name}: retained in marketplacePlugins by either signal`);
      scenario.expect?.(retained);
      assert.equal(
        observed.plugins.some((entry) => entry.id === scenario.entry.id),
        false,
        `${scenario.name}: not mistaken for the exact reference`,
      );

      const verdict = classifyClaudeUninstallState(observed, fx.registration, fx.installation);
      assert.equal(verdict.classification, "drift", scenario.name);
      assert.deepEqual(verdict.reasons, scenario.reasons, scenario.name);

      fx.runner.log.length = 0;
      let failure = null;
      try {
        await detachClaude({
          plan: fx.registration,
          installation: fx.installation,
          exec: fx.runner,
          cwd: fx.root,
          env: fx.env,
        });
      } catch (error) {
        failure = error;
      }
      assert.ok(failure, `${scenario.name}: detach fails`);
      assert.equal(failure.code, "claude-detach-drift", scenario.name);
      assert.ok(
        failure.message.includes(scenario.reasons[0]),
        `${scenario.name}: ${failure.message}`,
      );
      assert.deepEqual(mutationsOf(fx.runner), [], `${scenario.name}: no mutation before refusal`);
      fx.runner.state.plugins.pop();
    }

    // Unrelated state is unchanged and the registration is healthy again.
    assert.equal(JSON.stringify(fx.runner.state.marketplaces), marketplacesBefore);
    assert.equal(JSON.stringify(fx.runner.state.plugins), pluginsBefore);
    const observed = await observeClaudeUninstallState({
      plan: fx.registration,
      exec: fx.runner,
      cwd: fx.root,
      env: fx.env,
    });
    assert.deepEqual(classifyClaudeUninstallState(observed, fx.registration, fx.installation), {
      classification: "healthy",
      reasons: [],
    });
  } finally {
    await fx.cleanup();
  }
});

test("omitted optional plugin fields stay valid where the CLI may omit them", async () => {
  const fx = await detachFixture();
  try {
    const marketplace = fx.identity.marketplace;
    const exact = fx.runner.state.plugins[0];
    const classify = async () =>
      classifyClaudeUninstallState(
        await observeClaudeUninstallState({ plan: fx.registration, exec: fx.runner, cwd: fx.root, env: fx.env }),
        fx.registration,
        fx.installation,
      );

    // Omission is not malformed presence.
    delete exact.enabled;
    delete exact.marketplace;
    const observed = await observeClaudeUninstallState({
      plan: fx.registration,
      exec: fx.runner,
      cwd: fx.root,
      env: fx.env,
    });
    assert.equal(observed.plugins[0].marketplacePresent, false, "omitted marketplace is recorded as an omission");
    assert.equal(observed.plugins[0].marketplaceValid, true);
    assert.equal(observed.plugins[0].enabledPresent, false, "omitted enabled is recorded as an omission");
    assert.equal(observed.plugins[0].enabledValid, true);
    assert.equal(observed.plugins[0].enabled, true, "an omitted enabled field reports as enabled");
    assert.deepEqual(await classify(), { classification: "healthy", reasons: [] });

    // A suffix-owned extra with no explicit ownership field is recognized
    // without gaining any suspect reason.
    fx.runner.state.plugins.push({ id: `team-tools@${marketplace}`, version: "1.0.0", scope: "local", enabled: true });
    const withExtra = await observeClaudeUninstallState({
      plan: fx.registration,
      exec: fx.runner,
      cwd: fx.root,
      env: fx.env,
    });
    assert.equal(withExtra.marketplacePlugins.length, 2, "suffix ownership needs no explicit field");
    assert.deepEqual(
      classifyClaudeUninstallState(withExtra, fx.registration, fx.installation),
      {
        classification: "drift",
        reasons: [`plugin team-tools@${marketplace} from marketplace ${marketplace} is installed at local scope`],
      },
      "omitted ownership fields add no suspect reason",
    );
    fx.runner.state.plugins.pop();

    // Both signals present, consistent, and boolean stay healthy.
    exact.marketplace = marketplace;
    exact.enabled = true;
    const consistent = await observeClaudeUninstallState({
      plan: fx.registration,
      exec: fx.runner,
      cwd: fx.root,
      env: fx.env,
    });
    assert.equal(consistent.plugins[0].marketplacePresent, true);
    assert.equal(consistent.plugins[0].marketplaceValid, true);
    assert.equal(consistent.plugins[0].enabledValid, true);
    assert.deepEqual(classifyClaudeUninstallState(consistent, fx.registration, fx.installation), {
      classification: "healthy",
      reasons: [],
    });
    delete exact.marketplace;
  } finally {
    await fx.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * Phase 6, lane 3 — journal-agnostic lifecycle observer seam
 * ------------------------------------------------------------------ */

/** Records every hook invocation, optionally intercepting one of them. */
function createLifecycleRecorder({ baseSequence, rejectBefore, rejectAfter, failAt } = {}) {
  const events = [];
  const observer = {
    ...(baseSequence !== undefined ? { baseSequence } : {}),
    async beforeMutation(action, beforeObservation) {
      events.push({ hook: "before", action, beforeObservation });
      if (rejectBefore) throw rejectBefore;
      if (failAt === "before") throw new Error("observer before failure");
    },
    async afterMutation(action, outcome, afterObservation) {
      events.push({ hook: "after", action, outcome, afterObservation });
      if (rejectAfter) throw rejectAfter;
      if (failAt === "after" && events.filter((event) => event.hook === "after").length === 1) {
        throw new Error("observer after failure");
      }
    },
  };
  return { observer, events };
}

const captureShapeKeys = ["declaration", "plugin", "visible"];
const uninstallShapeKeys = [
  "declaration",
  "marketplace",
  "marketplacePlugins",
  "marketplaces",
  "plugins",
  "reference",
  "scope",
];

test("lifecycle observer brackets registration and compensation with exact actions", async () => {
  const fx = await stagedFixture();
  try {
    const events = [];
    const mutationsAtBefore = [];
    const observer = {
      baseSequence: 40,
      async beforeMutation(action, beforeObservation) {
        mutationsAtBefore.push(mutationsOf(fx.runner).length);
        events.push({ hook: "before", action, beforeObservation });
      },
      async afterMutation(action, outcome, afterObservation) {
        events.push({ hook: "after", action, outcome, afterObservation });
      },
    };
    const actions = [];

    // Registration mutates exactly twice: marketplace add, then install.
    await registerClaude({
      plan: fx.registration,
      exec: fx.runner,
      actions,
      cwd: fx.root,
      env: fx.env,
      observer,
    });
    assert.deepEqual(
      events.map((event) => `${event.hook}:${event.action.type}`),
      ["before:marketplace-add", "after:marketplace-add", "before:plugin-install", "after:plugin-install"],
      "hooks bracket each mutation in order",
    );
    assert.deepEqual(
      mutationsAtBefore,
      [0, 1],
      "beforeMutation is awaited durably before the CLI runs",
    );
    const marketplaceAdd = events[0].action;
    assert.deepEqual(marketplaceAdd, {
      sequence: 41,
      id: `marketplace-add:${fx.scope}:${fx.identity.marketplace}`,
      type: "marketplace-add",
      scope: fx.scope,
      marketplace: fx.identity.marketplace,
      path: fx.marketplaceRoot,
    });
    assert.ok(Object.isFrozen(marketplaceAdd), "actions are frozen plain data");
    assert.deepEqual(Object.keys(events[1].outcome), ["status"]);
    assert.equal(events[1].outcome.status, "succeeded");
    assert.ok(Object.isFrozen(events[1].outcome), "outcomes are frozen plain data");
    assert.deepEqual(Object.keys(events[0].beforeObservation).sort(), captureShapeKeys);
    assert.equal(events[0].beforeObservation.declaration.path, null, "the before-state predates the add");
    assert.equal(events[1].afterObservation.declaration.path, fx.marketplaceRoot, "the after-state proves the add landed");
    const install = events[2].action;
    assert.deepEqual(install, {
      sequence: 42,
      id: `plugin-install:${fx.scope}:${fx.reference}`,
      type: "plugin-install",
      scope: fx.scope,
      reference: fx.reference,
      marketplace: fx.identity.marketplace,
      version: fx.installation.claude.version,
    });
    assert.equal(events[3].afterObservation.plugin?.version, fx.installation.claude.version);

    // A second registration updates the exact reference.
    events.length = 0;
    await registerClaude({
      plan: fx.registration,
      exec: fx.runner,
      actions,
      cwd: fx.root,
      env: fx.env,
      observer,
    });
    assert.deepEqual(
      events.map((event) => `${event.hook}:${event.action.type}`),
      ["before:plugin-update", "after:plugin-update"],
      "an exact declaration skips the marketplace mutation entirely",
    );
    assert.deepEqual(events[0].action, {
      sequence: 41,
      id: `plugin-update:${fx.scope}:${fx.reference}`,
      type: "plugin-update",
      scope: fx.scope,
      reference: fx.reference,
      marketplace: fx.identity.marketplace,
      version: fx.installation.claude.version,
      priorVersion: ROUTER_PACKAGE_VERSION,
    });
    // Sequence numbering is per API call; a journal supplies an incremented
    // baseSequence per call for globally unique numbers.

    // The recorded action log stays exactly the classic shape — the observer
    // never pollutes it.
    assert.deepEqual(actions, [
      { type: "marketplace-add", name: fx.identity.marketplace, scope: fx.scope, path: fx.marketplaceRoot },
      { type: "plugin-install", reference: fx.reference, scope: fx.scope },
      {
        type: "plugin-update",
        reference: fx.reference,
        scope: fx.scope,
        priorVersion: ROUTER_PACKAGE_VERSION,
        priorScope: fx.scope,
      },
    ]);

    // Compensation of an update rollback restores the prior version.
    fx.runner.state.plugins[0].version = "9.9.9";
    const rollback = createLifecycleRecorder();
    await compensateClaude({
      actions: [
        {
          type: "plugin-update",
          reference: fx.reference,
          scope: fx.scope,
          priorVersion: ROUTER_PACKAGE_VERSION,
          priorScope: fx.scope,
        },
      ],
      exec: fx.runner,
      cwd: fx.root,
      env: fx.env,
      observer: rollback.observer,
      plan: fx.registration,
    });
    assert.deepEqual(
      rollback.events.map((event) => `${event.hook}:${event.action.type}`),
      ["before:plugin-uninstall", "after:plugin-uninstall", "before:plugin-install", "after:plugin-install"],
      "an update rollback uninstalls then reinstalls the exact prior version",
    );
    assert.deepEqual(rollback.events[2].action, {
      sequence: 2,
      id: `plugin-install:${fx.scope}:${fx.reference}`,
      type: "plugin-install",
      scope: fx.scope,
      reference: fx.reference,
      marketplace: fx.identity.marketplace,
      version: ROUTER_PACKAGE_VERSION,
    });
    assert.deepEqual(Object.keys(rollback.events[0].beforeObservation).sort(), captureShapeKeys);
    assert.equal(fx.runner.state.plugins[0].version, ROUTER_PACKAGE_VERSION, "the prior version is back");

    // Full compensation of the registration log: uninstall, then remove.
    const fullRollback = createLifecycleRecorder();
    await compensateClaude({
      actions,
      exec: fx.runner,
      cwd: fx.root,
      env: fx.env,
      observer: fullRollback.observer,
      plan: fx.registration,
    });
    assert.deepEqual(
      fullRollback.events.map((event) => `${event.hook}:${event.action.type}`),
      [
        "before:plugin-uninstall",
        "after:plugin-uninstall",
        "before:marketplace-remove",
        "after:marketplace-remove",
      ],
    );
    assert.deepEqual(fullRollback.events[0].action, {
      sequence: 1,
      id: `plugin-uninstall:${fx.scope}:${fx.reference}`,
      type: "plugin-uninstall",
      scope: fx.scope,
      reference: fx.reference,
      marketplace: fx.identity.marketplace,
    });
    assert.deepEqual(fullRollback.events[2].action, {
      sequence: 2,
      id: `marketplace-remove:${fx.scope}:${fx.identity.marketplace}`,
      type: "marketplace-remove",
      scope: fx.scope,
      marketplace: fx.identity.marketplace,
      path: fx.marketplaceRoot,
    });
    for (const event of fullRollback.events.filter((entry) => entry.hook === "after")) {
      assert.deepEqual(event.outcome, { status: "succeeded" });
    }
    assert.deepEqual(fx.runner.state.plugins, [], "compensation rolled back the plugin");
    assert.deepEqual(fx.runner.state.marketplaces, [], "compensation rolled back the marketplace");
  } finally {
    await fx.cleanup();
  }
});

test("lifecycle observer brackets detach and restore with uninstall-state observations", async () => {
  const fx = await detachFixture();
  try {
    const detachEvents = [];
    const detachRecorder = createLifecycleRecorder();
    const detached = await detachClaude({
      plan: fx.registration,
      installation: fx.installation,
      exec: fx.runner,
      cwd: fx.root,
      env: fx.env,
      observer: detachRecorder.observer,
    });
    detachEvents.push(...detachRecorder.events);
    assert.equal(detached.classification, "absent");
    assert.deepEqual(
      detachEvents.map((event) => `${event.hook}:${event.action.type}`),
      ["before:plugin-uninstall", "after:plugin-uninstall", "before:marketplace-remove", "after:marketplace-remove"],
    );
    assert.deepEqual(detachEvents[0].action, {
      sequence: 1,
      id: `plugin-uninstall:${fx.scope}:${fx.reference}`,
      type: "plugin-uninstall",
      scope: fx.scope,
      reference: fx.reference,
      marketplace: fx.identity.marketplace,
    });
    assert.deepEqual(detachEvents[2].action, {
      sequence: 2,
      id: `marketplace-remove:${fx.scope}:${fx.identity.marketplace}`,
      type: "marketplace-remove",
      scope: fx.scope,
      marketplace: fx.identity.marketplace,
      path: fx.marketplaceRoot,
    });
    assert.deepEqual(Object.keys(detachEvents[0].beforeObservation).sort(), uninstallShapeKeys);
    assert.equal(detachEvents[0].beforeObservation.plugins.length, 1, "the before-state shows the installed plugin");
    assert.deepEqual(detachEvents[1].afterObservation.plugins, [], "the after-state proves the plugin is gone");
    const finalObservation = detachEvents[3].afterObservation;
    assert.equal(finalObservation.declaration.path, null, "the final after-state is fully absent");
    assert.deepEqual(finalObservation.marketplaces, []);
    assert.deepEqual(finalObservation.plugins, []);
    assert.deepEqual(finalObservation.marketplacePlugins, []);
    assert.deepEqual(detachEvents[1].outcome, { status: "succeeded" });

    const restoreRecorder = createLifecycleRecorder();
    const restored = await restoreClaudeAfterDetach({
      plan: fx.registration,
      installation: fx.installation,
      prior: detached.prior,
      exec: fx.runner,
      cwd: fx.root,
      env: fx.env,
      observer: restoreRecorder.observer,
    });
    assert.equal(restored.classification, "healthy");
    assert.deepEqual(
      restoreRecorder.events.map((event) => `${event.hook}:${event.action.type}`),
      ["before:marketplace-add", "after:marketplace-add", "before:plugin-install", "after:plugin-install"],
    );
    assert.deepEqual(restoreRecorder.events[0].action, {
      sequence: 1,
      id: `marketplace-add:${fx.scope}:${fx.identity.marketplace}`,
      type: "marketplace-add",
      scope: fx.scope,
      marketplace: fx.identity.marketplace,
      path: fx.marketplaceRoot,
    });
    assert.deepEqual(restoreRecorder.events[2].action, {
      sequence: 2,
      id: `plugin-install:${fx.scope}:${fx.reference}`,
      type: "plugin-install",
      scope: fx.scope,
      reference: fx.reference,
      marketplace: fx.identity.marketplace,
      version: fx.installation.claude.version,
    });
    assert.deepEqual(Object.keys(restoreRecorder.events[2].beforeObservation).sort(), uninstallShapeKeys);
    assert.equal(
      restoreRecorder.events[3].afterObservation.plugins[0].version,
      fx.installation.claude.version,
    );
  } finally {
    await fx.cleanup();
  }
});

test("a rejected beforeMutation hook issues zero mutations and leaves state unchanged", async () => {
  const fx = await stagedFixture();
  try {
    const recorder = createLifecycleRecorder({ rejectBefore: new Error("journal write failed") });
    const actions = [];
    let failure = null;
    try {
      await registerClaude({
        plan: fx.registration,
        exec: fx.runner,
        actions,
        cwd: fx.root,
        env: fx.env,
        observer: recorder.observer,
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, "the rejected intent surfaces");
    assert.equal(failure.code, "claude-observer-failed");
    assert.equal(failure.phase, "before-mutation");
    assert.deepEqual(failure.action, {
      sequence: 1,
      id: `marketplace-add:${fx.scope}:${fx.identity.marketplace}`,
      type: "marketplace-add",
      scope: fx.scope,
      marketplace: fx.identity.marketplace,
      path: fx.marketplaceRoot,
    });
    assert.equal(failure.actions, actions, "the recorded action log travels on the error");
    assert.ok(failure.beforeObservation, "the pre-mutation observation travels on the error");
    assert.equal(failure.beforeObservation.declaration.path, null);
    assert.equal(failure.afterObservation, null, "no mutation ran, so there is no after-state");
    assert.equal(failure.outcome, null, "no mutation outcome exists");
    assert.match(failure.message, /journal write failed/);
    assert.deepEqual(recorder.events.map((event) => event.hook), ["before"], "the after-hook never runs");

    assert.deepEqual(mutationsOf(fx.runner), [], "zero mutation calls");
    assert.deepEqual(fx.runner.state.marketplaces, []);
    assert.deepEqual(fx.runner.state.plugins, []);
    await assert.rejects(readFile(fx.declarationFile, "utf8"), /ENOENT/, "no declaration was written");

    // The same guarantee applies to detach: a rejected intent stops the flow
    // before the exact uninstall, leaving the healthy registration intact.
    const registered = await detachFixture();
    try {
      const detachRecorder = createLifecycleRecorder({ rejectBefore: new Error("journal write failed") });
      let detachFailure = null;
      try {
        await detachClaude({
          plan: registered.registration,
          installation: registered.installation,
          exec: registered.runner,
          cwd: registered.root,
          env: registered.env,
          observer: detachRecorder.observer,
        });
      } catch (error) {
        detachFailure = error;
      }
      assert.equal(detachFailure?.code, "claude-observer-failed");
      assert.equal(detachFailure.phase, "before-mutation");
      assert.equal(detachFailure.action.type, "plugin-uninstall");
      assert.equal(detachFailure.prior.classification, "healthy");
      assert.deepEqual(mutationsOf(registered.runner), [], "zero mutation calls");
      const observed = await observeClaudeUninstallState({
        plan: registered.registration,
        exec: registered.runner,
        cwd: registered.root,
      });
      assert.equal(
        classifyClaudeUninstallState(observed, registered.registration, registered.installation).classification,
        "healthy",
        "the registration is untouched",
      );
    } finally {
      await registered.cleanup();
    }

    // (c) An unobservable pre-state fails closed before the hook and before
    // any mutation: intent can never be journaled without its observation.
    const unobservable = await stagedFixture();
    try {
      const blocked = async (argv, options = {}) => {
        if (argv.join(" ") === "plugin marketplace list --json") throw new Error("list exploded");
        return unobservable.runner(argv, options);
      };
      const blockedRecorder = createLifecycleRecorder();
      let blockedFailure = null;
      try {
        await registerClaude({
          plan: unobservable.registration,
          exec: blocked,
          actions: [],
          cwd: unobservable.root,
          env: unobservable.env,
          observer: blockedRecorder.observer,
        });
      } catch (error) {
        blockedFailure = error;
      }
      assert.equal(blockedFailure?.code, "claude-observation-failed");
      assert.match(blockedFailure.message, /list exploded/);
      assert.deepEqual(blockedRecorder.events, [], "no hook runs without a pre-mutation observation");
      assert.deepEqual(mutationsOf(unobservable.runner), [], "zero mutation calls");
    } finally {
      await unobservable.cleanup();
    }
  } finally {
    await fx.cleanup();
  }
});

test("afterMutation reports success, CLI failure, and observation failure", async () => {
  // (a) Fail-before-mutation: outcome reflects the CLI error; nothing landed.
  const fxA = await stagedFixture();
  try {
    const recorder = createLifecycleRecorder();
    fxA.runner.failOn(`plugin install ${fxA.reference} --scope ${fxA.scope}`, "install refused");
    await assert.rejects(
      registerClaude({
        plan: fxA.registration,
        exec: fxA.runner,
        actions: [],
        cwd: fxA.root,
        env: fxA.env,
        observer: recorder.observer,
      }),
      /install refused/,
      "the original CLI error still surfaces unchanged",
    );
    const failed = recorder.events.at(-1);
    assert.equal(failed.hook, "after");
    assert.equal(failed.action.type, "plugin-install");
    assert.deepEqual(failed.outcome, { status: "failed", errorCode: "CLAUDE_FAILED", message: "install refused" });
    assert.ok(Object.isFrozen(failed.outcome));
    assert.equal(failed.afterObservation.plugin, null, "after-observation proves nothing landed");
  } finally {
    await fxA.cleanup();
  }

  // (b) Mutate-then-error: status reflects the CLI error while the
  // after-observation proves the desired state landed anyway.
  const fxB = await stagedFixture();
  try {
    const recorder = createLifecycleRecorder();
    fxB.runner.failOn(`plugin install ${fxB.reference} --scope ${fxB.scope}`, "install exploded", {
      mutate: true,
    });
    await assert.rejects(
      registerClaude({
        plan: fxB.registration,
        exec: fxB.runner,
        actions: [],
        cwd: fxB.root,
        env: fxB.env,
        observer: recorder.observer,
      }),
      /install exploded/,
    );
    const failed = recorder.events.at(-1);
    assert.deepEqual(failed.outcome, { status: "failed", errorCode: "CLAUDE_FAILED", message: "install exploded" });
    assert.equal(
      failed.afterObservation.plugin?.version,
      fxB.installation.claude.version,
      "after-observation proves the install landed despite the error",
    );
  } finally {
    await fxB.cleanup();
  }

  // (c) Observation failure after a landed mutation: the hook still runs with
  // a bounded observation-failed outcome and a null observation.
  const fxC = await stagedFixture();
  try {
    const recorder = createLifecycleRecorder();
    const addCommand = `plugin marketplace add --scope ${fxC.scope} ${fxC.marketplaceRoot}`;
    let mutations = 0;
    let failedObservation = false;
    const flaky = async (argv, options = {}) => {
      const key = argv.join(" ");
      if (key === addCommand) mutations += 1;
      if (mutations > 0 && !failedObservation && key === "plugin list --json") {
        failedObservation = true;
        throw new Error("observation exploded");
      }
      return fxC.runner(argv, options);
    };
    await registerClaude({
      plan: fxC.registration,
      exec: flaky,
      actions: [],
      cwd: fxC.root,
      env: fxC.env,
      observer: recorder.observer,
    });
    const afterAdd = recorder.events[1];
    assert.equal(afterAdd.hook, "after");
    assert.deepEqual(afterAdd.outcome, {
      status: "succeeded",
      errorCode: "claude-observation-failed",
      message: "observation exploded",
    });
    assert.equal(afterAdd.afterObservation, null, "an unobservable re-read is reported as null");
    const afterInstall = recorder.events.at(-1);
    assert.deepEqual(afterInstall.outcome, { status: "succeeded" }, "later mutations report normally again");
  } finally {
    await fxC.cleanup();
  }

  // (d) Detach observation failure: the hook runs before the lifecycle error
  // surfaces, and no later mutation is issued.
  const fxD = await detachFixture();
  try {
    const recorder = createLifecycleRecorder();
    const uninstallCommand = `plugin uninstall ${fxD.reference} --scope ${fxD.scope}`;
    let mutations = 0;
    let failedObservation = false;
    const flaky = async (argv, options = {}) => {
      const key = argv.join(" ");
      if (key === uninstallCommand) mutations += 1;
      if (mutations > 0 && !failedObservation && key === "plugin marketplace list --json") {
        failedObservation = true;
        throw new Error("observation exploded");
      }
      return fxD.runner(argv, options);
    };
    await assert.rejects(
      detachClaude({
        plan: fxD.registration,
        installation: fxD.installation,
        exec: flaky,
        cwd: fxD.root,
        env: fxD.env,
        observer: recorder.observer,
      }),
      (error) => error.code === "claude-detach-observation-failed",
    );
    assert.deepEqual(
      recorder.events.map((event) => `${event.hook}:${event.action.type}`),
      ["before:plugin-uninstall", "after:plugin-uninstall"],
    );
    assert.deepEqual(recorder.events[1].outcome, {
      status: "succeeded",
      errorCode: "claude-observation-failed",
      message: "observation exploded",
    });
    assert.equal(recorder.events[1].afterObservation, null);
    assert.deepEqual(
      mutationsOf(fxD.runner),
      [uninstallCommand],
      "the marketplace removal is never issued after an unobservable step",
    );
  } finally {
    await fxD.cleanup();
  }
});

test("an afterMutation rejection surfaces recovery context without undoing anything", async () => {
  // (a) Registration: the marketplace add landed, then the journal write fails.
  const fxA = await stagedFixture();
  try {
    const recorder = createLifecycleRecorder({ failAt: "after" });
    const actions = [];
    let failure = null;
    try {
      await registerClaude({
        plan: fxA.registration,
        exec: fxA.runner,
        actions,
        cwd: fxA.root,
        env: fxA.env,
        observer: recorder.observer,
      });
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.code, "claude-observer-failed");
    assert.equal(failure.phase, "after-mutation");
    assert.deepEqual(failure.action, {
      sequence: 1,
      id: `marketplace-add:${fxA.scope}:${fxA.identity.marketplace}`,
      type: "marketplace-add",
      scope: fxA.scope,
      marketplace: fxA.identity.marketplace,
      path: fxA.marketplaceRoot,
    });
    assert.equal(failure.actions, actions);
    assert.deepEqual(failure.outcome, { status: "succeeded" });
    assert.equal(failure.beforeObservation.declaration.path, null, "the pre-mutation state travels");
    assert.equal(failure.afterObservation.declaration.path, fxA.marketplaceRoot, "the landed state travels");
    assert.equal(
      fxA.runner.log.some((line) => /marketplace remove|uninstall/.test(line)),
      false,
      "Claude code never auto-compensates an observer persistence failure",
    );
    assert.equal(fxA.runner.state.marketplaces.length, 1, "the landed marketplace is not removed");
    assert.equal(
      JSON.parse(await readFile(fxA.declarationFile, "utf8")).extraKnownMarketplaces?.[fxA.identity.marketplace]
        ?.source?.path,
      fxA.marketplaceRoot,
    );
  } finally {
    await fxA.cleanup();
  }

  // (b) Detach: the uninstall landed, the journal write fails, and the caller
  // can still restore from the carried prior snapshot.
  const fxB = await detachFixture();
  try {
    const recorder = createLifecycleRecorder({ failAt: "after" });
    let failure = null;
    try {
      await detachClaude({
        plan: fxB.registration,
        installation: fxB.installation,
        exec: fxB.runner,
        cwd: fxB.root,
        env: fxB.env,
        observer: recorder.observer,
      });
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.code, "claude-observer-failed");
    assert.equal(failure.phase, "after-mutation");
    assert.equal(failure.action.type, "plugin-uninstall");
    assert.equal(failure.prior.classification, "healthy", "the prior snapshot travels for recovery");
    assert.deepEqual(
      failure.actions.map((entry) => entry.type),
      ["plugin-uninstall"],
      "the recorded action log travels for recovery",
    );
    assert.deepEqual(failure.outcome, { status: "succeeded" });
    assert.deepEqual(failure.afterObservation.plugins, [], "the landed uninstall is observable");
    assert.deepEqual(
      mutationsOf(fxB.runner),
      [`plugin uninstall ${fxB.reference} --scope ${fxB.scope}`],
      "no marketplace removal and no re-installation: nothing is undone or broadened",
    );
    assert.equal(fxB.runner.state.plugins.length, 0, "the uninstall is not undone");
    assert.equal(fxB.runner.state.marketplaces.length, 1, "the marketplace is not removed");

    // The carried prior restores the exact registration through normal means.
    const restored = await restoreClaudeAfterDetach({
      plan: fxB.registration,
      installation: fxB.installation,
      prior: failure.prior,
      exec: fxB.runner,
      cwd: fxB.root,
      env: fxB.env,
    });
    assert.equal(restored.classification, "healthy");
  } finally {
    await fxB.cleanup();
  }
});

test("observer payloads never carry argv, CLI output, environment, or secrets", async () => {
  const fx = await stagedFixture();
  try {
    const secret = "SENTINEL-ENV-9f3b";
    const payloads = [];
    const observer = {
      async beforeMutation(action, beforeObservation) {
        payloads.push({ action, beforeObservation });
      },
      async afterMutation(action, outcome, afterObservation) {
        payloads.push({ action, outcome, afterObservation });
      },
    };
    fx.runner.failOn(`plugin install ${fx.reference} --scope ${fx.scope}`, `boom\n\u001b[31m${"x".repeat(500)}`);
    await assert.rejects(
      registerClaude({
        plan: fx.registration,
        exec: fx.runner,
        actions: [],
        cwd: fx.root,
        env: { ...fx.env, SKILL_ROUTER_TEST_SECRET: secret },
        observer,
      }),
      /boom/,
    );

    const serialized = JSON.stringify(payloads);
    assert.equal(serialized.includes(secret), false, "environment values never reach the observer");
    assert.equal(serialized.includes("--scope"), false, "raw argv never reaches the observer");
    assert.equal(serialized.includes("stdout"), false, "raw CLI output never reaches the observer");
    assert.equal(serialized.includes("stderr"), false, "raw CLI output never reaches the observer");

    const actionKeys = new Set(["sequence", "id", "type", "scope", "reference", "marketplace", "path", "version", "priorVersion"]);
    for (const payload of payloads) {
      for (const key of Object.keys(payload.action)) {
        assert.ok(actionKeys.has(key), `unexpected action key: ${key}`);
      }
      for (const key of ["stdout", "stderr", "argv", "env"]) {
        assert.equal(Object.hasOwn(payload.action, key), false);
      }
      if (payload.outcome) {
        for (const key of Object.keys(payload.outcome)) {
          assert.ok(["status", "errorCode", "message"].includes(key), `unexpected outcome key: ${key}`);
        }
      }
      for (const observation of [payload.beforeObservation, payload.afterObservation]) {
        if (observation) assert.deepEqual(Object.keys(observation).sort(), captureShapeKeys);
      }
    }

    const failure = payloads.at(-1).outcome;
    assert.equal(failure.status, "failed");
    assert.equal(failure.errorCode, "CLAUDE_FAILED");
    assert.ok(failure.message.length <= 201, "the outcome message is bounded");
    assert.equal(failure.message.includes("\n"), false, "the outcome message is sanitized");
    assert.equal(failure.message.includes("\u001b"), false, "the outcome message is sanitized");
    assert.match(failure.message, /^boom/, "the bounded message still identifies the failure");
  } finally {
    await fx.cleanup();
  }
});

test("drift refusals and an empty observer happen before hooks and mutations", async () => {
  const fx = await detachFixture();
  try {
    // Extra marketplace plugin: the blast-radius refusal precedes every hook.
    fx.runner.state.plugins.push({
      id: `team-tools@${fx.identity.marketplace}`,
      version: "9.9.9",
      scope: "local",
      enabled: true,
    });
    const recorder = createLifecycleRecorder();
    fx.runner.log.length = 0;
    await assert.rejects(
      detachClaude({
        plan: fx.registration,
        installation: fx.installation,
        exec: fx.runner,
        cwd: fx.root,
        env: fx.env,
        observer: recorder.observer,
      }),
      (error) => error.code === "claude-detach-drift" && /team-tools/.test(error.message),
    );
    assert.deepEqual(recorder.events, [], "no lifecycle hook runs for a refused detach");
    assert.deepEqual(mutationsOf(fx.runner), [], "no mutation runs for a refused detach");

    // An observer without hooks behaves exactly like no observer at all.
    fx.runner.state.plugins.pop();
    fx.runner.log.length = 0;
    const detached = await detachClaude({
      plan: fx.registration,
      installation: fx.installation,
      exec: fx.runner,
      cwd: fx.root,
      env: fx.env,
      observer: {},
    });
    assert.equal(detached.classification, "absent");
    assert.deepEqual(mutationsOf(fx.runner), [
      `plugin uninstall ${fx.reference} --scope ${fx.scope}`,
      `plugin marketplace remove ${fx.identity.marketplace} --scope ${fx.scope}`,
    ]);

    // Registration refuses a conflicting declaration before any hook too.
    const conflicting = await stagedFixture();
    try {
      await writeDeclaration(conflicting.root, conflicting.identity.marketplace, path.join(conflicting.directory, "elsewhere"));
      const conflictRecorder = createLifecycleRecorder();
      conflicting.runner.log.length = 0;
      await assert.rejects(
        registerClaude({
          plan: conflicting.registration,
          exec: conflicting.runner,
          actions: [],
          cwd: conflicting.root,
          env: conflicting.env,
          observer: conflictRecorder.observer,
        }),
        /refusing to replace it/,
      );
      assert.deepEqual(conflictRecorder.events, []);
      assert.deepEqual(mutationsOf(conflicting.runner), []);
    } finally {
      await conflicting.cleanup();
    }
  } finally {
    await fx.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * Phase 7 — generated-state privacy: the stable request spool path in
 * Claude instructions, and the private fingerprint-input sidecar that
 * lets strict removal reconstruct a current install from installed
 * bytes alone.
 * ------------------------------------------------------------------ */

/** A staged install whose skill carries support files at the requested modes. */
async function supportFixture({ modes = [0o755, 0o644, 0o600] } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "skill-router-claude-support-"));
  const state = path.join(directory, ".skill-router");
  await mkdir(state, { recursive: true });
  const root = path.join(directory, "router-root");
  await mkdir(root, { recursive: true });
  const skillDirectory = path.join(directory, "tree");
  await mkdir(path.join(skillDirectory, "references"), { recursive: true });
  await writeFile(path.join(skillDirectory, "SKILL.md"), "---\nname: Tree\ndescription: Support tree\n---\n\nBody.\n");
  const support = [];
  for (const [index, mode] of modes.entries()) {
    const file = path.join(skillDirectory, "references", `file-${index}.md`);
    await writeFile(file, `# reference ${index}\n`);
    if (fileModeBitsMeaningful()) await chmod(file, mode);
    support.push({
      file,
      mode: (await stat(file)).mode & 0o777,
      relative: `claude/plugins/${PLUGIN}/skills/tree/references/file-${index}.md`,
    });
  }
  const identity = claudeIdentity({ global: false, stateDirectory: state });
  const registry = { skills: [skillEntry("tree", path.join(skillDirectory, "SKILL.md"), "Support tree")] };
  const plan = await planClaudePlugin({
    requestDirectory: REQUEST_DIRECTORY,
    registry,
    identity,
    stateDirectory: state,
  });
  await stageClaudePlugin(plan, state);
  const installation = buildInstallation({
    global: false,
    stateDirectory: state,
    harnesses: ["claude"],
    claude: { fingerprint: plan.fingerprint, version: plan.version },
  });
  return {
    directory,
    state,
    root,
    identity,
    plan,
    installation,
    skillDirectory,
    support,
    sidecarPath: path.join(state, FINGERPRINT_SIDECAR),
    skillPath: `claude/plugins/${PLUGIN}/skills/tree/SKILL.md`,
    routerPath: `claude/plugins/${PLUGIN}/skills/skill-router/SKILL.md`,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

/** Removal-source inspection with an isolated runner, so drift is observable. */
function inspectWithRunner(fx, overrides = {}) {
  const runner = createFakeClaudeRunner();
  return {
    runner,
    promise: inspectGeneratedClaudeRemovalSource({
      identity: fx.identity,
      stateDirectory: fx.state,
      installation: fx.installation,
      exec: runner,
      cwd: fx.root,
      ...overrides,
    }),
  };
}

test("the router skill points at the stable request spool and never the state directory", async () => {
  const { directory, state } = await fixture();
  try {
    const source = await writeSkill(directory, "release", "name: Release\ndescription: Publish\n");
    const identity = claudeIdentity({ global: false, stateDirectory: state });
    const plan = await planClaudePlugin({
      requestDirectory: REQUEST_DIRECTORY,
      registry: { skills: [skillEntry("release", source, "Publish")] },
      identity,
      stateDirectory: state,
    });
    const router = planEntry(plan, `claude/plugins/${PLUGIN}/skills/skill-router/SKILL.md`);

    // The exact stable spool path is embedded, and the pre-spool location
    // inside router state is gone.
    assert.ok(router.includes(`\`${REQUEST_DIRECTORY}/<token>.txt\``), "the instruction names the stable spool path");
    assert.equal(router.includes(path.join(state, "requests")), false, "the legacy state-internal path is gone");
    assert.equal(router.includes(`${state}/requests`), false, "no state-relative request directory is named");

    // The privacy wording: one filesystem write, never a shell, never the
    // directory itself, and the router owns claim → normalize → read → consume.
    assert.match(router, /In one filesystem write or\npatch \(never a shell command\)/);
    assert.match(router, /create only that file, never create or\nreplace the directory/);
    assert.match(router, /atomically claims\nit, owner-normalizes it, reads it, and consumes it/);
    assert.match(router, /Never put request text in the route command or any shell command/);

    // The path only ever lives in generated content and the fingerprint it
    // produces — never in planning results the caller can observe.
    const observable = JSON.stringify({
      identity: plan.identity,
      version: plan.version,
      skills: plan.skills,
      paths: plan.paths,
      registration: plan.registration,
      removal: plan.removal,
      fingerprintInputs: plan.fingerprintInputs,
      sidecar: { path: plan.sidecar.path, mode: plan.sidecar.mode },
    });
    assert.equal(observable.includes(REQUEST_DIRECTORY), false, "planning never returns the request path");
    assert.equal(Object.hasOwn(plan, "requestDirectory"), false, "the request path is not a plan field");

    // The path is part of the fingerprint: two spools are two installs.
    const other = await planClaudePlugin({
      requestDirectory: path.join(directory, "other-spool"),
      registry: { skills: [skillEntry("release", source, "Publish")] },
      identity,
      stateDirectory: state,
    });
    assert.notEqual(other.fingerprint, plan.fingerprint, "the request path is fingerprinted with its instructions");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/* ================================================================== *
 * Phase 8 - defense-in-depth registry public-ID validation
 * ================================================================== */

/** Exact, bounded planner refusal for an invalid/reserved registry public ID. */
async function assertClaudeIdRejection(run) {
  const error = await captureError(run);
  assert.equal(error.message, MANAGED_REGISTRY_ID_ERROR, "the refusal is fixed and bounded");
  return error;
}

async function captureError(run) {
  let caught = null;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "expected planning to reject");
  return caught;
}

/**
 * Every registry public-ID surface the planner may consume or interpolate is
 * validated before any source read. The sentinel source below does not exist:
 * without planner validation these cases would surface an ENOENT naming the
 * path (or sort/interpolate the hostile bytes) instead of the fixed refusal.
 */
const CLAUDE_ID_FAILURE_CASES = [
  ["uppercase", "Release"],
  ["slash", "release/../etc"],
  ["backslash", "release\\..\\etc"],
  ["colon", "release:stage"],
  ["dot", "release.md"],
  ["traversal", "../../escape"],
  ["unicode", "résumé"],
  ["control", "release\u0001\u001b[31m"],
  ["newline", "release\ninjected"],
  ["over-length", "r".repeat(65)],
];

test("planning rejects every malformed registry public ID before any source read", async () => {
  const { directory, state } = await fixture();
  const sentinel = path.join(directory, "sentinel", "never-read.md");
  const identity = claudeIdentity({ global: false, stateDirectory: state });
  try {
    for (const [label, id] of CLAUDE_ID_FAILURE_CASES) {
      const error = await assertClaudeIdRejection(() =>
        planClaudePlugin({
          requestDirectory: REQUEST_DIRECTORY,
          registry: { skills: [skillEntry(id, sentinel, "Hostile")] },
          identity,
          stateDirectory: state,
        }),
      );
      assert.ok(!error.message.includes(sentinel), `${label}: the sentinel source path is never echoed`);
      assert.ok(!error.message.includes(id), `${label}: the invalid ID is never echoed`);
      assert.ok(error.message.length < 100, `${label}: the message stays bounded`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("planning validates reserved, handoff, workflow, and step IDs before any source read", async () => {
  const { directory, state } = await fixture();
  const sentinel = path.join(directory, "sentinel", "never-read.md");
  const identity = claudeIdentity({ global: false, stateDirectory: state });
  try {
    const planWith = (registry) =>
      planClaudePlugin({ requestDirectory: REQUEST_DIRECTORY, registry, identity, stateDirectory: state });
    const cases = [
      ["reserved skill ID", { skills: [skillEntry("skill-router", sentinel, "Impostor")] }],
      ["invalid handoff target", { skills: [skillEntry("release", sentinel, "Publish", { handoffTo: ["Bad/Target"] })] }],
      [
        "non-array handoff list",
        { skills: [skillEntry("release", sentinel, "Publish", { handoffTo: "release" })] },
      ],
      [
        "invalid workflow ID",
        {
          skills: [skillEntry("release", sentinel, "Publish")],
          workflows: [{ id: "Ship/It", steps: [{ skill: "release" }] }],
        },
      ],
      [
        "invalid workflow step",
        {
          skills: [skillEntry("release", sentinel, "Publish")],
          workflows: [{ id: "ship", steps: [{ skill: "Release It" }] }],
        },
      ],
      ["non-object workflow", { skills: [skillEntry("release", sentinel, "Publish")], workflows: ["ship"] }],
      ["non-array steps", { skills: [skillEntry("release", sentinel, "Publish")], workflows: [{ id: "ship", steps: "release" }] }],
      ["non-object skill entry", { skills: [null] }],
      ["non-array skills", { skills: "release" }],
      ["non-array workflows", { workflows: "ship" }],
    ];
    for (const [label, registry] of cases) {
      const error = await assertClaudeIdRejection(() => planWith(registry));
      assert.ok(!error.message.includes(sentinel), `${label}: the sentinel source path is never echoed`);
    }
    // Valid routing surfaces plan normally — including workflows and handoffs,
    // which the generated router instructions consume. Real sources are needed
    // here: unlike the rejection cases above, planning reads them.
    const release = await writeSkill(directory, "release", "name: Release\ndescription: Publish\n");
    const review = await writeSkill(directory, "review", "name: Review\ndescription: Review\n");
    const valid = await planWith({
      skills: [
        skillEntry("release", release, "Publish", { handoffTo: ["review"] }),
        skillEntry("review", review, "Review"),
      ],
      workflows: [{ id: "ship-it", steps: [{ skill: "release" }, { skill: "review" }] }],
    });
    assert.equal(valid.skills.length, 2, "valid IDs with handoffs and workflows plan successfully");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("huge and control-character IDs never reach the Claude refusal or its stack", async () => {
  const { directory, state } = await fixture();
  const sentinel = path.join(directory, "sentinel", "never-read.md");
  const identity = claudeIdentity({ global: false, stateDirectory: state });
  const huge = "x".repeat(100_000);
  const control = `claude\u0001\u001b[31m${"y".repeat(50)}`;
  try {
    for (const id of [huge, control]) {
      const error = await assertClaudeIdRejection(() =>
        planClaudePlugin({
          requestDirectory: REQUEST_DIRECTORY,
          registry: { skills: [skillEntry(id, sentinel, "Hostile")] },
          identity,
          stateDirectory: state,
        }),
      );
      const surface = `${error.message}\n${error.stack ?? ""}`;
      assert.ok(!surface.includes(huge), "the huge ID never reaches the message or stack");
      assert.ok(!surface.includes("\u001b[31m"), "control sequences never reach the message or stack");
      assert.ok(error.message.length < 100, "the refusal stays bounded");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("valid Claude IDs accept the 1/64 boundaries and permitted router-adjacent names", async () => {
  const { directory, state } = await fixture();
  const identity = claudeIdentity({ global: false, stateDirectory: state });
  try {
    const longestId = "l".repeat(64);
    const ids = ["a", longestId, "synced", "anthropic-skills", "anthropic", "claude", "claude-helper", "verify", "simplify", "doctor"];
    const skills = [];
    for (const id of ids) {
      skills.push(skillEntry(id, await writeSkill(directory, `sources/${id}`, "name: Entry\ndescription: Entry\n"), "Entry"));
    }
    const plan = await planClaudePlugin({
      requestDirectory: REQUEST_DIRECTORY,
      registry: { skills, workflows: [{ id: "ship-it", steps: [{ skill: "a" }, { skill: longestId }] }] },
      identity,
      stateDirectory: state,
    });
    const planned = new Set(plan.skills.map((entry) => entry.id));
    for (const id of ids) {
      assert.ok(planned.has(id), `${id} plans successfully`);
      assert.ok(
        plan.entries.some((entry) => entry.path === `claude/plugins/${PLUGIN}/skills/${id}/SKILL.md`),
        `${id} keeps its canonical plugin path`,
      );
    }
    assert.ok(
      plan.entries.some((entry) => entry.path === `claude/plugins/${PLUGIN}/skills/skill-router/SKILL.md`),
      "the planner still generates its own router skill",
    );

    // One character past the boundary rejects boundedly.
    const overlongSource = await writeSkill(directory, "sources/overlong", "description: Over\n");
    await assertClaudeIdRejection(() =>
      planClaudePlugin({
        requestDirectory: REQUEST_DIRECTORY,
        registry: { skills: [...skills, skillEntry("l".repeat(65), overlongSource, "Over")] },
        identity,
        stateDirectory: state,
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("planning rejects an exact-duplicate destination after validation as defense-in-depth", async () => {
  const { directory, state } = await fixture();
  const identity = claudeIdentity({ global: false, stateDirectory: state });
  try {
    const source = await writeSkill(directory, "release", "name: Release\ndescription: Publish\n");
    // Both IDs are individually valid, so validation passes and the retained
    // case-insensitive destination collision check rejects the duplicate.
    await assert.rejects(
      () =>
        planClaudePlugin({
          requestDirectory: REQUEST_DIRECTORY,
          registry: { skills: [skillEntry("release", source, "Publish"), skillEntry("release", source, "Publish again")] },
          identity,
          stateDirectory: state,
        }),
      /collide/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("planning requires an exact absolute request directory without echoing it", async () => {
  const { directory, state } = await fixture();
  try {
    const source = await writeSkill(directory, "release", "name: Release\ndescription: Publish\n");
    const identity = claudeIdentity({ global: false, stateDirectory: state });
    const base = { registry: { skills: [skillEntry("release", source, "Publish")] }, identity, stateDirectory: state };

    for (const [label, requestDirectory] of [
      ["missing", undefined],
      ["relative", "relative/spool/requests"],
      ["empty", ""],
      ["non-string", 42],
      ["null", null],
      ["home-relative", "~/spool"],
      ["dot-relative", "./spool"],
    ]) {
      await assert.rejects(
        planClaudePlugin({ ...base, requestDirectory }),
        (error) => /absolute request directory/.test(error.message),
        `${label} request directory must be rejected`,
      );
    }
    // The caller's path is never echoed back in the failure text.
    await assert.rejects(
      planClaudePlugin({ ...base, requestDirectory: "relative/private-spool" }),
      (error) =>
        /absolute request directory/.test(error.message) &&
        !error.message.includes("private-spool") &&
        !error.message.includes("relative"),
      "a relative path is never echoed",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("0755, 0644, and 0600 support sources all install at 0600 and fingerprint at their source mode", async () => {
  if (!fileModeBitsMeaningful()) return;
  const fx = await supportFixture({ modes: [0o755, 0o644, 0o600] });
  try {
    for (const entry of fx.support) {
      const planned = fx.plan.entries.find((candidate) => candidate.path === entry.relative);
      assert.ok(planned, `${entry.relative} is planned`);
      assert.equal(planned.installedMode, 0o600, "every support file installs owner-only");
      assert.equal(planned.fingerprintMode, entry.mode, "the fingerprint carries the source mode");
      assert.equal((await stat(path.join(fx.state, entry.relative))).mode & 0o777, 0o600, "staged owner-only");
    }
    const plannedSkill = fx.plan.entries.find((entry) => entry.path === fx.skillPath);
    assert.equal(plannedSkill.installedMode, 0o600);
    assert.equal(plannedSkill.fingerprintMode, 0o600, "generated documents are fingerprinted at 0600");
    assert.deepEqual((await verifyClaudePluginFiles({ plan: fx.plan, stateDirectory: fx.state })).map((d) => d.code), []);

    // A chmod-only source change still moves the fingerprint and the version,
    // while the installed mode stays exactly 0600.
    const target = fx.support[1];
    await chmod(target.file, 0o600);
    const rechmod = await planClaudePlugin({
      requestDirectory: REQUEST_DIRECTORY,
      registry: { skills: [skillEntry("tree", path.join(fx.skillDirectory, "SKILL.md"), "Support tree")] },
      identity: fx.identity,
      stateDirectory: fx.state,
      recorded: { fingerprint: fx.plan.fingerprint, version: fx.plan.version },
    });
    assert.notEqual(rechmod.fingerprint, fx.plan.fingerprint, "a chmod-only source change changes the fingerprint");
    assert.notEqual(rechmod.version, fx.plan.version, "a chmod-only source change advances the patch version");
    await stageClaudePlugin(rechmod, fx.state);
    assert.equal((await stat(path.join(fx.state, target.relative))).mode & 0o777, 0o600, "the installed mode never moves");
    assert.deepEqual(
      (await verifyClaudePluginFiles({ plan: rechmod, stateDirectory: fx.state })).map((d) => d.code),
      [],
    );
  } finally {
    await fx.cleanup();
  }
});

test("the fingerprint sidecar is canonical, private, complete, and outside its own fingerprint", async () => {
  const fx = await supportFixture({ modes: [0o644] });
  try {
    assert.equal(
      fx.plan.entries.some((entry) => entry.path === FINGERPRINT_SIDECAR),
      false,
      "the sidecar is never a plan entry fingerprint input",
    );
    assert.ok(
      fx.plan.entries.every((entry) => entry.path.startsWith("claude/")),
      "every plan entry lives inside the generated tree",
    );

    const sidecarStat = await stat(fx.sidecarPath);
    if (fileModeBitsMeaningful()) {
      assert.equal(sidecarStat.mode & 0o777, FINGERPRINT_SIDECAR_MODE, "the sidecar is exactly 0600");
      assert.equal(sidecarStat.mode & 0o777, 0o600);
    }
    assert.ok(sidecarStat.isFile(), "the sidecar is a regular file");

    // Exact canonical bytes: two-space JSON, path before mode, trailing newline.
    const bytes = await readFile(fx.sidecarPath);
    const document = JSON.parse(bytes.toString("utf8"));
    assert.deepEqual(Object.keys(document), ["schemaVersion", "entries"]);
    assert.equal(document.schemaVersion, 1);
    const expected = `${JSON.stringify(
      {
        schemaVersion: 1,
        entries: fx.plan.fingerprintInputs.map((input) => ({ path: input.path, mode: input.mode })),
      },
      null,
      2,
    )}\n`;
    assert.equal(bytes.toString("utf8"), expected, "the sidecar bytes are exactly canonical");
    assert.equal(
      bytes.toString("utf8"),
      `${JSON.stringify(document, null, 2)}\n`,
      "the on-disk document is the canonical serialization of itself",
    );

    // Sorted, unique, and complete: every non-manifest generated path, and
    // nothing else — never the manifests and never the sidecar itself.
    const paths = document.entries.map((entry) => entry.path);
    assert.deepEqual(paths, [...paths].sort(), "entries are sorted by path");
    assert.equal(new Set(paths).size, paths.length, "entries are unique");
    const nonManifest = fx.plan.entries
      .map((entry) => entry.path)
      .filter((path) => !path.endsWith(".json"))
      .sort();
    assert.deepEqual(paths, nonManifest, "every non-manifest fingerprint-bearing path is recorded exactly once");
    for (const entry of document.entries) {
      assert.deepEqual(Object.keys(entry), ["path", "mode"]);
      assert.equal(Number.isInteger(entry.mode), true);
      assert.ok(entry.mode >= 0 && entry.mode <= 0o777);
      assert.equal(entry.path.startsWith(`claude/plugins/${PLUGIN}/`), true, "only in-plugin paths are recorded");
    }
    const supportEntry = document.entries.find((entry) => entry.path === fx.support[0].relative);
    assert.equal(supportEntry.mode, fx.support[0].mode, "the support fingerprint mode is the source mode");

    // The sidecar is excluded from its own fingerprint: hashing exactly the
    // plan's fingerprint inputs reproduces the recorded fingerprint.
    assert.equal(
      claudeFingerprint(fx.identity, fx.plan.fingerprintInputs.map((input) => ({
        path: input.path,
        sha256: createHash("sha256")
          .update(
            fx.plan.entries.find((entry) => entry.path === input.path).content,
          )
          .digest("hex"),
        mode: input.mode,
      }))),
      fx.plan.fingerprint,
      "the sidecar and the manifests are not inputs of their own fingerprint",
    );

    // The parser and the reader agree with the plan.
    const parsed = parseFingerprintSidecar(bytes, fx.identity.plugin);
    assert.deepEqual([...parsed], document.entries.map((entry) => [entry.path, entry.mode]));
    const read = await readFingerprintSidecar(fx.state, fx.identity.plugin);
    assert.equal(read.status, "present");
    assert.deepEqual([...read.entries], [...parsed]);
  } finally {
    await fx.cleanup();
  }
});

test("verification accepts a valid private state and catches support and sidecar drift", async () => {
  const fx = await supportFixture({ modes: [0o644] });
  const supportPath = path.join(fx.state, fx.support[0].relative);
  const codes = async () => (await verifyClaudePluginFiles({ plan: fx.plan, stateDirectory: fx.state })).map((d) => d.code);
  const messages = async () =>
    (await verifyClaudePluginFiles({ plan: fx.plan, stateDirectory: fx.state })).map((d) => d.message);
  const canonicalBytes = await readFile(fx.sidecarPath);
  try {
    assert.deepEqual(await codes(), [], "a valid private state verifies cleanly");

    // A support file chmod is drift even though its bytes never changed.
    if (fileModeBitsMeaningful()) {
      await chmod(supportPath, 0o755);
      assert.deepEqual(await codes(), ["claude-mode-drift"]);
      await chmod(supportPath, 0o600);
      assert.deepEqual(await codes(), [], "the tree verifies again once the mode is restored");
    }

    // Sidecar byte drift: a canonical document that records the wrong mode.
    const drifted = JSON.parse(canonicalBytes.toString("utf8"));
    drifted.entries[0].mode = (drifted.entries[0].mode + 1) & 0o777;
    await writeFile(fx.sidecarPath, `${JSON.stringify(drifted, null, 2)}\n`, { mode: 0o600 });
    assert.deepEqual(await codes(), ["claude-fingerprint-sidecar"]);

    // Sidecar mode drift: right bytes, wrong permissions.
    await writeFile(fx.sidecarPath, canonicalBytes, { mode: 0o600 });
    if (fileModeBitsMeaningful()) {
      await chmod(fx.sidecarPath, 0o644);
      assert.deepEqual(await codes(), ["claude-fingerprint-sidecar"]);
      await chmod(fx.sidecarPath, 0o600);
    }
    assert.deepEqual(await codes(), [], "the state verifies again with the exact sidecar restored");

    // A missing sidecar is its own diagnostic, never a silent pass.
    await rm(fx.sidecarPath);
    assert.deepEqual(await codes(), ["claude-fingerprint-sidecar-missing"]);

    // A symlinked sidecar is refused, not followed.
    const outside = path.join(fx.directory, "outside-sidecar.json");
    await writeFile(outside, canonicalBytes);
    await symlink(outside, fx.sidecarPath);
    assert.deepEqual(await codes(), ["claude-fingerprint-sidecar"]);

    await rm(fx.sidecarPath, { force: true });
    await writeFile(fx.sidecarPath, canonicalBytes, { mode: 0o600 });
    assert.deepEqual(await codes(), [], "the tree is healthy again");

    // Correspondence: one extra in-plugin path and one missing path both fail.
    const extra = JSON.parse(canonicalBytes.toString("utf8"));
    extra.entries.push({
      path: `claude/plugins/${PLUGIN}/skills/tree/references/file-9.md`,
      mode: 384,
    });
    extra.entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    await writeFile(fx.sidecarPath, `${JSON.stringify(extra, null, 2)}\n`, { mode: 0o600 });
    assert.deepEqual(await codes(), ["claude-fingerprint-sidecar"]);

    const missing = JSON.parse(canonicalBytes.toString("utf8"));
    missing.entries = missing.entries.slice(1);
    await writeFile(fx.sidecarPath, `${JSON.stringify(missing, null, 2)}\n`, { mode: 0o600 });
    assert.deepEqual(await codes(), ["claude-fingerprint-sidecar"]);

    await writeFile(fx.sidecarPath, canonicalBytes, { mode: 0o600 });
    // Diagnostics stay bounded and never echo the absolute state or spool path.
    await rm(fx.sidecarPath);
    for (const message of await messages()) {
      assert.equal(message.length < 300, true, "diagnostics stay bounded");
      assert.equal(message.includes(fx.state), false, "the absolute state path is never echoed");
      assert.equal(message.includes(REQUEST_DIRECTORY), false, "the request path is never echoed");
    }
  } finally {
    await fx.cleanup();
  }
});

test("strict removal reconstructs from installed bytes plus the sidecar, never the sources", async () => {
  const fx = await supportFixture({ modes: [0o644, 0o600] });
  try {
    // The original skill document and its whole support tree disappear, and the
    // surviving source directory is chmod'd: strict removal must not care.
    await rm(fx.skillDirectory, { recursive: true, force: true });
    await mkdir(fx.skillDirectory, { recursive: true });
    if (fileModeBitsMeaningful()) await chmod(fx.skillDirectory, 0o777);

    const { runner, promise } = inspectWithRunner(fx);
    const inspected = await promise;
    assert.equal(inspected.validated, true);
    assert.equal(inspected.fingerprint, fx.installation.claude.fingerprint);
    assert.deepEqual(mutationsOf(runner), [], "inspection itself never mutates");

    // The sidecar branch is strict about installed modes too: every installed
    // generated file must still be exactly 0600, refused before any CLI call.
    if (fileModeBitsMeaningful()) {
      const drifted = path.join(fx.state, fx.support[0].relative);
      await chmod(drifted, 0o644);
      const rejection = inspectWithRunner(fx);
      await assert.rejects(rejection.promise, (error) => error.code === "claude-generated-mode");
      assert.deepEqual(rejection.runner.log, [], "an installed mode drift is refused before any CLI command");
      await chmod(drifted, 0o600);
      const third = inspectWithRunner(fx);
      assert.equal((await third.promise).validated, true, "the tree validates again once the mode is restored");
    }

    // The fingerprint modes come from the sidecar, so editing only the sidecar
    // changes the recomputed fingerprint — again before any CLI command.
    const edited = JSON.parse((await readFile(fx.sidecarPath)).toString("utf8"));
    const supportEntry = edited.entries.find((entry) => entry.path === fx.support[0].relative);
    supportEntry.mode = 0o700;
    await writeFile(fx.sidecarPath, `${JSON.stringify(edited, null, 2)}\n`, { mode: 0o600 });
    const tampered = inspectWithRunner(fx);
    await assert.rejects(tampered.promise, (error) => error.code === "claude-generated-fingerprint");
    assert.deepEqual(tampered.runner.log, [], "a sidecar mode tamper is refused before any CLI command");
  } finally {
    await fx.cleanup();
  }
});

test("the adversarial sidecar matrix is refused before any CLI mutation", async () => {
  const fx = await supportFixture({ modes: [0o644] });
  const canonical = await readFile(fx.sidecarPath);
  const document = JSON.parse(canonical.toString("utf8"));
  const pluginPrefix = `claude/plugins/${PLUGIN}/`;
  const rewrite = async (value) => {
    await rm(fx.sidecarPath, { force: true, recursive: true });
    await writeFile(
      fx.sidecarPath,
      typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
      { mode: 0o600 },
    );
    if (fileModeBitsMeaningful()) await chmod(fx.sidecarPath, 0o600);
  };
  const clone = () => JSON.parse(canonical.toString("utf8"));
  const withEntries = (mutate) => {
    const next = clone();
    mutate(next);
    return next;
  };

  /** Runs one adversarial case: coded refusal, zero CLI calls, no sentinels. */
  const refuse = async (label, build, expectations = {}) => {
    await build();
    const { runner, promise } = inspectWithRunner(fx);
    const sentinel = expectations.sentinel;
    await assert.rejects(
      promise,
      (error) => {
        assert.equal(error.code, "claude-fingerprint-sidecar", `${label} carries the sidecar refusal code`);
        assert.equal(
          /Claude fingerprint inputs sidecar/.test(error.message),
          true,
          `${label} carries the bounded sidecar message`,
        );
        assert.equal(error.message.length < 300, true, `${label} stays bounded`);
        assert.equal(error.message.includes(fx.state), false, `${label} never echoes the state path`);
        if (sentinel) assert.equal(error.message.includes(sentinel), false, `${label} never echoes the sentinel`);
        return true;
      },
      label,
    );
    assert.deepEqual(runner.log, [], `${label} is refused before any CLI command`);
    assert.deepEqual(mutationsOf(runner), [], `${label} never reaches a mutation`);
    await rewrite(canonical.toString("utf8"));
    const healthy = inspectWithRunner(fx);
    assert.equal((await healthy.promise).validated, true, `${label} left a healthy sidecar behind`);
  };

  try {
    // Type: symlink, directory, and special file are never followed or read.
    await refuse(
      "a symlinked sidecar",
      async () => {
        const outside = path.join(fx.directory, "adversarial-sidecar.json");
        await writeFile(outside, canonical);
        await rm(fx.sidecarPath, { force: true });
        await symlink(outside, fx.sidecarPath);
      },
    );
    await refuse("a directory in place of the sidecar", async () => {
      await rm(fx.sidecarPath, { recursive: true, force: true });
      await mkdir(fx.sidecarPath, { recursive: true });
    });
    const fifo = fx.sidecarPath;
    await rm(fifo, { force: true, recursive: true });
    if (spawnSync("mkfifo", [fifo]).status === 0) {
      await refuse("a special file in place of the sidecar", async () => {
        await rm(fifo, { force: true, recursive: true });
        spawnSync("mkfifo", [fifo]);
      });
    }

    // Mode: exactly 0600, never anything else.
    if (fileModeBitsMeaningful()) {
      await refuse("a world-readable sidecar", async () => {
        await rewrite(canonical.toString("utf8"));
        await chmod(fx.sidecarPath, 0o644);
      });
      await refuse("an owner-unwritable sidecar", async () => {
        await rewrite(canonical.toString("utf8"));
        await chmod(fx.sidecarPath, 0o400);
      });
    }

    // Bytes: malformed and non-canonical documents never parse as legacy.
    await refuse("malformed JSON", () => rewrite("{ this is not json"));
    await refuse("a JSON array", () => rewrite("[]\n"));
    await refuse("compact non-canonical bytes", () => rewrite(JSON.stringify(document)));
    await refuse("trailing whitespace", () => rewrite(`${canonical.toString("utf8")} `));
    await refuse("a reordered top-level document", () =>
      rewrite(`${JSON.stringify({ entries: document.entries, schemaVersion: 1 }, null, 2)}\n`),
    );

    // Schema: exact keys, exact version, exact entry shape, in that order.
    await refuse("an unknown top-level key", () =>
      rewrite(withEntries((next) => { next.extra = true; })),
    );
    await refuse("an unsupported schemaVersion", () =>
      rewrite(withEntries((next) => { next.schemaVersion = 2; })),
    );
    await refuse("an entry with an unknown key", () =>
      rewrite(withEntries((next) => { next.entries[0].sha256 = "0".repeat(64); })),
    );
    await refuse("an entry without a mode", () =>
      rewrite(withEntries((next) => { delete next.entries[0].mode; })),
    );
    await refuse("a reordered entry", () =>
      rewrite(withEntries((next) => { next.entries[0] = { mode: next.entries[0].mode, path: next.entries[0].path }; })),
    );

    // Ordering and uniqueness.
    await refuse("unsorted entries", () =>
      rewrite(withEntries((next) => { next.entries = [...next.entries].reverse(); })),
    );
    await refuse("a duplicated path", () =>
      rewrite(withEntries((next) => {
        next.entries = [next.entries[0], { ...next.entries[0] }, ...next.entries.slice(1)].sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        );
      })),
    );

    // Paths: absolute, backslashed, empty, dot, dotdot, and out-of-plugin.
    const sentinelAbsolute = path.join(fx.directory, "spool", `${"a".repeat(32)}.txt`);
    await refuse(
      "an absolute path",
      () =>
        rewrite(withEntries((next) => {
          next.entries = [
            ...next.entries,
            { path: sentinelAbsolute, mode: 384 },
          ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        })),
      { sentinel: sentinelAbsolute },
    );
    await refuse("a backslashed path", () =>
      rewrite(withEntries((next) => {
        next.entries = [
          ...next.entries,
          { path: `${pluginPrefix.replace(/\//g, "\\")}skills\\tree\\file.md`, mode: 384 },
        ];
      })),
    );
    await refuse("an empty path", () =>
      rewrite(withEntries((next) => { next.entries = [...next.entries, { path: "", mode: 384 }]; })),
    );
    await refuse("a dot path", () =>
      rewrite(withEntries((next) => { next.entries = [...next.entries, { path: ".", mode: 384 }]; })),
    );
    await refuse("a dotdot path", () =>
      rewrite(withEntries((next) => {
        next.entries = [...next.entries, { path: `${pluginPrefix}skills/../../secrets.md`, mode: 384 }];
      })),
    );
    await refuse("a dotdot segment", () =>
      rewrite(withEntries((next) => {
        next.entries = [...next.entries, { path: `${pluginPrefix}skills/tree/../../../owned.md`, mode: 384 }];
      })),
    );
    await refuse("a path outside the plugin", () =>
      rewrite(withEntries((next) => {
        next.entries = [...next.entries, { path: `claude/plugins/another-plugin/skills/x/SKILL.md`, mode: 384 }];
      })),
    );
    await refuse("a path outside the plugin tree", () =>
      rewrite(withEntries((next) => {
        next.entries = [...next.entries, { path: "claude/.claude-plugin/marketplace.json", mode: 384 }];
      })),
    );
    await refuse("an over-long path", () =>
      rewrite(withEntries((next) => {
        next.entries = [
          ...next.entries,
          { path: `${pluginPrefix}skills/${"x".repeat(FINGERPRINT_SIDECAR_LIMITS.maxPathLength)}/SKILL.md`, mode: 384 },
        ];
      })),
    );

    // Modes: integers only, inside 0..0777.
    await refuse("a string mode", () =>
      rewrite(withEntries((next) => { next.entries[0].mode = "384"; })),
    );
    await refuse("a fractional mode", () =>
      rewrite(withEntries((next) => { next.entries[0].mode = 384.5; })),
    );
    await refuse("an out-of-range mode", () =>
      rewrite(withEntries((next) => { next.entries[0].mode = 0o1000; })),
    );
    await refuse("a negative mode", () =>
      rewrite(withEntries((next) => { next.entries[0].mode = -1; })),
    );

    // Correspondence: missing, extra, and over-bound entries.
    await refuse("a missing entry", () =>
      rewrite(withEntries((next) => { next.entries = next.entries.slice(1); })),
    );
    await refuse("an extra entry", () =>
      rewrite(withEntries((next) => {
        next.entries = [
          ...next.entries,
          { path: `${pluginPrefix}skills/tree/references/file-9.md`, mode: 384 },
        ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      })),
    );
    await refuse("too many entries", () =>
      rewrite(
        `${JSON.stringify(
          {
            schemaVersion: 1,
            entries: Array.from({ length: FINGERPRINT_SIDECAR_LIMITS.maxEntries + 1 }, (_, index) => ({
              path: `claude/plugins/${PLUGIN}/skills/x${index}/SKILL.md`,
              mode: 384,
            })),
          },
          null,
          2,
        )}\n`,
      ),
    );
    await refuse("an oversize sidecar", () => rewrite(" ".repeat(FINGERPRINT_SIDECAR_LIMITS.maxBytes + 1)));
  } finally {
    await fx.cleanup();
  }
});

test("a legacy install without a sidecar stays removable, and a present invalid sidecar never falls back", async () => {
  if (!fileModeBitsMeaningful()) return;
  const fx = await supportFixture({ modes: [0o644, 0o600] });
  try {
    // A pre-sidecar install: no sidecar, and support files carry the source
    // modes they were generated from. The recorded fingerprint is unchanged
    // because planning has always fingerprinted support files at source mode.
    await rm(fx.sidecarPath);
    for (const entry of fx.support) await chmod(path.join(fx.state, entry.relative), entry.mode);
    const legacy = await inspectWithRunner(fx);
    assert.equal((await legacy.promise).validated, true, "a legacy install is still strictly removable");
    assert.deepEqual(mutationsOf(legacy.runner), [], "the legacy inspection runs no mutation of its own");

    // A present invalid sidecar on that same legacy tree never falls back.
    await writeFile(fx.sidecarPath, "not json\n", { mode: 0o600 });
    const refused = inspectWithRunner(fx);
    await assert.rejects(refused.promise, (error) => error.code === "claude-fingerprint-sidecar");
    assert.deepEqual(refused.runner.log, [], "a present invalid sidecar is refused before any CLI command");

    // Removing the sidecar again restores the legacy algorithm exactly.
    await rm(fx.sidecarPath);
    assert.equal((await inspectWithRunner(fx).promise).validated, true);

    // The deleted-sidecar degenerate case: a current install whose sources were
    // all 0600 is semantically identical under both algorithms, so it passes.
    const degenerate = await supportFixture({ modes: [0o600] });
    try {
      await rm(degenerate.sidecarPath);
      assert.equal(
        (await inspectWithRunner(degenerate).promise).validated,
        true,
        "the all-0600 degenerate case survives a deleted sidecar",
      );
    } finally {
      await degenerate.cleanup();
    }

    // A current install with a non-0600 source mode is *not* degenerate: with
    // its sidecar gone, the legacy algorithm cannot reproduce the fingerprint.
    const nonDegenerate = await supportFixture({ modes: [0o644] });
    try {
      await rm(nonDegenerate.sidecarPath);
      await assert.rejects(
        inspectWithRunner(nonDegenerate).promise,
        (error) => error.code === "claude-generated-fingerprint",
        "a deleted sidecar on a non-degenerate install never silently verifies",
      );
    } finally {
      await nonDegenerate.cleanup();
    }
  } finally {
    await fx.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * Phase 7 — planning enforces the sidecar bounds it serializes
 *
 * The private sidecar is the authority every check and removal reads, so
 * planning validates the exact bytes it is about to return through the
 * production reader's own parser, schema, path-set, and bounds. A caller can
 * never receive a plan whose own verification and removal would refuse its
 * own sidecar, and the refusal is the coded, bounded, non-leaking one.
 * ------------------------------------------------------------------ */

/** The generated-path prefix every recorded fingerprint input starts with. */
const SIDECAR_SKILL_PREFIX = `claude/plugins/${PLUGIN}/skills/`;

/**
 * A nested support-file relative path of exactly `total` characters, built
 * only from legal component lengths (200 / 120 / ≤40), so both fixtures are
 * shapes a real source tree can have — only the composed generated path or
 * the composed sidecar crosses a bound.
 */
function deepSupportRelative({ index, total }) {
  const stem = `file-${String(index).padStart(4, "0")}`;
  const filler = "x".repeat(total - 200 - 1 - 120 - 1 - stem.length - ".md".length);
  return `${"a".repeat(200)}/${"b".repeat(120)}/${stem}${filler}.md`;
}

/** Every path under `root` (relative, sorted) — a side-effect snapshot. */
async function walkTree(root) {
  const found = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      found.push(path.relative(root, absolute));
      if (entry.isDirectory()) await visit(absolute);
    }
  };
  await visit(root);
  return found.sort();
}

/**
 * A support-heavy skill source whose generated support paths have exactly the
 * requested length, plus the exact planning arguments for it. Nothing outside
 * the temp directory is ever touched and no Claude CLI is ever involved.
 */
async function boundFixture({ label, supportCount, supportRelativeLength }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `skill-router-claude-${label}-`));
  const state = path.join(directory, ".skill-router");
  const requestDirectory = path.join(directory, "spool");
  const root = path.join(directory, "router-root");
  const skillDirectory = path.join(directory, "tree");
  await Promise.all([mkdir(state, { recursive: true }), mkdir(root, { recursive: true }), mkdir(skillDirectory, { recursive: true })]);
  await writeFile(path.join(skillDirectory, "SKILL.md"), "---\nname: Tree\ndescription: Bounded sidecar\n---\n\nBody.\n");

  const relatives = Array.from({ length: supportCount }, (_, index) =>
    deepSupportRelative({ index, total: supportRelativeLength }),
  );
  await mkdir(path.join(skillDirectory, "a".repeat(200), "b".repeat(120)), { recursive: true });
  for (let start = 0; start < relatives.length; start += 256) {
    await Promise.all(
      relatives
        .slice(start, start + 256)
        .map((relative, offset) => writeFile(path.join(skillDirectory, relative), `# support ${start + offset}\n`)),
    );
  }

  const identity = claudeIdentity({ global: false, stateDirectory: state });
  return {
    directory,
    state,
    root,
    skillDirectory,
    relatives,
    identity,
    requestDirectory,
    planArgs: {
      requestDirectory,
      registry: { skills: [skillEntry("tree", path.join(skillDirectory, "SKILL.md"), "Bounded sidecar")] },
      identity,
      stateDirectory: state,
    },
    skillPath: `claude/plugins/${PLUGIN}/skills/tree/SKILL.md`,
    routerPath: `claude/plugins/${PLUGIN}/skills/skill-router/SKILL.md`,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

/**
 * The exact fingerprint inputs the plan would serialize if the planning gate
 * were bypassed. Modes are fixed 3-digit values: the source mode only changes
 * the fingerprint these bytes would produce, never whether they are accepted.
 */
function ungatedFingerprintInputs(fx) {
  return [
    { path: fx.skillPath, mode: 0o600 },
    ...fx.relatives.map((relative) => ({ path: `${SIDECAR_SKILL_PREFIX}tree/${relative}`, mode: 0o644 })),
    { path: fx.routerPath, mode: 0o600 },
  ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/** The planning refusal: the production sidecar code, bounded, non-leaking. */
function assertBoundedPlanningRefusal(fx, error, problem) {
  assert.equal(error.code, "claude-fingerprint-sidecar", "planning refuses with the production sidecar code");
  assert.match(error.message, /Claude fingerprint inputs sidecar/, "planning reuses the production refusal text");
  assert.match(error.message, problem, "planning names the bound that was crossed");
  assert.equal(error.message.length < 300, true, "the refusal stays bounded");
  for (const privatePath of [fx.directory, fx.state, fx.requestDirectory, fx.skillDirectory]) {
    assert.equal(error.message.includes(privatePath), false, "the refusal never echoes an absolute path");
  }
  assert.equal(
    error.message.includes("a".repeat(20)),
    false,
    "the refusal never echoes the over-long generated relative path",
  );
}

/** Planning wrote nothing at all: no stage, state, spool, journal, or CLI. */
async function assertPlanningSideEffectFree(fx, snapshot, cliLog) {
  assert.deepEqual(
    await walkTree(fx.directory),
    snapshot,
    "planning leaves the temp tree untouched: no stage, state, spool, or journal artifacts",
  );
  assert.deepEqual(await readdir(fx.state), [], "planning never writes into the router state directory");
  await assert.rejects(readFile(cliLog), { code: "ENOENT" }, "planning never invokes the Claude CLI");
}

/**
 * Points the Claude binary at a sentinel and records every invocation, then
 * restores the environment. A real spawn would fail against the missing
 * sentinel binary; an in-process call would append to the log.
 */
async function withSentinelClaudeCli(directory, run) {
  const log = path.join(directory, "claude-invocations.log");
  const previousBin = process.env.SKILL_ROUTER_CLAUDE_BIN;
  const previousLog = process.env.FAKE_CLAUDE_LOG;
  process.env.SKILL_ROUTER_CLAUDE_BIN = path.join(directory, "claude-was-never-called.mjs");
  process.env.FAKE_CLAUDE_LOG = log;
  try {
    return await run(log);
  } finally {
    if (previousBin === undefined) delete process.env.SKILL_ROUTER_CLAUDE_BIN;
    else process.env.SKILL_ROUTER_CLAUDE_BIN = previousBin;
    if (previousLog === undefined) delete process.env.FAKE_CLAUDE_LOG;
    else process.env.FAKE_CLAUDE_LOG = previousLog;
  }
}

test("planning refuses an over-long generated sidecar path, side-effect free and bounded", async () => {
  const fx = await boundFixture({ label: "overlong", supportCount: 1, supportRelativeLength: 350 });
  try {
    const overlong = `${SIDECAR_SKILL_PREFIX}tree/${fx.relatives[0]}`;
    assert.equal(overlong.length > FINGERPRINT_SIDECAR_LIMITS.maxPathLength, true, "the fixture crosses the path bound");
    assert.equal(
      overlong.split("/").every((segment) => segment.length <= 255),
      true,
      "every component is a legal length: only the composed path is over",
    );

    const snapshot = await walkTree(fx.directory);
    await withSentinelClaudeCli(fx.directory, async (cliLog) => {
      await assert.rejects(
        planClaudePlugin(fx.planArgs),
        (error) => {
          assertBoundedPlanningRefusal(fx, error, /over-long path/);
          return true;
        },
        "an over-long generated path is refused during planning",
      );
      await assertPlanningSideEffectFree(fx, snapshot, cliLog);
    });

    // Discrimination: without the planning gate these are exactly the bytes
    // the plan returns, and the production parser refuses them — the
    // self-invalid install the gate exists to prevent.
    assert.throws(
      () => parseFingerprintSidecar(Buffer.from(fingerprintSidecarText(ungatedFingerprintInputs(fx))), PLUGIN),
      (error) =>
        error.code === "claude-fingerprint-sidecar" &&
        /over-long path/.test(error.message) &&
        error.message.length < 300,
      "the ungated plan's own sidecar is refused by the production parser",
    );
  } finally {
    await fx.cleanup();
  }
});

test("planning refuses an oversize canonical sidecar, side-effect free and bounded", async () => {
  const fx = await boundFixture({ label: "oversize", supportCount: 2500, supportRelativeLength: 349 });
  try {
    const inputs = ungatedFingerprintInputs(fx);
    const wouldBe = fingerprintSidecarText(inputs);
    // Legal shape on every individual dimension — ≤4096 entries, every
    // generated path exactly at the 400-character bound — and still over the
    // canonical byte bound, which is the dimension this fixture targets.
    assert.equal(
      inputs.length <= FINGERPRINT_SIDECAR_LIMITS.maxEntries,
      true,
      "the fixture stays within the entry bound",
    );
    assert.equal(
      `${SIDECAR_SKILL_PREFIX}tree/${fx.relatives[0]}`.length,
      FINGERPRINT_SIDECAR_LIMITS.maxPathLength,
      "every generated support path sits exactly on the path bound",
    );
    assert.equal(
      Buffer.byteLength(wouldBe) > FINGERPRINT_SIDECAR_LIMITS.maxBytes,
      true,
      "the canonical sidecar of this legal-shaped tree exceeds the byte bound",
    );

    const snapshot = await walkTree(fx.directory);
    await withSentinelClaudeCli(fx.directory, async (cliLog) => {
      await assert.rejects(
        planClaudePlugin(fx.planArgs),
        (error) => {
          assertBoundedPlanningRefusal(fx, error, new RegExp(`exceeds ${FINGERPRINT_SIDECAR_LIMITS.maxBytes} bytes`));
          return true;
        },
        "an oversize canonical sidecar is refused during planning",
      );
      await assertPlanningSideEffectFree(fx, snapshot, cliLog);
    });

    // Discrimination: those exact bytes are what an ungated plan hands back,
    // and the production reader refuses them — the self-invalid install.
    await writeFile(path.join(fx.state, FINGERPRINT_SIDECAR), wouldBe, { mode: 0o600 });
    if (fileModeBitsMeaningful()) await chmod(path.join(fx.state, FINGERPRINT_SIDECAR), 0o600);
    await assert.rejects(
      readFingerprintSidecar(fx.state, PLUGIN),
      (error) =>
        error.code === "claude-fingerprint-sidecar" &&
        /exceeds \d+ bytes/.test(error.message) &&
        error.message.length < 300,
      "the ungated plan's own sidecar is refused by the production reader",
    );
  } finally {
    await fx.cleanup();
  }
});

test("a sidecar exactly at the path bound still plans, stages, verifies, and removes", async () => {
  const fx = await boundFixture({ label: "boundary", supportCount: 1, supportRelativeLength: 349 });
  const runner = createFakeClaudeRunner();
  try {
    const plan = await planClaudePlugin(fx.planArgs);
    const boundaryPath = `${SIDECAR_SKILL_PREFIX}tree/${fx.relatives[0]}`;
    assert.equal(
      boundaryPath.length,
      FINGERPRINT_SIDECAR_LIMITS.maxPathLength,
      "the fixture sits exactly on the path bound",
    );

    // The returned sidecar is exactly what every production reader accepts.
    const parsed = parseFingerprintSidecar(Buffer.from(plan.sidecar.content), PLUGIN);
    assert.equal(parsed.has(boundaryPath), true, "the boundary path is recorded");
    assert.equal(parsed.size <= FINGERPRINT_SIDECAR_LIMITS.maxEntries, true, "the entry bound holds");
    assert.equal(
      Buffer.byteLength(plan.sidecar.content) <= FINGERPRINT_SIDECAR_LIMITS.maxBytes,
      true,
      "the byte bound holds",
    );
    assert.deepEqual(
      plan.sidecar,
      {
        path: FINGERPRINT_SIDECAR,
        mode: FINGERPRINT_SIDECAR_MODE,
        content: fingerprintSidecarText(plan.fingerprintInputs),
      },
      "the returned sidecar is the canonical serialization of the plan's own inputs",
    );

    // Stage and verify: the staged bytes are the planned bytes, unchanged.
    await stageClaudePlugin(plan, fx.state);
    assert.deepEqual(
      await readFile(path.join(fx.state, FINGERPRINT_SIDECAR)),
      Buffer.from(plan.sidecar.content),
      "the staged sidecar is exactly the planned sidecar",
    );
    assert.deepEqual(
      (await verifyClaudePluginFiles({ plan, stateDirectory: fx.state })).map((diagnostic) => diagnostic.code),
      [],
      "the boundary install verifies cleanly",
    );

    // Remove: removal-source inspection validates from those bytes alone and
    // exact detach reaches fully absent.
    const installation = buildInstallation({
      global: false,
      stateDirectory: fx.state,
      harnesses: ["claude"],
      claude: { fingerprint: plan.fingerprint, version: plan.version },
    });
    await registerClaude({ plan: plan.registration, exec: runner, actions: [], cwd: fx.root });
    const inspected = await inspectGeneratedClaudeRemovalSource({
      identity: fx.identity,
      stateDirectory: fx.state,
      installation,
      exec: createFakeClaudeRunner(),
      cwd: fx.root,
    });
    assert.equal(inspected.validated, true, "removal-source inspection accepts the boundary sidecar");
    const detached = await detachClaude({ plan: plan.registration, installation, exec: runner, cwd: fx.root });
    assert.equal(detached.classification, "absent", "the boundary install removes cleanly");
  } finally {
    await fx.cleanup();
  }
});

test("planning refuses a source that does not fit the fixed bounds, path-free and side-effect free", async () => {
  const { directory, state } = await fixture();
  try {
    const skillDirectory = path.join(directory, "tree");
    await mkdir(skillDirectory, { recursive: true });
    const skillFile = path.join(skillDirectory, "SKILL.md");
    const document = "---\nname: Tree\ndescription: Support tree\n---\n\nBody.\n";
    await writeFile(skillFile, document);
    await writeFile(path.join(skillDirectory, "reference.md"), "keep\n");
    const identity = claudeIdentity({ global: false, stateDirectory: state });
    const registry = { skills: [skillEntry("tree", skillFile, "Support tree")] };
    const plan = (limits) =>
      planClaudePlugin({
        requestDirectory: REQUEST_DIRECTORY,
        registry,
        identity,
        stateDirectory: state,
        limits,
      });

    // Exactly at the aggregate bound the plan is returned with every planned
    // file; one byte short, it is refused outright.
    const total = Buffer.byteLength(document) + Buffer.byteLength("keep\n");
    const staged = await plan({ maxTotalBytes: total });
    assert.ok(staged.entries.some((entry) => entry.path.endsWith("skills/tree/reference.md")));
    await assert.rejects(plan({ maxTotalBytes: total - 1 }), /exceeded the supported source size limits/);
    // Per-file, entry, and depth bounds all refuse the same way.
    await assert.rejects(plan({ maxFileBytes: 4 }), /exceeded the supported source size limits/);
    await assert.rejects(plan({ maxEntries: 1 }), /exceeded the supported source size limits/);
    await assert.rejects(plan({ maxDepth: 0 }), /exceeded the supported source size limits/);

    // The refusal never echoes the source path or document, and planning
    // staged nothing.
    const error = await plan({ maxEntries: 1 }).then(() => null, (thrown) => thrown);
    assert.equal(error.message.includes(directory), false);
    assert.equal(error.message.includes(skillFile), false);
    assert.equal(error.message.includes("Body."), false);
    assert.deepEqual(await readdir(state), [], "a refused plan creates no state");

    // The bounded plan still stages and verifies cleanly on the fixed defaults.
    await stageClaudePlugin(staged, state);
    assert.deepEqual((await verifyClaudePluginFiles({ plan: staged, stateDirectory: state })).map((d) => d.code), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verification maps a bound failure onto the invalid status and still verifies the sidecar", async () => {
  const { directory, state } = await fixture();
  try {
    const source = await writeSkill(directory, "release", "name: Release\ndescription: Publish\n");
    const plan = await planClaudePlugin({
      requestDirectory: REQUEST_DIRECTORY,
      registry: { skills: [skillEntry("release", source, "Publish")] },
      identity: claudeIdentity({ global: false, stateDirectory: state }),
      stateDirectory: state,
    });
    await stageClaudePlugin(plan, state);

    const overEntries = await verifyClaudePluginFiles({ plan, stateDirectory: state, limits: { maxEntries: 2 } });
    assert.deepEqual(overEntries.map((d) => d.code), ["claude-layout-invalid"]);
    assert.match(overEntries[0].message, /exceeds the supported size limits/);
    assert.equal(overEntries[0].message.includes(state), false, "the refusal never echoes the state path");

    const overFileBytes = await verifyClaudePluginFiles({ plan, stateDirectory: state, limits: { maxFileBytes: 4 } });
    assert.deepEqual(overFileBytes.map((d) => d.code), ["claude-layout-invalid"]);
    const overTotalBytes = await verifyClaudePluginFiles({ plan, stateDirectory: state, limits: { maxTotalBytes: 4 } });
    assert.deepEqual(overTotalBytes.map((d) => d.code), ["claude-layout-invalid"]);

    // The private sidecar is still verified on the bound-failure path.
    await rm(path.join(state, FINGERPRINT_SIDECAR));
    const withMissingSidecar = await verifyClaudePluginFiles({
      plan,
      stateDirectory: state,
      limits: { maxEntries: 2 },
    });
    assert.deepEqual(
      withMissingSidecar.map((d) => d.code),
      ["claude-layout-invalid", "claude-fingerprint-sidecar-missing"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verification caps unexpected and missing layout diagnostics at 20 samples plus one summary", async () => {
  const { directory, state } = await fixture();
  try {
    const skills = [];
    for (let index = 0; index < 25; index += 1) {
      const id = `skill-${String(index).padStart(2, "0")}`;
      skills.push(skillEntry(id, await writeSkill(directory, id, `name: ${id}\ndescription: Skill ${index}\n`), `Skill ${index}`));
    }
    const plan = await planClaudePlugin({
      requestDirectory: REQUEST_DIRECTORY,
      registry: { skills },
      identity: claudeIdentity({ global: false, stateDirectory: state }),
      stateDirectory: state,
    });
    await stageClaudePlugin(plan, state);
    const claudeRoot = path.join(state, "claude");

    // 25 unexpected files: 20 detailed diagnostics plus one summary.
    for (let index = 0; index < 25; index += 1) {
      await writeFile(path.join(claudeRoot, `loose-${String(index).padStart(2, "0")}.md`), "unexpected\n");
    }
    const unexpected = await verifyClaudePluginFiles({ plan, stateDirectory: state });
    const detailed = unexpected.filter((item) => /an unexpected file/.test(item.message));
    const summaries = unexpected.filter((item) => item.suppressed !== undefined);
    assert.equal(detailed.length, 20, "exactly 20 detailed unexpected-file diagnostics");
    assert.equal(summaries.length, 1, "exactly one summary for the suppressed remainder");
    assert.equal(summaries[0].code, "claude-layout-invalid");
    assert.equal(summaries[0].suppressed, 5);
    assert.match(summaries[0].message, /only the first 20 are reported in detail/);
    assert.equal(unexpected.length, 21, "20 detailed problems plus one summary");
    for (const item of unexpected) {
      assert.equal(item.message.length < 300, true, "diagnostics stay bounded");
      assert.equal(item.message.includes(state), false, "the absolute state path is never echoed");
    }
    for (const loose of await readdir(claudeRoot)) {
      if (loose.startsWith("loose-")) await rm(path.join(claudeRoot, loose));
    }
    assert.deepEqual((await verifyClaudePluginFiles({ plan, stateDirectory: state })).map((d) => d.code), []);

    // 26 missing files: 20 detailed diagnostics plus one summary.
    await rm(path.join(claudeRoot, "plugins", PLUGIN, "skills"), { recursive: true, force: true });
    const missing = await verifyClaudePluginFiles({ plan, stateDirectory: state });
    const missingDetailed = missing.filter((item) => item.code === "claude-skill-missing" || item.code === "claude-router-skill-missing");
    const missingSummaries = missing.filter((item) => item.suppressed !== undefined);
    assert.equal(missingDetailed.length, 20, "exactly 20 detailed missing-skill diagnostics");
    assert.equal(missingSummaries.length, 1);
    assert.equal(missingSummaries[0].suppressed, 6);
    assert.equal(missing.length, 21, "20 detailed problems plus one summary");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generated removal source inspection is bounded and maps onto the layout status", async () => {
  const fx = await detachFixture();
  try {
    const error = await inspectGeneratedClaudeRemovalSource({
      identity: fx.identity,
      stateDirectory: fx.state,
      installation: fx.installation,
      exec: createFakeClaudeRunner(),
      cwd: fx.root,
      limits: { maxEntries: 2 },
    }).then(() => null, (thrown) => thrown);
    assert.equal(error.code, "claude-generated-layout");
    assert.match(error.message, /exceeds the supported size limits/);
    assert.equal(error.message.includes(fx.state), false, "the refusal never echoes the state path");

    // The same inspection on the fixed defaults stays strict and complete.
    const inspected = await inspectGeneratedClaudeRemovalSource({
      identity: fx.identity,
      stateDirectory: fx.state,
      installation: fx.installation,
      exec: createFakeClaudeRunner(),
      cwd: fx.root,
    });
    assert.equal(inspected.validated, true);
  } finally {
    await fx.cleanup();
  }
});
