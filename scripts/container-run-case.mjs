#!/usr/bin/env node
/**
 * In-container case runner (Phase 2) — executed inside one fresh container as
 * uid 1000 under the read-only root + tmpfs layout of the harness images.
 *
 * Contract:
 *   - verifies the mounted artifact's sha256 against the outer lifecycle's
 *     locked hash before anything else;
 *   - installs only the packed artifact into /opt/skill-router-install and
 *     creates only its own fixture (a single `release` skill) under
 *     /workspace;
 *   - runs the packaged skill-router CLI (init with an explicit harness,
 *     check/registry/managed files, route sanity, OpenCode config shape); for
 *     Claude routed cases runs `init --harness claude`, consumes the
 *     production-generated plugin directory and its recorded marketplace
 *     identity (exposed only through `--plugin-dir`) and re-verifies the full
 *     plugin manifest after the model run, while the Claude control case stays
 *     uninitialized; then exactly one harness run for the case's
 *     harness/scenario;
 *   - asserts the ordered structural chain from the harness event stream
 *     (never raw text matching on model output);
 *   - emits exactly ONE compact JSON line on stdout: a success report with
 *     case/harness/scenario, artifact hash, structural chain evidence,
 *     sessionCount (never a session id), outcome/skill id; or a failure
 *     report carrying only centrally sanitized event kinds/tool names/messages.
 *
 * Raw harness stdout/stderr, credentials, session ids, request tokens,
 * absolute container paths, prompts, and model content never reach a report.
 *
 * This module is import-safe: parser/assertion functions are exported for
 * host-side tests and main() only runs when invoked directly.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

/* --------------------------------- constants -------------------------------- */

export const RELEASE_MARKER = "RELEASE_SKILL_LOADED";
export const RELEASE_SKILL_ID = "release";
export const ROUTER_SKILL_ID = "skill-router";

export const ARTIFACT_PATH = "/input/skill-router.tgz";
export const INSTALL_PREFIX = "/opt/skill-router-install";
export const PROJECT_DIR = "/workspace/project";
export const FIXTURES_DIR = "/workspace/fixtures";
export const MANAGED_DIR = path.join(PROJECT_DIR, ".skill-router", "opencode-skills");
export const REGISTRY_FILE = path.join(PROJECT_DIR, ".skill-router", "registry.json");
export const OPENCODE_CONFIG_FILE = path.join(PROJECT_DIR, ".opencode", "opencode.json");

/* ------- Router-owned Claude state paths (namespace-independent) ----------- */

export const CLAUDE_STATE_DIR = path.join(PROJECT_DIR, ".skill-router", "claude");
export const INSTALLATION_FILE = path.join(PROJECT_DIR, ".skill-router", "installation.json");
/**
 * Scratch Claude configuration used only by router init/check when the
 * `claude` harness is recorded: the CLI keeps its cache and settings under
 * `CLAUDE_CONFIG_DIR`, so both stay under the container `/tmp` instead of the
 * container HOME. The command *cwd* is the router root (every project/local
 * command runs with `cwd=context.root`), so `--scope local` registration lands
 * in this project's own `.claude/settings.local.json`; the model run is
 * `--restricted`, which drops project/local settings, so the only plugin
 * source it can observe is `--plugin-dir`.
 */
export const CLAUDE_REGISTER_CONFIG_DIR = "/tmp/skill-router-claude-config";

/**
 * Production Claude integration, loaded from the artifact under test: the
 * installed package inside the container, or this repository checkout when
 * host-side tests import the runner. The runner never re-declares the plugin
 * namespace, its paths, the prompts that embed it, or the marketplace
 * identity — it consumes exactly what `skill-router init --harness claude`
 * generates.
 *
 * Resolution is deliberately lazy: inside the container the artifact is only
 * installed *after* this module loads (runCase step 2), so a container run
 * defers resolution to `runCase()`; a host-side repository checkout resolves
 * during module load, so every importer sees populated constants.
 */
let productionInstallation = null;
/** Fixed production plugin namespace for the project-scope Claude integration. */
export let PLUGIN_NAME = null;
/** Canonical Skill IDs Claude must use to load the router and release skills. */
export let CLAUDE_ROUTER_SKILL_ID = null;
export let CLAUDE_RELEASE_SKILL_ID = null;
/** Generated plugin paths (namespace-derived). */
export let PLUGIN_DIR = null;
export let PLUGIN_SKILLS_DIR = null;
export let PLUGIN_MANIFEST_DIR = null;
export let PLUGIN_MANIFEST_FILE = null;
/** Claude prompts (namespace-derived). */
export let CLAUDE_CONTROL_PROMPT = null;
export let CLAUDE_SELECT_PROMPT = null;
export let CLAUDE_NONE_PROMPT = null;

if (productionSourceAvailable()) await ensureProductionInstallation();

/** Marketplace identity of one router-owned state directory (production hash). */
export function productionClaudeMarketplaceName(scope, stateDirectory) {
  if (!productionInstallation) throw caseError("install", "production installation module is not loaded");
  return productionInstallation.claudeMarketplaceName(scope, stateDirectory);
}

/** Public (router) skill id → canonical namespaced Skill id. */
export function canonicalSkillId(publicSkillId) {
  return `${PLUGIN_NAME}:${String(publicSkillId)}`;
}

/** Pinned Claude 2.1.291 built-ins reported by every restricted init event. */
export const CLAUDE_BUILTIN_PLUGINS = Object.freeze([
  Object.freeze({ name: "cc-plugin-agents-md", path: "builtin" }),
  Object.freeze({ name: "cc-plugin-plugin-authoring", path: "builtin" }),
]);

export const STAGES = Object.freeze([
  "args",
  "env",
  "artifact",
  "install",
  "fixtures",
  "router",
  "config",
  "auth",
  "plugin",
  "harness",
  "stream",
  "parse",
  "inspect",
]);

export const CASE_ENV = Object.freeze({
  opencodeModel: "SKILL_ROUTER_OPENCODE_MODEL",
  claudeModel: "SKILL_ROUTER_CLAUDE_MODEL",
});
/** OpenCode model format (strict provider/model) — mirrors container-lib's
 * `MODEL_FORMAT_RE`; tests prove the host/container tables agree. */
export const MODEL_FORMAT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
/** Claude Code model input: aliases or Anthropic ids — mirrors container-lib's
 * `CLAUDE_MODEL_RE`; tests prove the host/container tables agree. */
export const CLAUDE_MODEL_FORMAT_RE = /^(?:sonnet|opus|haiku|claude-[A-Za-z0-9][A-Za-z0-9.-]*)$/;
/** Neutral bounded replacement for overlong event-derived names. */
export const OVERLONG_NAME_PLACEHOLDER = "overlong-name";

/**
 * Stable project request spool directory (Phase 7 ingress): every valid
 * request proof resolves to `<project>/.skill-router-requests/<32hex>.txt`.
 */
export const REQUEST_SPOOL_DIRNAME = ".skill-router-requests";
/**
 * Retired legacy spool fragment (`<state>/requests`). It is still *detected*
 * everywhere the stable spool is detected — a shell reference or a write/patch
 * proof that names it fails structurally — but it is never accepted as valid
 * proof of the request write.
 */
export const LEGACY_REQUEST_SPOOL_FRAGMENT = ".skill-router/requests";

export const REQUEST_TOKEN_FILE = /\.skill-router-requests\/([0-9a-f]{32})\.txt$/;
export const REQUEST_TOKEN_RE = /--request-token\s+([0-9a-f]{32})\b/;
/**
 * Package bin that must never be executed directly: npm package storage is not
 * executable under this substrate, so the immutable image-layer wrapper is what
 * PATH resolves instead.
 */
export const ROUTER_TARGET = "/opt/skill-router-install/node_modules/.bin/skill-router";
/** Immutable wrapper directory baked into the read-only rootfs. */
export const ROUTER_WRAPPER_DIR = "/usr/local/bin";
/** Immutable wrapper path (`scripts/router-wrapper.mjs` staged into the image). */
export const ROUTER_WRAPPER_PATH = "/usr/local/bin/skill-router";
/**
 * Pinned sha256 of the staged wrapper source (mirrors the host constant and
 * the digest embedded in `test/container/Dockerfile`); the case runner verifies
 * the image-layer file against it and never prints it.
 */
export const ROUTER_WRAPPER_SHA256 = "6c0a7f4a60c40d2584f00ede1aca6ff5d8876f4fd9d58715ce84ec8cb890bf64";
/** Roots the wrapper must never live inside. */
export const ROUTER_WRAPPER_FORBIDDEN_ROOTS = Object.freeze([
  PROJECT_DIR,
  "/home/node",
  INSTALL_PREFIX,
  "/workspace/fixtures",
]);
/** Route output is bounded: whole-value JSON objects only, max 64 KiB. */
export const ROUTE_OUTPUT_MAX_BYTES = 64 * 1024;
/** Bounded schema-only diagnostic limits (never values). */
export const ROUTE_DIAGNOSTIC_MAX_EVENTS = 4;
export const ROUTE_DIAGNOSTIC_MAX_KEYS = 16;
export const ROUTE_DIAGNOSTIC_MAX_CONTENT_ITEMS = 8;

export const SELECT_REQUEST = "prepare and publish a release";
export const NONE_REQUEST = "calculate orbital velocity";

export const OPENCODE_SELECT_PROMPT =
  "Load and use the `skill-router` skill for this request: prepare and publish a release. " +
  'Route exactly the request text "prepare and publish a release". After loading the selected skill, ' +
  "return the marker that its instructions tell you to return.";
export const OPENCODE_NONE_PROMPT =
  "Load and use the `skill-router` skill for this unrelated request: calculate orbital velocity. " +
  'Route exactly the request text "calculate orbital velocity". Report only the router outcome.';
// The three Claude prompts embed the production plugin namespace, so they are
// built by ensureProductionInstallation() (declared as `let` above).

const ALLOWED_TOOLS = "Skill,Write,Bash(skill-router route:*)";
const REQUEST_READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "list"]);
/**
 * Permission rules only (`--tools` stays the exact `Skill,Write,Bash`
 * allowlist): the trailing `mcp__*` rule is a defensive denial of every MCP
 * tool, on top of `--strict-mcp-config` plus the absence of any MCP config.
 */
const DISALLOWED_TOOLS =
  "WebFetch,WebSearch,Edit,MultiEdit,NotebookEdit,NotebookRead,TodoWrite,Task,TaskCreate,TaskGet,TaskList,TaskOutput,TaskStop,TaskUpdate,Agent,PushNotification,CronCreate,CronDelete,CronUpdate,ScheduleWakeup,RemoteTrigger,DesignSync,EnterWorktree,ExitWorktree,Monitor,KillShell,EnterPlanMode,ExitPlanMode,mcp__*";
const RUN_TIMEOUT_MS = 300_000;
/** Status-only router preflight: quick, and never waits on a model. */
const ROUTER_PREFLIGHT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 64 * 1024 * 1024;
const CASE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const SCENARIOS = new Set(["select", "none", "control"]);
const SHA256_RE = /^[0-9a-f]{64}$/;
const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
/** Bounded structural names: canonical namespaced Skill IDs carry a `:`. */
const SAFE_NAME_RE = /^[A-Za-z0-9._:-]+$/;
/** Tool-call identifiers are stored structurally; anything else is dropped. */
const TOOL_CALL_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const KIND_RE = /^[a-z0-9][a-z0-9_:.-]{0,39}$/;
const TOOL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ALLOWED_STATUSES = new Set(["completed", "error", "pending", "running", "waiting", "input", "cancelled"]);
/**
 * The stable project spool as it appears inside a normalized absolute path:
 * exactly one directory level below the project root.
 */
const REQUEST_DIR = `/${REQUEST_SPOOL_DIRNAME}/`;
/**
 * Filesystem tool that may create the router request file (`write`, used by
 * OpenCode v1 and Claude). Its completed input must carry the exact path and
 * exact request bytes.
 */
export const REQUEST_WRITE_TOOL = "write";
/**
 * Pinned OpenCode v2 filesystem tool (`opencode.tool.patch`, name `patch`;
 * `apply_patch` is the same tool under an alternate internal name). Its input
 * is `{ patchText }` in the pinned `*** Begin Patch … *** End Patch` dialect
 * describing add/update/delete operations.
 */
export const REQUEST_PATCH_TOOL = "patch";
/** Names the pinned harness may report for the patch tool. */
const REQUEST_PATCH_TOOLS = new Set(["patch", "apply_patch"]);
/** Input fields that may carry the structured patch text. */
const PATCH_TEXT_KEYS = ["patchText", "patch", "diff"];
/**
 * Router-owned Claude state generated by `skill-router init --harness
 * claude` and consumed verbatim by this runner — nothing here generates it
 * (the paths are declared with the other constants above):
 *
 *   <state>/claude/.claude-plugin/marketplace.json    local marketplace manifest
 *   <state>/claude/plugins/<plugin>/.claude-plugin/plugin.json   inert manifest
 *   <state>/claude/plugins/<plugin>/skills/<id>/SKILL.md         generated skills
 *
 * `PLUGIN_DIR` and its derived paths are namespace-dependent and are assigned
 * by ensureProductionInstallation().
 */
/** True-exposed-tool allowlist for Claude (permissions rules stay separate). */
export const CLAUDE_TOOLS = "Skill,Write,Bash";
/**
 * Exact model-callable tool set reported by the pinned `system/init` event.
 * The fixtures pin exactly these three; no pinned extra has been proven
 * necessary, so `CLAUDE_INIT_TOOL_EXTRAS` stays empty. If a future pinned CLI
 * reports an unavoidable extra tool, add it here (with the reason) rather than
 * widening the assertion at the call site.
 */
export const CLAUDE_INIT_TOOLS = Object.freeze(["Bash", "Skill", "Write"]);
export const CLAUDE_INIT_TOOL_EXTRAS = Object.freeze([]);
/**
 * Project-root entries that would give a non-bare Claude run a config, skill,
 * or MCP surface of its own; none may exist before launch.
 */
export const FORBIDDEN_PROJECT_CLAUDE_ENTRIES = Object.freeze([".claude", ".claude.json", ".mcp.json"]);
/** HOME entries that would give Claude a config/MCP surface outside the fresh
 * CLAUDE_CONFIG_DIR (which must itself be absent or empty). */
export const FORBIDDEN_HOME_CLAUDE_ENTRIES = Object.freeze([".claude.json", ".mcp.json"]);
/** The exposed plugin root carries exactly these entries (in sorted order). */
export const PLUGIN_ROOT_ENTRIES = Object.freeze([".claude-plugin", "skills"]);
/** `.claude-plugin/` carries exactly the inert manifest. */
export const PLUGIN_MANIFEST_ENTRIES = Object.freeze(["plugin.json"]);
/** Exhaustive inert manifest key set; any other field is a structural failure. */
export const PLUGIN_MANIFEST_KEYS = Object.freeze(["author", "description", "name", "version"]);
/**
 * Managed-policy surface under the image's Claude configuration root that must
 * be *absent* before any Claude launch. Presence only is asserted — the runner
 * never creates, repairs, or writes anything there.
 */
export const MANAGED_POLICY_ROOT = "/etc/claude-code";
/** Entry names under the policy root that must be absent. */
export const MANAGED_POLICY_ABSENT_ENTRIES = Object.freeze([
  "managed-settings.json",
  "managed-settings.d",
  "managed-mcp.json",
  ".claude",
]);
/** The same absent surface as fixed default-root paths. */
export const MANAGED_POLICY_ABSENT_PATHS = Object.freeze(
  MANAGED_POLICY_ABSENT_ENTRIES.map((entry) => `${MANAGED_POLICY_ROOT}/${entry}`),
);

/** Bounded, sanitized structural strings for summaries/failure reports. */
function boundedKind(value) {
  const text = sanitizeContainerText(String(value ?? "")).toLowerCase();
  return KIND_RE.test(text) ? text : "event";
}

function boundedTool(value) {
  const text = sanitizeContainerText(String(value ?? ""));
  return TOOL_RE.test(text) ? text : undefined;
}

function boundedStatus(value) {
  const text = String(value ?? "").toLowerCase();
  return ALLOWED_STATUSES.has(text) ? text : undefined;
}

function boundedName(value) {
  const text = sanitizeContainerText(String(value ?? ""));
  if (!SAFE_NAME_RE.test(text)) return undefined;
  // Overlong event-derived names are never carried raw.
  if (text.length > 64) return OVERLONG_NAME_PLACEHOLDER;
  return text;
}

/* --------------------------------- errors ---------------------------------- */

/** Structural case failure: message is fixed/structural, events sanitized. */
export class CaseAssertionError extends Error {
  constructor(stage, message, events = null, sessionCount = null) {
    super(message);
    this.name = "CaseAssertionError";
    this.stage = STAGES.includes(stage) ? stage : "unknown";
    this.events = events ?? null;
    this.sessionCount = Number.isInteger(sessionCount) ? sessionCount : null;
  }
}

function caseError(stage, message, events = null, sessionCount = null) {
  return new CaseAssertionError(stage, sanitizeContainerText(message), events, sessionCount);
}

/* -------------------------------- sanitization ------------------------------ */

/**
 * Central in-container sanitizer. Reports only carry structural facts, but
 * this guard still strips credentials (from the process environment and by
 * pattern), request tokens, UUIDs, and absolute container paths from any
 * message that might otherwise embed them.
 */
