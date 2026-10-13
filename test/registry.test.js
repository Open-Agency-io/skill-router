import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverSource, discoverSources } from "../src/discovery.js";
import {
  assertRegistryIdentifiers,
  buildRegistry,
  inspectRegistryIdentifiers,
  registryFingerprint,
  sourceFingerprint,
  writeJsonAtomic,
} from "../src/registry.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

test("selects the highest-precedence source and emits a compact registry", async () => {
  const discovery = await discoverSources([
    path.join(fixtures, "source-low"),
    path.join(fixtures, "source-high"),
  ]);
  const registry = buildRegistry(discovery);
  assert.equal(registry.skills.find((skill) => skill.id === "release").name, "Team Release");
  assert.equal(registry.diagnostics.some((item) => item.code === "overridden-id"), true);
  assert.equal(Object.hasOwn(registry.skills[0], "contentHash"), false);
  assert.match(registry.fingerprint, /^[a-f0-9]{64}$/);
});

test("rejects duplicate IDs at equal precedence", async () => {
  const discovery = await discoverSource(path.join(fixtures, "source-duplicate"));
  const registry = buildRegistry(discovery);
  assert.equal(registry.skills.length, 0);
  assert.equal(registry.diagnostics.some((item) => item.code === "duplicate-id"), true);
});

test("fingerprints are stable and sensitive to content hashes", () => {
  const skills = [{ id: "one", path: "/one", sourceIndex: 0, contentHash: "a" }];
  assert.equal(sourceFingerprint(skills), sourceFingerprint([...skills]));
  assert.notEqual(
    sourceFingerprint(skills),
    sourceFingerprint([{ ...skills[0], contentHash: "b" }]),
  );
});

test("fingerprints cover malformed candidates and source status", () => {
  const directory = [{ kind: "source", source: "/skills", sourceIndex: 0, status: "directory" }];
  const malformed = [
    ...directory,
    { kind: "candidate", source: "/skills", sourceIndex: 0, path: "/skills/broken.md", contentHash: "a" },
  ];
  assert.notEqual(sourceFingerprint(directory), sourceFingerprint(malformed));
  assert.notEqual(
    sourceFingerprint(directory),
    sourceFingerprint([{ ...directory[0], status: "missing" }]),
  );
});

test("does not treat inherited replacement or enabled properties as options", async () => {
  const skill = {
    id: "constructor",
    name: "Constructor",
    description: "Test inherited properties",
    source: "/skills",
    path: "/skills/constructor.md",
    sourceIndex: 0,
    contentHash: "a",
  };
  const registry = buildRegistry({ skills: [skill], diagnostics: [] });
  assert.equal(registry.skills[0].id, "constructor");
  assert.equal(registry.skills[0].enabled, true);
  assert.equal(registry.diagnostics.some((item) => item.code === "invalid-replacement"), false);
});

test("preserves the historical source fingerprint when no policy is present", async () => {
  const discovery = await discoverSources([
    path.join(fixtures, "source-low"),
    path.join(fixtures, "source-high"),
  ]);

  // Schema v1 registries (and every caller without a policy) keep the legacy
  // source-only fingerprint so an existing registry still verifies after an
  // upgrade instead of going stale until a mandatory rescan.
  const ungoverned = buildRegistry(discovery);
  assert.equal(ungoverned.fingerprint, sourceFingerprint(discovery.fingerprintEntries));
  assert.equal(ungoverned.policyHash, undefined);

  // Schema v2 still combines the discovered material with its routing policy.
  const policy = { schemaVersion: 2, sources: [] };
  const governed = buildRegistry(discovery, { policy });
  assert.equal(governed.fingerprint, registryFingerprint(discovery.fingerprintEntries, policy));
  assert.notEqual(governed.fingerprint, ungoverned.fingerprint);
});

test("writes registry JSON atomically", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "skill-router-"));
  const file = path.join(directory, "nested", "registry.json");
  await writeJsonAtomic(file, { schemaVersion: 1 });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { schemaVersion: 1 });
});

test("sourceRoots is inventory only and never changes the fingerprint", async () => {
  const discovery = await discoverSources([
    path.join(fixtures, "source-low"),
    path.join(fixtures, "source-high"),
  ]);
  const plain = buildRegistry(discovery);
  const inventoried = buildRegistry(discovery);
  inventoried.sourceRoots = [path.join(fixtures, "source-low")];

  assert.equal(Object.hasOwn(plain, "sourceRoots"), false, "buildRegistry never invents the field");
  assert.deepEqual(inventoried.sourceRoots, [path.join(fixtures, "source-low")], "the inventory is a plain array");
  assert.equal(inventoried.fingerprint, plain.fingerprint, "adding sourceRoots never changes the source fingerprint");
  assert.equal(inventoried.policyHash, plain.policyHash);
  assert.deepEqual(inventoried.skills, plain.skills);
  assert.deepEqual(inventoried.diagnostics, plain.diagnostics);

  // A legacy registry that simply lacks the field stays valid and identical
  // on every other field, so it can never go stale because of the new one.
  const parsedPlain = JSON.parse(JSON.stringify(plain));
  const parsedInventoried = JSON.parse(JSON.stringify(inventoried));
  assert.equal(parsedPlain.sourceRoots, undefined, "legacy registries lack the field");
  assert.equal(parsedInventoried.fingerprint, parsedPlain.fingerprint, "fingerprints still match after serialization");
  assert.equal(parsedInventoried.schemaVersion, parsedPlain.schemaVersion);

  const policy = { schemaVersion: 2, sources: [] };
  const governed = buildRegistry(discovery, { policy });
  const governedInventoried = buildRegistry(discovery, { policy });
  governedInventoried.sourceRoots = ["/srv/skills"];
  assert.equal(governedInventoried.fingerprint, governed.fingerprint, "policy-governed fingerprints are unaffected too");
});

