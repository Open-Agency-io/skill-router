import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, lstat, link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse, parseDocument } from "yaml";
import { fileModeBitsMeaningful, MANAGED_REGISTRY_ID_ERROR, planClaudePlugin } from "../src/claude.js";
import { fileIdentity, identitiesEqual, identityRecord, isIdentityAvailable } from "../src/durable-fs.js";
import { parseFrontmatter } from "../src/frontmatter.js";
import { buildInstallation, claudeIdentity, STATE_MARKER_CONTENT, STATE_MARKER_FILE } from "../src/installation.js";
import {
  MANAGED_SOURCE_LIMIT_ERROR,
  STATE_CONFIDENTIALITY_SAMPLE_LIMIT,
  STATE_TREE_LIMITS,
  classifyStateArtifact,
  inspectStateConfidentiality,
  inspectStateTree,
  planManagedState,
  stageFinalizeInternals,
  stageManagedState,
  stateConfidentialityInternals,
  stateTreeInternals,
} from "../src/managed-state.js";
import { boundedWalkInternals } from "../src/bounded-walk.js";
import { splitSkillDocument } from "../src/skill-document.js";

async function exists(value) {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}

/** The exact absolute stable request spool a planning test hands to the router. */
function requestSpool(root) {
  return path.join(root, ".skill-router-requests");
}

/** Recursive sha256 digest of every file below `directory` (null when absent). */
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

