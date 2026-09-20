import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig } from "../src/config.js";

test("normalizes defaults without sharing mutable values", () => {
  const first = normalizeConfig();
  const second = normalizeConfig();
  first.sources.push("one");
  assert.deepEqual(second.sources, []);
  assert.equal(first.routing.minimumScore, 0.55);
});

test("merges routing configuration", () => {
  const config = normalizeConfig({ routing: { minimumScore: 0.7 } });
  assert.equal(config.routing.minimumScore, 0.7);
  assert.equal(config.routing.maxCandidates, 5);
});

test("rejects unsafe configuration shapes", () => {
  assert.throws(() => normalizeConfig({ sources: "skills" }), /sources/);
  assert.throws(() => normalizeConfig({ routing: { minimumMargin: 2 } }), /minimumMargin/);
  assert.throws(() => normalizeConfig({ aliases: { release: false } }), /aliases/);
});
