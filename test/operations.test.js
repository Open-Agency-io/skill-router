import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import {
  addOperation,
  assertFreshEnablement,
  assertFreshPolicy,
  checkOperation,
  initOperation,
  operationInternals,
  recoverOperation,
  routeFileOperation,
  routeOperation,
  scanOperation,
  staleEnablementIds,
  uninstallOperation,
} from "../src/operations.js";
import { configuredSkillSources } from "../src/opencode.js";
import { readJournal } from "../src/journal.js";
import {
  journaledTransactionInternals,
  UninstallCommittedCleanupError,
} from "../src/transaction.js";
import { FINGERPRINT_SIDECAR, fileModeBitsMeaningful, planClaudePlugin } from "../src/claude.js";
import {
  inspectStateConfidentiality,
  planManagedState,
  stateConfidentialityInternals,
  stateTreeInternals,
} from "../src/managed-state.js";
import { splitSkillDocument } from "../src/skill-document.js";
import { normalizeConfig } from "../src/config.js";
import { discoverSources } from "../src/discovery.js";
import { configPolicy, policyFingerprint } from "../src/policy.js";
import { claudeIdentity, STATE_MARKER_CONTENT, STATE_MARKER_FILE } from "../src/installation.js";
import { parseFrontmatter } from "../src/frontmatter.js";
import { sourceFingerprint, writeJsonAtomic } from "../src/registry.js";
import { buildWorkspaceRegistry, createContext, sourcePaths } from "../src/workspace.js";
import { REQUEST_MARKER_NAME, REQUEST_SPOOL_MODE, setupRequestSpool } from "../src/requests.js";
import { acquireMutationLock, controlPaths } from "../src/mutation-lock.js";
import { createFakeClaudeRunner, pluginBelongsToMarketplace } from "./fake-claude.js";
import { after } from "node:test";

/**
 * Host-independent OpenCode capability: every operation in this file runs with
 * a fake `opencode` CLI that prints exactly one clean semantic version, so the
 * bounded capability probe resolves the same skills shape on every machine
 * instead of depending on whatever OpenCode happens to be installed.
 */
const openCodeProbeDirectory = await mkdtemp(path.join(os.tmpdir(), "skill-router-opencode-probe-"));
const openCodeProbeBin = path.join(openCodeProbeDirectory, "opencode");
await writeFile(openCodeProbeBin, "#!/bin/sh\nprintf '%s\\n' '2.0.0'\n", { mode: 0o755 });
const previousOpenCodeBin = process.env.SKILL_ROUTER_OPENCODE_BIN;
process.env.SKILL_ROUTER_OPENCODE_BIN = openCodeProbeBin;
after(async () => {
  if (previousOpenCodeBin === undefined) delete process.env.SKILL_ROUTER_OPENCODE_BIN;
  else process.env.SKILL_ROUTER_OPENCODE_BIN = previousOpenCodeBin;
  await rm(openCodeProbeDirectory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "skill-router-operations-"));
  const home = path.join(directory, "home");
  const root = path.join(directory, "project");
  await mkdir(home, { recursive: true });
  await mkdir(root, { recursive: true });
  return { directory, home, root };
}

async function writeSkill(file, name, description) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `---\nname: ${name}\ndescription: ${description}\n---\n\n${name} instructions.\n`);
}

test("initializes idempotently, hides routed skills, routes, scans, and checks", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    const sourceSkill = path.join(environment.root, ".agents", "skills", "release", "SKILL.md");
    await writeSkill(sourceSkill, "Release", "Prepare notes and publish a release");

    const first = await initOperation({ root: environment.root });
    const second = await initOperation({ root: environment.root });
    assert.equal(first.fingerprint, second.fingerprint);
    assert.equal(first.skillCount, 1);

    const managed = path.join(first.skillsDirectory, "release", "SKILL.md");
    const managedMetadata = parseFrontmatter(await readFile(managed, "utf8")).attributes;
    assert.equal(managedMetadata.metadata["opencode/autoinvoke"], false);
    const routerMetadata = parseFrontmatter(
      await readFile(path.join(first.skillsDirectory, "skill-router", "SKILL.md"), "utf8"),
    ).attributes;
    assert.notEqual(routerMetadata.metadata?.["opencode/autoinvoke"], false);
    const routerText = await readFile(path.join(first.skillsDirectory, "skill-router", "SKILL.md"), "utf8");
    assert.ok(routerText.length / 4 < 300, "router skill should remain below the 300-token estimate");

    assert.equal((await routeOperation("release", { root: environment.root })).skillId, "release");
    const sentinel = path.join(environment.directory, "must-not-exist");
    const requestToken = "0123456789abcdef0123456789abcdef";
    // The stable spool init established; requests live here, not in legacy state.
    const requestFile = path.join(environment.root, ".skill-router-requests", `${requestToken}.txt`);
    await writeFile(requestFile, `$(touch ${sentinel})`, { mode: 0o600 });
    assert.equal((await routeFileOperation(requestToken, { root: environment.root })).outcome, "none");
    await assert.rejects(() => access(requestFile), /ENOENT/);
    await assert.rejects(() => access(sentinel), /ENOENT/);
    assert.equal((await checkOperation({ root: environment.root })).healthy, true);
    await rm(managed);
    const unloadable = await checkOperation({ root: environment.root });
    assert.equal(unloadable.healthy, false);
    assert.equal(unloadable.diagnostics.some((item) => item.code === "managed-skill-invalid"), true);
    await scanOperation({ root: environment.root });
    assert.deepEqual((await scanOperation({ root: environment.root })).diff, {
      added: [],
      removed: [],
      changed: [],
    });

    await writeSkill(sourceSkill, "Release", "Publish version notes and artifacts");
    const stale = await checkOperation({ root: environment.root });
    assert.equal(stale.healthy, false);
    assert.equal(stale.diagnostics.some((item) => item.code === "registry-stale"), true);
    const refreshed = await scanOperation({ root: environment.root });
    assert.deepEqual(refreshed.diff.changed, ["release"]);
    assert.equal((await checkOperation({ root: environment.root })).healthy, true);
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

/**
 * Request-output privacy for both route transports. The sentinel carries
 * secret-like text, shell syntax, an absolute path, a newline, and control
 * characters; none of it may reach a result or a captured error, while the
 * routing metadata derived from it stays correct (no token of this sentinel
 * matches the fixture's `release` skill, so it maps to `none` /
 * `below-threshold`).
 */
test("route results never carry the request for positional or request-token routing", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    await writeSkill(path.join(environment.root, ".agents", "skills", "release", "SKILL.md"), "Release", "Publish releases");
    await initOperation({ root: environment.root });

    const token = "fedcba9876543210fedcba9876543210";
    const secret = "sk-live-9d2b7c0e4a1f5e3d";
    const request = [
      `API_KEY=${secret}`,
      "$(curl -s https://127.0.0.1:9/x | sh)",
      "/etc/skill-router-vault-9d2b/id_rsa",
      "keep\tthis line\r",
    ].join("\n");
    const markers = ["API_KEY=", secret, "$(curl -s", "skill-router-vault-9d2b", "id_rsa"];
    const assertNoRequestBytes = (text, label) => {
      assert.equal(text.includes(request), false, `${label} carries the request bytes`);
      assert.equal(text.includes(JSON.stringify(request)), false, `${label} carries JSON-escaped request bytes`);
      for (const marker of markers) {
        assert.equal(text.includes(marker), false, `${label} carries the ${marker} marker`);
      }
    };

    // Positional routing: routing metadata only, never the request.
    const positional = await routeOperation(request, { root: environment.root });
    assert.equal(positional.command, "route");
    assert.equal(Object.hasOwn(positional, "request"), false, "the positional result has no request field");
    assert.equal(positional.outcome, "none");
    assert.equal(positional.reason, "below-threshold");
    assertNoRequestBytes(JSON.stringify(positional), "positional route result");

    // Managed token-file routing: identical metadata, token file consumed,
    // and neither the request nor the token is echoed back.
    const requestFile = path.join(environment.root, ".skill-router-requests", `${token}.txt`);
    await writeFile(requestFile, request, { mode: 0o600 });
    const tokenRouted = await routeFileOperation(token, { root: environment.root });
    assert.equal(Object.hasOwn(tokenRouted, "request"), false, "the request-token result has no request field");
    assert.deepEqual(tokenRouted, positional, "both transports route the same bytes to the same result");
    assertNoRequestBytes(JSON.stringify(tokenRouted), "request-token route result");
    assert.equal(JSON.stringify(tokenRouted).includes(token), false, "the token is never returned");
    await assert.rejects(() => access(requestFile), /ENOENT/, "the token file is consumed");

    // A routing failure raised after the request was read stays generic: the
    // captured error carries neither the request bytes nor the token.
    const cold = path.join(environment.directory, "uninitialized");
    const coldFile = path.join(cold, ".skill-router-requests", `${token}.txt`);
    await mkdir(path.dirname(coldFile), { recursive: true });
    await writeFile(coldFile, request, { mode: 0o600 });
    const failure = await routeFileOperation(token, { root: cold }).then(() => null, (error) => error);
    assert.ok(failure instanceof Error, "an uninitialized root refuses the route");
    assert.match(failure.message, /Skill Router is not initialized/);
    assertNoRequestBytes(`${failure.name}: ${failure.message}\n${failure.stack ?? ""}`, "captured routing error");
    assert.equal(`${failure.message}`.includes(token), false, "the captured error does not echo the token");
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("refuses to replace an unowned state directory", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    const state = path.join(environment.root, ".skill-router");
    await mkdir(state);
    await writeFile(path.join(state, "keep.txt"), "keep\n");
    await assert.rejects(() => initOperation({ root: environment.root }), /unowned directory/);
    assert.equal(await readFile(path.join(state, "keep.txt"), "utf8"), "keep\n");
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("rejects skill sources that overlap router-owned state", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    const state = path.join(environment.root, ".skill-router");
    await mkdir(state);
    await writeFile(path.join(state, ".skill-router-owned"), "skill-router-state-v1\n");
    await writeFile(
      path.join(environment.root, ".skill-router.json"),
      JSON.stringify({ schemaVersion: 1, sources: [state] }),
    );
    await assert.rejects(() => initOperation({ root: environment.root }), /overlaps router-owned state/);
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("discovers JSONC-configured sources and completes with a manual OpenCode action", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    const source = path.join(environment.directory, "configured-skills");
    await writeSkill(path.join(source, "configured", "SKILL.md"), "Configured", "Handle configured work");
    const configFile = path.join(environment.root, ".opencode", "opencode.jsonc");
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(configFile, `{\n  // retained\n  "skills": [${JSON.stringify(source)}],\n}\n`);
    const result = await initOperation({ root: environment.root });
    assert.equal(result.skillCount, 1);
    assert.match(result.manualAction, /skills array/);
    assert.match(await readFile(configFile, "utf8"), /retained/);
    assert.equal((await checkOperation({ root: environment.root })).healthy, false);

    await writeFile(
      configFile,
      `{\n  // retained\n  "skills": [${JSON.stringify(source)}, ${JSON.stringify(result.skillsDirectory)}],\n}\n`,
    );
    assert.equal((await checkOperation({ root: environment.root })).healthy, true);
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("adds direct paths with overrides and supports dry-run without writes", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    await initOperation({ root: environment.root });
    const external = path.join(environment.directory, "external", "review", "SKILL.md");
    await writeSkill(external, "Review", "Review code for correctness");
    const original = await readFile(external, "utf8");
    await mkdir(path.join(path.dirname(external), "references"), { recursive: true });
    await writeFile(path.join(path.dirname(external), "references", "guide.md"), "Review guide\n");

    const dry = await addOperation(path.dirname(external), { root: environment.root, dryRun: true });
    assert.equal(dry.dryRun, true);
    const before = JSON.parse(await readFile(path.join(environment.root, ".skill-router.json"), "utf8"));
    assert.deepEqual(before.sources, []);

    const added = await addOperation(path.dirname(external), {
      root: environment.root,
      aliases: ["inspect this"],
      description: "Inspect a change carefully",
    });
    assert.deepEqual(added.added, ["review"]);
    assert.equal(await readFile(external, "utf8"), original);
    assert.equal(
      await readFile(path.join(added.skillsDirectory, "review", "references", "guide.md"), "utf8"),
      "Review guide\n",
    );
    assert.equal((await routeOperation("inspect this", { root: environment.root })).skillId, "review");

    const disabledSkill = path.join(environment.directory, "external", "format", "SKILL.md");
    await writeSkill(disabledSkill, "Format", "Format source files");
    await addOperation(path.dirname(disabledSkill), { root: environment.root, noEnable: true });
    assert.equal((await routeOperation("format", { root: environment.root })).outcome, "none");
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("replace accepts an exact skill file without selecting a duplicate arbitrarily", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    await initOperation({ root: environment.root });
    const source = path.join(environment.directory, "duplicates");
    const flat = path.join(source, "duplicate.md");
    await writeSkill(flat, "Chosen Duplicate", "Use the chosen duplicate skill");
    await writeSkill(path.join(source, "duplicate", "SKILL.md"), "Other Duplicate", "Other definition");
    await assert.rejects(
      () => addOperation("duplicate", { root: environment.root, source, replace: true }),
      /exact skill file or directory/,
    );
    const result = await addOperation(flat, { root: environment.root, replace: true });
    assert.deepEqual(result.added, ["duplicate"]);
    const config = JSON.parse(await readFile(path.join(environment.root, ".skill-router.json"), "utf8"));
    assert.equal(config.skills.duplicate.source, flat);
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("directory add requires confirmation when multiple skills are found", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    await initOperation({ root: environment.root });
    const source = path.join(environment.directory, "collection");
    await writeSkill(path.join(source, "one", "SKILL.md"), "One", "Handle first tasks");
    await writeSkill(path.join(source, "two", "SKILL.md"), "Two", "Handle second tasks");
    const dryRun = await addOperation(source, { root: environment.root, dryRun: true });
    assert.deepEqual(dryRun.added, ["one", "two"]);
    await assert.rejects(() => addOperation(source, { root: environment.root }), /--yes/);
    const result = await addOperation(source, { root: environment.root, yes: true });
    assert.deepEqual(result.added, ["one", "two"]);
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("add resolves an installed exact ID before a same-named local path", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    await writeSkill(
      path.join(environment.root, ".agents", "skills", "review", "SKILL.md"),
      "Installed Review",
      "Review installed code",
    );
    await mkdir(path.join(environment.root, "review"));
    await writeSkill(path.join(environment.root, "review", "SKILL.md"), "Path Review", "Review path code");
    await initOperation({ root: environment.root });
    const result = await addOperation("review", { root: environment.root });
    assert.deepEqual(result.added, ["review"]);
    const config = JSON.parse(await readFile(path.join(environment.root, ".skill-router.json"), "utf8"));
    assert.deepEqual(config.sources, []);
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("global init remains isolated from project configuration", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    await writeSkill(
      path.join(environment.home, ".agents", "skills", "global-review", "SKILL.md"),
      "Global Review",
      "Review changes globally",
    );
    const result = await initOperation({ root: environment.root, global: true });
    assert.equal(result.scope, "global");
    assert.equal(result.skillCount, 1);
    await access(path.join(environment.home, ".config", "skill-router", "config.json"));
    await assert.rejects(() => access(path.join(environment.root, ".skill-router.json")), /ENOENT/);
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

function writeSchemaV2Config(file, value) {
  return writeFile(file, `${JSON.stringify({ schemaVersion: 2, ...value }, null, 2)}\n`);
}

test("registers schema v2 skill sources and workflows through init, route, scan, and check", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    const external = path.join(environment.directory, "external");
    const reviewFile = path.join(external, "review", "SKILL.md");
    await writeSkill(reviewFile, "Review", "Review code for correctness");
    const packDirectory = path.join(external, "pack");
    await writeSkill(path.join(packDirectory, "SKILL.md"), "Pack", "Package a release bundle");
    await writeSkill(path.join(environment.home, "skills", "external", "SKILL.md"), "External", "Handle external requests");
    await writeSkill(path.join(environment.root, "team-skills", "release", "SKILL.md"), "Release", "Publish a release");

    await writeSchemaV2Config(path.join(environment.root, ".skill-router.json"), {
      aliases: { "inspect change": "review" },
      skills: {
        review: { source: reviewFile },
        pack: { source: packDirectory },
        external: { source: "~/skills/external" },
        release: { source: "./team-skills/release" },
      },
      routing: { allowSequences: true },
      workflows: {
        "change-gate": {
          description: "Review a change and package it",
          invocation: "automatic",
          applicability: { any: ["review the change"] },
          steps: [{ skill: "review" }, { skill: "pack", when: "tests passed" }],
        },
      },
    });

    const initialized = await initOperation({ root: environment.root });
    assert.equal(initialized.skillCount, 4);

    const registryFile = path.join(environment.root, ".skill-router", "registry.json");
    const stored = JSON.parse(await readFile(registryFile, "utf8"));
    assert.match(stored.policyHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(stored.skills.map((skill) => skill.id), ["external", "pack", "release", "review"]);
    assert.deepEqual(stored.workflows.map((workflow) => workflow.id), ["change-gate"]);
    assert.equal((await checkOperation({ root: environment.root })).healthy, true);

    assert.equal((await routeOperation("review", { root: environment.root })).skillId, "review");
    assert.equal((await routeOperation("pack", { root: environment.root })).skillId, "pack");
    assert.equal((await routeOperation("external", { root: environment.root })).skillId, "external");
    assert.equal((await routeOperation("release", { root: environment.root })).skillId, "release");
    assert.equal((await routeOperation("inspect change", { root: environment.root })).reason, "alias");
    assert.equal(
      (await routeOperation("review code for correctness", { root: environment.root })).skillId,
      "review",
    );

    const inferred = await routeOperation("please review the change", { root: environment.root });
    assert.equal(inferred.outcome, "sequence");
    assert.equal(inferred.workflowId, "change-gate");
    assert.deepEqual(inferred.steps, [{ skillId: "review" }]);

    const explicit = await routeOperation("change-gate", { root: environment.root });
    assert.equal(explicit.outcome, "sequence");
    assert.deepEqual(explicit.steps, [{ skillId: "review" }]);

    const rescanned = await scanOperation({ root: environment.root });
    assert.equal(rescanned.policyChanged, false);
    assert.deepEqual(rescanned.diff, { added: [], removed: [], changed: [] });
    assert.equal((await checkOperation({ root: environment.root })).healthy, true);
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("rejects schema v2 skill sources that are not exactly one matching skill", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    const external = path.join(environment.directory, "external");
    const reviewFile = path.join(external, "review", "SKILL.md");
    await writeSkill(reviewFile, "Review", "Review code for correctness");
    const collection = path.join(external, "collection");
    await writeSkill(path.join(collection, "one", "SKILL.md"), "One", "Handle first tasks");
    await writeSkill(path.join(collection, "two", "SKILL.md"), "Two", "Handle second tasks");

    const configFile = path.join(environment.root, ".skill-router.json");
    await writeSchemaV2Config(configFile, { skills: { mismatched: { source: reviewFile } } });
    await assert.rejects(() => initOperation({ root: environment.root }), /must match the configuration key/);

    await writeSchemaV2Config(configFile, { skills: { one: { source: collection } } });
    await assert.rejects(
      () => initOperation({ root: environment.root }),
      /must resolve to exactly one skill \(2 found\)/,
    );

    await writeSchemaV2Config(configFile, {
      skills: { absent: { source: path.join(external, "absent") } },
    });
    await assert.rejects(
      () => initOperation({ root: environment.root }),
      /must resolve to exactly one skill \(0 found\)/,
    );

    await writeSchemaV2Config(configFile, { skills: { review: { source: reviewFile } } });
    const recovered = await initOperation({ root: environment.root });
    assert.equal(recovered.skillCount, 1);
    assert.equal((await routeOperation("review", { root: environment.root })).skillId, "review");
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("detects a policy-only configuration change in route, check, and scan", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    const sourceSkill = path.join(environment.root, ".agents", "skills", "release", "SKILL.md");
    await writeSkill(sourceSkill, "Release", "Prepare notes and publish releases");
    const sourceText = await readFile(sourceSkill, "utf8");
    const configFile = path.join(environment.root, ".skill-router.json");
    const registryFile = path.join(environment.root, ".skill-router", "registry.json");

    await writeSchemaV2Config(configFile, { skills: {} });
    const initialized = await initOperation({ root: environment.root });
    const firstPolicy = JSON.parse(await readFile(registryFile, "utf8")).policyHash;
    assert.match(firstPolicy, /^[a-f0-9]{64}$/);
    assert.equal((await routeOperation("release", { root: environment.root })).outcome, "select");

    await writeSchemaV2Config(configFile, { skills: { release: { invocation: "advisory" } } });
    assert.equal(await readFile(sourceSkill, "utf8"), sourceText, "policy edits must not touch skill sources");

    await assert.rejects(() => routeOperation("release", { root: environment.root }), /policy is stale/);
    const stale = await checkOperation({ root: environment.root });
    assert.equal(stale.healthy, false);
    assert.equal(stale.diagnostics.some((item) => item.code === "policy-stale"), true);

    const rescanned = await scanOperation({ root: environment.root });
    assert.equal(rescanned.policyChanged, true);
    assert.notEqual(rescanned.fingerprint, initialized.fingerprint);
    assert.deepEqual(rescanned.diff.changed, ["release"]);
    assert.notEqual(JSON.parse(await readFile(registryFile, "utf8")).policyHash, firstPolicy);
    assert.equal((await checkOperation({ root: environment.root })).healthy, true);

    const advised = await routeOperation("release", { root: environment.root });
    assert.equal(advised.outcome, "advise");
    assert.deepEqual(advised.recommendation, { kind: "skill", id: "release" });
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("a declared schema v2 source wins over a bulk source for the same skill ID", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    const declared = path.join(environment.directory, "declared", "release", "SKILL.md");
    await writeSkill(declared, "Release", "Declared release implementation");
    const bulk = path.join(environment.directory, "bulk");
    await writeSkill(path.join(bulk, "release", "SKILL.md"), "Release", "Bulk release implementation");

    const configFile = path.join(environment.root, ".skill-router.json");
    await writeSchemaV2Config(configFile, {
      sources: [declared, bulk],
      skills: { release: { source: declared } },
    });

    const initialized = await initOperation({ root: environment.root });
    assert.equal(initialized.skillCount, 1);
    const stored = JSON.parse(
      await readFile(path.join(environment.root, ".skill-router", "registry.json"), "utf8"),
    );
    const entry = stored.skills.find((skill) => skill.id === "release");
    assert.equal(entry.source, declared);
    const managed = await readFile(path.join(initialized.skillsDirectory, "release", "SKILL.md"), "utf8");
    assert.match(managed, /Declared release implementation/);
    assert.equal((await routeOperation("release", { root: environment.root })).skillId, "release");
    assert.equal((await checkOperation({ root: environment.root })).healthy, true);
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("resolves a declared source nested under a bulk source exactly once", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    const bulk = path.join(environment.directory, "bulk");
    const declared = path.join(bulk, "release", "SKILL.md");
    await writeSkill(declared, "Release", "Declared release implementation");
    const other = path.join(environment.directory, "other");
    await writeSkill(path.join(other, "release", "SKILL.md"), "Release", "Other release implementation");

    // The declared file is discovered twice: once through its parent bulk
    // source and once through the direct registration. Collapsing that
    // duplicate must not cost the declared source its win over the sibling.
    const configFile = path.join(environment.root, ".skill-router.json");
    await writeSchemaV2Config(configFile, {
      sources: [bulk, other],
      skills: { release: { source: declared } },
    });

    const initialized = await initOperation({ root: environment.root });
    assert.equal(initialized.skillCount, 1);
    const stored = JSON.parse(
      await readFile(path.join(environment.root, ".skill-router", "registry.json"), "utf8"),
    );
    assert.equal(stored.skills.find((skill) => skill.id === "release").source, declared);
    const managed = await readFile(path.join(initialized.skillsDirectory, "release", "SKILL.md"), "utf8");
    assert.match(managed, /Declared release implementation/);
    assert.equal((await routeOperation("release", { root: environment.root })).skillId, "release");

    const checked = await checkOperation({ root: environment.root });
    assert.equal(checked.healthy, true);
    assert.equal(checked.diagnostics.some((item) => item.code === "direct-source-unresolved"), false);
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("build and check refuse workflows that contain a disabled step", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    await writeSkill(
      path.join(environment.root, ".agents", "skills", "release", "SKILL.md"),
      "Release",
      "Prepare notes and publish releases",
    );
    await writeSchemaV2Config(path.join(environment.root, ".skill-router.json"), {
      routing: { allowSequences: true },
      skills: { release: { enabled: false } },
      workflows: { "change-gate": { invocation: "automatic", steps: [{ skill: "release" }] } },
    });

    await assert.rejects(() => initOperation({ root: environment.root }), /uses disabled skill "release"/);
    const checked = await checkOperation({ root: environment.root });
    assert.equal(checked.healthy, false);
    assert.equal(
      checked.diagnostics.some((item) => item.code === "workflow-disabled-step" && item.level === "error"),
      true,
    );
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("schema v2 policy freshness covers top-level source edits", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    const sourceA = path.join(environment.directory, "skills-a");
    const sourceB = path.join(environment.directory, "skills-b");
    const sourceC = path.join(environment.directory, "skills-c");
    await writeSkill(path.join(sourceA, "alpha", "SKILL.md"), "Alpha", "Handle alpha requests");
    await writeSkill(path.join(sourceB, "beta", "SKILL.md"), "Beta", "Handle beta requests");
    await writeSkill(path.join(sourceC, "gamma", "SKILL.md"), "Gamma", "Handle gamma requests");

    const configFile = path.join(environment.root, ".skill-router.json");
    const root = environment.root;
    const edit = (sources) => writeSchemaV2Config(configFile, { sources });

    await edit([sourceA, sourceB]);
    await initOperation({ root });
    assert.equal((await routeOperation("alpha", { root })).skillId, "alpha");

    await edit([sourceB, sourceA]);
    await assert.rejects(() => routeOperation("alpha", { root }), /policy is stale/);
    assert.equal(
      (await checkOperation({ root })).diagnostics.some((item) => item.code === "policy-stale"),
      true,
    );
    await scanOperation({ root });
    assert.equal((await routeOperation("alpha", { root })).skillId, "alpha");

    await edit([sourceA]);
    await assert.rejects(() => routeOperation("alpha", { root }), /policy is stale/);
    await scanOperation({ root });
    assert.equal((await routeOperation("beta", { root })).outcome, "none");

    await edit([sourceA, sourceC]);
    await assert.rejects(() => routeOperation("alpha", { root }), /policy is stale/);
    await scanOperation({ root });
    assert.equal((await routeOperation("gamma", { root })).skillId, "gamma");
    assert.equal((await checkOperation({ root })).healthy, true);
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("schema v1 routes from the current configuration without any policy scan", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    await writeSkill(
      path.join(environment.root, ".agents", "skills", "release", "SKILL.md"),
      "Release",
      "Prepare notes and publish releases",
    );
    const configFile = path.join(environment.root, ".skill-router.json");
    const registryFile = path.join(environment.root, ".skill-router", "registry.json");
    const root = environment.root;

    await initOperation({ root });
    const generated = JSON.parse(await readFile(registryFile, "utf8"));
    assert.equal(generated.schemaVersion, 1);
    // Schema v1 does not persist a policy hash...
    assert.equal(generated.policyHash, undefined);
    // ...but a legacy generated v1 registry that carries one must not block.
    generated.policyHash = "0".repeat(64);
    await writeFile(registryFile, `${JSON.stringify(generated, null, 2)}\n`);

    await writeFile(
      configFile,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          aliases: { "ship it": "release" },
          skills: { release: { description: "Calculate orbital velocity" } },
        },
        null,
        2,
      )}\n`,
    );
    assert.equal((await routeOperation("ship it", { root })).skillId, "release");
    assert.equal((await routeOperation("release", { root })).reason, "exact-id");
    assert.equal((await routeOperation("calculate orbital velocity", { root })).skillId, "release");
    const checked = await checkOperation({ root });
    assert.equal(checked.diagnostics.some((item) => item.code === "policy-stale"), false);
    assert.equal(checked.healthy, true);

    // Current thresholds apply immediately as well.
    await writeFile(
      configFile,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          aliases: { "ship it": "release" },
          skills: { release: { description: "Calculate orbital velocity" } },
          routing: { minimumScore: 0.9 },
        },
        null,
        2,
      )}\n`,
    );
    assert.equal((await routeOperation("ship it", { root })).skillId, "release");
    assert.equal((await routeOperation("calculate orbital velocity", { root })).outcome, "none");
    const rescanned = await scanOperation({ root });
    assert.equal(rescanned.policyChanged, false);
    assert.equal(JSON.parse(await readFile(registryFile, "utf8")).policyHash, undefined);
    assert.equal((await checkOperation({ root })).healthy, true);
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("a legacy schema v1 registry fingerprint checks healthy without a rescan", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    await writeSkill(
      path.join(environment.root, ".agents", "skills", "release", "SKILL.md"),
      "Release",
      "Prepare notes and publish releases",
    );
    await initOperation({ root: environment.root });
    const registryFile = path.join(environment.root, ".skill-router", "registry.json");
    const stored = JSON.parse(await readFile(registryFile, "utf8"));
    assert.equal(stored.policyHash, undefined);

    // The registry a pre-policy version wrote carries the source-only
    // fingerprint; upgrading to the policy-aware format must not invalidate it.
    const discovery = await discoverSources(await sourcePaths(await createContext({ root: environment.root })));
    const legacyFingerprint = sourceFingerprint(discovery.fingerprintEntries);
    assert.equal(stored.fingerprint, legacyFingerprint);
    await writeFile(registryFile, `${JSON.stringify({ ...stored, fingerprint: legacyFingerprint }, null, 2)}\n`);

    const checked = await checkOperation({ root: environment.root });
    assert.equal(checked.healthy, true);
    assert.equal(checked.diagnostics.some((item) => item.code === "registry-stale"), false);
    assert.equal((await routeOperation("release", { root: environment.root })).skillId, "release");
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("policy freshness enforcement applies only to schema version 2", () => {
  const legacyHash = "0".repeat(64);
  const v1 = normalizeConfig({ schemaVersion: 1 });
  const v2 = normalizeConfig({ schemaVersion: 2 });
  assert.doesNotThrow(() => assertFreshPolicy({ policyHash: legacyHash }, v1));
  assert.doesNotThrow(() => assertFreshPolicy({}, v1));
  assert.throws(() => assertFreshPolicy({ policyHash: legacyHash }, v2), /policy is stale/);
  assert.throws(() => assertFreshPolicy({}, v2), /predates schemaVersion 2/);
  assert.doesNotThrow(() =>
    assertFreshPolicy({ policyHash: policyFingerprint(configPolicy(v2)) }, v2),
  );
});

async function exists(value) {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}

async function withHarnessEnvironment(run) {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    await run(environment);
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
}

function releaseSource(environment) {
  return path.join(environment.root, ".agents", "skills", "release", "SKILL.md");
}

test("OpenCode-only initialization records OpenCode-only metadata without probing Claude", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const runner = createFakeClaudeRunner();

    const init = await initOperation({ root: environment.root, claudeExec: runner });
    assert.deepEqual(init.harnesses, ["opencode"]);
    assert.equal(init.claude, undefined);
    assert.equal(runner.log.length, 0, "OpenCode-only work must not invoke the Claude CLI");

    const installation = JSON.parse(
      await readFile(path.join(environment.root, ".skill-router", "installation.json"), "utf8"),
    );
    assert.equal(installation.schemaVersion, 1);
    assert.equal(installation.owner, "skill-router");
    assert.equal(installation.scope, "project");
    assert.equal(installation.stateDirectory, path.join(environment.root, ".skill-router"));
    assert.deepEqual(installation.harnesses, ["opencode"]);
    assert.equal(installation.claude, undefined);
    assert.equal(await exists(path.join(environment.root, ".skill-router", "claude")), false);

    const check = await checkOperation({ root: environment.root, claudeExec: runner });
    assert.equal(check.healthy, true);
    assert.deepEqual(check.harnesses, ["opencode"]);
    assert.equal(runner.log.length, 0, "OpenCode-only checks must not invoke the Claude CLI");
  });
});

test("explicit harness selections are additive and Claude-only skips OpenCode wiring", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const runner = createFakeClaudeRunner();
    const root = environment.root;

    const claudeOnly = await initOperation({ root, harness: "claude", claudeExec: runner });
    assert.deepEqual(claudeOnly.harnesses, ["claude"]);
    assert.equal(claudeOnly.claude.scope, "local");
    assert.equal(claudeOnly.claude.plugin, "openagency-skill-router");
    assert.match(claudeOnly.claude.version, /^\d+\.\d+\.\d+$/, "the fresh plugin version is a plain semantic version");
    assert.ok(
      runner.log.some((line) => line.startsWith("plugin install openagency-skill-router@")),
      "Claude registration must install the exact plugin reference",
    );
    assert.equal(await exists(path.join(root, ".skill-router", "opencode-skills")), false);
    assert.equal(await exists(path.join(root, ".opencode", "opencode.json")), false);
    assert.equal((await checkOperation({ root, claudeExec: runner })).healthy, true);

    const retained = await initOperation({ root, claudeExec: runner });
    assert.deepEqual(retained.harnesses, ["claude"], "recorded harnesses are retained without a selection");

    const both = await initOperation({ root, harness: "opencode", claudeExec: runner });
    assert.deepEqual(both.harnesses, ["opencode", "claude"]);
    assert.ok(await exists(path.join(root, ".skill-router", "opencode-skills", "skill-router", "SKILL.md")));
    assert.equal((await checkOperation({ root, claudeExec: runner })).healthy, true);
  });
});

test("legacy state without installation metadata means OpenCode-only", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const runner = createFakeClaudeRunner();
    const root = environment.root;
    await initOperation({ root, claudeExec: runner });
    await rm(path.join(root, ".skill-router", "installation.json"));

    const legacy = await checkOperation({ root, claudeExec: runner });
    assert.equal(legacy.healthy, true);
    const warning = legacy.diagnostics.find((item) => item.code === "installation-legacy");
    assert.equal(warning?.level, "warning");
    assert.equal(runner.log.length, 0);

    const init = await initOperation({ root, harness: "claude", claudeExec: runner });
    assert.deepEqual(init.harnesses, ["opencode", "claude"]);
    assert.equal((await checkOperation({ root, claudeExec: runner })).healthy, true);
  });
});

test("scan and add regenerate every recorded integration", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const runner = createFakeClaudeRunner();
    const root = environment.root;
    const pluginSkills = path.join(
      root,
      ".skill-router",
      "claude",
      "plugins",
      "openagency-skill-router",
      "skills",
    );

    const init = await initOperation({ root, harness: "all", claudeExec: runner });
    assert.deepEqual(init.harnesses, ["opencode", "claude"]);
    assert.ok(await exists(path.join(pluginSkills, "release", "SKILL.md")));
    assert.ok(await exists(path.join(root, ".skill-router", "opencode-skills", "release", "SKILL.md")));

    await writeSkill(releaseSource(environment), "Release", "Publish releases quickly");
    runner.log.length = 0;
    const scan = await scanOperation({ root, claudeExec: runner });
    assert.deepEqual(scan.harnesses, ["opencode", "claude"]);
    assert.equal(scan.claude.version, "0.1.2", "changed plugin content must advance the plugin version (package 0.1.1 -> 0.1.2)");
    assert.ok(
      runner.log.includes(
        `plugin update openagency-skill-router@${scan.claude.marketplace} --scope local`,
      ),
    );
    assert.equal((await checkOperation({ root, claudeExec: runner })).healthy, true);

    const external = path.join(environment.directory, "external", "review", "SKILL.md");
    await writeSkill(external, "Review", "Review code for correctness");
    const added = await addOperation(path.dirname(external), { root, claudeExec: runner });
    assert.deepEqual(added.harnesses, ["opencode", "claude"]);
    assert.ok(await exists(path.join(pluginSkills, "review", "SKILL.md")));
    assert.equal((await checkOperation({ root, claudeExec: runner })).healthy, true);
  });
});

test("check never reports missing or damaged Claude registration as healthy", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const runner = createFakeClaudeRunner();
    const root = environment.root;
    await initOperation({ root, harness: "claude", claudeExec: runner });

    const missing = await checkOperation({ root, claudeExec: createFakeClaudeRunner() });
    assert.equal(missing.healthy, false);
    assert.ok(missing.diagnostics.some((item) => item.code === "claude-registration-missing"));

    const skillFile = path.join(
      root,
      ".skill-router",
      "claude",
      "plugins",
      "openagency-skill-router",
      "skills",
      "release",
      "SKILL.md",
    );
    await writeFile(skillFile, "tampered\n");
    const drifted = await checkOperation({ root, claudeExec: runner });
    assert.equal(drifted.healthy, false);
    assert.ok(drifted.diagnostics.some((item) => item.code === "claude-file-drift"));

    await writeSkill(releaseSource(environment), "Release", "Publish releases somewhere else");
    const stale = await checkOperation({ root, claudeExec: runner });
    assert.equal(stale.healthy, false);
    assert.ok(stale.diagnostics.some((item) => item.code === "registry-stale"));
    assert.equal(
      stale.diagnostics.some((item) => item.code === "claude-fingerprint-mismatch"),
      false,
      "installation metadata stays consistent with the installed registry",
    );

    const installationFile = path.join(root, ".skill-router", "installation.json");
    const installation = JSON.parse(await readFile(installationFile, "utf8"));
    installation.claude.fingerprint = "0".repeat(64);
    await writeFile(installationFile, `${JSON.stringify(installation, null, 2)}\n`);
    const mismatched = await checkOperation({ root, claudeExec: runner });
    assert.equal(mismatched.healthy, false);
    assert.ok(mismatched.diagnostics.some((item) => item.code === "claude-fingerprint-mismatch"));
  });
});

test("failed Claude registration restores router state and compensates exactly", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const runner = createFakeClaudeRunner();
    const root = environment.root;
    const state = path.join(root, ".skill-router");
    const configFile = path.join(root, ".skill-router.json");

    await initOperation({ root, claudeExec: runner });
    const registryBefore = await readFile(path.join(state, "registry.json"), "utf8");
    const managedBefore = await readFile(path.join(state, "opencode-skills", "release", "SKILL.md"), "utf8");
    const configBefore = await readFile(configFile, "utf8");

    const failing = createFakeClaudeRunner();
    const identity = claudeIdentity({ global: false, stateDirectory: state });
    failing.failOn(
      `plugin install ${identity.plugin}@${identity.marketplace} --scope local`,
      "install refused",
    );
    await writeSkill(releaseSource(environment), "Release", "Publish releases now");
    await assert.rejects(
      () => initOperation({ root, harness: "all", claudeExec: failing }),
      /install refused/,
    );

    assert.equal(await readFile(path.join(state, "registry.json"), "utf8"), registryBefore);
    assert.equal(
      await readFile(path.join(state, "opencode-skills", "release", "SKILL.md"), "utf8"),
      managedBefore,
      "the OpenCode managed copy must be restored",
    );
    assert.equal(await readFile(configFile, "utf8"), configBefore);
    assert.equal(await exists(path.join(state, "claude")), false);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(state, "installation.json"), "utf8")).harnesses,
      ["opencode"],
    );
    assert.deepEqual(
      failing.state.marketplaces,
      [],
      "only the marketplace registered by this attempt may be removed",
    );
    assert.ok(
      failing.log.includes(`plugin marketplace remove ${identity.marketplace} --scope local`),
      `expected marketplace compensation, saw: ${failing.log.join(" | ")}`,
    );

    const after = createFakeClaudeRunner();
    const check = await checkOperation({ root, claudeExec: after });
    assert.ok(check.diagnostics.some((item) => item.code === "registry-stale"));
    assert.equal(check.diagnostics.some((item) => item.code.startsWith("claude-")), false);
    await scanOperation({ root, claudeExec: after });
    assert.equal((await checkOperation({ root, claudeExec: after })).healthy, true);
    assert.equal(after.log.length, 0, "recovery must not touch Claude again");
  });
});

