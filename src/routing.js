import {
  applicabilityMatches,
  hasPositiveClause,
  negativePhraseMatch,
  normalizeText as normalize,
  phraseMatches,
  skillPolicy,
  tokenize as tokens,
  workflowRunMode,
} from "./policy.js";

function globMatches(value, pattern) {
  const expression = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*");
  return new RegExp(`^${expression}$`).test(value);
}

function included(id, config) {
  const include = config.include.length === 0 || config.include.some((pattern) => globMatches(id, pattern));
  return include && !config.exclude.some((pattern) => globMatches(id, pattern));
}

function overlap(queryTokens, fieldTokens) {
  if (queryTokens.length === 0 || fieldTokens.length === 0) return 0;
  const field = new Set(fieldTokens);
  return queryTokens.filter((token) => field.has(token)).length / queryTokens.length;
}

function scoreSkill(request, skill) {
  const queryTokens = tokens(request);
  const idTokens = tokens(skill.id);
  const nameTokens = tokens(skill.name);
  const descriptionTokens = tokens(skill.description);
  const score =
    0.5 * overlap(queryTokens, idTokens) +
    0.2 * overlap(queryTokens, nameTokens) +
    0.6 * overlap(queryTokens, descriptionTokens);
  return Math.min(1, Number(score.toFixed(4)));
}

/** Availability plus the negative-applicability hard veto used by every stage. */
function available(skill, config, requestTokens) {
  if (skill.enabled === false) return false;
  if (!included(skill.id, config)) return false;
  if (config.skills[skill.id]?.enabled === false) return false;
  return !negativePhraseMatch(skillPolicy(config, skill.id).applicability, requestTokens);
}

function workflowConfigured(config) {
  return config.routing.allowSequences === true && Object.keys(config.workflows ?? {}).length > 0;
}

/**
 * Inferred scoring applies the whole applicability policy: `available()` carries
 * the negative veto that also guards exact IDs and aliases, while the positive
 * `all`/`any` clauses gate inference only.
 */
