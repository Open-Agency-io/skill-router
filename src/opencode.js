import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { CONFIG_FILE } from "./config.js";
import { mapJsonReadError } from "./json-errors.js";
import { parseJsonc } from "./jsonc.js";

export const OPENCODE_PROBE_TIMEOUT_MS = 10_000;
const OPENCODE_PROBE_MAX_BUFFER = 64 * 1024;
const PROBE_KILL_GRACE_MS = 250;

export function skillShapeFromOpenCodeVersion(version) {
  const match = String(version).trim().match(/^(?:opencode\s+)?v?(\d+)\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/i);
  if (!match) return null;
  return Number.parseInt(match[1], 10) >= 2 ? "array" : "paths";
}

function probeFailureReason(error) {
  if (error?.code === "ENOENT") return "not-found";
  if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "noisy-output";
  if (error?.killed === true || error?.code === "ETIMEDOUT") return "timeout";
  if (typeof error?.code === "number" || typeof error?.signal === "string") return "nonzero-exit";
  return "failed";
}

/**
 * Best-effort, bounded termination of a probe child at the outer deadline:
 * SIGTERM first, then exactly one SIGKILL after a short grace if the child is
 * still running. The escalation timer is unref'd so it can never keep the
 * process alive, an already-exited child is never signalled again, and a
 * handle without `kill` (an injected test seam) is simply left alone. The
 * probe never awaits this cleanup: it only prevents a leaked process.
 */
function terminateProbeChild(child) {
  if (!child || typeof child.kill !== "function") return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const escalation = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }, PROBE_KILL_GRACE_MS);
  escalation.unref?.();
}

/** execFile-compatible seam; the returned child handle is retained by the probe. */
function defaultProbe(executable, args, options, callback) {
  return execFile(executable, args, options, callback);
}

/**
 * Bounded, asynchronous capability probe. The official CLI prints exactly one
 * clean version; anything else — a missing binary, a timeout, a nonzero exit,
 * a truncated or noisy stream, or an unrecognized line — is a *structured
 * unknown*, never a guessed shape. Only stdout is ever parsed, only its shape
 * (a single complete semantic version) is accepted, and neither the output nor
 * the failure text is ever echoed anywhere. The `exec` seam takes the standard
 * `child_process.execFile` callback signature and may return the child handle;
 * there is deliberately no synchronous variant.
 *
 * The probe owns a deadline that is independent of the executor's callback: if
 * the callback never arrives (a wedged CLI, a hostile seam), the probe still
 * settles as `timeout`, terminates the retained child, and ignores any late
 * answer — so it can never hang a command or leak a process or timer.
 */
export async function probeOpenCodeSkillShape({
  executable = process.env.SKILL_ROUTER_OPENCODE_BIN || "opencode",
  exec = defaultProbe,
  timeoutMs = OPENCODE_PROBE_TIMEOUT_MS,
} = {}) {
  const observation = await new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let child = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(value);
    };
    try {
      child = exec(
        executable,
        ["--version"],
        { encoding: "utf8", timeout: timeoutMs, maxBuffer: OPENCODE_PROBE_MAX_BUFFER, windowsHide: true },
        (error, stdout, stderr) => finish({ error, stdout, stderr }),
      );
    } catch (error) {
      finish({ error, stdout: "", stderr: "" });
      return;
    }
    // A synchronous callback (or throw) already settled; otherwise this probe
    // arms its own deadline regardless of what the executor does later.
    if (settled) return;
    timer = setTimeout(() => {
      terminateProbeChild(child);
      finish({ timedOut: true });
    }, timeoutMs);
  });
  if (observation.timedOut) return { status: "unknown", reason: "timeout" };
  if (observation.error) {
    return { status: "unknown", reason: probeFailureReason(observation.error) };
  }
  const shape = skillShapeFromOpenCodeVersion(observation.stdout);
  if (!shape) return { status: "unknown", reason: "unrecognized-output" };
  return { status: "known", shape };
}

/**
 * The fixed deferred action for an uninferable skill shape. It names neither
 * shape — recommending one would be a guess — and only asks for a supported
 * OpenCode CLI plus a rerun.
 */
