import { readFile } from "node:fs/promises";
import path from "node:path";

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

function cloneDefaults() {
  return {
    ...DEFAULT_CONFIG,
    sources: [...DEFAULT_CONFIG.sources],
    include: [...DEFAULT_CONFIG.include],
    exclude: [...DEFAULT_CONFIG.exclude],
    aliases: {},
    skills: {},
    routing: { ...DEFAULT_CONFIG.routing },
  };
}

export function normalizeConfig(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("configuration must be a JSON object");
  }

  const config = {
    ...cloneDefaults(),
    ...value,
    routing: { ...DEFAULT_CONFIG.routing, ...(value.routing ?? {}) },
    aliases: { ...(value.aliases ?? {}) },
    skills: { ...(value.skills ?? {}) },
  };

  validateConfig(config);
  return config;
}

export function validateConfig(config) {
  if (config.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
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
  if (Object.entries(config.aliases).some(([key, value]) => !key || typeof value !== "string")) {
    throw new Error("aliases must map non-empty phrases to skill IDs");
  }
  if (typeof config.stateDirectory !== "string" || !config.stateDirectory.trim()) {
    throw new Error("stateDirectory must be a non-empty string");
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
}

export async function loadConfig(root, explicitPath) {
  const file = path.resolve(root, explicitPath ?? CONFIG_FILE);
  try {
    return { file, config: normalizeConfig(JSON.parse(await readFile(file, "utf8"))) };
  } catch (error) {
    if (error.code === "ENOENT") return { file, config: normalizeConfig() };
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${file}: ${error.message}`);
    throw error;
  }
}