export function sanitizeContainerText(value) {
  if (typeof value !== "string" || value === "") return "";
  let output = value;
  for (const key of Object.keys(process.env ?? {})) {
    if (!/(KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD)/.test(key)) continue;
    const secret = process.env[key];
    if (typeof secret === "string" && secret.length >= 4) output = output.split(secret).join("[redacted]");
  }
  output = output
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[redacted-credential]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bAuthorization["']?\s*[:=]\s*(?:"[^"]*"|\S+)/gi, "Authorization: [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, "[redacted-jwt]")
    .replace(/\b(?:sk|pat|api|key|token|secret|auth|password|passwd|bearer)[-_:][A-Za-z0-9_./+=-]{8,}\b/gi, "[redacted]")
    .replace(/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Za-z0-9_]*)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, (_m, key) => `${key}=[redacted]`)
    .replace(/\b[0-9a-f]{32}\b/g, "[request-token]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[uuid]");
  for (const prefix of ["/workspace/", "/home/node/", "/opt/skill-router-install/", "/usr/local/lib/", "/input/", "/tmp/"]) {
    output = output.split(prefix).join("[container]/");
  }
  output = output.split("/workspace").join("[container]");
  output = output.split("/home/node").join("[container]");
  return output;
}

/* ------------------------------ OpenCode parsing ---------------------------- */

/** Parse OpenCode stdout (JSON array or NDJSON) into raw events. */
export function parseOpenCodeStdout(output) {
  const trimmed = String(output ?? "").trim();
  if (!trimmed) throw caseError("stream", "harness produced no event stream");
  if (trimmed.startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw caseError("stream", "harness event stream was not a valid JSON array");
    }
    if (!Array.isArray(parsed)) throw caseError("stream", "harness event stream was not an array");
    if (parsed.length === 0) throw caseError("stream", "harness produced an empty event stream");
    return parsed;
  }
  const events = [];
  const lines = trimmed.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw caseError("stream", `harness event stream line ${index + 1} was not valid JSON`);
    }
    if (!parsed || typeof parsed !== "object") {
      throw caseError("stream", `harness event stream line ${index + 1} was not an object`);
    }
    events.push(parsed);
  }
  if (events.length === 0) throw caseError("stream", "harness produced no event stream");
  return events;
}

/**
 * Normalize legacy (v1) and current (v2) OpenCode event shapes into one form.
 * v2 emits `tool_use` with completed/error `part` records; skill input may be
 * `id` or `name`; the shell tool may be `shell` or `bash`.
 *
 * v2 structure is preserved without ever exposing raw values in summaries:
 *   - `output`       the canonical `state.output` (string or object);
 *   - `contentItems` the documented ordered nested `state.metadata.content`
 *                    array (internal only, never summarized);
 *   - `exit`         the nested shell metadata exit code, when that block exists;
 *   - `hasMeta`      whether the nested metadata block exists at all;
 *   - `toolCallId`   the tool-call identifier, when it is a safe-shaped string.
 */
export function normalizeOpenCodeEvent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const part = raw.part && typeof raw.part === "object" ? raw.part : {};
  const state = part.state && typeof part.state === "object" ? part.state : {};
  const input = state.input ?? part.input ?? null;
  const session = raw.sessionID ?? raw.sessionId ?? raw.session_id ?? null;
  const partType = typeof part.type === "string" ? part.type : null;
  const tool = typeof part.tool === "string"
    ? part.tool
    : typeof raw.tool === "string"
      ? raw.tool
      : null;
  const status = state.status ?? part.status ?? (raw.type === "error" ? "error" : null);
  const text = partType === "text" && typeof part.text === "string" ? part.text : null;
  const stateMetadata = state.metadata && typeof state.metadata === "object" ? state.metadata : null;
  const shellMeta =
    stateMetadata && stateMetadata.metadata && typeof stateMetadata.metadata === "object"
      ? stateMetadata.metadata
      : null;
  const contentItems = stateMetadata && Array.isArray(stateMetadata.content) ? stateMetadata.content : null;
  const toolCallRaw =
    (typeof part.toolCallID === "string" ? part.toolCallID : null) ??
    (typeof part.toolCallId === "string" ? part.toolCallId : null) ??
    (typeof stateMetadata?.toolCallID === "string" ? stateMetadata.toolCallID : null) ??
    (typeof stateMetadata?.toolCallId === "string" ? stateMetadata.toolCallId : null);
  return {
    type: typeof raw.type === "string" ? raw.type : null,
    session: typeof session === "string" && session ? session : null,
    partType,
    tool,
    status: typeof status === "string" ? status : null,
    input: input && typeof input === "object" ? input : null,
    output: state.output ?? part.output ?? null,
    text,
    contentItems,
    exit: shellMeta ? integerOrNull(shellMeta.exit ?? shellMeta.exitCode ?? shellMeta.code) : null,
    hasMeta: shellMeta !== null,
    toolCallId: typeof toolCallRaw === "string" && TOOL_CALL_ID_RE.test(toolCallRaw) ? toolCallRaw : null,
  };
}

function integerOrNull(value) {
  return Number.isInteger(value) && Number.isSafeInteger(value) ? value : null;
}

