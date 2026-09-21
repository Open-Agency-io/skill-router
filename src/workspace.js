import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { loadConfig } from "./config.js";
import { discoverSources } from "./discovery.js";
import { buildRegistry } from "./registry.js";
import { parseJsonc } from "./jsonc.js";

function homeDirectory() {
  return path.resolve(process.env.SKILL_ROUTER_HOME || homedir());
}

export function expandPath(value, base, home = homeDirectory()) {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return path.resolve(base, value);
}

async function existing(paths) {
  const result = [];
  for (const candidate of paths) {
    try {
      await access(candidate);
      result.push(candidate);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return result;
}

async function preferredJsonConfig(jsonFile) {
  try {
    await access(jsonFile);
    return jsonFile;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const jsoncFile = `${jsonFile}c`;
  try {
    await access(jsoncFile);
    return jsoncFile;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return jsonFile;
  }
}

async function projectDirectories(directory) {
  let cursor = directory;
  let projectRoot = directory;
  while (true) {
    try {
      await access(path.join(cursor, ".git"));
      projectRoot = cursor;
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const directories = [];
  cursor = directory;
  while (true) {
    directories.unshift(cursor);
    if (cursor === projectRoot) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return directories;
}

export async function createContext(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const home = homeDirectory();
  const global = options.global === true;
  const ancestors = global ? [] : await projectDirectories(root);
  const configFile = options.config
    ? expandPath(options.config, root, home)
    : global
      ? path.join(home, ".config", "skill-router", "config.json")
      : path.join(root, ".skill-router.json");
  const { config } = await loadConfig(root, configFile);
  const stateDirectory = global
    ? path.join(home, ".local", "share", "skill-router")
    : expandPath(config.stateDirectory, root, home);
  const openCodeConfig = await preferredJsonConfig(global
    ? path.join(home, ".config", "opencode", "opencode.json")
    : path.join(root, ".opencode", "opencode.json"));

  return { root, home, global, ancestors, configFile, stateDirectory, openCodeConfig, config };
}

export async function sourcePaths(context, config = context.config) {
  const globalClaude = path.join(context.home, ".claude", "skills");
  const globalAgents = path.join(context.home, ".agents", "skills");
  const globalOpenCode = path.join(context.home, ".config", "opencode", "skills");
  const ancestors = context.ancestors ?? [context.root];
  const defaults = await existing(
    context.global
      ? [globalClaude, globalAgents, globalOpenCode]
      : [
          globalClaude,
          ...ancestors.map((directory) => path.join(directory, ".claude", "skills")),
          globalAgents,
          ...ancestors.map((directory) => path.join(directory, ".agents", "skills")),
          globalOpenCode,
          ...ancestors.map((directory) => path.join(directory, ".opencode", "skills")),
        ],
  );
  const configFiles = context.global
    ? [context.openCodeConfig]
    : [
        path.join(context.home, ".config", "opencode", "opencode.json"),
        path.join(context.home, ".config", "opencode", "opencode.jsonc"),
        ...ancestors.flatMap((directory) => [
          path.join(directory, "opencode.json"),
          path.join(directory, "opencode.jsonc"),
          path.join(directory, ".opencode", "opencode.json"),
          path.join(directory, ".opencode", "opencode.jsonc"),
        ]),
        context.openCodeConfig,
      ];
  const configured = [];
  for (const file of [...new Set(configFiles)]) {
    try {
      const document = parseJsonc(await readFile(file, "utf8"), file);
      for (const source of document.skills ?? []) {
        if (typeof source !== "string" || /^https?:\/\//.test(source)) continue;
        const resolved = expandPath(source, context.root, context.home);
        if (resolved !== path.join(context.stateDirectory, "opencode-skills")) configured.push(resolved);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const explicit = config.sources.map((source) => expandPath(source, context.root, context.home));
  const combined = [...defaults, ...configured, ...explicit];
  return combined.filter((source, index) => combined.lastIndexOf(source) === index);
}

export async function buildWorkspaceRegistry(context, config = context.config) {
  const sources = await sourcePaths(context, config);
  const discovery = await discoverSources(sources);
  const replace = Object.create(null);
  const enabled = Object.create(null);
  for (const [id, settings] of Object.entries(config.skills)) {
    if (settings.source) replace[id] = expandPath(settings.source, context.root, context.home);
    if (settings.enabled !== undefined) enabled[id] = settings.enabled;
  }
  const registry = buildRegistry(discovery, { replace, enabled });
  registry.skills = registry.skills.map((skill) =>
    config.skills[skill.id]?.description
      ? { ...skill, description: config.skills[skill.id].description }
      : skill,
  );
  return { sources, discovery, registry };
}

export async function readRegistry(context) {
  const file = path.join(context.stateDirectory, "registry.json");
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error(`Invalid registry JSON at ${file}`);
    throw error;
  }
}
