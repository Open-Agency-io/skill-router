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

function v2Config(value) {
  return normalizeConfig({ schemaVersion: 2, routing: { allowSequences: true }, ...value });
}

const gate = {
  description: "Review a change and run its tests",
  invocation: "automatic",
  applicability: { any: ["review the change"] },
  steps: [{ skill: "git-release" }, { skill: "code-review" }],
};

test("routes applicable workflows as ordered sequences", () => {
  const config = v2Config({ workflows: { "change-gate": gate } });
  const result = routeRequest("please review the change", registry, config);
  assert.equal(result.outcome, "sequence");
  assert.equal(result.workflowId, "change-gate");
  assert.deepEqual(result.steps, [{ skillId: "git-release" }, { skillId: "code-review" }]);
  assert.equal(result.reason, "applicable-workflow");
  assert.equal(routeRequest("review the change", registry, config).outcome, "sequence");
  assert.equal(routeRequest("calculate orbital velocity", registry, config).outcome, "none");
});

test("advises by default for workflows without an automatic invocation", () => {
  const { invocation, ...advisoryWorkflow } = gate;
  const config = v2Config({ workflows: { "change-gate": advisoryWorkflow } });
  const result = routeRequest("review the change", registry, config);
  assert.equal(result.outcome, "advise");
  assert.deepEqual(result.recommendation, {
    kind: "workflow",
    id: "change-gate",
    steps: [{ skillId: "git-release" }, { skillId: "code-review" }],
  });
  assert.equal(result.workflowId, undefined);
});

test("selects explicit workflows and aliases by exact ID", () => {
  const config = v2Config({
    aliases: { gate: "change-gate" },
    workflows: { "change-gate": gate },
  });
  assert.equal(routeRequest("change-gate", registry, config).outcome, "sequence");
  assert.equal(routeRequest("gate", registry, config).outcome, "sequence");
  assert.equal(routeRequest("gate", registry, config).workflowId, "change-gate");
});

test("keeps explicit-only skills out of inferred routing but selectable exactly", () => {
  const config = v2Config({ skills: { "code-review": { invocation: "explicit-only" } } });
  assert.equal(routeRequest("review code for correctness", registry, config).outcome, "none");
  const exact = routeRequest("code-review", registry, config);
  assert.equal(exact.outcome, "select");
  assert.equal(exact.skillId, "code-review");
  assert.equal(exact.reason, "exact-id");
});

test("never auto-selects advisory policy, including through exact IDs", () => {
  const config = v2Config({ skills: { "git-release": { invocation: "advisory" } } });
  const exact = routeRequest("git-release", registry, config);
  assert.equal(exact.outcome, "advise");
  assert.deepEqual(exact.recommendation, { kind: "skill", id: "git-release" });
  const inferred = routeRequest("prepare notes and publish releases", registry, config);
  assert.equal(inferred.outcome, "advise");
  assert.deepEqual(inferred.recommendation, { kind: "skill", id: "git-release" });
});

test("global advisory mode downgrades every selection to advice", () => {
  const config = v2Config({
    routing: { allowSequences: true, mode: "advisory" },
    workflows: { "change-gate": gate },
  });
  const exact = routeRequest("git-release", registry, config);
  assert.equal(exact.outcome, "advise");
  assert.deepEqual(exact.recommendation, { kind: "skill", id: "git-release" });
  assert.equal(exact.reason, "exact-id");
  assert.equal(routeRequest("review code for correctness", registry, config).outcome, "advise");
  const sequence = routeRequest("review the change", registry, config);
  assert.equal(sequence.outcome, "advise");
  assert.equal(sequence.recommendation.kind, "workflow");
  assert.equal(routeRequest("deploy service production", registry, config).outcome, "clarify");
});

test("negative applicability vetoes exact IDs, aliases, and inference", () => {
  const config = v2Config({
    aliases: { ship: "git-release", "release checklist": "git-release" },
    skills: { "git-release": { applicability: { none: ["release"] } } },
  });
  assert.equal(routeRequest("git-release", registry, config).outcome, "none");
  // The veto inspects the request: an alias phrase that carries the negative
  // token is refused, an unrelated alias phrase still resolves.
  assert.equal(routeRequest("release checklist", registry, config).outcome, "none");
  assert.equal(routeRequest("ship", registry, config).outcome, "select");
  assert.equal(routeRequest("git-release documentation", registry, config).outcome, "none");
  assert.equal(routeRequest("prepare notes and publish releases", registry, config).outcome, "select");
});

