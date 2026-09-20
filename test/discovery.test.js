import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverSource, discoverSources } from "../src/discovery.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

test("discovers flat and nested skills without loading bodies into entries", async () => {
  const result = await discoverSource(path.join(fixtures, "source-low"));
  assert.deepEqual(result.skills.map((skill) => skill.id), ["review", "release"]);
  const review = result.skills.find((skill) => skill.id === "review");
  assert.equal(review.opencodeAutoinvoke, false);
  assert.equal(review.description, "Review code for correctness and maintainability");
  assert.equal(Object.hasOwn(review, "body"), false);
});

test("tracks source precedence", async () => {
  const result = await discoverSources([
    path.join(fixtures, "source-low"),
    path.join(fixtures, "source-high"),
  ]);
  const releases = result.skills.filter((skill) => skill.id === "release");
  assert.deepEqual(releases.map((skill) => skill.sourceIndex), [0, 1]);
});

test("reports malformed skills and missing sources", async () => {
  const malformed = await discoverSource(path.join(fixtures, "source-malformed"));
  assert.equal(malformed.skills.length, 0);
  assert.equal(malformed.diagnostics[0].code, "invalid-skill");

  const missing = await discoverSource(path.join(fixtures, "absent"));
  assert.equal(missing.diagnostics[0].code, "source-not-found");
});

test("uses the documented literal ID for a source-root SKILL.md", async () => {
  const result = await discoverSource(path.join(fixtures, "source-root-skill"));
  assert.equal(result.skills[0].id, "SKILL");
  assert.equal(result.diagnostics.some((item) => item.code === "root-skill-id"), true);
  assert.equal(result.diagnostics.some((item) => item.code === "non-portable-id"), true);
});