test("dry-run planning exposes Claude integration without mutating anything", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const runner = createFakeClaudeRunner();
    const root = environment.root;
    const state = path.join(root, ".skill-router");

    const dry = await initOperation({ root, harness: "all", dryRun: true, claudeExec: runner });
    assert.deepEqual(dry.dryRun, true);
    assert.deepEqual(dry.harnesses, ["opencode", "claude"]);
    assert.equal(dry.claude.scope, "local");
    assert.match(dry.claude.marketplace, /^skill-router-[0-9a-f]{24}$/);
    assert.equal(runner.log.length, 0, "dry-run must not invoke the Claude CLI");
    assert.equal(await exists(state), false);
    assert.equal(await exists(path.join(root, ".opencode", "opencode.json")), false);
  });
});

test("routing stays harness-neutral and returns bare IDs", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const runner = createFakeClaudeRunner();
    const root = environment.root;
    await initOperation({ root, harness: "all", claudeExec: runner });

    const routed = await routeOperation("publish releases", { root });
    assert.equal(routed.outcome, "select");
    assert.equal(routed.skillId, "release");
    const serialized = JSON.stringify(routed);
    assert.equal(serialized.includes("openagency-skill-router"), false);
    assert.equal(serialized.includes("@"), false);
  });
});

test("global Claude registration uses the user scope and the global plugin namespace", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(
      path.join(environment.home, ".agents", "skills", "release", "SKILL.md"),
      "Release",
      "Publish releases",
    );
    const runner = createFakeClaudeRunner();
    const root = environment.root;
    const claudeEnv = {
      HOME: environment.home,
      CLAUDE_CONFIG_DIR: path.join(environment.home, "claude-config"),
    };
    await mkdir(claudeEnv.CLAUDE_CONFIG_DIR, { recursive: true });

    const init = await initOperation({ root, global: true, harness: "all", claudeExec: runner, claudeEnv });
    assert.deepEqual(init.harnesses, ["opencode", "claude"]);
    assert.equal(init.claude.scope, "user");
    assert.equal(init.claude.plugin, "openagency-skill-router-global");
    assert.ok(
      runner.log.includes(
        `plugin marketplace add --scope user ${init.claude.marketplaceDirectory}`,
      ),
      `expected a user-scoped marketplace add, saw: ${runner.log.join(" | ")}`,
    );
    assert.ok(
      runner.log.some(
        (line) =>
          line.startsWith("plugin install openagency-skill-router-global@") && line.endsWith("--scope user"),
      ),
      `expected a user-scoped install, saw: ${runner.log.join(" | ")}`,
    );
    assert.equal(runner.state.plugins[0].scope, "user");
    assert.equal((await checkOperation({ root, global: true, claudeExec: runner, claudeEnv })).healthy, true);
    assert.equal(await exists(path.join(claudeEnv.CLAUDE_CONFIG_DIR, "settings.json")), true);
    assert.equal(await exists(path.join(environment.root, ".skill-router", "claude")), false);
  });
});

test("chmod-only drift on a generated Claude file is unhealthy", async (t) => {
  if (!fileModeBitsMeaningful()) {
    t.skip("POSIX mode bits are not meaningful on this platform");
    return;
  }
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const runner = createFakeClaudeRunner();
    const root = environment.root;
    await initOperation({ root, harness: "claude", claudeExec: runner });
    assert.equal((await checkOperation({ root, claudeExec: runner })).healthy, true);

    const generated = path.join(
      root,
      ".skill-router",
      "claude",
      "plugins",
      "openagency-skill-router",
      "skills",
      "release",
      "SKILL.md",
    );
    await chmod(generated, 0o644);
    const drifted = await checkOperation({ root, claudeExec: runner });
    assert.equal(drifted.healthy, false, "a permission-only change is a drift");
    assert.ok(drifted.diagnostics.some((item) => item.code === "claude-mode-drift"));
    assert.equal(
      drifted.diagnostics.some((item) => item.code === "claude-file-drift"),
      false,
      "the bytes themselves are unchanged",
    );

    await chmod(generated, 0o600);
    assert.equal((await checkOperation({ root, claudeExec: runner })).healthy, true, "restoring the mode restores health");
  });
});

test("a conflicting marketplace declaration fails before any mutation and leaves state unchanged", async () => {
  await withHarnessEnvironment(async (environment) => {
    const root = environment.root;
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const runner = createFakeClaudeRunner();
    const identity = claudeIdentity({ global: false, stateDirectory: path.join(root, ".skill-router") });

    // A prior marketplace already owns this derived name at another path and
    // has an unrelated plugin installed from it. The plugin is disabled, so a
    // remove/re-add of that marketplace would be visible in the enabled flag
    // as well as in version and scope.
    const conflictPath = path.join(environment.directory, "conflicting-marketplace");
    await mkdir(path.join(conflictPath, ".claude-plugin"), { recursive: true });
    await writeFile(
      path.join(conflictPath, ".claude-plugin", "marketplace.json"),
      `${JSON.stringify(
        {
          name: identity.marketplace,
          description: "conflicting prior marketplace",
          owner: { name: "skill-router" },
          plugins: [{ name: "unrelated", source: "./plugins/unrelated", version: "9.9.9", description: "unrelated" }],
        },
        null,
        2,
      )}\n`,
    );
    const declarationFile = path.join(root, ".claude", "settings.local.json");
    await mkdir(path.dirname(declarationFile), { recursive: true });
    await writeFile(
      declarationFile,
      `${JSON.stringify(
        { extraKnownMarketplaces: { [identity.marketplace]: { source: { source: "directory", path: conflictPath } } } },
        null,
        2,
      )}\n`,
    );
    const declarationBefore = await readFile(declarationFile, "utf8");
    const unrelated = { id: `unrelated@${identity.marketplace}`, version: "9.9.9", scope: "local", enabled: false };
    runner.state.marketplaces.push({ name: identity.marketplace, path: conflictPath, scope: "local" });
    runner.state.plugins.push({ ...unrelated });
    const marketplacesBefore = JSON.stringify(runner.state.marketplaces);
    const pluginsBefore = JSON.stringify(runner.state.plugins);

    await assert.rejects(
      () => initOperation({ root, harness: "claude", claudeExec: runner }),
      /already declared at local scope with a different path; refusing to replace it/,
    );

    // Fail closed before any marketplace or plugin mutation: the journal's
    // read-only classification ran, then the refusal stopped everything before
    // any validation or mutation command could be issued.
    assert.deepEqual(
      runner.log,
      ["plugin marketplace list --json", "plugin list --json"],
      "no marketplace or plugin mutation command was issued",
    );
    assert.equal(
      await readFile(declarationFile, "utf8"),
      declarationBefore,
      "the conflicting declaration is unchanged",
    );
    assert.equal(JSON.stringify(runner.state.marketplaces), marketplacesBefore, "marketplace state is unchanged");
    assert.equal(JSON.stringify(runner.state.plugins), pluginsBefore, "plugin state is unchanged");
    assert.deepEqual(
      runner.state.plugins,
      [unrelated],
      "the unrelated plugin keeps its id, version, scope, and enabled state",
    );

    // Router state is rolled back: the conflict is detected after the staged
    // state is installed but before anything external ran.
    assert.equal(await exists(path.join(root, ".skill-router")), false, "router state was rolled back");
    assert.equal(await exists(path.join(root, ".skill-router.json")), false, "the router config was rolled back");
    assert.equal(await exists(path.join(root, ".agents")), true, "skill sources are untouched");
    assert.equal(await exists(declarationFile), true, "the pre-existing registration surface remains");
  });
});

test("restrictive source fields survive staged OpenCode generation and check stays healthy", async () => {
  await withHarnessEnvironment(async (environment) => {
    const source = releaseSource(environment);
    const sourceText = [
      "---",
      "# retained source comment",
      "name: Release Display Name",
      'description: "Original description"',
      "license: MIT",
      "compatibility: claude-code>=1.0",
      "allowed-tools: [Read, Grep]",
      "disallowed-tools: [Write]",
      "invocation: explicit-only",
      "model: claude-sonnet-4",
      "context: fork",
      "hooks:",
      "  preToolUse: echo pre",
      "path: ./skills/release",
      "metadata:",
      "  tier: 2",
      "  opencode/autoinvoke: true",
      "unknown-harness-field: keep-me",
      "---",
      "",
      "# Release body",
      "",
      "Keep this body verbatim.",
      "",
    ].join("\n");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, sourceText);

    const init = await initOperation({ root: environment.root });
    assert.equal(init.skillCount, 1, "the source stays discoverable by the compact parser");

    const generated = await readFile(
      path.join(environment.root, ".skill-router", "opencode-skills", "release", "SKILL.md"),
      "utf8",
    );
    const data = parse(splitSkillDocument(generated).yaml);
    assert.equal(data.name, "release", "canonical name is staged");
    assert.equal(data.description, "Original description", "the effective registry description is staged");
    assert.equal(data.license, "MIT");
    assert.equal(data.compatibility, "claude-code>=1.0");
    assert.deepEqual(data["allowed-tools"], ["Read", "Grep"]);
    assert.deepEqual(data["disallowed-tools"], ["Write"]);
    assert.equal(data.invocation, "explicit-only");
    assert.equal(data.model, "claude-sonnet-4");
    assert.equal(data.context, "fork");
    assert.deepEqual(data.hooks, { preToolUse: "echo pre" });
    assert.equal(data.path, "./skills/release");
    assert.equal(data["unknown-harness-field"], "keep-me");
    assert.deepEqual(
      data.metadata,
      { tier: 2, "opencode/autoinvoke": false },
      "restrictive metadata survives while the generated copy is hidden",
    );
    assert.match(generated, /# retained source comment/);
    assert.equal(splitSkillDocument(generated).body, splitSkillDocument(sourceText).body, "the body stays verbatim");

    // The compact parser that `check` uses must accept the generated copy.
    const compact = parseFrontmatter(generated);
    assert.equal(compact.attributes.metadata["opencode/autoinvoke"], false);
    assert.equal(compact.body, splitSkillDocument(sourceText).body);

    const checked = await checkOperation({ root: environment.root });
    assert.equal(checked.healthy, true, JSON.stringify(checked.diagnostics));
    assert.equal(checked.diagnostics.length, 0);
  });
});

test("commands from a deep descendant use the ancestor and create no nested surfaces", async () => {
  await withHarnessEnvironment(async (environment) => {
    const root = environment.root;
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const initialized = await initOperation({ root });
    assert.equal(initialized.root, root);
    const nested = path.join(root, "a", "b", "c");
    await mkdir(nested, { recursive: true });

    const routed = await routeOperation("publish releases", { root: nested });
    assert.equal(routed.outcome, "select");
    assert.equal(routed.skillId, "release", "routing reads the ancestor registry");

    const checked = await checkOperation({ root: nested });
    assert.equal(checked.healthy, true, "check validates the ancestor installation");
    assert.equal(checked.root, root, "check reports the resolved ancestor root");

    await scanOperation({ root: nested });

    const added = await addOperation("release", { root: nested });
    assert.equal(added.root, root, "add reports the resolved ancestor root");
    assert.deepEqual(added.harnesses, ["opencode"], "the ancestor installation is regenerated, not a new one");

    for (const shadow of [".skill-router", ".skill-router.json", ".opencode"]) {
      assert.equal(await exists(path.join(nested, shadow)), false, `no nested ${shadow} surface is created`);
    }
    assert.equal(await exists(path.join(root, ".skill-router", "registry.json")), true, "ancestor state is intact");
    assert.equal(await exists(path.join(root, ".opencode", "opencode.json")), true, "ancestor OpenCode config is intact");
  });
});

test("a malformed nested config is selected and errors instead of falling through", async () => {
  await withHarnessEnvironment(async (environment) => {
    const root = environment.root;
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    await initOperation({ root });
    const nested = path.join(root, "broken");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, ".skill-router.json"), "{ malformed");

    // The nearest (malformed) config wins: normal loading reports its error
    // rather than silently using the valid ancestor install.
    await assert.rejects(() => checkOperation({ root: nested }), /Invalid JSON/);
    await assert.rejects(() => routeOperation("publish releases", { root: nested }), /Invalid JSON/);
    await assert.rejects(() => initOperation({ root: nested }), /Invalid JSON/);

    assert.equal(await exists(path.join(nested, ".skill-router")), false, "no state was staged for the broken config");
    assert.equal((await checkOperation({ root })).healthy, true, "the ancestor installation is untouched");
  });
});

test("fresh init from a nested directory without an ancestor stays nested", async () => {
  await withHarnessEnvironment(async (environment) => {
    const root = environment.root;
    const nested = path.join(root, "fresh", "deep");
    await mkdir(nested, { recursive: true });
    await writeSkill(
      path.join(nested, ".agents", "skills", "release", "SKILL.md"),
      "Release",
      "Publish releases",
    );

    const init = await initOperation({ root: nested });
    assert.equal(init.root, nested, "no ancestor config means the requested directory is the root");
    assert.equal(init.skillCount, 1);
    assert.equal(await exists(path.join(nested, ".skill-router.json")), true, "the config is created where requested");
    assert.equal(await exists(path.join(nested, ".skill-router", "registry.json")), true);
    assert.equal(await exists(path.join(root, "fresh", ".skill-router.json")), false, "no parent is written");
    assert.equal(await exists(path.join(root, "fresh", ".skill-router")), false);
    assert.equal(await exists(path.join(root, ".skill-router")), false, "the workspace root stays untouched");
    assert.equal((await checkOperation({ root: nested })).healthy, true);
  });
});

test("init --harness claude from a descendant registers at the resolved ancestor root", async () => {
  await withHarnessEnvironment(async (environment) => {
    const root = environment.root;
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    await initOperation({ root });
    const nested = path.join(root, "a", "b");
    await mkdir(nested, { recursive: true });
    const runner = createFakeClaudeRunner();

    const init = await initOperation({ root: nested, harness: "claude", claudeExec: runner });
    assert.equal(init.root, root, "the ancestor root is reported");
    assert.deepEqual(init.harnesses, ["opencode", "claude"], "explicit selections stay additive at the ancestor");

    const checked = await checkOperation({ root: nested, claudeExec: runner });
    assert.equal(checked.healthy, true, "the ancestor installation stays healthy from the descendant");
    assert.equal(checked.root, root);

    // Every Claude command ran with the resolved ancestor root as cwd, and
    // registration/state landed there instead of in the descendant.
    assert.ok(runner.calls.length > 0, "Claude commands ran");
    for (const call of runner.calls) {
      assert.equal(call.cwd, root, `Claude command ran with the wrong cwd: ${call.key}`);
      assert.notEqual(call.cwd, nested, "the descendant is never used as the Claude cwd");
    }
    assert.equal(await exists(path.join(root, ".claude", "settings.local.json")), true, "registration is at the ancestor root");
    assert.equal(await exists(path.join(nested, ".claude")), false, "no nested registration surface");
    assert.equal(await exists(path.join(nested, ".skill-router")), false, "no nested state");
    const installation = JSON.parse(await readFile(path.join(root, ".skill-router", "installation.json"), "utf8"));
    assert.deepEqual(installation.harnesses, ["opencode", "claude"], "the ancestor installation records both harnesses");
    assert.equal(installation.stateDirectory, path.join(root, ".skill-router"));
  });
});

test("a symlinked .git marker between an install and a nested cwd creates no shadow state", async () => {
  await withHarnessEnvironment(async (environment) => {
    const outer = environment.root;
    await mkdir(path.join(outer, ".git"), { recursive: true });
    const repo = path.join(outer, "repo");
    const installRoot = path.join(repo, "inner");
    await mkdir(repo, { recursive: true });
    await mkdir(path.join(outer, "real-git"), { recursive: true });
    await symlink(path.join(outer, "real-git"), path.join(repo, ".git"));
    await writeSkill(
      path.join(installRoot, ".agents", "skills", "release", "SKILL.md"),
      "Release",
      "Publish releases",
    );

    // A fresh init from below the symlinked marker stays at the requested
    // directory: the marker is not a boundary, but no ancestor config exists.
    const fresh = await initOperation({ root: installRoot });
    assert.equal(fresh.root, installRoot, "the resolved root is the requested directory");
    assert.equal(fresh.skillCount, 1);

    const nested = path.join(installRoot, "sub", "deep");
    await mkdir(nested, { recursive: true });

    const routed = await routeOperation("publish releases", { root: nested });
    assert.equal(routed.skillId, "release", "routing reads the ancestor registry");
    const checked = await checkOperation({ root: nested });
    assert.equal(checked.healthy, true, "check validates the ancestor installation");
    assert.equal(checked.root, installRoot, "check reports the resolved root");
    await scanOperation({ root: nested });

    for (const shadowRoot of [path.join(installRoot, "sub"), nested, repo]) {
      for (const shadow of [".skill-router", ".skill-router.json", ".opencode"]) {
        assert.equal(await exists(path.join(shadowRoot, shadow)), false, `no ${shadow} shadow under ${shadowRoot}`);
      }
    }
    assert.equal(await exists(path.join(installRoot, ".skill-router", "registry.json")), true, "state lives at the resolved root");

    // Root resolution and source ancestry agree, and the ancestor walk crosses
    // the symlinked marker to the real .git boundary above it.
    const context = await createContext({ root: nested });
    assert.equal(context.root, installRoot, "root discovery agrees with the operations");
    assert.equal(context.ancestors.at(-1), context.root, "root and ancestors agree");
    assert.deepEqual(
      context.ancestors,
      [outer, repo, installRoot],
      "ancestors cross the symlinked marker and stop at the real .git (outermost first)",
    );
  });
});

test("a symlinked nested config is never used as an ownership signal", async () => {
  await withHarnessEnvironment(async (environment) => {
    const root = environment.root;
    const nested = path.join(root, "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(root, "elsewhere.json"), `${JSON.stringify({ schemaVersion: 1, sources: [] }, null, 2)}\n`);
    await symlink(path.join(root, "elsewhere.json"), path.join(nested, ".skill-router.json"));

    // No valid ancestor exists, so the requested directory is kept and the
    // transaction refuses to replace the non-regular config it finds there.
    await assert.rejects(() => initOperation({ root: nested }), /non-regular file/);
    assert.equal(await exists(path.join(nested, ".skill-router")), false, "no state was staged");
    const candidate = await lstat(path.join(nested, ".skill-router.json"));
    assert.ok(candidate.isSymbolicLink(), "the symlinked candidate is left untouched");
    assert.equal(await exists(path.join(root, ".skill-router")), false, "nothing was written to the workspace root");
  });
});

/* ---------------- Phase 4: fail-closed discovery and regeneration --------------- */

async function digestTree(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const digest = {};
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await digestTree(full);
      for (const [key, value] of Object.entries(nested)) digest[`${entry.name}/${key}`] = value;
    } else if (entry.isFile()) {
      digest[entry.name] = createHash("sha256").update(await readFile(full)).digest("hex");
    } else {
      digest[entry.name] = "special";
    }
  }
  return digest;
}