function skillInput(event) {
  const input = event.input;
  if (!input || typeof input !== "object") return null;
  for (const key of ["name", "id", "skill"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim().replace(/^\/+/, "");
  }
  return null;
}

function isSkillTool(event) {
  return typeof event.tool === "string" && ["skill", "skills"].includes(event.tool);
}

function isToolEvent(event) {
  return typeof event.tool === "string" && event.partType !== "text";
}

/**
 * Characters that can never appear in a managed route invocation: pipes,
 * redirects, chaining/background operators, command/variable substitution,
 * subshells, brace/glob expansion, and newlines.
 */
const ROUTE_DANGEROUS_RE = /[|><;&`$(){}\n\r*?~]/;

function stripOuterQuotes(token) {
  if (token.length >= 2) {
    const first = token[0];
    if ((first === '"' || first === "'") && token[token.length - 1] === first) return token.slice(1, -1);
  }
  return token;
}

/**
 * Structural parse of the *managed* route command:
 * `skill-router route --json --root . --request-token <32hex>` (the managed
 * global form `--global` is accepted as the mutually exclusive scope).
 *
 * Only harmless whitespace and argument reordering are tolerated; pipes,
 * redirects, chaining, substitutions, wrappers/absolute paths, unknown options,
 * extra positionals, missing/duplicate flags, and a non-`.` root are rejected
 * with a fixed reason code. The command and the token are never returned in a
 * reason, message, or diagnostic.
 */
export function parseManagedRouteCommand(command) {
  if (typeof command !== "string" || command.trim() === "") return { ok: false, reason: "not-managed" };
  if (ROUTE_DANGEROUS_RE.test(command)) return { ok: false, reason: "unsafe-shell-syntax" };
  const tokens = command.trim().split(/\s+/).filter(Boolean).map(stripOuterQuotes);
  if (tokens[0] !== "skill-router" || tokens[1] !== "route") return { ok: false, reason: "not-managed" };

  let json = 0;
  let root = null;
  let global = 0;
  let token = null;
  let index = 2;
  while (index < tokens.length) {
    const arg = tokens[index];
    if (arg === "--json") {
      json += 1;
      index += 1;
      continue;
    }
    if (arg === "--global") {
      global += 1;
      index += 1;
      continue;
    }
    if (arg === "--root") {
      const value = tokens[index + 1];
      if (value === undefined) return { ok: false, reason: "incomplete-root" };
      if (root !== null) return { ok: false, reason: "duplicate-scope" };
      root = value;
      index += 2;
      continue;
    }
    if (arg === "--request-token") {
      const value = tokens[index + 1];
      if (value === undefined) return { ok: false, reason: "incomplete-token" };
      if (token !== null) return { ok: false, reason: "duplicate-token" };
      if (!/^[0-9a-f]{32}$/.test(value)) return { ok: false, reason: "invalid-token" };
      token = value;
      index += 2;
      continue;
    }
    if (arg.startsWith("--")) return { ok: false, reason: "unknown-option" };
    return { ok: false, reason: "extra-positional" };
  }
  if (json !== 1) return { ok: false, reason: json === 0 ? "missing-json" : "duplicate-json" };
  if (global > 1) return { ok: false, reason: "duplicate-scope" };
  if (root !== null && global > 0) return { ok: false, reason: "conflicting-scope" };
  if (root === null && global === 0) return { ok: false, reason: "missing-scope" };
  if (root !== null && root !== ".") return { ok: false, reason: "unsupported-root" };
  if (token === null) return { ok: false, reason: "missing-token" };
  return { ok: true, token, scope: root !== null ? "root" : "global" };
}

/** A command that looks like a route attempt but did not parse exactly. */
function looksLikeRouteCommand(command) {
  const text = String(command);
  return text.includes("skill-router") && text.includes("route");
}

/**
 * True when normalized text names either request spool: the stable project
 * spool (`.skill-router-requests`) or the retired legacy spool
 * (`.skill-router/requests`). Both are always detected together so a legacy
 * reference can never slip past detection; only the stable path can still pass
 * the exact-path proof, so a legacy mention is always a structural failure.
 */
function mentionsRequestSpool(text) {
  return text.includes(REQUEST_SPOOL_DIRNAME) || text.includes(LEGACY_REQUEST_SPOOL_FRAGMENT);
}

/** True when normalized text names *only* the retired legacy spool. */
function mentionsLegacyRequestSpool(text) {
  return text.includes(LEGACY_REQUEST_SPOOL_FRAGMENT);
}

/**
 * Filesystem path of a tool input that targets a request spool (stable or
 * retired legacy; any slash direction; the exact-path proof still requires the
 * normalized absolute stable project spool directory).
 */
function requestPathOf(input) {
  if (!input || typeof input !== "object") return null;
  for (const key of ["path", "file_path", "filePath"]) {
    const value = input[key];
    if (typeof value === "string" && mentionsRequestSpool(value.replaceAll("\\", "/"))) return value;
  }
  return null;
}

/**
 * Any shell command referencing the stable or the retired legacy request spool
 * — relative, absolute, `./`-prefixed, quoted, or backslash-separated — is
 * rejected. Only a completed `write`/`patch` proof may create the file.
 */
function referencesRequestDirectory(command) {
  const text = String(command).replaceAll("\\", "/").replace(/["']/g, "");
  return mentionsRequestSpool(text);
}

/** True when a path/patch fragment points into either request spool. */
function requestTargetMentions(value) {
  return typeof value === "string" && mentionsRequestSpool(value.replaceAll("\\", "/"));
}

function normalizePath(value) {
  return path.posix.normalize(String(value).replaceAll("\\", "/"));
}

function resolvePatchPath(value, expectedPath) {
  const normalized = normalizePath(value);
  if (path.posix.isAbsolute(normalized)) return normalized;
  // The stable spool is exactly one directory level below the project root, so
  // the project directory is the spool directory's parent (derived from the
  // already trusted expected path).
  const requestDirectory = path.posix.dirname(normalizePath(expectedPath));
  const projectDirectory = path.posix.dirname(requestDirectory);
  return path.posix.resolve(projectDirectory, normalized);
}

/** True for the section headers that start a new file section. */
function isPatchSectionHeader(line) {
  return line.startsWith("*** Add File:") || line.startsWith("*** Update File:") || line.startsWith("*** Delete File:");
}

function stripCr(line) {
  return String(line).replace(/\r$/, "");
}

/**
 * Conservative structural parser for the pinned OpenCode patch dialect:
 *
 *   *** Begin Patch
 *   *** Add File: <path>       (+ lines)
 *   *** Update File: <path>    (@@ hunks, optional `*** Move to:`)
 *   *** Delete File: <path>
 *   *** End Patch
 *
 * Returns `{ ok: true, ops }` with one `{type, path, content?|hunks?|movePath?}`
 * per section, or `{ ok: false, reason }` where `reason` is a fixed structural
 * phrase. Nothing from the patch text (content, paths, tokens) ever appears in
 * a reason, and the parser never applies or trusts prose — anything it cannot
 * structure is rejected.
 */
export function parseStructuredPatch(text) {
  if (typeof text !== "string") return { ok: false, reason: "patch envelope was malformed" };
  const lines = text.split("\n");
  if (stripCr(lines[0] ?? "").trim() !== "*** Begin Patch") return { ok: false, reason: "patch envelope was malformed" };
  let end = lines.length - 1;
  while (end > 0 && stripCr(lines[end]).trim() === "") end -= 1;
  if (stripCr(lines[end]).trim() !== "*** End Patch") return { ok: false, reason: "patch envelope was malformed" };

  const body = lines.slice(1, end);
  const ops = [];
  let index = 0;
  while (index < body.length) {
    const header = stripCr(body[index]).trim();
    if (header === "") {
      index += 1;
      continue;
    }
    let type = null;
    if (header.startsWith("*** Add File:")) type = "add";
    else if (header.startsWith("*** Update File:")) type = "update";
    else if (header.startsWith("*** Delete File:")) type = "delete";
    if (!type) return { ok: false, reason: "patch envelope was malformed" };
    const target = header.slice(header.indexOf(":") + 1).trim();
    if (!target) return { ok: false, reason: "patch section had an empty path" };
    index += 1;

    const section = [];
    // `*** End of File` and `*** Move to:` belong to the *current* update
    // section (the pinned parser reads them there), so only a new file header
    // closes a section.
    while (index < body.length && !isPatchSectionHeader(stripCr(body[index]).trim())) {
      section.push(body[index]);
      index += 1;
    }

    if (type === "add") {
      const addLines = [];
      for (const line of section) {
        if (!line.startsWith("+")) return { ok: false, reason: "invalid Add File line" };
        addLines.push(line.slice(1));
      }
      ops.push({ type, path: target, content: addLines.join("\n") });
      continue;
    }
    if (type === "delete") {
      if (section.some((line) => line.trim() !== "")) return { ok: false, reason: "Delete File section had body lines" };
      ops.push({ type, path: target });
      continue;
    }

    // update: optional end marker + optional move, then one or more hunks.
    const rest = [...section];
    while (rest.length > 0 && stripCr(rest[0]).trim() === "*** End of File") rest.shift();
    let movePath = null;
    while (rest.length > 0 && stripCr(rest[0]).trim().startsWith("*** Move to:")) {
      movePath = stripCr(rest[0]).trim().slice("*** Move to:".length).trim();
      if (!movePath) return { ok: false, reason: "patch move destination was empty" };
      rest.shift();
    }
    const hunks = [];
    let current = null;
    for (const line of rest) {
      const clean = stripCr(line);
      if (clean.startsWith("@@")) {
        current = { header: clean.slice(2).trim(), lines: [] };
        hunks.push(current);
        continue;
      }
      if (current) {
        if (!(clean.startsWith(" ") || clean.startsWith("+") || clean.startsWith("-"))) {
          return { ok: false, reason: "invalid update hunk line" };
        }
        current.lines.push(clean);
        continue;
      }
      if (clean.trim() !== "") return { ok: false, reason: "update section had content before its first hunk" };
    }
    if (hunks.length === 0) return { ok: false, reason: "update section had no hunks" };
    ops.push({ type, path: target, movePath, hunks });
  }
  if (ops.length === 0) return { ok: false, reason: "patch contained no file operations" };
  return { ok: true, ops };
}

/**
 * Conservative structural proof for one pinned OpenCode `patch` input.
 *
 * `targetsRequest` says the patch (its declared path, raw patch text, or any
 * section path) points into a request spool — the stable project spool or the
 * retired legacy one — such a patch must then pass every check below,
 * otherwise the run fails structurally. `ok` says the patch proves a
 * creation/update of the expected request *file* in the stable spool (single
 * section, same directory, provable body); a patch that only names the legacy
 * directory is never `ok`. The request payload itself is verified by the
 * shared content check in `inspectOpenCodeRun`, so `write` and `patch` are held
 * to one identical byte rule (a single trailing newline is tolerated for
 * `patch`, because the pinned tool appends one when writing an added file).
 * Patches that do not mention a request spool at all are never candidates, and
 * no patch text, path, or token is ever placed in a reason.
 */
export function patchRequestProof(input, expectedPath) {
  if (!input || typeof input !== "object") {
    return { targetsRequest: false, ok: false, reason: "patch input is missing" };
  }
  const declared =
    typeof input.path === "string" ? input.path : typeof input.filePath === "string" ? input.filePath : null;
  const text =
    PATCH_TEXT_KEYS.map((key) => input[key]).find((value) => typeof value === "string" && value.length > 0) ?? null;
  const declaredTargets = requestTargetMentions(declared) || (text !== null && requestTargetMentions(text));

  if (text === null) {
    return { targetsRequest: declaredTargets, ok: false, reason: "patch input carried no structured patch text" };
  }
  const parsed = parseStructuredPatch(text);
  if (!parsed.ok) return { targetsRequest: declaredTargets, ok: false, reason: parsed.reason };

  const rawPaths = parsed.ops.map((op) => op.path);
  const targetsRequest = declaredTargets || rawPaths.some((value) => requestTargetMentions(value));
  if (parsed.ops.length !== 1) {
    return {
      targetsRequest,
      ok: false,
      reason: parsed.ops.length === 0 ? "patch contained no file operations" : "patch touched multiple files",
    };
  }
  if (!targetsRequest) return { targetsRequest: false, ok: false, reason: "patch did not target the requests directory" };

  // The pinned patch tool accepts paths relative to its cwd. The harness runs
  // it from PROJECT_DIR, derived here from the already trusted expected path.
  // Resolve first, then enforce the exact request directory below so traversal
  // and foreign relative paths remain rejected.
  const target = resolvePatchPath(rawPaths[0], expectedPath);
  if (declared !== null && resolvePatchPath(declared, expectedPath) !== target) {
    return { targetsRequest: true, ok: false, reason: "patch declared a conflicting path" };
  }
  // Only the containing directory is proven here; the exact file name/token is
  // checked against the route command by the caller (single source of truth).
  if (path.posix.dirname(target) !== path.posix.dirname(expectedPath)) {
    const reason = mentionsLegacyRequestSpool(target)
      ? "patch targeted the retired requests directory"
      : "patch did not target the requests directory";
    return { targetsRequest: true, ok: false, reason };
  }

  const op = parsed.ops[0];
  let content = null;
  if (op.type === "add") {
    content = op.content;
  } else if (op.type === "delete") {
    return { targetsRequest: true, ok: false, reason: "patch only deleted a file" };
  } else if (op.type === "update") {
    if (op.movePath) return { targetsRequest: true, ok: false, reason: "patch renamed the file" };
    if (op.hunks.length !== 1) return { targetsRequest: true, ok: false, reason: "patch update had more than one hunk" };
    const hunk = op.hunks[0];
    const header = hunk.header.match(/^-(\d+),(\d+)\s+\+(\d+)(?:,(\d+))?/);
    if (!header || Number(header[1]) !== 0 || Number(header[2]) !== 0) {
      return { targetsRequest: true, ok: false, reason: "patch update cannot be proven against an empty file" };
    }
    if (hunk.lines.some((line) => !line.startsWith("+"))) {
      return { targetsRequest: true, ok: false, reason: "patch update included context or removal lines" };
    }
    content = hunk.lines.map((line) => line.slice(1)).join("\n");
  } else {
    return { targetsRequest: true, ok: false, reason: "patch envelope was malformed" };
  }
  return { targetsRequest: true, ok: true, reason: null, path: target, content };
}

function normalizeForCompare(value) {
  return String(value).toLowerCase().replace(/\s+/g, " ").trim();
}

/** First completed skill load for `skillId` after index `after` (-1 = any). */
function skillLoad(events, skillId, after = -1) {
  for (let index = after + 1; index < events.length; index += 1) {
    const event = events[index];
    if (isSkillTool(event) && event.status === "completed" && skillInput(event) === skillId) return { index, event };
  }
  return null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function utf8Bytes(value) {
  return Buffer.byteLength(String(value), "utf8");
}

/** Fixed messages for documented route-output extraction failures. */
const ROUTE_OUTPUT_FAILURES = Object.freeze({
  absent: "route command produced no router JSON result",
  oversized: "route command output exceeded the size limit",
  ambiguous: "route command output was ambiguous",
  "not-json": "route command output was not valid JSON",
  "not-object": "route command output was not a JSON object",
  conflicting: "route output representations conflicted",
});

/** Whole-value JSON object parse: no brace scanning, no prose, no ANSI help. */
function parseWholeJsonObject(text, maxBytes) {
  const trimmed = String(text).trim();
  if (trimmed === "") return { ok: false, reason: "absent" };
  if (utf8Bytes(trimmed) > maxBytes) return { ok: false, reason: "oversized" };
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: "not-json" };
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: "not-object" };
  return { ok: true, value: parsed };
}

/**
 * Documented route-output extraction. The canonical `state.output` (string or
 * whole JSON object) wins; when it is absent, exactly one documented text item
 * in the nested `state.metadata.content` array is used. Rejects absent,
 * oversized (> 64 KiB), multiple/ambiguous, non-JSON, non-object, and
 * conflicting representations — never scans for braces and never extracts
 * prose.
 */
export function extractRouteOutput(event, { maxBytes = ROUTE_OUTPUT_MAX_BYTES } = {}) {
  const canonical = event?.output;
  const canonicalPresent = typeof canonical === "string" ? canonical.trim() !== "" : isPlainObject(canonical);
  const items = Array.isArray(event?.contentItems) ? event.contentItems : [];
  const textItems = items.filter(
    (item) => isPlainObject(item) && item.type === "text" && typeof item.text === "string" && item.text !== "",
  );

  if (!canonicalPresent) {
    if (items.length === 0) return { ok: false, reason: "absent" };
    if (textItems.length !== 1 || textItems.length !== items.length) return { ok: false, reason: "ambiguous" };
    const fromContent = parseWholeJsonObject(textItems[0].text, maxBytes);
    if (!fromContent.ok) return fromContent;
    return { ok: true, value: fromContent.value, source: "content" };
  }

  const fromCanonical = typeof canonical === "string"
    ? parseWholeJsonObject(canonical, maxBytes)
    : utf8Bytes(JSON.stringify(canonical)) > maxBytes
      ? { ok: false, reason: "oversized" }
      : { ok: true, value: canonical };
  if (!fromCanonical.ok) return fromCanonical;

  // A single, well-formed content text that disagrees with the canonical
  // output is a conflicting representation and must fail closed.
  if (items.length === 1 && textItems.length === 1) {
    const other = parseWholeJsonObject(textItems[0].text, maxBytes);
    const agrees = other.ok
      ? JSON.stringify(other.value) === JSON.stringify(fromCanonical.value)
      : typeof canonical === "string" && canonical.trim() === textItems[0].text.trim();
    if (!agrees) return { ok: false, reason: "conflicting" };
  }
  return { ok: true, value: fromCanonical.value, source: "output" };
}

/* --------------------- bounded schema-only diagnostics ---------------------- */

/** Field-name allowlist for schema-only diagnostics (strict: no spaces/dashes). */
const DIAGNOSTIC_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const DIAGNOSTIC_CREDENTIAL_KEY_RE = /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)$/i;

function describeType(value) {
  if (value === undefined || value === null) return "absent";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function safeKeyList(objectValue, max = ROUTE_DIAGNOSTIC_MAX_KEYS) {
  const keys = Object.keys(objectValue);
  const allowed = [];
  let dropped = 0;
  for (const key of keys) {
    if (allowed.length >= max) {
      dropped += 1;
      continue;
    }
    if (DIAGNOSTIC_NAME_RE.test(key) && !DIAGNOSTIC_CREDENTIAL_KEY_RE.test(key)) allowed.push(key);
    else dropped += 1;
  }
  return { keys: allowed.sort(), dropped };
}

function contentInventory(items) {
  const limited = items.slice(0, ROUTE_DIAGNOSTIC_MAX_CONTENT_ITEMS);
  return {
    count: items.length,
    items: limited.map((item) => {
      if (!isPlainObject(item)) return { type: describeType(item), keys: [], dropped: 0, textLength: null };
      const { keys, dropped } = safeKeyList(item, 8);
      const text = typeof item.text === "string" ? item.text : null;
      return {
        type: typeof item.type === "string" && DIAGNOSTIC_NAME_RE.test(item.type) ? item.type : "unknown",
        keys,
        dropped,
        textLength: text === null ? null : utf8Bytes(text),
      };
    }),
  };
}

/**
 * Bounded, schema-only diagnostic for route-output parse failures: at most
 * `ROUTE_DIAGNOSTIC_MAX_EVENTS` candidate events, fixed depth, allowlisted
 * field names (credential-shaped names excluded), and only value *types*,
 * string byte lengths, array lengths, and a content-item inventory. It never
 * carries a command, output, text, path, token, prose, or secret-shaped value.
 */
export function routeOutputDiagnostic(events, { limit = ROUTE_DIAGNOSTIC_MAX_EVENTS } = {}) {
  const candidates = [];
  for (const event of events ?? []) {
    if (!event || typeof event !== "object") continue;
    const command = typeof event.input?.command === "string" ? event.input.command : null;
    const isShellTool = event.tool === "shell" || event.tool === "bash";
    const routeish = command !== null && (command.includes("skill-router") || command.includes("route"));
    if (!isShellTool && !routeish) continue;
    candidates.push(event);
    if (candidates.length >= limit) break;
  }
  return candidates.map((event) => routeDiagnosticRecord(event));
}

function routeDiagnosticRecord(event) {
  const output = event.output;
  const outputIsObject = isPlainObject(output);
  const outputKeys = outputIsObject ? safeKeyList(output) : { keys: [], dropped: 0 };
  return {
    kind: boundedKind(event.type ?? "tool_use"),
    tool: boundedTool(event.tool),
    status: boundedStatus(event.status),
    exit: integerOrNull(event.exit),
    hasMeta: event.hasMeta === true,
    hasToolCallId: typeof event.toolCallId === "string",
    outputType: describeType(output),
    outputBytes:
      typeof output === "string"
        ? utf8Bytes(output)
        : outputIsObject
          ? utf8Bytes(JSON.stringify(output))
          : null,
    outputKeys: outputKeys.keys,
    outputKeysDropped: outputKeys.dropped,
    outputKeyCount: outputIsObject ? Object.keys(output).length : null,
    contentLength: Array.isArray(event.contentItems) ? event.contentItems.length : null,
    content: Array.isArray(event.contentItems) ? contentInventory(event.contentItems) : { count: 0, items: [] },
  };
}

/** Sanitized structural summary of normalized OpenCode events (failure text).
 * Accepts raw or already-normalized events; raw events are never summarized
 * by accident. */
export function summarizeOpenCodeEvents(events, limit = 25) {
  const normalized = events
    .map((event) => (event && typeof event === "object" && event.part && typeof event.part === "object" ? normalizeOpenCodeEvent(event) : event))
    .filter(Boolean);
  const summary = [];
  for (const event of normalized) {
    if (!event || typeof event !== "object") continue;
    if (isSkillTool(event)) {
      const entry = { kind: boundedKind(event.type ?? "tool_use"), tool: boundedTool(event.tool), status: boundedStatus(event.status) };
      const name = boundedName(skillInput(event));
      if (name) entry.name = name;
      summary.push(entry);
    } else if (isToolEvent(event) && event.tool === REQUEST_WRITE_TOOL) {
      // Never include the path or content of a write; only its structure.
      summary.push({ kind: boundedKind(event.type ?? "tool_use"), tool: boundedTool(event.tool), status: boundedStatus(event.status), name: "write" });
    } else if (isToolEvent(event) && REQUEST_PATCH_TOOLS.has(event.tool)) {
      // Never include patch text, paths, or tokens; only its structure.
      summary.push({
        kind: boundedKind(event.type ?? "tool_use"),
        tool: boundedTool(event.tool),
        status: boundedStatus(event.status),
        name: boundedTool(event.tool),
      });
    } else if (isToolEvent(event) && event.input && typeof event.input.command === "string") {
      summary.push({ kind: boundedKind(event.type ?? "tool_use"), tool: boundedTool(event.tool), status: boundedStatus(event.status) });
    } else if (isToolEvent(event)) {
      summary.push({ kind: boundedKind(event.type ?? "tool_use"), tool: boundedTool(event.tool), status: boundedStatus(event.status) });
    } else if (typeof event.text === "string") {
      summary.push({ kind: "text" });
    } else if (event.type) {
      summary.push({ kind: boundedKind(event.type) });
    }
    if (summary.length >= limit) break;
  }
  return summary;
}

/**
 * Route JSON payload contract, shared by both harness inspectors: a router
 * result carries routing decisions only. It must never echo a `request`
 * field, the sentinel request bytes, or the 32-hex request token — those may
 * appear only in the write/patch event that proves the spool file and in the
 * route command itself, never in the router result (and therefore never in a
 * diagnostic or report). Returns a fixed structural reason, or `null`.
 */
function routeOutputPayloadViolation(routeOutput, { request = null, token = null } = {}) {
  if (isPlainObject(routeOutput) && Object.hasOwn(routeOutput, "request")) {
    return "route output carried a request field";
  }
  const serialized = JSON.stringify(routeOutput) ?? "";
  if (typeof request === "string" && request !== "" && serialized.includes(request)) {
    return "route output carried the request bytes";
  }
  if (typeof token === "string" && /^[0-9a-f]{32}$/.test(token) && serialized.includes(token)) {
    return "route output carried the request token";
  }
  return null;
}

/**
 * Structural assertions over one OpenCode run. Returns
 * `{ sessionCount, chain, outcome, skillId }` or throws CaseAssertionError.
 */
export function inspectOpenCodeRun(output, { scenario, request = null, projectPath = PROJECT_DIR } = {}) {
  if (!SCENARIOS.has(scenario) || scenario === "control") {
    throw caseError("args", `opencode cases support select/none scenarios, not "${String(scenario)}"`);
  }
  const events = parseOpenCodeStdout(output).map(normalizeOpenCodeEvent).filter(Boolean);
  const summary = () => summarizeOpenCodeEvents(events);
  const sessions = new Set(events.map((event) => event.session).filter(Boolean));
  if (sessions.size !== 1) {
    throw caseError("stream", `event stream reported ${sessions.size} distinct sessions (expected exactly 1)`, summary(), sessions.size);
  }

  // Shell-safe transport: no shell/bash command may ever reference a request
  // spool (stable or retired legacy; relative, absolute, ./-prefixed, quoted,
  // or backslash-separated); only the write tool may create the file (below).
  for (const event of events) {
    if (isToolEvent(event) && typeof event.input?.command === "string" && referencesRequestDirectory(event.input.command)) {
      throw caseError("inspect", "shell command attempted to write the request file", summary(), sessions.size);
    }
  }

  const routerLoad = skillLoad(events, ROUTER_SKILL_ID);
  if (!routerLoad) {
    const failed = events.some((event) => isSkillTool(event) && skillInput(event) === ROUTER_SKILL_ID && event.status === "error");
    throw caseError(
      "inspect",
      failed ? "router skill load failed" : "router skill was never loaded",
      summary(),
      sessions.size,
    );
  }
  const chain = ["router-skill-loaded"];

  // Exactly one *managed* route invocation after the router load. Commands
  // that only look like a route attempt are skipped when an exact one exists;
  // with no exact one they are diagnosed structurally (never echoed).
  const routeMatches = [];
  const routeLookalikes = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!isToolEvent(event) || !event.input) continue;
    const command = event.input.command;
    if (typeof command !== "string") continue;
    const parsed = parseManagedRouteCommand(command);
    if (parsed.ok) {
      routeMatches.push({ index, event, parsed });
      continue;
    }
    if (looksLikeRouteCommand(command)) routeLookalikes.push({ index, event, command });
  }
  if (routeMatches.length === 0) {
    const lookalike = routeLookalikes[0];
    if (lookalike) {
      // Diagnose in order of *specificity*, never echoing the command/token.
      if (!REQUEST_TOKEN_RE.test(lookalike.command)) {
        throw caseError("inspect", "route command did not use a 32-hex --request-token", summary(), sessions.size);
      }
      if (request && normalizeForCompare(lookalike.command).includes(normalizeForCompare(request))) {
        throw caseError("inspect", "route command interpolated the request text (unsafe shell transport)", summary(), sessions.size);
      }
      throw caseError("inspect", "route command was not the exact managed invocation", summary(), sessions.size);
    }
    throw caseError("inspect", "no route invocation followed the router skill load", summary(), sessions.size);
  }
  if (routeMatches.length > 1) {
    throw caseError("inspect", "multiple managed route invocations detected", summary(), sessions.size);
  }
  const routeEntry = routeMatches[0];
  const routeIndex = routeEntry.index;
  if (routeIndex <= routerLoad.index) {
    throw caseError("inspect", "no route invocation followed the router skill load", summary(), sessions.size);
  }
  const routeEvent = routeEntry.event;
  if (routeEvent.status === "error") throw caseError("inspect", "route command failed", summary(), sessions.size);
  if (routeEvent.status !== "completed") {
    throw caseError("inspect", `route command did not complete (status ${String(routeEvent.status)})`, summary(), sessions.size);
  }
  // v2 shell can settle `completed` with a nonzero exit; the nested metadata
  // block, when present, must carry an exit of exactly 0. Legacy events without
  // that block (v1 fixtures) keep their previous contract.
  if (routeEvent.hasMeta && routeEvent.exit === null) {
    throw caseError("inspect", "route command exit status was missing from its metadata", summary(), sessions.size);
  }
  if (routeEvent.exit !== null && routeEvent.exit !== 0) {
    throw caseError("inspect", "route command reported a non-zero exit status", summary(), sessions.size);
  }
  const command = routeEntry.event.input.command;
  const routeToken = routeEntry.parsed.token;

  // Request-file proof (v1 and v2): a *completed* filesystem `write` event or
  // a structurally valid `patch` event must create/update exactly the stable
  // project spool file `<project>/.skill-router-requests/<token>.txt` (the
  // token carried by the managed route invocation) with the exact request
  // bytes, after the router load and before the route invocation. Read-only
  // observations may reference the path but never prove a write; any other
  // mutating tool that targets a spool is rejected, and a patch that targets a
  // spool without a valid proof — including one aimed at the retired legacy
  // directory — fails structurally.
  const expectedPath = path.posix.normalize(`${projectPath}/${REQUEST_DIR}${routeToken}.txt`);
  const candidates = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!isToolEvent(event) || !event.input) continue;
    if (REQUEST_PATCH_TOOLS.has(event.tool)) {
      const proof = patchRequestProof(event.input, expectedPath);
      if (proof.targetsRequest) {
        candidates.push({
          index,
          event,
          tool: event.tool,
          proof,
          target: proof.path ?? null,
          content: proof.content ?? null,
        });
      }
      continue;
    }
    const target = requestPathOf(event.input);
    if (target) candidates.push({ index, event, tool: event.tool, proof: null, target, content: event.input.content });
  }

  const writers = [];
  for (const candidate of candidates) {
    // Observations (read/grep/glob/list) reference the path but never satisfy
    // the write proof, no matter when they occur.
    if (REQUEST_READ_ONLY_TOOLS.has(candidate.tool)) continue;
    if (candidate.tool === REQUEST_WRITE_TOOL) {
      writers.push(candidate);
      continue;
    }
    if (REQUEST_PATCH_TOOLS.has(candidate.tool)) {
      if (candidate.proof?.ok) {
        writers.push(candidate);
        continue;
      }
      const reason = candidate.proof?.reason ?? "patch was rejected";
      throw caseError("inspect", `request file was targeted by an invalid patch (${reason})`, summary(), sessions.size);
    }
    const tool = boundedTool(candidate.tool);
    throw caseError(
      "inspect",
      `request file was written by tool "${tool ?? "unknown"}" instead of a filesystem write/patch tool`,
      summary(),
      sessions.size,
    );
  }
  if (writers.length === 0) throw caseError("inspect", "request file was never written", summary(), sessions.size);
  if (writers.length > 1) {
    const tools = [...new Set(writers.map((entry) => boundedTool(entry.tool) ?? "unknown"))].join(", ");
    throw caseError("inspect", `request file had multiple writers (${tools})`, summary(), sessions.size);
  }
  const write = writers[0];
  if (write.index <= routerLoad.index) {
    throw caseError("inspect", "request file write occurred before the router skill load", summary(), sessions.size);
  }
  if (write.index >= routeIndex) {
    throw caseError("inspect", "request file write occurred after the route invocation", summary(), sessions.size);
  }
  if (write.event.status !== "completed") {
    throw caseError("inspect", `request file write did not complete (status ${String(write.event.status)})`, summary(), sessions.size);
  }
  const normalizedTarget = path.posix.normalize(write.target.replaceAll("\\", "/"));
  const expectedDir = path.posix.dirname(expectedPath);
  if (path.posix.dirname(normalizedTarget) !== expectedDir) {
    // A retired-legacy spool target is called out structurally; it is never
    // accepted as proof, whatever tool produced it.
    if (mentionsLegacyRequestSpool(normalizedTarget)) {
      throw caseError("inspect", "request file path targeted the retired requests directory", summary(), sessions.size);
    }
    throw caseError("inspect", "request file path was not the exact project-local requests path", summary(), sessions.size);
  }
  const writeToken = path.posix.basename(normalizedTarget).replace(/\.txt$/, "");
  if (!/^[0-9a-f]{32}$/.test(writeToken)) {
    throw caseError("inspect", "request file path was not the exact project-local requests path", summary(), sessions.size);
  }
  if (writeToken !== routeToken) {
    throw caseError("inspect", "written request token did not match the route command token", summary(), sessions.size);
  }
  // `write` carries the input content; a valid `patch` carries the content it
  // proves (the pinned patch tool appends one newline when writing an added
  // file, so a single trailing newline is tolerated for patch only).
  const content = write.content;
  const allowed = write.tool === REQUEST_WRITE_TOOL ? [request] : [request, `${request}\n`];
  if (typeof content !== "string" || (request ? !allowed.includes(content) : content.length === 0)) {
    throw caseError("inspect", "request file content did not match the exact request bytes", summary(), sessions.size);
  }

  if (request && normalizeForCompare(command).includes(normalizeForCompare(request))) {
    throw caseError("inspect", "route command interpolated the request text (unsafe shell transport)", summary(), sessions.size);
  }
  chain.push("request-token-written", "route-invoked");

  // Documented route-output extraction: canonical `state.output` first, else
  // exactly one documented text item in the nested content array. Any failure
  // carries a bounded, schema-only diagnostic (types/lengths only).
  const extracted = extractRouteOutput(routeEvent);
  if (!extracted.ok) {
    const failure = caseError(
      "parse",
      ROUTE_OUTPUT_FAILURES[extracted.reason] ?? ROUTE_OUTPUT_FAILURES.absent,
      summary(),
      sessions.size,
    );
    failure.diagnostic = routeOutputDiagnostic(events);
    throw failure;
  }
  const routeOutput = extracted.value;
  if (typeof routeOutput.outcome !== "string") {
    const failure = caseError("parse", "route command produced no router JSON result", summary(), sessions.size);
    failure.diagnostic = routeOutputDiagnostic(events);
    throw failure;
  }
  if (routeOutput.command !== undefined && routeOutput.command !== "route") {
    const failure = caseError("parse", "route output declared an unexpected command", summary(), sessions.size);
    failure.diagnostic = routeOutputDiagnostic(events);
    throw failure;
  }
  // The router result never echoes the request it routed: no `request` field,
  // no sentinel request bytes, and no request token beyond the write event and
  // the route command themselves.
  const payloadViolation = routeOutputPayloadViolation(routeOutput, { request, token: routeToken });
  if (payloadViolation) {
    const failure = caseError("parse", payloadViolation, summary(), sessions.size);
    failure.diagnostic = routeOutputDiagnostic(events);
    throw failure;
  }
  const skillId = typeof routeOutput.skillId === "string" ? routeOutput.skillId : null;
  if (scenario === "select") {
    if (routeOutput.outcome !== "select" || skillId !== RELEASE_SKILL_ID) {
      throw caseError(
        "inspect",
        `route returned outcome=${routeOutput.outcome} skillId=${String(skillId)} (expected select/release)`,
        summary(),
        sessions.size,
      );
    }
  } else if (routeOutput.outcome !== "none") {
    throw caseError("inspect", `route returned outcome=${routeOutput.outcome} (expected none)`, summary(), sessions.size);
  }
  chain.push("route-result");

  const texts = events
    .map((event, index) => ({ event, index }))
    .filter((entry) => typeof entry.event.text === "string" && entry.event.text.trim() !== "");

  if (scenario === "select") {
    const releaseLoad = skillLoad(events, RELEASE_SKILL_ID, routeIndex);
    if (!releaseLoad) {
      throw caseError("inspect", "selected release skill was never loaded after the route result", summary(), sessions.size);
    }
    chain.push("release-skill-loaded");
    const finalText = texts.at(-1);
    if (!finalText) throw caseError("inspect", "harness produced no final assistant text", summary(), sessions.size);
    if (!finalText.event.text.includes(RELEASE_MARKER)) {
      throw caseError("inspect", "final response omitted the hidden marker", summary(), sessions.size);
    }
    if (finalText.index <= releaseLoad.index) {
      throw caseError("inspect", "marker surfaced before the selected skill loaded", summary(), sessions.size);
    }
    chain.push("marker-emitted");
    return { sessionCount: sessions.size, chain, outcome: "select", skillId: RELEASE_SKILL_ID };
  }

  if (skillLoad(events, RELEASE_SKILL_ID)) {
    throw caseError("inspect", "release skill was loaded in a none scenario", summary(), sessions.size);
  }
  if (texts.some((entry) => entry.event.text.includes(RELEASE_MARKER))) {
    throw caseError("inspect", "none scenario surfaced the hidden marker", summary(), sessions.size);
  }
  chain.push("abstained");
  return { sessionCount: sessions.size, chain, outcome: "none", skillId: null };
}

/* -------------------------------- Claude parsing ---------------------------- */

/** Parse Claude stream-json stdout into events. */
export function parseClaudeStdout(output) {
  const trimmed = String(output ?? "").trim();
  if (!trimmed) throw caseError("stream", "claude produced no stream events");
  const events = [];
  const lines = trimmed.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw caseError("stream", `claude stream line ${index + 1} was not valid JSON`);
    }
    if (!parsed || typeof parsed !== "object") {
      throw caseError("stream", `claude stream line ${index + 1} was not an object`);
    }
    events.push(parsed);
  }
  if (events.length === 0) throw caseError("stream", "claude produced no stream events");
  return events;
}

function contentBlocks(event, type) {
  if (event?.type !== type || !Array.isArray(event.message?.content)) return [];
  return event.message.content.filter((block) => block && typeof block === "object");
}

function claudeToolUses(events) {
  const uses = [];
  events.forEach((event, index) => {
    for (const block of contentBlocks(event, "assistant")) {
      if (block.type === "tool_use") uses.push({ index, id: block.id, name: block.name, input: block.input });
    }
  });
  return uses;
}

function claudeToolResults(events) {
  const results = new Map();
  events.forEach((event, index) => {
    for (const block of contentBlocks(event, "user")) {
      if (block.type !== "tool_result") continue;
      const content = block.content;
      const text = typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "")).join("")
          : "";
      results.set(block.tool_use_id, { index, isError: block.is_error === true, text });
    }
  });
  return results;
}

function claudeAssistantTexts(events) {
  const texts = [];
  events.forEach((event, index) => {
    for (const block of contentBlocks(event, "assistant")) {
      if (block.type === "text" && typeof block.text === "string") texts.push({ index, text: block.text });
    }
  });
  return texts;
}

function claudeSkillName(input) {
  if (!input || typeof input !== "object") return null;
  const first = Object.values(input).find((value) => typeof value === "string" && value.trim());
  return first ? first.trim().replace(/^\/+/, "").split(/\s+/)[0] : null;
}

function claudeSkillsInventory(init) {
  const lists = {};
  for (const [key, value] of Object.entries(init)) {
    if (key !== "slash_commands" && !/^skill/i.test(key)) continue;
    if (Array.isArray(value)) {
      lists[key] = value
        .map((entry) => (typeof entry === "string" ? entry.replace(/^\/+/, "").trim() : typeof entry?.name === "string" ? entry.name : ""))
        .filter(Boolean);
    } else if (value && typeof value === "object") {
      lists[key] = Object.keys(value).map((entry) => entry.replace(/^\/+/, ""));
    }
  }
  return lists;
}

function successfulClaudeSkillUse(uses, results, skillId, afterIndex) {
  return (
    uses.find(
      (use) => use.index > afterIndex && use.name === "Skill" && claudeSkillName(use.input) === skillId && results.get(use.id) && results.get(use.id).isError !== true,
    ) ?? null
  );
}

/** Sanitized structural summary of Claude stream events (failure text). */
export function summarizeClaudeEvents(events, limit = 25) {
  const summary = [];
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (event.type === "system") summary.push({ kind: boundedKind(`system:${String(event.subtype ?? "unknown")}`) });
    else if (event.type === "result") summary.push({ kind: "result" });
    else if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "tool_use") {
          const entry = { kind: "tool_use", tool: boundedTool(block.name) };
          const name = block.name === "Skill" ? boundedName(claudeSkillName(block.input)) : undefined;
          if (name) entry.name = name;
          summary.push(entry);
        } else if (block.type === "text") summary.push({ kind: "text" });
        else summary.push({ kind: boundedKind(block.type) });
      }
    } else if (event.type) {
      summary.push({ kind: boundedKind(event.type) });
    }
    if (summary.length >= limit) break;
  }
  return summary;
}

/* -------------------------- Claude init + name policy ---------------------- */

/** Whether a reported init state value counts as "empty". */
function isEmptyReportedState(value) {
  if (value === null || value === undefined || value === false || value === 0) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/** Exact `{name,path}` tuples carried by the pinned init `plugins` array. */
function pluginStateEntries(value) {
  if (!Array.isArray(value)) return null;
  const entries = value.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.name !== "string" || typeof entry.path !== "string") return null;
    return { name: entry.name.trim(), path: entry.path.trim().replaceAll("\\", "/").replace(/\/+$/, "") };
  });
  return entries.every((entry) => entry && entry.name && entry.path) ? entries : null;
}

/** Reported failure fields on one plugin entry. */
const PLUGIN_ERROR_KEYS = Object.freeze(["error", "errors"]);
/** Origin markers of a plugin that did not come from this run's inline
 * `--plugin-dir` (the only plugin source the argv ever provides). */
const PLUGIN_ORIGIN_KEYS = Object.freeze(["marketplace", "registry", "remote", "url"]);

/** Structural problem class for a reported plugin state: ok/malformed/errors/origin. */
function pluginStateProblem(value) {
  const normalized = pluginStateEntries(value);
  if (normalized === null) return "malformed";
  const entries = value;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    for (const key of PLUGIN_ERROR_KEYS) if (!isEmptyReportedState(entry[key])) return "errors";
    for (const key of PLUGIN_ORIGIN_KEYS) if (!isEmptyReportedState(entry[key])) return "origin";
  }
  return "ok";
}

/**
 * Hardened `system/init` contract, applied to every Claude run:
 *
 *   - the model-callable tool set is exactly `Skill`, `Write`, `Bash`. The
 *     fixtures pin exactly those three, so `CLAUDE_INIT_TOOL_EXTRAS` is empty;
 *     a known unavoidable pinned extra would be documented there instead of
 *     widening this assertion;
 *   - no `mcp__*` tool is exposed and no inventory entry is `mcp__*`;
 *     `mcp_servers` is reported and empty (the pinned init reports it) and no
 *     other mcp-shaped key carries state;
 *   - plugin state, *when reported*, names only the expected inline plugin:
 *     the two pinned `builtin` plugins plus the production plugin namespace at
 *     the exact generated plugin directory for routed cases, carries no
 *     errors, and declares no non-inline origin. The
 *     `plugins` key itself is advisory when absent: inventory omission is
 *     tolerated because the pinned init has already omitted the plugin
 *     skill inventory (it did so for the previous `--add-dir` layout too), while any
 *     reported content is held to the exact expected set.
 *
 * Throws CaseAssertionError; returns true when the contract holds.
 */
export function assertClaudeInitContract(init, { scenario, summary = () => [], sessionCount = null } = {}) {
  if (!SCENARIOS.has(scenario)) {
    throw caseError("args", `claude scenarios are control/select/none, not "${String(scenario)}"`);
  }
  if (!init || typeof init !== "object") {
    throw caseError("harness", "system/init event was not an object", summary(), sessionCount);
  }

  const tools = new Set(
    (Array.isArray(init.tools) ? init.tools : [])
      .map((entry) => (typeof entry === "string" ? entry : entry && typeof entry.name === "string" ? entry.name : null))
      .filter(Boolean),
  );
  if ([...tools].some((name) => name.startsWith("mcp__"))) {
    throw caseError("harness", "system/init exposed an MCP tool", summary(), sessionCount);
  }
  const expectedTools = [...CLAUDE_INIT_TOOLS, ...CLAUDE_INIT_TOOL_EXTRAS].sort();
  const missingTools = expectedTools.filter((name) => !tools.has(name));
  if (missingTools.length > 0) {
    throw caseError("harness", `system/init tools missing ${missingTools.join(", ")}`, summary(), sessionCount);
  }
  const unexpectedTools = [...tools].filter((name) => !expectedTools.includes(name)).sort();
  if (unexpectedTools.length > 0) {
    throw caseError("harness", `system/init exposed unexpected tool(s): ${unexpectedTools.join(", ")}`, summary(), sessionCount);
  }

  const mcpKeys = Object.keys(init).filter((key) => /mcp/i.test(key));
  if (!mcpKeys.includes("mcp_servers")) {
    throw caseError("harness", "system/init did not report mcp_servers", summary(), sessionCount);
  }
  for (const key of mcpKeys) {
    if (!isEmptyReportedState(init[key])) {
      throw caseError("harness", `system/init reported MCP state under "${key}"`, summary(), sessionCount);
    }
  }
  for (const [key, value] of Object.entries(init)) {
    const inventoryNames = (Array.isArray(value)
      ? value.map((entry) => (typeof entry === "string" ? entry : entry && typeof entry.name === "string" ? entry.name : ""))
      : value && typeof value === "object"
        ? Object.keys(value)
        : []
    ).map((name) => String(name).replace(/^\/+/, ""));
    if (inventoryNames.some((name) => name.startsWith("mcp__"))) {
      throw caseError("harness", `system/init reported an MCP tool inventory under "${key}"`, summary(), sessionCount);
    }
  }

  const pluginKeys = Object.keys(init).filter((key) => /plugin/i.test(key));
  if (pluginKeys.length > 0) {
    const expectedPlugins = [
      ...CLAUDE_BUILTIN_PLUGINS,
      ...(scenario === "control" ? [] : [{ name: PLUGIN_NAME, path: PLUGIN_DIR }]),
    ];
    for (const key of pluginKeys) {
      if (key !== "plugins") {
        if (!isEmptyReportedState(init[key])) {
          throw caseError("harness", `system/init reported plugin state under "${key}"`, summary(), sessionCount);
        }
        continue;
      }
      const problem = pluginStateProblem(init[key]);
      if (problem === "malformed") throw caseError("harness", "system/init plugin state was malformed", summary(), sessionCount);
      if (problem === "errors") throw caseError("harness", "system/init reported plugin errors", summary(), sessionCount);
      if (problem === "origin") throw caseError("harness", "system/init reported a non-inline plugin origin", summary(), sessionCount);
      const entries = pluginStateEntries(init[key]);
      const actual = entries.map(({ name, path: pluginPath }) => `${name}\0${pluginPath}`).sort();
      const expected = expectedPlugins.map(({ name, path: pluginPath }) => `${name}\0${pluginPath}`).sort();
      if (actual.some((entry) => !expected.includes(entry))) {
        throw caseError("harness", "system/init reported an unexpected plugin", summary(), sessionCount);
      }
      if (expected.some((entry) => !actual.includes(entry))) {
        throw caseError("harness", "system/init did not report the expected inline plugin", summary(), sessionCount);
      }
    }
  }
  return true;
}

/**
 * Every Skill tool use must name a canonical, scenario-allowed Skill ID:
 *
 *   - only `<plugin>:skill-router` (all scenarios) and `<plugin>:release`
 *     (select only), under the production plugin namespace, are allowed;
 *   - bare aliases (`skill-router`, `release`) are rejected as soon as they
 *     succeed — a bare name can only come from a surface the case did not
 *     provision — while a failed bare attempt is tolerated because it proves
 *     nothing and cannot satisfy any required chain step;
 *   - any other skill name (an unexpected plugin skill name, a foreign plugin,
 *     or a builtin) fails closed.
 */
function assertCanonicalSkillUses({ uses, results, scenario, summary, sessionCount }) {
  const allowed =
    scenario === "select"
      ? new Set([CLAUDE_ROUTER_SKILL_ID, CLAUDE_RELEASE_SKILL_ID])
      : new Set([CLAUDE_ROUTER_SKILL_ID]);
  for (const use of uses) {
    if (use.name !== "Skill") continue;
    const name = claudeSkillName(use.input);
    if (!name) throw caseError("inspect", "skill use carried no skill name", summary(), sessionCount);
    if (allowed.has(name)) continue;
    const outcome = results.get(use.id);
    const succeeded = Boolean(outcome) && outcome.isError !== true;
    const isRelease =
      name === RELEASE_SKILL_ID || name === CLAUDE_RELEASE_SKILL_ID || name.endsWith(`:${RELEASE_SKILL_ID}`);
    if (scenario === "control" && isRelease) {
      throw caseError("inspect", "control loaded the release skill", summary(), sessionCount);
    }
    if (scenario !== "select" && isRelease) {
      throw caseError("inspect", "release skill was loaded in a none scenario", summary(), sessionCount);
    }
    if (name === ROUTER_SKILL_ID || name === RELEASE_SKILL_ID) {
      if (succeeded) {
        throw caseError(
          "inspect",
          "a bare skill alias was loaded instead of the canonical plugin skill id",
          summary(),
          sessionCount,
        );
      }
      continue;
    }
    throw caseError("inspect", "unexpected plugin skill name/use", summary(), sessionCount);
  }
  return true;
}

/**
 * Structural assertions over one Claude run (control/select/none). Returns
 * `{ sessionCount, chain, outcome, skillId }` or throws CaseAssertionError.
 *
 * Routed runs must prove, in exact order: the canonical router Skill load, one
 * successful Write that is the exact request-token write (never a write into
 * the generated plugin), every successful Bash call being the exact managed
 * route invocation with that token, the router JSON result, then the canonical
 * release Skill load (select) or abstention (none). No `mcp__*` tool may ever
 * be reported or used. The public route output skillId stays `release`.
 */
export function inspectClaudeRun(
  output,
  { scenario, request = null, projectPath = PROJECT_DIR, pluginDir = PLUGIN_DIR } = {},
) {
  if (!SCENARIOS.has(scenario)) {
    throw caseError("args", `claude scenarios are control/select/none, not "${String(scenario)}"`);
  }
  const events = parseClaudeStdout(output);
  const summary = () => summarizeClaudeEvents(events);

  const inits = events.filter((event) => event?.type === "system" && event?.subtype === "init");
  if (inits.length !== 1) throw caseError("stream", `expected exactly one system/init event, saw ${inits.length}`, summary());
  const init = inits[0];
  const initIndex = events.indexOf(init);

  const sessions = new Set(events.map((event) => (typeof event?.session_id === "string" ? event.session_id : null)).filter(Boolean));
  if (sessions.size !== 1) {
    throw caseError("stream", `stream reported ${sessions.size} distinct sessions (expected exactly 1)`, summary(), sessions.size);
  }

  const results = events.filter((event) => event?.type === "result");
  if (results.length !== 1) throw caseError("stream", `expected exactly one result event, saw ${results.length}`, summary(), sessions.size);
  if (results[0].subtype !== "success" || results[0].is_error === true) {
    throw caseError("harness", "claude run did not finish successfully", summary(), sessions.size);
  }

  const inventory = claudeSkillsInventory(init);
  const uses = claudeToolUses(events);
  const resultsById = claudeToolResults(events);
  const texts = claudeAssistantTexts(events);

  assertClaudeInitContract(init, { scenario, summary, sessionCount: sessions.size });

  // Defensive MCP denial at the use site: no `mcp__*` tool may ever be called,
  // whatever the init inventory reported.
  if (uses.some((use) => typeof use.name === "string" && use.name.startsWith("mcp__"))) {
    throw caseError("inspect", "an MCP tool use was observed", summary(), sessions.size);
  }
  // Shell-safe transport (same rule as OpenCode): no Bash command may ever
  // reference the stable spool or the retired legacy spool — relative,
  // absolute, ./-prefixed, quoted, or backslash-separated. Only the Write tool
  // may create the file.
  for (const use of uses) {
    const command = typeof use.input?.command === "string" ? use.input.command : null;
    if (command !== null && referencesRequestDirectory(command)) {
      throw caseError("inspect", "shell command attempted to write the request file", summary(), sessions.size);
    }
  }
  assertCanonicalSkillUses({ uses, results: resultsById, scenario, summary, sessionCount: sessions.size });

  if (scenario === "control") {
    let proven = false;
    if (Object.keys(inventory).length > 0) {
      const names = Object.values(inventory).flat();
      if (names.some((name) => name === ROUTER_SKILL_ID || name === CLAUDE_ROUTER_SKILL_ID)) {
        throw caseError("inspect", "router skill was discoverable without the plugin", summary(), sessions.size);
      }
      if (names.some((name) => name === RELEASE_SKILL_ID || name === CLAUDE_RELEASE_SKILL_ID)) {
        throw caseError("inspect", "release skill was discoverable without the plugin", summary(), sessions.size);
      }
      proven = true;
    }
    const attempts = uses.filter((use) => use.name === "Skill" && claudeSkillName(use.input) === CLAUDE_ROUTER_SKILL_ID);
    for (const attempt of attempts) {
      const outcome = resultsById.get(attempt.id);
      if (!outcome) throw caseError("inspect", "router skill attempt produced no tool_result", summary(), sessions.size);
      if (outcome.isError !== true) throw caseError("inspect", "router skill loaded without the plugin", summary(), sessions.size);
      proven = true;
    }
    if (!proven) {
      throw caseError("inspect", "no structural proof that the router skill is unavailable", summary(), sessions.size);
    }
    if (texts.some((entry) => entry.text.includes(RELEASE_MARKER))) {
      throw caseError("inspect", "control surfaced the hidden marker", summary(), sessions.size);
    }
    return { sessionCount: sessions.size, chain: ["router-unavailable"], outcome: "unavailable", skillId: null };
  }

  // Claude's init inventory is not authoritative for `--plugin-dir` skills in
  // the pinned CLI (it already omitted the plugin skill under the previous
  // `--add-dir` layout). Runtime discovery is proven by the correlated
  // successful Skill tool_result below; inventory omission cannot contradict
  // that stronger evidence. Control remains fail-closed above: explicit
  // inventory presence or a Skill attempt without the plugin is rejected.
  const routerUse = successfulClaudeSkillUse(uses, resultsById, CLAUDE_ROUTER_SKILL_ID, initIndex);
  if (!routerUse) {
    throw caseError("inspect", "router skill was never loaded with a successful tool_result", summary(), sessions.size);
  }
  const chain = ["router-skill-loaded"];

  // Exactly one successful Write, and it must be the exact request-token
  // write. Any successful Write into the generated plugin is rejected outright.
  const successfulWrites = uses.filter(
    (use) => use.name === "Write" && resultsById.get(use.id) && resultsById.get(use.id).isError !== true,
  );
  const normalizedPlugin = String(pluginDir).replaceAll("\\", "/").replace(/\/+$/, "");
  for (const candidate of successfulWrites) {
    const target = typeof candidate.input?.file_path === "string" ? candidate.input.file_path.replaceAll("\\", "/") : "";
    if (target === normalizedPlugin || target.startsWith(`${normalizedPlugin}/`)) {
      throw caseError("inspect", "a successful Write targeted the generated plugin", summary(), sessions.size);
    }
  }
  if (successfulWrites.length === 0) {
    throw caseError("inspect", "request token file was not written", summary(), sessions.size);
  }
  if (successfulWrites.length > 1) {
    throw caseError("inspect", "more than one successful Write tool call was observed", summary(), sessions.size);
  }
  const writeUse = successfulWrites[0];
  if (writeUse.index <= routerUse.index) {
    throw caseError("inspect", "request file write occurred before the router skill load", summary(), sessions.size);
  }
  const writePath = typeof writeUse.input.file_path === "string" ? writeUse.input.file_path.replaceAll("\\", "/") : "";
  if (mentionsLegacyRequestSpool(writePath)) {
    // The retired legacy spool is detected and rejected structurally: it can
    // never satisfy the request-write proof.
    throw caseError("inspect", "request token file was written to the retired requests directory", summary(), sessions.size);
  }
  const pathMatch = writePath.match(REQUEST_TOKEN_FILE);
  if (!pathMatch) {
    throw caseError("inspect", "the successful Write did not target the request token file", summary(), sessions.size);
  }
  const writtenToken = pathMatch[1];
  const normalizedWrite = path.posix.normalize(writePath);
  const projectRoot = String(projectPath ?? "").replaceAll("\\", "/").replace(/\/+$/, "");
  // Exactly `<project>/.skill-router-requests/<token>.txt`: the stable spool
  // sits directly under the project root.
  if (projectRoot && path.posix.dirname(normalizedWrite) !== `${projectRoot}/${REQUEST_SPOOL_DIRNAME}`) {
    throw caseError("inspect", "request token file was written outside the project", summary(), sessions.size);
  }
  const content = writeUse.input.content;
  if (typeof content !== "string" || content.length === 0 || content.length > 100_000) {
    throw caseError("inspect", "request token file content was empty or exceeded the router request size limit", summary(), sessions.size);
  }
  // Exact request bytes, mirroring the OpenCode write contract: the written
  // payload is the safe shell-free transport, so it must be exactly the
  // request text.
  if (request && content !== request) {
    throw caseError("inspect", "request token file content did not match the exact request bytes", summary(), sessions.size);
  }
  chain.push("request-token-written");

  // Every successful Bash call must be the exact managed route invocation with
  // the written token. Failed attempts never satisfy the chain, but the
  // diagnostics below keep them structural and value-free.
  const successfulBash = uses.filter(
    (use) => use.name === "Bash" && resultsById.get(use.id) && resultsById.get(use.id).isError !== true,
  );
  for (const candidate of successfulBash) {
    const command = typeof candidate.input?.command === "string" ? candidate.input.command : null;
    if (command === null) {
      throw caseError("inspect", "a successful Bash tool call carried no command", summary(), sessions.size);
    }
    if (!looksLikeRouteCommand(command)) {
      throw caseError("inspect", "a successful Bash tool call was not the managed route invocation", summary(), sessions.size);
    }
    if (candidate.index < writeUse.index) {
      throw caseError("inspect", "route invocation preceded the request token write", summary(), sessions.size);
    }
    const tokenMatch = command.match(REQUEST_TOKEN_RE);
    if (!tokenMatch) throw caseError("inspect", "route command did not use a 32-hex --request-token", summary(), sessions.size);
    if (tokenMatch[1] !== writtenToken) {
      throw caseError("inspect", "route command token did not match the written request token", summary(), sessions.size);
    }
    if (request && normalizeForCompare(command).includes(normalizeForCompare(request))) {
      throw caseError("inspect", "route command interpolated the request text (unsafe shell transport)", summary(), sessions.size);
    }
    if (!parseManagedRouteCommand(command).ok) {
      throw caseError("inspect", "a successful Bash tool call was not the managed route invocation", summary(), sessions.size);
    }
  }

  const bashCandidates = uses.filter(
    (use) =>
      use.index > writeUse.index &&
      use.name === "Bash" &&
      typeof use.input?.command === "string" &&
      use.input.command.includes("skill-router route") &&
      use.input.command.includes("--request-token"),
  );
  if (bashCandidates.length === 0) {
    throw caseError("inspect", "route command with --request-token was never invoked", summary(), sessions.size);
  }
  let routeUse = null;
  let routeResult = null;
  let routeOutput = null;
  for (const candidate of bashCandidates) {
    const command = candidate.input.command;
    if (request && normalizeForCompare(command).includes(normalizeForCompare(request))) {
      throw caseError("inspect", "route command interpolated the request text (unsafe shell transport)", summary(), sessions.size);
    }
    const tokenMatch = command.match(REQUEST_TOKEN_RE);
    if (!tokenMatch) throw caseError("inspect", "route command did not carry a 32-hex --request-token", summary(), sessions.size);
    if (tokenMatch[1] !== writtenToken) {
      throw caseError("inspect", "route command token did not match the written request token", summary(), sessions.size);
    }
    const outcome = resultsById.get(candidate.id);
    if (!outcome || outcome.isError === true) continue;
    try {
      const parsed = JSON.parse(outcome.text);
      if (parsed && typeof parsed === "object" && typeof parsed.outcome === "string") {
        routeUse = candidate;
        routeResult = outcome;
        routeOutput = parsed;
        break;
      }
    } catch {
      // A non-JSON intermediate attempt does not satisfy the structural chain.
    }
  }
  if (!routeUse) throw caseError("inspect", "no route tool_result parsed as router JSON", summary(), sessions.size);
  chain.push("route-invoked", "route-result");
  // The router result never echoes the request it routed: no `request` field,
  // no sentinel request bytes, and no request token beyond the Write event and
  // the Bash command themselves.
  const payloadViolation = routeOutputPayloadViolation(routeOutput, { request, token: writtenToken });
  if (payloadViolation) throw caseError("parse", payloadViolation, summary(), sessions.size);

  const skillId = typeof routeOutput.skillId === "string" ? routeOutput.skillId : null;
  if (scenario === "select") {
    if (routeOutput.outcome !== "select" || skillId !== RELEASE_SKILL_ID) {
      throw caseError(
        "inspect",
        `route returned outcome=${routeOutput.outcome} skillId=${String(skillId)} (expected select/release)`,
        summary(),
        sessions.size,
      );
    }
    // The route returns the public id (`release`); Claude must load the
    // canonical namespaced Skill ID the generated plugin actually exposes.
    const releaseUse = successfulClaudeSkillUse(uses, resultsById, CLAUDE_RELEASE_SKILL_ID, routeResult.index);
    if (!releaseUse) {
      throw caseError("inspect", "selected release skill was never loaded after the route result", summary(), sessions.size);
    }
    chain.push("release-skill-loaded");
    const finalText = texts.at(-1);
    if (!finalText) throw caseError("inspect", "run produced no final assistant text", summary(), sessions.size);
    if (!finalText.text.includes(RELEASE_MARKER)) {
      throw caseError("inspect", "final response omitted the hidden marker", summary(), sessions.size);
    }
    if (finalText.index <= releaseUse.index) {
      throw caseError("inspect", "marker surfaced before the selected skill loaded", summary(), sessions.size);
    }
    chain.push("marker-emitted");
    return { sessionCount: sessions.size, chain, outcome: "select", skillId: RELEASE_SKILL_ID };
  }

  if (routeOutput.outcome !== "none") {
    throw caseError("inspect", `route returned outcome=${routeOutput.outcome} (expected none)`, summary(), sessions.size);
  }
  // Any release skill use (bare or canonical) in a none run is already a
  // structural failure in assertCanonicalSkillUses above.
  if (texts.some((entry) => entry.text.includes(RELEASE_MARKER))) {
    throw caseError("inspect", "none scenario surfaced the hidden marker", summary(), sessions.size);
  }
  chain.push("abstained");
  return { sessionCount: sessions.size, chain, outcome: "none", skillId: null };
}

/* -------------------------------- report builders --------------------------- */

export function buildSuccessReport({ options, result, containerName, artifactSha256 }) {
  return {
    ok: true,
    case: options.case,
    harness: options.harness,
    scenario: options.scenario,
    container: containerName,
    artifactSha256,
    sessionCount: result.sessionCount,
    outcome: result.outcome,
    skillId: result.skillId,
    chain: result.chain,
  };
}

export function buildFailureReport(options, error) {
  const stage = STAGES.includes(error?.stage) ? error.stage : "unknown";
  const events = Array.isArray(error?.events)
    ? error.events.slice(0, 25).map((entry) => {
        if (!entry || typeof entry !== "object") return { kind: "event" };
        const sanitized = { kind: boundedKind(entry.kind) };
        const tool = boundedTool(entry.tool);
        if (tool) sanitized.tool = tool;
        const status = boundedStatus(entry.status);
        if (status) sanitized.status = status;
        const name = boundedName(entry.name);
        if (name) sanitized.name = name;
        return sanitized;
      })
    : [];
  const diagnostic = Array.isArray(error?.diagnostic)
    ? error.diagnostic
        .slice(0, ROUTE_DIAGNOSTIC_MAX_EVENTS)
        .map((record) => sanitizeDiagnosticValue(record))
        .filter(Boolean)
    : [];
  const report = {
    ok: false,
    case: options?.case ?? "unknown",
    harness: options?.harness ?? "unknown",
    scenario: options?.scenario ?? "unknown",
    stage,
    error: sanitizeContainerText(String(error?.message ?? error)).slice(0, 400),
    events,
    sessionCount: Number.isInteger(error?.sessionCount) ? error.sessionCount : null,
  };
  if (diagnostic.length > 0) report.diagnostic = diagnostic;
  return report;
}

/**
 * Defensive re-check of a schema-only diagnostic: allowlisted field names,
 * allowlisted non-credential-shaped string tokens, numbers/booleans/null, and
 * bounded nesting only. Anything else is dropped rather than rendered.
 */
function sanitizeDiagnosticValue(value) {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!DIAGNOSTIC_NAME_RE.test(value) || DIAGNOSTIC_CREDENTIAL_KEY_RE.test(value)) return undefined;
    return sanitizeContainerText(value);
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeDiagnosticValue(entry)).filter((entry) => entry !== undefined);
  if (typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (!DIAGNOSTIC_NAME_RE.test(key)) continue;
      const cleaned = sanitizeDiagnosticValue(entry);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  return undefined;
}

/* ------------------------------ setup + execution --------------------------- */

function promptFor(harness, scenario) {
  if (harness === "claude") {
    if (scenario === "control") return { prompt: CLAUDE_CONTROL_PROMPT, request: null };
    return scenario === "select"
      ? { prompt: CLAUDE_SELECT_PROMPT, request: SELECT_REQUEST }
      : { prompt: CLAUDE_NONE_PROMPT, request: NONE_REQUEST };
  }
  return scenario === "select"
    ? { prompt: OPENCODE_SELECT_PROMPT, request: SELECT_REQUEST }
    : { prompt: OPENCODE_NONE_PROMPT, request: NONE_REQUEST };
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * In-container OpenCode model resolver (used by runOpenCode): strict
 * provider/model, never defaulted. Exported so tests exercise the exact
 * function the runner calls.
 */
export function requireOpenCodeModel(env = process.env) {
  const value = String(env[CASE_ENV.opencodeModel] ?? "").trim();
  if (!value) {
    throw caseError("env", `${CASE_ENV.opencodeModel} is required for OpenCode cases (no default billable model is chosen)`);
  }
  if (!MODEL_FORMAT_RE.test(value)) {
    throw caseError("env", `${CASE_ENV.opencodeModel} must use provider/model format`);
  }
  return value;
}

/**
 * In-container Claude model resolver (used by runClaude): the same aliases /
 * Anthropic ids the host preflight accepts, OpenCode `provider/model` syntax
 * rejected, and the value returned unchanged for `claude --model`.
 */
export function requireClaudeModel(env = process.env) {
  const value = String(env[CASE_ENV.claudeModel] ?? "").trim();
  if (!value) {
    throw caseError(
      "env",
      `${CASE_ENV.claudeModel} is required for Claude cases (alias like sonnet/opus/haiku, or an Anthropic model id); ` +
        "no default billable model is chosen",
    );
  }
  if (!CLAUDE_MODEL_FORMAT_RE.test(value)) {
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*\//.test(value)) {
      throw caseError(
        "env",
        `${CASE_ENV.claudeModel} must be a Claude Code alias (sonnet/opus/haiku) or Anthropic model id (claude-...), ` +
          "not OpenCode provider/model syntax",
      );
    }
    throw caseError(
      "env",
      `${CASE_ENV.claudeModel} must be a Claude Code alias (sonnet/opus/haiku) or an Anthropic model id (claude-...)`,
    );
  }
  return value;
}

function routerBin() {
  return ROUTER_TARGET;
}

/**
 * Verify the immutable image-layer router wrapper before any model process.
 *
 * The wrapper ships in the read-only rootfs — root-owned, mode 0555, pinned
 * bytes — because every writable tmpfs is `noexec`, and a case running as
 * uid 1000 on a `--read-only` rootfs cannot alter it. Checks are fail-closed
 * and never emit a path, content, or hash: fixed location outside
 * project/HOME/install storage, regular non-symlink file, image-root owner,
 * mode no more permissive than 0555 and usable by the runtime user, and a
 * sha256 equal to the pinned digest of the staged source. `io`/`target` are
 * injectable so drift is testable without a container.
 */
export function verifyImmutableRouterWrapper({
  io = null,
  target = ROUTER_WRAPPER_PATH,
  expectedSha256 = ROUTER_WRAPPER_SHA256,
  forbiddenRoots = ROUTER_WRAPPER_FORBIDDEN_ROOTS,
} = {}) {
  for (const root of forbiddenRoots) {
    if (target === root || target.startsWith(`${root}/`)) {
      throw caseError("router", "router wrapper path must stay outside project/HOME/fixtures/install storage");
    }
  }
  const lstat = io?.lstatSync ?? lstatSync;
  const read = io?.readFileSync ?? readFileSync;
  let stat;
  try {
    stat = lstat(target);
  } catch {
    throw caseError("router", "router wrapper is missing (image layer)");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw caseError("router", "router wrapper must be a regular non-symlink file");
  }
  if (stat.uid !== 0) throw caseError("router", "router wrapper is not owned by the image root user");
  const mode = stat.mode & 0o7777;
  if (mode & ~0o555) throw caseError("router", "router wrapper is more permissive than 0555");
  if ((mode & 0o005) !== 0o005) throw caseError("router", "router wrapper is not usable by the runtime user");

  let bytes;
  try {
    bytes = read(target);
  } catch {
    throw caseError("router", "router wrapper could not be read");
  }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes));
  const actual = createHash("sha256").update(buffer).digest("hex");
  if (actual !== expectedSha256) throw caseError("router", "router wrapper does not match the pinned image source");
  return true;
}

/**
 * Child environment PATH: prepends the wrapper directory **exactly once** and
 * preserves the incoming PATH after it, while stripping any direct reference to
 * the non-executable package `.bin`. Pure and deterministic: every caller
 * (router env, OpenCode, Claude, status-only preflight) derives the same PATH
 * from the same incoming environment.
 */
export function withWrapperPath(baseEnv = process.env) {
  const incoming = String(baseEnv?.PATH ?? "");
  const packageBin = path.dirname(ROUTER_TARGET);
  const rest = incoming
    .split(path.delimiter)
    .filter((entry) => entry !== "" && entry !== ROUTER_WRAPPER_DIR && entry !== packageBin);
  return { ...baseEnv, PATH: [ROUTER_WRAPPER_DIR, ...rest].join(path.delimiter) };
}

/**
 * Status-only executable preflight, run before any model process with the very
 * same wrapper-PATH environment the model children will receive: spawns the
 * bare `skill-router --version` (deterministic, non-mutating) with
 * `cwd = PROJECT_DIR`, requires a successful spawn and an exit status of
 * exactly 0, and **discards** stdout/stderr — no value, output, or version
 * string is ever reported. Inject `run` for tests (no model call).
 */
export function preflightRouterExecutable({ env = process.env, run = spawnSync } = {}) {
  const childEnv = withWrapperPath(env);
  let result;
  try {
    result = run("skill-router", ["--version"], {
      cwd: PROJECT_DIR,
      env: childEnv,
      encoding: "utf8",
      timeout: ROUTER_PREFLIGHT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
  } catch (error) {
    throw caseError("env", `skill-router executable preflight failed to start (${error?.code ?? "spawn error"})`);
  }
  if (result?.error) {
    throw caseError("env", `skill-router executable preflight failed to start (${result.error.code ?? "spawn error"})`);
  }
  if (!Number.isInteger(result?.status)) {
    throw caseError("env", "skill-router executable preflight did not report an exit status");
  }
  if (result.status !== 0) {
    throw caseError("env", `skill-router executable preflight exited with status ${String(result.status)}`);
  }
  // stdout/stderr intentionally discarded: only the exit status is asserted.
  return childEnv;
}

/** Router child env: same wrapper PATH as the model children. */
function routerEnv(extra = {}) {
  return withWrapperPath({
    ...process.env,
    PWD: PROJECT_DIR,
    SKILL_ROUTER_HOME: process.env.HOME ?? "/home/node",
    ...extra,
  });
}

function runRouter(args, options = {}) {
  const { timeout = 120_000, cwd = PROJECT_DIR, env = null } = options ?? {};
  const result = spawnSync(process.execPath, [routerBin(), ...args], {
    cwd,
    env: env ?? routerEnv(),
    encoding: "utf8",
    timeout,
    maxBuffer: MAX_BUFFER,
  });
  if (result.error) {
    throw caseError("router", `skill-router ${args[0]} failed to start (${result.error.code ?? "spawn error"})`);
  }
  if (result.status !== 0) {
    throw caseError("router", `skill-router ${args[0]} exited with status ${String(result.status)}`);
  }
  return String(result.stdout ?? "");
}

function routerJson(args, options) {
  const separator = args.indexOf("--");
  const withJson = separator === -1 ? [...args, "--json"] : [...args.slice(0, separator), "--json", ...args.slice(separator)];
  const stdout = runRouter(withJson, options);
  try {
    return JSON.parse(stdout);
  } catch {
    throw caseError("router", `skill-router ${args[0]} returned no JSON`);
  }
}

function writeReleaseFixture() {
  const target = path.join(FIXTURES_DIR, RELEASE_SKILL_ID);
  mkdirSync(target, { recursive: true });
  writeFileSync(
    path.join(target, "SKILL.md"),
    `---\nname: Release\ndescription: Prepare notes and publish releases\n---\n\n# Release\n\nWhen loaded, return ${RELEASE_MARKER}.\n`,
  );
  writeFileSync(path.join(PROJECT_DIR, ".skill-router.json"), `${JSON.stringify({ schemaVersion: 1, sources: [FIXTURES_DIR] }, null, 2)}\n`);
}

