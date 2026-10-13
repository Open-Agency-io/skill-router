import { createHash } from "node:crypto";

export const INVOCATION_VALUES = ["automatic", "advisory", "explicit-only"];
export const ROUTING_MODE_VALUES = ["automatic", "advisory"];
export const DEFAULT_SKILL_INVOCATION = "automatic";
export const DEFAULT_WORKFLOW_INVOCATION = "advisory";
export const APPLICABILITY_CLAUSES = ["all", "any", "none"];

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "i",
  "in",
  "is",
  "it",
  "me",
  "of",
  "on",
  "please",
  "the",
  "this",
  "to",
  "use",
  "with",
]);

export function normalizeText(value) {
  return String(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function tokenize(value) {
  return [...new Set(normalizeText(value).split(/\s+/).filter((token) => token && !STOP_WORDS.has(token)))];
}

/** Stable comparison key for a phrase under token-boundary matching. */
export function phraseKey(phrase) {
  return [...tokenize(phrase)].sort().join(" ");
}

/**
 * Token-boundary phrase match: every meaningful token of the phrase must appear
 * as a whole token of the request. No regular expressions or expressions.
 */
export function phraseMatches(phrase, requestTokens) {
  const needed = tokenize(phrase);
  return needed.length > 0 && needed.every((token) => requestTokens.has(token));
}

export function assertPhrase(phrase, label) {
  if (typeof phrase !== "string") throw new Error(`${label} must be a string`);
  if (!normalizeText(phrase)) throw new Error(`${label} must be a non-empty phrase`);
  if (tokenize(phrase).length === 0) throw new Error(`${label} must contain at least one matchable token`);
}

export function assertApplicability(applicability, label) {
  if (applicability === undefined) return;
  if (!applicability || typeof applicability !== "object" || Array.isArray(applicability)) {
    throw new Error(`${label} must be an object with all, any, and none phrase lists`);
  }
  for (const key of Object.keys(applicability)) {
    if (!APPLICABILITY_CLAUSES.includes(key)) {
      throw new Error(`${label}.${key} is not supported; use all, any, or none`);
    }
  }
  const seen = new Map();
  for (const clause of APPLICABILITY_CLAUSES) {
    const phrases = applicability[clause];
    if (phrases === undefined) continue;
    if (!Array.isArray(phrases)) throw new Error(`${label}.${clause} must be an array of phrases`);
    const polarity = clause === "none" ? "negative" : "positive";
    for (const phrase of phrases) {
      assertPhrase(phrase, `${label}.${clause} phrase`);
      const key = phraseKey(phrase);
      const prior = seen.get(key);
      if (prior) {
        if (prior !== polarity) {
          throw new Error(`${label} lists ${JSON.stringify(phrase)} as both a positive and a negative phrase`);
        }
        throw new Error(`${label} repeats the normalized phrase ${JSON.stringify(phrase)}`);
      }
      seen.set(key, polarity);
    }
  }
}

export function negativePhraseMatch(applicability, requestTokens) {
  const phrases = applicability?.none;
  if (!phrases) return false;
  return phrases.some((phrase) => phraseMatches(phrase, requestTokens));
}

export function positivePhrasesMatch(applicability, requestTokens) {
  if (!applicability) return true;
  const all = applicability.all ?? [];
  const any = applicability.any ?? [];
  if (all.some((phrase) => !phraseMatches(phrase, requestTokens))) return false;
  if (any.length > 0 && !any.some((phrase) => phraseMatches(phrase, requestTokens))) return false;
  return true;
}

/** Full applicability match: no negative phrase matches and every positive clause holds. */
export function applicabilityMatches(applicability, requestTokens) {
  return !negativePhraseMatch(applicability, requestTokens) && positivePhrasesMatch(applicability, requestTokens);
}

/** Inferred matching of a workflow requires at least one positive clause. */
export function hasPositiveClause(applicability) {
  return Boolean(
    applicability && (((applicability.all ?? []).length > 0) || ((applicability.any ?? []).length > 0)),
  );
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function pickKeys(source, keys) {
  const result = {};
  for (const key of keys) {
    if (source?.[key] !== undefined) result[key] = source[key];
  }
  return result;
}

/**
 * Canonical routing policy derived from the authoring configuration. It is part
 * of the registry fingerprint so stale policy cannot be used silently.
 */
export function configPolicy(config) {
  const skills = {};
  for (const [id, settings] of Object.entries(config.skills ?? {})) {
    skills[id] = pickKeys(settings, [
      "enabled",
      "description",
      "source",
      "invocation",
      "applicability",
      "handoffTo",
    ]);
  }
  return {
    schemaVersion: config.schemaVersion ?? 1,
    // Source order decides precedence between duplicate skill IDs, so add,
    // remove, and reorder edits all make a stored policy stale for schema v2.
    sources: [...(config.sources ?? [])],
    include: [...(config.include ?? [])],
    exclude: [...(config.exclude ?? [])],
    aliases: { ...(config.aliases ?? {}) },
    skills,
    routing: pickKeys(config.routing, [
      "minimumScore",
      "minimumMargin",
      "maxCandidates",
      "allowSequences",
      "mode",
    ]),
    workflows: { ...(config.workflows ?? {}) },
  };
}

export function policyFingerprint(policy) {
  return createHash("sha256").update(canonical(policy ?? null)).digest("hex");
}

/** Effective skill policy with schema defaults applied. */
export function skillPolicy(config, id) {
  const settings = config.skills?.[id];
  return {
    description: settings?.description,
    invocation: settings?.invocation ?? DEFAULT_SKILL_INVOCATION,
    applicability: settings?.applicability ?? null,
    handoffTo: settings?.handoffTo ?? [],
  };
}

/**
 * How a workflow may run. Inferred matching only sequences a workflow when it
 * is automatic and every step skill is automatic; anything more restrictive
 * becomes advice. Explicit selection still never follows advisory step policy.
 *
 * `steps` must be the effective steps: steps whose `when` condition is false
 * are absent from the sequence, so they may not downgrade its run mode.
 */
export function workflowRunMode(workflow, config, { explicit, steps = workflow.steps }) {
  const invocation = workflow.invocation ?? DEFAULT_WORKFLOW_INVOCATION;
  const stepModes = steps.map((step) => skillPolicy(config, step.skill).invocation);
  if (explicit) {
    if (invocation === DEFAULT_WORKFLOW_INVOCATION) return "advise";
    if (stepModes.some((mode) => mode === "advisory")) return "advise";
    return "sequence";
  }
  if (invocation === "explicit-only") return "exclude";
  if (invocation === "automatic" && stepModes.every((mode) => mode === DEFAULT_SKILL_INVOCATION)) {
    return "sequence";
  }
  return "advise";
}

/**
 * Normalized alias key under the routing match contract. Aliases are compared
 * to requests, skill IDs, workflow IDs, and each other with this exact
 * normalization, so a shared key would make one of them unreachable.
 */
export function aliasKey(alias) {
  return normalizeText(alias);
}

/** Sorted keys so collision reports never depend on object insertion order. */
function sortedKeys(value) {
  return Object.keys(value ?? {}).sort();
}

export function workflowEntries(config) {
  return Object.entries(config.workflows ?? {})
    .map(([id, workflow]) => ({
      id,
      ...(workflow.description !== undefined ? { description: workflow.description } : {}),
      ...(workflow.invocation !== undefined ? { invocation: workflow.invocation } : {}),
      ...(workflow.applicability !== undefined ? { applicability: workflow.applicability } : {}),
      steps: workflow.steps,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function handoffCycles(config) {
  const graph = new Map();
  for (const [id, settings] of Object.entries(config.skills ?? {})) {
    if ((settings?.handoffTo ?? []).length) graph.set(id, [...settings.handoffTo]);
  }
  const color = new Map();
  const stack = [];
  const cycles = [];
  const seen = new Set();
  const visit = (node) => {
    const state = color.get(node) ?? 0;
    if (state === 1) {
      const start = stack.indexOf(node);
      const cycle = stack.slice(start);
      const key = [...cycle].sort().join("|");
      if (!seen.has(key)) {
        seen.add(key);
        cycles.push(cycle);
      }
      return;
    }
    if (state === 2) return;
    color.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) visit(next);
    stack.pop();
    color.set(node, 2);
  };
  for (const node of graph.keys()) visit(node);
  return cycles;
}

/**
 * Cross-reference validation between the configuration and the discovered
 * registry. Schema v1 keeps its historical behavior and is not re-validated.
 */
export function referenceDiagnostics(config, skills) {
  const diagnostics = [];
  if ((config.schemaVersion ?? 1) !== 2) return diagnostics;

  const skillIds = new Set(skills.map((skill) => skill.id));
  const skillById = new Map(skills.map((skill) => [skill.id, skill]));
  const workflowIds = new Set(Object.keys(config.workflows ?? {}));
  const isDisabled = (id) => skillById.get(id)?.enabled === false;

  // Normalized owners of the shared namespace: routing resolves an alias
  // before an exact ID, so a normalized collision makes one of them dead.
  const normalizedOwners = new Map();
  for (const skill of skills) normalizedOwners.set(aliasKey(skill.id), `skill ${skill.id}`);
  for (const workflowId of workflowIds) {
    const key = aliasKey(workflowId);
    if (!normalizedOwners.has(key)) normalizedOwners.set(key, `workflow ${workflowId}`);
  }

  for (const [alias, target] of Object.entries(config.aliases ?? {})) {
    if (!skillIds.has(target) && !workflowIds.has(target)) {
      diagnostics.push({
        level: "error",
        code: "alias-unknown-target",
        id: alias,
        message: `Alias ${JSON.stringify(alias)} references unknown skill or workflow ${JSON.stringify(target)}`,
      });
    } else if (isDisabled(target)) {
      diagnostics.push({
        level: "warning",
        code: "alias-disabled-target",
        id: alias,
        message: `Alias ${JSON.stringify(alias)} targets disabled skill ${JSON.stringify(target)}`,
      });
    }
  }

  const normalizedAliases = new Map();
  for (const alias of sortedKeys(config.aliases)) {
    const key = aliasKey(alias);
    const prior = normalizedAliases.get(key);
    if (prior !== undefined) {
      diagnostics.push({
        level: "error",
        code: "alias-collision",
        id: alias,
        message: `Alias ${JSON.stringify(alias)} collides with alias ${JSON.stringify(prior)} after normalization`,
      });
      continue;
    }
    normalizedAliases.set(key, alias);
    const owner = normalizedOwners.get(key);
    if (owner) {
      diagnostics.push({
        level: "error",
        code: "alias-collision",
        id: alias,
        message: `Alias ${JSON.stringify(alias)} collides with ${owner} after normalization`,
      });
    }
  }

  for (const workflowId of workflowIds) {
    const collision = skills.find((skill) => skill.id.toLowerCase() === workflowId.toLowerCase());
    if (collision) {
      diagnostics.push({
        level: "error",
        code: "skill-workflow-collision",
        id: workflowId,
        message: `Workflow ${workflowId} collides with skill ${collision.id} ignoring case`,
      });
    }
  }

  for (const [workflowId, workflow] of Object.entries(config.workflows ?? {})) {
    workflow.steps.forEach((step, index) => {
      if (!skillIds.has(step.skill)) {
        diagnostics.push({
          level: "error",
          code: "workflow-unknown-skill",
          id: workflowId,
          message: `Workflow ${workflowId} step ${index + 1} references unknown skill ${JSON.stringify(step.skill)}`,
        });
      } else if (isDisabled(step.skill)) {
        diagnostics.push({
          level: "error",
          code: "workflow-disabled-step",
          id: workflowId,
          message: `Workflow ${workflowId} step ${index + 1} uses disabled skill ${JSON.stringify(step.skill)}`,
        });
      }
    });
    for (let index = 1; index < workflow.steps.length; index += 1) {
      if (workflow.steps[index].skill === workflow.steps[index - 1].skill) {
        diagnostics.push({
          level: "warning",
          code: "duplicate-consecutive-step",
          id: workflowId,
          message: `Workflow ${workflowId} repeats skill ${workflow.steps[index].skill} in consecutive steps`,
        });
      }
    }
  }

  for (const [id, settings] of Object.entries(config.skills ?? {})) {
    for (const target of settings.handoffTo ?? []) {
      if (!skillIds.has(target)) {
        diagnostics.push({
          level: "error",
          code: "handoff-unknown-skill",
          id,
          message: `Skill ${id} hands off to unknown skill ${JSON.stringify(target)}`,
        });
      } else if (isDisabled(target)) {
        diagnostics.push({
          level: "warning",
          code: "handoff-disabled-target",
          id,
          message: `Skill ${id} hands off to disabled skill ${JSON.stringify(target)}`,
        });
      }
    }
  }

  for (const cycle of handoffCycles(config)) {
    diagnostics.push({
      level: "warning",
      code: "handoff-cycle",
      id: cycle[0],
      message: `Handoff cycle: ${cycle.join(" -> ")} -> ${cycle[0]}`,
    });
  }

  return diagnostics;
}