async function snapshotEnvironment(root) {
  const fileDigest = async (file) => {
    try {
      return createHash("sha256").update(await readFile(file)).digest("hex");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  };
  return {
    config: await fileDigest(path.join(root, ".skill-router.json")),
    state: await digestTree(path.join(root, ".skill-router")),
    openCode: await fileDigest(path.join(root, ".opencode", "opencode.json")),
  };
}

async function writeMalformedSkill(directory, id = "broken") {
  const file = path.join(directory, `${id}.md`);
  await mkdir(directory, { recursive: true });
  // Duplicate frontmatter keys fail the compact parser that discovery uses,
  // so this is a discovery-level malformed candidate.
  await writeFile(file, "---\nname: one\nname: two\n---\nBody\n");
  return file;
}

test("regeneration is gated by severity, not by a code allowlist", () => {
  const { blockingDiagnostics } = operationInternals;
  assert.deepEqual(blockingDiagnostics(undefined), []);
  assert.deepEqual(blockingDiagnostics({ diagnostics: [] }), []);
  assert.deepEqual(
    blockingDiagnostics({ diagnostics: [{ level: "warning", code: "source-not-found", message: "w" }] }),
    [],
    "warnings never block",
  );
  assert.deepEqual(
    blockingDiagnostics({ diagnostics: [{ level: "warning", code: "invented-warning-code" }] }),
    [],
    "an unknown warning code never blocks",
  );
  const unknownError = { level: "error", code: "invented-error-code-42", message: "boom" };
  assert.deepEqual(
    blockingDiagnostics({ diagnostics: [unknownError] }),
    [unknownError],
    "an unknown error code blocks automatically",
  );
  assert.equal(
    blockingDiagnostics({ diagnostics: [{ level: "error", code: "source-not-found", message: "m" }] }).length,
    1,
    "missing sources block without a special case",
  );
  for (const code of [
    "duplicate-id",
    "invalid-replacement",
    "source-not-directory",
    "alias-unknown-target",
    "alias-collision",
    "skill-workflow-collision",
    "workflow-unknown-skill",
    "workflow-disabled-step",
    "handoff-unknown-skill",
    "direct-source-unresolved",
    "direct-source-id-mismatch",
  ]) {
    assert.equal(
      blockingDiagnostics({ diagnostics: [{ level: "error", code, message: "m" }] }).length,
      1,
      `${code} still blocks`,
    );
  }
});

test("fresh init with a mixed valid and malformed source set aborts before any write", async () => {
  await withHarnessEnvironment(async (environment) => {
    const root = environment.root;
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const broken = path.join(environment.directory, "broken");
    await writeMalformedSkill(broken);
    const configFile = path.join(root, ".skill-router.json");
    await writeFile(configFile, `${JSON.stringify({ schemaVersion: 1, sources: [broken] }, null, 2)}\n`);
    const configBefore = await readFile(configFile, "utf8");
    const runner = createFakeClaudeRunner();

    await assert.rejects(
      () => initOperation({ root, harness: "all", claudeExec: runner }),
      /Skill file cannot be loaded \(reason: frontmatter\)/,
      "the malformed candidate blocks init",
    );
    await assert.rejects(
      () => initOperation({ root, harness: "all", dryRun: true, claudeExec: runner }),
      /Skill file cannot be loaded \(reason: frontmatter\)/,
      "dry-run applies the same completeness gate",
    );

    assert.equal(await readFile(configFile, "utf8"), configBefore, "the config is never rewritten");
    assert.equal(await exists(path.join(root, ".skill-router")), false, "no router state");
    assert.equal(await exists(path.join(root, ".opencode")), false, "no OpenCode configuration");
    assert.equal(await exists(path.join(root, ".claude")), false, "no Claude registration surface");
    assert.deepEqual(runner.log, [], "the Claude CLI is never invoked");

    // A candidate the compact parser accepts but YAML rejects still aborts
    // before any write: the OpenCode staging path is guarded as well.
    const yamlBroken = path.join(environment.directory, "yaml-broken");
    await mkdir(yamlBroken, { recursive: true });
    await writeFile(path.join(yamlBroken, "skill.md"), "---\nbroken: [1,\n---\nBody\n");
    const yamlConfig = `${JSON.stringify({ schemaVersion: 1, sources: [yamlBroken] }, null, 2)}\n`;
    await writeFile(configFile, yamlConfig);
    await assert.rejects(() => initOperation({ root }), /Invalid skill frontmatter/);
    assert.equal(await readFile(configFile, "utf8"), yamlConfig, "the second config edit is untouched");
    assert.equal(await exists(path.join(root, ".skill-router")), false, "still no router state");
    assert.equal(await exists(path.join(root, ".claude")), false, "still no Claude surface");
    assert.deepEqual(runner.log, [], "still no Claude CLI call");
  });
});

test("a scan that hits a malformed candidate leaves the healthy installation untouched", async () => {
  await withHarnessEnvironment(async (environment) => {
    const root = environment.root;
    const external = path.join(environment.directory, "external");
    await writeSkill(path.join(external, "review", "SKILL.md"), "Review", "Review code for correctness");
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    await writeFile(
      path.join(root, ".skill-router.json"),
      `${JSON.stringify({ schemaVersion: 1, sources: [external] }, null, 2)}\n`,
    );
    const runner = createFakeClaudeRunner();
    await initOperation({ root, harness: "all", claudeExec: runner });
    assert.equal((await checkOperation({ root, claudeExec: runner })).healthy, true, "the baseline install is healthy");

    const before = await snapshotEnvironment(root);
    const claudeStateBefore = JSON.stringify(runner.state);

    // A malformed candidate appears inside an already configured source.
    await writeMalformedSkill(external, "broken");
    runner.log.length = 0;
    await assert.rejects(() => scanOperation({ root, claudeExec: runner }), /Skill file cannot be loaded \(reason: frontmatter\)/);

    const after = await snapshotEnvironment(root);
    assert.deepEqual(
      after.state,
      before.state,
      "registry, managed trees, installation metadata, and the Claude plugin are byte-identical",
    );
    assert.equal(after.config, before.config, "the config is unchanged");
    assert.equal(after.openCode, before.openCode, "the OpenCode configuration is unchanged");
    assert.equal(JSON.stringify(runner.state), claudeStateBefore, "the fake Claude registration state is unchanged");
    assert.deepEqual(runner.log, [], "no Claude CLI call happens on discovery failure");

    // The last healthy installation is still routable, while `check` reports
    // the discovery error read-only instead of mutating anything.
    assert.equal((await routeOperation("review", { root })).skillId, "review");
    runner.log.length = 0;
    const checked = await checkOperation({ root, claudeExec: runner });
    assert.equal(checked.healthy, false, "check reports the discovery error");
    assert.ok(checked.diagnostics.some((item) => item.code === "invalid-skill"));
    assert.ok(
      runner.log.every((line) => /^(plugin validate --strict|plugin list --json|plugin marketplace list --json)/.test(line)),
      `check only issues read-only calls: ${runner.log.join(" | ")}`,
    );
    assert.deepEqual(await snapshotEnvironment(root), before, "check is read-only");

    // An unreadable candidate blocks the same way (guarded: some platforms
    // and privileged users can still read mode-000 files).
    await rm(path.join(external, "broken.md"));
    const unreadable = path.join(external, "secret.md");
    await writeFile(unreadable, "---\nname: Secret\ndescription: Hidden\n---\nBody\n");
    await chmod(unreadable, 0o000);
    let stillReadable = true;
    try {
      await readFile(unreadable);
    } catch {
      stillReadable = false;
    }
    if (!stillReadable) {
      runner.log.length = 0;
      await assert.rejects(() => scanOperation({ root, claudeExec: runner }), /Skill file cannot be loaded \(reason: read\)/);
      assert.deepEqual(await snapshotEnvironment(root), before, "the unreadable candidate blocks with no writes");
      assert.deepEqual(runner.log, [], "still no Claude CLI call");
    }
    await chmod(unreadable, 0o644);
  });
});

test("missing and wrong-type configured sources block scans and preserve prior state", async () => {
  await withHarnessEnvironment(async (environment) => {
    const root = environment.root;
    const external = path.join(environment.directory, "external");
    await writeSkill(path.join(external, "review", "SKILL.md"), "Review", "Review code for correctness");
    const configFile = path.join(root, ".skill-router.json");
    await writeFile(configFile, `${JSON.stringify({ schemaVersion: 1, sources: [external] }, null, 2)}\n`);
    await initOperation({ root });
    const before = await snapshotEnvironment(root);

    const missing = path.join(environment.directory, "missing");
    const withMissing = `${JSON.stringify({ schemaVersion: 1, sources: [external, missing] }, null, 2)}\n`;
    await writeFile(configFile, withMissing);
    await assert.rejects(() => scanOperation({ root }), /does not exist/, "a missing configured source blocks scan");
    const afterMissing = await snapshotEnvironment(root);
    assert.deepEqual(afterMissing.state, before.state, "state is preserved");
    assert.equal(afterMissing.config, createHash("sha256").update(withMissing).digest("hex"), "only the caller's config edit exists");

    const notADirectory = path.join(environment.directory, "note.txt");
    await writeFile(notADirectory, "just text\n");
    await writeFile(configFile, `${JSON.stringify({ schemaVersion: 1, sources: [external, notADirectory] }, null, 2)}\n`);
    await assert.rejects(() => scanOperation({ root }), /is not a directory/, "a wrong source type blocks scan");
    const afterWrong = await snapshotEnvironment(root);
    assert.deepEqual(afterWrong.state, before.state, "state is preserved for wrong source types too");

    assert.equal((await routeOperation("review", { root })).skillId, "review", "the prior installation still routes");
  });
});

test("a healthy change and a broken source never produce a partial update or removal", async () => {
  await withHarnessEnvironment(async (environment) => {
    const root = environment.root;
    const sourceA = path.join(environment.directory, "source-a");
    const sourceB = path.join(environment.directory, "source-b");
    await writeSkill(path.join(sourceA, "alpha", "SKILL.md"), "Alpha", "Handle alpha");
    await writeSkill(path.join(sourceB, "beta", "SKILL.md"), "Beta", "Handle beta");
    await writeFile(
      path.join(root, ".skill-router.json"),
      `${JSON.stringify({ schemaVersion: 1, sources: [sourceA, sourceB] }, null, 2)}\n`,
    );
    await initOperation({ root });
    const before = await snapshotEnvironment(root);
    assert.equal((await routeOperation("alpha", { root })).skillId, "alpha");
    assert.equal((await routeOperation("beta", { root })).skillId, "beta");

    // One source changes (an update would be committed) while the other
    // disappears (a removal would be committed): the scan must do neither.
    await writeSkill(path.join(sourceA, "alpha", "SKILL.md"), "Alpha A", "Handle alpha differently");
    await rm(sourceB, { recursive: true, force: true });
    await assert.rejects(() => scanOperation({ root }), /does not exist/);

    assert.deepEqual(await snapshotEnvironment(root), before, "no partial update and no partial removal");
    assert.equal((await routeOperation("alpha", { root })).skillId, "alpha", "the installed registry still routes");
    assert.equal((await routeOperation("beta", { root })).skillId, "beta", "no skill was silently removed");
  });
});

test("a vanished participating implicit default blocks instead of deleting its skills", async () => {
  await withHarnessEnvironment(async (environment) => {
    const root = environment.root;
    const defaultRoot = path.join(environment.home, ".claude", "skills");
    await writeSkill(path.join(defaultRoot, "release", "SKILL.md"), "Release", "Publish releases");
    const configFile = path.join(root, ".skill-router.json");
    const registryFile = path.join(root, ".skill-router", "registry.json");
    const readRegistryFile = async () => JSON.parse(await readFile(registryFile, "utf8"));

    await initOperation({ root });
    const installed = await readRegistryFile();
    assert.deepEqual(
      installed.sourceRoots,
      [defaultRoot],
      "the roots submitted to discovery are persisted deterministically",
    );
    assert.equal((await routeOperation("release", { root })).skillId, "release");
    const healthyBefore = await snapshotEnvironment(root);

    // The default root disappears entirely: scan and check must both fail
    // closed rather than silently dropping its skills.
    await rm(defaultRoot, { recursive: true, force: true });
    await assert.rejects(() => scanOperation({ root }), /does not exist/);
    const checked = await checkOperation({ root });
    assert.equal(checked.healthy, false, "check reports the missing source");
    assert.ok(checked.diagnostics.some((item) => item.code === "source-not-found"));
    assert.deepEqual(await snapshotEnvironment(root), healthyBefore, "the failed scan changed nothing");

    // A legacy registry without `sourceRoots` is still inferred conservatively.
    const legacy = await readRegistryFile();
    delete legacy.sourceRoots;
    await writeFile(registryFile, `${JSON.stringify(legacy, null, 2)}\n`);
    const legacyBefore = await snapshotEnvironment(root);
    await assert.rejects(
      () => scanOperation({ root }),
      /does not exist/,
      "legacy registries infer participation from installed skill paths",
    );
    const legacyChecked = await checkOperation({ root });
    assert.equal(legacyChecked.healthy, false, "check reports the missing source for legacy registries too");
    assert.ok(legacyChecked.diagnostics.some((item) => item.code === "source-not-found"));
    assert.deepEqual(await snapshotEnvironment(root), legacyBefore, "legacy check stays read-only");

    // Recreating the directory makes the removal explicit and discoverable.
    await mkdir(defaultRoot, { recursive: true });
    const removal = await scanOperation({ root });
    assert.deepEqual(removal.diff.removed, ["release"], "an empty recreated source removes its skills explicitly");
    assert.equal((await checkOperation({ root })).healthy, true);
    const rebuilt = await readRegistryFile();
    assert.deepEqual(rebuilt.sourceRoots, [defaultRoot], "sourceRoots stays deterministic after regeneration");
    await scanOperation({ root });
    assert.deepEqual((await readRegistryFile()).sourceRoots, rebuilt.sourceRoots, "repeat runs produce the same inventory");
  });
});

test("removing a configured source or a skill file is an intentional change that commits", async () => {
  await withHarnessEnvironment(async (environment) => {
    const root = environment.root;
    const sourceA = path.join(environment.directory, "source-a");
    const sourceB = path.join(environment.directory, "source-b");
    await writeSkill(path.join(sourceA, "alpha", "SKILL.md"), "Alpha", "Handle alpha");
    await writeSkill(path.join(sourceA, "gamma", "SKILL.md"), "Gamma", "Handle gamma");
    await writeSkill(path.join(sourceB, "beta", "SKILL.md"), "Beta", "Handle beta");
    const configFile = path.join(root, ".skill-router.json");
    await writeFile(configFile, `${JSON.stringify({ schemaVersion: 1, sources: [sourceA, sourceB] }, null, 2)}\n`);
    await initOperation({ root });

    // Removing an explicit source from configuration is an intentional change.
    await writeFile(configFile, `${JSON.stringify({ schemaVersion: 1, sources: [sourceA] }, null, 2)}\n`);
    const sourceRemoval = await scanOperation({ root });
    assert.deepEqual(sourceRemoval.diff.removed, ["beta"], "skills from the removed source are gone");
    assert.equal((await checkOperation({ root })).healthy, true);
    assert.equal((await routeOperation("beta", { root })).outcome, "none", "the removed skill no longer routes");

    // Deleting a skill file inside an otherwise healthy source is intentional.
    await rm(path.join(sourceA, "alpha", "SKILL.md"));
    const skillRemoval = await scanOperation({ root });
    assert.deepEqual(skillRemoval.diff.removed, ["alpha"], "the deleted skill is removed");
    assert.equal((await checkOperation({ root })).healthy, true);
    assert.equal((await routeOperation("gamma", { root })).skillId, "gamma", "remaining skills still route");
  });
});

test("warning-only discovery still commits", async () => {
  await withHarnessEnvironment(async (environment) => {
    const root = environment.root;
    const source = path.join(root, ".agents", "skills", "release");
    await mkdir(source, { recursive: true });
    // A skill without a description is a warning, not an error.
    await writeFile(path.join(source, "SKILL.md"), "---\nname: Release\n---\n\nBody.\n");

    const init = await initOperation({ root });
    assert.equal(init.skillCount, 1, "the warning does not block generation");
    assert.ok(
      init.diagnostics.some((item) => item.level === "warning" && item.code === "missing-description"),
      "the warning is still reported",
    );
    assert.equal(await exists(path.join(root, ".skill-router", "registry.json")), true, "state was committed");
    assert.equal(await exists(path.join(root, ".opencode", "opencode.json")), true, "OpenCode config was committed");
    assert.equal((await checkOperation({ root })).healthy, true, "warnings never make a healthy install unhealthy");
    assert.equal((await routeOperation("release", { root })).skillId, "release");
  });
});

test("the Claude CLI sees zero calls when discovery fails", async () => {
  await withHarnessEnvironment(async (environment) => {
    const root = environment.root;
    const external = path.join(environment.directory, "external");
    await writeSkill(path.join(external, "review", "SKILL.md"), "Review", "Review code for correctness");
    const configFile = path.join(root, ".skill-router.json");
    await writeFile(configFile, `${JSON.stringify({ schemaVersion: 1, sources: [external] }, null, 2)}\n`);
    const runner = createFakeClaudeRunner();

    await initOperation({ root, harness: "claude", claudeExec: runner });
    assert.ok(runner.log.length > 0, "a healthy Claude init does invoke the CLI");

    await rm(external, { recursive: true, force: true });
    runner.log.length = 0;
    await assert.rejects(() => scanOperation({ root, claudeExec: runner }), /does not exist/);
    assert.deepEqual(runner.log, [], "no validation, list, install, update, or marketplace call runs");
    assert.equal(runner.state.plugins.length, 1, "the previously installed plugin is untouched");
    assert.equal(runner.state.marketplaces.length, 1, "the previously registered marketplace is untouched");
  });
});

async function captureError(run) {
  let caught = null;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "expected the operation to reject");
  return caught;
}

test("OpenCode-only dry-run and real init reject the same document error", async () => {
  await withHarnessEnvironment(async (environment) => {
    const root = environment.root;
    const configFile = path.join(root, ".skill-router.json");
    const cases = [
      ["malformed yaml", "---\nbroken: [1,\n---\nBody.\n", /Invalid skill frontmatter/],
      ["non-map metadata", "---\nname: Release\ndescription: Publish\nmetadata: legacy\n---\nBody.\n", /frontmatter metadata must be a YAML mapping/],
    ];
    for (const [label, body, pattern] of cases) {
      const source = path.join(environment.directory, `case-${label.replaceAll(" ", "-")}`);
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, "skill.md"), body);
      await writeFile(configFile, `${JSON.stringify({ schemaVersion: 1, sources: [source] }, null, 2)}\n`);
      const before = await digestTree(root);

      const dryError = await captureError(() => initOperation({ root, dryRun: true }));
      assert.match(dryError.message, pattern, `${label}: dry-run rejects it`);
      const realError = await captureError(() => initOperation({ root }));
      assert.match(realError.message, pattern, `${label}: execution rejects it`);
      assert.equal(realError.message, dryError.message, `${label}: identical, meaningful error text`);

      assert.deepEqual(await digestTree(root), before, `${label}: no config/state/OpenCode/Claude artifact`);
      assert.equal(await exists(path.join(root, ".claude")), false, `${label}: no Claude surface`);
      assert.deepEqual(
        (await readdir(root)).filter((entry) => entry.includes(".stage-")),
        [],
        `${label}: no stage directory remains`,
      );
    }
  });
});

test("reserved and case-variant destinations fail dry-run and execution identically", async () => {
  await withHarnessEnvironment(async (environment) => {
    const root = environment.root;
    const configFile = path.join(root, ".skill-router.json");

    // A discovered skill directory named like the reserved router skill.
    const reservedSource = path.join(environment.directory, "reserved");
    const reservedSkill = path.join(reservedSource, "skill-router", "SKILL.md");
    await mkdir(path.dirname(reservedSkill), { recursive: true });
    await writeFile(reservedSkill, "---\nname: Router\ndescription: Impostor\n---\n\nBody.\n");
    await writeFile(configFile, `${JSON.stringify({ schemaVersion: 1, sources: [reservedSource] }, null, 2)}\n`);
    let before = await digestTree(root);
    const reservedDry = await captureError(() => initOperation({ root, dryRun: true }));
    const reservedReal = await captureError(() => initOperation({ root }));
    assert.match(reservedDry.message, /derived skill ID is not a portable public ID \(reason: reserved\)/);
    assert.equal(reservedReal.message, reservedDry.message, "reserved ID: identical error text");
    assert.deepEqual(await digestTree(root), before, "reserved ID failure writes nothing");

    // Case-variant spellings of one destination: the uppercase directory is
    // not a portable public ID, so discovery rejects it before any managed
    // destination is planned — dry-run and execution refuse identically.
    const upperSource = path.join(environment.directory, "upper");
    const lowerSource = path.join(environment.directory, "lower");
    await mkdir(path.join(upperSource, "Release"), { recursive: true });
    await mkdir(path.join(lowerSource, "release"), { recursive: true });
    await writeFile(path.join(upperSource, "Release", "SKILL.md"), "---\nname: Release\ndescription: Upper\n---\n\nBody.\n");
    await writeFile(path.join(lowerSource, "release", "SKILL.md"), "---\nname: release\ndescription: Lower\n---\n\nBody.\n");
    await writeFile(
      configFile,
      `${JSON.stringify({ schemaVersion: 1, sources: [upperSource, lowerSource] }, null, 2)}\n`,
    );
    before = await digestTree(root);
    const collisionDry = await captureError(() => initOperation({ root, dryRun: true }));
    const collisionReal = await captureError(() => initOperation({ root }));
    assert.match(collisionDry.message, /derived skill ID is not a portable public ID \(reason: grammar\)/);
    assert.equal(collisionReal.message, collisionDry.message, "collisions: identical error text");
    assert.deepEqual(await digestTree(root), before, "collision failure writes nothing");
    assert.deepEqual(
      (await readdir(root)).filter((entry) => entry.includes(".stage-")),
      [],
      "no stage directory remains for either failure",
    );
  });
});

/**
 * Phase 8 installed-registry safety: an invalid registry on disk is untrusted
 * material. `check` reports one bounded `registry-invalid-id` and skips every
 * ID-consuming probe; both route transports refuse before scoring, and token
 * routing refuses before the spool or the request is touched. A corrected
 * `scan` then replaces the poisoned registry, with the poisoned IDs treated as
 * inert inventory (never echoed into the diff).
 */
test("check and both route transports refuse a poisoned installed registry without reading or echoing it", async () => {
  await withHarnessEnvironment(async (environment) => {
    const root = environment.root;
    const registryFile = path.join(root, ".skill-router", "registry.json");
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const runner = createFakeClaudeRunner();
    await initOperation({ root, harness: "all", claudeExec: runner });
    const healthy = JSON.parse(await readFile(registryFile, "utf8"));
    runner.log.length = 0;

    // Outside sentinels the poisoned identifiers would resolve to if any
    // consumer joined them to a path.
    const outside = path.join(environment.directory, "outside");
    await mkdir(outside, { recursive: true });
    const sentinel = path.join(outside, "sentinel.txt");
    await writeFile(sentinel, "must not be read\n");

    const controlName = "claude\u0001\u001b[31m";
    const huge = "x".repeat(100_000);
    await writeFile(
      registryFile,
      `${JSON.stringify(
        {
          ...healthy,
          skills: [
            ...healthy.skills,
            { id: "../../outside/sentinel", source: sentinel, enabled: true, handoffTo: ["../../../etc/passwd"] },
            { id: "../".repeat(40) + "sentinel", enabled: true },
            { id: huge, enabled: true },
            { id: controlName, enabled: true },
            { id: "skill-router", enabled: true },
          ],
          workflows: [{ id: "poison-flow", steps: [{ skill: "../../../../sentinel" }] }],
        },
        null,
        2,
      )}\n`,
    );
    const poisoned = await digestTree(root);

    const check = await checkOperation({ root, claudeExec: runner });
    assert.equal(check.healthy, false);
    const reported = check.diagnostics.filter((item) => item.code === "registry-invalid-id");
    assert.equal(reported.length, 1, "exactly one registry-invalid-id diagnostic");
    assert.equal(reported[0].level, "error");
    assert.equal(
      reported[0].message,
      "Registry contains invalid skill or workflow IDs; run skill-router scan to rebuild it",
    );
    assert.equal(check.diagnostics.some((item) => item.code === "managed-skill-invalid"), false, "no per-skill probe");
    assert.equal(check.diagnostics.some((item) => item.code === "claude-generation-failed"), false, "no Claude planning");
    assert.equal(check.diagnostics.some((item) => item.code === "claude-fingerprint-mismatch"), false);
    assert.equal(runner.log.length, 0, "no Claude CLI probe may consume the poisoned registry");
    assert.equal(await readFile(sentinel, "utf8"), "must not be read\n", "no outside read");

    const serialized = JSON.stringify(check);
    for (const marker of ["sentinel", "etc/passwd", huge.slice(0, 80), "\u0001", "[31m", outside]) {
      assert.equal(serialized.includes(marker), false, `check output leaks ${marker}`);
    }
    assert.equal(/[\u0000-\u001f]/.test(serialized), false, "check output is control-free");
    assert.ok(serialized.length < 20_000, "check output stays bounded");

    await assert.rejects(
      () => routeOperation("release", { root }),
      (error) => {
        assert.match(error.message, /invalid skill or workflow IDs/);
        assert.equal(error.message.includes("sentinel"), false);
        assert.ok(error.message.length < 200);
        return true;
      },
    );

    // Token routing refuses before the stable spool is set up and before the
    // request is claimed: the entry is still there afterwards.
    assert.deepEqual(await digestTree(root), poisoned, "check and route refusals write nothing");
    const requestToken = "0123456789abcdef0123456789abcdef";
    const requestFile = path.join(root, ".skill-router-requests", `${requestToken}.txt`);
    await writeFile(requestFile, "please release the thing\n", { mode: 0o600 });
    const withPendingRequest = await digestTree(root);
    const tokenError = await captureError(() => routeFileOperation(requestToken, { root }));
    assert.match(tokenError.message, /invalid skill or workflow IDs/);
    assert.equal(tokenError.message.includes("sentinel"), false);
    await access(requestFile);
    assert.deepEqual(await digestTree(root), withPendingRequest, "the refusal writes nothing and claims nothing");

    // A corrected current config/discovery replaces the poisoned registry: the
    // invalid IDs are inert inventory and never appear in the diff or output.
    const scan = await scanOperation({ root, claudeExec: runner });
    const diffText = JSON.stringify(scan.diff);
    assert.deepEqual(scan.diff, { added: [], removed: [], changed: [] }, "only the poisoned entries disappeared");
    assert.equal(diffText.includes("sentinel"), false, "diff never echoes a poisoned ID");
    assert.equal(diffText.includes(huge.slice(0, 80)), false);
    const rebuilt = JSON.parse(await readFile(registryFile, "utf8"));
    assert.deepEqual(rebuilt.skills.map((skill) => skill.id), ["release"]);
    assert.equal((await checkOperation({ root, claudeExec: runner })).healthy, true);
    assert.equal((await routeOperation("release", { root })).skillId, "release");
  });
});

/**
 * Phase 8 no-mutation ordering: invalid discovery, an invalid schema-v1
 * declaration, and an invalid `add` target all refuse before the stable spool,
 * journal, payload, stage, config, state, OpenCode, or Claude work — for
 * dry-runs and real executions alike — and leave no anchor or control
 * directory behind.
 */
test("init, scan, and add refuse invalid identifiers before any spool, journal, config, or state mutation", async () => {
  await withHarnessEnvironment(async (environment) => {
    const root = environment.root;
    const configFile = path.join(root, ".skill-router.json");

    // 1. Invalid discovery in a default source refuses every build command.
    await writeSkill(path.join(root, ".agents", "skills", "Bad Name", "SKILL.md"), "Bad", "Invalid ID");
    let before = await digestTree(root);
    for (const [label, run] of [
      ["init", () => initOperation({ root })],
      ["init dry-run", () => initOperation({ root, dryRun: true })],
      ["scan", () => scanOperation({ root })],
      ["scan dry-run", () => scanOperation({ root, dryRun: true })],
      ["add", () => addOperation("release", { root })],
    ]) {
      const error = await captureError(run);
      assert.match(error.message, /derived skill ID is not a portable public ID/, label);
      assert.equal(error.message.includes("No skill found"), false, `${label}: discovery failure stays itself`);
    }
    assert.deepEqual(await digestTree(root), before, "invalid discovery writes nothing");
    await assert.rejects(() => access(path.join(root, ".skill-router-requests")), /ENOENT/, "no spool");
    await assert.rejects(() => access(path.join(root, ".skill-router")), /ENOENT/, "no state");
    await assert.rejects(() => access(configFile), /ENOENT/, "no config");
    // R1: the control directory this run created is preserved empty and
    // inert - there is no anchor, lock, journal, or control data in it.
    assert.deepEqual(
      await readdir(path.join(root, ".skill-router-control")).catch(() => []),
      [],
      "no anchor or control data",
    );

    // 2. An invalid schema-v1 declaration refuses identically.
    await rm(path.join(root, ".agents", "skills", "Bad Name"), { recursive: true, force: true });
    await writeFile(configFile, `${JSON.stringify({ schemaVersion: 1, skills: { "Bad ID": {} } }, null, 2)}\n`);
    before = await digestTree(root);
    for (const [label, run] of [
      ["init", () => initOperation({ root })],
      ["init dry-run", () => initOperation({ root, dryRun: true })],
      ["scan", () => scanOperation({ root })],
      ["add", () => addOperation("release", { root })],
    ]) {
      const error = await captureError(run);
      assert.match(error.message, /skills key must be a portable ID/, label);
      assert.equal(error.message.includes("Bad ID"), false, `${label}: the invalid key is never echoed`);
    }
    assert.deepEqual(await digestTree(root), before, "invalid configuration writes nothing");
    await assert.rejects(() => access(path.join(root, ".skill-router-requests")), /ENOENT/);
    await assert.rejects(() => access(path.join(root, ".skill-router")), /ENOENT/);
    assert.deepEqual(
      await readdir(path.join(root, ".skill-router-control")).catch(() => []),
      [],
      "no anchor or control data",
    );

    // 3. A healthy baseline: later refusals must leave it byte-identical.
    await writeFile(configFile, `${JSON.stringify({ schemaVersion: 1 }, null, 2)}\n`);
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const init = await initOperation({ root });
    assert.equal(init.skillCount, 1);
    const healthy = await digestTree(root);

    // Invalid add targets: fixed bounded refusals, no echo, no mutation.
    for (const target of ["../evil", "..\\evil", "Bad ID", "x".repeat(100_000), "a\u0000b", "skill-router"]) {
      const error = await captureError(() => addOperation(target, { root }));
      assert.match(error.message, /Add target is neither an existing local path nor a valid public skill ID/);
      assert.ok(error.message.length < 200, "add refusal stays bounded");
      assert.equal(error.message.includes("xxxx"), false, "the huge target is never echoed");
      assert.equal(/[\u0000-\u001f]/.test(error.message), false, "the refusal is control-free");
    }
    // A valid but missing ID keeps the established, echoable guidance.
    assert.match(
      (await captureError(() => addOperation("ghost-skill", { root }))).message,
      /No skill found for: ghost-skill/,
    );
    // A path whose derived ID is invalid refuses with the discovery error,
    // never collapsing into `No skill found`.
    const badParent = path.join(environment.directory, "Bad Parent");
    await writeSkill(path.join(badParent, "SKILL.md"), "Bad", "Invalid parent");
    const pathError = await captureError(() => addOperation(badParent, { root }));
    assert.match(pathError.message, /derived skill ID is not a portable public ID \(reason: grammar\)/);
    assert.equal(pathError.message.includes("No skill found"), false);
    // --source selectors are validated before anything else, and --yes or
    // --replace never bypass that gate.
    const source = path.join(environment.directory, "source");
    await writeSkill(path.join(source, "one", "SKILL.md"), "One", "First");
    for (const extra of [{}, { yes: true }, { replace: true }, { dryRun: true }]) {
      const selector = await captureError(() => addOperation("Bad ID", { root, source, ...extra }));
      assert.match(selector.message, /add target must be a portable ID/);
      const reserved = await captureError(() => addOperation("skill-router", { root, source, ...extra }));
      assert.match(reserved.message, /add target uses the reserved skill-router ID/);
    }
    assert.deepEqual(await digestTree(root), healthy, "every add refusal leaves the healthy state byte-identical");
    // The successful init legitimately established the control anchor; the
    // refusals added no journal, lock, or extra control artifact beside it.
    assert.deepEqual(await readdir(path.join(root, ".skill-router-control")), ["control.json"]);
    assert.equal((await checkOperation({ root })).healthy, true);
    assert.equal((await routeOperation("release", { root })).skillId, "release");
  });
});