/**
 * Environment for Claude registration during router init/check. The adapter
 * runs every project/local command with `cwd=context.root`, so `--scope local`
 * writes `<root>/.claude/settings.local.json` (project-owned, asserted
 * separately); the CLI cache lives under `CLAUDE_CONFIG_DIR` in the container
 * `/tmp` and never in the container HOME. The model run therefore keeps a
 * fresh, empty config root, `--restricted` drops the project/local settings
 * file, and the only plugin surface it can observe is `--plugin-dir`.
 */
export function claudeRegistrationOptions() {
  mkdirSync(CLAUDE_REGISTER_CONFIG_DIR, { recursive: true });
  return {
    // The router process runs in the router root (the adapter passes that same
    // root as cwd to every Claude command), so `--scope local` registration
    // lands in this project's own `.claude/settings.local.json`; only the
    // Claude cache/config root is redirected to the scratch directory.
    env: routerEnv({
      CLAUDE_CONFIG_DIR: CLAUDE_REGISTER_CONFIG_DIR,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_ERROR_REPORTING: "1",
      DISABLE_BUG_COMMAND: "1",
    }),
  };
}

/** Harness id → the explicit `--harness` value the packaged CLI must receive. */
export function routerHarnessFlag(harness) {
  return harness === "claude" ? "claude" : "opencode";
}