export const OPENCODE_SHAPE_UNKNOWN_ACTION =
  "OpenCode's skills shape is unknown: make a supported OpenCode CLI available " +
  "(opencode --version must print a single clean version) and rerun skill-router to attach the managed skills directory";

export function configuredSkillSources(config) {
  if (Array.isArray(config.skills)) return config.skills;
  if (config.skills && typeof config.skills === "object" && Array.isArray(config.skills.paths)) {
    return config.skills.paths;
  }
  return [];
}

function configuredSkillShape(config) {
  if (Array.isArray(config.skills)) return "array";
  if (config.skills && typeof config.skills === "object" && Array.isArray(config.skills.paths)) return "paths";
  return null;
}

function assertConfigObject(config, file) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`OpenCode configuration must be an object: ${file}`);
  }
}

/**
 * Shape rules shared by every OpenCode planner: `skills` must be absent, an
 * array, or an object whose optional `paths` is an array. Anything else — a
 * string, null, or a non-array `paths` — fails closed instead of guessing
 * where the managed directory lives.
 */
function assertSkillsConfiguration(config, file) {
  if (config.skills === undefined || Array.isArray(config.skills)) return;
  if (config.skills === null || typeof config.skills !== "object") {
    throw new Error(`OpenCode skills must be an array or an object with paths: ${file}`);
  }
  if (config.skills.paths !== undefined && !Array.isArray(config.skills.paths)) {
    throw new Error(`OpenCode skills must be an array or an object with paths: ${file}`);
  }
}

/**
 * The single parsing rule every OpenCode planner shares: strict JSON first,
 * JSONC only as a fallback that is remembered so no planner ever rewrites a
 * document it could not round-trip.
 */
function parseOpenCodeText(text, file) {
  try {
    return { strict: true, config: JSON.parse(text) };
  } catch {
    return { strict: false, config: parseJsonc(text, file) };
  }
}

/**
 * One byte-exact read per plan: `bytes` is exactly what is on disk (or `null`
 * for an absent configuration), so every plan outcome can bind its write to a
 * compare-and-swap against observed bytes instead of re-reading an unbound
 * copy later.
 */
async function readOpenCodeConfig(file) {
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, strict: true, bytes: null, text: null, config: { $schema: "https://opencode.ai/config.json" } };
    }
    throw mapJsonReadError(file, error);
  }
  const text = bytes.toString("utf8");
  return { exists: true, bytes, text, ...parseOpenCodeText(text, file) };
}

/**
 * Capability resolution, in fixed order: an existing valid skills shape in the
 * configuration always wins and never spawns the CLI; an explicit caller shape
 * is the next authority; only then is the bounded asynchronous `opencode
 * --version` probe performed. A dry run never spawns OpenCode, and an
 * uninferable shape is returned as a structured unknown instead of a guess.
 */
async function resolveTargetShape({ config, shape, dryRun, exec }) {
  const configured = configuredSkillShape(config);
  if (configured) return { shape: configured };
  if (shape === "array" || shape === "paths") return { shape };
  if (dryRun) return { unknown: "dry-run" };
  const probe = await probeOpenCodeSkillShape(exec ? { exec } : {});
  if (probe.status === "known") return { shape: probe.shape };
  return { unknown: probe.reason };
}

/** Deferred plan: router-owned generation continues, nothing is written. */
function deferredShapePlan(file, config, observed) {
  return {
    file,
    config,
    content: null,
    manual: true,
    deferred: true,
    instruction: OPENCODE_SHAPE_UNKNOWN_ACTION,
    ...observed,
  };
}

/**
 * `shape` remains the explicit caller override (tests and embedders); normal
 * execution omits it and lets an existing skills shape or the bounded CLI
 * probe decide. `options.dryRun` guarantees OpenCode is never spawned, and
 * `options.exec` is the injected spawn seam for the probe.
 *
 * Every outcome — rewrite, JSONC manual, and deferred — carries `exists` and
 * the exact observed `original` bytes (or `null` for an absent file), so a
 * caller can bind its write to a compare-and-swap against what this plan
 * actually saw.
 */
