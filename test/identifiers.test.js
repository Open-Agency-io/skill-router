import assert from "node:assert/strict";
import test from "node:test";
import {
  assertValidId,
  classifyId,
  isReservedId,
  isValidId,
  MAX_ID_LENGTH,
  PORTABLE_ID,
  RESERVED_ID,
} from "../src/identifiers.js";

test("exports the shared grammar constants with exact ownership", () => {
  assert.equal(PORTABLE_ID.source, "^[a-z0-9]+(?:-[a-z0-9]+)*$");
  assert.equal(PORTABLE_ID.global, false);
  assert.equal(MAX_ID_LENGTH, 64);
  assert.equal(RESERVED_ID, "skill-router");
});

test("accepts the exhaustive valid matrix, including prototype names and Claude-family names", () => {
  const valid = [
    "a",
    "0",
    "z9",
    "git-release",
    "release-2",
    "skill-router-x",
    "skillrouter",
    "skill-router-2",
    // Prototype- and command-sensitive names are ordinary portable IDs; the
    // null-prototype maps in config/registry are what make them safe.
    "constructor",
    "prototype",
    "to-string",
    "synced",
    // Broad Claude/Anthropic names are explicitly valid, not reserved.
    "anthropic-skills",
    "anthropic",
    "claude",
    "claude-helper",
    "verify",
    "simplify",
    "doctor",
    // Exact length boundaries.
    "a".repeat(1),
    "a".repeat(64),
    `a-${"bc-".repeat(20)}de`, // 64 characters
    "0".repeat(64),
  ];
  for (const id of valid) {
    assert.equal(classifyId(id), null, `${JSON.stringify(id)} should be valid`);
    assert.equal(isValidId(id), true, `${JSON.stringify(id)} should be valid`);
    assert.doesNotThrow(() => assertValidId(id, "test"));
  }
});

test("rejects the exhaustive invalid matrix with the exact reason", () => {
  const invalid = new Map([
    ["A", "grammar"],
    ["aB", "grammar"],
    ["skill_router", "grammar"],
    ["a_b", "grammar"],
    ["-a", "grammar"],
    ["a-", "grammar"],
    ["a--b", "grammar"],
    ["a b", "grammar"],
    ["a.b", "grammar"],
    ["a/b", "grammar"],
    ["café", "grammar"],
    ["SKILL", "grammar"],
    ["Skill-Router", "grammar"],
    ["skill-router ", "grammar"],
    [" skill-router", "grammar"],
    ["skill router", "grammar"],
    ["skill-router\n", "grammar"],
    ["\nskill-router", "grammar"],
    ["a\u0000b", "grammar"],
    ["a\u001b[31m", "grammar"],
    ["", "empty"],
    ["a".repeat(65), "length"],
    ["a-".repeat(33), "length"], // 66 characters
    ["x".repeat(100_000), "length"],
    ["skill-router", "reserved"],
  ]);
  for (const [id, reason] of invalid) {
    assert.equal(classifyId(id), reason, `${JSON.stringify(id)} should be ${reason}`);
    assert.equal(isValidId(id), false, `${JSON.stringify(id)} should be invalid`);
    assert.throws(() => assertValidId(id, "test"));
  }
});

test("classifies non-string values without inspecting them", () => {
  for (const value of [null, undefined, 0, 1, true, false, 42n, {}, [], Symbol("x"), () => {}]) {
    assert.equal(classifyId(value), "type");
    assert.equal(isValidId(value), false);
  }
});

test("reserves exactly skill-router and nothing else", () => {
  assert.equal(isReservedId("skill-router"), true);
  for (const value of ["SKILL-ROUTER", "Skill-Router", "skill-router ", "skill-router-2", "skillrouter", "", null]) {
    assert.equal(isReservedId(value), false, `${JSON.stringify(value)} should not be reserved`);
  }
  // Case variants fail grammar, never the reservation reason.
  assert.equal(classifyId("Skill-Router"), "grammar");
  assert.equal(classifyId("SKILL-ROUTER"), "grammar");
});

test("assertion errors are fixed, bounded, and never echo the malformed value", () => {
  const junk = `Bad-${"x".repeat(100_000)}`;
  assert.throws(
    () => assertValidId(junk, "skills key"),
    (error) => {
      assert.equal(error.message, `skills key must be a portable ID: lowercase letters, digits, and hyphens, at most ${MAX_ID_LENGTH} characters`);
      assert.equal(error.message.includes("xxx"), false);
      assert.equal(error.message.length < 200, true);
      return true;
    },
  );
  assert.throws(
    () => assertValidId("skill-router", "workflows key"),
    (error) => {
      assert.equal(error.message, "workflows key uses the reserved skill-router ID");
      return true;
    },
  );
  for (const value of ["zz\u0000qq", "zz\u001b[2J", "zz\nqq"]) {
    assert.throws(
      () => assertValidId(value, "alias target"),
      (error) => {
        assert.equal(/[\u0000-\u001f]/.test(error.message), false, "message must be control-free");
        assert.equal(error.message.includes("zz"), false, "message must not echo the value");
        assert.equal(error.message.includes("qq"), false, "message must not echo the value");
        return true;
      },
    );
  }
});