function assertRouterInstall({ harness }) {
  const registration = harness === "claude" ? claudeRegistrationOptions() : null;
  const init = routerJson(["init", "--root", PROJECT_DIR, "--harness", routerHarnessFlag(harness)], registration);
  if (init.skillCount !== 1) {
    throw caseError("router", `init registered ${String(init.skillCount)} skill(s); expected only the release fixture`);
  }
  if (harness === "claude") {
    if (!init.claude || typeof init.claude !== "object") {
      throw caseError("router", "init did not report the generated Claude plugin");
    }
    if (init.claude.plugin !== PLUGIN_NAME || init.claude.scope !== "local") {
      throw caseError("router", "init reported an unexpected Claude plugin identity");
    }
  }
  const check = routerJson(["check", "--root", PROJECT_DIR], registration);
  if (check.healthy !== true) throw caseError("router", "skill-router check reported an unhealthy install");

  if (!existsSync(REGISTRY_FILE)) throw caseError("router", "registry.json was not generated");
  let registry;
  try {
    registry = JSON.parse(readFileSync(REGISTRY_FILE, "utf8"));
  } catch {
    throw caseError("router", "registry.json was not valid JSON");
  }
  const registrySkills = Array.isArray(registry?.skills) ? registry.skills : [];
  if (!registrySkills.some((entry) => entry?.id === RELEASE_SKILL_ID && entry.enabled !== false)) {
    throw caseError("router", "registry does not contain an enabled release skill");
  }
  if (harness === "claude") {
    // The Claude harness generates no OpenCode overlay; the production plugin
    // is verified in full instead.
    assertClaudeInstallation();
  } else {
    for (const id of [ROUTER_SKILL_ID, RELEASE_SKILL_ID]) {
      const managed = path.join(MANAGED_DIR, id, "SKILL.md");
      if (!existsSync(managed)) throw caseError("router", `managed skill file for ${id} was not generated`);
    }
  }

  const select = routerJson(["route", "--root", PROJECT_DIR, "--", SELECT_REQUEST]);
  if (select.outcome !== "select" || select.skillId !== RELEASE_SKILL_ID) {
    throw caseError("router", "router did not select the release skill for the release request");
  }
  const none = routerJson(["route", "--root", PROJECT_DIR, "--", NONE_REQUEST]);
  if (none.outcome !== "none") throw caseError("router", "router did not abstain for the unrelated request");
}