export async function planOpenCodeConfig(file, skillsDirectory, shape, options = {}) {
  const { config, strict, bytes } = await readOpenCodeConfig(file);
  assertConfigObject(config, file);
  assertSkillsConfiguration(config, file);
  const observed = { exists: bytes !== null, original: bytes };
  const resolution = await resolveTargetShape({
    config,
    shape,
    dryRun: options.dryRun === true,
    exec: options.exec,
  });
  if (resolution.unknown !== undefined) return deferredShapePlan(file, config, observed);
  const targetShape = resolution.shape;
  if (config.skills !== undefined && !Array.isArray(config.skills) && config.skills.paths === undefined) {
    // A v1 skills object may legitimately omit paths (e.g. only urls). Accept it
    // only when the target shape is paths so we can add paths without dropping fields.
    if (targetShape !== "paths") {
      throw new Error(`OpenCode skills must be an array or an object with paths: ${file}`);
    }
  }
  const skills = [...configuredSkillSources(config)];
  const configured = skills.includes(skillsDirectory);
  if (!configured) skills.push(skillsDirectory);
  if (!strict) {
    return {
      file,
      config,
      content: null,
      manual: true,
      instruction: configured
        ? undefined
        : targetShape === "paths"
          ? `Add ${JSON.stringify(skillsDirectory)} to the skills.paths array in ${file}`
          : `Add ${JSON.stringify(skillsDirectory)} to the skills array in ${file}`,
      ...observed,
    };
  }
  const nextSkills = targetShape === "array"
    ? skills
    : { ...(config.skills ?? {}), paths: skills };
  const nextConfig = { ...config, skills: nextSkills };
  return {
    file,
    config: nextConfig,
    content: `${JSON.stringify(nextConfig, null, 2)}\n`,
    manual: false,
    ...observed,
  };
}

function absentRemovalPlan(file, skillsDirectory, config = null, strict = false) {
  return {
    file,
    skillsDirectory,
    status: "absent",
    manual: false,
    config,
    content: null,
    strict,
    occurrenceCount: 0,
  };
}

/**
 * Classifies the configuration path before it is read: a missing path or a
 * dangling symlink is simply absent, while directories, FIFOs, sockets, and
 * other non-regular targets refuse up front so planning never blocks on or
 * interprets something that cannot be rewritten safely. Symlinks that resolve
 * to a regular file are read through, but remain refused later if a rewrite
 * would be required.
 */
async function inspectOpenCodeConfigTarget(file) {
  let entry = null;
  try {
    entry = await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return { entry: null, resolved: null };
    throw error;
  }
  if (!entry.isSymbolicLink()) {
    if (!entry.isFile()) throw new Error(`Refusing a non-regular OpenCode configuration: ${file}`);
    return { entry, resolved: entry };
  }
  let resolved = null;
  try {
    resolved = await lstat(await realpath(file));
  } catch (error) {
    if (error.code === "ENOENT") return { entry, resolved: null };
    throw error;
  }
  if (!resolved.isFile()) throw new Error(`Refusing a non-regular OpenCode configuration: ${file}`);
  return { entry, resolved };
}

function removalInstruction(file, skillsDirectory, config, occurrenceCount) {
  const container = Array.isArray(config.skills) ? "skills array" : "skills.paths array";
  const scope = occurrenceCount > 1 ? `all ${occurrenceCount} occurrences of` : "the exact entry";
  return `Remove ${scope} ${JSON.stringify(skillsDirectory)} from the ${container} in ${file}`;
}

/**
 * Pure removal plan for the managed OpenCode skills directory.
 *
 * - The router's own configuration (`.skill-router.json`) is never a target.
 * - A missing file or a missing exact entry is already detached (`absent`).
 * - Strict JSON with the entry yields `rewrite` and the exact bytes to write,
 *   together with the exact `original` bytes observed while planning so the
 *   transaction can compare-and-swap against them;
 *   every unrelated field, source, and the array/`skills.paths` shape survive,
 *   and every occurrence of the exact managed path is removed.
 * - JSONC with the entry yields `manual`: the document is never rewritten and
 *   the user must remove the exact entry before uninstall can continue.
 * - Directories, FIFOs, and symlinks that would require a rewrite refuse
 *   instead of being replaced through an unsafe target.
 * - Malformed documents, non-object configurations, and unsupported `skills`
 *   shapes refuse instead of guessing.
 */