test("add selects a discovered valid ID before a same-named path and a path when no ID matches", async () => {
  await withHarnessEnvironment(async (environment) => {
    const root = environment.root;
    await writeSkill(path.join(root, ".agents", "skills", "review", "SKILL.md"), "Installed", "Installed review");
    await writeSkill(path.join(root, "review", "SKILL.md"), "Local", "Local review");
    await writeSkill(path.join(root, "docs-only", "SKILL.md"), "Docs", "Docs only");
    await initOperation({ root });

    // The exact discovered ID wins even though the relative path exists.
    const byId = await addOperation("review", { root });
    assert.deepEqual(byId.added, ["review"]);
    let config = JSON.parse(await readFile(path.join(root, ".skill-router.json"), "utf8"));
    assert.deepEqual(config.sources, [], "the ID selection added no source");

    // A relative path selects the path, not any ID.
    const byPath = await addOperation("./docs-only", { root });
    assert.deepEqual(byPath.added, ["docs-only"]);
    config = JSON.parse(await readFile(path.join(root, ".skill-router.json"), "utf8"));
    assert.deepEqual(config.sources, [path.join(root, "docs-only", "SKILL.md")]);
    assert.equal((await checkOperation({ root })).healthy, true);
  });
});

test("Claude-family and command-like names are ordinary portable skills end to end", async () => {
  await withHarnessEnvironment(async (environment) => {
    const root = environment.root;
    const names = ["synced", "anthropic-skills", "anthropic", "claude", "claude-helper", "verify", "simplify", "doctor"];
    for (const name of names) {
      const label = `${name[0].toUpperCase()}${name.slice(1)}`;
      await writeSkill(path.join(root, ".agents", "skills", name, "SKILL.md"), label, `Handle ${name} work`);
    }
    const init = await initOperation({ root });
    assert.equal(init.skillCount, names.length, "none of these names is reserved");
    for (const name of names) {
      assert.equal((await routeOperation(name, { root })).skillId, name);
    }
    const added = await addOperation("doctor", { root });
    assert.deepEqual(added.added, ["doctor"]);
    assert.equal((await checkOperation({ root })).healthy, true);
  });
});

/**
 * Blocker 1 end-to-end: a terminal-control filename whose body is also
 * malformed produces exactly one bounded, control-free invalid-ID diagnostic.
 * No surface — discovery result, init/scan/add errors and stacks, or the
 * check API — may leak the raw control bytes, the malformed ID, the absolute
 * source path, raw parser/errno text, or unbounded output.
 */
test("an invalid candidate with a broken body never leaks through any surface", async () => {
  await withHarnessEnvironment(async (environment) => {
    const root = environment.root;
    const hostileId = "evil\u0001\u001b[31m";
    const source = path.join(environment.directory, "hostile");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, `${hostileId}.md`), "---\nname: Evil\ndescription: Broken\n");
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const configFile = path.join(root, ".skill-router.json");
    await writeFile(configFile, `${JSON.stringify({ schemaVersion: 1, sources: [source] }, null, 2)}\n`);
    const runner = createFakeClaudeRunner();
    const before = await digestTree(root);

    const assertBounded = (error, label) => {
      assert.match(error.message, /derived skill ID is not a portable public ID \(reason: grammar\)/, label);
      assert.ok(error.message.length < 200, `${label}: message stays bounded`);
      // Messages stay strictly control-free; stacks legitimately contain
      // newlines and carriage returns as formatting.
      assert.equal(/[\u0000-\u001f]/.test(error.message), false, `${label}: message control-free`);
      assert.equal(/[\u0000-\u0009\u000b-\u001f]/.test(error.stack ?? ""), false, `${label}: stack control-free`);
      for (const text of [error.message, error.stack ?? ""]) {
        assert.equal(text.includes(hostileId), false, `${label}: no malformed ID`);
        assert.equal(text.includes("\u001b"), false, `${label}: no escape sequence`);
        assert.equal(text.includes(source), false, `${label}: no absolute source path`);
        assert.equal(/EACCES|ENOENT|errno|syscall|closing delimiter/.test(text), false, `${label}: no raw cause`);
        assert.ok(text.length < 4000, `${label}: bounded`);
      }
    };

    for (const [label, run] of [
      ["init", () => initOperation({ root, claudeExec: runner })],
      ["init dry-run", () => initOperation({ root, dryRun: true, claudeExec: runner })],
      ["scan", () => scanOperation({ root, claudeExec: runner })],
      ["add", () => addOperation("release", { root, claudeExec: runner })],
    ]) {
      assertBounded(await captureError(run), label);
    }
    assert.deepEqual(await digestTree(root), before, "every refusal writes nothing");

    // The check API reports the same bounded diagnostic shape.
    const checked = await checkOperation({ root, claudeExec: runner });
    assert.equal(checked.healthy, false);
    const reported = checked.diagnostics.filter((item) => item.code === "invalid-skill-id");
    assert.equal(reported.length, 1);
    assert.equal(reported[0].reason, "grammar");
    assert.equal(checked.diagnostics.some((item) => item.code === "invalid-skill"), false, "no parallel parse error");
    const serialized = JSON.stringify(checked);
    assert.equal(serialized.includes(hostileId), false, "check never echoes the malformed ID");
    assert.equal(serialized.includes(source), false, "check never echoes the absolute source path");
    assert.equal(/[\u0000-\u001f]/.test(serialized), false, "check output is control-free");
    assert.ok(serialized.length < 20_000, "check output stays bounded");
  });
});

/**
 * Blocker 2: a malformed installed registry is inert migration input. Route
 * and check still refuse it, while dry-run and real scan succeed — including
 * the post-commit diff — without echoing control/huge poison, and the
 * rebuilt registry is healthy again.
 */
test("scan migrates a malformed installed registry without echoing poison", async () => {
  await withHarnessEnvironment(async (environment) => {
    const root = environment.root;
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const runner = createFakeClaudeRunner();
    await initOperation({ root, harness: "all", claudeExec: runner });
    const registryFile = path.join(root, ".skill-router", "registry.json");
    const healthy = JSON.parse(await readFile(registryFile, "utf8"));
    const control = "claude\u0001\u001b[31m";
    const huge = "x".repeat(100_000);

    // Legacy installed registry: poison `skills` and no `sourceRoots`.
    await writeFile(
      registryFile,
      `${JSON.stringify(
        { schemaVersion: 1, fingerprint: healthy.fingerprint, skills: { [control]: { source: huge } } },
        null,
        2,
      )}\n`,
    );
    await assert.rejects(() => routeOperation("release", { root }), /invalid skill or workflow IDs/);
    const refused = await checkOperation({ root, claudeExec: runner });
    assert.equal(refused.healthy, false, "check still refuses before migration");
    assert.equal(refused.diagnostics.filter((item) => item.code === "registry-invalid-id").length, 1);
    assert.equal(JSON.stringify(refused).includes(huge.slice(0, 80)), false, "check leaks no poison");

    const dryLegacy = await scanOperation({ root, dryRun: true, claudeExec: runner });
    assert.equal(dryLegacy.dryRun, true);
    const legacyScan = await scanOperation({ root, claudeExec: runner });
    assert.deepEqual(legacyScan.diff.added, ["release"]);
    assert.deepEqual(legacyScan.diff.removed, []);

    // Current installed registry: valid sourceRoots, non-array poison skills.
    await writeFile(
      registryFile,
      `${JSON.stringify({ ...healthy, skills: { [huge]: true, [control]: true }, workflows: control }, null, 2)}\n`,
    );
    const dryCurrent = await scanOperation({ root, dryRun: true, claudeExec: runner });
    assert.equal(dryCurrent.dryRun, true);
    const currentScan = await scanOperation({ root, claudeExec: runner });
    const diffText = JSON.stringify(currentScan.diff);
    assert.equal(diffText.includes(huge.slice(0, 80)), false, "the diff never echoes poison");
    assert.equal(diffText.includes("\u0001"), false);
    assert.equal(/[\u0000-\u001f]/.test(diffText), false, "the diff is control-free");

    // The rebuilt registry is healthy again.
    const rebuilt = JSON.parse(await readFile(registryFile, "utf8"));
    assert.deepEqual(rebuilt.skills.map((skill) => skill.id), ["release"]);
    assert.equal((await checkOperation({ root, claudeExec: runner })).healthy, true);
    assert.equal((await routeOperation("release", { root })).skillId, "release");
  });
});

/**
 * The final re-review blocker: `direct-source-unresolved` used to re-expose
 * the raw resolved source path after discovery had already bounded it. Both
 * hostile variants — a valid derived ID with malformed frontmatter, and a
 * path-derived invalid ID — must refuse on every surface while identifying
 * only the validated config key and fixed counts, never the absolute path,
 * an escape byte, a raw cause, or unbounded output.
 */
test("a hostile direct source is refused without leaking its path through any surface", async () => {
  await withHarnessEnvironment(async (environment) => {
    const root = environment.root;
    const configFile = path.join(root, ".skill-router.json");
    const runner = createFakeClaudeRunner();
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    await initOperation({ root, harness: "all", claudeExec: runner });
    assert.equal((await checkOperation({ root, claudeExec: runner })).healthy, true);

    // An absolute ancestor with an escape byte and sensitive components.
    const hostileAncestor = path.join(environment.directory, "sent\u001binel");

    // Case A: valid derived ID (`safe-id`) but malformed frontmatter.
    const malformedSource = path.join(hostileAncestor, "safe-id");
    await mkdir(malformedSource, { recursive: true });
    await writeFile(path.join(malformedSource, "SKILL.md"), "---\nname: Safe\ndescription: Broken\n");
    await writeSchemaV2Config(configFile, { skills: { "safe-id": { source: malformedSource } } });
    const configBefore = await readFile(configFile, "utf8");
    const stateBefore = await digestTree(root);
    const claudeBefore = JSON.stringify(runner.state);
    runner.log.length = 0;

    const assertSafe = (error, label) => {
      assert.match(error.message, /skills\.safe-id\.source must resolve to exactly one skill \(0 found\)/, label);
      assert.ok(error.message.length < 400, `${label}: bounded message`);
      // Messages stay strictly control-free; stacks allow formatting newlines.
      assert.equal(/[\u0000-\u001f]/.test(error.message), false, `${label}: message control-free`);
      assert.equal(/[\u0000-\u0009\u000b-\u001f]/.test(error.stack ?? ""), false, `${label}: stack control-free`);
      for (const text of [error.message, error.stack ?? ""]) {
        assert.equal(text.includes(malformedSource), false, `${label}: no absolute source path`);
        assert.equal(text.includes("\u001b"), false, `${label}: no escape sequence`);
        assert.equal(/EACCES|ENOENT|errno|syscall|closing delimiter/.test(text), false, `${label}: no raw cause`);
        assert.ok(text.length < 4000, `${label}: bounded`);
      }
    };

    for (const [label, run] of [
      ["init", () => initOperation({ root, claudeExec: runner })],
      ["init dry-run", () => initOperation({ root, dryRun: true, claudeExec: runner })],
      ["scan", () => scanOperation({ root, claudeExec: runner })],
      ["add", () => addOperation("release", { root, claudeExec: runner })],
    ]) {
      assertSafe(await captureError(run), label);
      assert.deepEqual(runner.log, [], `${label}: no Claude CLI call on refusal`);
    }
    assert.equal(await readFile(configFile, "utf8"), configBefore, "the config is never rewritten");
    assert.deepEqual(await digestTree(root), stateBefore, "no state, spool, journal, stage, or control change");
    assert.equal(JSON.stringify(runner.state), claudeBefore, "the fake Claude registration is unchanged");

    // The check API exposes the structured code and key, never the path.
    const checked = await checkOperation({ root, claudeExec: runner });
    assert.equal(checked.healthy, false);
    const unresolved = checked.diagnostics.filter((item) => item.code === "direct-source-unresolved");
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].id, "safe-id");
    assert.equal(unresolved[0].message, "skills.safe-id.source must resolve to exactly one skill (0 found)");
    const checkedText = JSON.stringify(checked);
    assert.equal(checkedText.includes(malformedSource), false, "check never echoes the source path");
    assert.equal(checkedText.includes("\u001b"), false);
    assert.equal(/[\u0000-\u001f]/.test(checkedText), false, "check output is control-free");
    assert.ok(checkedText.length < 20_000, "check output stays bounded");
    assert.deepEqual(await digestTree(root), stateBefore, "check is read-only");
    assert.equal(JSON.stringify(runner.state), claudeBefore, "check leaves Claude state unchanged");

    // Case B: a path-derived invalid ID in the same hostile ancestor.
    const invalidSource = path.join(hostileAncestor, "Bad Parent");
    await mkdir(invalidSource, { recursive: true });
    await writeFile(path.join(invalidSource, "SKILL.md"), "---\nname: Safe\ndescription: Safe skill\n---\n\nBody\n");
    await writeSchemaV2Config(configFile, { skills: { "safe-id": { source: invalidSource } } });
    const caseBState = await digestTree(root);
    const invalidChecked = await checkOperation({ root, claudeExec: runner });
    assert.equal(invalidChecked.healthy, false);
    assert.equal(invalidChecked.diagnostics.some((item) => item.code === "invalid-skill-id"), true);
    assert.equal(invalidChecked.diagnostics.filter((item) => item.code === "direct-source-unresolved").length, 1);
    const invalidText = JSON.stringify(invalidChecked);
    assert.equal(invalidText.includes(invalidSource), false, "case B check never echoes the source path");
    assert.equal(invalidText.includes("\u001b"), false);
    assert.equal(/[\u0000-\u001f]/.test(invalidText), false);
    runner.log.length = 0;
    const invalidScan = await captureError(() => scanOperation({ root, claudeExec: runner }));
    assert.match(invalidScan.message, /derived skill ID is not a portable public ID \(reason: grammar\)/);
    assert.match(invalidScan.message, /skills\.safe-id\.source must resolve to exactly one skill \(0 found\)/);
    assert.equal(invalidScan.message.includes(invalidSource), false);
    assert.deepEqual(runner.log, [], "case B: still no Claude CLI call");
    assert.deepEqual(await digestTree(root), caseBState, "case B refusal writes nothing");

    // Recovery: a corrected configuration scans back to health.
    await writeSchemaV2Config(configFile, {});
    const healed = await scanOperation({ root, claudeExec: runner });
    assert.deepEqual(healed.diff, { added: [], removed: [], changed: [] });
    assert.equal((await checkOperation({ root, claudeExec: runner })).healthy, true);
  });
});

test("a successful dry-run writes nothing and execution writes the pre-rendered output", async () => {
  await withHarnessEnvironment(async (environment) => {
    const root = environment.root;
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const before = await digestTree(root);

    const dry = await initOperation({ root, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.skillCount, 1, "the dry-run validated and rendered the plan");
    assert.deepEqual(await digestTree(root), before, "a successful dry-run performs zero writes");

    const init = await initOperation({ root });
    assert.equal(init.skillCount, 1);
    assert.equal(dry.fingerprint, init.fingerprint, "dry-run and execution plan the same registry");

    const installed = JSON.parse(await readFile(path.join(root, ".skill-router", "registry.json"), "utf8"));
    const plan = await planManagedState(path.join(root, ".skill-router"), installed, {
      installation: { harnesses: ["opencode"] },
      requestDirectory: spoolOf(root),
    });
    assert.equal(
      await readFile(path.join(root, ".skill-router", "opencode-skills", "release", "SKILL.md"), "utf8"),
      plan.skills.find((entry) => entry.id === "release").document,
      "execution wrote exactly the pre-rendered document",
    );
    assert.equal(
      await readFile(path.join(root, ".skill-router", "opencode-skills", "skill-router", "SKILL.md"), "utf8"),
      plan.routerDocument,
      "execution wrote exactly the pre-rendered router document",
    );
  });
});

test("claude-only runs skip OpenCode rendering while all-harness runs perform it", async () => {
  await withHarnessEnvironment(async (environment) => {
    const root = environment.root;
    // Valid for discovery and for the Claude renderer, invalid for the OpenCode
    // renderer (non-mapping metadata), so it proves which path ran.
    const source = path.join(root, ".agents", "skills", "release");
    await mkdir(source, { recursive: true });
    await writeFile(
      path.join(source, "SKILL.md"),
      "---\nname: Release\ndescription: Publish releases\nmetadata: legacy-string\n---\n\nBody.\n",
    );
    const runner = createFakeClaudeRunner();
    const before = await digestTree(root);

    const claudeDry = await initOperation({ root, harness: "claude", dryRun: true, claudeExec: runner });
    assert.deepEqual(claudeDry.harnesses, ["claude"]);
    assert.deepEqual(await digestTree(root), before, "Claude-only dry-run writes nothing");
    assert.deepEqual(runner.log, [], "dry-run never invokes the Claude CLI");

    const allDry = await captureError(() =>
      initOperation({ root, harness: "all", dryRun: true, claudeExec: runner }),
    );
    assert.match(
      allDry.message,
      /frontmatter metadata must be a YAML mapping/,
      "all-harness dry-run renders OpenCode documents",
    );
    assert.deepEqual(await digestTree(root), before, "the failing all-harness dry-run writes nothing");

    const claudeInit = await initOperation({ root, harness: "claude", claudeExec: runner });
    assert.deepEqual(claudeInit.harnesses, ["claude"]);
    assert.equal(
      await exists(path.join(root, ".skill-router", "opencode-skills")),
      false,
      "Claude-only staging writes no OpenCode tree",
    );
    assert.ok(runner.log.length > 0, "Claude-only init still registers through the CLI");

    const allInit = await captureError(() => initOperation({ root, harness: "all", claudeExec: runner }));
    assert.equal(allInit.message, allDry.message, "all-harness dry-run and execution reject identically");
  });
});

/* ------------------------------------------------------------------ *
 * Phase 5 — dependent integration: ownership-aware uninstall.
 * ------------------------------------------------------------------ */

const EXTERNAL_MUTATION = /^plugin (?:uninstall|install|update|marketplace add|marketplace remove)\b/;
const READ_ONLY_CLAUDE = /^plugin (?:list|marketplace list|validate)\b/;

function mutationsOf(runner) {
  return runner.log.filter((line) => EXTERNAL_MUTATION.test(line));
}

function openCodeConfigFile(root) {
  return path.join(root, ".opencode", "opencode.json");
}

async function openCodeSources(root) {
  return configuredSkillSources(JSON.parse(await readFile(openCodeConfigFile(root), "utf8")));
}

/** Healthy project-scope installation using both harnesses plus a byte snapshot. */
async function dualInstall(environment) {
  await writeSkill(releaseSource(environment), "Release", "Publish releases");
  const runner = createFakeClaudeRunner();
  const root = environment.root;
  const state = path.join(root, ".skill-router");
  await initOperation({ root, harness: "all", claudeExec: runner });
  return {
    runner,
    root,
    state,
    identity: claudeIdentity({ global: false, stateDirectory: state }),
    snapshot: {
      router: await readFile(path.join(root, ".skill-router.json"), "utf8"),
      openCode: await readFile(openCodeConfigFile(root), "utf8"),
    },
  };
}

function assertHealthyRegistration(runner, state) {
  assert.equal(runner.state.plugins.length, 1, "the exact plugin registration is installed once");
  assert.equal(runner.state.marketplaces.length, 1, "the exact marketplace is declared once");
  assert.equal(runner.state.marketplaces[0].path, path.join(state, "claude"));
}

test("project uninstall removes an OpenCode-only installation and preserves the router configuration", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const runner = createFakeClaudeRunner();
    const root = environment.root;
    const state = path.join(root, ".skill-router");
    const routerConfig = path.join(root, ".skill-router.json");
    await initOperation({ root, claudeExec: runner });
    const configBefore = await readFile(routerConfig, "utf8");

    const result = await uninstallOperation({ root, claudeExec: runner });
    assert.equal(result.command, "uninstall");
    assert.equal(result.scope, "project");
    assert.equal(result.root, root);
    assert.equal(result.status, "removed");
    assert.equal(result.dryRun, false);
    assert.equal(result.configPreserved, true);
    assert.equal(result.stateDirectory, state);
    assert.equal(result.configFile, routerConfig);
    assert.equal(result.openCodeConfig, openCodeConfigFile(root));
    assert.deepEqual(result.harnesses, ["opencode"]);
    assert.equal(result.opencode.status, "detached");
    assert.equal(result.opencode.rewritten, true);
    assert.equal(result.opencode.skillsDirectory, path.join(state, "opencode-skills"));
    assert.deepEqual(result.claude, { status: "not-recorded" });
    assert.equal(runner.log.length, 0, "OpenCode-only uninstall never probes Claude");

    await assert.rejects(() => access(state), /ENOENT/);
    assert.equal(await readFile(routerConfig, "utf8"), configBefore, "the router configuration is preserved byte for byte");
    assert.ok(await exists(openCodeConfigFile(root)), "the OpenCode configuration stays on disk");
    assert.deepEqual(await openCodeSources(root), [], "the exact managed source is detached");
  });
});

test("strict array and paths OpenCode detach remove only the exact managed source", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const root = environment.root;
    const state = path.join(root, ".skill-router");
    const managed = path.join(state, "opencode-skills");
    const file = openCodeConfigFile(root);
    // Unrelated configured sources must exist so discovery stays complete; they
    // are unrelated to the router-managed absolute skills directory.
    await mkdir(path.join(root, "team"), { recursive: true });
    await mkdir(path.join(root, "managed"), { recursive: true });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      `${JSON.stringify(
        { $schema: "https://opencode.ai/config.json", model: "example/model", skills: ["./team", "./managed"], theme: "dark" },
        null,
        2,
      )}\n`,
    );

    await initOperation({ root });
    assert.deepEqual(await openCodeSources(root), ["./team", "./managed", managed]);
    const first = await uninstallOperation({ root });
    assert.equal(first.status, "removed");
    const arrayAfter = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(arrayAfter.skills, ["./team", "./managed"], "every unrelated array entry survives");
    assert.equal(arrayAfter.model, "example/model");
    assert.equal(arrayAfter.theme, "dark");
    assert.equal(arrayAfter.$schema, "https://opencode.ai/config.json");
    await assert.rejects(() => access(state), /ENOENT/);
    assert.ok(await exists(file), "the OpenCode configuration is retained");

    await writeFile(
      file,
      `${JSON.stringify(
        { model: "example/model", skills: { paths: ["./team"], urls: ["https://example.test/skills"] } },
        null,
        2,
      )}\n`,
    );
    await initOperation({ root });
    assert.deepEqual(await openCodeSources(root), ["./team", managed]);
    await uninstallOperation({ root });
    const pathsAfter = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(pathsAfter.skills.paths, ["./team"], "the exact managed path is removed from skills.paths");
    assert.deepEqual(pathsAfter.skills.urls, ["https://example.test/skills"], "sibling sources survive");
    assert.equal(pathsAfter.model, "example/model");
  });
});

test("Claude-only uninstall detaches the registration without creating OpenCode state", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const runner = createFakeClaudeRunner();
    const root = environment.root;
    const state = path.join(root, ".skill-router");
    const init = await initOperation({ root, harness: "claude", claudeExec: runner });
    assert.equal(await exists(openCodeConfigFile(root)), false);

    const result = await uninstallOperation({ root, claudeExec: runner });
    assert.equal(result.status, "removed");
    assert.deepEqual(result.harnesses, ["claude"]);
    assert.deepEqual(result.opencode, { status: "not-recorded" });
    assert.equal(result.claude.status, "detached");
    assert.equal(result.claude.classification, "healthy");
    assert.equal(result.claude.scope, "local");
    assert.equal(result.claude.plugin, init.claude.plugin);
    assert.equal(result.claude.marketplace, init.claude.marketplace);
    assert.equal(result.claude.version, init.claude.version);
    assert.ok(mutationsOf(runner).some((line) => line.startsWith("plugin uninstall ")));
    assert.ok(mutationsOf(runner).some((line) => line.startsWith("plugin marketplace remove ")));
    assert.deepEqual(runner.state.plugins, []);
    assert.deepEqual(runner.state.marketplaces, []);
    assert.equal(await exists(openCodeConfigFile(root)), false, "uninstall creates no OpenCode configuration");
    await assert.rejects(() => access(state), /ENOENT/);
    assert.ok(await exists(path.join(root, ".skill-router.json")), "the router configuration remains");
  });
});

test("dual-harness uninstall detaches both integrations and clears the declaration", async () => {
  await withHarnessEnvironment(async (environment) => {
    const fx = await dualInstall(environment);
    const settingsFile = path.join(fx.root, ".claude", "settings.local.json");
    const declared = JSON.parse(await readFile(settingsFile, "utf8"));

    const result = await uninstallOperation({ root: fx.root, claudeExec: fx.runner });
    assert.equal(result.status, "removed");
    assert.deepEqual(result.harnesses, ["opencode", "claude"]);
    assert.equal(result.opencode.status, "detached");
    assert.equal(result.claude.status, "detached");
    assert.equal(result.claude.classification, "healthy");
    assert.equal(result.claude.marketplaceDirectory, path.join(fx.state, "claude"));
    assert.deepEqual(fx.runner.state.plugins, []);
    assert.deepEqual(fx.runner.state.marketplaces, []);
    const marketplaceName = Object.keys(declared.extraKnownMarketplaces ?? {})[0];
    assert.ok(marketplaceName, "the pre-uninstall declaration names the generated marketplace");
    const after = JSON.parse(await readFile(settingsFile, "utf8"));
    assert.equal(
      after.extraKnownMarketplaces?.[marketplaceName],
      undefined,
      "the scope-owned declaration is removed",
    );
    assert.deepEqual(await openCodeSources(fx.root), []);
    await assert.rejects(() => access(fx.state), /ENOENT/);
    assert.equal(await readFile(path.join(fx.root, ".skill-router.json"), "utf8"), fx.snapshot.router);
    assert.ok(mutationsOf(fx.runner).length >= 2, "both detach steps ran");
  });
});

test("global uninstall removes user-scope state and its integration", async () => {
  await withHarnessEnvironment(async (environment) => {
    const home = environment.home;
    const claudeEnv = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, "claude-config") };
    await mkdir(claudeEnv.CLAUDE_CONFIG_DIR, { recursive: true });
    await writeSkill(path.join(home, ".agents", "skills", "release", "SKILL.md"), "Release", "Publish releases");
    const runner = createFakeClaudeRunner();
    const root = environment.root;
    const state = path.join(home, ".local", "share", "skill-router");
    const openCodeFile = path.join(home, ".config", "opencode", "opencode.json");
    const globalConfig = path.join(home, ".config", "skill-router", "config.json");

    const init = await initOperation({ root, global: true, harness: "all", claudeExec: runner, claudeEnv });
    assert.deepEqual(init.harnesses, ["opencode", "claude"]);
    const result = await uninstallOperation({ root, global: true, claudeExec: runner, claudeEnv });
    assert.equal(result.status, "removed");
    assert.equal(result.scope, "global");
    assert.equal(result.stateDirectory, state);
    assert.equal(result.claude.scope, "user");
    assert.equal(result.claude.marketplace, init.claude.marketplace);
    await assert.rejects(() => access(state), /ENOENT/);
    assert.deepEqual(await configuredSkillSources(JSON.parse(await readFile(openCodeFile, "utf8"))), []);
    assert.ok(await exists(openCodeFile), "the global OpenCode configuration is retained");
    assert.ok(await exists(globalConfig), "the global router configuration is retained");
    assert.deepEqual(runner.state.plugins, []);
    assert.deepEqual(runner.state.marketplaces, []);
    const settings = JSON.parse(await readFile(path.join(claudeEnv.CLAUDE_CONFIG_DIR, "settings.json"), "utf8"));
    assert.equal(settings.extraKnownMarketplaces?.[init.claude.marketplace], undefined, "the user-scope declaration is removed");
  });
});