/**
 * Structural verification of the *production* Claude integration generated by
 * `skill-router init --harness claude`: router-owned installation metadata,
 * the recorded marketplace identity, the exact inert plugin layout, and the
 * presence of every enabled registry skill. This runner never generates any
 * of it — it only consumes and verifies what the packaged CLI produced.
 */
export function assertClaudeInstallation({
  installationFile = INSTALLATION_FILE,
  stateDir = CLAUDE_STATE_DIR,
  pluginDir = PLUGIN_DIR,
  registryFile = REGISTRY_FILE,
} = {}) {
  const readJson = (file, label) => {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      throw caseError("router", `${label} is missing`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw caseError("router", `${label} is not valid JSON`);
    }
  };
  const exactEntries = (root, expected, label) => {
    let names;
    try {
      names = sortedEntries(root).map((entry) => entry.name);
    } catch {
      throw caseError("plugin", `${label} is missing`);
    }
    if (JSON.stringify(names) !== JSON.stringify([...expected])) {
      throw caseError("plugin", `${label} must carry exactly ${expected.join(", ")}`);
    }
  };

  const installation = readJson(installationFile, "installation metadata");
  if (!installation || typeof installation !== "object" || Array.isArray(installation)) {
    throw caseError("router", "installation metadata is not an object");
  }
  if (installation.schemaVersion !== 1 || installation.owner !== "skill-router") {
    throw caseError("router", "installation metadata does not carry router ownership");
  }
  if (installation.scope !== "project") throw caseError("router", "installation metadata does not record the project scope");
  const stateRoot = path.resolve(path.dirname(stateDir));
  if (path.resolve(String(installation.stateDirectory ?? "")) !== stateRoot) {
    throw caseError("router", "installation metadata points at another state directory");
  }
  const harnesses = Array.isArray(installation.harnesses) ? installation.harnesses : [];
  if (harnesses.length !== 1 || harnesses[0] !== "claude") {
    throw caseError("router", `a claude case recorded ${JSON.stringify(harnesses).slice(0, 60)} as its harnesses`);
  }
  const claude = installation.claude && typeof installation.claude === "object" ? installation.claude : {};
  if (claude.scope !== "local") throw caseError("router", "Claude registration scope is not local");
  if (claude.plugin !== PLUGIN_NAME) throw caseError("router", "installation metadata carries the wrong plugin namespace");
  if (claude.marketplace !== productionClaudeMarketplaceName("project", stateRoot)) {
    throw caseError("router", "marketplace identity does not match the scoped state-path hash");
  }
  if (!/^[0-9a-f]{64}$/.test(String(claude.fingerprint ?? ""))) {
    throw caseError("router", "installation fingerprint is missing or malformed");
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(claude.version ?? ""))) {
    throw caseError("router", "installation plugin version is missing or malformed");
  }

  const marketplace = readJson(path.join(stateDir, ".claude-plugin", "marketplace.json"), "marketplace manifest");
  if (marketplace.name !== claude.marketplace) {
    throw caseError("router", "marketplace manifest name does not match the recorded identity");
  }
  const declared = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  if (declared.length !== 1) throw caseError("router", "marketplace manifest must declare exactly one plugin");
  if (declared[0].name !== PLUGIN_NAME || declared[0].source !== `./plugins/${PLUGIN_NAME}`) {
    throw caseError("router", "marketplace manifest does not declare the production plugin reference");
  }
  if (declared[0].version !== claude.version) {
    throw caseError("router", "marketplace manifest version does not match installation metadata");
  }

  exactEntries(pluginDir, PLUGIN_ROOT_ENTRIES, "plugin root");
  exactEntries(path.join(pluginDir, ".claude-plugin"), PLUGIN_MANIFEST_ENTRIES, "plugin .claude-plugin");
  const plugin = readJson(path.join(pluginDir, ".claude-plugin", "plugin.json"), "plugin manifest");
  if (JSON.stringify(Object.keys(plugin).sort()) !== JSON.stringify([...PLUGIN_MANIFEST_KEYS].sort())) {
    throw caseError("plugin", `plugin manifest must carry inert metadata only (${PLUGIN_MANIFEST_KEYS.join(", ")})`);
  }
  if (plugin.name !== PLUGIN_NAME) throw caseError("plugin", "plugin manifest carries the wrong namespace");
  if (plugin.version !== claude.version) throw caseError("plugin", "plugin manifest version does not match installation metadata");

  const registry = readJson(registryFile, "registry");
  const enabled = (Array.isArray(registry?.skills) ? registry.skills : [])
    .filter((entry) => entry?.enabled !== false)
    .map((entry) => String(entry.id));
  for (const id of [...enabled].sort()) {
    if (!existsSync(path.join(pluginDir, "skills", id, "SKILL.md"))) {
      throw caseError("plugin", `generated plugin is missing skill ${id}`);
    }
  }
  if (!existsSync(path.join(pluginDir, "skills", ROUTER_SKILL_ID, "SKILL.md"))) {
    throw caseError("plugin", "generated plugin is missing the router skill");
  }
  // Whole-tree regularity: no symlink or special file anywhere under the
  // generated plugin (this also fails when the tree cannot be read at all).
  pluginTreeManifest(pluginDir);
  return {
    pluginDir,
    marketplace: claude.marketplace,
    version: claude.version,
    fingerprint: claude.fingerprint,
    skillCount: enabled.length,
  };
}