test("identifier inspection accepts every portable registry reference, including Claude-family names", () => {
  const registry = {
    skills: [
      { id: "release", handoffTo: ["verify", "doctor"] },
      { id: "synced" },
      { id: "anthropic-skills" },
      { id: "anthropic" },
      { id: "claude" },
      { id: "claude-helper" },
      { id: "verify" },
      { id: "simplify" },
      { id: "doctor" },
      { id: "constructor", handoffTo: ["prototype"] },
      { id: "a".repeat(64) },
    ],
    workflows: [
      { id: "release-flow", steps: [{ skill: "verify" }, { skill: "doctor", when: "asked" }] },
      { id: "claude-flow", steps: [{ skill: "claude-helper" }] },
    ],
  };
  const inspection = inspectRegistryIdentifiers(registry);
  assert.equal(inspection.valid, true);
  assert.equal(inspection.invalid, 0);
  assert.equal(inspection.checked, 19);
  assert.deepEqual(inspection.reasons, []);
  assert.deepEqual(inspection.fields, []);
  assert.doesNotThrow(() => assertRegistryIdentifiers(registry));
  // A registry without skills/workflows is not an identifier problem.
  assert.equal(inspectRegistryIdentifiers({}).valid, true);
  assert.equal(inspectRegistryIdentifiers(null).valid, true);
});

test("identifier inspection refuses poisoned IDs in every reference field without consuming them", () => {
  const registry = {
    skills: [
      { id: "../sentinel", source: "/outside/sentinel" },
      { id: "release", handoffTo: ["../../etc/passwd"] },
      { id: "x".repeat(100_000) },
      { id: "a\u0000b" },
      { id: "skill-router" },
      { id: "Release" },
      { id: "" },
    ],
    workflows: [
      { id: "Bad Flow", steps: [{ skill: "release" }] },
      { id: "flow", steps: [{ skill: "..\\..\\windows" }] },
      { id: "skill-router", steps: [] },
    ],
  };
  const inspection = inspectRegistryIdentifiers(registry);
  assert.equal(inspection.valid, false);
  assert.equal(inspection.invalid, 10);
  assert.deepEqual(inspection.reasons, ["empty", "grammar", "length", "reserved"]);
  assert.deepEqual(inspection.fields, [
    "skills[].handoffTo[]",
    "skills[].id",
    "workflows[].id",
    "workflows[].steps[].skill",
  ]);

  // The result is bounded and never embeds an untrusted value or path.
  const serialized = JSON.stringify(inspection);
  for (const marker of ["sentinel", "etc/passwd", "windows", "a\u0000", "Bad Flow", "Release", "skill-router"]) {
    assert.equal(serialized.includes(marker), false, `inspection result leaks ${marker}`);
  }
  assert.ok(serialized.length < 400, "inspection result stays bounded");

  assert.throws(
    () => assertRegistryIdentifiers(registry),
    (error) => {
      assert.equal(
        error.message,
        "Registry contains invalid skill or workflow IDs; run skill-router scan to rebuild it",
      );
      assert.ok(error.message.length < 200);
      assert.equal(/[\u0000-\u001f]/.test(error.message), false);
      return true;
    },
  );
});

test("identifier inspection treats malformed shapes conservatively instead of crashing", () => {
  const cases = [
    { registry: { skills: "poison" }, field: "skills[].id" },
    { registry: { skills: [{ id: "release", handoffTo: "poison" }] }, field: "skills[].handoffTo[]" },
    { registry: { skills: [null] }, field: "skills[].id" },
    { registry: { workflows: { flow: {} } }, field: "workflows[].id" },
    { registry: { workflows: [{ id: "flow", steps: "poison" }] }, field: "workflows[].steps[].skill" },
    { registry: { workflows: [{ id: "flow", steps: [null] }] }, field: "workflows[].steps[].skill" },
  ];
  for (const { registry, field } of cases) {
    const inspection = inspectRegistryIdentifiers(registry);
    assert.equal(inspection.valid, false, `${JSON.stringify(registry)} must be invalid`);
    assert.deepEqual(inspection.reasons, ["type"]);
    assert.deepEqual(inspection.fields, [field]);
    assert.equal(JSON.stringify(inspection).includes("poison"), false);
    assert.throws(() => assertRegistryIdentifiers(registry), /invalid skill or workflow IDs/);
  }
});