test("legacy marker-owned state removes OpenCode only and never probes Claude", async () => {
  await withHarnessEnvironment(async (environment) => {
    const fx = await dualInstall(environment);
    await rm(path.join(fx.state, "installation.json"));
    fx.runner.log.length = 0;

    const result = await uninstallOperation({ root: fx.root, claudeExec: fx.runner });
    assert.equal(result.status, "removed");
    assert.deepEqual(result.harnesses, ["opencode"], "legacy state infers OpenCode-only");
    assert.deepEqual(result.claude, { status: "not-recorded" });
    assert.equal(result.opencode.status, "detached");
    assert.equal(fx.runner.log.length, 0, "legacy uninstall never touches the Claude CLI");
    assert.equal(fx.runner.state.plugins.length, 1, "the unrecorded registration is left alone");
    await assert.rejects(() => access(fx.state), /ENOENT/);
    assert.deepEqual(await openCodeSources(fx.root), []);
    assert.ok(await exists(path.join(fx.root, ".skill-router.json")));
  });
});

test("a JSONC OpenCode configuration refuses with its instruction before any Claude probe", async () => {
  await withHarnessEnvironment(async (environment) => {
    const fx = await dualInstall(environment);
    const managed = path.join(fx.state, "opencode-skills");
    const jsonc = `{\n  // keep this comment\n  "skills": { "paths": [${JSON.stringify(managed)}] },\n}\n`;
    await writeFile(openCodeConfigFile(fx.root), jsonc);
    fx.runner.log.length = 0;

    await assert.rejects(
      () => uninstallOperation({ root: fx.root, claudeExec: fx.runner }),
      (error) => {
        assert.match(error.message, /Manual change required before uninstall/);
        assert.match(error.message, /skills\.paths array/);
        assert.ok(error.message.includes(managed), "the instruction names the exact entry");
        return true;
      },
    );
    assert.equal(fx.runner.log.length, 0, "the manual refusal happens before any Claude probe");
    assert.equal(mutationsOf(fx.runner).length, 0);
    assert.equal(await readFile(openCodeConfigFile(fx.root), "utf8"), jsonc, "JSONC is never rewritten");
    assert.ok(await exists(fx.state));
    assert.equal(fx.runner.state.plugins.length, 1, "the registration is untouched");
  });
});

test("a malformed OpenCode configuration refuses before any probe or write", async () => {
  await withHarnessEnvironment(async (environment) => {
    const fx = await dualInstall(environment);
    await writeFile(openCodeConfigFile(fx.root), '{ "skills": [');
    fx.runner.log.length = 0;

    await assert.rejects(() => uninstallOperation({ root: fx.root, claudeExec: fx.runner }), /Invalid/);
    assert.equal(fx.runner.log.length, 0, "no Claude probe happens for a malformed configuration");
    assert.equal(await readFile(openCodeConfigFile(fx.root), "utf8"), '{ "skills": [');
    assert.ok(await exists(fx.state));
    assert.equal(fx.runner.state.plugins.length, 1);
  });
});

test("uninstall refuses symlinked and unmarked state before any probe", async () => {
  await withHarnessEnvironment(async (environment) => {
    const fx = await dualInstall(environment);
    const marker = path.join(fx.state, ".skill-router-owned");
    const openCodeBefore = await readFile(openCodeConfigFile(fx.root), "utf8");
    fx.runner.log.length = 0;

    await writeFile(marker, "skill-router-state-v2\n");
    await assert.rejects(
      () => uninstallOperation({ root: fx.root, claudeExec: fx.runner }),
      /does not match the recorded content/,
    );
    await writeFile(marker, "skill-router-state-v1\n");

    await rm(marker);
    await assert.rejects(
      () => uninstallOperation({ root: fx.root, claudeExec: fx.runner }),
      /Refusing unowned router state/,
    );
    await writeFile(marker, "skill-router-state-v1\n");

    const real = path.join(fx.root, "state-real");
    await rename(fx.state, real);
    await symlink(real, fx.state);
    await assert.rejects(() => uninstallOperation({ root: fx.root, claudeExec: fx.runner }), /symlink/);
    await rm(fx.state);
    await rename(real, fx.state);

    assert.equal(fx.runner.log.length, 0, "ownership refusals happen before any Claude probe");
    assert.equal(mutationsOf(fx.runner).length, 0);
    assert.equal(await readFile(openCodeConfigFile(fx.root), "utf8"), openCodeBefore);
    assert.ok(await exists(fx.state));
    assertHealthyRegistration(fx.runner, fx.state);
  });
});

test("uninstall refuses installation metadata recorded for another scope or state path", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const root = environment.root;
    const state = path.join(root, ".skill-router");
    const runner = createFakeClaudeRunner();
    await initOperation({ root, claudeExec: runner });
    const file = path.join(state, "installation.json");
    const installation = JSON.parse(await readFile(file, "utf8"));
    const openCodeBefore = await readFile(openCodeConfigFile(root), "utf8");

    await writeFile(file, `${JSON.stringify({ ...installation, scope: "global" }, null, 2)}\n`);
    await assert.rejects(() => uninstallOperation({ root }), /scope is global, expected project/);

    await writeFile(
      file,
      `${JSON.stringify({ ...installation, stateDirectory: path.join(root, "elsewhere") }, null, 2)}\n`,
    );
    await assert.rejects(() => uninstallOperation({ root }), /stateDirectory does not match/);

    await writeFile(file, `${JSON.stringify(installation, null, 2)}\n`);
    assert.equal(await readFile(openCodeConfigFile(root), "utf8"), openCodeBefore, "no refusal wrote anything");
    assert.ok(await exists(state));
    assert.equal((await uninstallOperation({ root })).status, "removed");
  });
});

test("dry-run runs the full preflight and writes or mutates nothing", async () => {
  await withHarnessEnvironment(async (environment) => {
    const fx = await dualInstall(environment);
    const routerBefore = await readFile(path.join(fx.root, ".skill-router.json"), "utf8");
    const openCodeBefore = await readFile(openCodeConfigFile(fx.root), "utf8");
    const installationBefore = await readFile(path.join(fx.state, "installation.json"), "utf8");
    const registryBefore = await readFile(path.join(fx.state, "registry.json"), "utf8");
    const managedBefore = await readFile(path.join(fx.state, "opencode-skills", "release", "SKILL.md"), "utf8");
    const claudeBefore = await readFile(path.join(fx.state, "claude", "plugins", "openagency-skill-router", "skills", "release", "SKILL.md"), "utf8");
    const claudeStateBefore = JSON.stringify(fx.runner.state);
    fx.runner.log.length = 0;

    const dry = await uninstallOperation({ root: fx.root, dryRun: true, claudeExec: fx.runner });
    assert.equal(dry.status, "would-remove");
    assert.equal(dry.dryRun, true);
    assert.equal(dry.configPreserved, true);
    assert.deepEqual(dry.harnesses, ["opencode", "claude"]);
    assert.equal(dry.opencode.status, "would-detach");
    assert.equal(dry.opencode.rewritten, false);
    assert.equal(dry.claude.status, "would-detach");
    assert.equal(dry.claude.classification, "healthy");

    assert.equal(fx.runner.log.length > 0, true, "the preflight observes Claude read-only");
    for (const line of fx.runner.log) assert.match(line, READ_ONLY_CLAUDE, `read-only preflight: ${line}`);
    assert.equal(mutationsOf(fx.runner).length, 0, "dry-run never mutates Claude");
    assert.equal(JSON.stringify(fx.runner.state), claudeStateBefore, "the fake Claude state is untouched");

    assert.equal(await readFile(path.join(fx.root, ".skill-router.json"), "utf8"), routerBefore);
    assert.equal(await readFile(openCodeConfigFile(fx.root), "utf8"), openCodeBefore, "the OpenCode configuration is untouched");
    assert.equal(await readFile(path.join(fx.state, "installation.json"), "utf8"), installationBefore);
    assert.equal(await readFile(path.join(fx.state, "registry.json"), "utf8"), registryBefore);
    assert.equal(
      await readFile(path.join(fx.state, "opencode-skills", "release", "SKILL.md"), "utf8"),
      managedBefore,
    );
    assert.equal(
      await readFile(path.join(fx.state, "claude", "plugins", "openagency-skill-router", "skills", "release", "SKILL.md"), "utf8"),
      claudeBefore,
      "the generated Claude source is still canonical after dry-run",
    );
    assert.ok(await exists(fx.state));
  });
});

test("uninstall resolves the initialized ancestor from a nested root", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const project = environment.root;
    const nested = path.join(project, "sub", "deep");
    await mkdir(nested, { recursive: true });
    await initOperation({ root: project });

    const result = await uninstallOperation({ root: nested });
    assert.equal(result.root, project, "the nested root resolves the ancestor installation");
    assert.equal(result.configFile, path.join(project, ".skill-router.json"));
    assert.equal(result.stateDirectory, path.join(project, ".skill-router"));
    assert.equal(result.status, "removed");
    await assert.rejects(() => access(path.join(project, ".skill-router")), /ENOENT/);
    assert.ok(await exists(path.join(project, ".skill-router.json")), "the ancestor router configuration remains");
    assert.equal(await exists(path.join(nested, ".skill-router")), false, "no nested state is created or removed");
    assert.deepEqual(await openCodeSources(project), []);
  });
});

test("uninstall honors an explicit --config and keeps that configuration file", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const root = environment.root;
    const customFile = path.join(root, "custom", "router.json");
    await mkdir(path.dirname(customFile), { recursive: true });
    const custom = `${JSON.stringify({ schemaVersion: 1, sources: [] }, null, 2)}\n`;
    await writeFile(customFile, custom);

    const init = await initOperation({ root, config: "custom/router.json" });
    assert.equal(init.configFile, customFile);
    assert.equal(init.registryFile, path.join(root, ".skill-router", "registry.json"));
    const written = await readFile(customFile, "utf8");

    const result = await uninstallOperation({ root, config: "custom/router.json" });
    assert.equal(result.configFile, customFile);
    assert.equal(result.stateDirectory, path.join(root, ".skill-router"));
    assert.equal(result.status, "removed");
    await assert.rejects(() => access(path.join(root, ".skill-router")), /ENOENT/);
    assert.equal(await readFile(customFile, "utf8"), written, "the explicit router configuration is preserved");
    assert.equal(await exists(path.join(root, ".skill-router.json")), false, "no implicit configuration appears");
    assert.deepEqual(await openCodeSources(root), []);

    // Without --config the same root resolves the implicit configuration, which
    // still reports the installation as absent rather than inferring ownership.
    const again = await uninstallOperation({ root });
    assert.equal(again.status, "already-absent");
    assert.equal(again.configFile, path.join(root, ".skill-router.json"));
  });
});

test("fully absent Claude permits state removal even with a damaged generated subtree", async () => {
  await withHarnessEnvironment(async (environment) => {
    const fx = await dualInstall(environment);
    // The user already detached by hand: no registration, no declaration, and
    // the generated subtree is damaged. Uninstall must still succeed without
    // inspecting or mutating Claude.
    fx.runner.state.marketplaces = [];
    fx.runner.state.plugins = [];
    await rm(path.join(fx.root, ".claude", "settings.local.json"), { force: true });
    await rm(path.join(fx.state, "claude"), { recursive: true, force: true });
    fx.runner.log.length = 0;

    const result = await uninstallOperation({ root: fx.root, claudeExec: fx.runner });
    assert.equal(result.status, "removed");
    assert.equal(result.claude.status, "already-detached");
    assert.equal(result.claude.classification, "absent");
    assert.equal(result.opencode.status, "detached");
    assert.equal(fx.runner.log.some((line) => line.startsWith("plugin validate")), false, "no generated-source inspection for absent Claude");
    assert.equal(mutationsOf(fx.runner).length, 0, "absent Claude needs no mutation");
    for (const line of fx.runner.log) assert.match(line, READ_ONLY_CLAUDE);
    await assert.rejects(() => access(fx.state), /ENOENT/);
    assert.deepEqual(await openCodeSources(fx.root), []);
    assert.equal(await readFile(path.join(fx.root, ".skill-router.json"), "utf8"), fx.snapshot.router);
  });
});

test("every Claude drift refuses before any write", async () => {
  await withHarnessEnvironment(async (environment) => {
    const fx = await dualInstall(environment);
    const openCodeBefore = await readFile(openCodeConfigFile(fx.root), "utf8");
    const routerBefore = await readFile(path.join(fx.root, ".skill-router.json"), "utf8");
    const marketplaceRoot = path.join(fx.state, "claude");
    const recorded = fx.runner.state.plugins[0].version;
    let spliced = [];
    fx.runner.log.length = 0;

    const refusals = [
      [
        "wrong version",
        () => {
          fx.runner.state.plugins[0].version = "9.9.9";
        },
        () => {
          fx.runner.state.plugins[0].version = recorded;
        },
      ],
      [
        "disabled plugin",
        () => {
          fx.runner.state.plugins[0].enabled = false;
        },
        () => {
          fx.runner.state.plugins[0].enabled = true;
        },
      ],
      [
        "duplicate reference",
        () => {
          fx.runner.state.plugins.push({ ...fx.runner.state.plugins[0] });
        },
        () => {
          fx.runner.state.plugins.pop();
        },
      ],
      [
        "wrong marketplace path",
        () => {
          fx.runner.state.marketplaces[0].path = path.join(environment.directory, "elsewhere");
        },
        () => {
          fx.runner.state.marketplaces[0].path = marketplaceRoot;
        },
      ],
      [
        "partial absence",
        () => {
          spliced = fx.runner.state.plugins.splice(0, fx.runner.state.plugins.length);
        },
        () => {
          fx.runner.state.plugins.push(...spliced);
        },
      ],
    ];

    for (const [label, tamper, restore] of refusals) {
      tamper();
      await assert.rejects(
        () => uninstallOperation({ root: fx.root, claudeExec: fx.runner }),
        /cannot be removed safely/,
        label,
      );
      restore();
      assert.equal(await readFile(openCodeConfigFile(fx.root), "utf8"), openCodeBefore, `${label}: OpenCode stays untouched`);
      assert.ok(await exists(fx.state), `${label}: state survives`);
    }

    assert.equal(mutationsOf(fx.runner).length, 0, "no drift ever reaches a mutation");
    assert.equal(await readFile(path.join(fx.root, ".skill-router.json"), "utf8"), routerBefore);
    assertHealthyRegistration(fx.runner, fx.state);
    const recovered = await uninstallOperation({ root: fx.root, claudeExec: fx.runner });
    assert.equal(recovered.status, "removed", "a healthy retry still succeeds");
  });
});

test("an extra marketplace-owned plugin refuses and survives the blast radius", async () => {
  await withHarnessEnvironment(async (environment) => {
    const fx = await dualInstall(environment);
    const marketplace = fx.runner.state.marketplaces[0].name;
    const extra = { id: `team-tools@${marketplace}`, version: "1.2.3", scope: "local", enabled: true };
    fx.runner.state.plugins.push(extra);
    // The fake models the real CLI: removing this marketplace would uninstall
    // every plugin it owns, at any scope.
    assert.equal(pluginBelongsToMarketplace(extra, marketplace), true, "the fake models the real marketplace blast radius");
    const openCodeBefore = await readFile(openCodeConfigFile(fx.root), "utf8");
    fx.runner.log.length = 0;

    await assert.rejects(
      () => uninstallOperation({ root: fx.root, claudeExec: fx.runner }),
      /plugin team-tools@.* from marketplace/,
    );
    assert.equal(mutationsOf(fx.runner).length, 0, "refusal happens before any mutation");
    assert.deepEqual(fx.runner.state.plugins.map((entry) => entry.id), [
      fx.runner.state.plugins[0].id,
      `team-tools@${marketplace}`,
    ]);
    assert.ok(
      fx.runner.state.plugins.some((entry) => entry.id === `team-tools@${marketplace}`),
      "the extra plugin survives because nothing was removed",
    );
    assert.equal(fx.runner.state.marketplaces.length, 1, "the marketplace is still declared");
    assert.equal(await readFile(openCodeConfigFile(fx.root), "utf8"), openCodeBefore);
    assert.ok(await exists(fx.state));
    assert.ok(
      await exists(path.join(fx.state, "claude", "plugins", "openagency-skill-router", "skills", "release", "SKILL.md")),
      "the generated source is untouched",
    );
  });
});

test("a fail-before-mutation plugin uninstall restores OpenCode bytes and the healthy registration", async () => {
  await withHarnessEnvironment(async (environment) => {
    const fx = await dualInstall(environment);
    const reference = `${fx.identity.plugin}@${fx.identity.marketplace}`;
    fx.runner.failOn(`plugin uninstall ${reference} --scope local`, "uninstall refused");

    await assert.rejects(() => uninstallOperation({ root: fx.root, claudeExec: fx.runner }), /uninstall refused/);
    assert.equal(await readFile(openCodeConfigFile(fx.root), "utf8"), fx.snapshot.openCode, "OpenCode bytes are restored");
    assert.equal(await readFile(path.join(fx.root, ".skill-router.json"), "utf8"), fx.snapshot.router);
    assert.ok(await exists(fx.state), "the canonical state is kept");
    assertHealthyRegistration(fx.runner, fx.state);
    assert.deepEqual(
      await openCodeSources(fx.root),
      [path.join(fx.state, "opencode-skills")],
      "the restored configuration still lists the managed source",
    );
    assert.equal((await checkOperation({ root: fx.root, claudeExec: fx.runner })).healthy, true, "the installation is healthy again");
  });
});

test("a fail-before-mutation marketplace removal restores the plugin registration and OpenCode bytes", async () => {
  await withHarnessEnvironment(async (environment) => {
    const fx = await dualInstall(environment);
    fx.runner.failOn(`plugin marketplace remove ${fx.identity.marketplace} --scope local`, "remove refused");

    await assert.rejects(() => uninstallOperation({ root: fx.root, claudeExec: fx.runner }), /remove refused/);
    assert.equal(await readFile(openCodeConfigFile(fx.root), "utf8"), fx.snapshot.openCode, "OpenCode bytes are restored");
    assert.ok(await exists(fx.state));
    assertHealthyRegistration(fx.runner, fx.state);
    const declaration = JSON.parse(await readFile(path.join(fx.root, ".claude", "settings.local.json"), "utf8"));
    assert.ok(declaration.extraKnownMarketplaces?.[fx.identity.marketplace], "the declaration is restored");
    assert.equal((await checkOperation({ root: fx.root, claudeExec: fx.runner })).healthy, true);
  });
});

test("a mutate-then-error detach is reconciled and the uninstall still completes", async () => {
  await withHarnessEnvironment(async (environment) => {
    const fx = await dualInstall(environment);
    const reference = `${fx.identity.plugin}@${fx.identity.marketplace}`;
    fx.runner.failOn(`plugin uninstall ${reference} --scope local`, "exit 1 after mutating", { mutate: true });

    const result = await uninstallOperation({ root: fx.root, claudeExec: fx.runner });
    assert.equal(result.status, "removed");
    assert.equal(result.claude.status, "detached");
    assert.deepEqual(fx.runner.state.plugins, [], "the mutation is observed and trusted");
    assert.deepEqual(fx.runner.state.marketplaces, []);
    await assert.rejects(() => access(fx.state), /ENOENT/);
    assert.deepEqual(await openCodeSources(fx.root), []);
    const declaration = JSON.parse(await readFile(path.join(fx.root, ".claude", "settings.local.json"), "utf8"));
    assert.equal(declaration.extraKnownMarketplaces?.[fx.identity.marketplace], undefined);
  });
});

test("a local OpenCode write failure stops the run before any Claude mutation", async () => {
  await withHarnessEnvironment(async (environment) => {
    const fx = await dualInstall(environment);
    const realStep = journaledTransactionInternals.onStep;
    let failed = false;
    fx.runner.log.length = 0;
    journaledTransactionInternals.onStep = async (step) => {
      if (step === "file-write" && !failed) {
        failed = true;
        throw new Error("local write refused");
      }
    };
    try {
      await assert.rejects(
        () => uninstallOperation({ root: fx.root, claudeExec: fx.runner }),
        /local write refused/,
      );
    } finally {
      journaledTransactionInternals.onStep = realStep;
    }
    assert.equal(mutationsOf(fx.runner).length, 0, "Claude is never mutated after a local failure");
    assert.equal(await readFile(openCodeConfigFile(fx.root), "utf8"), fx.snapshot.openCode);
    assert.ok(await exists(fx.state));
    assertHealthyRegistration(fx.runner, fx.state);
  });
});

test("a commit rename failure restores the OpenCode bytes and the healthy registration", async () => {
  await withHarnessEnvironment(async (environment) => {
    const fx = await dualInstall(environment);
    const realRename = journaledTransactionInternals.rename;
    journaledTransactionInternals.rename = async () => {
      throw new Error("rename refused");
    };
    try {
      await assert.rejects(() => uninstallOperation({ root: fx.root, claudeExec: fx.runner }), /rename refused/);
    } finally {
      journaledTransactionInternals.rename = realRename;
    }
    assert.equal(await readFile(openCodeConfigFile(fx.root), "utf8"), fx.snapshot.openCode, "OpenCode bytes are restored");
    assert.equal(await readFile(path.join(fx.root, ".skill-router.json"), "utf8"), fx.snapshot.router);
    assert.ok(await exists(fx.state), "the canonical state is kept");
    assertHealthyRegistration(fx.runner, fx.state);
    assert.equal((await checkOperation({ root: fx.root, claudeExec: fx.runner })).healthy, true);
  });
});

test("a backup cleanup failure reports a committed uninstall and never reinstalls", async () => {
  await withHarnessEnvironment(async (environment) => {
    const fx = await dualInstall(environment);
    const installationBefore = await readFile(path.join(fx.state, "installation.json"), "utf8");
    const realRm = journaledTransactionInternals.rm;
    let backupPath = null;
    journaledTransactionInternals.rm = async (target, options) => {
      if (String(target).includes(".backup-")) throw new Error("cleanup refused");
      return realRm(target, options);
    };
    try {
      await assert.rejects(
        () => uninstallOperation({ root: fx.root, claudeExec: fx.runner }),
        (error) => {
          assert.ok(error instanceof UninstallCommittedCleanupError, "the committed cleanup failure is distinct");
          assert.match(error.message, /Uninstall committed/);
          backupPath = error.backupPath;
          assert.ok(error.message.includes(backupPath), "the message names the exact backup path");
          return true;
        },
      );
    } finally {
      journaledTransactionInternals.rm = realRm;
    }
    assert.equal(fx.runner.state.plugins.length, 0, "a committed uninstall never reinstalls the plugin");
    assert.deepEqual(fx.runner.state.marketplaces, [], "a committed uninstall never re-registers the marketplace");
    await assert.rejects(() => access(fx.state), /ENOENT/, "the state rename already committed");
    assert.deepEqual(await openCodeSources(fx.root), [], "the local detach stays committed");
    assert.equal(await readFile(path.join(fx.root, ".skill-router.json"), "utf8"), fx.snapshot.router);
    // B3: a failed removal never renames anything back over the recorded
    // path. The recorded backup path stays absent, and the exact owned
    // installation survives at the preserved re-claimed deletion claim inside
    // its durably attributed cleanup container.
    await assert.rejects(() => access(backupPath), /ENOENT/, "nothing is renamed back over the recorded backup path");
    const claimParent = path.dirname(backupPath);
    const containerName = (await readdir(claimParent)).find((name) =>
      name.startsWith(`${path.basename(backupPath)}.claim-`),
    );
    assert.ok(containerName, "the attributed cleanup claim container is preserved");
    const container = path.join(claimParent, containerName);
    const deletionChild = (await readdir(container)).find((name) => /^delete-[0-9a-f]{32}$/.test(name));
    assert.ok(deletionChild, "the re-claimed deletion claim is preserved");
    assert.equal(
      await readFile(path.join(container, deletionChild, "installation.json"), "utf8"),
      installationBefore,
      "the preserved deletion claim still holds the exact owned installation",
    );
    await rm(container, { recursive: true, force: true });
  });
});

test("repeated uninstall is idempotent and probes nothing", async () => {
  await withHarnessEnvironment(async (environment) => {
    const fx = await dualInstall(environment);
    const routerBefore = await readFile(path.join(fx.root, ".skill-router.json"), "utf8");
    const first = await uninstallOperation({ root: fx.root, claudeExec: fx.runner });
    assert.equal(first.status, "removed");
    const openCodeAfter = await readFile(openCodeConfigFile(fx.root), "utf8");
    fx.runner.log.length = 0;

    const again = await uninstallOperation({ root: fx.root, claudeExec: fx.runner });
    assert.equal(again.status, "already-absent");
    assert.deepEqual(again.harnesses, []);
    assert.equal(again.configPreserved, true);
    assert.deepEqual(again.opencode, { status: "not-recorded" });
    assert.deepEqual(again.claude, { status: "not-recorded" });
    assert.equal(fx.runner.log.length, 0, "an already-absent uninstall never probes Claude");

    const dryAgain = await uninstallOperation({ root: fx.root, dryRun: true, claudeExec: fx.runner });
    assert.equal(dryAgain.status, "already-absent");
    assert.equal(dryAgain.dryRun, true);
    assert.equal(fx.runner.log.length, 0);

    assert.equal(await readFile(path.join(fx.root, ".skill-router.json"), "utf8"), routerBefore, "the router configuration is retained");
    assert.equal(await readFile(openCodeConfigFile(fx.root), "utf8"), openCodeAfter, "the detached OpenCode configuration is stable");
    assert.equal(await exists(path.join(fx.root, ".claude", "settings.local.json")), true, "Claude-owned settings are never deleted by the router");
  });
});

test("uninstall rejects harness selections and selective removal", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    await initOperation({ root: environment.root });
    await assert.rejects(
      () => uninstallOperation({ root: environment.root, harness: "claude" }),
      /does not accept a harness selection/,
    );
    assert.ok(await exists(path.join(environment.root, ".skill-router")));
    assert.ok((await openCodeSources(environment.root)).length > 0, "the installation is untouched");
  });
});

test("init, add, and scan refuse a router configuration inside state", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const root = environment.root;
    const runner = createFakeClaudeRunner();
    const remedy = /Copy the configuration file outside the router-owned state directory and retry/;

    for (const attempt of [
      () => initOperation({ root, config: ".skill-router/router.json", harness: "all", claudeExec: runner }),
      () => initOperation({ root, config: ".skill-router/router.json", harness: "all", dryRun: true, claudeExec: runner }),
      () => addOperation(releaseSource(environment), { root, config: ".skill-router/router.json", claudeExec: runner }),
      () => scanOperation({ root, config: ".skill-router/router.json", claudeExec: runner }),
    ]) {
      await assert.rejects(attempt, (error) => {
        assert.match(error.message, /is inside/, error.message);
        assert.match(error.message, remedy, error.message);
        return true;
      });
    }

    assert.equal(await exists(path.join(root, ".skill-router")), false, "no state directory is created");
    assert.equal(await exists(path.join(root, ".skill-router", "router.json")), false);
    assert.equal(await exists(path.join(root, ".skill-router.json")), false, "no router configuration is created");
    assert.equal(runner.log.length, 0, "no Claude probe runs before the refusal");

    // The same commands refuse a configuration that resolves into an existing
    // state directory through a symlinked parent.
    const state = path.join(root, ".skill-router");
    await mkdir(state, { recursive: true });
    await writeFile(path.join(state, STATE_MARKER_FILE), `${STATE_MARKER_CONTENT}\n`);
    const alias = path.join(root, "state-alias");
    await symlink(state, alias);
    for (const attempt of [
      () => initOperation({ root, config: "state-alias/router.json", harness: "all", claudeExec: runner }),
      () => scanOperation({ root, config: "state-alias/router.json", claudeExec: runner }),
      () => addOperation(releaseSource(environment), { root, config: "state-alias/router.json", claudeExec: runner }),
    ]) {
      await assert.rejects(attempt, /resolves to .* which is inside the router-owned state directory/);
    }
    assert.equal(await readFile(path.join(state, STATE_MARKER_FILE), "utf8"), `${STATE_MARKER_CONTENT}\n`);
    assert.equal(runner.log.length, 0, "no Claude probe runs before the symlink refusal either");
  });
});

test("global init and uninstall refuse a configuration inside the global state", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(path.join(environment.home, ".agents", "skills", "release", "SKILL.md"), "Release", "Publish releases");
    const root = environment.root;
    const runner = createFakeClaudeRunner();
    const claudeEnv = { HOME: environment.home, CLAUDE_CONFIG_DIR: path.join(environment.home, "claude-config") };
    await mkdir(claudeEnv.CLAUDE_CONFIG_DIR, { recursive: true });
    const globalState = path.join(environment.home, ".local", "share", "skill-router");
    const inside = path.join(globalState, "config.json");
    const remedy = /Copy the configuration file outside the router-owned state directory and retry/;

    await assert.rejects(
      () => initOperation({ root, global: true, config: inside, harness: "all", claudeExec: runner, claudeEnv }),
      remedy,
    );
    assert.equal(await exists(globalState), false, "no global state is created before the refusal");
    assert.equal(runner.log.length, 0);

    await initOperation({ root, global: true, harness: "all", claudeExec: runner, claudeEnv });
    const installationBefore = await readFile(path.join(globalState, "installation.json"), "utf8");
    const globalConfig = path.join(environment.home, ".config", "skill-router", "config.json");
    const configBefore = await readFile(globalConfig, "utf8");
    runner.log.length = 0;

    await assert.rejects(
      () => uninstallOperation({ root, global: true, config: inside, claudeExec: runner, claudeEnv }),
      remedy,
    );
    assert.equal(runner.log.length, 0, "uninstall refuses before any Claude probe");
    assert.equal(await readFile(path.join(globalState, "installation.json"), "utf8"), installationBefore, "ownership metadata is untouched");
    assert.equal(await readFile(globalConfig, "utf8"), configBefore, "the real global configuration is untouched");
    assert.equal(runner.state.plugins.length, 1, "the registration is untouched");

    // ... and the same refusal applies when the path resolves into state
    // through an existing symlink.
    const globalAlias = path.join(environment.home, "state-alias");
    await symlink(globalState, globalAlias);
    await assert.rejects(
      () =>
        uninstallOperation({
          root,
          global: true,
          config: path.join(globalAlias, "config.json"),
          claudeExec: runner,
          claudeEnv,
        }),
      /resolves to .* which is inside the router-owned state directory/,
    );
    assert.equal(runner.log.length, 0, "the symlink refusal also runs before any Claude probe");

    assert.equal((await uninstallOperation({ root, global: true, claudeExec: runner, claudeEnv })).status, "removed");
  });
});