test("positive applicability gates inferred skill routing only", () => {
  const config = v2Config({
    skills: { "code-review": { applicability: { all: ["pull request"] } } },
  });
  assert.equal(routeRequest("review code for correctness", registry, config).outcome, "none");
  assert.equal(routeRequest("code-review", registry, config).outcome, "select");
  assert.equal(
    routeRequest("review code for correctness pull request", registry, config).skillId,
    "code-review",
  );
});

test("clarifies when multiple workflows match", () => {
  const config = v2Config({
    workflows: {
      "alpha-gate": { ...gate, steps: [{ skill: "git-release" }] },
      "beta-gate": { ...gate, steps: [{ skill: "code-review" }] },
    },
  });
  const result = routeRequest("review the change", registry, config);
  assert.equal(result.outcome, "clarify");
  assert.equal(result.reason, "ambiguous-workflows");
  assert.deepEqual(result.workflows, ["alpha-gate", "beta-gate"]);
  assert.deepEqual(result.candidates, []);
});

test("does not infer workflows without a positive applicability clause", () => {
  const config = v2Config({
    workflows: {
      "change-gate": {
        description: gate.description,
        invocation: gate.invocation,
        steps: gate.steps,
      },
    },
  });
  const result = routeRequest("review code for correctness", registry, config);
  assert.equal(result.outcome, "select");
  assert.equal(result.skillId, "code-review");
  assert.equal(routeRequest("change-gate", registry, config).outcome, "sequence");
});

test("most restrictive step policy downgrades workflow inference to advice", () => {
  const config = v2Config({
    skills: { "git-release": { invocation: "advisory" } },
    workflows: { "change-gate": gate },
  });
  const inferred = routeRequest("review the change", registry, config);
  assert.equal(inferred.outcome, "advise");
  assert.equal(inferred.recommendation.kind, "workflow");
  const explicit = routeRequest("change-gate", registry, config);
  assert.equal(explicit.outcome, "advise");
  assert.equal(explicit.recommendation.kind, "workflow");
});

test("explicit workflows may run explicit-only steps", () => {
  const config = v2Config({
    skills: { "deploy-api": { invocation: "explicit-only" } },
    workflows: {
      "ship-it": {
        invocation: "automatic",
        applicability: { any: ["ship it"] },
        steps: [{ skill: "deploy-api" }, { skill: "git-release" }],
      },
    },
  });
  const explicit = routeRequest("ship-it", registry, config);
  assert.equal(explicit.outcome, "sequence");
  assert.deepEqual(explicit.steps, [{ skillId: "deploy-api" }, { skillId: "git-release" }]);
  const inferred = routeRequest("deploy a service to production ship it", registry, config);
  assert.equal(inferred.outcome, "advise");
  assert.equal(inferred.recommendation.kind, "workflow");
});

test("step conditions inspect only the original request", () => {
  const config = v2Config({
    workflows: {
      "change-gate": {
        invocation: "automatic",
        applicability: { any: ["change"] },
        steps: [
          { skill: "code-review", when: "tests failed" },
          { skill: "git-release" },
        ],
      },
    },
  });
  const matched = routeRequest("change tests failed", registry, config);
  assert.deepEqual(matched.steps, [{ skillId: "code-review" }, { skillId: "git-release" }]);
  const unmatched = routeRequest("change looks good", registry, config);
  assert.deepEqual(unmatched.steps, [{ skillId: "git-release" }]);
});

test("returns handoff relationships as advisory IDs without following them", () => {
  const config = v2Config({ skills: { "git-release": { handoffTo: ["code-review"] } } });
  const selected = routeRequest("git-release", registry, config);
  assert.equal(selected.outcome, "select");
  assert.equal(selected.skillId, "git-release");
  assert.deepEqual(selected.handoffs, ["code-review"]);
  const advised = routeRequest("git-release", registry, v2Config({
    skills: { "git-release": { invocation: "advisory", handoffTo: ["code-review"] } },
  }));
  assert.equal(advised.outcome, "advise");
  assert.deepEqual(advised.handoffs, ["code-review"]);
  assert.equal(advised.skillId, undefined);
});

test("ranks automatic and advisory skills in one pool before choosing an outcome", () => {
  const stronger = v2Config({
    skills: {
      "code-review": { description: "Review correctness" },
      "git-release": { invocation: "advisory", description: "Review code and prepare the release" },
    },
  });
  const advised = routeRequest("review code release", registry, stronger);
  assert.equal(advised.outcome, "advise");
  assert.deepEqual(advised.recommendation, { kind: "skill", id: "git-release" });
  assert.equal(advised.reason, "advisory-policy");
  assert.equal(advised.confidence, 0.8333);
  // Without the advisory competitor the weaker automatic skill would win, so
  // the outcome proves both policies were ranked together.
  const selected = routeRequest("review code release", registry, v2Config({
    skills: { "code-review": { description: "Review correctness" } },
  }));
  assert.equal(selected.outcome, "select");
  assert.equal(selected.skillId, "code-review");

  const close = v2Config({
    skills: {
      "code-review": { description: "Review correctness" },
      "git-release": { invocation: "advisory", description: "Review correctness release" },
    },
  });
  const ambiguous = routeRequest("review code release", registry, close);
  assert.equal(ambiguous.outcome, "clarify");
  assert.equal(ambiguous.reason, "ambiguous");
  assert.deepEqual(
    ambiguous.candidates.slice(0, 2).map((item) => item.id),
    ["code-review", "git-release"],
  );
});