function assertOpenCodeConfigShape(harness) {
  if (!existsSync(OPENCODE_CONFIG_FILE)) throw caseError("config", "opencode config was not generated");
  let document;
  try {
    document = JSON.parse(readFileSync(OPENCODE_CONFIG_FILE, "utf8"));
  } catch {
    throw caseError("config", "opencode config was not valid JSON");
  }
  if (harness === "opencode-v1") {
    if (Array.isArray(document.skills)) throw caseError("config", "v1 wrote an array-shaped skills config");
    const paths = document.skills && Array.isArray(document.skills.paths) ? document.skills.paths : null;
    if (!paths) throw caseError("config", "v1 config is missing skills.paths");
    if (!paths.includes(MANAGED_DIR)) throw caseError("config", "v1 skills.paths omits the managed skills directory");
    return;
  }
  if (harness === "opencode-v2") {
    if (!Array.isArray(document.skills)) throw caseError("config", "v2 wrote a non-array skills config");
    if (!document.skills.includes(MANAGED_DIR)) throw caseError("config", "v2 skills array omits the managed skills directory");
  }
}

function sortedEntries(root) {
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
}

/** Deterministic manifest ordering (codepoint order on the relative path). */
function compareManifestEntries(a, b) {
  if (a.path === b.path) return 0;
  return a.path < b.path ? -1 : 1;
}

function sha256Bytes(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function fileDigest(file) {
  const bytes = readFileSync(file);
  return { bytes: bytes.length, sha256: sha256Bytes(bytes) };
}

function productionSourceCandidates() {
  return [
    pathToFileURL(path.join(INSTALL_PREFIX, "node_modules", "@openagency", "skill-router", "src", "installation.js")),
    new URL("../src/installation.js", import.meta.url),
  ];
}

function productionSourceAvailable() {
  return productionSourceCandidates().some((candidate) => existsSync(fileURLToPath(candidate)));
}

/**
 * Production installation module — the single source of truth for the plugin
 * namespace and the marketplace identity. Inside the container the packed
 * artifact's copy (installed in step 2) wins; host-side tests import the
 * runner from the repository checkout, whose copy is the same source that
 * ships in the artifact. Nothing else in this runner may re-declare those
 * values.
 */
async function loadProductionInstallation() {
  const candidates = productionSourceCandidates();
  let found = 0;
  let failures = 0;
  for (const candidate of candidates) {
    if (!existsSync(fileURLToPath(candidate))) continue;
    found += 1;
    try {
      return await import(candidate.href);
    } catch {
      failures += 1;
    }
  }
  throw caseError(
    "install",
    `production installation module is unavailable (${found} candidate(s) found, ${failures} load failure(s))`,
  );
}

/**
 * Resolve the production module and populate every namespace-derived export.
 * Idempotent: host-side checkouts call it during module load (so importers see
 * populated constants), while a container run defers it to `runCase()` because
 * the artifact only exists after the install step.
 */
export async function ensureProductionInstallation() {
  if (productionInstallation) return productionInstallation;
  const installation = await loadProductionInstallation();
  PLUGIN_NAME = installation.CLAUDE_PLUGINS.project;
  CLAUDE_ROUTER_SKILL_ID = `${PLUGIN_NAME}:${ROUTER_SKILL_ID}`;
  CLAUDE_RELEASE_SKILL_ID = `${PLUGIN_NAME}:${RELEASE_SKILL_ID}`;
  PLUGIN_DIR = path.join(CLAUDE_STATE_DIR, "plugins", PLUGIN_NAME);
  PLUGIN_SKILLS_DIR = path.join(PLUGIN_DIR, "skills");
  PLUGIN_MANIFEST_DIR = path.join(PLUGIN_DIR, ".claude-plugin");
  PLUGIN_MANIFEST_FILE = path.join(PLUGIN_MANIFEST_DIR, "plugin.json");
  CLAUDE_CONTROL_PROMPT =
    `Use the Skill tool to load the skill named ${CLAUDE_ROUTER_SKILL_ID}, then use it for this request: ` +
    "prepare and publish a release. If the skill cannot be loaded, report that it is unavailable and stop.";
  CLAUDE_SELECT_PROMPT =
    `Load and use the \`${CLAUDE_ROUTER_SKILL_ID}\` skill for this request: prepare and publish a release. ` +
    'Route exactly the request text "prepare and publish a release". After loading the selected skill, ' +
    "return the marker that its instructions tell you to return.";
  CLAUDE_NONE_PROMPT =
    `Load and use the \`${CLAUDE_ROUTER_SKILL_ID}\` skill for this unrelated request: calculate orbital velocity. ` +
    'Route exactly the request text "calculate orbital velocity". Report only the router outcome.';
  productionInstallation = installation;
  return installation;
}

/**
 * Deterministic full manifest of the generated plugin tree: every relative
 * path with its type, plus byte length and sha256 for files. Directories are
 * part of the manifest, so an added or removed directory is drift too. Symlinks
 * and special files anywhere in the tree (or as the root itself) are a
 * structural failure, and paths are always root-relative so nothing absolute
 * can leak into a report.
 */
export function pluginTreeManifest(root) {
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch {
    throw caseError("plugin", "generated plugin tree is missing");
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw caseError("plugin", "generated plugin tree is not a directory");
  }
  const entries = [];
  const walk = (directory, prefix) => {
    let dirents;
    try {
      dirents = sortedEntries(directory);
    } catch {
      throw caseError("plugin", "generated plugin tree is unreadable");
    }
    for (const entry of dirents) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw caseError("plugin", "generated plugin tree contains a symlink");
      if (entry.isDirectory()) {
        entries.push({ path: relative, type: "dir" });
        walk(target, relative);
        continue;
      }
      if (!entry.isFile()) throw caseError("plugin", "generated plugin tree contains a special file");
      const digest = fileDigest(target);
      entries.push({ path: relative, type: "file", bytes: digest.bytes, sha256: digest.sha256 });
    }
  };
  walk(root, "");
  entries.sort(compareManifestEntries);
  return entries;
}

/**
 * Post-run re-verification: the generated plugin manifest captured before the
 * model run must be reproduced exactly, so any mutation, addition, removal, or
 * symlink/special file introduced during the run fails the case closed.
 */
export function assertPluginTreeUnchanged(expected, root = PLUGIN_DIR) {
  if (!Array.isArray(expected)) throw caseError("plugin", "plugin manifest snapshot is missing");
  const actual = pluginTreeManifest(root);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw caseError("plugin", "plugin manifest changed during the model run");
  }
  return actual;
}

/**
 * Project-owned Claude registration surface: the adapter runs every
 * project/local command with `cwd=context.root`, so `--scope local`
 * registration lands here as exactly one regular `settings.local.json`
 * declaring the generated marketplace. The control case never initializes, so
 * the surface must be absent there.
 */
export function assertClaudeLocalRegistration({ projectDir = PROJECT_DIR, marketplace = null } = {}) {
  const directory = path.join(projectDir, ".claude");
  let names;
  try {
    names = sortedEntries(directory).map((entry) => entry.name);
  } catch {
    throw caseError("plugin", "project Claude registration directory is missing");
  }
  if (names.length !== 1 || names[0] !== "settings.local.json") {
    throw caseError(
      "plugin",
      `project .claude must carry exactly settings.local.json (found: ${names.slice(0, 6).join(", ") || "nothing"})`,
    );
  }
  const file = path.join(directory, "settings.local.json");
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw caseError("plugin", "project Claude registration file must be a regular file");
  }
  let document;
  try {
    document = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw caseError("plugin", "project Claude registration file is not valid JSON");
  }
  const declarations = document?.extraKnownMarketplaces;
  if (!declarations || typeof declarations !== "object" || Array.isArray(declarations)) {
    throw caseError("plugin", "project Claude registration carries no marketplace declaration");
  }
  if (marketplace !== null && !Object.hasOwn(declarations, marketplace)) {
    throw caseError("plugin", "project Claude registration does not declare the expected marketplace");
  }
  return file;
}

/**
 * Pre-launch absence proof for the image's managed Claude policy surface. Only
 * absence is asserted: nothing under the policy root is ever created,
 * repaired, or written by this runner.
 */
export function assertNoManagedClaudePolicy({
  root = MANAGED_POLICY_ROOT,
  entries = MANAGED_POLICY_ABSENT_ENTRIES,
  exists = existsSync,
} = {}) {
  const present = entries.filter((entry) => exists(path.join(root, entry)));
  if (present.length > 0) {
    throw caseError("config", `managed Claude policy surface is present (expected none): ${present.join(", ")}`);
  }
  return true;
}

/**
 * Pre-launch structural proof that a non-bare Claude run stays hermetic.
 *
 * Before `claude` starts, the generated project and the container HOME must
 * offer no Claude config/skill/MCP surface of its own (no project `.claude`,
 * `.claude.json`, or `.mcp.json`; no HOME `.claude.json`/`.mcp.json`), the
 * `CLAUDE_CONFIG_DIR` root must be absent or empty (fresh tmpfs), and the only
 * plugin surface may be the production plugin directory generated by
 * `skill-router init --harness claude` for routed cases — control must stay
 * uninitialized with no plugin directory and no router-owned Claude state at
 * all. Routed cases must show exactly the inert plugin layout
 * (`.claude-plugin/plugin.json` + `skills/`) with no symlink or special file
 * anywhere. Returns the verified summary or throws a structural
 * CaseAssertionError whose message names entries only.
 */
export function assertClaudeLaunchSurfaces({
  scenario,
  projectDir = PROJECT_DIR,
  homeDir = process.env.HOME ?? "/home/node",
  pluginDir = PLUGIN_DIR,
  stateDir = null,
  installation = null,
} = {}) {
  if (!SCENARIOS.has(scenario)) {
    throw caseError("args", `claude scenarios are control/select/none, not "${String(scenario)}"`);
  }
  // `<state>/claude/plugins/<plugin>` → `<state>/claude`, so a caller that
  // overrides the plugin directory still checks the matching Claude state.
  const claudeStateDir = stateDir ?? path.dirname(path.dirname(pluginDir));
  const surfaceOf = (target) => {
    if (!existsSync(target)) return { exists: false, directory: false, names: [] };
    const directory = statSync(target).isDirectory();
    return { exists: true, directory, names: directory ? sortedEntries(target).map((entry) => entry.name) : [] };
  };
  const bounded = (names) => names.slice(0, 6).join(", ");

  const violations = [];
  for (const entry of FORBIDDEN_PROJECT_CLAUDE_ENTRIES) {
    const surface = surfaceOf(path.join(projectDir, entry));
    if (entry === ".claude") {
      // Routed Claude cases own exactly one project Claude surface: the
      // `settings.local.json` that `--scope local` registration writes. It is
      // allowed only in that exact shape; control must have none, and the
      // model run is `--restricted`, which drops project/local settings.
      if (!surface.exists) continue;
      const exact =
        surface.directory &&
        JSON.stringify(surface.names) === JSON.stringify(["settings.local.json"]);
      if (scenario === "control") violations.push("project .claude");
      else if (!exact) {
        violations.push(
          `project .claude not exactly settings.local.json (${surface.directory ? bounded(surface.names) : "not a directory"})`,
        );
      }
      continue;
    }
    if (surface.exists) violations.push(`project ${entry}`);
  }
  // The router wrapper ships in the immutable image layer, so any runtime
  // `bin/` surface is unexpected: neither inside the project nor as a
  // sibling workspace directory (the generated project/plugin surfaces and the
  // fixtures directory are the only tolerated workspace content).
  if (surfaceOf(path.join(projectDir, "bin")).exists) violations.push("project bin directory");
  if (surfaceOf(path.join(path.dirname(projectDir), "bin")).exists) violations.push("workspace bin directory");
  for (const entry of FORBIDDEN_HOME_CLAUDE_ENTRIES) {
    if (surfaceOf(path.join(homeDir, entry)).exists) violations.push(`home ${entry}`);
  }
  const config = surfaceOf(path.join(homeDir, ".claude"));
  if (config.exists && (!config.directory || config.names.length > 0)) {
    violations.push(
      config.directory ? `config root not fresh (${bounded(config.names)})` : "config root is not a directory",
    );
  }
  if (violations.length) {
    throw caseError("config", `pre-launch Claude surfaces are not clean: ${violations.join("; ")}`);
  }

  if (scenario === "control") {
    // The control case never initializes the router: neither the plugin
    // directory nor router-owned Claude state may exist before launch.
    if (surfaceOf(pluginDir).exists) throw caseError("plugin", "control must not expose the plugin directory");
    if (surfaceOf(claudeStateDir).exists) throw caseError("plugin", "control must not expose router-owned Claude state");
    return { scenario, configFresh: true, plugin: false };
  }

  const plugin = surfaceOf(pluginDir);
  if (!plugin.exists || !plugin.directory || JSON.stringify(plugin.names) !== JSON.stringify([...PLUGIN_ROOT_ENTRIES])) {
    throw caseError(
      "plugin",
      `plugin root must contain exactly ${PLUGIN_ROOT_ENTRIES.join(", ")} ` +
        `(found: ${plugin.exists ? bounded(plugin.names) : "nothing"})`,
    );
  }
  const manifestSurface = surfaceOf(path.join(pluginDir, ".claude-plugin"));
  if (!manifestSurface.directory || JSON.stringify(manifestSurface.names) !== JSON.stringify([...PLUGIN_MANIFEST_ENTRIES])) {
    throw caseError(
      "plugin",
      `plugin .claude-plugin must contain exactly ${PLUGIN_MANIFEST_ENTRIES.join(", ")} ` +
        `(found: ${manifestSurface.exists ? bounded(manifestSurface.names) : "nothing"})`,
    );
  }
  const manifestPath = path.join(pluginDir, ".claude-plugin", "plugin.json");
  const manifestFile = surfaceOf(manifestPath);
  if (!manifestFile.exists || manifestFile.directory) {
    throw caseError("plugin", "plugin manifest is missing");
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw caseError("plugin", "plugin manifest is not valid JSON");
  }
  if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify([...PLUGIN_MANIFEST_KEYS].sort())) {
    throw caseError("plugin", `plugin manifest must carry inert metadata only (${PLUGIN_MANIFEST_KEYS.join(", ")})`);
  }
  if (manifest.name !== PLUGIN_NAME) throw caseError("plugin", "plugin manifest carries the wrong namespace");
  if (installation?.version && manifest.version !== installation.version) {
    throw caseError("plugin", "plugin manifest version does not match installation metadata");
  }
  const skillsSurface = surfaceOf(path.join(pluginDir, "skills"));
  if (!skillsSurface.exists || !skillsSurface.directory) {
    throw caseError("plugin", "plugin skills directory is missing");
  }
  if (!existsSync(path.join(pluginDir, "skills", ROUTER_SKILL_ID, "SKILL.md"))) {
    throw caseError("plugin", "generated plugin is missing the router skill");
  }
  // Whole-tree regularity: no symlink or special file anywhere under the
  // generated plugin (this also fails when the tree cannot be read at all).
  pluginTreeManifest(pluginDir);
  return { scenario, configFresh: true, plugin: true };
}

/* --------------------- OpenCode credential directory ------------------------ */

/** Fixed in-container credential directory mount. Mirrors the host
 * `RUNTIME.opencodeAuthDir`; host/container tests prove they agree. */
export const OPENCODE_AUTH_MOUNT = "/input/opencode-credential";
/** File names inside that fixed mount (mirror `RUNTIME.opencodeAuthLegacy` /
 * `RUNTIME.opencodeAuthImport`). */
export const OPENCODE_AUTH_LEGACY = "auth.json";
export const OPENCODE_AUTH_IMPORT = "auth-import.json";
/** Credential path under XDG_DATA_HOME (mirrors `RUNTIME.opencodeAuthData`). */
export const OPENCODE_AUTH_DATA = "opencode/auth.json";

/**
 * Normalize harness output for structural probing: strip ANSI, lowercase, and
 * collapse runs of non-alphanumerics to a single `-`, so display names such as
 * "OpenCode Go" and "OpenAI" can be matched against provider ids. The raw text
 * is never stored or echoed (it can contain host paths and account labels).
 */
export function normalizeProviderProbeText(text) {
  return String(text ?? "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** True when the probe output structurally names the provider id. */
export function providerRecognized(output, provider) {
  const id = String(provider ?? "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) return false;
  const normalized = normalizeProviderProbeText(output);
  if (!normalized) return false;
  return (
    normalized === id || normalized.startsWith(`${id}-`) || normalized.endsWith(`-${id}`) || normalized.includes(`-${id}-`)
  );
}

/** Default structural `opencode auth list` probe: status + raw text only, and
 * the raw text never leaves this function's callers (never echoed). */
function defaultAuthList({ env, args = ["auth", "list"], timeout = RUN_TIMEOUT_MS }) {
  const result = spawnSync("opencode", args, {
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: MAX_BUFFER,
  });
  return {
    error: result.error ?? null,
    status: result.status ?? null,
    output: String(result.stdout ?? ""),
  };
}

/** Default `opencode auth import <file> --standalone` probe: status only —
 * neither stdout nor stderr ever crosses the boundary. */
function defaultAuthImport({ env, file, timeout = RUN_TIMEOUT_MS }) {
  const result = spawnSync("opencode", ["auth", "import", file, "--standalone"], {
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: MAX_BUFFER,
  });
  return { error: result.error ?? null, status: result.status ?? null };
}

function assertOwnerOnlyRegularFile(target, label) {
  if (!existsSync(target)) throw caseError("auth", `${label} is missing from the container mount`);
  const stat = statSync(target);
  if (!stat.isFile()) throw caseError("auth", `${label} must be a regular file`);
  if ((stat.mode & 0o077) !== 0) throw caseError("auth", `${label} must be owner-only`);
}

/** The mounted legacy document must carry exactly one (the selected) provider. */
function assertLegacyCarriesOnly(file, provider) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw caseError("auth", "the mounted legacy credential file is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw caseError("auth", "the mounted legacy credential file is not a JSON object");
  }
  const ids = Object.keys(parsed).map((id) => id.toLowerCase()).sort();
  if (ids.length !== 1 || ids[0] !== provider) {
    throw caseError("auth", "the mounted legacy credential file must carry exactly the selected provider");
  }
}

/** The generated v2 import array must carry exactly one (the selected) provider. */
function assertImportCarriesOnly(file, provider) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw caseError("auth", "the mounted v2 credential import file is not valid JSON");
  }
  if (!Array.isArray(parsed)) throw caseError("auth", "the mounted v2 credential import file must be an array");
  const ids = [...new Set(parsed.map((entry) => String(entry?.integrationID ?? "").toLowerCase()))].sort();
  if (ids.length !== 1 || ids[0] !== provider) {
    throw caseError("auth", "the mounted v2 credential import file must carry exactly the selected provider");
  }
}

