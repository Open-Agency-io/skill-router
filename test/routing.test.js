import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig } from "../src/config.js";
import { routeRequest } from "../src/routing.js";

const registry = {
  skills: [
    { id: "git-release", name: "Git Release", description: "Prepare notes and publish releases", enabled: true },
    { id: "code-review", name: "Code Review", description: "Review code for correctness", enabled: true },
    { id: "deploy-api", name: "Deploy API", description: "Deploy a service to production", enabled: true },
    { id: "deploy-web", name: "Deploy Web", description: "Deploy a service to production", enabled: true },
  ],
};

test("selects exact IDs and aliases without scoring", () => {
  const config = normalizeConfig({ aliases: { "ship it": "git-release" } });
  assert.equal(routeRequest("git-release", registry, config).reason, "exact-id");
  assert.equal(routeRequest("ship it", registry, config).skillId, "git-release");
});

test("selects a clear description match", () => {
  const result = routeRequest("review code for correctness", registry, normalizeConfig());
  assert.equal(result.outcome, "select");
  assert.equal(result.skillId, "code-review");
});

test("abstains for unrelated requests and clarifies close matches", () => {
  assert.equal(routeRequest("calculate orbital velocity", registry, normalizeConfig()).outcome, "none");
  const ambiguous = routeRequest("deploy service production", registry, normalizeConfig());
  assert.equal(ambiguous.outcome, "clarify");
  assert.deepEqual(ambiguous.candidates.slice(0, 2).map((item) => item.id), ["deploy-api", "deploy-web"]);
});

test("calculates ambiguity before truncating the returned shortlist", () => {
  const config = normalizeConfig({ routing: { maxCandidates: 1 } });
  const result = routeRequest("deploy service production", registry, config);
  assert.equal(result.outcome, "clarify");
  assert.equal(result.candidates.length, 1);
});

test("honors include, exclude, disabled skills, and description overrides", () => {
  const excluded = normalizeConfig({ exclude: ["code-*"] });
  assert.equal(routeRequest("code-review", registry, excluded).outcome, "none");

  const disabled = normalizeConfig({ skills: { "git-release": { enabled: false } } });
  assert.equal(routeRequest("git-release", registry, disabled).outcome, "none");

  const override = normalizeConfig({
    skills: { "git-release": { description: "calculate orbital velocity" } },
  });
  assert.equal(routeRequest("calculate orbital velocity", registry, override).skillId, "git-release");
});