test("uses canonical IDs as managed OpenCode skill names", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  const source = path.join(root, "release", "SKILL.md");
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(
    source,
    "---\nname: Release Display Name\ndescription: Publish a release\n---\n\nRelease instructions.\n",
  );
  const registry = {
    skills: [{
      id: "release",
      name: "Release Display Name",
      description: "Publish a release",
      source,
      enabled: true,
    }],
  };
  try {
    const staged = await stageManagedState(path.join(root, "state"), registry, {
      requestDirectory: requestSpool(root),
    });
    const release = parseFrontmatter(
      await readFile(path.join(staged.stage, "opencode-skills", "release", "SKILL.md"), "utf8"),
    ).attributes;
    const router = parseFrontmatter(
      await readFile(path.join(staged.stage, "opencode-skills", "skill-router", "SKILL.md"), "utf8"),
    ).attributes;
    assert.equal(release.name, "release");
    assert.equal(release.metadata["opencode/autoinvoke"], false);
    assert.equal(router.name, "skill-router");
    assert.equal(registry.skills[0].name, "Release Display Name");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("router skill instructions cover every route outcome safely", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  const source = path.join(root, "source.md");
  await writeFile(source, "source\n");
  try {
    const staged = await stageManagedState(path.join(root, "state"), {
      skills: [{ id: "source", name: "source", description: "Source", source, enabled: true }],
    }, { requestDirectory: requestSpool(root) });
    const text = await readFile(path.join(staged.stage, "opencode-skills", "skill-router", "SKILL.md"), "utf8");
    for (const outcome of ["select", "sequence", "advise", "clarify", "none"]) {
      assert.ok(text.includes(`\`${outcome}\``), `router skill must document ${outcome}`);
    }
    assert.ok(text.includes("Never auto-follow `handoffs`"));
    assert.ok(text.includes("never load it"));
    assert.ok(text.includes("an ordered plan, not atomic execution"));
    assert.ok(text.length / 4 < 300, "router skill should remain below the 300-token estimate");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Exact, bounded planner refusal for an invalid/reserved registry public ID. */
async function assertManagedIdRejection(run) {
  const error = await captureError(run);
  assert.equal(error.message, MANAGED_REGISTRY_ID_ERROR, "the refusal is fixed and bounded");
  return error;
}

test("rejects case-variant managed destinations before any source read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  const lower = path.join(root, "lower.md");
  const upper = path.join(root, "upper.md");
  await writeFile(lower, "lower\n");
  await writeFile(upper, "upper\n");
  const registry = {
    skills: [
      { id: "skill", name: "skill", description: "lower", source: lower, enabled: true },
      { id: "SKILL", name: "SKILL", description: "upper", source: upper, enabled: true },
    ],
  };
  try {
    // Uppercase is not a portable public ID, so validation rejects the
    // registry before the destination collision check would ever see it —
    // and before either source document is read.
    await assertManagedIdRejection(() =>
      stageManagedState(path.join(root, "state"), registry, { requestDirectory: requestSpool(root) }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects exact-duplicate managed destinations after validation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  const first = path.join(root, "first.md");
  const second = path.join(root, "second.md");
  await writeFile(first, "first\n");
  await writeFile(second, "second\n");
  const registry = {
    skills: [
      { id: "skill", name: "skill", description: "first", source: first, enabled: true },
      { id: "skill", name: "skill", description: "second", source: second, enabled: true },
    ],
  };
  try {
    // Both IDs are individually valid, so validation passes and the retained
    // case-insensitive destination collision check rejects the duplicate.
    await assert.rejects(
      () => stageManagedState(path.join(root, "state"), registry, { requestDirectory: requestSpool(root) }),
      /collide/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reserves the generated router ID before any source read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  const source = path.join(root, "source.md");
  await writeFile(source, "source\n");
  try {
    // The exact reservation is only `skill-router`, and a user registry
    // claiming it is an invalid public ID: rejected by validation before the
    // reserved-ID destination check or any source read.
    await assertManagedIdRejection(() =>
      stageManagedState(path.join(root, "state"), {
        skills: [{ id: "skill-router", name: "Collision", description: "Collision", source, enabled: true }],
      }, { requestDirectory: requestSpool(root) }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reserves the router ID for a case variant before any source read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  const source = path.join(root, "source.md");
  await writeFile(source, "source\n");
  try {
    await assertManagedIdRejection(() =>
      stageManagedState(path.join(root, "state"), {
        skills: [{ id: "Skill-Router", name: "Collision", description: "Collision", source, enabled: true }],
      }, { requestDirectory: requestSpool(root) }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stages router-owned installation metadata for recorded harnesses", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  const source = path.join(root, "release", "SKILL.md");
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, "---\nname: Release\ndescription: Publish a release\n---\n\nRelease instructions.\n");
  const registry = {
    skills: [{ id: "release", name: "Release", description: "Publish a release", source, enabled: true }],
  };
  try {
    const stateDirectory = path.join(root, "state");
    const installation = buildInstallation({
      global: false,
      stateDirectory,
      harnesses: ["opencode"],
    });
    const staged = await stageManagedState(stateDirectory, registry, {
      installation,
      requestDirectory: requestSpool(root),
    });
    const document = JSON.parse(await readFile(path.join(staged.stage, "installation.json"), "utf8"));
    assert.equal(document.owner, "skill-router");
    assert.equal(document.scope, "project");
    assert.deepEqual(document.harnesses, ["opencode"]);
    assert.ok(await exists(path.join(staged.stage, "opencode-skills", "release", "SKILL.md")));
    assert.equal(await exists(path.join(staged.stage, "claude")), false);

    // Calls without installation metadata keep the historical OpenCode output.
    const legacy = await stageManagedState(path.join(root, "legacy"), registry, {
      requestDirectory: requestSpool(root),
    });
    assert.ok(await exists(path.join(legacy.stage, "opencode-skills", "skill-router", "SKILL.md")));
    assert.equal(await exists(path.join(legacy.stage, "installation.json")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stages the generated Claude plugin only when the harness is recorded", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  const source = path.join(root, "release", "SKILL.md");
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, "---\nname: Release\ndescription: Publish a release\n---\n\nRelease instructions.\n");
  const registry = {
    skills: [{ id: "release", name: "Release", description: "Publish a release", source, enabled: true }],
  };
  const stateDirectory = path.join(root, "state");
  try {
    const identity = claudeIdentity({ global: false, stateDirectory });
    const claudePlan = await planClaudePlugin({
      registry,
      identity,
      stateDirectory,
      requestDirectory: requestSpool(root),
    });
    const installation = buildInstallation({
      global: false,
      stateDirectory,
      harnesses: ["claude"],
      claude: { fingerprint: claudePlan.fingerprint, version: claudePlan.version },
    });
    const staged = await stageManagedState(stateDirectory, registry, {
      installation,
      claudePlan,
      requestDirectory: requestSpool(root),
    });
    assert.equal(await exists(path.join(staged.stage, "opencode-skills")), false);
    assert.ok(
      await exists(
        path.join(staged.stage, "claude", "plugins", "openagency-skill-router", "skills", "release", "SKILL.md"),
      ),
    );
    const document = JSON.parse(await readFile(path.join(staged.stage, "installation.json"), "utf8"));
    assert.deepEqual(document.harnesses, ["claude"]);
    assert.equal(document.claude.plugin, "openagency-skill-router");
    assert.equal(document.claude.scope, "local");
    assert.equal(document.claude.fingerprint, claudePlan.fingerprint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const COMPLEX_SOURCE = `---
# retained source comment
name: Release Display Name
description: "Original description"
license: MIT
compatibility: claude-code>=1.0
allowed-tools: [Read, Grep]
disallowed-tools: ["Write", "Bash(rm:*)"]
invocation: explicit-only
model: claude-sonnet-4
context: fork
hooks:
  preToolUse: echo pre
  postToolUse: echo post
path: ./skills/release
metadata:
  tier: 2
  owner: platform
  opencode/autoinvoke: true
unknown-harness-field: keep-me
nested:
  list: [one, two]
  mapping:
    deep: value
---

# Release body

Keep this body verbatim.
`;

async function stageComplexSkill(root, { sourceText = COMPLEX_SOURCE, id = "release", description = "Effective description" } = {}) {
  const source = path.join(root, id, "SKILL.md");
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, sourceText);
  const registry = { skills: [{ id, name: id, description, source, enabled: true }] };
  const staged = await stageManagedState(path.join(root, "state"), registry, {
    requestDirectory: requestSpool(root),
  });
  // Directory-form sources stage as `<id>/SKILL.md`; flat sources as `<id>.md`.
  const directoryForm = path.join(staged.stage, "opencode-skills", id, "SKILL.md");
  const generatedPath = (await exists(directoryForm))
    ? directoryForm
    : path.join(staged.stage, "opencode-skills", `${id}.md`);
  const generated = await readFile(generatedPath, "utf8");
  return { source, staged, generated, generatedPath };
}

test("the generated OpenCode copy preserves source frontmatter and only adds the router-owned overrides", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const { source, generated } = await stageComplexSkill(root);
    const generatedData = parse(splitSkillDocument(generated).yaml);
    const sourceData = parse(splitSkillDocument(await readFile(source, "utf8")).yaml);

    // Identity is router-owned; every other source field survives semantically.
    assert.equal(generatedData.name, "release", "canonical name overrides the display name");
    assert.equal(generatedData.description, "Effective description", "effective registry description wins");
    assert.equal(generatedData.license, "MIT");
    assert.equal(generatedData.compatibility, "claude-code>=1.0");
    assert.deepEqual(generatedData["allowed-tools"], ["Read", "Grep"]);
    assert.deepEqual(generatedData["disallowed-tools"], ["Write", "Bash(rm:*)"]);
    assert.equal(generatedData.invocation, "explicit-only");
    assert.equal(generatedData.model, "claude-sonnet-4");
    assert.equal(generatedData.context, "fork");
    assert.deepEqual(generatedData.hooks, { preToolUse: "echo pre", postToolUse: "echo post" });
    assert.equal(generatedData.path, "./skills/release");
    assert.equal(generatedData["unknown-harness-field"], "keep-me", "unknown harness fields survive");
    assert.deepEqual(generatedData.nested, { list: ["one", "two"], mapping: { deep: "value" } });

    // Only the OpenCode marker is added/overridden inside existing metadata.
    assert.deepEqual(generatedData.metadata, {
      tier: 2,
      owner: "platform",
      "opencode/autoinvoke": false,
    });
    assert.deepEqual(
      Object.keys(generatedData).sort(),
      Object.keys(sourceData).sort(),
      "no top-level field is added or dropped",
    );

    // Comment and key order survive; the body stays verbatim.
    assert.match(generated, /# retained source comment/);
    const keysOf = (document) =>
      splitSkillDocument(document)
        .yaml.split("\n")
        .map((line) => line.match(/^([A-Za-z][A-Za-z0-9-]*):/)?.[1])
        .filter(Boolean);
    assert.deepEqual(keysOf(generated), keysOf(await readFile(source, "utf8")));
    assert.equal(splitSkillDocument(generated).body, splitSkillDocument(COMPLEX_SOURCE).body);

    // What `check` reads comes from the compact parser: it must parse the
    // generated copy and see the hidden marker plus canonical identity.
    const compact = parseFrontmatter(generated);
    assert.equal(compact.attributes.name, "release");
    assert.equal(compact.attributes.description, "Effective description");
    assert.equal(compact.attributes.license, "MIT");
    assert.equal(compact.attributes.metadata["opencode/autoinvoke"], false);
    assert.equal(compact.body, splitSkillDocument(COMPLEX_SOURCE).body);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source metadata that is not a mapping fails closed instead of being discarded", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    for (const metadataLine of ["metadata: legacy-string\n", "metadata: [a, b]\n", "metadata:\n"]) {
      const sourceText = `---\nname: Release\ndescription: Original\n${metadataLine}---\n\nBody.\n`;
      await assert.rejects(
        () => stageComplexSkill(root, { sourceText }),
        /frontmatter metadata must be a YAML mapping/,
        `${metadataLine.trim() || "metadata:"} is rejected`,
      );
    }
    // The staged directory is cleaned up on failure, so the last rejection
    // leaves no partial generation behind.
    assert.equal(await exists(path.join(root, "state")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sources without frontmatter get canonical identity and OpenCode metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const body = "# Instructions only\n\nNo frontmatter here.\n";
    const { generated } = await stageComplexSkill(root, { sourceText: body, id: "plain" });
    assert.deepEqual(parse(splitSkillDocument(generated).yaml), {
      name: "plain",
      description: "Effective description",
      metadata: { "opencode/autoinvoke": false },
    });
    assert.equal(splitSkillDocument(generated).body, body, "the original content is retained as the body");
    assert.equal(parseFrontmatter(generated).attributes.metadata["opencode/autoinvoke"], false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("block sequences and deep mappings are preserved by generation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const sourceText = [
      "---",
      "name: Release",
      "description: Original",
      "stages:",
      "  - plan",
      "  - publish",
      "matrix:",
      "  os:",
      "    - linux",
      "    - darwin",
      "---",
      "",
      "Body.",
      "",
    ].join("\n");
    const { generated } = await stageComplexSkill(root, { sourceText });
    const data = parse(splitSkillDocument(generated).yaml);
    assert.deepEqual(data.stages, ["plan", "publish"], "block sequences survive");
    assert.deepEqual(data.matrix, { os: ["linux", "darwin"] }, "nested sequences and mappings survive");
    assert.equal(data.description, "Effective description");
    assert.deepEqual(data.metadata, { "opencode/autoinvoke": false }, "the marker is added when metadata is absent");
    assert.equal(splitSkillDocument(generated).body, splitSkillDocument(sourceText).body);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the staged OpenCode copy keeps merge-inherited metadata keys", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const sourceText = [
      "---",
      "name: Release Display Name",
      "description: Original description",
      "base: &b {tier: 2, owner: platform}",
      "defaults: &d {metadata: *b}",
      "<<: *d",
      "---",
      "",
      "# Release body",
      "",
      "Keep this body verbatim.",
      "",
    ].join("\n");
    const { generated } = await stageComplexSkill(root, { sourceText });

    // The inherited mapping is materialized as an explicit top-level metadata
    // mapping carrying every effective key, then patched.
    const effectiveData = parseDocument(splitSkillDocument(generated).yaml, { merge: true }).toJS();
    assert.deepEqual(effectiveData.metadata, {
      tier: 2,
      owner: "platform",
      "opencode/autoinvoke": false,
    });
    assert.equal(effectiveData.name, "release", "canonical name is still overridden");

    // Merge/anchor constructs outside the materialized metadata are preserved.
    assert.match(generated, /^<<: \*d$/m, "the top-level merge construct survives");
    assert.ok(generated.includes("metadata: *b"), "the nested anchor survives");
    assert.ok(generated.includes("defaults: &d"), "the anchor definition survives");

    // What `check` reads stays compatible: the compact parser sees an explicit
    // metadata mapping with the hidden marker.
    const compact = parseFrontmatter(generated);
    assert.equal(compact.attributes.metadata["opencode/autoinvoke"], false);
    assert.equal(compact.attributes.metadata.tier, 2, "inherited metadata is visible to the compact parser too");
    assert.equal(splitSkillDocument(generated).body, splitSkillDocument(sourceText).body, "the body is unchanged");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("planManagedState is side-effect-free, deterministic, and frozen", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const source = path.join(root, "release", "SKILL.md");
    await mkdir(path.join(root, "release", "references"), { recursive: true });
    await writeFile(source, "---\nname: Release\ndescription: Publish a release\n---\n\nBody.\n");
    await writeFile(path.join(root, "release", "references", "steps.md"), "# steps\n");
    const registry = {
      fingerprint: "f".repeat(64),
      skills: [{ id: "release", name: "release", description: "Publish a release", source, enabled: true }],
    };
    const state = path.join(root, "state");
    const requestDirectory = requestSpool(root);

    const before = await digestTree(root);
    const first = await planManagedState(state, registry, { requestDirectory });
    const second = await planManagedState(state, registry, { requestDirectory });
    assert.deepEqual(first, second, "planning is deterministic");
    assert.deepEqual(await digestTree(root), before, "planning wrote nothing at all");
    assert.equal(await exists(state), false, "no state directory was created");

    assert.ok(Object.isFrozen(first), "the plan is frozen");
    assert.ok(Object.isFrozen(first.skills), "the document list is frozen");
    assert.ok(Object.isFrozen(first.skills[0]), "each document entry is frozen");
    assert.equal(first.stateDirectory, path.resolve(state));
    assert.equal(first.requestDirectory, requestDirectory, "the exact stable request directory is in the plan");
    assert.equal(first.fingerprint, registry.fingerprint, "the plan is tied to the registry");
    assert.deepEqual(first.harnesses, ["opencode"]);
    assert.equal(first.skills[0].relativeFile, path.join("release", "SKILL.md"), "destination is recorded");
    assert.equal(first.skills[0].source, source, "source is recorded");
    assert.deepEqual(first.skills[0].support, {
      source: path.dirname(source),
      skillFile: source,
    }, "support-tree inputs are recorded for execution-time copying");
    assert.ok(first.skills[0].document.includes("opencode/autoinvoke: false"), "the document is already rendered");
    assert.ok(typeof first.routerDocument === "string" && first.routerDocument.includes("name: skill-router"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("staging consumes an injected plan and rejects mismatched plans before writing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const source = path.join(root, "release", "SKILL.md");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "---\nname: Release\ndescription: Publish a release\n---\n\nBody.\n");
    const registry = {
      fingerprint: "f".repeat(64),
      skills: [{ id: "release", name: "release", description: "Publish a release", source, enabled: true }],
    };
    const state = path.join(root, "state");
    const requestDirectory = requestSpool(root);
    const plan = await planManagedState(state, registry, { requestDirectory });

    const staged = await stageManagedState(state, registry, { plan, requestDirectory });
    assert.equal(
      await readFile(path.join(staged.stage, "opencode-skills", "release", "SKILL.md"), "utf8"),
      plan.skills[0].document,
      "staging writes the pre-rendered document byte-for-byte",
    );
    assert.equal(
      await readFile(path.join(staged.stage, "opencode-skills", "skill-router", "SKILL.md"), "utf8"),
      plan.routerDocument,
      "staging writes the pre-rendered router document",
    );
    assert.deepEqual(staged.plan, plan, "the staged plan is the injected plan");
    // Mirrors the transaction, which renames the staged tree into place.
    await rm(staged.stage, { recursive: true, force: true });

    const stageDirectories = async () =>
      (await readdir(root)).filter((entry) => entry.includes(".stage-"));

    // Every mismatch is rejected before any `.stage-*` directory appears.
    const foreignFingerprint = { ...registry, fingerprint: "e".repeat(64) };
    await assert.rejects(
      () => stageManagedState(state, foreignFingerprint, { plan, requestDirectory }),
      /does not match the registry fingerprint/,
    );
    assert.deepEqual(await stageDirectories(), [], "a fingerprint mismatch creates no stage directory");

    await assert.rejects(
      () => stageManagedState(path.join(root, "other"), registry, { plan, requestDirectory }),
      /belongs to another state directory/,
    );
    assert.deepEqual(await stageDirectories(), [], "a foreign state directory creates no stage directory");

    const claudeOnly = buildInstallation({
      global: false,
      stateDirectory: state,
      harnesses: ["claude"],
      claude: { fingerprint: "f".repeat(64), version: "0.1.0" },
    });
    const claudePlan = await planManagedState(state, registry, { installation: claudeOnly, requestDirectory });
    await assert.rejects(
      () =>
        stageManagedState(state, registry, {
          installation: { harnesses: ["opencode"] },
          plan: claudePlan,
          requestDirectory,
        }),
      /does not match the recorded harnesses/,
    );
    assert.deepEqual(await stageDirectories(), [], "a harness mismatch creates no stage directory");

    await assert.rejects(
      () => stageManagedState(state, registry, { plan: { skills: [] }, requestDirectory }),
      /plan is malformed/,
    );
    assert.deepEqual(await stageDirectories(), [], "a malformed plan creates no stage directory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("document generation errors surface identically from planning and staging", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const cases = [
      ["non-map metadata", "---\nname: Release\ndescription: Publish\nmetadata: legacy\n---\nBody.\n", /frontmatter metadata must be a YAML mapping/],
      ["malformed YAML", "---\nbroken: [1,\n---\nBody.\n", /Invalid skill frontmatter/],
      ["duplicate keys", "---\nname: one\nname: two\n---\nBody.\n", /Invalid skill frontmatter/],
    ];
    for (const [label, sourceText, pattern] of cases) {
      const source = path.join(root, `${label.replaceAll(" ", "-")}.md`);
      await writeFile(source, sourceText);
      // The document label is display text; the derived skill ID stays a valid
      // portable ID so the failure under test is the document error.
      const id = label.replaceAll(" ", "-").toLowerCase();
      const registry = {
        fingerprint: "f".repeat(64),
        skills: [{ id, name: "x", description: "d", source, enabled: true }],
      };
      const state = path.join(root, `state-${label.replaceAll(" ", "-")}`);

      const planError = await captureError(() => planManagedState(state, registry, { requestDirectory: requestSpool(root) }));
      assert.match(planError.message, pattern, `${label}: planning rejects it`);
      const stageError = await captureError(() =>
        stageManagedState(state, registry, { requestDirectory: requestSpool(root) }),
      );
      assert.match(stageError.message, pattern, `${label}: staging rejects it`);
      assert.equal(stageError.message, planError.message, `${label}: identical error text`);
    }
    assert.deepEqual(
      (await readdir(root)).filter((entry) => entry.includes(".stage-")),
      [],
      "failed planning and staging leave no stage directories",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reserved and duplicate destinations fail planning and staging identically", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    // Sentinel sources that do not exist: a planner that lost its validation
    // would surface an ENOENT naming the path instead of the fixed refusal.
    const reserved = path.join(root, "sentinel", "skill-router", "SKILL.md");
    const reservedRegistry = {
      fingerprint: "f".repeat(64),
      skills: [{ id: "skill-router", name: "skill-router", description: "Impostor", source: reserved, enabled: true }],
    };
    const reservedState = path.join(root, "state-reserved");
    const reservedOptions = { requestDirectory: requestSpool(root) };
    const planError = await captureError(() => planManagedState(reservedState, reservedRegistry, reservedOptions));
    assert.equal(planError.message, MANAGED_REGISTRY_ID_ERROR, "reserved ID refuses with the fixed message");
    assert.ok(!planError.message.includes("skill-router"), "the reserved ID is never echoed");
    assert.ok(!planError.message.includes(reserved), "the source path is never echoed");
    const stageError = await captureError(() => stageManagedState(reservedState, reservedRegistry, reservedOptions));
    assert.equal(stageError.message, planError.message, "reserved ID rejects identically");

    // Case variants are invalid grammar and reject at validation; exact
    // duplicates are individually valid and reach the retained collision
    // defense-in-depth check. Both reject identically from plan and stage.
    const upper = path.join(root, "upper", "Release", "SKILL.md");
    const lower = path.join(root, "lower", "release", "SKILL.md");
    const duplicate = path.join(root, "duplicate.md");
    await mkdir(path.dirname(upper), { recursive: true });
    await mkdir(path.dirname(lower), { recursive: true });
    await writeFile(upper, "---\nname: Release\ndescription: Upper\n---\n\nBody.\n");
    await writeFile(lower, "---\nname: release\ndescription: Lower\n---\n\nBody.\n");
    await writeFile(duplicate, "---\ndescription: Duplicate\n---\n\nBody.\n");
    const caseRegistry = {
      fingerprint: "f".repeat(64),
      skills: [
        { id: "Release", name: "Release", description: "Upper", source: upper, enabled: true },
        { id: "release", name: "release", description: "Lower", source: lower, enabled: true },
      ],
    };
    const caseState = path.join(root, "state-case");
    const casePlanError = await captureError(() =>
      planManagedState(caseState, caseRegistry, { requestDirectory: requestSpool(root) }),
    );
    assert.equal(casePlanError.message, MANAGED_REGISTRY_ID_ERROR, "case variants refuse at validation");
    const caseStageError = await captureError(() =>
      stageManagedState(caseState, caseRegistry, { requestDirectory: requestSpool(root) }),
    );
    assert.equal(caseStageError.message, casePlanError.message, "case variants reject identically");

    const duplicateRegistry = {
      fingerprint: "f".repeat(64),
      skills: [
        { id: "release", name: "release", description: "First", source: duplicate, enabled: true },
        { id: "release", name: "release", description: "Second", source: duplicate, enabled: true },
      ],
    };
    const duplicateState = path.join(root, "state-duplicate");
    const duplicatePlanError = await captureError(() =>
      planManagedState(duplicateState, duplicateRegistry, { requestDirectory: requestSpool(root) }),
    );
    assert.match(duplicatePlanError.message, /collide on case-insensitive filesystems/);
    const duplicateStageError = await captureError(() =>
      stageManagedState(duplicateState, duplicateRegistry, { requestDirectory: requestSpool(root) }),
    );
    assert.equal(duplicateStageError.message, duplicatePlanError.message, "collisions reject identically");

    assert.deepEqual(
      (await readdir(root)).filter((entry) => entry.includes(".stage-")),
      [],
      "rejected plans leave no stage directories",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude-only planning skips OpenCode rendering while all-harness planning performs it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    // Valid for discovery and for the Claude renderer, invalid for the OpenCode
    // renderer (non-mapping metadata), so it proves which path ran.
    const source = path.join(root, "release", "SKILL.md");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(
      source,
      "---\nname: Release\ndescription: Publish releases\nmetadata: legacy-string\n---\n\nBody.\n",
    );
    const registry = {
      fingerprint: "f".repeat(64),
      skills: [{ id: "release", name: "release", description: "Publish releases", source, enabled: true }],
    };
    const state = path.join(root, "state");
    const claudeInstallation = buildInstallation({
      global: false,
      stateDirectory: state,
      harnesses: ["claude"],
      claude: { fingerprint: "f".repeat(64), version: "0.1.0" },
    });
    const allInstallation = buildInstallation({
      global: false,
      stateDirectory: state,
      harnesses: ["opencode", "claude"],
      claude: { fingerprint: "f".repeat(64), version: "0.1.0" },
    });

    const claudePlan = await planManagedState(state, registry, {
      installation: claudeInstallation,
      requestDirectory: requestSpool(root),
    });
    assert.deepEqual(claudePlan.skills, [], "no OpenCode document is rendered for Claude-only");
    assert.equal(claudePlan.routerDocument, null, "no router document is rendered for Claude-only");
    assert.deepEqual(claudePlan.harnesses, ["claude"]);
    assert.equal(claudePlan.requestDirectory, requestSpool(root), "the request directory stays a plan input");

    const allHarnessError = await captureError(() =>
      planManagedState(state, registry, { installation: allInstallation, requestDirectory: requestSpool(root) }),
    );
    assert.match(allHarnessError.message, /frontmatter metadata must be a YAML mapping/, "all-harness planning does render");

    // Claude-only staging writes no OpenCode tree at all.
    const staged = await stageManagedState(state, registry, {
      installation: claudeInstallation,
      plan: claudePlan,
      requestDirectory: requestSpool(root),
    });
    assert.equal(await exists(path.join(staged.stage, "opencode-skills")), false, "no OpenCode tree for Claude-only");
    assert.deepEqual(
      (await readdir(staged.stage)).sort(),
      [".skill-router-owned", "installation.json", "registry.json"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ================================================================== *
 * Phase 8 - defense-in-depth registry public-ID validation
 * ================================================================== */

/**
 * Every registry public-ID surface the planner may consume or interpolate is
 * validated before any source read or filesystem work. Sentinel sources below
 * do not exist: without planner validation these cases would surface an
 * ENOENT naming the path (or construct an unsafe destination) instead of the
 * fixed, bounded refusal.
 */
const ID_FAILURE_CASES = [
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

test("planManagedState rejects every malformed registry public ID before any source read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  const sentinel = path.join(root, "sentinel", "never-read.md");
  try {
    for (const [label, id] of ID_FAILURE_CASES) {
      const registry = {
        fingerprint: "f".repeat(64),
        skills: [{ id, name: id, description: "Hostile", source: sentinel, enabled: true }],
      };
      const error = await assertManagedIdRejection(() =>
        planManagedState(path.join(root, "state"), registry, { requestDirectory: requestSpool(root) }),
      );
      assert.ok(!error.message.includes(sentinel), `${label}: the sentinel source path is never echoed`);
      assert.ok(!error.message.includes(id), `${label}: the invalid ID is never echoed`);
      assert.ok(error.message.length < 100, `${label}: the message stays bounded`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("planManagedState validates reserved, handoff, workflow, and step IDs before any source read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  const sentinel = path.join(root, "sentinel", "never-read.md");
  try {
    const skill = (id, extra = {}) => ({
      id,
      name: id,
      description: "Hostile",
      source: sentinel,
      enabled: true,
      ...extra,
    });
    const cases = [
      ["reserved skill ID", { skills: [skill("skill-router")] }],
      ["invalid handoff target", { skills: [skill("release", { handoffTo: ["Bad/Target"] })] }],
      ["non-array handoff list", { skills: [skill("release", { handoffTo: "release" })] }],
      [
        "invalid workflow ID",
        { skills: [skill("release")], workflows: [{ id: "Ship/It", steps: [{ skill: "release" }] }] },
      ],
      [
        "invalid workflow step",
        { skills: [skill("release")], workflows: [{ id: "ship", steps: [{ skill: "Release It" }] }] },
      ],
      ["non-object workflow", { skills: [skill("release")], workflows: ["ship"] }],
      ["non-array steps", { skills: [skill("release")], workflows: [{ id: "ship", steps: "release" }] }],
      ["non-object skill entry", { skills: [null] }],
      ["non-array skills", { skills: "release" }],
      ["non-array workflows", { workflows: "ship" }],
    ];
    for (const [label, surfaces] of cases) {
      const registry = { fingerprint: "f".repeat(64), ...surfaces };
      const error = await assertManagedIdRejection(() =>
        planManagedState(path.join(root, "state"), registry, { requestDirectory: requestSpool(root) }),
      );
      assert.ok(!error.message.includes(sentinel), `${label}: the sentinel source path is never echoed`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("huge and control-character IDs never reach the managed refusal or its stack", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  const sentinel = path.join(root, "sentinel", "never-read.md");
  const huge = "x".repeat(100_000);
  const control = `claude\u0001\u001b[31m${"y".repeat(50)}`;
  try {
    for (const id of [huge, control]) {
      const registry = {
        fingerprint: "f".repeat(64),
        skills: [{ id, name: id, description: "Hostile", source: sentinel, enabled: true }],
      };
      const error = await assertManagedIdRejection(() =>
        planManagedState(path.join(root, "state"), registry, { requestDirectory: requestSpool(root) }),
      );
      const surface = `${error.message}\n${error.stack ?? ""}`;
      assert.ok(!surface.includes(huge), "the huge ID never reaches the message or stack");
      assert.ok(!surface.includes("\u001b[31m"), "control sequences never reach the message or stack");
      assert.ok(error.message.length < 100, "the refusal stays bounded");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("valid managed IDs accept the 1/64 boundaries and permitted router-adjacent names", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const writeSource = async (id) => {
      const source = path.join(root, "sources", `${id}.md`);
      await mkdir(path.dirname(source), { recursive: true });
      await writeFile(source, `---\ndescription: Skill ${id}\n---\n\nBody.\n`);
      return source;
    };
    const shortest = await writeSource("shortest");
    const longestId = "l".repeat(64);
    const longest = path.join(root, "sources", longestId, "SKILL.md");
    await mkdir(path.dirname(longest), { recursive: true });
    await writeFile(longest, "---\ndescription: Longest\n---\n\nBody.\n");
    // Names a router may reasonably carry are not reserved: only the exact
    // `skill-router` ID is.
    const permitted = [
      "synced",
      "anthropic-skills",
      "anthropic",
      "claude",
      "claude-helper",
      "verify",
      "simplify",
      "doctor",
    ];
    const permittedSources = new Map();
    for (const id of permitted) permittedSources.set(id, await writeSource(id));

    const registry = {
      fingerprint: "f".repeat(64),
      skills: [
        { id: "a", name: "a", description: "Shortest", source: shortest, enabled: true },
        { id: longestId, name: longestId, description: "Longest", source: longest, enabled: true },
        ...permitted.map((id) => ({
          id,
          name: id,
          description: `Permitted ${id}`,
          source: permittedSources.get(id),
          enabled: true,
        })),
      ],
      workflows: [{ id: "ship-it", steps: [{ skill: "a" }, { skill: longestId }] }],
    };
    const state = path.join(root, "state");
    const plan = await planManagedState(state, registry, { requestDirectory: requestSpool(root) });
    const byId = new Map(plan.skills.map((entry) => [entry.id, entry]));
    assert.equal(byId.get("a").relativeFile, "a.md", "the 1-char ID keeps its canonical file destination");
    assert.equal(
      byId.get(longestId).relativeFile,
      path.join(longestId, "SKILL.md"),
      "the 64-char ID keeps its canonical directory destination",
    );
    for (const id of permitted) {
      assert.equal(byId.get(id).relativeFile, `${id}.md`, `${id} plans with its canonical destination`);
    }
    assert.equal(plan.skills.length, 10, "every valid skill is planned");

    // The same registry with one extra character rejects boundedly.
    const overlong = {
      ...registry,
      skills: [...registry.skills, { id: "l".repeat(65), source: longest, enabled: true }],
    };
    await assertManagedIdRejection(() =>
      planManagedState(path.join(root, "state-overlong"), overlong, { requestDirectory: requestSpool(root) }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude-only managed planning validates every routing surface it does not emit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  const sentinel = path.join(root, "sentinel", "never-read.md");
  try {
    const state = path.join(root, "state");
    const claudeOnly = buildInstallation({
      global: false,
      stateDirectory: state,
      harnesses: ["claude"],
      claude: { fingerprint: "f".repeat(64), version: "0.1.0" },
    });
    const options = { installation: claudeOnly, requestDirectory: requestSpool(root) };
    // A Claude-only plan emits no OpenCode documents, but the registry's
    // workflow and step surfaces are still validated: Claude router
    // instructions and future managed planning consume them.
    await assertManagedIdRejection(() =>
      planManagedState(state, {
        fingerprint: "f".repeat(64),
        skills: [{ id: "release", name: "release", description: "Valid", source: sentinel, enabled: true }],
        workflows: [{ id: "ship", steps: [{ skill: "Bad Step" }] }],
      }, options),
    );
    await assertManagedIdRejection(() =>
      planManagedState(state, {
        fingerprint: "f".repeat(64),
        skills: [{ id: "skill-router", name: "router", description: "Impostor", source: sentinel, enabled: true }],
      }, options),
    );
    // A fully valid registry with workflows still plans Claude-only without
    // touching the sentinel source.
    const plan = await planManagedState(state, {
      fingerprint: "f".repeat(64),
      skills: [{ id: "release", name: "release", description: "Valid", source: sentinel, enabled: true }],
      workflows: [{ id: "ship", steps: [{ skill: "release" }] }],
    }, options);
    assert.deepEqual(plan.skills, [], "no OpenCode document is rendered for Claude-only");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("staging rejects an injected plan with hostile IDs or destinations before any write", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const source = path.join(root, "release", "SKILL.md");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "---\nname: Release\ndescription: Publish a release\n---\n\nBody.\n");
    const registry = {
      fingerprint: "f".repeat(64),
      skills: [{ id: "release", name: "release", description: "Publish a release", source, enabled: true }],
    };
    const state = path.join(root, "state");
    const requestDirectory = requestSpool(root);
    const plan = await planManagedState(state, registry, { requestDirectory });
    const stageDirectories = async () => (await readdir(root)).filter((entry) => entry.includes(".stage-"));

    // A hand-built plan interpolates its own IDs and relative destinations
    // into staged paths, so the plan tie-in re-validates them pre-write: an
    // invalid public ID refuses with the fixed planning message, and a
    // non-canonical destination refuses as a malformed plan.
    const hostileId = { ...plan, skills: [{ ...plan.skills[0], id: "../../escape" }] };
    const idError = await captureError(() =>
      stageManagedState(state, registry, { plan: hostileId, requestDirectory }),
    );
    assert.equal(idError.message, MANAGED_REGISTRY_ID_ERROR, "a hostile plan ID uses the fixed refusal");
    assert.ok(!idError.message.includes("../../escape"), "the hostile ID is never echoed");

    const hostileDestination = {
      ...plan,
      skills: [{ ...plan.skills[0], relativeFile: path.join("..", "..", "escape.md") }],
    };
    await assert.rejects(
      () => stageManagedState(state, registry, { plan: hostileDestination, requestDirectory }),
      /plan is malformed/,
    );
    assert.deepEqual(await stageDirectories(), [], "a hostile injected plan creates no stage directory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("staging refuses a matching-fingerprint plan whose registry routing surfaces are poisoned", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const source = path.join(root, "release", "SKILL.md");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "---\nname: Release\ndescription: Publish a release\n---\n\nBody.\n");
    const registry = {
      fingerprint: "f".repeat(64),
      skills: [{ id: "release", name: "release", description: "Publish a release", source, enabled: true }],
    };
    const state = path.join(root, "state");
    const requestDirectory = requestSpool(root);
    // One valid plan, tied to the clean registry's fingerprint. Every poisoned
    // registry below keeps that exact fingerprint, so the plan tie-in's
    // fingerprint, harness, path, and canonical-destination checks all pass —
    // only the unconditional staging-entry registry assertion can refuse.
    const plan = await planManagedState(state, registry, { requestDirectory });
    const sentinel = path.join(root, "sentinel", "never-read.md");
    const poisoned = [
      [
        "handoff target",
        {
          ...registry,
          skills: [{ ...registry.skills[0], handoffTo: ["Bad/Target"], source: sentinel }],
        },
      ],
      [
        "workflow ID",
        { ...registry, workflows: [{ id: "Ship/It", steps: [{ skill: "release" }] }] },
      ],
      [
        "workflow step skill",
        { ...registry, workflows: [{ id: "ship", steps: [{ skill: "Release It" }] }] },
      ],
      ["malformed skills shape", { ...registry, skills: "release" }],
    ];
    const stageDirectories = async () => (await readdir(root)).filter((entry) => entry.includes(".stage-"));

    for (const [label, poisonedRegistry] of poisoned) {
      assert.equal(poisonedRegistry.fingerprint, registry.fingerprint, `${label}: the fingerprint still matches`);

      // Ordinary generated stage path: the refusal happens before any
      // `.stage-*` directory exists.
      const generatedError = await captureError(() =>
        stageManagedState(state, poisonedRegistry, { plan, requestDirectory }),
      );
      assert.equal(generatedError.message, MANAGED_REGISTRY_ID_ERROR, `${label}: the fixed refusal`);
      assert.ok(!generatedError.message.includes("Bad"), `${label}: poisoned values are never echoed`);
      assert.ok(!generatedError.message.includes(sentinel), `${label}: the sentinel source is never echoed`);
      assert.deepEqual(await stageDirectories(), [], `${label}: no generated stage directory appears`);

      // Journaled stage path: the exact stage directory is never created.
      const exactStage = path.join(root, `stage-${label.replaceAll(" ", "-")}`);
      const journaledError = await captureError(() =>
        stageManagedState(state, poisonedRegistry, { plan, requestDirectory, stageDirectory: exactStage }),
      );
      assert.equal(journaledError.message, MANAGED_REGISTRY_ID_ERROR, `${label}: the fixed refusal (journaled)`);
      assert.equal(await exists(exactStage), false, `${label}: the exact stage directory is never created`);
      assert.deepEqual(await stageDirectories(), [], `${label}: no generated stage directory appears`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ================================================================== *
 * Phase 6 - journaled staging and bounded state-tree inspection
 * ================================================================== */

async function stageSource(root) {
  const source = path.join(root, "release", "SKILL.md");
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, "---\nname: Release\ndescription: Publish a release\n---\n\nBody.\n");
  return {
    skills: [{ id: "release", name: "release", description: "Publish a release", source, enabled: true }],
  };
}

test("journaled staging writes the exact stage directory with owner-only modes, identity, and digest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const registry = await stageSource(root);
    const state = path.join(root, "state");
    const requestDirectory = requestSpool(root);
    const exact = path.join(state).replace(/state$/, ".state.stage-tx1");

    const staged = await stageManagedState(state, registry, { stageDirectory: exact, requestDirectory });
    assert.equal(staged.stage, exact, "the exact requested path is used");
    assert.equal(staged.journaled, true);
    const siblings = (await readdir(root)).filter((name) => name.includes(".stage-"));
    assert.deepEqual(siblings, [path.basename(exact)], "no random sibling stage directory is created");

    // Owner-only modes everywhere the journaled path controls.
    const marker = await lstat(path.join(exact, STATE_MARKER_FILE));
    assert.equal(marker.mode & 0o777, 0o600, "the marker is owner-only");
    const registryStat = await lstat(path.join(exact, "registry.json"));
    assert.equal(registryStat.mode & 0o777, 0o600, "registry.json is owner-only");
    const skillsStat = await lstat(path.join(exact, "opencode-skills"));
    assert.equal(skillsStat.mode & 0o777, 0o700, "directories are owner-only");
    const skillStat = await lstat(path.join(exact, "opencode-skills", "release", "SKILL.md"));
    assert.equal(skillStat.mode & 0o777, 0o600, "generated skills are owner-only");

    // No-follow identity plus a deterministic tree-manifest digest.
    assert.equal(staged.identity.ino, Number((await lstat(exact)).ino));
    assert.equal(staged.identity.dev, Number((await lstat(exact)).dev));
    assert.match(staged.digest, /^[0-9a-f]{64}$/);

    const again = path.join(state).replace(/state$/, ".state.stage-tx2");
    const second = await stageManagedState(state, registry, { stageDirectory: again, requestDirectory });
    assert.equal(second.digest, staged.digest, "the tree digest is deterministic across runs");
    assert.notEqual(second.identity.ino, staged.identity.ino, "identity is per directory");
    const owned = await inspectStateTree(exact);
    assert.equal(owned.status, "owned");
    assert.equal(owned.digest, staged.digest, "inspection reproduces the staged digest");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("journaled staging refuses a preexisting stage path before writing anything", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const registry = await stageSource(root);
    const state = path.join(root, "state");
    const requestDirectory = requestSpool(root);
    const directory = path.join(root, ".state.stage-existing");
    await mkdir(directory);
    await writeFile(path.join(directory, "keep.txt"), "keep");
    await assert.rejects(
      () => stageManagedState(state, registry, { stageDirectory: directory, requestDirectory }),
      /reuse an existing stage directory/,
    );
    assert.deepEqual(await readdir(directory), ["keep.txt"], "an existing directory is untouched");

    const fileStage = path.join(root, ".state.stage-file");
    await writeFile(fileStage, "not a directory");
    await assert.rejects(
      () => stageManagedState(state, registry, { stageDirectory: fileStage, requestDirectory }),
      /existing stage/,
    );
    assert.equal(await readFile(fileStage, "utf8"), "not a directory");

    const linkTarget = path.join(root, "elsewhere");
    await mkdir(linkTarget);
    const linkStage = path.join(root, ".state.stage-link");
    await symlink(linkTarget, linkStage);
    await assert.rejects(
      () => stageManagedState(state, registry, { stageDirectory: linkStage, requestDirectory }),
      /existing stage/,
    );
    assert.deepEqual(await readdir(linkTarget), [], "the symlink target receives nothing");

    const nested = path.join(state, ".state.stage-nested");
    await assert.rejects(
      () => stageManagedState(state, registry, { stageDirectory: nested, requestDirectory }),
      /must not live inside the state directory/,
    );
    await assert.rejects(
      () => stageManagedState(state, registry, { stageDirectory: state, requestDirectory }),
      /must differ from the state directory/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("journaled staging refuses symlinked and special support entries while legacy staging skips them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const source = path.join(root, "skills", "demo", "SKILL.md");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "---\nname: demo\ndescription: Demo\n---\n\nBody.\n");
    const secret = path.join(root, "secret.txt");
    await writeFile(secret, "not staged");
    await symlink(secret, path.join(path.dirname(source), "linked.md"));
    const pipe = path.join(path.dirname(source), "pipe");
    const fifo = spawnSync("mkfifo", [pipe]);
    const registry = { skills: [{ id: "demo", name: "demo", description: "Demo", source, enabled: true }] };
    const state = path.join(root, "state");
    const requestDirectory = requestSpool(root);

    // Legacy behavior is preserved: symlinks and special files in a support
    // tree are skipped, never staged and never refused.
    const legacy = await stageManagedState(state, registry, { requestDirectory });
    assert.equal(await exists(path.join(legacy.stage, "opencode-skills", "demo", "linked.md")), false);
    if (fifo.status === 0) {
      assert.equal(await exists(path.join(legacy.stage, "opencode-skills", "demo", "pipe")), false);
    }
    await rm(legacy.stage, { recursive: true, force: true });

    const exact = path.join(root, ".state.stage-linked");
    await assert.rejects(
      () => stageManagedState(state, registry, { stageDirectory: exact, requestDirectory }),
      /symbolic link/,
    );
    assert.equal(await exists(exact), false, "a refused journaled stage is removed");

    if (fifo.status === 0) {
      // Drop the symlink so the refusal can only come from the special file.
      await rm(path.join(path.dirname(source), "linked.md"));
      const specialStage = path.join(root, ".state.stage-special");
      await assert.rejects(
        () => stageManagedState(state, registry, { stageDirectory: specialStage, requestDirectory }),
        /special file/,
      );
      assert.equal(await exists(specialStage), false, "a refused journaled stage is removed");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function ownedTree(root, name, { marker = `${STATE_MARKER_CONTENT}\n`, files = { "a.txt": "a" } } = {}) {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  if (marker !== null) await writeFile(path.join(directory, STATE_MARKER_FILE), marker, { mode: 0o600 });
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(directory, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { mode: 0o600 });
  }
  return directory;
}

test("inspectStateTree is bounded, no-follow, and classifies foreign trees without touching them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const missing = path.join(root, "nope");
    assert.deepEqual(await inspectStateTree(missing), { status: "absent", path: path.resolve(missing) });

    const owned = await ownedTree(root, "owned", { files: { "registry.json": "{}", "deep/nested.txt": "x" } });
    const info = await inspectStateTree(owned);
    assert.equal(info.status, "owned");
    assert.match(info.digest, /^[0-9a-f]{64}$/);
    assert.equal(info.entries, 4, "marker, registry.json, the deep directory, and its file");
    assert.deepEqual([...info.files].sort(), [STATE_MARKER_FILE, "deep/nested.txt", "registry.json"]);
    assert.deepEqual(await inspectStateTree(owned), info, "inspection is deterministic");

    // Symlinked root, unowned content, wrong marker, and symlink entries.
    const linkTarget = await ownedTree(root, "link-target");
    const linkedRoot = path.join(root, "linked-root");
    await symlink(linkTarget, linkedRoot);
    assert.equal((await inspectStateTree(linkedRoot)).status, "foreign");

    const unowned = path.join(root, "unowned");
    await mkdir(unowned);
    assert.equal((await inspectStateTree(unowned)).status, "foreign");

    const wrongMarker = await ownedTree(root, "wrong-marker", { marker: "something-else\n" });
    assert.equal((await inspectStateTree(wrongMarker)).status, "foreign");

    const symlinked = await ownedTree(root, "with-link");
    await symlink(path.join(symlinked, STATE_MARKER_FILE), path.join(symlinked, "escape.txt"));
    const linkResult = await inspectStateTree(symlinked);
    assert.equal(linkResult.status, "foreign");
    assert.match(linkResult.reason, /symbolic link/);

    const worldWritable = await ownedTree(root, "writable");
    await chmod(path.join(worldWritable, "a.txt"), 0o666);
    const writableResult = await inspectStateTree(worldWritable);
    assert.equal(writableResult.status, "foreign");
    assert.match(writableResult.reason, /group or other/);
    assert.equal((await readFile(path.join(worldWritable, "a.txt"), "utf8")), "a", "foreign content is preserved");

    // Bounds fail closed instead of walking forever.
    const bounded = await ownedTree(root, "bounded", { files: { one: "1", two: "2", three: "3" } });
    const limited = await inspectStateTree(bounded, { limits: { maxEntries: 2 } });
    assert.equal(limited.status, "foreign");
    assert.match(limited.reason, /entries/);
    const depthLimited = await inspectStateTree(owned, { limits: { maxDepth: 1 } });
    assert.equal(depthLimited.status, "foreign");

    // A special file (best effort where mkfifo exists) refuses as foreign.
    const special = await ownedTree(root, "special");
    const created = spawnSync("mkfifo", [path.join(special, "pipe")]);
    if (created.status === 0) {
      const specialResult = await inspectStateTree(special);
      assert.equal(specialResult.status, "foreign");
      assert.match(specialResult.reason, /special file/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("classifyStateArtifact reports absent, expected-before, expected-desired, and foreign", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const canonical = await ownedTree(root, "canonical", { files: { "registry.json": "prior" } });
    const staged = await ownedTree(root, "staged", { files: { "registry.json": "desired" } });
    const beforeInfo = await inspectStateTree(canonical);
    const desiredInfo = await inspectStateTree(staged);

    assert.equal(await classifyStateArtifact(path.join(root, "missing"), {}), "absent");
    assert.equal(
      await classifyStateArtifact(canonical, { before: { identity: beforeInfo.identity, digest: beforeInfo.digest } }),
      "expected-before",
    );
    assert.equal(
      await classifyStateArtifact(canonical, { desired: { identity: beforeInfo.identity, digest: beforeInfo.digest } }),
      "expected-desired",
    );
    // A digest that matches but an identity that does not is foreign: identity
    // is what proves a directory survived the same-parent rename.
    assert.equal(
      await classifyStateArtifact(canonical, {
        before: { identity: desiredInfo.identity, digest: beforeInfo.digest },
      }),
      "foreign",
    );
    assert.equal(
      await classifyStateArtifact(canonical, { before: { digest: desiredInfo.digest } }),
      "foreign",
      "content that matches neither recorded expectation is foreign",
    );
    assert.equal(await classifyStateArtifact(staged, { before: { identity: beforeInfo.identity } }), "foreign");
    assert.equal((await lstat(canonical)).isDirectory(), true, "classification never removes anything");
    assert.equal((await lstat(staged)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectStateTree rejects group/other-writable roots while readable legacy modes stay attributable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    if (process.platform !== "win32") {
      // Owner-safe legacy modes remain attributable: readable is fine, only
      // group/other WRITABLE roots are refused.
      const legacy = await ownedTree(root, "legacy-root", { files: { "registry.json": "{}" } });
      await chmod(path.join(legacy, "registry.json"), 0o644);
      await chmod(legacy, 0o755);
      const legacyInfo = await inspectStateTree(legacy);
      assert.equal(legacyInfo.status, "owned", "0755 roots and 0644 files stay attributable");

      // A group/other-writable root could be rewritten between classification
      // and a later rename, so it fails closed and is never modified.
      const writable = await ownedTree(root, "writable-root");
      await chmod(writable, 0o777);
      const info = await inspectStateTree(writable);
      assert.equal(info.status, "foreign");
      assert.match(info.reason, /writable by group or other/);
      assert.equal((await lstat(writable)).isDirectory(), true, "the foreign root is preserved");
      await chmod(writable, 0o700);
      assert.equal((await inspectStateTree(writable)).status, "owned", "restoring the mode restores attribution");

      // Nested entries keep the same owner-safe rule.
      const inner = await ownedTree(root, "inner-writable", { files: { "deep/x.txt": "y" } });
      await chmod(path.join(inner, "deep"), 0o777);
      const innerInfo = await inspectStateTree(inner);
      assert.equal(innerInfo.status, "foreign");
      assert.match(innerInfo.reason, /writable by group or other/);
    } else {
      const owned = await ownedTree(root, "owned");
      assert.equal((await inspectStateTree(owned)).status, "owned");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ================================================================== *
 * Phase 7 — stable request-spool planning input, exact generated-state
 * modes, and the read-only confidentiality inspector
 * ================================================================== */

/** Exact-mode enforcement is only claimable where uid and mode bits mean something. */
const POSIX = fileModeBitsMeaningful() && typeof process.getuid === "function";

/** Owner-private tree: every directory 0700, every file 0600, no marker needed. */
async function confidentialTree(root, name, files = { "a.txt": "a" }) {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(directory, relative);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { mode: 0o600 });
  }
  return directory;
}

/** Every entry of a tree with its full permission bits, root first. */
async function collectModes(directory) {
  const entries = [];
  entries.push({ path: ".", kind: "directory", mode: (await lstat(directory)).mode & 0o7777 });
  const walk = async (current, relative) => {
    const children = [...(await readdir(current, { withFileTypes: true }))].sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of children) {
      const absolute = path.join(current, entry.name);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        entries.push({ path: name, kind: "directory", mode: (await lstat(absolute)).mode & 0o7777 });
        await walk(absolute, name);
      } else {
        entries.push({ path: name, kind: "file", mode: (await lstat(absolute)).mode & 0o7777 });
      }
    }
  };
  await walk(directory, "");
  return entries;
}

function sampleCodes(info) {
  return new Map(info.samples.map((sample) => [sample.path, sample.code]));
}

test("generated OpenCode router instructions use the exact stable request directory, never <state>/requests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const source = path.join(root, "source.md");
    await writeFile(source, "source\n");
    const state = path.join(root, "state");
    const requestDirectory = requestSpool(root);
    const registry = { skills: [{ id: "source", name: "source", description: "Source", source, enabled: true }] };

    const plan = await planManagedState(state, registry, { requestDirectory });
    assert.equal(plan.requestDirectory, requestDirectory, "the frozen plan carries the request directory");
    assert.ok(Object.isFrozen(plan), "the plan stays frozen");
    assert.ok(plan.routerDocument.includes(`\`${requestDirectory}/<token>.txt\``), "the exact absolute spool path is generated");

    const retired = `${path.join(state, "requests")}/`;
    assert.equal(plan.routerDocument.includes(retired), false, "the retired <state>/requests spool is gone");
    assert.equal(plan.routerDocument.includes(`${state}/requests`), false);

    // The confidentiality wording the harness depends on (whitespace-flattened
    // so re-wrapping the prose does not break the contract).
    const flat = plan.routerDocument.replace(/\s+/g, " ");
    for (const phrase of [
      "32-char lowercase hexadecimal token",
      "filesystem write or patch (never a shell command)",
      "create only that file",
      "never create or replace the directory",
      "atomically claims it, owner-normalizes it, reads it, and consumes it",
      "Never put request text in the route command or any shell command",
    ]) {
      assert.ok(flat.includes(phrase), `router instructions must say: ${JSON.stringify(phrase)}`);
    }

    // What a staged harness actually reads carries exactly the same location.
    const staged = await stageManagedState(state, registry, { requestDirectory });
    const text = await readFile(path.join(staged.stage, "opencode-skills", "skill-router", "SKILL.md"), "utf8");
    assert.ok(text.includes(`\`${requestDirectory}/<token>.txt\``));
    assert.equal(text.includes(`${state}/requests`), false);
    assert.ok(text.length / 4 < 300, "router skill should remain below the 300-token estimate");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("planning and staging require an exact absolute request directory and write nothing when it is missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const source = path.join(root, "source.md");
    await writeFile(source, "source\n");
    const state = path.join(root, "state");
    const registry = {
      fingerprint: "f".repeat(64),
      skills: [{ id: "source", name: "source", description: "Source", source, enabled: true }],
    };

    await assert.rejects(() => planManagedState(state, registry), /requires options\.requestDirectory/);
    await assert.rejects(() => planManagedState(state, registry, {}), /requestDirectory/);
    await assert.rejects(() => planManagedState(state, registry, { requestDirectory: "" }), /requestDirectory/);
    await assert.rejects(
      () => planManagedState(state, registry, { requestDirectory: "relative/spool" }),
      /absolute options\.requestDirectory/,
    );
    await assert.rejects(
      () => planManagedState(state, registry, { requestDirectory: path.join("nested", "spool") }),
      /absolute options\.requestDirectory/,
    );

    // Direct staging plans internally, so it inherits the same requirement.
    await assert.rejects(() => stageManagedState(state, registry), /requestDirectory/);
    await assert.rejects(() => stageManagedState(state, registry, { requestDirectory: "relative/spool" }), /absolute/);

    assert.equal(await exists(state), false, "no state directory was created");
    assert.deepEqual(
      (await readdir(root)).filter((entry) => entry.includes(".stage-")),
      [],
      "a rejected plan creates no stage directory",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an injected plan for another or missing request directory is rejected before any filesystem work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const source = path.join(root, "source.md");
    await writeFile(source, "source\n");
    const state = path.join(root, "state");
    const requestDirectory = requestSpool(root);
    const registry = {
      fingerprint: "f".repeat(64),
      skills: [{ id: "source", name: "source", description: "Source", source, enabled: true }],
    };
    const plan = await planManagedState(state, registry, { requestDirectory });

    const staged = await stageManagedState(state, registry, { plan, requestDirectory });
    assert.equal(
      await readFile(path.join(staged.stage, "opencode-skills", "skill-router", "SKILL.md"), "utf8"),
      plan.routerDocument,
      "a matching plan still stages its pre-rendered router document",
    );
    await rm(staged.stage, { recursive: true, force: true });

    const stageDirectories = async () => (await readdir(root)).filter((entry) => entry.includes(".stage-"));

    await assert.rejects(
      () => stageManagedState(state, registry, { plan, requestDirectory: path.join(root, "elsewhere-requests") }),
      /belongs to another request directory/,
    );
    assert.deepEqual(await stageDirectories(), [], "a foreign request directory creates no stage directory");

    await assert.rejects(() => stageManagedState(state, registry, { plan }), /requires options\.requestDirectory/);
    assert.deepEqual(await stageDirectories(), [], "a missing request directory creates no stage directory");

    const { requestDirectory: _dropped, ...planWithoutRequestDirectory } = plan;
    await assert.rejects(
      () => stageManagedState(state, registry, { plan: planWithoutRequestDirectory, requestDirectory }),
      /does not record an absolute request directory/,
    );
    assert.deepEqual(await stageDirectories(), [], "a plan without a request directory creates no stage directory");

    const relativePlan = { ...plan, requestDirectory: "relative/spool" };
    await assert.rejects(
      () => stageManagedState(state, registry, { plan: relativePlan, requestDirectory }),
      /does not record an absolute request directory/,
    );
    assert.deepEqual(await stageDirectories(), [], "a relative plan request directory creates no stage directory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a completed staged tree is exactly 0700/0600 whatever the support source modes were", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const skillDirectory = path.join(root, "skills", "demo");
    await mkdir(path.join(skillDirectory, "references", "deep"), { recursive: true });
    const skillSource = path.join(skillDirectory, "SKILL.md");
    await writeFile(skillSource, "---\nname: demo\ndescription: Demo\n---\n\nBody.\n");
    const supportSources = [
      ["references/readme.md", "readme\n", 0o644],
      ["references/data.json", '{"a":1}\n', 0o666],
      ["references/deep/steps.md", "# steps\n", 0o755],
      ["references/run.sh", "#!/bin/sh\necho hi\n", 0o755],
    ];
    for (const [relative, content, mode] of supportSources) {
      const target = path.join(skillDirectory, relative);
      await writeFile(target, content);
      await chmod(target, mode);
    }
    const registry = { skills: [{ id: "demo", name: "demo", description: "Demo", source: skillSource, enabled: true }] };
    const state = path.join(root, "state");
    const requestDirectory = requestSpool(root);
    const plan = await planManagedState(state, registry, { requestDirectory });

    if (!POSIX) return;

    for (const [label, stageOptions] of [
      ["journaled", { stageDirectory: path.join(root, ".state.stage-exact") }],
      ["direct", {}],
    ]) {
      const staged = await stageManagedState(state, registry, { ...stageOptions, requestDirectory });
      for (const entry of await collectModes(staged.stage)) {
        assert.equal(
          entry.mode,
          entry.kind === "directory" ? 0o700 : 0o600,
          `${label}: ${entry.path} must be exactly owner-only, got ${entry.mode.toString(8)}`,
        );
      }
      for (const [relative, content] of supportSources) {
        assert.equal(
          await readFile(path.join(staged.stage, "opencode-skills", "demo", relative), "utf8"),
          content,
          `${label}: ${relative} keeps its exact bytes`,
        );
      }
      assert.equal(
        await readFile(path.join(staged.stage, "opencode-skills", "demo", "SKILL.md"), "utf8"),
        plan.skills[0].document,
        `${label}: the generated skill document is byte-identical to the plan`,
      );
      assert.equal(
        await readFile(path.join(staged.stage, "opencode-skills", "skill-router", "SKILL.md"), "utf8"),
        plan.routerDocument,
        `${label}: the generated router document is byte-identical to the plan`,
      );
      const info = await inspectStateConfidentiality(staged.stage);
      assert.equal(info.status, "confidential", `${label}: a completed generated stage is confidential`);
      assert.equal(info.drift, 0);
      assert.deepEqual(info.samples, []);
      assert.equal((await inspectStateTree(staged.stage)).status, "owned", `${label}: attribution is unchanged`);
      await rm(staged.stage, { recursive: true, force: true });
    }

    // Normalization never leaks back onto the sources the plan read.
    for (const [relative, , mode] of supportSources) {
      assert.equal((await lstat(path.join(skillDirectory, relative))).mode & 0o7777, mode);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectStateConfidentiality reports absent, then confidential, without leaking paths, uids, or causes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const absent = await inspectStateConfidentiality(path.join(root, "nope"));
    assert.equal(absent.status, "absent", "missing state is a status, not an exception");
    assert.equal(absent.supported, POSIX, "the summary states whether POSIX enforcement applies here");
    assert.equal(absent.directories, 0);
    assert.equal(absent.files, 0);
    assert.equal(absent.entries, 0);
    assert.equal(absent.drift, 0);
    assert.deepEqual(absent.samples, []);
    assert.ok(Object.isFrozen(absent), "summaries are frozen");
    assert.ok(Object.isFrozen(absent.samples));

    if (!POSIX) return;

    const registry = await stageSource(root);
    const state = path.join(root, "state");
    const staged = await stageManagedState(state, registry, { requestDirectory: requestSpool(root) });
    const info = await inspectStateConfidentiality(staged.stage);
    assert.equal(info.status, "confidential");
    assert.equal(info.supported, true);
    assert.equal(info.directories, 4, "the root plus opencode-skills, release, and skill-router");
    assert.equal(info.files, 4, "the marker, registry.json, and two SKILL.md files");
    assert.equal(info.entries, 7);
    assert.equal(info.drift, 0);
    assert.deepEqual(Object.keys(info).sort(), [
      "directories",
      "drift",
      "entries",
      "files",
      "samples",
      "status",
      "supported",
    ]);

    // Nothing secret-shaped: no absolute path, uid, byte count, digest, or cause.
    const serialized = JSON.stringify(info);
    assert.equal(serialized.includes(staged.stage), false, "no absolute path is returned");
    assert.equal(serialized.includes(root), false, "no absolute path is returned");
    assert.equal(/"(uid|gid|digest|bytes|reason|cause)"/.test(serialized), false, "no uid, digest, byte, or cause");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectStateConfidentiality reports owner-safe legacy modes as drift while inspectStateTree keeps them owned", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    if (!POSIX) return;
    const legacy = await ownedTree(root, "legacy", { files: { "registry.json": "{}", "deep/nested.txt": "x" } });
    await chmod(path.join(legacy, "registry.json"), 0o644);
    await chmod(path.join(legacy, "deep"), 0o755);
    await chmod(legacy, 0o755);

    // Explicit regression: attribution is unchanged by the privacy contract.
    assert.equal((await inspectStateTree(legacy)).status, "owned", "0755/0644 legacy state stays attributable");

    const info = await inspectStateConfidentiality(legacy);
    assert.equal(info.status, "drift", "the same tree is not confidential");
    assert.equal(info.supported, true);
    const codes = sampleCodes(info);
    assert.equal(codes.get("."), "directory-mode", "a 0700 root is required");
    assert.equal(codes.get("registry.json"), "file-mode", "a 0644 file is required to be 0600");
    assert.equal(codes.get("deep"), "directory-mode", "every nested directory is required to be 0700");
    assert.equal(codes.has("deep/nested.txt"), false, "an exact 0600 file is not a sample");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectStateConfidentiality classifies every confidentiality violation as bounded drift", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    if (!POSIX) return;

    const rootLoose = await confidentialTree(root, "root-loose");
    await chmod(rootLoose, 0o755);
    assert.equal((await inspectStateConfidentiality(rootLoose)).status, "drift", "a 0755 root is drift");

    const nestedLoose = await confidentialTree(root, "nested-loose", { "deep/x.txt": "x" });
    await chmod(path.join(nestedLoose, "deep"), 0o755);
    const nestedInfo = await inspectStateConfidentiality(nestedLoose);
    assert.equal(nestedInfo.status, "drift");
    assert.equal(sampleCodes(nestedInfo).get("deep"), "directory-mode");

    const fileLoose = await confidentialTree(root, "file-loose", { "read.txt": "r", "locked.txt": "l" });
    await chmod(path.join(fileLoose, "read.txt"), 0o644);
    await chmod(path.join(fileLoose, "locked.txt"), 0o400);
    const fileInfo = await inspectStateConfidentiality(fileLoose);
    assert.equal(fileInfo.status, "drift");
    assert.equal(sampleCodes(fileInfo).get("read.txt"), "file-mode", "a 0644 file is drift");
    assert.equal(sampleCodes(fileInfo).get("locked.txt"), "file-mode", "even a read-only 0400 file must be exactly 0600");

    // The full 0o7777 mask: setuid/setgid/sticky bits are never masked away.
    const specialBits = await confidentialTree(root, "special-bits", { "suid.txt": "s" });
    await chmod(path.join(specialBits, "suid.txt"), 0o4600);
    await chmod(specialBits, 0o1700);
    const bitsInfo = await inspectStateConfidentiality(specialBits);
    assert.equal(bitsInfo.status, "drift");
    assert.equal(sampleCodes(bitsInfo).get("."), "directory-mode", "a sticky root is not exactly 0700");
    assert.equal(sampleCodes(bitsInfo).get("suid.txt"), "file-mode", "a setuid file is not exactly 0600");

    const linked = await confidentialTree(root, "linked");
    await symlink(path.join(linked, "a.txt"), path.join(linked, "escape.txt"));
    const linkInfo = await inspectStateConfidentiality(linked);
    assert.equal(linkInfo.status, "drift");
    assert.equal(sampleCodes(linkInfo).get("escape.txt"), "symlink", "a symlink is never followed");
    assert.equal(linkInfo.files, 1, "a symlink is not counted as a file");

    const linkRoot = path.join(root, "link-root");
    await symlink(linked, linkRoot);
    const linkRootInfo = await inspectStateConfidentiality(linkRoot);
    assert.equal(linkRootInfo.status, "drift");
    assert.equal(sampleCodes(linkRootInfo).get("."), "symlink", "a symlinked root is drift, not a walk");

    // A FIFO must never be opened: opening it for reading would block forever.
    const special = await confidentialTree(root, "special");
    if (spawnSync("mkfifo", [path.join(special, "pipe")]).status === 0) {
      const specialInfo = await inspectStateConfidentiality(special);
      assert.equal(specialInfo.status, "drift");
      assert.equal(sampleCodes(specialInfo).get("pipe"), "special");
    }

    const notADirectory = path.join(root, "just-a-file");
    await writeFile(notADirectory, "x", { mode: 0o600 });
    const fileRootInfo = await inspectStateConfidentiality(notADirectory);
    assert.equal(fileRootInfo.status, "drift");
    assert.equal(fileRootInfo.samples[0].code, "not-directory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectStateConfidentiality reports foreign owners, unreadable entries, and lstat failures through the test seam", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  const restore = {
    lstat: stateConfidentialityInternals.lstat,
    openFile: stateConfidentialityInternals.openFile,
    currentUid: stateConfidentialityInternals.currentUid,
    uidSemantics: stateConfidentialityInternals.uidSemantics,
  };
  try {
    if (POSIX) {
      const tree = await confidentialTree(root, "owned", { "a.txt": "a" });
      assert.equal((await inspectStateConfidentiality(tree)).status, "confidential");

      stateConfidentialityInternals.currentUid = () => Number(process.getuid()) + 1;
      const foreign = await inspectStateConfidentiality(tree);
      assert.equal(foreign.status, "drift", "a tree owned by another user is drift");
      assert.equal(foreign.supported, true);
      assert.ok(foreign.samples.length > 0 && foreign.samples.every((sample) => sample.code === "foreign-owner"));
      assert.equal(foreign.directories, 1);
      assert.equal(foreign.files, 1);

      // A file whose exact path cannot be opened is drift, without reading it.
      stateConfidentialityInternals.currentUid = restore.currentUid;
      stateConfidentialityInternals.openFile = async () => {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      };
      const unreadableFile = await inspectStateConfidentiality(tree);
      assert.equal(unreadableFile.status, "drift");
      assert.equal(sampleCodes(unreadableFile).get("a.txt"), "unreadable-file");

      // A type swap caught by the probe on the same handle.
      stateConfidentialityInternals.openFile = async (target, flags) => {
        const handle = await restore.openFile(target, flags);
        return new Proxy(handle, {
          get(targetObject, property, receiver) {
            if (property === "stat") {
              return async () => ({ isFile: () => false });
            }
            const value = Reflect.get(targetObject, property, receiver);
            return typeof value === "function" ? value.bind(targetObject) : value;
          },
        });
      };
      const swapped = await inspectStateConfidentiality(tree);
      assert.equal(sampleCodes(swapped).get("a.txt"), "type-changed", "an entry that is no longer a file is drift");
      stateConfidentialityInternals.openFile = restore.openFile;

      // An lstat failure mid-walk is indeterminate drift, never success/throw.
      stateConfidentialityInternals.lstat = async (target) => {
        if (path.basename(target) === "a.txt") {
          const error = new Error("i/o error");
          error.code = "EIO";
          throw error;
        }
        return restore.lstat(target);
      };
      const statError = await inspectStateConfidentiality(tree);
      assert.equal(statError.status, "drift");
      assert.equal(sampleCodes(statError).get("a.txt"), "stat-error");

      stateConfidentialityInternals.lstat = async (target) => {
        if (path.basename(target) === "a.txt") {
          const error = new Error("gone");
          error.code = "ENOENT";
          throw error;
        }
        return restore.lstat(target);
      };
      const vanished = await inspectStateConfidentiality(tree);
      assert.equal(vanished.status, "drift");
      assert.equal(sampleCodes(vanished).get("a.txt"), "vanished");
      stateConfidentialityInternals.lstat = restore.lstat;

      // A failing root lstat that is not absence is drift, not an exception.
      stateConfidentialityInternals.lstat = async () => {
        const error = new Error("i/o error");
        error.code = "EIO";
        throw error;
      };
      const brokenRoot = await inspectStateConfidentiality(tree);
      assert.equal(brokenRoot.status, "drift");
      assert.equal(brokenRoot.samples[0].code, "stat-error");
      stateConfidentialityInternals.lstat = restore.lstat;
    }

    // Without uid/mode semantics the inspector claims no POSIX enforcement.
    stateConfidentialityInternals.uidSemantics = () => false;
    const tree = await confidentialTree(root, "limited", { "a.txt": "a" });
    const limited = await inspectStateConfidentiality(tree);
    assert.equal(limited.status, "limited", "an explicit limited signal, not a confidentiality claim");
    assert.equal(limited.supported, false);
    assert.equal(limited.directories, 0, "nothing is traversed or counted");
    assert.equal(limited.files, 0);
    assert.deepEqual(limited.samples, []);
    const absentLimited = await inspectStateConfidentiality(path.join(root, "missing"));
    assert.equal(absentLimited.status, "absent", "absence is still reported on such a platform");
    assert.equal(absentLimited.supported, false);
  } finally {
    stateConfidentialityInternals.lstat = restore.lstat;
    stateConfidentialityInternals.openFile = restore.openFile;
    stateConfidentialityInternals.currentUid = restore.currentUid;
    stateConfidentialityInternals.uidSemantics = restore.uidSemantics;
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectStateConfidentiality fails closed on unreadable directories and exceeded depth or entry bounds", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    if (POSIX) {
      const unreadable = await confidentialTree(root, "unreadable", { "locked/inside.txt": "x" });
      try {
        await chmod(path.join(unreadable, "locked"), 0o000);
        const unreadableInfo = await inspectStateConfidentiality(unreadable);
        assert.equal(unreadableInfo.status, "drift");
        assert.ok(
          unreadableInfo.samples.some((sample) => sample.path === "locked" && sample.code === "directory-mode"),
          "an unreadable mode is not exact 0700",
        );
        if (typeof process.getuid === "function" && process.getuid() !== 0) {
          assert.ok(
            unreadableInfo.samples.some((sample) => sample.code === "unreadable-directory"),
            "a directory that cannot be enumerated is drift",
          );
        }
      } finally {
        // Restore even if an assertion failed, so the shared temp cleanup can
        // still walk the tree.
        await chmod(path.join(unreadable, "locked"), 0o700);
      }
      assert.equal(
        (await inspectStateConfidentiality(unreadable)).status,
        "confidential",
        "restoring modes restores confidentiality",
      );
    }

    const deep = path.join(root, "deep");
    await mkdir(path.join(deep, "one", "two", "three"), { recursive: true, mode: 0o700 });
    const depthInfo = await inspectStateConfidentiality(deep, { limits: { maxDepth: 2 } });
    assert.equal(depthInfo.status, "drift", "exceeding the depth bound is never success");
    assert.ok(depthInfo.samples.some((sample) => sample.code === "depth-limit"));

    const wide = await confidentialTree(root, "wide", { one: "1", two: "2", three: "3" });
    const wideInfo = await inspectStateConfidentiality(wide, { limits: { maxEntries: 2 } });
    assert.equal(wideInfo.status, "drift", "exceeding the entry bound is never success");
    assert.ok(wideInfo.samples.some((sample) => sample.code === "entries-limit"));
    assert.ok(wideInfo.samples.length <= STATE_CONFIDENTIALITY_SAMPLE_LIMIT);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectStateConfidentiality caps its samples and leaves the tree byte-, mode-, and time-identical", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    if (!POSIX) return;
    const files = {};
    for (let index = 0; index < 20; index += 1) files[`f${index}.txt`] = `body-${index}\n`;
    const tree = await confidentialTree(root, "many", files);
    for (const name of Object.keys(files)) await chmod(path.join(tree, name), 0o644);

    const statMap = async () => {
      const values = new Map();
      for (const entry of await collectModes(tree)) {
        const target = entry.path === "." ? tree : path.join(tree, entry.path);
        values.set(entry.path, (await lstat(target)).mtimeMs);
      }
      return values;
    };
    const beforeDigest = await digestTree(tree);
    const beforeModes = new Map((await collectModes(tree)).map((entry) => [entry.path, entry.mode]));
    const beforeTimes = await statMap();

    const info = await inspectStateConfidentiality(tree);
    assert.equal(info.status, "drift");
    assert.equal(info.supported, true);
    assert.equal(info.files, 20, "every file is still counted");
    assert.equal(info.directories, 1);
    assert.equal(info.entries, 20);
    assert.equal(info.drift, 20, "every 0644 file drifts; the exact 0700 root does not");
    assert.equal(info.samples.length, STATE_CONFIDENTIALITY_SAMPLE_LIMIT, "at most 16 relative-path/code samples");
    assert.ok(info.samples.every((sample) => sample.path === "." || !sample.path.startsWith("/")), "samples are relative");

    assert.deepEqual(await digestTree(tree), beforeDigest, "no byte changed");
    const afterModes = new Map((await collectModes(tree)).map((entry) => [entry.path, entry.mode]));
    assert.deepEqual(afterModes, beforeModes, "no mode changed");
    assert.deepEqual(await statMap(), beforeTimes, "no write, truncation, or replacement happened");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ================================================================== *
 * Phase 7 re-review — the guarded legacy-request classifier is bounded
 *
 * The guard may see an empty subtree and then a concurrent process can
 * atomically place a huge owner-private legacy `requests` directory before
 * the inspector reaches it. The classifier must decide empty vs present with
 * one streaming read — never a materialized name list — and must never open,
 * read, or hash a child.
 * ================================================================== */

/** Wraps the guarded classifier's directory handle to count observed children. */
function instrumentLegacyClassifier() {
  const state = { opendirCalls: 0, readCalls: 0, targets: [] };
  const previous = stateTreeInternals.opendir;
  stateTreeInternals.opendir = async (target) => {
    state.opendirCalls += 1;
    state.targets.push(String(target));
    const directory = await previous(target);
    const read = directory.read.bind(directory);
    directory.read = async () => {
      state.readCalls += 1;
      return read();
    };
    return directory;
  };
  return {
    state,
    restore() {
      stateTreeInternals.opendir = previous;
    },
  };
}

test("the guarded legacy-request classifier reads at most one child and never hashes any of them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    // Baseline: an owned tree whose legacy subtree is present but empty.
    const guarded = await ownedTree(root, "guarded", { files: { "registry.json": "{}" } });
    const legacy = path.join(guarded, "requests");
    await mkdir(legacy, { recursive: true, mode: 0o700 });
    const baseline = await inspectStateTree(guarded, { skipLegacyRequests: true });
    assert.equal(baseline.status, "owned");
    assert.equal(baseline.legacyRequests, "empty");
    assert.equal(
      (await inspectStateTree(guarded)).digest,
      baseline.digest,
      "an empty legacy subtree keeps byte-identical digest parity with the ordinary walk",
    );

    // The race: a concurrent process atomically swaps in a huge populated
    // subtree, far above the injected low entry bound.
    const populated = path.join(root, "populated-requests");
    await mkdir(populated, { recursive: true, mode: 0o700 });
    const sentinelBytes = "guarded classifier sentinel body\n";
    for (let index = 0; index < 64; index += 1) {
      await writeFile(path.join(populated, `${String(index).padStart(3, "0")}.txt`), `${sentinelBytes}${index}`, {
        mode: 0o600,
      });
    }
    const instrument = instrumentLegacyClassifier();
    try {
      await rename(populated, legacy);
      const result = await inspectStateTree(guarded, { skipLegacyRequests: true, limits: { maxEntries: 4 } });
      assert.equal(result.status, "owned");
      assert.equal(result.legacyRequests, "present", "a populated subtree is reported, never hashed");
      assert.equal(instrument.state.opendirCalls, 1, "exactly one directory handle is opened");
      assert.equal(instrument.state.readCalls, 1, "exactly one child is observed: the bound is one read, not N");
      assert.ok(instrument.state.readCalls <= 1, "the read bound is at most one child");
      assert.ok(
        instrument.state.targets.every((target) => path.resolve(target) === path.resolve(legacy)),
        "the only opened directory is the legacy subtree itself",
      );
      assert.equal(result.digest, baseline.digest, "no child reaches the digest");
      assert.deepEqual(
        result.files.filter((name) => name.startsWith("requests")),
        [],
        "no child reaches the file list",
      );
      const serialized = JSON.stringify(result);
      assert.equal(serialized.includes("sentinel"), false, "no child body reaches the summary");
      assert.equal(serialized.includes("000.txt"), false, "no child name reaches the summary");

      // Every entry keeps its exact bytes: the classifier never wrote either.
      assert.deepEqual((await readdir(legacy)).length, 64, "every entry survives");
      assert.equal(await readFile(path.join(legacy, "000.txt"), "utf8"), `${sentinelBytes}0`);
      assert.equal(await readFile(path.join(legacy, "063.txt"), "utf8"), `${sentinelBytes}63`);
    } finally {
      instrument.restore();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a wrong-type root-relative requests entry fails closed before any generic hashing or reads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    // A concurrent replacement that is a regular file, not the legacy
    // directory: it must never flow into ordinary file hashing.
    const wrongType = await ownedTree(root, "wrong-type", { files: { "registry.json": "{}" } });
    const sentinelBytes = "wrong-type sentinel body\n";
    await writeFile(path.join(wrongType, "requests"), sentinelBytes, { mode: 0o600 });
    const guardedFile = await inspectStateTree(wrongType, { skipLegacyRequests: true });
    assert.equal(guardedFile.status, "owned");
    assert.equal(guardedFile.legacyRequests, "unsafe", "a wrong-type replacement fails closed");
    assert.equal(guardedFile.files.includes("requests"), false, "it is never hashed as a normal file");
    assert.equal(JSON.stringify(guardedFile).includes("sentinel"), false, "its body is never read");

    // The ordinary Phase 6 walk is unchanged: the same entry is still hashed.
    const ordinary = await inspectStateTree(wrongType);
    assert.ok(ordinary.files.includes("requests"), "the default walk still hashes a regular file");

    // A symlink at the same exact path also fails closed and is never followed.
    const linked = await ownedTree(root, "linked", { files: { "registry.json": "{}" } });
    const secret = path.join(root, "secret.txt");
    await writeFile(secret, "secret body\n");
    await symlink(secret, path.join(linked, "requests"));
    const guardedLink = await inspectStateTree(linked, { skipLegacyRequests: true });
    assert.equal(guardedLink.legacyRequests, "unsafe", "a symlinked replacement fails closed");
    assert.equal((await inspectStateTree(linked)).status, "foreign", "the default walk still refuses the symlink");

    // A nested look-alike keeps ordinary Phase 6 treatment: only the exact
    // root-relative entry is guarded.
    const nested = await ownedTree(root, "nested", { files: { "opencode-skills/requests/child.txt": "child body\n" } });
    const guardedNested = await inspectStateTree(nested, { skipLegacyRequests: true });
    assert.equal(guardedNested.legacyRequests, null, "no root-relative legacy subtree exists here");
    assert.ok(
      guardedNested.files.includes("opencode-skills/requests/child.txt"),
      "nested look-alikes keep ordinary hashing",
    );
    assert.equal(
      guardedNested.digest,
      (await inspectStateTree(nested)).digest,
      "a nested look-alike keeps digest parity with the ordinary walk",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("guarded inspection keeps absent/empty parity and the ordinary summary shape", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const absentTree = await ownedTree(root, "absent", { files: { "registry.json": "{}" } });
    const emptyTree = await ownedTree(root, "empty", { files: { "registry.json": "{}" } });
    await mkdir(path.join(emptyTree, "requests"), { recursive: true, mode: 0o700 });

    const guardedAbsent = await inspectStateTree(absentTree, { skipLegacyRequests: true });
    const guardedEmpty = await inspectStateTree(emptyTree, { skipLegacyRequests: true });
    const ordinaryAbsent = await inspectStateTree(absentTree);
    const ordinaryEmpty = await inspectStateTree(emptyTree);

    assert.equal(guardedAbsent.digest, ordinaryAbsent.digest, "no legacy subtree: identical digest");
    assert.equal(guardedEmpty.digest, ordinaryEmpty.digest, "empty legacy subtree: identical digest");
    assert.equal(guardedEmpty.entries, ordinaryEmpty.entries, "the directory marker still counts");
    assert.equal(guardedEmpty.bytes, ordinaryEmpty.bytes);
    assert.equal(guardedAbsent.legacyRequests, null);
    assert.equal(guardedEmpty.legacyRequests, "empty");
    assert.equal("legacyRequests" in ordinaryEmpty, false, "the default summary shape is unchanged");

    // Phase 6 classification is unaffected by the guarded summary.
    assert.equal(
      await classifyStateArtifact(emptyTree, { before: { digest: ordinaryEmpty.digest } }),
      "expected-before",
      "the journal classifier still matches the ordinary digest",
    );
    const instrument = instrumentLegacyClassifier();
    try {
      await inspectStateTree(emptyTree);
      assert.equal(instrument.state.opendirCalls, 0, "the default walk never uses the guarded classifier");
    } finally {
      instrument.restore();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ================================================================== *
 * Phase 14 - unprovable identities never classify an artifact
 * ================================================================== */

test("an unprovable recorded identity never classifies a tree as expected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const canonical = await ownedTree(root, "canonical", { files: { "registry.json": "prior" } });
    const info = await inspectStateTree(canonical);
    assert.equal(info.identity.status, "available", "the tagged identity is available on a POSIX filesystem");
    assert.equal(isIdentityAvailable(info.identity), true);

    // An older journal could record a zero/invalid pair. It is schema-valid,
    // but it can never classify - not even a digest-exact tree - as expected,
    // so it can never authorize a destructive cleanup.
    for (const invalid of [{ dev: 0, ino: 0 }, { dev: 3, ino: 0 }, { dev: -1, ino: 2 }]) {
      assert.equal(
        await classifyStateArtifact(canonical, { before: { identity: invalid, digest: info.digest } }),
        "foreign",
        `a zero/invalid recorded identity ${JSON.stringify(invalid)} never matches`,
      );
      assert.equal(
        await classifyStateArtifact(canonical, { desired: { identity: invalid, digest: info.digest } }),
        "foreign",
      );
    }

    // Two unavailable identities are never equal, at the centralized layer.
    assert.equal(identitiesEqual(fileIdentity({ dev: 0, ino: 0 }), fileIdentity({ dev: 0, ino: 0 })), false);
    assert.equal((await lstat(canonical)).isDirectory(), true, "classification never removes anything");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("planning refuses an oversized or over-budget source with one fixed path-free error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const document = "---\nname: demo\ndescription: Demo\n---\n\nBody.\n";
    const source = path.join(root, "skills", "demo", "SKILL.md");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, document);
    const registry = { skills: [{ id: "demo", name: "demo", description: "Demo", source, enabled: true }] };
    const state = path.join(root, "state");
    const options = { requestDirectory: requestSpool(root) };
    const bytes = Buffer.byteLength(document);

    // Exactly at the bound the plan is returned unchanged.
    const exact = await planManagedState(state, registry, { ...options, limits: { maxTotalBytes: bytes } });
    assert.equal(exact.skills[0].document, (await planManagedState(state, registry, options)).skills[0].document);

    // One byte short of the aggregate bound, and any per-file bound below the
    // document, both refuse with the same fixed, path-free error.
    for (const limits of [{ maxTotalBytes: bytes - 1 }, { maxFileBytes: 4 }, { maxFileBytes: bytes - 1 }]) {
      const error = await captureError(() => planManagedState(state, registry, { ...options, limits }));
      assert.equal(error.message, MANAGED_SOURCE_LIMIT_ERROR);
      assert.equal(error.message.includes(root), false, "the refusal never echoes a path");
      assert.equal(error.message.includes(source), false, "the refusal never echoes the source");
      assert.equal(error.message.includes("Body."), false, "the refusal never echoes the document");
    }
    // The refusal is side-effect free: nothing was staged or written.
    assert.deepEqual(await readdir(root), ["skills"], "planning creates no directories or files");
    assert.equal(await exists(state), false, "planning creates no state directory");

    // The established vocabulary for every non-limit failure is untouched.
    const missing = await captureError(() =>
      planManagedState(state, {
        skills: [{ id: "ghost", name: "ghost", description: "Ghost", source: path.join(root, "ghost.md"), enabled: true }],
      }, options),
    );
    assert.equal(missing.code, "ENOENT", "a missing source keeps its raw errno error");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("support copying re-enforces the exact entry, depth, file, and total bounds at copy time", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const skillDirectory = path.join(root, "skills", "demo");
    await mkdir(path.join(skillDirectory, "nested", "deep"), { recursive: true });
    const skillSource = path.join(skillDirectory, "SKILL.md");
    const document = "---\nname: demo\ndescription: Demo\n---\n\nBody.\n";
    await writeFile(skillSource, document);
    await writeFile(path.join(skillDirectory, "reference.md"), "keep\n");
    await writeFile(path.join(skillDirectory, "nested", "deep", "steps.md"), "steps\n");
    const registry = { skills: [{ id: "demo", name: "demo", description: "Demo", source: skillSource, enabled: true }] };
    const state = path.join(root, "state");
    const requestDirectory = requestSpool(root);
    // Planning runs on the fixed production defaults and passes; every bound
    // below is enforced again by the copy itself.
    const plan = await planManagedState(state, registry, { requestDirectory });
    const supportBytes = Buffer.byteLength("keep\n") + Buffer.byteLength("steps\n");
    // Observed support entries: SKILL.md, reference.md, nested, nested/deep,
    // nested/deep/steps.md — five entries, three directories deep.
    for (const limits of [
      { maxEntries: 5 },
      { maxDepth: 3 },
      { maxFileBytes: 6 },
      { maxTotalBytes: supportBytes },
    ]) {
      const staged = await stageManagedState(state, registry, {
        plan,
        requestDirectory,
        stageDirectory: path.join(root, `.state.stage-ok-${Object.values(limits).join("-")}`),
        limits,
      });
      assert.equal(
        await readFile(path.join(staged.stage, "opencode-skills", "demo", "nested", "deep", "steps.md"), "utf8"),
        "steps\n",
        `at the exact ${Object.keys(limits)[0]} bound the copy still completes`,
      );
      await rm(staged.stage, { recursive: true, force: true });
    }

    const refusals = [
      [{ maxEntries: 4 }, /entries/],
      [{ maxDepth: 2 }, /depth/],
      [{ maxFileBytes: 5 }, /file-bytes/],
      [{ maxTotalBytes: supportBytes - 1 }, /total-bytes/],
    ];
    for (const [limits, reason] of refusals) {
      const stageDirectory = path.join(root, `.state.stage-refused-${Object.values(limits).join("-")}`);
      const error = await captureError(() =>
        stageManagedState(state, registry, { plan, requestDirectory, stageDirectory, limits }),
      );
      assert.match(error.message, reason);
      assert.equal(error.name, "BoundedWalkError", "the copy surfaces the shared bounded-walk refusal");
      assert.equal(error.message.includes(root), false, "the limit error never echoes a path");
      assert.equal(error.message.includes(skillDirectory), false, "the limit error never echoes the source tree");
      assert.equal(await exists(stageDirectory), false, "the refused stage path is freed for reuse");
    }
    // A direct (non-journaled) stage refuses the same way and leaves nothing
    // at its stage path either.
    await assert.rejects(
      () => stageManagedState(state, registry, { plan, requestDirectory, limits: { maxEntries: 4 } }),
      /entries/,
    );
    const leftovers = (await readdir(root)).filter((name) => name.includes(".stage-"));
    assert.deepEqual(leftovers, [], "no refused stage directory is left at its original path");
    // The partial trees survive, but only as bounded owner-private claims
    // that were moved aside and re-proved by identity — never raw-removed.
    const claims = (await readdir(root)).filter((name) => name.startsWith(".skill-router-stage-claim-"));
    assert.ok(claims.length >= 1, "each refusal preserves a clearly labeled claim");
    for (const claim of claims) {
      const stat = await lstat(path.join(root, claim));
      assert.equal(stat.isDirectory(), true, "a preserved claim is a directory");
      if (POSIX) assert.equal(stat.mode & 0o7777, 0o700, "a preserved claim is owner-private");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("support copying never follows symlinks and never copies through them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const skillDirectory = path.join(root, "skills", "demo");
    await mkdir(skillDirectory, { recursive: true });
    const skillSource = path.join(skillDirectory, "SKILL.md");
    await writeFile(skillSource, "---\nname: demo\ndescription: Demo\n---\n\nBody.\n");
    await writeFile(path.join(skillDirectory, "reference.md"), "keep\n");
    const secret = path.join(root, "outside-secret.txt");
    await writeFile(secret, "TOP-SECRET-BYTES\n");
    await symlink(secret, path.join(skillDirectory, "linked.md"));
    const outsideTree = path.join(root, "outside-tree");
    await mkdir(outsideTree, { recursive: true });
    await writeFile(path.join(outsideTree, "hidden.md"), "TOP-SECRET-BYTES\n");
    await symlink(outsideTree, path.join(skillDirectory, "linked-dir"));
    const registry = { skills: [{ id: "demo", name: "demo", description: "Demo", source: skillSource, enabled: true }] };
    const state = path.join(root, "state");

    const staged = await stageManagedState(state, registry, { requestDirectory: requestSpool(root) });
    const skillsDirectory = path.join(staged.stage, "opencode-skills", "demo");
    assert.equal(await exists(path.join(skillsDirectory, "linked.md")), false, "a symlinked file is never staged");
    assert.equal(await exists(path.join(skillsDirectory, "linked-dir")), false, "a symlinked directory is never staged");
    assert.equal(await exists(path.join(skillsDirectory, "linked-dir", "hidden.md")), false, "a linked subtree is never descended");
    assert.equal(await readFile(path.join(skillsDirectory, "reference.md"), "utf8"), "keep\n");

    // The secret bytes exist nowhere in the staged tree, so nothing was ever
    // read *through* either link.
    const serialized = JSON.stringify(await digestTree(staged.stage));
    assert.equal(serialized.includes(createHash("sha256").update("TOP-SECRET-BYTES\n").digest("hex")), false);
    await rm(staged.stage, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("journaled staging keeps a strong tagged identity whose plain record is the journal schema", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const source = path.join(root, "release", "SKILL.md");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "---\nname: Release\ndescription: Publish a release\n---\n\nBody.\n");
    const registry = { skills: [{ id: "release", name: "Release", description: "Publish a release", source, enabled: true }] };
    const exact = path.join(root, ".state.stage-identity");
    const staged = await stageManagedState(path.join(root, "state"), registry, {
      requestDirectory: requestSpool(root),
      stageDirectory: exact,
    });

    // The strong-identity normal path stays green: the reported identity is
    // the live tagged form of the exact stage directory.
    assert.equal(isIdentityAvailable(staged.identity), true, "a completed journaled stage reports a strong identity");
    const stat = await lstat(staged.stage);
    assert.equal(staged.identity.dev, stat.dev);
    assert.equal(staged.identity.ino, stat.ino);
    assert.equal(identitiesEqual(staged.identity, fileIdentity(stat)), true);

    // The journal's persisted schema is unchanged: the plain record carries
    // exactly dev/ino and nothing tagged.
    const plain = identityRecord(staged.identity);
    assert.deepEqual(Object.keys(plain).sort(), ["dev", "ino"]);
    assert.deepEqual(plain, { dev: stat.dev, ino: stat.ino });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ================================================================== *
 * Phase 14 lane C - streaming, stable-open state-tree traversal
 * ================================================================== */

test("state-tree inspection refuses at the production entry cap without materializing the directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const tree = path.join(root, "state");
    await mkdir(tree, { recursive: true, mode: 0o700 });
    await writeFile(path.join(tree, STATE_MARKER_FILE), `${STATE_MARKER_CONTENT}\n`, { mode: 0o600 });
    const total = STATE_TREE_LIMITS.maxEntries + 4;
    for (let offset = 0; offset < total; offset += 256) {
      await Promise.all(
        Array.from({ length: Math.min(256, total - offset) }, (_, index) => offset + index).map((index) =>
          writeFile(path.join(tree, `f${String(index).padStart(4, "0")}`), "x", { mode: 0o600 }),
        ),
      );
    }

    let pulled = 0;
    const original = boundedWalkInternals.opendir;
    boundedWalkInternals.opendir = async (target) => {
      const handle = await original(target);
      if (path.resolve(target) !== path.resolve(tree)) return handle;
      return {
        async *[Symbol.asyncIterator]() {
          for await (const dirent of handle) {
            pulled += 1;
            yield dirent;
          }
        },
        close: () => handle.close(),
      };
    };
    let info;
    try {
      info = await inspectStateTree(tree);
    } finally {
      boundedWalkInternals.opendir = original;
    }
    assert.equal(info.status, "foreign");
    assert.match(info.reason, new RegExp(`more than ${STATE_TREE_LIMITS.maxEntries} entries`));
    assert.equal(
      pulled,
      STATE_TREE_LIMITS.maxEntries + 1,
      "enumeration stopped at the first overflowing entry; the rest of the directory was never pulled",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stage over the finalize entry cap is refused whole, never partially finalized", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const skillDirectory = path.join(root, "skills", "demo");
    await mkdir(skillDirectory, { recursive: true });
    const skillSource = path.join(skillDirectory, "SKILL.md");
    await writeFile(skillSource, "---\nname: demo\ndescription: Demo\n---\n\nBody.\n");
    const supportCount = STATE_TREE_LIMITS.maxEntries;
    for (let offset = 0; offset < supportCount; offset += 256) {
      await Promise.all(
        Array.from({ length: Math.min(256, supportCount - offset) }, (_, index) => offset + index).map((index) =>
          writeFile(path.join(skillDirectory, `s${String(index).padStart(4, "0")}.txt`), "x"),
        ),
      );
    }
    const registry = { skills: [{ id: "demo", name: "demo", description: "Demo", source: skillSource, enabled: true }] };
    const state = path.join(root, "state");
    const requestDirectory = requestSpool(root);
    // Planning on the fixed defaults refuses this tree (the document budget
    // sees no problem, but the copy-time entry bound does), so plan on limits
    // that let the copy finish and force the refusal into finalize instead.
    const plan = await planManagedState(state, registry, { requestDirectory, limits: { maxTotalBytes: 1024 } });
    const stageDirectory = path.join(root, ".state.stage-overcap");
    const error = await captureError(() =>
      stageManagedState(state, registry, {
        plan,
        requestDirectory,
        stageDirectory,
        limits: { maxEntries: supportCount + 16 },
      }),
    );
    assert.match(error.message, new RegExp(`more than ${STATE_TREE_LIMITS.maxEntries} entries`));
    assert.equal(error.code, "MANAGED_STAGE_FINALIZE_REFUSED");
    assert.equal(error.claimPath !== undefined, true, "the preserved claim is reported on the refusal");
    assert.equal(await exists(stageDirectory), false, "the stage path is freed — no partial finalize survives there");
    const leftovers = (await readdir(root)).filter((name) => name.includes(".stage-"));
    assert.deepEqual(leftovers, [], "no stage directory of any kind is left at its original path");
    // The oversized partial tree survives only as one bounded owner-private
    // claim, re-proved by identity before it was moved there.
    const claims = (await readdir(root)).filter((name) => name.startsWith(".skill-router-stage-claim-"));
    assert.equal(claims.length, 1, "exactly one preserved claim");
    assert.equal(path.resolve(error.claimPath), path.join(root, claims[0]), "claimPath names exactly that claim");
    const claimStat = await lstat(error.claimPath);
    assert.equal(claimStat.isDirectory(), true);
    if (POSIX) assert.equal(claimStat.mode & 0o7777, 0o700, "the preserved claim is owner-private");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the legacy request branch refuses a requests directory replaced before its classification open", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const tree = await ownedTree(root, "state", { files: { "registry.json": "{}" } });
    const requests = path.join(tree, "requests");
    await mkdir(requests, { recursive: true, mode: 0o700 });
    const outside = path.join(root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "live.txt"), "request\n");
    const baseline = await inspectStateTree(tree);

    const original = stateTreeInternals.opendir;
    stateTreeInternals.opendir = async (target) => {
      if (path.resolve(target) === path.resolve(requests)) {
        // Deterministic TOCTOU: the legacy directory is swapped for a symlink
        // to an outside tree immediately before the classification open.
        await rm(requests, { recursive: true, force: true });
        await symlink(outside, requests);
      }
      return original(target);
    };
    let guarded;
    try {
      guarded = await inspectStateTree(tree, { skipLegacyRequests: true });
    } finally {
      stateTreeInternals.opendir = original;
    }
    assert.equal(guarded.status, "owned");
    assert.equal(
      guarded.legacyRequests,
      "unsafe",
      "a replaced legacy directory never classifies as empty or present",
    );
    assert.equal(guarded.digest, baseline.digest, "the digest still carries only the directory marker");
    assert.equal(guarded.bytes, baseline.bytes, "no content of the replacement is ever read or hashed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a state subdirectory swapped in the open window is refused as foreign", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const tree = await ownedTree(root, "state", { files: { "registry.json": "{}" } });
    const sub = path.join(tree, "sub");
    await mkdir(sub, { recursive: true, mode: 0o700 });
    await writeFile(path.join(sub, "inner.txt"), "x", { mode: 0o600 });
    const outside = path.join(root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.txt"), "secret\n");

    const original = boundedWalkInternals.opendir;
    boundedWalkInternals.opendir = async (target) => {
      if (path.resolve(target) === path.resolve(sub)) {
        await rm(sub, { recursive: true, force: true });
        await symlink(outside, sub);
      }
      return original(target);
    };
    let info;
    try {
      info = await inspectStateTree(tree);
    } finally {
      boundedWalkInternals.opendir = original;
    }
    assert.equal(info.status, "foreign", "a replaced directory fails the inspection closed");
    assert.match(info.reason, /unreadable/);
    assert.equal(info.files, undefined, "no partial file inventory of a replaced subtree is ever returned");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ================================================================== *
 * Phase 14 lane C - handle-only finalize and pinned classification
 * ================================================================== */

/** A journaled stage of one skill whose support tree carries one file and one nested directory. */
async function finalizeFixture(root, { nested = true } = {}) {
  const skillDirectory = path.join(root, "skills", "demo");
  await mkdir(nested ? path.join(skillDirectory, "docs") : skillDirectory, { recursive: true });
  const skillSource = path.join(skillDirectory, "SKILL.md");
  await writeFile(skillSource, "---\nname: demo\ndescription: Demo\n---\n\nBody.\n");
  const supportRelative = nested ? path.join("docs", "guide.md") : "guide.md";
  const supportFile = path.join(skillDirectory, supportRelative);
  await writeFile(supportFile, "guide\n");
  const registry = { skills: [{ id: "demo", name: "demo", description: "Demo", source: skillSource, enabled: true }] };
  return { registry, supportFile, stagedSupportRelative: path.join("opencode-skills", "demo", supportRelative) };
}

test("finalize refuses a staged file swapped for a symlink and never touches the external target", async (t) => {
  const POSIX = fileModeBitsMeaningful() && typeof process.getuid === "function";
  if (!POSIX) return;
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  const fixture = await finalizeFixture(root);
  const { registry } = fixture;
  const state = path.join(root, "state");
  const requestDirectory = requestSpool(root);
  const plan = await planManagedState(state, registry, { requestDirectory });
  const stageDirectory = path.join(root, ".state.stage-symlink");
  const stagedSupport = path.join(stageDirectory, fixture.stagedSupportRelative);
  const outside = path.join(root, "outside.txt");
  await writeFile(outside, "outside\n");
  await chmod(outside, 0o644);

  const original = stageFinalizeInternals.open;
  stageFinalizeInternals.open = async (target, flags, mode) => {
    if (path.resolve(target) === path.resolve(stagedSupport)) {
      // Deterministic TOCTOU: the staged file becomes a symlink to an outside
      // file the instant before finalize opens it.
      await rm(stagedSupport, { force: true });
      await symlink(outside, stagedSupport);
    }
    return original(target, flags, mode);
  };
  let error;
  try {
    error = await captureError(() =>
      stageManagedState(state, registry, { plan, requestDirectory, stageDirectory }),
    );
  } finally {
    stageFinalizeInternals.open = original;
  }
  assert.equal(error.code, "MANAGED_STAGE_FINALIZE_REFUSED");
  assert.match(error.message, /symbolic link/);
  assert.equal((await lstat(outside)).mode & 0o7777, 0o644, "the external target's mode is untouched");
  assert.equal(await readFile(outside, "utf8"), "outside\n", "the external target's bytes are untouched");
  assert.equal(await exists(stageDirectory), false, "the refused stage is removed whole");
});

test("finalize refuses a staged file that has another hard link and never chmods through the handle", async (t) => {
  const POSIX = fileModeBitsMeaningful() && typeof process.getuid === "function";
  if (!POSIX) return;
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  const fixture = await finalizeFixture(root, { nested: false });
  const { registry } = fixture;
  const state = path.join(root, "state");
  const requestDirectory = requestSpool(root);
  const plan = await planManagedState(state, registry, { requestDirectory });
  const stageDirectory = path.join(root, ".state.stage-hardlink");
  const stagedSupport = path.join(stageDirectory, fixture.stagedSupportRelative);
  const alias = path.join(root, "alias.txt");

  const original = stageFinalizeInternals.open;
  let linked = false;
  stageFinalizeInternals.open = async (target, flags, mode) => {
    if (!linked && path.resolve(target) === path.resolve(stagedSupport)) {
      linked = true;
      // A second name for the same inode, then a public mode through that
      // name: finalize must refuse on `nlink === 1` before its own fchmod
      // could ever normalize (and therefore alter) the shared inode.
      await link(stagedSupport, alias);
      await chmod(alias, 0o644);
    }
    return original(target, flags, mode);
  };
  let error;
  try {
    error = await captureError(() =>
      stageManagedState(state, registry, { plan, requestDirectory, stageDirectory }),
    );
  } finally {
    stageFinalizeInternals.open = original;
  }
  assert.equal(linked, true, "the fixture's hard link was created");
  assert.equal(error.code, "MANAGED_STAGE_FINALIZE_REFUSED");
  assert.match(error.message, /another hard link/);
  assert.equal((await lstat(alias)).mode & 0o7777, 0o644, "the shared inode's mode is unchanged: no fchmod ran");
  assert.equal(await exists(stageDirectory), false, "the refused stage is removed whole");
});

test("finalize refuses a recorded directory replaced before its deepest-first phase", async (t) => {
  const POSIX = fileModeBitsMeaningful() && typeof process.getuid === "function";
  if (!POSIX) return;
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  const { registry } = await finalizeFixture(root);
  const state = path.join(root, "state");
  const requestDirectory = requestSpool(root);
  const plan = await planManagedState(state, registry, { requestDirectory });
  const stageDirectory = path.join(root, ".state.stage-dirswap");
  const stagedDocs = path.join(stageDirectory, "opencode-skills", "demo", "docs");
  const replacement = path.join(root, "replacement");
  await mkdir(replacement, { recursive: true });
  await writeFile(path.join(replacement, "other.md"), "other\n");

  const original = stageFinalizeInternals.open;
  stageFinalizeInternals.open = async (target, flags, mode) => {
    const directoryHandle = typeof flags === "number" && (flags & (fsConstants.O_DIRECTORY ?? 0)) !== 0;
    if (directoryHandle && path.resolve(target) === path.resolve(stagedDocs)) {
      // The recorded directory is swapped for a different real directory
      // between the walk and the deepest-first finalize phase. The original is
      // renamed aside rather than deleted: an inode allocator with eager reuse
      // (ext4 on the Linux runner) can give the replacement directory the same
      // dev/ino the deleted one just freed, which would make the swap
      // invisible to the identity pin. Renaming keeps that inode allocated,
      // so the replacement provably differs on every platform.
      await rename(stagedDocs, `${stagedDocs}.pinned`);
      await mkdir(stagedDocs, { recursive: true });
      await writeFile(path.join(stagedDocs, "other.md"), "other\n");
    }
    return original(target, flags, mode);
  };
  let error;
  try {
    error = await captureError(() =>
      stageManagedState(state, registry, { plan, requestDirectory, stageDirectory }),
    );
  } finally {
    stageFinalizeInternals.open = original;
  }
  assert.equal(error.code, "MANAGED_STAGE_FINALIZE_REFUSED");
  assert.match(error.message, /replaced/);
  const replacementMode = (await lstat(replacement)).mode & 0o7777;
  assert.notEqual(replacementMode, 0o700, "no fchmod ran on anything outside the recorded identity");
  assert.equal(await exists(stageDirectory), false, "the refused stage is removed whole");
});

test("the legacy classification refuses a same-type replacement, and the ABA case is the documented residual", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const tree = await ownedTree(root, "state", { files: { "registry.json": "{}" } });
    const requests = path.join(tree, "requests");
    await mkdir(requests, { recursive: true, mode: 0o700 });

    // Same-type replacement left in place: prior, reopened, and post-open
    // observations disagree on identity, so it never classifies.
    const other = path.join(root, "other-requests");
    await mkdir(other, { recursive: true, mode: 0o700 });
    await writeFile(path.join(other, "pending.txt"), "pending\n", { mode: 0o600 });
    const original = stateTreeInternals.opendir;
    stateTreeInternals.opendir = async (target) => {
      if (path.resolve(target) === path.resolve(requests)) {
        await rm(requests, { recursive: true, force: true });
        await rename(other, requests);
      }
      return original(target);
    };
    let guarded;
    try {
      guarded = await inspectStateTree(tree, { skipLegacyRequests: true });
    } finally {
      stateTreeInternals.opendir = original;
    }
    assert.equal(guarded.legacyRequests, "unsafe", "a same-type replacement never classifies as empty or present");

    // ABA residual, documented: swap away and restore so all three
    // observations agree on the original, while the single read comes from
    // the replacement's handle. Pathname checks without fd-relative opens
    // cannot see this; the classification proceeds rather than refusing.
    await rm(requests, { recursive: true, force: true });
    const originalDir = path.join(root, "held-original");
    await mkdir(requests, { recursive: true, mode: 0o700 });
    const swap = path.join(root, "swap-requests");
    await mkdir(swap, { recursive: true, mode: 0o700 });
    await writeFile(path.join(swap, "only-in-swap.txt"), "swap\n", { mode: 0o600 });
    stateTreeInternals.opendir = async (target) => {
      if (path.resolve(target) === path.resolve(requests)) {
        await rename(requests, originalDir);
        await rename(swap, requests);
        const handle = await original(target);
        await rename(requests, swap);
        await rename(originalDir, requests);
        return handle;
      }
      return original(target);
    };
    let aba;
    try {
      aba = await inspectStateTree(tree, { skipLegacyRequests: true });
    } finally {
      stateTreeInternals.opendir = original;
    }
    assert.equal(aba.legacyRequests, "present", "the documented ABA residual: the restored original validates the open");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("confidentiality inspection reports a same-type replacement as drift, never confidentiality", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const tree = await ownedTree(root, "state", { files: { "registry.json": "{}" } });
    const sub = path.join(tree, "sub");
    await mkdir(sub, { recursive: true, mode: 0o700 });
    await writeFile(path.join(sub, "inner.txt"), "x", { mode: 0o600 });
    const other = path.join(root, "other-sub");
    await mkdir(other, { recursive: true, mode: 0o700 });
    await writeFile(path.join(other, "other.txt"), "y", { mode: 0o600 });

    const swapIn = async () => {
      await rm(sub, { recursive: true, force: true });
      await rename(other, sub);
    };

    // Replacement *after* the open: the post-open verification sees it.
    const originalOpen = stateConfidentialityInternals.opendir;
    stateConfidentialityInternals.opendir = async (target) => {
      const handle = await originalOpen(target);
      if (path.resolve(target) === path.resolve(sub)) await swapIn();
      return handle;
    };
    let afterOpen;
    try {
      afterOpen = await inspectStateConfidentiality(tree);
    } finally {
      stateConfidentialityInternals.opendir = originalOpen;
      await rm(other, { recursive: true, force: true }).catch(() => {});
      await rm(sub, { recursive: true, force: true });
      await mkdir(sub, { recursive: true, mode: 0o700 });
      await writeFile(path.join(sub, "inner.txt"), "x", { mode: 0o600 });
      await mkdir(other, { recursive: true, mode: 0o700 });
      await writeFile(path.join(other, "other.txt"), "y", { mode: 0o600 });
    }
    assert.equal(afterOpen.status, "drift", "a post-open replacement is never confidential");
    assert.ok(afterOpen.samples.some((sample) => sample.code === "replaced-directory"));

    // Replacement *before* the open: the open resolves to the replacement
    // and the same-path re-verification sees the identity change.
    stateConfidentialityInternals.opendir = async (target) => {
      if (path.resolve(target) === path.resolve(sub)) await swapIn();
      return originalOpen(target);
    };
    let beforeOpen;
    try {
      beforeOpen = await inspectStateConfidentiality(tree);
    } finally {
      stateConfidentialityInternals.opendir = originalOpen;
    }
    assert.equal(beforeOpen.status, "drift", "a pre-open replacement is never confidential");
    assert.ok(beforeOpen.samples.some((sample) => sample.code === "replaced-directory"));
    assert.equal(
      beforeOpen.samples.some((sample) => sample.path.includes("other.txt")),
      false,
      "no child of the replacement is ever examined",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a replacement stage tree always survives a staging failure untouched", async (t) => {
  const POSIX = fileModeBitsMeaningful() && typeof process.getuid === "function";
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const fixture = await finalizeFixture(root);
    const { registry } = fixture;
    const state = path.join(root, "state");
    const requestDirectory = requestSpool(root);
    const plan = await planManagedState(state, registry, { requestDirectory });
    const stageDirectory = path.join(root, ".state.stage-replaced");

    // The decoy an adversary swaps onto the exact stage path just before the
    // injected finalize failure.
    const decoy = path.join(root, "decoy");
    await mkdir(decoy, { recursive: true });
    await writeFile(path.join(decoy, "keep.txt"), "decoy bytes\n");
    if (POSIX) await chmod(path.join(decoy, "keep.txt"), 0o644);
    await writeFile(path.join(decoy, "second.txt"), "more decoy bytes\n");

    const original = stageFinalizeInternals.open;
    let swapped = false;
    stageFinalizeInternals.open = async (target, flags, mode) => {
      if (!swapped) {
        swapped = true;
        // Replace the *entire* stage path, then fail staging.
        await rm(stageDirectory, { recursive: true, force: true });
        await rename(decoy, stageDirectory);
        throw new Error("injected finalize failure");
      }
      return original(target, flags, mode);
    };
    let error;
    try {
      error = await captureError(() => stageManagedState(state, registry, { plan, requestDirectory, stageDirectory }));
    } finally {
      stageFinalizeInternals.open = original;
    }
    assert.equal(swapped, true, "the fixture's replacement happened");
    assert.equal(error.code, "MANAGED_STAGE_FINALIZE_REFUSED", "the injected open failure surfaces as the finalize refusal");

    // The replacement survives byte-, name-, and mode-identical: the failure
    // path never rm'd, moved, chmod'd, or claimed it.
    assert.deepEqual((await readdir(stageDirectory)).sort(), ["keep.txt", "second.txt"]);
    assert.equal(await readFile(path.join(stageDirectory, "keep.txt"), "utf8"), "decoy bytes\n");
    if (POSIX) {
      assert.equal((await lstat(path.join(stageDirectory, "keep.txt"))).mode & 0o7777, 0o644, "replacement modes survive");
      assert.equal((await lstat(stageDirectory)).mode & 0o7777, 0o755, "the replacement root's mode survives");
    }
    const claims = (await readdir(root)).filter((name) => name.startsWith(".skill-router-stage-claim-"));
    assert.deepEqual(claims, [], "nothing of the replacement is ever moved into a claim");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an ordinary staging failure frees the stage path and leaves one bounded owner-private claim", async (t) => {
  const POSIX = fileModeBitsMeaningful() && typeof process.getuid === "function";
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  try {
    const fixture = await finalizeFixture(root);
    const { registry } = fixture;
    const state = path.join(root, "state");
    const requestDirectory = requestSpool(root);
    const plan = await planManagedState(state, registry, { requestDirectory });
    const stageDirectory = path.join(root, ".state.stage-ordinary");

    const original = stageFinalizeInternals.open;
    stageFinalizeInternals.open = async () => {
      throw new Error("injected staging failure");
    };
    let error;
    try {
      error = await captureError(() => stageManagedState(state, registry, { plan, requestDirectory, stageDirectory }));
    } finally {
      stageFinalizeInternals.open = original;
    }
    assert.equal(error.code, "MANAGED_STAGE_FINALIZE_REFUSED", "the injected open failure surfaces as the finalize refusal");
    assert.equal(typeof error.claimPath, "string", "the preserved claim is reported on the error");
    assert.equal(await exists(stageDirectory), false, "the exact stage path is freed");

    // The claim is bounded and owner-private, holds the partial journaled
    // tree, and is the identity-proved move of the tree this call created.
    const claimStat = await lstat(error.claimPath);
    assert.equal(claimStat.isDirectory(), true);
    if (POSIX) assert.equal(claimStat.mode & 0o7777, 0o700, "the claim is owner-private");
    assert.equal(await exists(path.join(error.claimPath, STATE_MARKER_FILE)), true, "the partial tree survives inside the claim");
    const claims = (await readdir(root)).filter((name) => name.startsWith(".skill-router-stage-claim-"));
    assert.deepEqual(claims, [path.basename(error.claimPath)], "exactly one claim exists");

    // The freed path is immediately reusable: the same staging now succeeds.
    const retried = await stageManagedState(state, registry, { plan, requestDirectory, stageDirectory });
    assert.equal((await inspectStateTree(retried.stage)).status, "owned", "a retry at the same path completes");
    await rm(retried.stage, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
