import path from "node:path";
import { assertValidId } from "./identifiers.js";
import { jsonSyntaxError, readJsonText } from "./json-errors.js";
import {
  aliasKey,
  assertApplicability,
  assertPhrase,
  INVOCATION_VALUES,
  ROUTING_MODE_VALUES,
} from "./policy.js";

export const CONFIG_FILE = ".skill-router.json";

export const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: 1,
  sources: [],
  include: ["*"],
  exclude: [],
  aliases: {},
  skills: {},
  routing: Object.freeze({
    minimumScore: 0.55,
    minimumMargin: 0.15,
    maxCandidates: 5,
    allowSequences: false,
  }),
  stateDirectory: ".skill-router",
});

const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "sources",
  "include",
  "exclude",
  "aliases",
  "skills",
  "workflows",
  "routing",
  "stateDirectory",
]);
const ROUTING_KEYS = new Set([
  "minimumScore",
  "minimumMargin",
  "maxCandidates",
  "allowSequences",
  "mode",
]);
const SKILL_KEYS = new Set(["enabled", "source", "description", "invocation", "applicability", "handoffTo"]);
const WORKFLOW_KEYS = new Set(["description", "invocation", "applicability", "steps"]);
const STEP_KEYS = new Set(["skill", "when"]);

const MAX_ECHO_LENGTH = 64;

/**
 * Bounded, control-safe rendering of an untrusted string for error text.
 * Small values render exactly like JSON.stringify, so existing messages are
 * unchanged; anything longer is truncated before escaping so a hostile key
 * can never inject unbounded text or raw control characters.
 */
function quoteBounded(value) {
  const text = String(value);
  const quoted = JSON.stringify(text);
  if (quoted.length <= MAX_ECHO_LENGTH) return quoted;
  const head = JSON.stringify([...text].slice(0, MAX_ECHO_LENGTH).join(""));
  return `${head.slice(0, -1)}…"`;
}

function safeMap(value = {}) {
  const result = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(result, key, { value: item, enumerable: true, writable: true, configurable: true });
  }
  return result;
}

function routingDefaults(version) {
  return version >= 2 ? { ...DEFAULT_CONFIG.routing, mode: "automatic" } : { ...DEFAULT_CONFIG.routing };
}

function cloneDefaults(version = 1) {
  return {
    ...DEFAULT_CONFIG,
    sources: [...DEFAULT_CONFIG.sources],
    include: [...DEFAULT_CONFIG.include],
    exclude: [...DEFAULT_CONFIG.exclude],
    aliases: safeMap(),
    skills: safeMap(),
    routing: routingDefaults(version),
    ...(version >= 2 ? { workflows: safeMap() } : {}),
  };
}

export function normalizeConfig(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("configuration must be a JSON object");
  }
  if (
    value.workflows !== undefined &&
    (!value.workflows || typeof value.workflows !== "object" || Array.isArray(value.workflows))
  ) {
    throw new Error("workflows must be an object");
  }

  const version = value.schemaVersion === undefined ? 1 : value.schemaVersion;
  const config = {
    ...cloneDefaults(version),
    ...value,
    schemaVersion: version,
    routing: { ...routingDefaults(version), ...(value.routing ?? {}) },
    aliases: safeMap(value.aliases),
    skills: safeMap(value.skills),
    ...(version >= 2 ? { workflows: safeMap(value.workflows) } : {}),
  };

  validateConfig(config);
  return config;
}

function validateSteps(workflowId, workflow, workflowIds) {
  if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) {
    throw new Error(`workflows.${workflowId}.steps must be a non-empty array`);
  }
  let unconditional = 0;
  workflow.steps.forEach((step, index) => {
    const label = `workflows.${workflowId}.steps[${index}]`;
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      throw new Error(`${label} must be an object with a skill`);
    }
    for (const key of Object.keys(step)) {
      if (!STEP_KEYS.has(key)) throw new Error(`Unknown ${label} key: ${quoteBounded(key)}`);
    }
    if (typeof step.skill !== "string" || !step.skill.trim()) {
      throw new Error(`${label}.skill must be a non-empty skill ID`);
    }
    // Step skills are public skill/workflow references, so the shared
    // grammar and reservation apply before any comparison or echo.
    assertValidId(step.skill, `${label}.skill`);
    if (workflowIds.some((candidate) => candidate.toLowerCase() === step.skill.toLowerCase())) {
      throw new Error(`${label} references workflow ${JSON.stringify(step.skill)}; nested workflows are not supported`);
    }
    if (step.when !== undefined) assertPhrase(step.when, `${label}.when`);
    else unconditional += 1;
  });
  if (unconditional === 0) {
    throw new Error(`workflows.${workflowId} must include at least one step without a when condition`);
  }
}

