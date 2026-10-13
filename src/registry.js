import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { classifyId } from "./identifiers.js";
import { canonical, policyFingerprint } from "./policy.js";

function sortedFingerprintEntries(entries) {
  return entries
    .map((entry) => ({ ...entry }))
    .sort(
      (a, b) =>
        (a.sourceIndex ?? 0) - (b.sourceIndex ?? 0) ||
        (a.path ?? a.source ?? "").localeCompare(b.path ?? b.source ?? "") ||
        (a.kind ?? "").localeCompare(b.kind ?? ""),
    );
}

/**
 * Pure, side-effect-free inspection of every public identifier an installed
 * registry carries: `skills[].id`, `skills[].handoffTo[]`, `workflows[].id`,
 * and `workflows[].steps[].skill`. Nothing is joined to a path, resolved,
 * read, or mutated, so a poisoned `../...`, absolute-looking, separator,
 * control-character, or 100k identifier is classified — never consumed.
 *
 * The result is bounded and nonsecret: counts, distinct reason codes from the
 * shared identifier contract, and a capped sample of fixed *field kinds*
 * ("skills[].id", ...) that had at least one invalid slot. It never embeds an
 * identifier, a path, or any other untrusted value. Malformed array/object
 * shapes are recorded conservatively as `type` problems in the same vocabulary
 * so downstream consumers can refuse instead of crashing; this is not a full
 * registry schema validation.
 */
const MAX_FIELD_SAMPLES = 4;

export const REGISTRY_ID_FIELDS = Object.freeze([
  "skills[].handoffTo[]",
  "skills[].id",
  "workflows[].id",
  "workflows[].steps[].skill",
]);

export function inspectRegistryIdentifiers(registry) {
  const reasons = new Set();
  const fields = new Set();
  let checked = 0;
  let invalid = 0;

  const problem = (field, reason) => {
    checked += 1;
    invalid += 1;
    fields.add(field);
    reasons.add(reason);
  };
  const slot = (field, value) => {
    const reason = classifyId(value);
    if (reason === null) {
      checked += 1;
      return;
    }
    problem(field, reason);
  };
  const isEntry = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

  const skills = registry?.skills;
  if (skills !== undefined && skills !== null) {
    if (!Array.isArray(skills)) {
      problem("skills[].id", "type");
    } else {
      for (const skill of skills) {
        if (!isEntry(skill)) {
          problem("skills[].id", "type");
          continue;
        }
        slot("skills[].id", skill.id);
        if (skill.handoffTo !== undefined && skill.handoffTo !== null) {
          if (!Array.isArray(skill.handoffTo)) {
            problem("skills[].handoffTo[]", "type");
          } else {
            for (const target of skill.handoffTo) slot("skills[].handoffTo[]", target);
          }
        }
      }
    }
  }

  const workflows = registry?.workflows;
  if (workflows !== undefined && workflows !== null) {
    if (!Array.isArray(workflows)) {
      problem("workflows[].id", "type");
    } else {
      for (const workflow of workflows) {
        if (!isEntry(workflow)) {
          problem("workflows[].id", "type");
          continue;
        }
        slot("workflows[].id", workflow.id);
        const steps = workflow.steps;
        if (steps !== undefined && steps !== null) {
          if (!Array.isArray(steps)) {
            problem("workflows[].steps[].skill", "type");
          } else {
            for (const step of steps) {
              if (!isEntry(step)) {
                problem("workflows[].steps[].skill", "type");
                continue;
              }
              slot("workflows[].steps[].skill", step.skill);
            }
          }
        }
      }
    }
  }

  return {
    valid: invalid === 0,
    checked,
    invalid,
    reasons: [...reasons].sort(),
    fields: [...fields].sort().slice(0, MAX_FIELD_SAMPLES),
  };
}

/**
 * Refuse an installed registry whose public identifiers are not portable.
 * The error is fixed and bounded: it names no identifier, path, count of
 * offenders, or reason, because every one of those can carry untrusted bytes.
 */
export function assertRegistryIdentifiers(registry) {
  const inspection = inspectRegistryIdentifiers(registry);
  if (!inspection.valid) {
    throw new Error("Registry contains invalid skill or workflow IDs; run skill-router scan to rebuild it");
  }
  return inspection;
}

export function sourceFingerprint(entries) {
  return createHash("sha256").update(canonical(sortedFingerprintEntries(entries))).digest("hex");
}

/**
 * Registry freshness covers discovered source material and the derived routing
 * policy (aliases, skill overrides, workflows, routing thresholds and mode).
 */
export function registryFingerprint(entries, policy) {
  const material = { policy: policy ?? null, sources: sortedFingerprintEntries(entries) };
  return createHash("sha256").update(canonical(material)).digest("hex");
}

export function buildRegistry(discovery, options = {}) {
  const diagnostics = [...(discovery.diagnostics ?? [])];
  const replacements = options.replace ?? Object.create(null);
  const enabled = options.enabled ?? Object.create(null);
  const policy = options.policy ?? null;
  const groups = new Map();
  for (const skill of discovery.skills) {
    const group = groups.get(skill.id) ?? [];
    group.push(skill);
    groups.set(skill.id, group);
  }

  const effective = [];
  for (const [id, candidates] of groups) {
    candidates.sort((a, b) => a.sourceIndex - b.sourceIndex || a.path.localeCompare(b.path));
    const topIndex = candidates.at(-1).sourceIndex;
    const winners = candidates.filter((candidate) => candidate.sourceIndex === topIndex);
    const hasReplacement = Object.hasOwn(replacements, id);
    if (winners.length > 1 && !hasReplacement) {
      diagnostics.push({
        level: "error",
        code: "duplicate-id",
        id,
        message: `Skill ${id} is defined more than once at the same precedence`,
        paths: winners.map((candidate) => candidate.path),
      });
      continue;
    }

    const winner = hasReplacement
      ? candidates.find((candidate) => candidate.path === replacements[id])
      : winners.at(-1);
    if (!winner) {
      diagnostics.push({
        level: "error",
        code: "invalid-replacement",
        id,
        message: `Replacement path for ${id} was not discovered`,
      });
      continue;
    }
    if (candidates.length > 1) {
      diagnostics.push({
        level: "warning",
        code: "overridden-id",
        id,
        message: `Skill ${id} uses the highest-precedence source`,
        selected: winner.path,
        overridden: candidates.filter((candidate) => candidate !== winner).map((candidate) => candidate.path),
      });
    }

    effective.push({
      id: winner.id,
      name: winner.name,
      description: winner.description,
      ...(winner.compatibility ? { compatibility: winner.compatibility } : {}),
      source: winner.path,
      enabled: Object.hasOwn(enabled, id) ? enabled[id] : true,
    });
  }

  effective.sort((a, b) => a.id.localeCompare(b.id));
  const workflows = options.workflows ?? [];
  const entries = discovery.fingerprintEntries ?? discovery.skills;
  return {
    schemaVersion: 1,
    // Without a policy there is nothing to combine, and a pre-policy registry
    // on disk must keep verifying: fall back to the historical source-only
    // fingerprint instead of a registry fingerprint over `policy: null`.
    fingerprint: policy ? registryFingerprint(entries, policy) : sourceFingerprint(entries),
    ...(policy ? { policyHash: policyFingerprint(policy) } : {}),
    skills: effective,
    ...(workflows.length ? { workflows } : {}),
    diagnostics,
  };
}

export async function writeJsonAtomic(file, value) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
