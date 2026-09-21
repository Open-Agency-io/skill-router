import { access, lstat, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { normalizeConfig } from "./config.js";
import { discoverSources } from "./discovery.js";
import { stageManagedState } from "./managed-state.js";
import { parseFrontmatter, skillMetadata } from "./frontmatter.js";
import { planOpenCodeConfig } from "./opencode.js";
import { routeRequest } from "./routing.js";
import { parseJsonc } from "./jsonc.js";
import { applyManagedTransaction } from "./transaction.js";
import {
  buildWorkspaceRegistry,
  createContext,
  expandPath,
  readRegistry,
  sourcePaths,
} from "./workspace.js";

function blockingDiagnostics(registry, options = {}) {
  const blocking = new Set(["duplicate-id", "invalid-replacement", "source-not-directory"]);
  if (!options.allowMissingSources) blocking.add("source-not-found");
  return registry.diagnostics.filter((item) => item.level === "error" && blocking.has(item.code));
}

function serializeConfig(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function overlaps(left, right) {
  const relative = path.relative(left, right);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function verifyApplied(context, registry, skillsDirectory, manualOpenCode) {
  const installed = JSON.parse(await readFile(path.join(context.stateDirectory, "registry.json"), "utf8"));
  if (installed.fingerprint !== registry.fingerprint) throw new Error("registry verification failed");
  if (!manualOpenCode) {
    const openCode = parseJsonc(await readFile(context.openCodeConfig, "utf8"), context.openCodeConfig);
    if (!openCode.skills?.includes(skillsDirectory)) throw new Error("OpenCode source verification failed");
  }
  await access(path.join(skillsDirectory, "skill-router", "SKILL.md"));
}

async function applyBuild(context, config, options = {}) {
  const normalized = normalizeConfig(config);
  const currentContext = { ...context, config: normalized };
  const built = await buildWorkspaceRegistry(currentContext, normalized);
  for (const source of built.sources) {
    if (overlaps(source, context.stateDirectory) || overlaps(context.stateDirectory, source)) {
      throw new Error(`Skill source overlaps router-owned state: ${source}`);
    }
  }
  const blocking = blockingDiagnostics(built.registry, options);
  if (blocking.length) {
    throw new Error(blocking.map((item) => item.message).join("; "));
  }

  const skillsDirectory = path.join(context.stateDirectory, "opencode-skills");
  const openCode = await planOpenCodeConfig(context.openCodeConfig, skillsDirectory);
  const plan = {
    configFile: context.configFile,
    registryFile: path.join(context.stateDirectory, "registry.json"),
    openCodeConfig: context.openCodeConfig,
    skillsDirectory,
    skillCount: built.registry.skills.length,
    fingerprint: built.registry.fingerprint,
    diagnostics: built.registry.diagnostics,
    manualAction: openCode.instruction,
  };
  if (options.dryRun) return { ...plan, dryRun: true, registry: built.registry };

  const staged = await stageManagedState(context.stateDirectory, built.registry, { global: context.global });
  const files = [{ path: context.configFile, content: serializeConfig(normalized) }];
  if (openCode.content !== null) files.push({ path: context.openCodeConfig, content: openCode.content });
  await applyManagedTransaction({
    stateDirectory: context.stateDirectory,
    stagedDirectory: staged.stage,
    files,
    verify: () => verifyApplied(context, built.registry, skillsDirectory, openCode.manual),
  });
  return { ...plan, dryRun: false, registry: built.registry };
}

export async function initOperation(options = {}) {
  const context = await createContext(options);
  if (options.harness && !["opencode", "all"].includes(options.harness)) {
    throw new Error(`Unsupported harness: ${options.harness}`);
  }
  const result = await applyBuild(context, context.config, options);
  return { command: "init", scope: context.global ? "global" : "project", ...result };
}

function registryDiff(before, after) {
  const oldSkills = new Map((before?.skills ?? []).map((skill) => [skill.id, skill]));
  const newSkills = new Map(after.skills.map((skill) => [skill.id, skill]));
  return {
    added: [...newSkills.keys()].filter((id) => !oldSkills.has(id)),
    removed: [...oldSkills.keys()].filter((id) => !newSkills.has(id)),
    changed: [...newSkills.keys()].filter(
      (id) => oldSkills.has(id) && JSON.stringify(oldSkills.get(id)) !== JSON.stringify(newSkills.get(id)),
    ),
  };
}

export async function scanOperation(options = {}) {
  const context = await createContext(options);
  const before = await readRegistry(context);
  const result = await applyBuild(context, context.config, { ...options, allowMissingSources: true });
  return { command: "scan", diff: registryDiff(before, result.registry), ...result };
}

export async function routeOperation(request, options = {}) {
  const context = await createContext(options);
  const registry = await readRegistry(context);
  if (!registry) throw new Error("Skill Router is not initialized; run skill-router init first");
  return { command: "route", request, ...routeRequest(request, registry, context.config) };
}

export async function routeFileOperation(requestToken, options = {}) {
  if (!/^[a-f0-9]{32}$/.test(requestToken)) {
    throw new Error("--request-token must be exactly 32 lowercase hexadecimal characters");
  }
  const context = await createContext(options);
  const file = path.join(context.stateDirectory, "requests", `${requestToken}.txt`);
  let request;
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Managed route request must be a regular file");
    if (stat.size > 100_000) throw new Error("Managed route request exceeds 100000 bytes");
    request = await readFile(file, "utf8");
  } finally {
    await rm(file, { force: true });
  }
  return routeOperation(request, options);
}

async function pathExists(value) {
  try {
    return await lstat(value);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function persistedSource(target, stat) {
  if (stat.isFile()) return target;
  if (!stat.isDirectory()) throw new Error(`Unsupported skill source: ${target}`);
  const skillFile = path.join(target, "SKILL.md");
  return (await pathExists(skillFile))?.isFile() ? skillFile : target;
}

export async function addOperation(target, options = {}) {
  if (!target) throw new Error("add requires a skill ID or local path");
  const context = await createContext(options);
  const config = structuredClone(context.config);
  let requestedSource;

  if (options.source) {
    requestedSource = expandPath(options.source, context.root, context.home);
    if (!(await pathExists(requestedSource))) throw new Error(`Skill source does not exist: ${requestedSource}`);
    if (!config.sources.includes(requestedSource)) config.sources.push(requestedSource);
  }

  const initialSources = await sourcePaths({ ...context, config }, config);
  const initialDiscovery = await discoverSources(initialSources);
  const installedID = initialDiscovery.skills.some((skill) => skill.id === target);
  const possiblePath = expandPath(target, context.root, context.home);
  const targetStat = installedID ? null : await pathExists(possiblePath);
  if (targetStat) {
    requestedSource = await persistedSource(possiblePath, targetStat);
    if (!config.sources.includes(requestedSource)) config.sources.push(requestedSource);
  }

  const sources = await sourcePaths({ ...context, config }, config);
  const discovery = await discoverSources(sources);
  let selected;
  if (targetStat) {
    const exactSource = path.resolve(requestedSource);
    selected = discovery.skills.filter(
      (skill) => skill.source === exactSource || skill.path === exactSource || skill.path.startsWith(`${exactSource}${path.sep}`),
    );
  } else {
    selected = discovery.skills.filter((skill) => skill.id === target);
    if (requestedSource) {
      const fromRequested = selected.filter(
        (skill) => skill.source === requestedSource || skill.path.startsWith(`${requestedSource}${path.sep}`),
      );
      if (fromRequested.length) selected = fromRequested;
    }
  }
  if (selected.length === 0) throw new Error(`No skill found for: ${target}`);
  if (selected.length > 1 && targetStat && !options.yes && !options.dryRun) {
    throw new Error(`Source contains ${selected.length} skills; rerun with --yes to add all`);
  }
  if (selected.length > 1 && !targetStat && !options.replace) {
    const highest = Math.max(...selected.map((skill) => skill.sourceIndex));
    selected = selected.filter((skill) => skill.sourceIndex === highest);
    if (selected.length > 1) throw new Error(`Skill ID ${target} is ambiguous; use --source and --replace`);
  }
  if (selected.length > 1 && !targetStat && options.replace) {
    throw new Error(`Skill ID ${target} has multiple definitions; add the exact skill file or directory with --replace`);
  }
  if ((options.aliases?.length || options.description) && selected.length !== 1) {
    throw new Error("--alias and --description require exactly one added skill");
  }

  for (const skill of selected) {
    const prior = Object.hasOwn(config.skills, skill.id) ? config.skills[skill.id] : {};
    const settings = { ...prior, enabled: !options.noEnable };
    if (options.description) settings.description = options.description;
    if (options.replace) settings.source = skill.path;
    Object.defineProperty(config.skills, skill.id, {
      value: settings,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  for (const alias of options.aliases ?? []) {
    Object.defineProperty(config.aliases, alias, {
      value: selected[0].id,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  const result = await applyBuild(context, config, options);
  return { command: "add", added: selected.map((skill) => skill.id), ...result };
}

export async function checkOperation(options = {}) {
  const context = await createContext(options);
  const diagnostics = [];
  const installed = await readRegistry(context);
  if (!installed) diagnostics.push({ level: "error", code: "registry-missing", message: "Registry is missing" });

  let current;
  try {
    current = await buildWorkspaceRegistry(context, context.config);
    diagnostics.push(...current.registry.diagnostics);
    if (installed && installed.fingerprint !== current.registry.fingerprint) {
      diagnostics.push({ level: "error", code: "registry-stale", message: "Registry fingerprint is stale" });
    }
  } catch (error) {
    diagnostics.push({ level: "error", code: "discovery-failed", message: error.message });
  }

  const skillsDirectory = path.join(context.stateDirectory, "opencode-skills");
  try {
    const openCode = parseJsonc(await readFile(context.openCodeConfig, "utf8"), context.openCodeConfig);
    if (!openCode.skills?.includes(skillsDirectory)) {
      diagnostics.push({ level: "error", code: "opencode-source-missing", message: "OpenCode source is not configured" });
    }
  } catch (error) {
    diagnostics.push({ level: "error", code: "opencode-config-invalid", message: error.message });
  }
  try {
    await access(path.join(skillsDirectory, "skill-router", "SKILL.md"));
  } catch {
    diagnostics.push({ level: "error", code: "router-skill-missing", message: "Generated router skill is missing" });
  }

  for (const skill of installed?.skills?.filter((entry) => entry.enabled !== false) ?? []) {
    const managedFile = path.basename(skill.source) === "SKILL.md"
      ? path.join(skillsDirectory, skill.id, "SKILL.md")
      : path.join(skillsDirectory, `${skill.id}.md`);
    try {
      const stat = await lstat(managedFile);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("not a regular file");
      const metadata = skillMetadata(parseFrontmatter(await readFile(managedFile, "utf8")).attributes);
      if (metadata.opencodeAutoinvoke !== false) throw new Error("autoinvoke is not disabled");
    } catch (error) {
      diagnostics.push({
        level: "error",
        code: "managed-skill-invalid",
        skillId: skill.id,
        message: `Managed skill ${skill.id} is not explicitly loadable: ${error.message}`,
      });
    }
  }

  return {
    command: "check",
    healthy: !diagnostics.some((item) => item.level === "error"),
    diagnostics,
    fingerprint: installed?.fingerprint,
  };
}

export const operationInternals = { applyBuild, registryDiff };