function validateV2(config) {
  for (const key of Object.keys(config)) {
    if (!TOP_LEVEL_KEYS.has(key)) throw new Error(`Unknown configuration key: ${quoteBounded(key)}`);
  }
  for (const key of Object.keys(config.routing)) {
    if (!ROUTING_KEYS.has(key)) throw new Error(`Unknown routing key: ${quoteBounded(key)}`);
  }
  if (!ROUTING_MODE_VALUES.includes(config.routing.mode)) {
    throw new Error(`routing.mode must be one of ${ROUTING_MODE_VALUES.join(", ")}`);
  }

  // Declared IDs are trusted label material only after this gate, so no
  // untrusted ID is ever interpolated into an error message before it has
  // passed the shared grammar and reservation checks.
  for (const id of Object.keys(config.skills)) {
    assertValidId(id, "skills key");
  }
  for (const id of Object.keys(config.workflows ?? {})) {
    assertValidId(id, "workflows key");
  }

  for (const [id, settings] of Object.entries(config.skills)) {
    for (const key of Object.keys(settings)) {
      if (!SKILL_KEYS.has(key)) throw new Error(`Unknown skills.${id} key: ${quoteBounded(key)}`);
    }
    if (settings.source !== undefined) {
      if (typeof settings.source !== "string" || !settings.source.trim()) {
        throw new Error(`skills.${id}.source must be a non-empty local path`);
      }
      if (/^https?:\/\//i.test(settings.source)) {
        throw new Error(`skills.${id}.source must be a local path; remote sources are not supported`);
      }
    }
    if (settings.invocation !== undefined && !INVOCATION_VALUES.includes(settings.invocation)) {
      throw new Error(`skills.${id}.invocation must be one of ${INVOCATION_VALUES.join(", ")}`);
    }
    assertApplicability(settings.applicability, `skills.${id}.applicability`);
    if (settings.handoffTo !== undefined) {
      if (!Array.isArray(settings.handoffTo)) {
        throw new Error(`skills.${id}.handoffTo must be an array of skill IDs`);
      }
      settings.handoffTo.forEach((target, index) => {
        if (typeof target !== "string" || !target.trim()) {
          throw new Error(`skills.${id}.handoffTo[${index}] must be a non-empty skill ID`);
        }
        // Handoff targets are public skill references under the shared contract.
        assertValidId(target, `skills.${id}.handoffTo[${index}]`);
        if (settings.handoffTo.indexOf(target) !== index) {
          throw new Error(`skills.${id}.handoffTo lists ${JSON.stringify(target)} more than once`);
        }
      });
    }
  }

  // Declared skill and workflow IDs are portable lowercase, so a declared clash
  // is an exact clash. Discovered skill IDs may still differ only by case, so
  // the shared case-insensitive namespace with the registry is enforced by
  // referenceDiagnostics() in policy.js.
  const namespace = new Map();
  const normalizedIds = new Map();
  for (const id of Object.keys(config.skills)) {
    namespace.set(id.toLowerCase(), `skill ${id}`);
    normalizedIds.set(aliasKey(id), `skill ${id}`);
  }
  if (config.workflows !== undefined) {
    for (const id of Object.keys(config.workflows)) {
      const owner = namespace.get(id.toLowerCase());
      if (owner) throw new Error(`Skill and workflow IDs share one namespace and must be unique: ${owner} and workflow ${id}`);
      namespace.set(id.toLowerCase(), `workflow ${id}`);
      normalizedIds.set(aliasKey(id), `workflow ${id}`);
    }
  }

  // Schema v2 rejects aliases that normalize onto a skill ID, a workflow ID,
  // or another alias: routing matches aliases first, so such an alias silently
  // hides its neighbor. Keys are checked in sorted order so the rejection does
  // not depend on insertion order. Schema v1 keeps its alias-first semantics.
  const normalizedAliases = new Map();
  for (const alias of Object.keys(config.aliases).sort()) {
    const key = aliasKey(alias);
    // Routing compares the normalized alias against normalized requests, so an
    // empty key can never match anything and would silently shadow its target.
    if (!key) {
      throw new Error(`Alias ${quoteBounded(alias)} normalizes to an empty phrase and can never match a request`);
    }
    const prior = normalizedAliases.get(key);
    if (prior !== undefined) {
      throw new Error(
        `Alias ${quoteBounded(alias)} collides with alias ${quoteBounded(prior)} after normalization`,
      );
    }
    normalizedAliases.set(key, alias);
    const owner = normalizedIds.get(key);
    if (owner) throw new Error(`Alias ${quoteBounded(alias)} collides with ${owner} after normalization`);
  }

  if (config.workflows === undefined) return;

  for (const [id, workflow] of Object.entries(config.workflows)) {
    if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
      throw new Error(`workflows.${id} must be an object`);
    }
    for (const key of Object.keys(workflow)) {
      if (!WORKFLOW_KEYS.has(key)) throw new Error(`Unknown workflows.${id} key: ${quoteBounded(key)}`);
    }
    if (workflow.description !== undefined && typeof workflow.description !== "string") {
      throw new Error(`workflows.${id}.description must be a string`);
    }
    if (workflow.invocation !== undefined && !INVOCATION_VALUES.includes(workflow.invocation)) {
      throw new Error(`workflows.${id}.invocation must be one of ${INVOCATION_VALUES.join(", ")}`);
    }
    assertApplicability(workflow.applicability, `workflows.${id}.applicability`);
    validateSteps(id, workflow, Object.keys(config.workflows));
  }

  if (Object.keys(config.workflows).length > 0 && config.routing.allowSequences !== true) {
    throw new Error("routing.allowSequences must be true when workflows are configured");
  }
}