/**
 * Prepare credentials for one OpenCode run, before the harness process starts
 * (and therefore before anything else in this runner can initialize the
 * OpenCode credential database):
 *
 *   - **v1 (legacy reader)**: the fixed mount's `auth.json` must be a regular
 *     owner-only file; it is copied once into the fresh tmpfs XDG data path
 *     with mode 0600, then `opencode auth list` must name the provider.
 *   - **v2 (fresh database)**: the fixed mount's `auth-import.json` (the
 *     generated `Credential.Entry[]`) is imported with
 *     `opencode auth import <file> --standalone` (status 0 required), then
 *     `opencode auth list --standalone` must name the provider. The legacy
 *     file is deliberately *not* staged, so the only credential path is this
 *     explicit import.
 *
 * Raw stdout/stderr never crosses the boundary. Returns
 * `{ mode, provider, recognition: "listed" }`; anything less is an error.
 */
export function setupOpenCodeAuth({
  provider,
  harness = null,
  env = process.env,
  mount = OPENCODE_AUTH_MOUNT,
  listAuth = defaultAuthList,
  importAuth = defaultAuthImport,
}) {
  const normalizedProvider = String(provider ?? "").toLowerCase();
  const probeEnv = { ...env, NO_COLOR: "1" };
  let probe;

  if (harness === "opencode-v2") {
    const importFile = path.join(mount, OPENCODE_AUTH_IMPORT);
    assertOwnerOnlyRegularFile(importFile, "the mounted v2 credential import file");
    assertImportCarriesOnly(importFile, normalizedProvider);
    const imported = importAuth({ env: probeEnv, file: importFile });
    if (imported.error) {
      throw caseError("auth", `opencode auth import failed to start (${imported.error.code ?? "spawn error"})`);
    }
    if (imported.status !== 0) {
      throw caseError("auth", `opencode auth import exited with status ${String(imported.status)}`);
    }
    probe = listAuth({ env: probeEnv, args: ["auth", "list", "--standalone"] });
  } else {
    const legacyFile = path.join(mount, OPENCODE_AUTH_LEGACY);
    assertOwnerOnlyRegularFile(legacyFile, "the mounted legacy auth file");
    assertLegacyCarriesOnly(legacyFile, normalizedProvider);
    const dataHome = env.XDG_DATA_HOME;
    if (typeof dataHome !== "string" || dataHome === "") {
      throw caseError("auth", "XDG_DATA_HOME is required to stage the OpenCode credentials");
    }
    const target = path.join(dataHome, OPENCODE_AUTH_DATA);
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(legacyFile, target);
    chmodSync(target, 0o600);
    const staged = statSync(target);
    if (!staged.isFile() || (staged.mode & 0o077) !== 0) {
      throw caseError("auth", "the staged OpenCode credential file is not owner-only");
    }
    probe = listAuth({ env: probeEnv, args: ["auth", "list"] });
  }

  if (probe.error) {
    throw caseError("auth", `opencode auth list failed to start (${probe.error.code ?? "spawn error"})`);
  }
  if (probe.status !== 0) {
    throw caseError("auth", `opencode auth list exited with status ${String(probe.status)}`);
  }
  if (!providerRecognized(probe.output, normalizedProvider)) {
    throw caseError("auth", "opencode does not recognize the configured provider");
  }
  return { mode: "snapshot", provider: normalizedProvider, recognition: "listed" };
}

/**
 * Claude cases never receive the OpenCode credential mount; asserted
 * immediately before the Claude process starts (the mount is a
 * container-local path, so the check is injectable for tests).
 */
export function assertClaudeHasNoAuthMount(exists = (target) => existsSync(target)) {
  if (exists(OPENCODE_AUTH_MOUNT)) {
    throw caseError("auth", "a Claude case must not receive the OpenCode credential mount");
  }
  return true;
}

/**
 * Child environment for exactly one OpenCode invocation: the wrapper PATH (so
 * the model's own shell resolves `skill-router` through the executable
 * wrapper), the project cwd, and the pinned no-network/autoupdate guards. No
 * host PATH, host config, or host credential path is introduced.
 */
export function openCodeRunEnv(baseEnv = process.env) {
  return Object.assign(withWrapperPath(baseEnv), {
    PWD: PROJECT_DIR,
    SKILL_ROUTER_HOME: baseEnv.HOME ?? "/home/node",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  });
}

function runOpenCode({ harness, scenario, prompt }) {
  const model = requireOpenCodeModel();
  // Stage the explicit auth snapshot when mounted, and prove structurally that
  // the selected provider is recognized before the harness process starts.
  if (existsSync(OPENCODE_AUTH_MOUNT)) {
    setupOpenCodeAuth({ provider: model.split("/", 1)[0].toLowerCase(), harness });
  }
  const args = harness === "opencode-v1"
    ? ["run", "--pure", "--auto", "--format", "json", "--model", model, "--agent", "build", prompt]
    : ["run", "--standalone", "--auto", "--format", "json", "--model", model, prompt];
  const environment = openCodeRunEnv(process.env);
  const result = spawnSync("opencode", args, {
    cwd: PROJECT_DIR,
    env: environment,
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
  if (result.error) throw caseError("harness", `opencode failed to start (${result.error.code ?? "spawn error"})`);
  return { output: String(result.stdout ?? ""), status: result.status };
}

export function inspectOpenCodeProcess(result, options) {
  // Inspect first so a non-zero CLI exit yields the bounded structural reason
  // already present in its NDJSON stream. A structurally valid run must still
  // have exited zero; process failure is never accepted as success.
  const inspected = inspectOpenCodeRun(result?.output, options);
  if (result?.status !== 0) {
    throw caseError("harness", `opencode exited with status ${String(result?.status)}`);
  }
  return inspected;
}

/**
 * Exact Claude CLI argv for a case (non-bare: `--bare` is deliberately absent
 * so the `claude setup-token` credential in `CLAUDE_CODE_OAUTH_TOKEN` is
 * honoured — bare mode ignores it and would force API-key auth). `--tools` is
 * the true exposed-tool allowlist; `--allowedTools`/`--disallowedTools` remain
 * scoped permission rules; `--permission-mode dontAsk` plus
 * `--permission-prompts none` make every non-allowlisted request a
 * deterministic denial instead of a prompt; `--restricted` confines file tools
 * to the working directories (the generated plugin included), drops
 * user/project/local settings files, and refuses bypassPermissions;
 * `--strict-mcp-config` keeps
 * any MCP server from `--mcp-config` (we pass none) as the only possible MCP
 * source, and `disallowedTools` carries a defensive `mcp__*` denial for every
 * MCP tool. The production plugin directory is only exposed with
 * `--plugin-dir` for select/none — never for control.
 */
export function claudeArgv({ model, pluginDir = null }) {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--model",
    model,
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--restricted",
    "--strict-mcp-config",
    "--tools",
    CLAUDE_TOOLS,
    "--allowedTools",
    ALLOWED_TOOLS,
    "--disallowedTools",
    DISALLOWED_TOOLS,
  ];
  if (pluginDir) args.push("--plugin-dir", pluginDir);
  return args;
}

/** Minimum length of the setup-token credential, mirroring the host MIN_SECRET_LENGTH. */
export const MIN_SECRET_LENGTH = 8;

/**
 * Child environment for exactly one Claude invocation. Setup-token auth only:
 * the OAuth token present in `process.env` is inherited, any API key is
 * deleted so non-bare Claude can never fall back to API-key auth, and the
 * config root is pinned to a fresh, container-local directory under the tmpfs
 * HOME (no host config or settings are ever involved).
 */
export function claudeRunEnv(baseEnv = process.env) {
  const home = String(baseEnv.HOME ?? "/home/node");
  // PATH: install bin prepended exactly once so `skill-router` resolves for
  // Claude's own shell; the incoming PATH is preserved after it.
  const environment = withWrapperPath(baseEnv);
  delete environment.ANTHROPIC_API_KEY;
  return Object.assign(environment, {
    PWD: PROJECT_DIR,
    SKILL_ROUTER_HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_SKILLS_SYNC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_BUG_COMMAND: "1",
  });
}

function runClaude({ prompt, scenario }) {
  assertClaudeHasNoAuthMount();
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (typeof token !== "string" || token.trim().length < MIN_SECRET_LENGTH) {
    throw caseError(
      "env",
      "CLAUDE_CODE_OAUTH_TOKEN is not available in the case container " +
        "(non-bare setup-token auth only; an API key never substitutes for it)",
    );
  }
  const model = requireClaudeModel();
  const args = claudeArgv({ model, pluginDir: scenario === "control" ? null : PLUGIN_DIR });
  const environment = claudeRunEnv(process.env);
  const result = spawnSync("claude", args, {
    cwd: PROJECT_DIR,
    env: environment,
    input: prompt,
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
  if (result.error) throw caseError("harness", `claude failed to start (${result.error.code ?? "spawn error"})`);
  if (result.status !== 0) throw caseError("harness", `claude exited with status ${String(result.status)}`);
  return String(result.stdout ?? "");
}

/* --------------------------------- case flow -------------------------------- */

function parseArguments(argv) {
  const options = {};
  for (const token of argv) {
    if (!token.startsWith("--")) throw caseError("args", `unexpected argument ${JSON.stringify(token).slice(0, 40)}`);
    const equal = token.indexOf("=");
    if (equal === -1) throw caseError("args", "options must use --name=value form");
    const key = token.slice(2, equal);
    const value = token.slice(equal + 1);
    if (!["case", "harness", "scenario", "artifact-sha256", "container-name"].includes(key)) {
      throw caseError("args", `unknown option --${key}`);
    }
    options[key] = value;
  }
  const parsed = {
    case: options["case"] ?? "unknown",
    harness: options.harness ?? "unknown",
    scenario: options.scenario ?? "unknown",
    artifactSha256: options["artifact-sha256"] ?? "",
    containerName: options["container-name"] ?? "unknown",
  };
  if (!CASE_ID_RE.test(parsed.case)) throw caseError("args", "case id is invalid", null);
  if (!CASE_ID_RE.test(parsed.harness)) throw caseError("args", "harness id is invalid", null);
  if (!SCENARIOS.has(parsed.scenario)) throw caseError("args", "scenario must be select, none, or control", null);
  if (!SHA256_RE.test(parsed.artifactSha256)) throw caseError("args", "artifact-sha256 must be a lowercase sha256 hex digest", null);
  if (!CONTAINER_NAME_RE.test(parsed.containerName)) throw caseError("args", "container-name is invalid", null);
  return parsed;
}

export async function runCase(options) {
  // 1. Verify the mounted artifact against the outer lifecycle's locked hash.
  if (!existsSync(ARTIFACT_PATH)) throw caseError("artifact", "packed artifact is missing from the container mount");
  const actual = sha256File(ARTIFACT_PATH);
  if (actual !== options.artifactSha256) {
    throw caseError("artifact", "packed artifact sha256 does not match the lifecycle-locked hash");
  }

  // 2. Install only the packed artifact.
  mkdirSync(PROJECT_DIR, { recursive: true });
  const install = spawnSync(
    "npm",
    ["install", "--prefix", INSTALL_PREFIX, "--ignore-scripts", "--no-audit", "--no-fund", ARTIFACT_PATH],
    { cwd: PROJECT_DIR, env: process.env, encoding: "utf8", timeout: 300_000, maxBuffer: MAX_BUFFER },
  );
  if (install.error) throw caseError("install", `npm install failed to start (${install.error.code ?? "spawn error"})`);
  if (install.status !== 0) throw caseError("install", `npm install exited with status ${String(install.status)}`);
  if (!existsSync(routerBin())) throw caseError("install", "installed artifact did not provide a skill-router bin");

  // 2a. Resolve the production installation module *from the verified artifact
  // that was just installed*: this module is evaluated before step 2 exists in
  // the container, so the namespace-derived exports are populated here — after
  // the artifact hash check and the install, never before either.
  await ensureProductionInstallation();

  // 2b. Verify the immutable image-layer wrapper *after* install + package-bin
  // existence validation and *before* router setup, the status-only preflight,
  // and any model call. Package storage is non-executable, so PATH resolves
  // this rootfs wrapper (root-owned, mode 0555, pinned bytes) instead of the
  // package `.bin`; drift in the image layer fails the case closed.
  verifyImmutableRouterWrapper();

  // 3. Create only this case's fixture (a single release skill).
  mkdirSync(FIXTURES_DIR, { recursive: true });
  writeReleaseFixture();

  // 4. Router install checks: init/check/registry/managed files + route sanity.
  //    Claude cases initialize with the explicit `--harness claude` flag and
  //    consume the production plugin the packaged CLI generates; the control
  //    case never initializes so the router and the plugin stay provably
  //    unavailable.
  if (options.harness !== "claude" || options.scenario !== "control") {
    assertRouterInstall({ harness: options.harness });
  }

  // 5. OpenCode config shape (where applicable).
  if (options.harness === "opencode-v1" || options.harness === "opencode-v2") {
    assertOpenCodeConfigShape(options.harness);
  }

  // 6. Managed Claude policy absence, then the production plugin surfaces
  //    (select/none) or the uninitialized control proof, then the structural
  //    proof that no other Claude config/skill surface exists before the
  //    non-bare launch. The full generated plugin manifest is captured here so
  //    the same bytes can be re-verified after the model run.
  let pluginManifestBefore = null;
  let registrationBefore = null;
  if (options.harness === "claude") {
    assertNoManagedClaudePolicy();
    if (options.scenario === "control") {
      const surfaces = [
        ["project .claude", path.join(PROJECT_DIR, ".claude")],
        ["plugin directory", PLUGIN_DIR],
        ["router-owned Claude state", CLAUDE_STATE_DIR],
        ["router state", path.join(PROJECT_DIR, ".skill-router")],
        ["HOME config skills", path.join(process.env.HOME ?? "/home/node", ".claude", "skills")],
      ];
      for (const [label, target] of surfaces) {
        if (existsSync(target)) throw caseError("plugin", `control exposed ${label} before launch`);
      }
      assertClaudeLaunchSurfaces({ scenario: "control" });
    } else {
      const installation = assertClaudeInstallation();
      // Local-scope registration runs with cwd = the router root, so the
      // project owns exactly one registration file declaring this marketplace.
      const registrationFile = assertClaudeLocalRegistration({ marketplace: installation.marketplace });
      registrationBefore = readFileSync(registrationFile, "utf8");
      assertClaudeLaunchSurfaces({ scenario: options.scenario, installation });
      // Pre-run snapshot of the complete generated plugin tree (inert manifest
      // plus every skill and support file), re-verified byte-for-byte after
      // the model run.
      pluginManifestBefore = pluginTreeManifest(PLUGIN_DIR);
    }
  }

  // 7. Exactly one harness run for this case. Status-only executable
  // preflight first: same PATH-scoped environment as the model children, exit
  // status only, output discarded (no model call of its own).
  preflightRouterExecutable({ env: process.env });
  const { prompt, request } = promptFor(options.harness, options.scenario);
  let stdout;
  let openCodeResult = null;
  if (options.harness === "claude") stdout = runClaude({ prompt, scenario: options.scenario });
  else openCodeResult = runOpenCode({ harness: options.harness, scenario: options.scenario, prompt });

  // 7b. Post-run plugin proof: the control run must still have initialized
  // nothing at all, and a routed plugin tree must reproduce the pre-launch
  // manifest exactly (no mutation, addition, removal, or symlink/special file
  // introduced by the run).
  if (options.harness === "claude") {
    if (options.scenario === "control") {
      for (const [label, target] of [
        ["plugin directory", PLUGIN_DIR],
        ["router-owned Claude state", CLAUDE_STATE_DIR],
        ["router state", path.join(PROJECT_DIR, ".skill-router")],
        ["project .claude", path.join(PROJECT_DIR, ".claude")],
      ]) {
        if (existsSync(target)) throw caseError("plugin", `the control run created ${label}`);
      }
    } else {
      assertPluginTreeUnchanged(pluginManifestBefore, PLUGIN_DIR);
      // `--restricted` drops project/local settings, so the model run must
      // not have touched the registration file it is not allowed to read.
      const registrationFile = assertClaudeLocalRegistration();
      if (readFileSync(registrationFile, "utf8") !== registrationBefore) {
        throw caseError("plugin", "the project Claude registration changed during the model run");
      }
    }
  }

  // 8. Structural assertions over the event stream.
  const result = options.harness === "claude"
    ? inspectClaudeRun(stdout, { scenario: options.scenario, request, projectPath: PROJECT_DIR, pluginDir: PLUGIN_DIR })
    : inspectOpenCodeProcess(openCodeResult, { scenario: options.scenario, request, projectPath: PROJECT_DIR });

  return result;
}

/* ------------------------------------ main ---------------------------------- */

async function main() {
  let options = null;
  let report;
  try {
    options = parseArguments(process.argv.slice(2));
    const result = await runCase(options);
    report = buildSuccessReport({
      options,
      result,
      containerName: options.containerName,
      artifactSha256: options.artifactSha256,
    });
  } catch (error) {
    report = buildFailureReport(options, error);
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) await main();