test("invalidates a workflow when an active step cannot run", () => {
  const workflows = {
    "change-gate": {
      invocation: "automatic",
      applicability: { any: ["review the change"] },
      steps: [{ skill: "git-release" }, { skill: "code-review" }],
    },
  };
  const request = "review the change";
  const blocked = [
    v2Config({ skills: { "code-review": { enabled: false } }, workflows }),
    v2Config({ exclude: ["code-*"], workflows }),
    v2Config({ skills: { "code-review": { applicability: { all: ["pull request"] } } }, workflows }),
    v2Config({ workflows }),
  ];
  const partial = { ...registry, skills: registry.skills.filter((skill) => skill.id !== "code-review") };
  for (const config of blocked.slice(0, 3)) {
    assert.equal(routeRequest(request, registry, config).outcome, "none");
  }
  assert.equal(routeRequest(request, partial, blocked[3]).outcome, "none");
  // The required gate stays in the sequence while it can still run.
  const healthy = routeRequest(request, registry, v2Config({ workflows }));
  assert.equal(healthy.outcome, "sequence");
  assert.deepEqual(healthy.steps, [{ skillId: "git-release" }, { skillId: "code-review" }]);
});

test("terminates a matched workflow whose required step cannot run", () => {
  const workflows = {
    "change-gate": {
      invocation: "automatic",
      applicability: { any: ["review the change"] },
      steps: [{ skill: "deploy-web" }, { skill: "code-review" }],
    },
  };
  const config = v2Config({
    aliases: { "review gate": "change-gate" },
    skills: { "deploy-web": { applicability: { all: ["deploy the service"] } } },
    workflows,
  });

  // The blocked request still scores strongly for code-review, so a fall-through
  // to heuristic selection would auto-select a skill as if the workflow had
  // never matched. Every match kind stops at the failed gate instead.
  const inferred = routeRequest("review the change", registry, config);
  assert.equal(inferred.outcome, "none");
  assert.equal(inferred.reason, "workflow-unavailable");
  assert.equal(inferred.workflowId, "change-gate");
  assert.equal(inferred.skillId, undefined);

  const aliased = routeRequest("review gate", registry, config);
  assert.equal(aliased.outcome, "none");
  assert.equal(aliased.reason, "workflow-unavailable");
  assert.equal(aliased.workflowId, "change-gate");
  assert.equal(aliased.skillId, undefined);

  const exact = routeRequest("change-gate", registry, config);
  assert.equal(exact.outcome, "none");
  assert.equal(exact.reason, "workflow-unavailable");
  assert.equal(exact.workflowId, "change-gate");
  assert.equal(exact.skillId, undefined);
});

test("counts only runnable workflows for inferred ambiguity", () => {
  const config = v2Config({
    skills: { "deploy-web": { applicability: { all: ["deploy the service"] } } },
    workflows: {
      "alpha-gate": { ...gate, steps: [{ skill: "git-release" }] },
      "beta-gate": { ...gate, steps: [{ skill: "deploy-web" }] },
    },
  });
  const result = routeRequest("review the change", registry, config);
  assert.equal(result.outcome, "sequence");
  assert.equal(result.workflowId, "alpha-gate");
});

test("only false step conditions may leave an automatic sequence", () => {
  const config = v2Config({
    skills: { "git-release": { invocation: "advisory" } },
    workflows: {
      "change-gate": {
        invocation: "automatic",
        applicability: { any: ["review the change"] },
        steps: [{ skill: "git-release", when: "publish too" }, { skill: "code-review" }],
      },
    },
  });
  const skipped = routeRequest("review the change", registry, config);
  assert.equal(skipped.outcome, "sequence");
  assert.deepEqual(skipped.steps, [{ skillId: "code-review" }]);
  const included = routeRequest("review the change publish too", registry, config);
  assert.equal(included.outcome, "advise");
  assert.deepEqual(included.recommendation, {
    kind: "workflow",
    id: "change-gate",
    steps: [{ skillId: "git-release" }, { skillId: "code-review" }],
  });
});
