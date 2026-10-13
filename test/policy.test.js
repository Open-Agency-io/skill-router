import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig } from "../src/config.js";
import { configPolicy, policyFingerprint, referenceDiagnostics } from "../src/policy.js";
import { registryFingerprint } from "../src/registry.js";

function v2(value) {
  return normalizeConfig({ schemaVersion: 2, routing: { allowSequences: true }, ...value });
}

function codes(diagnostics) {
  return diagnostics.map((item) => item.code).sort();
}

test("flags cross-references to unknown skills and workflows", () => {
  const config = v2({
    aliases: { ship: "ghost" },
    skills: { release: { handoffTo: ["phantom"] } },
    workflows: { flow: { steps: [{ skill: "release" }, { skill: "phantom" }] } },
  });
  const diagnostics = referenceDiagnostics(config, [{ id: "release", enabled: true }]);
  assert.deepEqual(codes(diagnostics), [
    "alias-unknown-target",
    "handoff-unknown-skill",
    "workflow-unknown-skill",
  ]);
  assert.ok(diagnostics.every((item) => item.level === "error"));
});

test("warns about disabled cross-reference targets but blocks disabled workflow steps", () => {
  const config = v2({
    aliases: { ship: "release" },
    skills: { review: { handoffTo: ["release"] } },
    workflows: { flow: { steps: [{ skill: "release" }, { skill: "review" }] } },
  });
  const diagnostics = referenceDiagnostics(config, [
    { id: "release", enabled: false },
    { id: "review", enabled: true },
  ]);
  assert.deepEqual(codes(diagnostics), [
    "alias-disabled-target",
    "handoff-disabled-target",
    "workflow-disabled-step",
  ]);
  const levels = new Map(diagnostics.map((item) => [item.code, item.level]));
  // A disabled step would silently shrink a required gate, so build and init
  // must refuse it instead of downgrading it to advice.
  assert.equal(levels.get("alias-disabled-target"), "warning");
  assert.equal(levels.get("handoff-disabled-target"), "warning");
  assert.equal(levels.get("workflow-disabled-step"), "error");
});

test("keeps the shared skill and workflow namespace case-insensitive against the registry", () => {
  const config = v2({ workflows: { release: { steps: [{ skill: "review" }] } } });
  const diagnostics = referenceDiagnostics(config, [
    { id: "Release", enabled: true },
    { id: "review", enabled: true },
  ]);
  const collision = diagnostics.find((item) => item.code === "skill-workflow-collision");
  assert.ok(collision, "expected a case-insensitive skill/workflow collision");
  assert.equal(collision.level, "error");
  assert.match(collision.message, /Release/);
  assert.match(collision.message, /ignoring case/);
});

test("skips cross-reference validation for schema version 1", () => {
  const config = normalizeConfig({ aliases: { ship: "ghost" } });
  assert.deepEqual(referenceDiagnostics(config, []), []);
});

test("policy fingerprints cover every routing-relevant configuration field", () => {
  const base = normalizeConfig({ schemaVersion: 2, routing: { allowSequences: true } });
  const fingerprint = policyFingerprint(configPolicy(base));
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(
    fingerprint,
    policyFingerprint(configPolicy(normalizeConfig({ schemaVersion: 2, routing: { allowSequences: true } }))),
  );

  const variants = [
    { schemaVersion: 2, routing: { allowSequences: true, minimumScore: 0.9 } },
    { schemaVersion: 2, routing: { allowSequences: true, minimumMargin: 0.4 } },
    { schemaVersion: 2, routing: { allowSequences: true, maxCandidates: 2 } },
    { schemaVersion: 2, routing: { allowSequences: true, mode: "advisory" } },
    { schemaVersion: 2, routing: { allowSequences: true }, sources: ["./team-skills"] },
    { schemaVersion: 2, routing: { allowSequences: true }, include: ["release*"] },
    { schemaVersion: 2, routing: { allowSequences: true }, exclude: ["release*"] },
    { schemaVersion: 2, routing: { allowSequences: true }, aliases: { ship: "release" } },
    { schemaVersion: 2, routing: { allowSequences: true }, skills: { release: { enabled: false } } },
    { schemaVersion: 2, routing: { allowSequences: true }, skills: { release: { description: "override" } } },
    { schemaVersion: 2, routing: { allowSequences: true }, skills: { release: { source: "./skills/release" } } },
    { schemaVersion: 2, routing: { allowSequences: true }, skills: { release: { invocation: "advisory" } } },
    { schemaVersion: 2, routing: { allowSequences: true }, skills: { release: { applicability: { none: ["docs"] } } } },
    { schemaVersion: 2, routing: { allowSequences: true }, skills: { release: { handoffTo: ["review"] } } },
    { schemaVersion: 2, routing: { allowSequences: true }, workflows: { flow: { steps: [{ skill: "release" }] } } },
  ];
  for (const variant of variants) {
    assert.notEqual(
      policyFingerprint(configPolicy(normalizeConfig(variant))),
      fingerprint,
      `policy fingerprint ignored ${JSON.stringify(variant)}`,
    );
  }
});