test("project uninstall refuses a configuration inside state before ownership or integration probes", async () => {
  await withHarnessEnvironment(async (environment) => {
    const fx = await dualInstall(environment);
    const remedy = /Copy the configuration file outside the router-owned state directory and retry/;
    const installationBefore = await readFile(path.join(fx.state, "installation.json"), "utf8");
    const openCodeBefore = await readFile(openCodeConfigFile(fx.root), "utf8");
    fx.runner.log.length = 0;

    await assert.rejects(
      () => uninstallOperation({ root: fx.root, config: ".skill-router/router.json", claudeExec: fx.runner }),
      (error) => {
        assert.match(error.message, /is inside/, error.message);
        assert.match(error.message, remedy, error.message);
        return true;
      },
    );
    assert.equal(fx.runner.log.length, 0, "no Claude probe runs before the refusal");
    assert.equal(await readFile(path.join(fx.state, "installation.json"), "utf8"), installationBefore);
    assert.equal(await readFile(openCodeConfigFile(fx.root), "utf8"), openCodeBefore);
    assert.equal(fx.runner.state.plugins.length, 1);
    assert.equal((await readFile(path.join(fx.root, ".skill-router.json"), "utf8")), fx.snapshot.router);

    // The same configuration reached through a symlinked parent resolves into
    // state and is refused with the resolved-path wording.
    const alias = path.join(fx.root, "state-alias");
    await symlink(fx.state, alias);
    fx.runner.log.length = 0;
    await assert.rejects(
      () => uninstallOperation({ root: fx.root, config: "state-alias/router.json", claudeExec: fx.runner }),
      /resolves to .* which is inside the router-owned state directory/,
    );
    assert.equal(fx.runner.log.length, 0);
    assert.equal(await readFile(path.join(fx.state, "installation.json"), "utf8"), installationBefore);
    assert.equal((await uninstallOperation({ root: fx.root, claudeExec: fx.runner })).status, "removed", "the installation is still removable afterwards");
  });
});

test("a configuration changed after planning refuses before any write or Claude mutation", async () => {
  await withHarnessEnvironment(async (environment) => {
    const fx = await dualInstall(environment);
    const file = openCodeConfigFile(fx.root);
    const observed = await readFile(file, "utf8");
    const mutated = `${JSON.stringify({ ...JSON.parse(observed), theme: "dark" }, null, 2)}\n`;
    assert.notEqual(mutated, observed, "the concurrent writer produces different bytes");
    let probes = 0;
    fx.runner.log.length = 0;
    const exec = async (argv, options) => {
      probes += 1;
      // The very first Claude probe happens after the removal plan was built.
      if (probes === 1) await writeFile(file, mutated);
      return fx.runner(argv, options);
    };

    await assert.rejects(
      () => uninstallOperation({ root: fx.root, claudeExec: exec }),
      /no longer matches the bytes observed during planning/,
    );
    assert.equal(await readFile(file, "utf8"), mutated, "the concurrent contents are preserved");
    assert.equal(mutationsOf(fx.runner).length, 0, "Claude is never mutated");
    assert.ok(await exists(fx.state), "the canonical state survives");
    assertHealthyRegistration(fx.runner, fx.state);
    assert.equal(fx.runner.state.marketplaces[0].path, path.join(fx.state, "claude"));
  });
});

test("an OpenCode source reintroduced before commit aborts the uninstall", async () => {
  await withHarnessEnvironment(async (environment) => {
    const fx = await dualInstall(environment);
    const file = openCodeConfigFile(fx.root);
    const managed = path.join(fx.state, "opencode-skills");

    // The user already detached the source by hand: the plan records absence.
    const detached = JSON.parse(await readFile(file, "utf8"));
    if (Array.isArray(detached.skills)) detached.skills = detached.skills.filter((value) => value !== managed);
    else if (detached.skills && Array.isArray(detached.skills.paths)) {
      detached.skills.paths = detached.skills.paths.filter((value) => value !== managed);
    }
    await writeFile(file, `${JSON.stringify(detached, null, 2)}\n`);
    assert.deepEqual(await openCodeSources(fx.root), []);

    const exec = async (argv, options) => {
      const result = await fx.runner(argv, options);
      if (argv.join(" ").startsWith("plugin marketplace remove ")) {
        // Concurrently put the managed source back after the external detach.
        const document = JSON.parse(await readFile(file, "utf8"));
        if (Array.isArray(document.skills)) document.skills.push(managed);
        else document.skills.paths.push(managed);
        await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
      }
      return result;
    };
    fx.runner.log.length = 0;

    await assert.rejects(() => uninstallOperation({ root: fx.root, claudeExec: exec }), /still configured/);
    assert.deepEqual(await openCodeSources(fx.root), [managed], "the reintroduced source is preserved, not clobbered");
    assert.ok(await exists(fx.state), "the canonical state survives the abort");
    assertHealthyRegistration(fx.runner, fx.state);
    const declaration = JSON.parse(await readFile(path.join(fx.root, ".claude", "settings.local.json"), "utf8"));
    assert.ok(declaration.extraKnownMarketplaces?.[fx.identity.marketplace], "the declaration is restored");
  });
});

test("a Claude registration reintroduced before commit aborts an initially absent uninstall", async () => {
  await withHarnessEnvironment(async (environment) => {
    const fx = await dualInstall(environment);
    const reference = `${fx.identity.plugin}@${fx.identity.marketplace}`;
    const version = fx.runner.state.plugins[0].version;
    // Claude was already detached by hand: no registration and no declaration.
    fx.runner.state.marketplaces = [];
    fx.runner.state.plugins = [];
    await rm(path.join(fx.root, ".claude", "settings.local.json"), { force: true });
    fx.runner.log.length = 0;

    const realStep = journaledTransactionInternals.onStep;
    let reintroduced = false;
    journaledTransactionInternals.onStep = async (step) => {
      // A concurrent actor re-registers the moment the local detach lands.
      if (step === "file-applied" && !reintroduced) {
        reintroduced = true;
        fx.runner.state.plugins.push({ id: reference, version, scope: "local", enabled: true });
      }
    };
    try {
      await assert.rejects(
        () => uninstallOperation({ root: fx.root, claudeExec: fx.runner }),
        /must be fully absent before the commit boundary/,
      );
    } finally {
      journaledTransactionInternals.onStep = realStep;
    }

    assert.equal(
      fx.runner.log.some((line) => line.startsWith("plugin uninstall ") || line.startsWith("plugin marketplace remove ")),
      false,
      "an initially absent registration is never mutated, so there is nothing to compensate",
    );
    assert.deepEqual(fx.runner.state.plugins.map((entry) => entry.id), [reference], "the reintroduced registration is left alone");
    assert.equal(await readFile(openCodeConfigFile(fx.root), "utf8"), fx.snapshot.openCode, "OpenCode is restored");
    assert.ok(await exists(fx.state), "the canonical state survives");
    assert.equal(await readFile(path.join(fx.root, ".skill-router.json"), "utf8"), fx.snapshot.router);
  });
});

test("a Claude registration reintroduced before commit aborts a healthy uninstall and is compensated", async () => {
  await withHarnessEnvironment(async (environment) => {
    const fx = await dualInstall(environment);
    const marketplace = fx.runner.state.marketplaces[0].name;
    const marketplaceRoot = path.join(fx.state, "claude");
    const settingsFile = path.join(fx.root, ".claude", "settings.local.json");

    let removalSeen = false;
    let observationsSinceRemoval = 0;
    let reintroducedAt = null;
    const exec = async (argv, options) => {
      const key = argv.join(" ");
      if (removalSeen && observationsSinceRemoval === 2 && key === "plugin marketplace list --json") {
        // Re-register the scope-owned marketplace just before the final
        // commit-boundary observation, without reinstalling the plugin.
        reintroducedAt = observationsSinceRemoval;
        fx.runner.state.marketplaces.push({ name: marketplace, path: marketplaceRoot, scope: "local" });
        const document = JSON.parse(await readFile(settingsFile, "utf8"));
        document.extraKnownMarketplaces = {
          ...(document.extraKnownMarketplaces ?? {}),
          [marketplace]: { source: { source: "directory", path: marketplaceRoot } },
        };
        await writeFile(settingsFile, `${JSON.stringify(document, null, 2)}\n`);
      }
      const result = await fx.runner(argv, options);
      if (key.startsWith("plugin marketplace remove ")) removalSeen = true;
      if (removalSeen && key === "plugin list --json") observationsSinceRemoval += 1;
      return result;
    };
    fx.runner.log.length = 0;

    await assert.rejects(
      () => uninstallOperation({ root: fx.root, claudeExec: exec }),
      /must be fully absent before the commit boundary/,
    );
    assert.equal(
      reintroducedAt,
      2,
      "the reintroduction lands between ordinary external verification and the commit boundary",
    );
    assert.ok(observationsSinceRemoval >= 3, "the commit boundary re-observed Claude");
    assert.ok(
      mutationsOf(fx.runner).some((line) => line.startsWith("plugin install ")),
      "an initially healthy registration is compensated back to health",
    );
    assertHealthyRegistration(fx.runner, fx.state);
    assert.ok((await readFile(path.join(fx.state, "installation.json"), "utf8")).length > 0);
    assert.equal(await readFile(openCodeConfigFile(fx.root), "utf8"), fx.snapshot.openCode, "OpenCode is restored");
    assert.ok(await exists(fx.state), "the canonical state survives");
    const declaration = JSON.parse(await readFile(settingsFile, "utf8"));
    assert.ok(declaration.extraKnownMarketplaces?.[marketplace], "the declaration is restored");
  });
});

test("read-only commands stay available while a configuration sits inside state", async () => {
  await withHarnessEnvironment(async (environment) => {
    const fx = await dualInstall(environment);
    const inside = path.join(fx.state, "router.json");
    const document = `${JSON.stringify({ schemaVersion: 1, sources: [] }, null, 2)}\n`;
    // Owner-only, so the placement (not the mode) is the subject: a broad mode
    // here would be a genuine confidentiality drift and `check` would say so.
    await writeFile(inside, document, { mode: 0o600 });

    // The invariant is scoped to mutating operations: diagnostics and routing
    // still work so a blocked user can inspect the installation.
    const checked = await checkOperation({ root: fx.root, config: ".skill-router/router.json", claudeExec: fx.runner });
    assert.equal(checked.healthy, true, JSON.stringify(checked.diagnostics));
    const routed = await routeOperation("release", { root: fx.root, config: ".skill-router/router.json" });
    assert.equal(routed.outcome, "select");
    assert.equal(await readFile(inside, "utf8"), document, "read-only commands never write");
    assert.equal((await readFile(path.join(fx.root, ".skill-router.json"), "utf8")), fx.snapshot.router);
  });
});

/* ------------------------------------------------------------------ *
 * Phase 7 — stable request-spool integration
 *
 * The stable spool lives at `<resolved-root>/.skill-router-requests` (global:
 * `<home>/.local/share/skill-router-requests`), entirely outside router state,
 * so every assertion below can prove the spool and the state directory are
 * independent artifacts.
 * ------------------------------------------------------------------ */

const TOKEN = "0123456789abcdef0123456789abcdef";
const TOKEN_B = "fedcba9876543210fedcba9876543210";
const posix = process.platform !== "win32";

function spoolOf(root) {
  return path.join(root, ".skill-router-requests");
}

async function requestNames(directory) {
  try {
    return (await readdir(directory)).sort();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function modeOf(target) {
  return (await lstat(target)).mode & 0o777;
}

test("init, add, and scan establish the exact owner-private spool before the journal", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const spool = spoolOf(environment.root);

    // A failing init (a disabled workflow step) never reaches the transaction,
    // so it must never leave an empty spool behind either.
    const configFile = path.join(environment.root, ".skill-router.json");
    await writeFile(
      configFile,
      `${JSON.stringify({ schemaVersion: 2, routing: { allowSequences: true }, workflows: { w: { invocation: "automatic", steps: [{ skill: "missing" }] } } }, null, 2)}\n`,
    );
    await assert.rejects(() => initOperation({ root: environment.root }), /missing/);
    assert.equal(await exists(spool), false, "a pre-transaction failure creates no spool");

    // A real init establishes it: exact 0700 directory, owner-only marker.
    await rm(configFile);
    const init = await initOperation({ root: environment.root });
    assert.equal(init.command, "init");
    assert.ok(await exists(spool), "init creates the stable spool");
    if (posix) {
      assert.equal(await modeOf(spool), REQUEST_SPOOL_MODE, "the spool is exactly 0700");
      assert.equal(await modeOf(path.join(spool, REQUEST_MARKER_NAME)), 0o600, "the marker is owner-only");
    }
    assert.deepEqual(await requestNames(spool), [REQUEST_MARKER_NAME], "the spool starts empty but marked");

    // `add` validates rather than recreating, and `scan` keeps it healthy.
    const managed = path.join(init.skillsDirectory, "release", "SKILL.md");
    assert.ok(await exists(managed));
    await addOperation("release", { root: environment.root, alias: "ship" });
    assert.deepEqual(await requestNames(spool), [REQUEST_MARKER_NAME]);
    await scanOperation({ root: environment.root });
    assert.deepEqual(await requestNames(spool), [REQUEST_MARKER_NAME]);
    assert.equal((await checkOperation({ root: environment.root })).healthy, true);
  });
});

test("the global spool is created under the router home with safe parents", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    // Remove any `.local/share` the fixture may have created so the parents
    // must be established by the spool setup itself.
    await rm(path.join(environment.home, ".local"), { recursive: true, force: true });

    const init = await initOperation({ root: environment.root, global: true });
    assert.equal(init.scope, "global");
    const spool = path.join(environment.home, ".local", "share", "skill-router-requests");
    assert.ok(await exists(spool), "the global spool lives under the router home");
    if (posix) {
      assert.equal(await modeOf(spool), REQUEST_SPOOL_MODE, "the global spool is exactly 0700");
      assert.equal(await modeOf(path.join(spool, REQUEST_MARKER_NAME)), 0o600);
    }
    // The project root gained no spool: global and project scopes never share one.
    assert.equal(await exists(spoolOf(environment.root)), false);
    assert.deepEqual(await requestNames(spool), [REQUEST_MARKER_NAME]);
  });
});

test("a nested cwd resolves the ancestor's spool and never the nested directory's", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    await initOperation({ root: environment.root });
    const nested = path.join(environment.root, "a", "b");
    await mkdir(nested, { recursive: true });

    // Routing from the nested cwd consumes from the resolved ancestor spool.
    const context = await createContext({ root: nested });
    assert.equal(context.root, environment.root, "the ancestor installation is resolved");
    await writeFile(path.join(context.requestDirectory, `${TOKEN}.txt`), "publish releases", { mode: 0o600 });
    const routed = await routeFileOperation(TOKEN, { root: nested });
    assert.equal(routed.skillId, "release");
    assert.deepEqual(await requestNames(context.requestDirectory), [REQUEST_MARKER_NAME]);
    assert.equal(await exists(spoolOf(nested)), false, "no spool is created in the nested directory");
  });
});

test("a dry run inspects the spool but never creates, adopts, or chmods it", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const spool = spoolOf(environment.root);
    const dry = await initOperation({ root: environment.root, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(await exists(spool), false, "dry-run creates no spool");

    // An adoptable (empty, unmarked, owned) directory is a valid planned state
    // and is left byte-for-byte untouched by the dry run.
    await mkdir(spool);
    if (posix) await chmod(spool, 0o755);
    const modeBefore = posix ? await modeOf(spool) : null;
    const second = await initOperation({ root: environment.root, dryRun: true });
    assert.equal(second.dryRun, true);
    assert.deepEqual(await requestNames(spool), [], "dry-run adopts nothing");
    if (posix) assert.equal(await modeOf(spool), modeBefore, "dry-run never chmods");

    // A repairable mode drift on a marked spool is also only planned.
    await setupRequestSpool(spool);
    if (posix) {
      await chmod(spool, 0o755);
      const drift = await initOperation({ root: environment.root, dryRun: true });
      assert.equal(drift.dryRun, true);
      assert.equal(await modeOf(spool), 0o755, "dry-run leaves the drift for the real run");
      const repaired = await initOperation({ root: environment.root });
      assert.equal(repaired.dryRun, false);
      assert.equal(await modeOf(spool), REQUEST_SPOOL_MODE, "the real run normalizes the mode");
    }
  });
});

test("an unsafe spool refuses init, add, and scan before any journal, config, state, or Claude call", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const runner = createFakeClaudeRunner();
    const init = await initOperation({ root: environment.root, harness: "all", claudeExec: runner });
    const spool = spoolOf(environment.root);
    const configBefore = await readFile(path.join(environment.root, ".skill-router.json"), "utf8");
    const stateBefore = await digestTree(path.join(environment.root, ".skill-router"));
    const journalFile = path.join(environment.root, ".skill-router-control", "transaction.json");
    runner.log.length = 0;

    const scenarios = [
      // A symlinked spool is never followed.
      async () => {
        const elsewhere = path.join(environment.root, "elsewhere");
        await mkdir(elsewhere);
        await rm(spool, { recursive: true, force: true });
        await symlink(elsewhere, spool);
        return "REQUEST-SPOOL-TYPE";
      },
      // A nonempty unmarked directory is never adopted.
      async () => {
        await rm(spool, { recursive: true, force: true });
        await mkdir(spool);
        await writeFile(path.join(spool, "stranger.txt"), "keep", { mode: 0o600 });
        return "REQUEST-SPOOL-UNMARKED";
      },
      // An unattributable marker is refused.
      async () => {
        await rm(spool, { recursive: true, force: true });
        await mkdir(spool);
        if (posix) await chmod(spool, REQUEST_SPOOL_MODE);
        await symlink(path.join(environment.root, "nope"), path.join(spool, REQUEST_MARKER_NAME));
        return "REQUEST-SPOOL-MARKER";
      },
    ];

    for (const scenario of scenarios) {
      const expected = await scenario();
      for (const run of [
        () => initOperation({ root: environment.root, harness: "all", claudeExec: runner }),
        () => scanOperation({ root: environment.root, harness: "all", claudeExec: runner }),
      ]) {
        await assert.rejects(run, (error) => {
          assert.equal(error.code, expected, `${error.code} should be ${expected}`);
          assert.equal(error.name, "RequestSpoolError", "the fixed request-spool error set is used");
          assert.ok(!error.message.includes(environment.root), "no path in the refusal");
          assert.ok(!error.message.includes(TOKEN), "no token in the refusal");
          return true;
        });
      }
      assert.equal(await exists(journalFile), false, "no journal is created by a refused mutation");
      assert.equal(await readFile(path.join(environment.root, ".skill-router.json"), "utf8"), configBefore);
      assert.deepEqual(await digestTree(path.join(environment.root, ".skill-router")), stateBefore);
      assert.equal(mutationsOf(runner).length, 0, "no Claude mutation runs");
      assert.equal(init.fingerprint.length > 0, true, "the pre-scenario fingerprint was captured");
    }

    // Restore a healthy spool and prove the installation is still coherent.
    await rm(spool, { recursive: true, force: true });
    await setupRequestSpool(spool);
    assert.equal((await checkOperation({ root: environment.root, claudeExec: runner })).healthy, true);
    assert.equal((await routeOperation("release", { root: environment.root })).skillId, "release");
  });
});

test("a pending legacy request blocks init, add, and scan before any artifact", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    await initOperation({ root: environment.root });
    const state = path.join(environment.root, ".skill-router");
    const legacy = path.join(state, "requests");
    const spool = spoolOf(environment.root);
    const configBefore = await readFile(path.join(environment.root, ".skill-router.json"), "utf8");
    await mkdir(legacy);
    if (posix) await chmod(legacy, REQUEST_SPOOL_MODE);

    const shapes = [
      // A public ingress entry.
      async () => {
        await writeFile(path.join(legacy, `${TOKEN}.txt`), "pending body", { mode: 0o600 });
        return "REQUEST-LEGACY-PENDING";
      },
      // A claim left by an interrupted consumer.
      async () => {
        await writeFile(path.join(legacy, `.claim.${TOKEN}.${"a".repeat(32)}`), "claimed body", { mode: 0o600 });
        return "REQUEST-LEGACY-PENDING";
      },
      // An unknown entry that is never swept away.
      async () => {
        await writeFile(path.join(legacy, "operator-note.txt"), "not a request", { mode: 0o600 });
        return "REQUEST-LEGACY-PENDING";
      },
      // A malformed token-shaped name.
      async () => {
        await writeFile(path.join(legacy, "not-a-token.txt"), "malformed", { mode: 0o600 });
        return "REQUEST-LEGACY-PENDING";
      },
    ];

    for (const shape of shapes) {
      const expected = await shape();
      const before = await requestNames(legacy);
      // The pending entry lives inside state, so the digest is captured after
      // it is written: the refusals below must leave state byte-identical.
      const stateWithEntry = await digestTree(state);
      for (const run of [
        () => initOperation({ root: environment.root }),
        () => scanOperation({ root: environment.root }),
        () => initOperation({ root: environment.root, dryRun: true }),
      ]) {
        await assert.rejects(run, (error) => {
          assert.equal(error.code, expected);
          assert.ok(!error.message.includes(environment.root), "no path in the refusal");
          assert.ok(!error.message.includes("pending body"), "no body in the refusal");
          assert.ok(!error.message.includes(TOKEN), "no token in the refusal");
          return true;
        });
      }
      assert.deepEqual(await requestNames(legacy), before, "every legacy entry is preserved");
      assert.equal(await readFile(path.join(environment.root, ".skill-router.json"), "utf8"), configBefore);
      assert.deepEqual(await digestTree(state), stateWithEntry, "state is byte-identical");
      assert.deepEqual(await requestNames(spool), [REQUEST_MARKER_NAME], "no spool entry is created");
      // Clear for the next shape.
      for (const name of await requestNames(legacy)) {
        if (name !== REQUEST_MARKER_NAME) await rm(path.join(legacy, name));
      }
    }

    // An unsafe legacy directory is refused too, and nothing inside it is read.
    await rm(legacy, { recursive: true, force: true });
    await mkdir(legacy);
    if (posix) await chmod(legacy, 0o755);
    await writeFile(path.join(legacy, `${TOKEN}.txt`), "exposed", { mode: 0o600 });
    const unsafeState = await digestTree(state);
    await assert.rejects(() => initOperation({ root: environment.root }), (error) => {
      assert.equal(error.code, "REQUEST-LEGACY-UNSAFE");
      return true;
    });
    assert.equal(await readFile(path.join(legacy, `${TOKEN}.txt`), "utf8"), "exposed", "the entry survives");
    assert.deepEqual(await digestTree(state), unsafeState);

    // Draining the legacy directory unblocks mutations again.
    await rm(legacy, { recursive: true, force: true });
    const rescan = await scanOperation({ root: environment.root });
    assert.equal(rescan.command, "scan");
    assert.equal((await checkOperation({ root: environment.root })).healthy, true);
  });
});

test("an empty legacy directory is an accepted planned state", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    await initOperation({ root: environment.root });
    const legacy = path.join(environment.root, ".skill-router", "requests");
    await mkdir(legacy);
    if (posix) await chmod(legacy, REQUEST_SPOOL_MODE);

    const rescan = await scanOperation({ root: environment.root });
    assert.equal(rescan.command, "scan", "an empty legacy directory never blocks a mutation");
    const dry = await initOperation({ root: environment.root, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal((await checkOperation({ root: environment.root })).healthy, true, JSON.stringify((await checkOperation({ root: environment.root })).diagnostics));
  });
});

test("token routing consumes the stable spool and falls back to a drained legacy directory", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    await initOperation({ root: environment.root });
    const spool = spoolOf(environment.root);

    // Ordinary stable consumption.
    await writeFile(path.join(spool, `${TOKEN}.txt`), "publish releases", { mode: 0o600 });
    const stable = await routeFileOperation(TOKEN, { root: environment.root });
    assert.equal(stable.skillId, "release");
    assert.equal(Object.hasOwn(stable, "request"), false, "no request field is returned");
    assert.deepEqual(await requestNames(spool), [REQUEST_MARKER_NAME], "the claim is removed");

    // Legacy fallback: the harness wrote into `<state>/requests`, which the
    // router drains only when the stable spool has no entry for the token.
    const legacy = path.join(environment.root, ".skill-router", "requests");
    await mkdir(legacy);
    if (posix) await chmod(legacy, REQUEST_SPOOL_MODE);
    await writeFile(path.join(legacy, `${TOKEN}.txt`), "publish releases", { mode: 0o600 });
    const legacyRouted = await routeFileOperation(TOKEN, { root: environment.root });
    assert.equal(legacyRouted.skillId, "release");
    assert.deepEqual(await requestNames(legacy), [], "the legacy entry is drained");
    assert.deepEqual(await requestNames(spool), [REQUEST_MARKER_NAME], "legacy consumption creates no stable entry");

    // A crash-style claim in the stable spool resumes and is consumed once.
    const claim = `.claim.${TOKEN}.${"b".repeat(32)}`;
    await writeFile(path.join(spool, claim), "publish releases", { mode: 0o644 });
    const resumed = await routeFileOperation(TOKEN, { root: environment.root });
    assert.equal(resumed.skillId, "release");
    assert.deepEqual(await requestNames(spool), [REQUEST_MARKER_NAME], "the interrupted claim is consumed exactly once");

    // A token present in both the stable and legacy directories is ambiguity:
    // nothing is claimed, read, or removed from either location.
    await writeFile(path.join(spool, `${TOKEN_B}.txt`), "publish releases", { mode: 0o600 });
    await writeFile(path.join(legacy, `${TOKEN_B}.txt`), "publish releases", { mode: 0o600 });
    await assert.rejects(() => routeFileOperation(TOKEN_B, { root: environment.root }), (error) => {
      assert.equal(error.code, "REQUEST-AMBIGUOUS");
      assert.equal(error.name, "RequestSpoolError");
      assert.ok(!error.message.includes(TOKEN_B), "the token is never echoed");
      assert.ok(!error.message.includes(environment.root), "no path is echoed");
      return true;
    });
    assert.equal(await readFile(path.join(spool, `${TOKEN_B}.txt`), "utf8"), "publish releases", "the stable entry survives");
    assert.equal(await readFile(path.join(legacy, `${TOKEN_B}.txt`), "utf8"), "publish releases", "the legacy entry survives");
    assert.equal(await exists(path.join(spool, `.claim.${TOKEN_B}.`)) === false, true, "no claim was started");

    // Draining the legacy side resolves the ambiguity and routes normally.
    await rm(path.join(legacy, `${TOKEN_B}.txt`));
    const resolved = await routeFileOperation(TOKEN_B, { root: environment.root });
    assert.equal(resolved.skillId, "release");
    assert.deepEqual(await requestNames(spool), [REQUEST_MARKER_NAME]);
  });
});

test("pending journal, live lock, missing registry, and stale policy all refuse before setup or claim", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    await initOperation({ root: environment.root });
    const spool = spoolOf(environment.root);
    const requestFile = path.join(spool, `${TOKEN}.txt`);
    const request = "publish releases";
    const seedRequest = async () => {
      await rm(spool, { recursive: true, force: true });
      await setupRequestSpool(spool);
      await writeFile(requestFile, request, { mode: 0o600 });
    };
    const assertUntouched = async (label) => {
      assert.equal(await readFile(requestFile, "utf8"), request, `${label} leaves the request bytes unchanged`);
      const names = await requestNames(spool);
      assert.ok(names.includes(`${TOKEN}.txt`), `${label} never claims the public entry`);
      assert.equal(names.some((name) => name.startsWith(".claim.")), false, `${label} creates no claim`);
    };

    // Missing registry: an uninitialized root refuses before the spool is set up.
    const cold = path.join(environment.directory, "cold");
    const coldSpool = spoolOf(cold);
    await mkdir(coldSpool, { recursive: true });
    const coldFile = path.join(coldSpool, `${TOKEN}.txt`);
    await writeFile(coldFile, request, { mode: 0o600 });
    await assert.rejects(() => routeFileOperation(TOKEN, { root: cold }), /not initialized/);
    assert.equal(await readFile(coldFile, "utf8"), request, "a missing registry never touches the request");
    assert.equal(await exists(path.join(coldSpool, REQUEST_MARKER_NAME)), false, "no spool is established");

    // Pending journal: the controlled read refuses before the operation runs.
    // The two-fault pattern (stage build + recovery files) leaves a real
    // pending journal behind, exactly how the CLI suite seeds one.
    await seedRequest();
    const journalFile = path.join(environment.root, ".skill-router-control", "transaction.json");
    const previousStep = journaledTransactionInternals.onStep;
    journaledTransactionInternals.onStep = async (name) => {
      if (name === "stage:build" || name === "recovery:files") throw new Error(`stop at ${name}`);
    };
    try {
      await initOperation({ root: environment.root }).catch(() => {});
    } finally {
      journaledTransactionInternals.onStep = previousStep;
    }
    assert.ok(await exists(journalFile), "a pending journal is seeded");
    await assert.rejects(
      () => routeFileOperation(TOKEN, { root: environment.root }),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
    await assertUntouched("a pending journal");
    await rm(journalFile, { force: true });

    // Live lock: the read times out before the operation runs.
    await seedRequest();
    const paths = controlPaths({ root: environment.root });
    const lease = await acquireMutationLock(paths, { timeoutMs: 5000, heartbeatMs: 200 });
    try {
      await assert.rejects(
        () => routeFileOperation(TOKEN, { root: environment.root, lockTimeout: 0 }),
        (error) => error.code === "MUTATION_LOCKED",
      );
      await assertUntouched("a live lock");
    } finally {
      await lease.release();
    }
  });
});