function scorePool(request, registry, config, requestTokens, matches) {
  return registry.skills
    .filter((skill) => available(skill, config, requestTokens))
    .filter((skill) => {
      const policy = skillPolicy(config, skill.id);
      return applicabilityMatches(policy.applicability, requestTokens) && matches(policy);
    })
    .map((skill) => {
      const override = config.skills[skill.id];
      const effective = {
        ...skill,
        ...(override?.description ? { description: override.description } : {}),
      };
      return { id: skill.id, score: scoreSkill(request, effective) };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function handoffField(config, ids) {
  const handoffs = [...new Set(ids.flatMap((id) => skillPolicy(config, id).handoffTo))].sort();
  return handoffs.length ? { handoffs } : {};
}

function compactSteps(steps) {
  return steps.map((step) => ({ skillId: step.skill }));
}

/**
 * Steps are filtered by their `when` condition against the original request.
 * Every other step is active for the request: if its skill is missing,
 * disabled, excluded, or inapplicable the workflow outcome is invalidated
 * instead of silently shrinking the sequence. Returns `null` when the workflow
 * cannot run as declared.
 */
function effectiveSteps(workflow, config, registry, requestTokens) {
  const steps = [];
  for (const step of workflow.steps) {
    if (step.when !== undefined && !phraseMatches(step.when, requestTokens)) continue;
    const skill = registry.skills.find((candidate) => candidate.id === step.skill);
    if (!skill || !available(skill, config, requestTokens)) return null;
    if (!applicabilityMatches(skillPolicy(config, step.skill).applicability, requestTokens)) return null;
    steps.push(step);
  }
  return steps;
}

function explicitSkill(skill, config, requestTokens, reason) {
  if (!available(skill, config, requestTokens)) return null;
  const policy = skillPolicy(config, skill.id);
  if (policy.invocation === "advisory") {
    return {
      outcome: "advise",
      recommendation: { kind: "skill", id: skill.id },
      reason,
      ...handoffField(config, [skill.id]),
    };
  }
  return {
    outcome: "select",
    skillId: skill.id,
    confidence: 1,
    reason,
    ...handoffField(config, [skill.id]),
  };
}

function workflowOutcome(id, workflow, config, registry, requestTokens, reason, explicit) {
  if (negativePhraseMatch(workflow.applicability, requestTokens)) return null;
  const steps = effectiveSteps(workflow, config, registry, requestTokens);
  if (!steps || steps.length === 0) return null;
  const handoffs = handoffField(
    config,
    steps.map((step) => step.skill),
  );
  // The run mode is derived from the steps that actually run, so a skipped
  // conditional step can neither downgrade nor upgrade the outcome.
  if (workflowRunMode(workflow, config, { explicit, steps }) === "advise") {
    return {
      outcome: "advise",
      recommendation: { kind: "workflow", id, steps: compactSteps(steps) },
      reason,
      ...handoffs,
    };
  }
  return {
    outcome: "sequence",
    workflowId: id,
    steps: compactSteps(steps),
    reason,
    ...handoffs,
  };
}

function inferredWorkflows(config, registry, requestTokens) {
  const matches = [];
  for (const [id, workflow] of Object.entries(config.workflows ?? {})) {
    if (!hasPositiveClause(workflow.applicability)) continue;
    if (!applicabilityMatches(workflow.applicability, requestTokens)) continue;
    if (workflowRunMode(workflow, config, { explicit: false }) === "exclude") continue;
    // A matched workflow with a null outcome could not run as declared: an
    // active required step is missing, disabled, excluded, or inapplicable.
    matches.push({
      id,
      outcome: workflowOutcome(id, workflow, config, registry, requestTokens, "applicable-workflow", false),
    });
  }
  return matches.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Terminal outcome for a workflow that matched the request but cannot run as
 * declared. Routing must stop here: falling through would auto-select a
 * remaining step or an unrelated skill as if the workflow had never matched.
 */
function workflowUnavailable(id) {
  return { outcome: "none", workflowId: id, reason: "workflow-unavailable" };
}

function asAdvise(outcome) {
  if (outcome.outcome === "select") {
    const advice = {
      outcome: "advise",
      recommendation: { kind: "skill", id: outcome.skillId },
      reason: outcome.reason,
    };
    if (outcome.confidence !== undefined) advice.confidence = outcome.confidence;
    if (outcome.candidates !== undefined) advice.candidates = outcome.candidates;
    if (outcome.handoffs !== undefined) advice.handoffs = outcome.handoffs;
    return advice;
  }
  const advice = {
    outcome: "advise",
    recommendation: { kind: "workflow", id: outcome.workflowId, steps: outcome.steps },
    reason: outcome.reason,
  };
  if (outcome.handoffs !== undefined) advice.handoffs = outcome.handoffs;
  return advice;
}

/**
 * Automatic and advisory skills are ranked in one pool so the strongest
 * candidate wins regardless of policy; explicit-only skills never enter
 * inference. Threshold and margin are applied to the unified ranking, then the
 * winning skill's policy decides between `select` and `advise`.
 */
function routeScoring(request, registry, config, requestTokens) {
  const scored = scorePool(
    request,
    registry,
    config,
    requestTokens,
    (policy) => policy.invocation !== "explicit-only",
  );
  const candidates = scored.slice(0, config.routing.maxCandidates);
  const top = scored[0];
  if (!top || top.score < config.routing.minimumScore) {
    return { outcome: "none", candidates, reason: "below-threshold" };
  }

  const runnerUp = scored[1];
  const margin = top.score - (runnerUp?.score ?? 0);
  if (runnerUp && margin < config.routing.minimumMargin) {
    return { outcome: "clarify", candidates, reason: "ambiguous" };
  }

  if (skillPolicy(config, top.id).invocation === "advisory") {
    return {
      outcome: "advise",
      recommendation: { kind: "skill", id: top.id },
      confidence: top.score,
      reason: "advisory-policy",
      ...handoffField(config, [top.id]),
    };
  }

  return {
    outcome: "select",
    skillId: top.id,
    confidence: top.score,
    candidates,
    reason: "deterministic-score",
    ...handoffField(config, [top.id]),
  };
}

export function routeRequest(request, registry, config) {
  if (typeof request !== "string" || !request.trim()) {
    throw new Error("route request must be a non-empty string");
  }

  const advisoryMode = config.routing.mode === "advisory";
  const normalizedRequest = normalize(request);
  const requestTokens = new Set(tokens(request));
  const decide = () => {
    if (Object.keys(config.aliases).length) {
      for (const [alias, id] of Object.entries(config.aliases)) {
        if (normalize(alias) !== normalizedRequest) continue;
        const skill = registry.skills.find((candidate) => candidate.id === id);
        if (skill) {
          const explicit = explicitSkill(skill, config, requestTokens, "alias");
          if (explicit) return explicit;
          continue;
        }
        if (workflowConfigured(config)) {
          const workflow = config.workflows[id];
          if (workflow) {
            const outcome = workflowOutcome(id, workflow, config, registry, requestTokens, "alias", true);
            // The alias named this workflow, so an unusable one is terminal:
            // routing may not fall through to heuristic skill selection.
            return outcome ?? workflowUnavailable(id);
          }
        }
      }
    }

    const exact = registry.skills.find((skill) => skill.id === request.trim());
    if (exact) {
      const outcome = explicitSkill(exact, config, requestTokens, "exact-id");
      if (outcome) return outcome;
    }
    if (workflowConfigured(config)) {
      const id = Object.keys(config.workflows).find((candidate) => candidate === request.trim());
      if (id) {
        const outcome = workflowOutcome(id, config.workflows[id], config, registry, requestTokens, "exact-id", true);
        // An explicit workflow request never degrades into individual skill
        // scoring when the workflow itself cannot run.
        return outcome ?? workflowUnavailable(id);
      }
    }

    if (workflowConfigured(config)) {
      const matches = inferredWorkflows(config, registry, requestTokens);
      const runnable = matches.filter((match) => match.outcome);
      const blocked = matches.filter((match) => !match.outcome);
      // Ambiguity still counts only workflows that can actually run; a matched
      // workflow that failed its step gate is terminal, not a fall-through cue.
      if (runnable.length > 1) {
        return {
          outcome: "clarify",
          candidates: [],
          workflows: runnable.map((match) => match.id),
          reason: "ambiguous-workflows",
        };
      }
      if (runnable.length === 1) return runnable[0].outcome;
      if (blocked.length) return workflowUnavailable(blocked[0].id);
    }

    return routeScoring(request, registry, config, requestTokens);
  };

  const outcome = decide();
  return advisoryMode && (outcome.outcome === "select" || outcome.outcome === "sequence")
    ? asAdvise(outcome)
    : outcome;
}

export const routingInternals = { normalize, tokens, globMatches, scoreSkill };