test("policy fingerprints cover source order and content", () => {
  const base = normalizeConfig({ schemaVersion: 2, routing: { allowSequences: true }, sources: ["./a", "./b"] });
  const fingerprint = policyFingerprint(configPolicy(base));
  const variants = [
    { schemaVersion: 2, routing: { allowSequences: true }, sources: ["./a"] },
    { schemaVersion: 2, routing: { allowSequences: true }, sources: ["./b", "./a"] },
    { schemaVersion: 2, routing: { allowSequences: true }, sources: ["./a", "./c"] },
  ];
  for (const variant of variants) {
    assert.notEqual(
      policyFingerprint(configPolicy(normalizeConfig(variant))),
      fingerprint,
      `policy fingerprint ignored ${JSON.stringify(variant)}`,
    );
  }
  assert.deepEqual(configPolicy(base).sources, ["./a", "./b"]);
});

test("flags aliases that collide with skills, workflows, and other aliases", () => {
  const skills = [
    { id: "release-notes", enabled: true },
    { id: "other", enabled: true },
    { id: "one", enabled: true },
    { id: "two", enabled: true },
  ];
  // Raw configuration objects: normalizeConfig rejects these combinations at
  // authoring time, but the registry layer must report them on its own.
  const diagnose = (aliases, workflows) =>
    referenceDiagnostics(
      { schemaVersion: 2, aliases, skills: {}, ...(workflows ? { workflows } : {}) },
      skills,
    );
  const collisions = (aliases, workflows) =>
    diagnose(aliases, workflows).filter((item) => item.code === "alias-collision");

  const expected = [
    'Alias "release notes" collides with skill release-notes after normalization',
    'Alias "ship-it" collides with alias "ship it" after normalization',
  ];
  const aliases = { "release notes": "other", "ship it": "one", "ship-it": "two" };
  const reversed = { "ship-it": "two", "ship it": "one", "release notes": "other" };
  assert.deepEqual(collisions(aliases).map((item) => item.message).sort(), expected);
  assert.deepEqual(collisions(reversed).map((item) => item.message).sort(), expected);
  assert.ok(collisions(aliases).every((item) => item.level === "error"));

  assert.deepEqual(collisions({ "change gate": "one" }, { "change-gate": { steps: [{ skill: "one" }] } }), [
    {
      level: "error",
      code: "alias-collision",
      id: "change gate",
      message: 'Alias "change gate" collides with workflow change-gate after normalization',
    },
  ]);
  assert.deepEqual(collisions({ ship: "other" }), []);
});

test("registry fingerprints cannot ignore a policy-only change", () => {
  const entries = [{ kind: "source", source: "/skills", sourceIndex: 0, status: "directory" }];
  const before = normalizeConfig({ schemaVersion: 2, routing: { allowSequences: true } });
  const after = normalizeConfig({
    schemaVersion: 2,
    routing: { allowSequences: true, minimumScore: 0.9 },
  });
  assert.equal(
    registryFingerprint(entries, configPolicy(before)),
    registryFingerprint(entries, configPolicy(before)),
  );
  assert.notEqual(
    registryFingerprint(entries, configPolicy(before)),
    registryFingerprint(entries, configPolicy(after)),
  );
  assert.notEqual(registryFingerprint(entries, null), registryFingerprint(entries, configPolicy(before)));
});
