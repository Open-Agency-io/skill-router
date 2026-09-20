import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverSource, discoverSources } from "../src/discovery.js";
import { buildRegistry, sourceFingerprint, writeJsonAtomic } from "../src/registry.js";

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

test("writes registry JSON atomically", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "skill-router-"));
  const file = path.join(directory, "nested", "registry.json");
  await writeJsonAtomic(file, { schemaVersion: 1 });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { schemaVersion: 1 });
});