test("a stale policy refuses token routing before the spool is set up or the request claimed", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const configFile = path.join(environment.root, ".skill-router.json");
    await writeSchemaV2Config(configFile, { sources: [] });
    await initOperation({ root: environment.root });
    const spool = spoolOf(environment.root);
    const requestFile = path.join(spool, `${TOKEN}.txt`);
    const request = "publish releases";
    await writeFile(requestFile, request, { mode: 0o600 });

    // A schema v2 policy edit makes the registry stale; token routing refuses
    // on the policy check before it ever touches the spool or the request.
    const config = JSON.parse(await readFile(configFile, "utf8"));
    config.aliases = { "ship it": "release" };
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`);
    await assert.rejects(() => routeFileOperation(TOKEN, { root: environment.root }), /policy is stale/);
    assert.equal(await readFile(requestFile, "utf8"), request, "a stale policy leaves the request bytes unchanged");
    const names = await requestNames(spool);
    assert.ok(names.includes(`${TOKEN}.txt`), "a stale policy never claims the public entry");
    assert.equal(names.some((name) => name.startsWith(".claim.")), false, "a stale policy creates no claim");
    assert.deepEqual(names, [REQUEST_MARKER_NAME, `${TOKEN}.txt`].sort());

    // Positional routing refuses identically, so both transports agree.
    await assert.rejects(() => routeOperation(request, { root: environment.root }), /policy is stale/);
    assert.deepEqual(await requestNames(spool), names, "positional routing never touches the spool");
  });
});

test("check reports the spool and legacy matrix read-only, without creating or repairing anything", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    await initOperation({ root: environment.root });
    const spool = spoolOf(environment.root);
    const legacy = path.join(environment.root, ".skill-router", "requests");
    const diagnosticOf = (checked, code) => checked.diagnostics.find((item) => item.code === code);

    // A ready spool is healthy and produces no request diagnostics.
    const healthy = await checkOperation({ root: environment.root });
    assert.equal(healthy.healthy, true, JSON.stringify(healthy.diagnostics));
    assert.equal(diagnosticOf(healthy, "request-spool-invalid"), undefined);
    assert.equal(diagnosticOf(healthy, "legacy-requests-pending"), undefined);

    // An absent spool is unhealthy, and check never creates it.
    await rm(spool, { recursive: true, force: true });
    const absent = await checkOperation({ root: environment.root });
    assert.equal(absent.healthy, false);
    const absentDiagnostic = diagnosticOf(absent, "request-spool-invalid");
    assert.ok(absentDiagnostic, "an absent spool is reported");
    assert.match(absentDiagnostic.message, /run skill-router init/);
    assert.ok(!absentDiagnostic.message.includes(environment.root), "no path in the diagnostic");
    assert.equal(await exists(spool), false, "check creates no spool");

    // An adoptable (empty unmarked) directory is unhealthy and untouched.
    await mkdir(spool);
    if (posix) await chmod(spool, 0o755);
    const adoptable = await checkOperation({ root: environment.root });
    assert.equal(adoptable.healthy, false);
    assert.ok(diagnosticOf(adoptable, "request-spool-invalid"));
    assert.deepEqual(await requestNames(spool), [], "check adopts nothing");
    if (posix) assert.equal(await modeOf(spool), 0o755, "check never chmods");

    // A marked but group-readable spool is unhealthy and left drifted.
    await setupRequestSpool(spool);
    if (posix) {
      await chmod(spool, 0o755);
      const drifted = await checkOperation({ root: environment.root });
      assert.equal(drifted.healthy, false);
      assert.ok(diagnosticOf(drifted, "request-spool-invalid"));
      assert.equal(await modeOf(spool), 0o755, "check leaves the drift for init");
    }

    // Back to healthy, then a pending legacy request is reported separately.
    await rm(spool, { recursive: true, force: true });
    await setupRequestSpool(spool);
    await mkdir(legacy);
    if (posix) await chmod(legacy, REQUEST_SPOOL_MODE);
    await writeFile(path.join(legacy, `${TOKEN}.txt`), "pending", { mode: 0o600 });
    const pending = await checkOperation({ root: environment.root });
    assert.equal(pending.healthy, false);
    const pendingDiagnostic = diagnosticOf(pending, "legacy-requests-pending");
    assert.ok(pendingDiagnostic, "pending legacy requests are reported");
    assert.match(pendingDiagnostic.message, /route --request-token/);
    assert.ok(!pendingDiagnostic.message.includes(TOKEN), "no token in the diagnostic");
    assert.ok(!pendingDiagnostic.message.includes(environment.root), "no path in the diagnostic");
    assert.equal(await readFile(path.join(legacy, `${TOKEN}.txt`), "utf8"), "pending", "check never reads or deletes it");

    // An unsafe legacy directory is reported distinctly.
    await chmod(legacy, 0o755);
    const unsafe = await checkOperation({ root: environment.root });
    assert.equal(unsafe.healthy, false);
    assert.ok(diagnosticOf(unsafe, "legacy-request-spool-invalid"), "an unsafe legacy directory is reported");
    assert.equal(await readFile(path.join(legacy, `${TOKEN}.txt`), "utf8"), "pending");

    // An empty legacy directory is healthy again (mode restored to private).
    await rm(path.join(legacy, `${TOKEN}.txt`));
    if (posix) await chmod(legacy, REQUEST_SPOOL_MODE);
    const drained = await checkOperation({ root: environment.root });
    assert.equal(drained.healthy, true, JSON.stringify(drained.diagnostics));
  });
});

test("uninstall preflights the spool before any probe and reports its fate truthfully", async () => {
  await withHarnessEnvironment(async (environment) => {
    const fx = await dualInstall(environment);
    const spool = spoolOf(fx.root);
    assert.deepEqual(await requestNames(spool), [REQUEST_MARKER_NAME], "init leaves an empty spool");

    // A dry run proves the spool empty and reports the plan without touching it.
    const dry = await uninstallOperation({ root: fx.root, dryRun: true, claudeExec: fx.runner });
    assert.equal(dry.status, "would-remove");
    assert.equal(dry.requestSpool, "would-remove");
    assert.ok(await exists(spool), "dry-run keeps the spool");
    assert.deepEqual(await requestNames(spool), [REQUEST_MARKER_NAME]);

    // A real uninstall removes the empty spool only after state is gone.
    const removed = await uninstallOperation({ root: fx.root, claudeExec: fx.runner });
    assert.equal(removed.status, "removed");
    assert.equal(removed.requestSpool, "removed");
    assert.equal(await exists(spool), false, "the empty spool is removed with the installation");
    assert.equal(await exists(fx.state), false, "state is removed too");

    // Absent state is idempotent: a real uninstall still clears an empty spool,
    // and a repeated run reports the spool absent without recreating anything.
    await initOperation({ root: fx.root, harness: "all", claudeExec: fx.runner });
    await rm(fx.state, { recursive: true, force: true });
    const cleared = await uninstallOperation({ root: fx.root, claudeExec: fx.runner });
    assert.equal(cleared.status, "already-absent");
    assert.equal(cleared.requestSpool, "removed", "already-absent state still removes a proven-empty spool");
    assert.equal(await exists(spool), false);
    const again = await uninstallOperation({ root: fx.root, dryRun: true, claudeExec: fx.runner });
    assert.equal(again.requestSpool, "absent");
    assert.equal(await exists(spool), false, "a dry run creates nothing");
  });
});

test("a pending request or an unsafe spool refuses uninstall before any probe and preserves everything", async () => {
  await withHarnessEnvironment(async (environment) => {
    const fx = await dualInstall(environment);
    const spool = spoolOf(fx.root);
    const requestFile = path.join(spool, `${TOKEN}.txt`);
    await writeFile(requestFile, "publish releases", { mode: 0o600 });
    fx.runner.log.length = 0;

    // Nonempty spool: refuse generically, preserve the entry, probe nothing.
    await assert.rejects(() => uninstallOperation({ root: fx.root, claudeExec: fx.runner }), (error) => {
      assert.equal(error.code, "REQUEST-SPOOL-NOT-EMPTY");
      assert.equal(error.name, "RequestSpoolError");
      assert.ok(!error.message.includes(TOKEN), "no token echoed");
      assert.ok(!error.message.includes(fx.root), "no path echoed");
      return true;
    });
    assert.equal(await readFile(requestFile, "utf8"), "publish releases", "the request survives");
    assert.deepEqual(fx.runner.log, [], "no Claude probe runs before the refusal");
    assert.equal(mutationsOf(fx.runner).length, 0);
    assert.ok(await exists(fx.state), "state is untouched");

    // An unknown entry also refuses uninstall and is preserved.
    await rm(requestFile);
    const stranger = path.join(spool, "operator-note.txt");
    await writeFile(stranger, "not a request", { mode: 0o600 });
    await assert.rejects(() => uninstallOperation({ root: fx.root, claudeExec: fx.runner }), (error) => {
      assert.equal(error.code, "REQUEST-SPOOL-NOT-EMPTY");
      return true;
    });
    assert.equal(await readFile(stranger, "utf8"), "not a request");
    assert.deepEqual(fx.runner.log, [], "still no Claude probe");
    await rm(stranger);

    // An unattributable spool refuses too.
    await rm(spool, { recursive: true, force: true });
    await mkdir(spool);
    await writeFile(path.join(spool, "stranger.txt"), "keep", { mode: 0o600 });
    await assert.rejects(() => uninstallOperation({ root: fx.root, claudeExec: fx.runner }), (error) => {
      assert.equal(error.code, "REQUEST-SPOOL-UNMARKED");
      return true;
    });
    assert.equal(await readFile(path.join(spool, "stranger.txt"), "utf8"), "keep");
    assert.deepEqual(fx.runner.log, []);

    // A pending legacy request refuses uninstall because it lives inside state.
    await rm(spool, { recursive: true, force: true });
    await setupRequestSpool(spool);
    const legacy = path.join(fx.state, "requests");
    await mkdir(legacy);
    if (posix) await chmod(legacy, REQUEST_SPOOL_MODE);
    await writeFile(path.join(legacy, `${TOKEN}.txt`), "legacy pending", { mode: 0o600 });
    await assert.rejects(() => uninstallOperation({ root: fx.root, claudeExec: fx.runner }), (error) => {
      assert.equal(error.code, "REQUEST-LEGACY-PENDING");
      assert.ok(!error.message.includes(TOKEN), "no token echoed");
      return true;
    });
    assert.equal(await readFile(path.join(legacy, `${TOKEN}.txt`), "utf8"), "legacy pending", "legacy bytes survive");
    assert.deepEqual(fx.runner.log, [], "no Claude probe runs for a pending legacy request");
    assert.ok(await exists(fx.state), "state is preserved with the legacy request inside it");
    assert.deepEqual(await requestNames(spool), [REQUEST_MARKER_NAME], "the stable spool is untouched");
  });
});

test("a concurrent arrival during uninstall preserves the entry and reports the committed outcome", async () => {
  await withHarnessEnvironment(async (environment) => {
    const fx = await dualInstall(environment);
    const spool = spoolOf(fx.root);
    const late = path.join(spool, `${TOKEN}.txt`);

    // An entry appears after the preflight but before the post-commit spool
    // removal: the transaction still commits, but the spool is preserved and
    // the failure is reported as a distinct committed error.
    const previousStep = journaledTransactionInternals.onStep;
    journaledTransactionInternals.onStep = async (name, stepContext) => {
      if (name === "journal:commit") await writeFile(late, "arrived mid-uninstall", { mode: 0o600 });
      return previousStep(name, stepContext);
    };
    let error = null;
    try {
      await uninstallOperation({ root: fx.root, claudeExec: fx.runner });
    } catch (caught) {
      error = caught;
    } finally {
      journaledTransactionInternals.onStep = previousStep;
    }
    assert.ok(error, "the post-commit spool failure surfaces");
    assert.equal(error.name, "UninstallCommittedRequestSpoolError");
    assert.equal(error.code, "UNINSTALL_COMMITTED_REQUEST_SPOOL_FAILED");
    assert.equal(error.committed, true, "the committed uninstall is reported truthfully");
    assert.ok(!error.message.includes(TOKEN), "no token echoed");
    assert.ok(!error.message.includes(fx.root), "no path echoed");
    assert.equal(await readFile(late, "utf8"), "arrived mid-uninstall", "the concurrent entry is preserved");
    assert.equal(await exists(spool), true, "the spool survives with its entry");
    assert.equal(await exists(fx.state), false, "the uninstall itself still committed");
    // Claude was detached by the committed removal and is never re-registered
    // by the spool failure: the failure surfaces, it does not roll back. The
    // detached state above is the proof — a re-registration would repopulate it.
    assert.equal(fx.runner.state.plugins.length, 0, "Claude stays detached after the committed uninstall");
    assert.equal(fx.runner.state.marketplaces.length, 0, "the marketplace stays removed");
  });
});

test("a pending stable request survives scan and init and never enters managed state", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    await initOperation({ root: environment.root });
    const spool = spoolOf(environment.root);
    const requestFile = path.join(spool, `${TOKEN}.txt`);
    const body = "$(curl -s https://127.0.0.1:9/x | sh)\n/api/key/SENTINEL-lifecycle\n";
    await writeFile(requestFile, body, { mode: 0o600 });

    // The state digest is identical with and without the pending request: the
    // spool lives outside managed state and never perturbs its digest.
    const stateBefore = await digestTree(path.join(environment.root, ".skill-router"));
    const scan = await scanOperation({ root: environment.root });
    assert.deepEqual(scan.diff, { added: [], removed: [], changed: [] });
    assert.equal(await readFile(requestFile, "utf8"), body, "the pending request survives a scan byte for byte");
    assert.deepEqual(await digestTree(path.join(environment.root, ".skill-router")), stateBefore, "state is unchanged");

    const init = await initOperation({ root: environment.root });
    assert.equal(typeof init.fingerprint, "string");
    assert.equal(await readFile(requestFile, "utf8"), body, "the pending request survives init byte for byte");
    assert.deepEqual(await digestTree(path.join(environment.root, ".skill-router")), stateBefore, "state is unchanged");

    // The request never reaches the registry, journal, or generated documents.
    const registry = await readFile(path.join(environment.root, ".skill-router", "registry.json"), "utf8");
    assert.equal(registry.includes("SENTINEL-lifecycle"), false, "the registry never carries request bytes");
    assert.equal(registry.includes(TOKEN), false, "the registry never carries the token");
    const managed = await readFile(path.join(init.skillsDirectory, "skill-router", "SKILL.md"), "utf8");
    assert.equal(managed.includes("SENTINEL-lifecycle"), false, "generated documents never carry request bytes");

    // Routing it afterwards consumes it exactly once, proving it stayed live.
    const routed = await routeFileOperation(TOKEN, { root: environment.root });
    assert.equal(routed.command, "route");
    assert.deepEqual(await requestNames(spool), [REQUEST_MARKER_NAME]);
  });
});

test("recovery forward and rollback leave the stable spool byte-identical", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    await initOperation({ root: environment.root });
    const spool = spoolOf(environment.root);
    const requestFile = path.join(spool, `${TOKEN}.txt`);
    await writeFile(requestFile, "publish releases", { mode: 0o600 });
    const spoolBefore = await digestTree(spool);

    // Rollback: a fault before the commit rolls the transaction back, and the
    // spool (with its pending request) is byte-identical afterwards.
    const previousStep = journaledTransactionInternals.onStep;
    journaledTransactionInternals.onStep = async (name) => {
      if (name === "stage:build") throw new Error("stop before commit");
    };
    try {
      await scanOperation({ root: environment.root }).catch(() => {});
    } finally {
      journaledTransactionInternals.onStep = previousStep;
    }
    assert.deepEqual(await digestTree(spool), spoolBefore, "rollback leaves the spool byte-identical");
    assert.equal(await readFile(requestFile, "utf8"), "publish releases");

    // Forward: a fault after the commit leaves a committed journal; recovery
    // finishes it forward and the spool is still byte-identical.
    journaledTransactionInternals.onStep = async (name) => {
      if (name === "cleanup:journal") throw new Error("stop after commit");
    };
    try {
      await scanOperation({ root: environment.root }).catch(() => {});
    } finally {
      journaledTransactionInternals.onStep = previousStep;
    }
    assert.deepEqual(await digestTree(spool), spoolBefore, "a committed journal leaves the spool untouched");
    const recovered = await recoverOperation({ root: environment.root });
    assert.ok(["recovered", "clean"].includes(recovered.status), `recovery completed: ${recovered.status}`);
    assert.deepEqual(await digestTree(spool), spoolBefore, "forward recovery leaves the spool byte-identical");
    assert.equal(await readFile(requestFile, "utf8"), "publish releases");

    // The recovered installation still routes the surviving request once.
    const routed = await routeFileOperation(TOKEN, { root: environment.root });
    assert.equal(routed.command, "route");
    assert.deepEqual(await requestNames(spool), [REQUEST_MARKER_NAME]);
  });
});

test("the old state-directory request path is never consumed, only the stable spool", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    await initOperation({ root: environment.root });
    const legacy = path.join(environment.root, ".skill-router", "requests");
    await mkdir(legacy);
    if (posix) await chmod(legacy, REQUEST_SPOOL_MODE);
    // A request left only in the legacy location by a pre-Phase-7 harness is
    // still drained, but only because the stable spool has no entry: the two
    // locations can never both claim a token.
    await writeFile(path.join(legacy, `${TOKEN}.txt`), "publish releases", { mode: 0o600 });
    const routed = await routeFileOperation(TOKEN, { root: environment.root });
    assert.equal(routed.skillId, "release");
    assert.deepEqual(await requestNames(legacy), []);

    // A second, different token in the legacy directory is still refused when
    // the stable spool also carries it — the stable spool is authoritative.
    await writeFile(path.join(legacy, `${TOKEN_B}.txt`), "publish releases", { mode: 0o600 });
    await writeFile(path.join(spoolOf(environment.root), `${TOKEN_B}.txt`), "publish releases", { mode: 0o600 });
    await assert.rejects(() => routeFileOperation(TOKEN_B, { root: environment.root }), (error) => {
      assert.equal(error.code, "REQUEST-AMBIGUOUS");
      return true;
    });
  });
});

/* ------------------------------------------------------------------ *
 * Phase 7 — generated-instruction privacy and state confidentiality
 *
 * The stable spool path is owner-private routing data: it may appear in the
 * generated OpenCode/Claude instructions and in in-memory plans, never in an
 * operation result, a diagnostic, a journal, or control metadata. Confidential
 * state (exact 0700/0600) is silent in `check`; drift is one bounded error.
 * ------------------------------------------------------------------ */

/** Every regular file below a directory, for leak scans. */
async function allFiles(directory) {
  const found = [];
  const walk = async (current) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) found.push(absolute);
    }
  };
  await walk(directory);
  return found;
}

/** Rewrites an installed state tree into legacy owner-safe broad modes. */
async function broadenStateTree(directory) {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await broadenStateTree(absolute);
    else await chmod(absolute, 0o644);
  }
}

test("generated OpenCode and Claude instructions carry the exact stable spool; results never echo it", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const state = path.join(environment.root, ".skill-router");
    const projectSpool = spoolOf(environment.root);
    const runner = createFakeClaudeRunner();

    // All harnesses first, so both generated instruction sets exist: the
    // OpenCode and Claude routers both point at the exact stable spool, and
    // the fingerprint stays consistent because `check` plans with the same
    // owner-private input.
    const all = await initOperation({ root: environment.root, harness: "all", claudeExec: runner });
    const routerText = await readFile(path.join(state, "opencode-skills", "skill-router", "SKILL.md"), "utf8");
    assert.ok(routerText.includes(`\`${projectSpool}/<token>.txt\``), "the exact absolute spool is generated");
    assert.equal(routerText.includes(`${state}/requests`), false, "the retired state spool never reappears");
    const plugin = claudeIdentity({ global: false, stateDirectory: state }).plugin;
    const claudeRouter = await readFile(
      path.join(state, "claude", "plugins", plugin, "skills", "skill-router", "SKILL.md"),
      "utf8",
    );
    assert.ok(claudeRouter.includes(`\`${projectSpool}/<token>.txt\``), "Claude instructions carry the same spool");
    assert.equal(claudeRouter.includes(`${state}/requests`), false);

    // Nothing serialized back to a caller ever carries the spool path, and the
    // sidecar's mode-input document stays out of results and diagnostics too.
    const sidecar = path.join(state, FINGERPRINT_SIDECAR);
    assert.ok(await exists(sidecar), "the fingerprint sidecar is part of managed state");
    const checked = await checkOperation({ root: environment.root, claudeExec: runner });
    assert.equal(checked.healthy, true, JSON.stringify(checked.diagnostics));
    const sidecarText = await readFile(sidecar, "utf8");
    for (const serialized of [JSON.stringify(all), JSON.stringify(checked)]) {
      assert.equal(serialized.includes(projectSpool), false, "the spool path never reaches a result");
      assert.equal(serialized.includes(".skill-router-requests"), false);
      assert.equal(serialized.includes(FINGERPRINT_SIDECAR), false, "sidecar bytes never reach a result");
    }
    assert.equal(sidecarText.includes(projectSpool), false, "the sidecar records mode inputs, not routing data");
    assert.equal(sidecarText.includes(TOKEN), false);

    // Global scope: the same rule with the router-home spool. The project
    // check runs above, before the global installation adds its own generated
    // OpenCode source to project-scope discovery.
    const globalSpool = path.join(environment.home, ".local", "share", "skill-router-requests");
    const globalState = path.join(environment.home, ".local", "share", "skill-router");
    const globalInit = await initOperation({ root: environment.root, global: true });
    const globalRouter = await readFile(
      path.join(globalState, "opencode-skills", "skill-router", "SKILL.md"),
      "utf8",
    );
    assert.ok(globalRouter.includes(`\`${globalSpool}/<token>.txt\``));
    assert.equal(globalRouter.includes(`${globalState}/requests`), false);
    assert.equal(JSON.stringify(globalInit).includes(globalSpool), false, "the global spool path never reaches a result");
    assert.equal(JSON.stringify(globalInit).includes(".skill-router-requests"), false);
  });
});

test("check reports confidentiality drift for broad modes, stays read-only, and heals after regeneration", async () => {
  await withHarnessEnvironment(async (environment) => {
    if (!posix) return;
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    await initOperation({ root: environment.root });
    const state = path.join(environment.root, ".skill-router");
    const skillsDirectory = path.join(state, "opencode-skills");
    const registryFile = path.join(state, "registry.json");
    const projectSpool = spoolOf(environment.root);

    // The two exact broad-mode cases: a 0755 directory and a 0644 file.
    await chmod(skillsDirectory, 0o755);
    await chmod(registryFile, 0o644);

    // A dry run plans but never chmods, and check alone never repairs.
    await initOperation({ root: environment.root, dryRun: true });
    assert.equal(await modeOf(skillsDirectory), 0o755, "dry-run never chmods");
    assert.equal(await modeOf(registryFile), 0o644);

    const check = await checkOperation({ root: environment.root });
    assert.equal(check.healthy, false, "check alone is unhealthy for confidentiality drift");
    const drift = check.diagnostics.filter((item) => item.code === "state-confidentiality-invalid");
    assert.equal(drift.length, 1, "exactly one bounded diagnostic");
    assert.equal(drift[0].level, "error");
    // Path-free and nonsecret: only fixed, allowlisted issue codes may be
    // named. No filesystem path, relative sample, uid, or mode string leaks.
    assert.equal(drift[0].message.includes(environment.root), false, "no absolute path leaks");
    assert.equal(drift[0].message.includes(state), false, "no absolute state path leaks");
    assert.equal(drift[0].message.includes(projectSpool), false, "no spool path leaks");
    assert.equal(/\b(uid|gid)\b/i.test(drift[0].message), false, "no identity values leak");
    assert.equal(drift[0].message.includes("/"), false, "no path separator may appear");
    assert.match(
      drift[0].message,
      /\(issues: (depth-limit|directory-mode|entries-limit|file-mode|foreign-owner|not-directory|special|stat-error|symlink|type-changed|unreadable-directory|unreadable-file|vanished)(, [a-z-]+)*\)$/,
      "only allowlisted issue codes are named",
    );
    // Modes stay exactly where the user left them: check never chmods.
    assert.equal(await modeOf(skillsDirectory), 0o755);
    assert.equal(await modeOf(registryFile), 0o644);

    // Regeneration replaces the tree with exact owner-private modes, and the
    // independent inspector agrees with what check then reports.
    await scanOperation({ root: environment.root });
    assert.equal(await modeOf(skillsDirectory), 0o700, "scan installs exact 0700 directories");
    assert.equal(await modeOf(registryFile), 0o600, "scan installs exact 0600 files");
    assert.equal((await inspectStateConfidentiality(state)).status, "confidential");
    const healed = await checkOperation({ root: environment.root });
    assert.equal(healed.healthy, true, JSON.stringify(healed.diagnostics));
    assert.equal(healed.diagnostics.some((item) => item.code === "state-confidentiality-invalid"), false);
  });
});

test("a platform without uid/mode semantics gets one warning that claims nothing", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    await initOperation({ root: environment.root });
    const restore = stateConfidentialityInternals.uidSemantics;
    try {
      stateConfidentialityInternals.uidSemantics = () => false;
      const limited = await checkOperation({ root: environment.root });
      const warnings = limited.diagnostics.filter((item) => item.code === "state-confidentiality-limited");
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].level, "warning", "limited is never an error");
      assert.equal(limited.healthy, true, "a limited platform claims neither drift nor enforcement");
      assert.equal(
        limited.diagnostics.some((item) => item.code === "state-confidentiality-invalid"),
        false,
      );
    } finally {
      stateConfidentialityInternals.uidSemantics = restore;
    }
    // With real semantics the same confidential state is simply silent.
    const healthy = await checkOperation({ root: environment.root });
    assert.equal(healthy.healthy, true, JSON.stringify(healthy.diagnostics));
    assert.equal(
      healthy.diagnostics.some((item) => item.code.startsWith("state-confidentiality")),
      false,
      "confidential state produces no diagnostic at all",
    );
  });
});

test("legacy broad modes keep check unhealthy but stay uninstallable without a pre-chmod", async () => {
  await withHarnessEnvironment(async (environment) => {
    if (!posix) return;
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    // A legacy-shaped installation: OpenCode-only, owner-safe, but broad.
    await initOperation({ root: environment.root });
    const state = path.join(environment.root, ".skill-router");
    const spool = spoolOf(environment.root);
    await broadenStateTree(state);

    const check = await checkOperation({ root: environment.root });
    assert.equal(check.healthy, false, "check alone is unhealthy");
    assert.ok(check.diagnostics.some((item) => item.code === "state-confidentiality-invalid"));
    assert.equal(await modeOf(state), 0o755, "check never chmods the state it reports on");

    // Phase 6 attribution still accepts the tree, so uninstall needs no
    // pre-chmod: it removes exactly what the user had, broad modes and all.
    const removal = await uninstallOperation({ root: environment.root });
    assert.equal(removal.command, "uninstall");
    assert.equal(await exists(state), false, "the broad-mode state is removable");
    assert.equal(await exists(spool), false, "the empty stable spool is removed with it");
  });
});

test("a pending stable request survives regeneration and never reaches state, sidecar, journal, or control", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const runner = createFakeClaudeRunner();
    await initOperation({ root: environment.root, harness: "all", claudeExec: runner });
    const spool = spoolOf(environment.root);
    const state = path.join(environment.root, ".skill-router");
    const control = path.join(environment.root, ".skill-router-control");
    const requestBytes = "publish releases; rm -rf /; sk-test-0123456789abcdef\n";
    const requestFile = path.join(spool, `${TOKEN}.txt`);
    await writeFile(requestFile, requestBytes, { mode: 0o600 });
    const requestHash = createHash("sha256").update(requestBytes).digest("hex");

    await scanOperation({ root: environment.root, claudeExec: runner });

    // The pending request survives byte-identically, and scan neither reads
    // nor relocates it.
    assert.equal(await readFile(requestFile, "utf8"), requestBytes);

    // Neither state, the sidecar, the journal, nor control metadata carries
    // the request bytes, their hash, or the token.
    for (const file of await allFiles(state)) {
      const content = await readFile(file, "utf8");
      assert.equal(content.includes(requestBytes.trim()), false, `${file} carries request bytes`);
      assert.equal(content.includes(requestHash), false, `${file} carries the request hash`);
      assert.equal(content.includes(TOKEN), false, `${file} carries the request token`);
    }
    for (const file of await allFiles(control)) {
      const content = await readFile(file, "utf8");
      assert.equal(content.includes(requestBytes.trim()), false, `${file} carries request bytes`);
      assert.equal(content.includes(requestHash), false, `${file} carries the request hash`);
      assert.equal(content.includes(TOKEN), false, `${file} carries the request token`);
    }
    assert.deepEqual(await requestNames(spool).then((names) => names.sort()), [REQUEST_MARKER_NAME, `${TOKEN}.txt`].sort());
    assert.equal(await exists(path.join(control, "transaction.json")), false, "the journal is removed on commit");
  });
});

test("a malformed fingerprint sidecar fails check and refuses uninstall before any Claude mutation", async () => {
  await withHarnessEnvironment(async (environment) => {
    if (!posix) return;
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const runner = createFakeClaudeRunner();
    await initOperation({ root: environment.root, harness: "all", claudeExec: runner });
    const state = path.join(environment.root, ".skill-router");
    const sidecar = path.join(state, FINGERPRINT_SIDECAR);
    const original = await readFile(sidecar, "utf8");

    // `check` reports the malformed sidecar as one error and repairs nothing.
    await writeFile(sidecar, "{ not the sidecar document }\n", { mode: 0o600 });
    const checked = await checkOperation({ root: environment.root, claudeExec: runner });
    assert.equal(checked.healthy, false);
    assert.ok(checked.diagnostics.some((item) => item.code === "claude-fingerprint-sidecar"));
    assert.equal(await readFile(sidecar, "utf8"), "{ not the sidecar document }\n", "check never repairs the sidecar");

    // Uninstall refuses on the malformed sidecar before any mutating Claude
    // CLI call: attribution must come from the sidecar, never from guessing.
    runner.log.length = 0;
    await assert.rejects(
      () => uninstallOperation({ root: environment.root, claudeExec: runner }),
      /sidecar/i,
    );
    assert.equal(mutationsOf(runner).length, 0, "no mutating Claude call ran before the refusal");
    assert.ok(await exists(state), "state survives the refused uninstall");

    // Restoring the exact sidecar bytes restores health.
    await writeFile(sidecar, original, { mode: 0o600 });
    const healed = await checkOperation({ root: environment.root, claudeExec: runner });
    assert.equal(healed.healthy, true, JSON.stringify(healed.diagnostics));
  });
});

