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

function normalize(value) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(value) {
  return [...new Set(normalize(value).split(/\s+/).filter((token) => token && !STOP_WORDS.has(token)))];
}

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

function candidatesFor(request, registry, config) {
  return registry.skills
    .filter((skill) => skill.enabled !== false && included(skill.id, config))
    .map((skill) => {
      const override = config.skills[skill.id];
      const effective = {
        ...skill,
        ...(override?.description ? { description: override.description } : {}),
      };
      if (override?.enabled === false) return null;
      return { id: skill.id, score: scoreSkill(request, effective) };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function routeRequest(request, registry, config) {
  if (typeof request !== "string" || !request.trim()) {
    throw new Error("route request must be a non-empty string");
  }

  const normalizedRequest = normalize(request);
  for (const [alias, id] of Object.entries(config.aliases)) {
    if (normalize(alias) === normalizedRequest) {
      const skill = registry.skills.find((candidate) => candidate.id === id && candidate.enabled !== false);
      if (skill && included(id, config) && config.skills[id]?.enabled !== false) {
        return { outcome: "select", skillId: id, confidence: 1, reason: "alias" };
      }
    }
  }

  const exact = registry.skills.find(
    (skill) =>
      skill.id === request.trim() &&
      skill.enabled !== false &&
      included(skill.id, config) &&
      config.skills[skill.id]?.enabled !== false,
  );
  if (exact) return { outcome: "select", skillId: exact.id, confidence: 1, reason: "exact-id" };

  const scored = candidatesFor(request, registry, config);
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

  return {
    outcome: "select",
    skillId: top.id,
    confidence: top.score,
    candidates,
    reason: "deterministic-score",
  };
}

export const routingInternals = { normalize, tokens, globMatches, scoreSkill };