export async function planOpenCodeRemoval(file, skillsDirectory) {
  if (typeof skillsDirectory !== "string" || skillsDirectory === "") {
    throw new Error("A managed skills directory is required to plan an OpenCode removal");
  }
  if (path.basename(file) === CONFIG_FILE) {
    throw new Error(`Refusing to treat the router configuration as an OpenCode configuration: ${file}`);
  }
  const { entry, resolved } = await inspectOpenCodeConfigTarget(file);
  // A missing path, a dangling symlink, or a target without a readable file
  // has no configuration to detach from.
  if (!entry || !resolved) return absentRemovalPlan(file, skillsDirectory);
  // One byte-exact read per plan: `original` records exactly what was on disk,
  // so the removal transaction can bind its write and its restoration proof to
  // observed bytes instead of re-reading an unbound copy later.
  let original;
  try {
    original = await readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") return absentRemovalPlan(file, skillsDirectory);
    throw error;
  }
  const { config, strict } = parseOpenCodeText(original.toString("utf8"), file);

  assertConfigObject(config, file);
  assertSkillsConfiguration(config, file);
  const occurrenceCount = configuredSkillSources(config).filter((value) => value === skillsDirectory).length;
  if (occurrenceCount === 0) return absentRemovalPlan(file, skillsDirectory, config, strict);

  if (!strict) {
    return {
      file,
      skillsDirectory,
      status: "manual",
      manual: true,
      config,
      content: null,
      strict: false,
      occurrenceCount,
      instruction: removalInstruction(file, skillsDirectory, config, occurrenceCount),
    };
  }
  if (entry.isSymbolicLink()) {
    throw new Error(`Refusing to rewrite a symlinked OpenCode configuration: ${file}`);
  }
  const nextConfig = Array.isArray(config.skills)
    ? { ...config, skills: config.skills.filter((value) => value !== skillsDirectory) }
    : { ...config, skills: { ...config.skills, paths: config.skills.paths.filter((value) => value !== skillsDirectory) } };
  return {
    file,
    skillsDirectory,
    status: "rewrite",
    manual: false,
    config: nextConfig,
    content: `${JSON.stringify(nextConfig, null, 2)}\n`,
    // Exact bytes observed while planning: the transaction refuses to write if
    // the file no longer matches them, and proves restoration against them.
    original,
    strict: true,
    occurrenceCount,
  };
}

/**
 * Proves a removal plan really happened: `rewrite` plans must match the file
 * byte for byte, and every plan must show exact absence of the managed
 * directory. A `manual` plan cannot be verified because it was never applied.
 */
export async function verifyOpenCodeRemoval(plan) {
  if (!plan || typeof plan !== "object") throw new Error("An OpenCode removal plan is required");
  const { file, skillsDirectory, status } = plan;
  if (typeof file !== "string" || typeof skillsDirectory !== "string") {
    throw new Error("An OpenCode removal plan must record the configuration file and the managed skills directory");
  }
  if (status === "manual") {
    throw new Error(`The OpenCode configuration still requires manual removal: ${file}`);
  }
  if (status !== "absent" && status !== "rewrite") {
    throw new Error(`Unsupported OpenCode removal status: ${JSON.stringify(status)}`);
  }
  const { entry, resolved } = await inspectOpenCodeConfigTarget(file);
  if (!entry || !resolved) {
    if (status === "rewrite") throw new Error(`The OpenCode configuration is missing after the planned rewrite: ${file}`);
    return true;
  }
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      if (status === "rewrite") throw new Error(`The OpenCode configuration is missing after the planned rewrite: ${file}`);
      return true;
    }
    throw error;
  }
  if (status === "rewrite" && text !== plan.content) {
    throw new Error(`The OpenCode configuration does not match the planned removal bytes: ${file}`);
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    config = parseJsonc(text, file);
  }
  assertConfigObject(config, file);
  assertSkillsConfiguration(config, file);
  if (configuredSkillSources(config).some((value) => value === skillsDirectory)) {
    throw new Error(`The managed skills directory is still configured in ${file}`);
  }
  return true;
}

export async function ensureOpenCodeDirectory(file) {
  await mkdir(path.dirname(file), { recursive: true });
}