/* ------------------------------------------------------------------ *
 * Phase 7 blocker 1 — the transaction's legacy-request bracket
 *
 * An old harness can write `<state>/requests/<token>.txt` (or a claim, or any
 * unknown name) *after* this command's early preflight and while the
 * transaction is planning. Without the bracket, that entry would be hashed
 * into the journaled prior-state digest and then deleted with the backup. The
 * tests below inject it deterministically at a durable transaction step — not
 * by racing — and prove the refusal happens before any journal, payload,
 * stage, or backup exists.
 * ------------------------------------------------------------------ */

/** Deterministic injection at one durable transaction step, never by timing. */
async function atTransactionStep(run, target, inject) {
  const previous = journaledTransactionInternals.onStep;
  journaledTransactionInternals.onStep = async (name, context) => {
    if (name === target) await inject(context);
    return previous(name, context);
  };
  try {
    return await run();
  } finally {
    journaledTransactionInternals.onStep = previous;
  }
}

/** Every transaction transient that must not exist after a refusal. */
async function transactionArtifacts(root) {
  const pattern = /(\.skill-router-[0-9a-f]{64}\.(?:before|after|tmp)$)|(^transaction\.json$)|(\.stage-[0-9a-f]{64}$)|(\.backup-[0-9a-f]{64}$)|(\.claim-[0-9a-f]{64}$)/;
  const found = [];
  for (const file of await allFiles(root)) {
    const relative = path.relative(root, file);
    if (pattern.test(relative) || pattern.test(path.basename(file))) found.push(relative);
  }
  for (const name of await readdir(root)) {
    if (pattern.test(name)) found.push(name);
  }
  return found.sort();
}

/** Asserts no artifact outside the request file itself carries request data. */
async function assertNoRequestMaterial(root, { requestBytes, token, requestHash, except }) {
  for (const file of await allFiles(root)) {
    if (except && path.resolve(file) === path.resolve(except)) continue;
    const content = await readFile(file, "utf8");
    assert.equal(content.includes(requestBytes.trim()), false, `${file} carries request bytes`);
    assert.equal(content.includes(token), false, `${file} carries the request token`);
    assert.equal(content.includes(requestHash), false, `${file} carries the request hash`);
  }
}

/** The two shapes an old harness can leave behind: a public entry and a claim. */
const LEGACY_ENTRY_KINDS = [
  ["public", `${TOKEN}.txt`],
  ["claim", `.claim.${TOKEN}.${"d".repeat(32)}`],
];

for (const [kind, entryName] of LEGACY_ENTRY_KINDS) {
  test(`a late legacy ${kind} entry refuses managed regeneration before any journal`, async () => {
    await withHarnessEnvironment(async (environment) => {
      await writeSkill(releaseSource(environment), "Release", "Publish releases");
      const runner = createFakeClaudeRunner();
      await initOperation({ root: environment.root, harness: "all", claudeExec: runner });
      const state = path.join(environment.root, ".skill-router");
      const legacy = path.join(state, "requests");
      const requestFile = path.join(legacy, entryName);
      const requestBytes = `legacy ${kind} sentinel for ${TOKEN}\n`;
      const requestHash = createHash("sha256").update(requestBytes).digest("hex");
      const paths = controlPaths({ root: environment.root });
      const configFile = path.join(environment.root, ".skill-router.json");

      // The command's own preflight sees no legacy requests at all.
      assert.equal(await exists(legacy), false, "the legacy directory does not exist at preflight time");
      const stateBefore = await digestTree(state);
      const spoolBefore = await requestNames(spoolOf(environment.root));
      const configBefore = await readFile(configFile, "utf8");
      runner.log.length = 0;

      // The race: the old harness writes the entry after that preflight, at
      // the moment the transaction is about to inspect the prior state.
      const refusal = await captureError(() =>
        atTransactionStep(
          () => scanOperation({ root: environment.root, claudeExec: runner }),
          "inspect",
          async () => {
            // Owner-private, as the legacy spool contract requires: the
            // refusal must come from the entry's presence, not its mode.
            await mkdir(legacy, { recursive: true, mode: 0o700 });
            await writeFile(requestFile, requestBytes, { mode: 0o600 });
          },
        ),
      );
      assert.match(String(refusal.message), /legacy request files are pending/i);
      assert.equal(refusal.code, "REQUEST-LEGACY-PENDING", "the fixed generic request refusal");
      assert.equal(String(refusal.message).includes(TOKEN), false, "the refusal echoes no token");
      assert.equal(String(refusal.message).includes("requests"), false, "the refusal echoes no path");

      // The request survives byte-identically at its exact path, and the only
      // change under state is the injected entry itself.
      assert.equal(await readFile(requestFile, "utf8"), requestBytes);
      assert.deepEqual(
        await digestTree(state),
        { ...stateBefore, [`requests/${entryName}`]: requestHash },
        "the canonical state is otherwise untouched",
      );

      // No journal, payload, stage, backup, or claim was ever created.
      assert.equal(await readJournal(paths, { allowMissing: true }), null, "no journal exists");
      assert.deepEqual(await transactionArtifacts(environment.root), [], "no transaction artifact remains");

      // Config, spool, and harness logs are unchanged; zero Claude mutation.
      assert.equal(await readFile(configFile, "utf8"), configBefore);
      assert.deepEqual(await requestNames(spoolOf(environment.root)), spoolBefore);
      assert.equal(mutationsOf(runner).length, 0, "no mutating Claude call ran");

      // Nothing anywhere else carries the bytes, the token, or their hash.
      await assertNoRequestMaterial(environment.root, {
        requestBytes,
        token: TOKEN,
        requestHash,
        except: requestFile,
      });
    });
  });

  test(`a late legacy ${kind} entry refuses uninstall before any journal`, async () => {
    await withHarnessEnvironment(async (environment) => {
      await writeSkill(releaseSource(environment), "Release", "Publish releases");
      const runner = createFakeClaudeRunner();
      await initOperation({ root: environment.root, harness: "all", claudeExec: runner });
      const state = path.join(environment.root, ".skill-router");
      const legacy = path.join(state, "requests");
      const requestFile = path.join(legacy, entryName);
      const requestBytes = `uninstall ${kind} sentinel for ${TOKEN}\n`;
      const requestHash = createHash("sha256").update(requestBytes).digest("hex");
      const paths = controlPaths({ root: environment.root });
      const configFile = path.join(environment.root, ".skill-router.json");

      assert.equal(await exists(legacy), false, "the legacy directory does not exist at preflight time");
      const stateBefore = await digestTree(state);
      const spoolBefore = await requestNames(spoolOf(environment.root));
      const configBefore = await readFile(configFile, "utf8");
      runner.log.length = 0;

      const refusal = await captureError(() =>
        atTransactionStep(
          () => uninstallOperation({ root: environment.root, claudeExec: runner }),
          "inspect",
          async () => {
            // Owner-private, as the legacy spool contract requires.
            await mkdir(legacy, { recursive: true, mode: 0o700 });
            await writeFile(requestFile, requestBytes, { mode: 0o600 });
          },
        ),
      );
      assert.match(String(refusal.message), /legacy request files are pending/i);
      assert.equal(refusal.code, "REQUEST-LEGACY-PENDING");

      // Uninstall removes the very state the request lives in, so the request
      // and the whole state tree must survive untouched.
      assert.equal(await readFile(requestFile, "utf8"), requestBytes);
      assert.deepEqual(await digestTree(state), { ...stateBefore, [`requests/${entryName}`]: requestHash });
      assert.equal(await exists(state), true, "state was not renamed away");
      assert.equal(await readJournal(paths, { allowMissing: true }), null, "no journal exists");
      assert.deepEqual(await transactionArtifacts(environment.root), [], "no transaction artifact remains");
      assert.equal(await readFile(configFile, "utf8"), configBefore, "the router config is untouched");
      assert.deepEqual(await requestNames(spoolOf(environment.root)), spoolBefore, "the stable spool is untouched");
      assert.equal(mutationsOf(runner).length, 0, "no mutating Claude call ran");
      await assertNoRequestMaterial(environment.root, {
        requestBytes,
        token: TOKEN,
        requestHash,
        except: requestFile,
      });
    });
  });
}

test("a legacy request that appears after the guarded bracket fails closed and is never silently cleaned up", async () => {
  await withHarnessEnvironment(async (environment) => {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    await initOperation({ root: environment.root });
    const state = path.join(environment.root, ".skill-router");
    const legacy = path.join(state, "requests");
    const entryName = `${TOKEN}.txt`;
    const requestFile = path.join(legacy, entryName);
    const requestBytes = "late-boundary sentinel\n";
    const requestHash = createHash("sha256").update(requestBytes).digest("hex");
    const paths = controlPaths({ root: environment.root });

    // Later boundary: the entry appears after the bracket has taken its
    // snapshot, so the recorded baseline can never match the tree the renames
    // now carry. Endpoint reconciliation must refuse rather than let the
    // backup cleanup delete live request data.
    const failure = await captureError(() =>
      atTransactionStep(
        () => scanOperation({ root: environment.root }),
        "stage:build",
        async () => {
          await mkdir(legacy, { recursive: true, mode: 0o700 });
          await writeFile(requestFile, requestBytes, { mode: 0o600 });
        },
      ),
    );
    assert.ok(
      /recorded endpoints|ambiguous|recovery/i.test(String(failure.message)),
      `expected an endpoint-refusal failure, got: ${failure.message}`,
    );

    // Exactly one copy of the request survives — wherever the transaction
    // moved the tree — and it is never inside a cleanup claim.
    const copies = [];
    for (const file of await allFiles(environment.root)) {
      if (path.basename(file) !== entryName) continue;
      if (path.basename(path.dirname(file)) !== "requests") continue;
      copies.push(file);
      assert.equal(await readFile(file, "utf8"), requestBytes, "the surviving copy is byte-identical");
      assert.equal(file.includes(".claim-"), false, "no cleanup claim ever held the request");
      assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), requestHash);
    }
    assert.equal(copies.length, 1, `expected exactly one surviving copy, found ${copies.length}`);
    assert.ok(await readJournal(paths, { allowMissing: true }), "the refusal leaves its journal for recovery");
  });
});

test("a confidentiality diagnostic never carries a filesystem path, even under a legacy request", async () => {
  await withHarnessEnvironment(async (environment) => {
    if (!posix) return;
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    await initOperation({ root: environment.root });
    const state = path.join(environment.root, ".skill-router");
    // The sample path for this entry *is* `requests/<token>.txt`, so the
    // diagnostic must name only allowlisted issue codes. The directory stays
    // owner-private; it is the request file's broad mode that drifts.
    const legacy = path.join(state, "requests");
    await mkdir(legacy, { recursive: true, mode: 0o700 });
    const requestBytes = "legacy broad-mode sentinel\n";
    await writeFile(path.join(legacy, `${TOKEN}.txt`), requestBytes, { mode: 0o644 });
    const requestHash = createHash("sha256").update(requestBytes).digest("hex");

    const check = await checkOperation({ root: environment.root });
    assert.equal(check.healthy, false);
    const drift = check.diagnostics.find((item) => item.code === "state-confidentiality-invalid");
    assert.ok(drift, "the confidentiality code is reported");
    assert.ok(
      check.diagnostics.some((item) => item.code === "legacy-requests-pending"),
      "the pending legacy request is reported separately",
    );

    const serialized = JSON.stringify(check);
    assert.equal(serialized.includes(TOKEN), false, "no token leaks");
    assert.equal(serialized.includes(`requests/${TOKEN}.txt`), false, "no request path leaks");
    assert.equal(serialized.includes(requestBytes.trim()), false, "no request bytes leak");
    assert.equal(serialized.includes(requestHash), false, "no request hash leaks");
    assert.equal(drift.message.includes("/"), false, "the message names no path at all");
    assert.match(drift.message, /\(issues: [a-z-]+(, [a-z-]+)*\)$/, "only allowlisted issue codes");
  });
});

test("a huge legacy requests directory swapped during the guarded inspection is refused as unsafe after one open and zero reads", async () => {
  await withHarnessEnvironment(async (environment) => {
    if (!posix) return;
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const runner = createFakeClaudeRunner();
    await initOperation({ root: environment.root, harness: "all", claudeExec: runner });
    const state = path.join(environment.root, ".skill-router");
    const legacy = path.join(state, "requests");
    const paths = controlPaths({ root: environment.root });
    const configFile = path.join(environment.root, ".skill-router.json");

    // The transaction's first guard check sees an empty, owner-private legacy
    // directory, exactly as a healthy installation looks.
    await mkdir(legacy, { recursive: true, mode: 0o700 });
    const stateBefore = await digestTree(state);
    const configBefore = await readFile(configFile, "utf8");
    const spoolBefore = await requestNames(spoolOf(environment.root));
    runner.log.length = 0;

    // The race: a concurrent process atomically swaps in a huge populated
    // subtree at the moment the guarded inspector reaches it.
    const populated = path.join(environment.root, "populated-requests");
    await mkdir(populated, { recursive: true, mode: 0o700 });
    const sentinelBytes = "huge spool sentinel body\n";
    const sentinelHash = createHash("sha256").update(sentinelBytes).digest("hex");
    for (let index = 0; index < 48; index += 1) {
      await writeFile(path.join(populated, `${String(index).padStart(3, "0")}.txt`), `${sentinelBytes}${index}`, {
        mode: 0o600,
      });
    }

    const previousOpen = stateTreeInternals.opendir;
    const observed = { opens: 0, reads: 0 };
    let placed = false;
    stateTreeInternals.opendir = async (target) => {
      observed.opens += 1;
      if (!placed) {
        placed = true;
        await rename(populated, legacy);
      }
      const directory = await previousOpen(target);
      const read = directory.read.bind(directory);
      directory.read = async () => {
        observed.reads += 1;
        return read();
      };
      return directory;
    };
    let refusal;
    try {
      refusal = await captureError(() => scanOperation({ root: environment.root, claudeExec: runner }));
    } finally {
      stateTreeInternals.opendir = previousOpen;
    }
    // Hardened contract: the same-type swap is detected by identity before any
    // child of the replacement can be observed, so the refusal is the generic
    // unsafe one - never a pending count - and no child is ever read.
    assert.equal(refusal.code, "REQUEST-LEGACY-UNSAFE", "the fixed generic unsafe refusal");
    assert.match(String(refusal.message), /cannot be verified as owner-private/i);
    assert.equal(placed, true, "the swap happened at the guarded inspection, after the first guard check");
    assert.equal(observed.opens, 1, "one directory handle is opened for the legacy subtree");
    assert.equal(observed.reads, 0, "zero child reads: the identity recheck refuses before any child is observed");
    assert.equal(String(refusal.message).includes(".txt"), false, "no child name or path is echoed");
    assert.equal(String(refusal.message).includes("requests"), false, "no directory name is echoed");

    // Every entry keeps its exact bytes, and nothing else moved.
    const names = (await readdir(legacy)).sort();
    assert.equal(names.length, 48, "every entry survives");
    for (const name of names) {
      assert.equal(await readFile(path.join(legacy, name), "utf8"), `${sentinelBytes}${Number(name.slice(0, 3))}`);
    }
    const expected = { ...stateBefore };
    for (const name of names) {
      expected[`requests/${name}`] = createHash("sha256")
        .update(`${sentinelBytes}${Number(name.slice(0, 3))}`)
        .digest("hex");
    }
    assert.deepEqual(await digestTree(state), expected, "state changed only by the injected entries themselves");

    // Refused before any journal, payload, stage, backup, config, spool, or
    // Claude mutation.
    assert.equal(await readJournal(paths, { allowMissing: true }), null, "no journal exists");
    assert.deepEqual(await transactionArtifacts(environment.root), [], "no transaction artifact remains");
    assert.equal(await readFile(configFile, "utf8"), configBefore, "the router config is untouched");
    assert.deepEqual(await requestNames(spoolOf(environment.root)), spoolBefore, "the stable spool is untouched");
    assert.equal(mutationsOf(runner).length, 0, "no mutating Claude call ran");

    // No sentinel body or hash reached any other artifact.
    for (const file of await allFiles(environment.root)) {
      if (path.dirname(file) === legacy) continue;
      const content = await readFile(file, "utf8");
      assert.equal(content.includes(sentinelBytes.trim()), false, `${file} carries the sentinel body`);
      assert.equal(content.includes(sentinelHash), false, `${file} carries the sentinel hash`);
    }
  });
});

test("stale enablement is a schema v1 rule with one exact direction", () => {
  const v1 = normalizeConfig({ schemaVersion: 1, skills: { release: {} } });
  const disabledV1 = normalizeConfig({ schemaVersion: 1, skills: { release: { enabled: false } } });
  const installedDisabled = { skills: [{ id: "release", enabled: false }] };
  const installedEnabled = { skills: [{ id: "release", enabled: true }] };

  // Installed false + current true/default is the stale direction.
  assert.deepEqual(staleEnablementIds(installedDisabled, v1), ["release"]);
  assert.throws(
    () => assertFreshEnablement(installedDisabled, v1),
    /Registry skill enablement is stale; run skill-router scan first/,
  );
  // Installed false + current false agrees: no staleness, the config veto is
  // the immediate one routing already applies.
  assert.deepEqual(staleEnablementIds(installedDisabled, disabledV1), []);
  assert.doesNotThrow(() => assertFreshEnablement(installedDisabled, disabledV1));
  // Installed true is never staleness, in either config direction.
  assert.deepEqual(staleEnablementIds(installedEnabled, v1), []);
  assert.deepEqual(staleEnablementIds(installedEnabled, disabledV1), []);
  // Schema v2 folds enablement into its policy hash instead; no second
  // fingerprint is added here.
  const v2 = normalizeConfig({ schemaVersion: 2, skills: { release: {} } });
  assert.deepEqual(staleEnablementIds(installedDisabled, v2), []);
  assert.doesNotThrow(() => assertFreshEnablement(installedDisabled, v2));
  // Malformed or absent registry inventory is inert.
  assert.deepEqual(staleEnablementIds({ skills: null }, v1), []);
  assert.deepEqual(staleEnablementIds({}, v1), []);
  assert.deepEqual(staleEnablementIds(null, v1), []);
});

test("schema v1 enablement edits refuse route and check until a scan rebuilds them", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    const root = environment.root;
    await writeSkill(
      path.join(root, ".agents", "skills", "release", "SKILL.md"),
      "Release",
      "Prepare notes and publish releases",
    );
    const configFile = path.join(root, ".skill-router.json");
    const document = (settings) => `${JSON.stringify({ schemaVersion: 1, skills: { release: settings } }, null, 2)}\n`;

    // The installed registry records the skill as disabled and the live
    // configuration still disables it: the immediate veto applies and there
    // is no staleness.
    await writeFile(configFile, document({ enabled: false }));
    await initOperation({ root });
    assert.equal((await routeOperation("release", { root })).outcome, "none");
    assert.equal(
      (await checkOperation({ root })).diagnostics.some((item) => item.code === "enablement-stale"),
      false,
    );

    // Re-enabling in the configuration is stale against the installed
    // registry: both route transports refuse with the fixed run-scan message.
    await writeFile(configFile, document({}));
    await assert.rejects(
      () => routeOperation("release", { root }),
      /Registry skill enablement is stale; run skill-router scan first/,
    );
    await assert.rejects(
      () => routeFileOperation("0123456789abcdef0123456789abcdef", { root }),
      /Registry skill enablement is stale; run skill-router scan first/,
    );
    const checked = await checkOperation({ root });
    assert.equal(checked.healthy, false);
    assert.equal(
      checked.diagnostics.some((item) => item.code === "enablement-stale" && item.level === "error"),
      true,
    );

    // A scan rebuild records the current enablement, so routing works again.
    await scanOperation({ root });
    assert.equal((await routeOperation("release", { root })).skillId, "release");
    assert.equal((await checkOperation({ root })).healthy, true);
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("a dry run never spawns OpenCode and defers when its skills shape is unknown", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  const previousBin = process.env.SKILL_ROUTER_OPENCODE_BIN;
  const canaryRan = path.join(environment.directory, "opencode-canary-ran");
  try {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    // A canary "CLI" would record its own invocation; a dry run must never
    // reach it, whatever the configuration says.
    const canary = path.join(environment.directory, "opencode-canary");
    await writeFile(canary, `#!/bin/sh\nprintf ran > ${canaryRan}\nprintf '%s\\n' '2.0.0'\n`, { mode: 0o755 });
    process.env.SKILL_ROUTER_OPENCODE_BIN = canary;

    // Without a configuration the shape is uninferable in a dry run: router-
    // owned generation still completes, the fixed deferred action is emitted,
    // and nothing is spawned or rewritten.
    const deferred = await initOperation({ root: environment.root, dryRun: true });
    assert.equal(deferred.dryRun, true);
    assert.equal(deferred.skillCount, 1);
    assert.match(deferred.manualAction, /make a supported OpenCode CLI available/);
    assert.equal(/paths|array/i.test(deferred.manualAction), false, "the deferred action recommends no shape");
    assert.equal(await exists(canaryRan), false, "a dry run never spawns OpenCode");
    assert.equal(
      await exists(path.join(environment.root, ".opencode", "opencode.json")),
      false,
      "a dry run rewrites no OpenCode configuration",
    );

    // An existing valid skills shape needs no probe at all, dry run or not.
    const openCodeFile = path.join(environment.root, ".opencode", "opencode.json");
    await mkdir(path.dirname(openCodeFile), { recursive: true });
    await writeFile(openCodeFile, `${JSON.stringify({ skills: [] }, null, 2)}\n`);
    const known = await initOperation({ root: environment.root, dryRun: true });
    assert.equal(known.manualAction, undefined);
    assert.equal(known.skillCount, 1);
    assert.equal(await exists(canaryRan), false, "an existing shape wins without any spawn");
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    if (previousBin === undefined) delete process.env.SKILL_ROUTER_OPENCODE_BIN;
    else process.env.SKILL_ROUTER_OPENCODE_BIN = previousBin;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("a real run defers the OpenCode write when the CLI cannot answer, then reruns cleanly", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  const previousBin = process.env.SKILL_ROUTER_OPENCODE_BIN;
  try {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    // No OpenCode CLI is available at all.
    process.env.SKILL_ROUTER_OPENCODE_BIN = path.join(environment.directory, "missing-opencode");

    const deferred = await initOperation({ root: environment.root });
    assert.equal(deferred.skillCount, 1, "router-owned generation still completes");
    assert.match(deferred.manualAction, /make a supported OpenCode CLI available/);
    assert.equal(/paths|array/i.test(deferred.manualAction), false, "the action recommends no shape");
    assert.equal(
      await exists(path.join(deferred.skillsDirectory, "release", "SKILL.md")),
      true,
      "the managed generation itself is complete",
    );
    assert.equal(
      await exists(path.join(environment.root, ".opencode", "opencode.json")),
      false,
      "no OpenCode configuration is written while the shape is unknown",
    );
    const checked = await checkOperation({ root: environment.root });
    assert.equal(checked.healthy, false);
    // The OpenCode configuration file was never created, so `check` reports
    // the missing configuration rather than a missing source entry.
    assert.equal(checked.diagnostics.some((item) => item.code === "opencode-config-invalid"), true);

    // Making a supported CLI available and rerunning attaches the managed
    // directory exactly as the deferred action says.
    const bin = path.join(environment.directory, "opencode");
    await writeFile(bin, "#!/bin/sh\nprintf '%s\\n' 'opencode v2.0.0'\n", { mode: 0o755 });
    process.env.SKILL_ROUTER_OPENCODE_BIN = bin;
    const rerun = await scanOperation({ root: environment.root });
    assert.equal(rerun.manualAction, undefined);
    const openCode = JSON.parse(
      await readFile(path.join(environment.root, ".opencode", "opencode.json"), "utf8"),
    );
    assert.deepEqual(openCode.skills, [rerun.skillsDirectory]);
    assert.equal((await checkOperation({ root: environment.root })).healthy, true);
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    if (previousBin === undefined) delete process.env.SKILL_ROUTER_OPENCODE_BIN;
    else process.env.SKILL_ROUTER_OPENCODE_BIN = previousBin;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("a real run never consults the CLI when the configuration already declares a shape", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  const previousBin = process.env.SKILL_ROUTER_OPENCODE_BIN;
  const canaryRan = path.join(environment.directory, "opencode-canary-ran");
  try {
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const openCodeFile = path.join(environment.root, ".opencode", "opencode.json");
    await mkdir(path.dirname(openCodeFile), { recursive: true });
    await writeFile(openCodeFile, `${JSON.stringify({ skills: [] }, null, 2)}\n`);
    // A canary "CLI" would record its own invocation; the existing skills
    // array already answers the shape question, so it must never run.
    const canary = path.join(environment.directory, "opencode-canary");
    await writeFile(canary, `#!/bin/sh\nprintf ran > ${canaryRan}\nprintf '%s\\n' '2.0.0'\n`, { mode: 0o755 });
    process.env.SKILL_ROUTER_OPENCODE_BIN = canary;

    const init = await initOperation({ root: environment.root });
    assert.equal(init.manualAction, undefined);
    assert.equal(await exists(canaryRan), false, "an existing valid skills shape wins without any probe");
    const openCode = JSON.parse(await readFile(openCodeFile, "utf8"));
    assert.deepEqual(openCode.skills, [init.skillsDirectory], "the declared shape is preserved");
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    if (previousBin === undefined) delete process.env.SKILL_ROUTER_OPENCODE_BIN;
    else process.env.SKILL_ROUTER_OPENCODE_BIN = previousBin;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("an OpenCode configuration created after planning refuses before any config or state mutation", async () => {
  await withHarnessEnvironment(async (environment) => {
    const root = environment.root;
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const openCodeFile = path.join(root, ".opencode", "opencode.json");
    // The capability probe runs *inside* OpenCode planning. This stand-in CLI
    // mutates the configuration exactly after planning has observed its
    // absence, then answers with a clean version — the user-edit window the
    // compare-and-swap must close.
    const userBytes = '{"skills":[]}';
    const window = path.join(environment.directory, "opencode-window");
    await writeFile(
      window,
      "#!/bin/sh\n" +
        `mkdir -p ${JSON.stringify(path.dirname(openCodeFile))}\n` +
        `printf '%s' ${JSON.stringify(userBytes)} > ${JSON.stringify(openCodeFile)}\n` +
        "printf '%s\\n' '2.0.0'\n",
      { mode: 0o755 },
    );
    const previousBin = process.env.SKILL_ROUTER_OPENCODE_BIN;
    process.env.SKILL_ROUTER_OPENCODE_BIN = window;
    try {
      const error = await captureError(() => initOperation({ root }));
      assert.match(error.message, /no longer matches the bytes observed during planning/);
      // The CAS refusal fires during file-payload planning — before the
      // journal, staging, config writes, or any Claude mutation.
      assert.equal(await readFile(openCodeFile, "utf8"), userBytes, "the racing creation survives untouched");
      assert.equal(await digestTree(path.join(root, ".skill-router")), null, "no router state was staged");
      await assert.rejects(() => access(path.join(root, ".skill-router.json")), /ENOENT/, "no config was written");

      // Without the racing mutation the same command completes and attaches
      // the managed directory itself.
      process.env.SKILL_ROUTER_OPENCODE_BIN = previousBin;
      const init = await initOperation({ root });
      assert.equal(init.manualAction, undefined);
      const openCode = JSON.parse(await readFile(openCodeFile, "utf8"));
      assert.deepEqual(openCode.skills, [init.skillsDirectory]);
    } finally {
      if (previousBin === undefined) delete process.env.SKILL_ROUTER_OPENCODE_BIN;
      else process.env.SKILL_ROUTER_OPENCODE_BIN = previousBin;
    }
  });
});

test("an OpenCode configuration rewritten after planning refuses against the observed bytes", async () => {
  await withHarnessEnvironment(async (environment) => {
    const root = environment.root;
    await writeSkill(releaseSource(environment), "Release", "Publish releases");
    const openCodeFile = path.join(root, ".opencode", "opencode.json");
    await mkdir(path.dirname(openCodeFile), { recursive: true });
    // A v1 skills object without paths still needs the probe, so the probe
    // callback is exactly the post-planning mutation window.
    const originalBytes = '{"model":"example/model","skills":{"urls":["https://example.test/skills"]}}';
    const mutatedBytes = '{"model":"other/model","skills":{"urls":[]}}';
    await writeFile(openCodeFile, originalBytes);
    const window = path.join(environment.directory, "opencode-rewrite-window");
    await writeFile(
      window,
      "#!/bin/sh\n" +
        `printf '%s' ${JSON.stringify(mutatedBytes)} > ${JSON.stringify(openCodeFile)}\n` +
        "printf '%s\\n' '1.18.20'\n",
      { mode: 0o755 },
    );
    const previousBin = process.env.SKILL_ROUTER_OPENCODE_BIN;
    process.env.SKILL_ROUTER_OPENCODE_BIN = window;
    try {
      const error = await captureError(() => initOperation({ root }));
      assert.match(error.message, /no longer matches the bytes observed during planning/);
      assert.equal(await readFile(openCodeFile, "utf8"), mutatedBytes, "the racing rewrite survives untouched");
      assert.equal(await digestTree(path.join(root, ".skill-router")), null, "no router state was staged");
      await assert.rejects(() => access(path.join(root, ".skill-router.json")), /ENOENT/, "no config was written");
    } finally {
      if (previousBin === undefined) delete process.env.SKILL_ROUTER_OPENCODE_BIN;
      else process.env.SKILL_ROUTER_OPENCODE_BIN = previousBin;
    }
  });
});