export function validateConfig(config) {
  if (config.schemaVersion !== 1 && config.schemaVersion !== 2) {
    throw new Error("schemaVersion must be 1 or 2");
  }
  for (const key of ["sources", "include", "exclude"]) {
    if (!Array.isArray(config[key]) || config[key].some((item) => typeof item !== "string")) {
      throw new Error(`${key} must be an array of strings`);
    }
  }
  for (const key of ["aliases", "skills"]) {
    if (!config[key] || typeof config[key] !== "object" || Array.isArray(config[key])) {
      throw new Error(`${key} must be an object`);
    }
  }
  for (const [key, value] of Object.entries(config.aliases)) {
    if (!key || typeof value !== "string") {
      throw new Error("aliases must map non-empty phrases to skill IDs");
    }
  }
  for (const [id, settings] of Object.entries(config.skills)) {
    // Validate the ID before any error can interpolate it as label material.
    assertValidId(id, "skills key");
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new Error("skills must map skill IDs to settings objects");
    }
    if (settings.enabled !== undefined && typeof settings.enabled !== "boolean") {
      throw new Error(`skills.${id}.enabled must be a boolean`);
    }
    for (const key of ["description", "source"]) {
      if (settings[key] !== undefined && typeof settings[key] !== "string") {
        throw new Error(`skills.${id}.${key} must be a string`);
      }
    }
  }
  // Alias values are public skill/workflow references in both schema
  // versions; alias keys stay free-form request phrases.
  for (const value of Object.values(config.aliases)) {
    assertValidId(value, "alias target");
  }
  if (config.stateDirectory !== ".skill-router") {
    throw new Error('stateDirectory must be the router-owned path ".skill-router"');
  }

  const { minimumScore, minimumMargin, maxCandidates, allowSequences } = config.routing;
  for (const [key, value] of Object.entries({ minimumScore, minimumMargin })) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`routing.${key} must be between 0 and 1`);
    }
  }
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 20) {
    throw new Error("routing.maxCandidates must be an integer between 1 and 20");
  }
  if (typeof allowSequences !== "boolean") {
    throw new Error("routing.allowSequences must be a boolean");
  }

  if (config.schemaVersion === 1) {
    if (config.workflows !== undefined) throw new Error("workflows require schemaVersion 2");
    if (config.routing.mode !== undefined) throw new Error("routing.mode requires schemaVersion 2");
    for (const [id, settings] of Object.entries(config.skills)) {
      for (const key of ["invocation", "applicability", "handoffTo"]) {
        if (settings[key] !== undefined) throw new Error(`skills.${id}.${key} requires schemaVersion 2`);
      }
    }
    return;
  }

  validateV2(config);
}

export async function loadConfig(root, explicitPath) {
  const file = path.resolve(root, explicitPath ?? CONFIG_FILE);
  let text;
  try {
    text = await readJsonText(file);
  } catch (error) {
    if (error?.code === "ENOENT") return { file, config: normalizeConfig() };
    throw error;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    // Bounded error: file context plus a safely derived line/column, never the
    // parser's own snippet-bearing text.
    throw jsonSyntaxError(text, error, { file });
  }
  return { file, config: normalizeConfig(value) };
}
