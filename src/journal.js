// Strict transaction journal and payload primitives for Phase 6 recovery.
//
// The journal is exactly one strict, closed-schema JSON document at
// `<controlDirectory>/transaction.json` describing one transaction. It records
// paths, SHA-256 digests, identities, and bounded metadata only - never config
// bodies, skill/request content, raw CLI output, environment, or credentials.
// Exact before/after bytes live in transient 0600 payload files adjacent to
// each target; the journal references them by exact derived name.
//
// File identity is the centralized tagged semantic from `src/durable-fs.js`:
// the journal schema still records the plain `{dev, ino}` pair (never BigInt),
// a zero/invalid recorded pair is treated as unavailable and never authorizes a
// deletion, and every destructive journal/payload removal requires a strong,
// exact identity - otherwise the artifact is preserved with a stable error.
//
// This module implements schema/validation and durable primitives only. The
// typed recovery machines (deciding what to do with a journal after a crash)
// are built on top later; `RECOVERY_AMBIGUOUS` is exported for that runner.
import fsp from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_MAX_FILE_BYTES,
  durableAtomicWrite,
  durableCreateFile,
  durableUnlink,
  fileIdentity,
  identitiesEqual,
  isIdentityAvailable,
  isOwnerOnlyMode,
  readRegularFileNoFollow,
  sha256Bytes,
  syncDirectory,
} from "./durable-fs.js";
import { CONTROL_DIRECTORY_NAME, JOURNAL_FILE_NAME } from "./mutation-lock.js";
import { CLAUDE_SCOPES, CLAUDE_VERSION_PATTERN } from "./installation.js";

/* ------------------------------------------------------------------ *
 * Stable constants
 * ------------------------------------------------------------------ */

export const JOURNAL_SCHEMA_VERSION = 1;
export const JOURNAL_OWNER = "skill-router";
export const JOURNAL_MAX_BYTES = 256 * 1024;

export const JOURNAL_ERROR_CODES = Object.freeze({
  JOURNAL_INVALID: "JOURNAL_INVALID",
  RECOVERY_CONFLICT: "RECOVERY_CONFLICT",
  RECOVERY_AMBIGUOUS: "RECOVERY_AMBIGUOUS",
});

export const JOURNAL_KINDS = Object.freeze(["managed", "removal"]);
export const JOURNAL_COMMANDS = Object.freeze(["init", "add", "scan", "uninstall"]);
export const JOURNAL_MODES = Object.freeze(["forward", "rollback", "committed"]);
export const JOURNAL_SCOPES = Object.freeze(["project", "global"]);
export const JOURNAL_KIND_COMMANDS = Object.freeze({
  managed: Object.freeze(["init", "add", "scan"]),
  removal: Object.freeze(["uninstall"]),
});
// Forward phase order per journal machine. Phase is a hint for recovery, never
// an authority; transitions are validated against this explicit order.
export const JOURNAL_PHASE_ORDER = Object.freeze({
  managed: Object.freeze(["prepared", "intent", "applying", "proven"]),
  removal: Object.freeze(["prepared", "intent", "detaching", "commit-ready"]),
});
export const JOURNAL_TERMINAL_PHASES = Object.freeze(["committed", "rolled-back"]);

export const FILE_ROLES = Object.freeze(["router-config", "opencode-config"]);
export const FILE_STATUSES = Object.freeze(["prepared", "intent", "applied", "restored"]);
export const FILE_ROLE_KINDS = Object.freeze({
  managed: Object.freeze(["router-config", "opencode-config"]),
  removal: Object.freeze(["opencode-config"]),
});
export const MAX_FILE_RECORDS = 32;
export const MAX_CLAUDE_ACTIONS = 32;

export const CLAUDE_JOURNAL_SCOPES = Object.freeze(["local", "user"]);
export const CLAUDE_PRIOR_DESIRED = Object.freeze(["healthy", "absent"]);
export const CLAUDE_ACTION_TYPES = Object.freeze([
  "marketplace-add",
  "plugin-install",
  "plugin-update",
  "plugin-uninstall",
  "marketplace-remove",
]);
export const CLAUDE_ACTION_STATUSES = Object.freeze(["intent", "observed"]);
export const CLAUDE_OUTCOME_STATUSES = Object.freeze(["succeeded", "failed"]);

// Allowed patch keys for updateJournal; revision/updatedAt are auto-managed
// and every other top-level key is immutable per transaction.
export const JOURNAL_MUTABLE_KEYS = Object.freeze(["mode", "phase", "state", "files", "claude"]);

const TOP_LEVEL_KEYS = Object.freeze([
  "schemaVersion",
  "owner",
  "transactionId",
  "revision",
  "kind",
  "command",
  "mode",
  "phase",
  "scope",
  "root",
  "controlDirectory",
  "stateDirectory",
  "createdAt",
  "updatedAt",
  "state",
  "files",
  "claude",
]);
const STATE_KEYS = Object.freeze(["stage", "backup"]);
const ARTIFACT_KEYS = Object.freeze(["path", "identity", "marker", "digest"]);
const FILE_RECORD_KEYS = Object.freeze(["target", "role", "status", "before", "after"]);
const DESCRIPTOR_KEYS = Object.freeze(["exists", "sha256", "payloadPath"]);
const CLAUDE_KEYS = Object.freeze([
  "reference",
  "scope",
  "marketplace",
  "marketplaceRoot",
  "version",
  "prior",
  "desired",
  "actions",
]);
const ACTION_BASE_KEYS = Object.freeze(["sequence", "id", "type", "scope", "status", "outcome"]);
// `outcome` is deliberately *not* required: the durable intent for a Claude
// mutation must land in the journal before the command runs, so an action with
// `status: "intent"` and no outcome is a legal (and required) journal state.
// An outcome, when present, still requires `status: "observed"`.
const ACTION_REQUIRED_KEYS = Object.freeze(["sequence", "id", "type", "scope", "status"]);
const ACTION_SHAPE = Object.freeze({
  "marketplace-add": Object.freeze({
    required: Object.freeze(["marketplace", "path"]),
    optional: Object.freeze([]),
  }),
  "marketplace-remove": Object.freeze({
    required: Object.freeze(["marketplace", "path"]),
    optional: Object.freeze([]),
  }),
  "plugin-install": Object.freeze({
    required: Object.freeze(["reference"]),
    optional: Object.freeze(["marketplace", "version"]),
  }),
  "plugin-update": Object.freeze({
    required: Object.freeze(["reference"]),
    optional: Object.freeze(["marketplace", "version", "priorVersion"]),
  }),
  "plugin-uninstall": Object.freeze({
    required: Object.freeze(["reference"]),
    optional: Object.freeze(["marketplace"]),
  }),
});
const OUTCOME_KEYS = Object.freeze(["status", "errorCode", "message"]);
const EXPECTED_BINDING_KEYS = Object.freeze([
  "root",
  "scope",
  "transactionId",
  "controlDirectory",
  "stateDirectory",
]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MARKER_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const MARKETPLACE_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9._-]{1,128}@[A-Za-z0-9._-]{1,128}$/;
const ERROR_CODE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const PAYLOAD_NAME_PATTERN = /^\.(.+)\.skill-router-([0-9a-f]{64})\.(before|after)$/;
// Built from char codes so no raw control byte or escape ambiguity enters
// this file: matches C0 controls (0..31) and DEL (127).
const CONTROL_CHARACTER_PATTERN = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`);
const MAX_PATH_LENGTH = 4096;
const MAX_REVISION = 2147483647;

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

const JOURNAL_CODES = new Set(Object.values(JOURNAL_ERROR_CODES));

export class JournalError extends Error {
  constructor(code, message, details = {}) {
    if (!JOURNAL_CODES.has(code)) throw new TypeError(`unsupported journal error code: ${String(code)}`);
    super(message);
    this.name = "JournalError";
    this.code = code;
    if (details.path !== undefined) this.path = details.path;
    if (details.transactionId !== undefined) this.transactionId = details.transactionId;
  }
}
function invalid(message, details) {
  return new JournalError(JOURNAL_ERROR_CODES.JOURNAL_INVALID, message, details);
}

function conflict(message, details) {
  return new JournalError(JOURNAL_ERROR_CODES.RECOVERY_CONFLICT, message, details);
}

function fail(message, details) {
  throw invalid(message, details);
}

function boundedLabel(value) {
  return String(value).replace(/[^\w.@-]/g, "?").slice(0, 64);
}

/* ------------------------------------------------------------------ *
 * Path derivations - the only shapes ever written or deleted
 * ------------------------------------------------------------------ */

/** Exact sibling staging directory for a transaction's state directory. */
export function stagePathFor(stateDirectory, transactionId) {
  return `${stateDirectory}.stage-${transactionId}`;
}

/** Exact sibling state backup for a transaction. */
export function backupPathFor(stateDirectory, transactionId) {
  return `${stateDirectory}.backup-${transactionId}`;
}

/** Exact adjacent payload path for one side of a target file. */
export function payloadPathFor(target, transactionId, side) {
  if (side !== "before" && side !== "after") throw new TypeError("payload side must be before or after");
  return path.join(path.dirname(target), `.${path.basename(target)}.skill-router-${transactionId}.${side}`);
}

/**
 * The one derived transient a recorded payload may have: the same-directory
 * temp file used to materialize payload bytes durably (write -> fsync ->
 * rename), so a recorded payload path itself never holds partial content and
 * an interrupted materialization can be cleaned exactly.
 */
export function payloadTransientPath(payloadPath) {
  parsePayloadPath(payloadPath, "payloadPath");
  return `${payloadPath}.tmp`;
}

/**
 * The single derived cleanup claim for a transaction-owned state artifact
 * (backup, stage, or the canonical tree being removed during rollback). The
 * name is strictly derivable from the exact artifact path and the journal's
 * transaction id, so recovery can recognize an interrupted claim after a crash
 * and re-enter it without guessing; nothing else is ever deleted by it.
 */
export function claimPathFor(artifactPath, transactionId) {
  if (typeof artifactPath !== "string" || artifactPath.length === 0) {
    throw new TypeError("claimPathFor requires an artifact path");
  }
  requireAbsolutePath(artifactPath, "artifactPath");
  if (typeof transactionId !== "string" || !SHA256_PATTERN.test(transactionId)) {
    throw new TypeError("claimPathFor requires a lowercase sha256 transaction id");
  }
  return `${artifactPath}.claim-${transactionId}`;
}

/* ------------------------------------------------------------------ *
 * Primitive validators
 * ------------------------------------------------------------------ */

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} must be a plain object`);
  return value;
}

function rejectUnknownKeys(object, allowed, label) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) fail(`${label} has unknown key: ${boundedLabel(key)}`);
  }
}

function requireKeys(object, keys, label) {
  for (const key of keys) {
    if (!Object.hasOwn(object, key)) fail(`${label} is missing required key: ${key}`);
  }
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") fail(`${label} must be a boolean`);
  return value;
}

function requireDigest(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be a lowercase sha256 hex digest`);
  }
  return value;
}

function requireNullableDigest(value, label) {
  if (value === null) return null;
  return requireDigest(value, label);
}

function requireBoundedString(value, label, { min = 1, max = 256, pattern = null } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    fail(`${label} must be a string of ${min}..${max} characters`);
  }
  if (pattern && !pattern.test(value)) fail(`${label} has an invalid format`);
  return value;
}

function requireTimestamp(value, label) {
  requireBoundedString(value, label, { min: 24, max: 24, pattern: ISO_TIMESTAMP_PATTERN });
  if (!Number.isFinite(Date.parse(value))) fail(`${label} is not a valid timestamp`);
  return value;
}

function requireNoControlCharacters(value, label) {
  if (CONTROL_CHARACTER_PATTERN.test(value)) fail(`${label} must not contain control characters`);
  return value;
}

function requireAbsolutePath(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_PATH_LENGTH) {
    fail(`${label} must be a path string of 1..${MAX_PATH_LENGTH} characters`);
  }
  requireNoControlCharacters(value, label);
  if (/[*?[\]]/.test(value)) fail(`${label} must not contain wildcard characters`);
  if (!path.isAbsolute(value)) fail(`${label} must be an absolute path`);
  if (path.resolve(value) !== value) fail(`${label} must be a normalized absolute path`);
  return value;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/* ------------------------------------------------------------------ *
 * Section validators (each rebuilds a fresh plain structure)
 * ------------------------------------------------------------------ */

function validateArtifactEntry(entry, label, expectedPath) {
  if (entry === null) return null;
  requirePlainObject(entry, label);
  rejectUnknownKeys(entry, ARTIFACT_KEYS, label);
  requireKeys(entry, ARTIFACT_KEYS, label);
  const entryPath = requireAbsolutePath(entry.path, `${label}.path`);
  if (entryPath !== expectedPath) {
    fail(`${label}.path must be the exact transaction-derived sibling of the state directory`);
  }
  let identity = null;
  if (entry.identity !== null) {
    requirePlainObject(entry.identity, `${label}.identity`);
    rejectUnknownKeys(entry.identity, ["dev", "ino"], `${label}.identity`);
    requireKeys(entry.identity, ["dev", "ino"], `${label}.identity`);
    for (const key of ["dev", "ino"]) {
      if (!Number.isSafeInteger(entry.identity[key]) || entry.identity[key] < 0) {
        fail(`${label}.identity.${key} must be a non-negative safe integer`);
      }
    }
    identity = { dev: entry.identity.dev, ino: entry.identity.ino };
  }
  const marker = entry.marker === null
    ? null
    : requireBoundedString(entry.marker, `${label}.marker`, { max: 128, pattern: MARKER_PATTERN });
  const digest = requireNullableDigest(entry.digest, `${label}.digest`);
  return { path: entryPath, identity, marker, digest };
}

function validateStateSection(state, { stateDirectory, transactionId }) {
  requirePlainObject(state, "state");
  rejectUnknownKeys(state, STATE_KEYS, "state");
  requireKeys(state, STATE_KEYS, "state");
  return {
    stage: validateArtifactEntry(state.stage, "state.stage", stagePathFor(stateDirectory, transactionId)),
    backup: validateArtifactEntry(state.backup, "state.backup", backupPathFor(stateDirectory, transactionId)),
  };
}

function validateDescriptor(descriptor, label, { target, transactionId, side }) {
  requirePlainObject(descriptor, label);
  rejectUnknownKeys(descriptor, DESCRIPTOR_KEYS, label);
  requireKeys(descriptor, DESCRIPTOR_KEYS, label);
  const exists = requireBoolean(descriptor.exists, `${label}.exists`);
  if (side === "after" && exists !== true) fail(`${label}.exists must be true`);
  if (exists) {
    requireDigest(descriptor.sha256, `${label}.sha256`);
    const expectedPayload = payloadPathFor(target, transactionId, side);
    if (typeof descriptor.payloadPath !== "string") {
      fail(`${label}.payloadPath must be an exact payload path`);
    }
    if (descriptor.payloadPath !== expectedPayload) {
      fail(`${label}.payloadPath must be the exact transaction-derived payload adjacent to the target`);
    }
    return { exists: true, sha256: descriptor.sha256, payloadPath: descriptor.payloadPath };
  }
  if (descriptor.sha256 !== null) fail(`${label}.sha256 must be null when the file is absent`);
  if (descriptor.payloadPath !== null) fail(`${label}.payloadPath must be null when the file is absent`);
  return { exists: false, sha256: null, payloadPath: null };
}

/**
 * Validates one file record. With `kind`/`controlDirectory`/`stateDirectory`
 * (journal context) the full containment and role rules apply; standalone
 * (payload context) only shape, payload derivation, and target consistency are
 * checked, with the transaction id derived from the required after payload.
 */
function validateFileRecord(record, { kind = null, controlDirectory = null, stateDirectory = null } = {}) {
  requirePlainObject(record, "file record");
  rejectUnknownKeys(record, FILE_RECORD_KEYS, "file record");
  requireKeys(record, FILE_RECORD_KEYS, "file record");
  const target = requireAbsolutePath(record.target, "file target");
  requireBoundedString(record.role, "file role", { max: 64 });
  if (!FILE_ROLES.includes(record.role)) fail("file role is not a supported role");
  if (kind !== null && !FILE_ROLE_KINDS[kind].includes(record.role)) {
    fail(`file role ${record.role} is not allowed for a ${kind} transaction`);
  }
  if (!FILE_STATUSES.includes(record.status)) fail("file status is not a supported status");

  requirePlainObject(record.after, "file after descriptor");
  if (typeof record.after.payloadPath !== "string") fail("file after descriptor requires an exact payload path");
  const parsed = parsePayloadPath(record.after.payloadPath, "file after descriptor payloadPath");
  const transactionId = parsed.transactionId;
  if (path.dirname(record.after.payloadPath) !== path.dirname(target)) {
    fail("file payloadPath must live in the target's directory");
  }
  if (path.basename(target) !== parsed.base) fail("file payload name must be derived from the target's basename");

  if (controlDirectory !== null && stateDirectory !== null) {
    if (target === controlDirectory || isInside(controlDirectory, target)) {
      fail("file target must not overlap the control directory");
    }
    if (target === stateDirectory || isInside(stateDirectory, target)) {
      fail("file target must not overlap the state directory");
    }
    if (isInside(target, controlDirectory) || isInside(target, stateDirectory)) {
      fail("file target must not be an ancestor of the control or state directory");
    }
  }

  const before = validateDescriptor(record.before, "file before descriptor", {
    target,
    transactionId,
    side: "before",
  });
  const after = validateDescriptor(record.after, "file after descriptor", {
    target,
    transactionId,
    side: "after",
  });
  if (before.payloadPath !== null && before.payloadPath === after.payloadPath) {
    fail("before and after payloads must differ");
  }
  return { target, role: record.role, status: record.status, before, after, transactionId };
}

function validateOutcome(outcome, label) {
  requirePlainObject(outcome, label);
  rejectUnknownKeys(outcome, OUTCOME_KEYS, label);
  requireKeys(outcome, ["status"], label);
  if (!CLAUDE_OUTCOME_STATUSES.includes(outcome.status)) fail(`${label}.status is not a supported status`);
  const rebuilt = { status: outcome.status };
  if (Object.hasOwn(outcome, "errorCode")) {
    requireBoundedString(outcome.errorCode, `${label}.errorCode`, { max: 64, pattern: ERROR_CODE_PATTERN });
    requireNoControlCharacters(outcome.errorCode, `${label}.errorCode`);
    rebuilt.errorCode = outcome.errorCode;
  }
  if (Object.hasOwn(outcome, "message")) {
    requireBoundedString(outcome.message, `${label}.message`, { max: 400 });
    requireNoControlCharacters(outcome.message, `${label}.message`);
    rebuilt.message = outcome.message;
  }
  return rebuilt;
}

function validateAction(action, claude, previousSequence) {
  requirePlainObject(action, "claude action");
  const type = requireBoundedString(action.type, "claude action type", { max: 32 });
  if (!CLAUDE_ACTION_TYPES.includes(type)) fail("claude action type is not supported");
  const shape = ACTION_SHAPE[type];
  const allowed = [...ACTION_BASE_KEYS, ...shape.required, ...shape.optional];
  rejectUnknownKeys(action, allowed, `claude action ${type}`);
  requireKeys(action, [...ACTION_REQUIRED_KEYS, ...shape.required], `claude action ${type}`);

  if (!Number.isSafeInteger(action.sequence) || action.sequence < 1) {
    fail("claude action sequence must be a positive integer");
  }
  if (previousSequence !== null && action.sequence <= previousSequence) {
    fail("claude action sequences must be strictly increasing");
  }
  if (!CLAUDE_JOURNAL_SCOPES.includes(action.scope)) fail("claude action scope is not supported");
  if (action.scope !== claude.scope) fail("claude action scope must match claude.scope");
  if (!CLAUDE_ACTION_STATUSES.includes(action.status)) fail("claude action status is not supported");

  const rebuilt = { sequence: action.sequence, id: "", type, scope: action.scope, status: action.status };
  if (Object.hasOwn(action, "reference")) {
    requireBoundedString(action.reference, "claude action reference", { max: 256, pattern: REFERENCE_PATTERN });
    if (action.reference !== claude.reference) fail("claude action reference must match claude.reference");
    rebuilt.reference = action.reference;
  }
  if (Object.hasOwn(action, "marketplace")) {
    requireBoundedString(action.marketplace, "claude action marketplace", { max: 128, pattern: MARKETPLACE_PATTERN });
    if (action.marketplace !== claude.marketplace) fail("claude action marketplace must match claude.marketplace");
    rebuilt.marketplace = action.marketplace;
  }
  if (Object.hasOwn(action, "path")) {
    requireAbsolutePath(action.path, "claude action path");
    if (action.path !== claude.marketplaceRoot) fail("claude action path must match claude.marketplaceRoot");
    rebuilt.path = action.path;
  }
  if (Object.hasOwn(action, "version")) {
    requireBoundedString(action.version, "claude action version", { max: 32, pattern: CLAUDE_VERSION_PATTERN });
    rebuilt.version = action.version;
  }
  if (Object.hasOwn(action, "priorVersion")) {
    requireBoundedString(
      action.priorVersion,
      "claude action priorVersion",
      { max: 32, pattern: CLAUDE_VERSION_PATTERN },
    );
    rebuilt.priorVersion = action.priorVersion;
  }
  if (type.startsWith("marketplace-") && rebuilt.reference !== undefined) {
    fail(`claude action ${type} must not carry a reference`);
  }
  if (type.startsWith("plugin-") && rebuilt.path !== undefined) {
    fail(`claude action ${type} must not carry a path`);
  }
  if (type === "plugin-uninstall" && (rebuilt.version !== undefined || rebuilt.priorVersion !== undefined)) {
    fail("claude action plugin-uninstall must not carry version data");
  }
  if (type === "marketplace-add" && (rebuilt.version !== undefined || rebuilt.priorVersion !== undefined)) {
    fail("claude action marketplace-add must not carry version data");
  }

  const target = rebuilt.reference ?? rebuilt.marketplace;
  const derivedId = `${type}:${action.scope}:${target}`;
  requireBoundedString(action.id, "claude action id", { max: 320 });
  if (action.id !== derivedId) fail("claude action id must be derived as type:scope:target");
  rebuilt.id = action.id;

  if (Object.hasOwn(action, "outcome")) {
    if (action.status !== "observed") fail("claude action outcome requires status observed");
    rebuilt.outcome = validateOutcome(action.outcome, "claude action outcome");
  }
  return rebuilt;
}

function validateClaudeSection(claude, { scope, kind, stateDirectory }) {
  if (claude === null) return null;
  requirePlainObject(claude, "claude");
  rejectUnknownKeys(claude, CLAUDE_KEYS, "claude");
  requireKeys(claude, CLAUDE_KEYS, "claude");

  const expectedClaudeScope = CLAUDE_SCOPES[scope];
  requireBoundedString(claude.scope, "claude.scope", { max: 16 });
  if (!CLAUDE_JOURNAL_SCOPES.includes(claude.scope)) fail("claude.scope is not supported");
  if (claude.scope !== expectedClaudeScope) {
    fail(`claude.scope must be ${expectedClaudeScope} for a ${scope} journal`);
  }
  requireBoundedString(claude.marketplace, "claude.marketplace", { max: 128, pattern: MARKETPLACE_PATTERN });
  requireBoundedString(claude.reference, "claude.reference", { max: 256, pattern: REFERENCE_PATTERN });
  if (!claude.reference.endsWith(`@${claude.marketplace}`)) {
    fail("claude.reference must end with @claude.marketplace");
  }
  const marketplaceRoot = requireAbsolutePath(claude.marketplaceRoot, "claude.marketplaceRoot");
  if (!isInside(stateDirectory, marketplaceRoot)) {
    fail("claude.marketplaceRoot must be strictly inside the state directory");
  }
  requireBoundedString(claude.version, "claude.version", { max: 32, pattern: CLAUDE_VERSION_PATTERN });
  if (!CLAUDE_PRIOR_DESIRED.includes(claude.prior)) fail("claude.prior must be healthy or absent");
  if (!CLAUDE_PRIOR_DESIRED.includes(claude.desired)) fail("claude.desired must be healthy or absent");
  if (kind === "managed" && claude.desired !== "healthy") {
    fail("a managed transaction requires claude.desired healthy");
  }
  if (kind === "removal" && claude.desired !== "absent") {
    fail("a removal transaction requires claude.desired absent");
  }
  if (claude.prior === "absent" && claude.desired === "absent") {
    fail("claude prior and desired cannot both be absent");
  }
  if (!Array.isArray(claude.actions)) fail("claude.actions must be an array");
  if (claude.actions.length > MAX_CLAUDE_ACTIONS) {
    fail(`claude.actions must hold at most ${MAX_CLAUDE_ACTIONS} entries`);
  }
  const rebuiltClaude = {
    reference: claude.reference,
    scope: claude.scope,
    marketplace: claude.marketplace,
    marketplaceRoot,
    version: claude.version,
    prior: claude.prior,
    desired: claude.desired,
    actions: [],
  };
  let previousSequence = null;
  for (const action of claude.actions) {
    const rebuilt = validateAction(action, rebuiltClaude, previousSequence);
    previousSequence = rebuilt.sequence;
    rebuiltClaude.actions.push(rebuilt);
  }
  return rebuiltClaude;
}

function validateFilesList(files, { kind, controlDirectory, stateDirectory }) {
  if (!Array.isArray(files)) fail("files must be an array");
  if (files.length > MAX_FILE_RECORDS) fail(`files must hold at most ${MAX_FILE_RECORDS} records`);
  const rebuilt = [];
  const targets = new Set();
  for (const record of files) {
    const validated = validateFileRecord(record, { kind, controlDirectory, stateDirectory });
    if (targets.has(validated.target)) fail("file targets must be unique");
    targets.add(validated.target);
    rebuilt.push({
      target: validated.target,
      role: validated.role,
      status: validated.status,
      before: { ...validated.before },
      after: { ...validated.after },
    });
  }
  for (const record of rebuilt) {
    for (const payload of [record.before.payloadPath, record.after.payloadPath]) {
      if (payload !== null && targets.has(payload)) {
        fail("a payload path must not collide with another file target");
      }
    }
  }
  return rebuilt;
}

/* ------------------------------------------------------------------ *
 * Top-level validation
 * ------------------------------------------------------------------ */

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const element of value) deepFreeze(element);
    Object.freeze(value);
  } else if (value !== null && typeof value === "object") {
    for (const element of Object.values(value)) deepFreeze(element);
    Object.freeze(value);
  }
  return value;
}

function applyExpectedBinding(document, expected) {
  if (expected === undefined || expected === null) return;
  if (!isPlainObject(expected)) throw new TypeError("expected binding must be a plain object");
  for (const key of Object.keys(expected)) {
    if (!EXPECTED_BINDING_KEYS.includes(key)) throw new TypeError(`unknown expected binding: ${boundedLabel(key)}`);
  }
  if (Object.hasOwn(expected, "root")) {
    if (path.resolve(String(expected.root)) !== document.root) fail("journal root does not match the expected root");
  }
  if (Object.hasOwn(expected, "controlDirectory")) {
    if (path.resolve(String(expected.controlDirectory)) !== document.controlDirectory) {
      fail("journal controlDirectory does not match the expected control directory");
    }
  }
  if (Object.hasOwn(expected, "stateDirectory")) {
    if (path.resolve(String(expected.stateDirectory)) !== document.stateDirectory) {
      fail("journal stateDirectory does not match the expected state directory");
    }
  }
  if (Object.hasOwn(expected, "scope") && expected.scope !== document.scope) {
    fail("journal scope does not match the expected scope");
  }
  if (Object.hasOwn(expected, "transactionId") && expected.transactionId !== document.transactionId) {
    fail("journal transactionId does not match the expected transaction");
  }
}

/**
 * Strict closed-schema validation. Rebuilds every node from validated fields
 * (prototype/extra-key tricks cannot survive), then deeply freezes the result.
 * Throws JournalError JOURNAL_INVALID; returns the normalized frozen document.
 */
export function validateJournal(document, expected) {
  requirePlainObject(document, "journal");
  rejectUnknownKeys(document, TOP_LEVEL_KEYS, "journal");
  requireKeys(document, TOP_LEVEL_KEYS, "journal");

  if (document.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${JOURNAL_SCHEMA_VERSION}`);
  }
  if (document.owner !== JOURNAL_OWNER) fail(`owner must be ${JSON.stringify(JOURNAL_OWNER)}`);
  const transactionId = requireDigest(document.transactionId, "transactionId");
  if (!Number.isSafeInteger(document.revision) || document.revision < 0 || document.revision > MAX_REVISION) {
    fail(`revision must be an integer between 0 and ${MAX_REVISION}`);
  }
  requireBoundedString(document.kind, "kind", { max: 16 });
  if (!JOURNAL_KINDS.includes(document.kind)) fail("kind must be managed or removal");
  const kind = document.kind;
  requireBoundedString(document.command, "command", { max: 16 });
  if (!JOURNAL_COMMANDS.includes(document.command)) fail("command is not supported");
  if (!JOURNAL_KIND_COMMANDS[kind].includes(document.command)) {
    fail(`command ${document.command} is not valid for a ${kind} transaction`);
  }
  requireBoundedString(document.mode, "mode", { max: 16 });
  if (!JOURNAL_MODES.includes(document.mode)) fail("mode must be forward, rollback, or committed");
  requireBoundedString(document.scope, "scope", { max: 16 });
  if (!JOURNAL_SCOPES.includes(document.scope)) fail("scope must be project or global");

  const orderedPhases = JOURNAL_PHASE_ORDER[kind];
  requireBoundedString(document.phase, "phase", { max: 32 });
  const phase = document.phase;
  if (!orderedPhases.includes(phase) && !JOURNAL_TERMINAL_PHASES.includes(phase)) {
    fail(`phase is not valid for a ${kind} transaction`);
  }
  const terminal = JOURNAL_TERMINAL_PHASES.includes(phase);
  if (document.mode === "committed" && phase !== "committed") {
    fail("mode committed requires phase committed");
  }
  if (phase === "committed" && document.mode !== "committed") {
    fail("phase committed requires mode committed");
  }
  if (phase === "rolled-back" && document.mode !== "rollback") {
    fail("phase rolled-back requires mode rollback");
  }
  if (document.mode === "committed" && !terminal) fail("mode committed requires a terminal phase");

  const root = requireAbsolutePath(document.root, "root");
  const controlDirectory = requireAbsolutePath(document.controlDirectory, "controlDirectory");
  const stateDirectory = requireAbsolutePath(document.stateDirectory, "stateDirectory");
  if (document.scope === "project") {
    if (controlDirectory !== path.join(root, CONTROL_DIRECTORY_NAME)) {
      fail("a project journal's controlDirectory must be <root>/.skill-router-control");
    }
  } else if (controlDirectory === path.join(root, CONTROL_DIRECTORY_NAME)) {
    fail("a global journal's controlDirectory must not use the project control layout");
  }
  const controlVsState = controlDirectory === stateDirectory
    || isInside(stateDirectory, controlDirectory)
    || isInside(controlDirectory, stateDirectory);
  if (controlVsState) fail("controlDirectory and stateDirectory must be disjoint");

  const createdAt = requireTimestamp(document.createdAt, "createdAt");
  const updatedAt = requireTimestamp(document.updatedAt, "updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) fail("updatedAt must not precede createdAt");

  const state = validateStateSection(document.state, { stateDirectory, transactionId });
  const files = validateFilesList(document.files, { kind, controlDirectory, stateDirectory });
  const claude = validateClaudeSection(document.claude, { scope: document.scope, kind, stateDirectory });

  const normalized = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    owner: JOURNAL_OWNER,
    transactionId,
    revision: document.revision,
    kind,
    command: document.command,
    mode: document.mode,
    phase,
    scope: document.scope,
    root,
    controlDirectory,
    stateDirectory,
    createdAt,
    updatedAt,
    state,
    files,
    claude,
  };
  applyExpectedBinding(normalized, expected);
  return deepFreeze(normalized);
}

/* ------------------------------------------------------------------ *
 * Serialization
 * ------------------------------------------------------------------ */

/** Canonical deterministic bytes: validated document + single newline. */
function canonicalBytes(document) {
  return Buffer.from(`${JSON.stringify(document)}\n`, "utf8");
}

/** Deterministic newline JSON serialization of any accepted journal shape. */
export function serializeJournal(document) {
  return canonicalBytes(validateJournal(document));
}

/* ------------------------------------------------------------------ *
 * Lease / paths / time / transitions
 * ------------------------------------------------------------------ */

function validateJournalPaths(paths) {
  if (!paths || typeof paths !== "object") throw new TypeError("control paths object is required");
  for (const key of ["controlDirectory", "journalFile"]) {
    if (typeof paths[key] !== "string" || paths[key].length === 0) {
      throw new TypeError(`control paths.${key} must be a non-empty string`);
    }
  }
  if (path.dirname(paths.journalFile) !== paths.controlDirectory) {
    throw new TypeError("control paths.journalFile must be inside paths.controlDirectory");
  }
  if (path.basename(paths.journalFile) !== JOURNAL_FILE_NAME) {
    throw new TypeError(`control paths.journalFile must be named ${JOURNAL_FILE_NAME}`);
  }
  return paths;
}

async function assertLeaseHeld(lease, label) {
  if (!lease || typeof lease.assertHeld !== "function") {
    throw new TypeError(`a mutation lock lease with assertHeld() is required to ${label}`);
  }
  await lease.assertHeld();
}

function currentMillis(now) {
  const value = now();
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("now() must return a non-negative safe integer timestamp");
  }
  return value;
}

function monotonicTimestamp(previousIso, now) {
  const stamp = currentMillis(now);
  const previous = Date.parse(previousIso);
  const next = Number.isFinite(previous) && stamp <= previous ? previous + 1 : stamp;
  return new Date(next).toISOString();
}

/**
 * Explicit transition table. Outside recovery: forward phases advance one step
 * at a time (same phase allowed for status updates), never backwards, never
 * skipping; forward may switch to rollback from any phase; committed may only
 * be entered from the final forward phase; rollback only finishes as
 * rolled-back. `recovery: true` permits phase skips and backwards moves, plus
 * rollback-to-forward resumption and commit marking from any forward phase
 * (the typed recovery machine re-derives commit proof from observed
 * endpoints), but never exits a terminal phase and never turns a rollback
 * into a commit.
 */
function assertLegalTransition(baseline, next, { recovery = false }) {
  const guard = (message) => fail(`illegal journal transition: ${message}`);
  if (JOURNAL_TERMINAL_PHASES.includes(baseline.phase)) {
    guard(`a terminal journal (${baseline.phase}) cannot be updated`);
  }
  const order = JOURNAL_PHASE_ORDER[next.kind];
  if (next.phase === "committed") {
    if (baseline.mode !== "forward") guard("only a forward journal can become committed");
    if (!recovery && baseline.phase !== order[order.length - 1]) {
      guard("committed is only reachable from the final forward phase outside recovery");
    }
    return;
  }
  if (next.phase === "rolled-back") {
    if (next.mode !== "rollback") guard("rolled-back requires mode rollback");
    return;
  }
  if (next.mode === "rollback") {
    if (next.phase !== baseline.phase && !recovery) {
      guard("rollback keeps its phase until it finishes as rolled-back");
    }
    return;
  }
  if (baseline.mode === "rollback") {
    if (!recovery) guard("a rollback journal cannot resume forward outside recovery");
    return;
  }
  const from = order.indexOf(baseline.phase);
  const to = order.indexOf(next.phase);
  if (from < 0 || to < 0) guard(`phase is not valid for a ${next.kind} transaction`);
  if (recovery) return;
  if (to === from) return;
  if (to === from + 1) return;
  guard(to < from ? "phase cannot move backwards" : "phase cannot skip ahead");
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

async function readJournalRecord(paths, { allowMissing = false, expected } = {}) {
  let stat;
  try {
    stat = await fsp.lstat(paths.journalFile);
  } catch (error) {
    if (error.code === "ENOENT") {
      if (allowMissing) return null;
      fail("journal is missing", { path: paths.journalFile });
    }
    throw error;
  }
  if (stat.isSymbolicLink()) fail("journal file is a symbolic link", { path: paths.journalFile });
  if (!stat.isFile()) fail("journal path is not a regular file", { path: paths.journalFile });
  if (process.platform !== "win32") {
    if (!isOwnerOnlyMode(stat.mode)) fail("journal file must be owner-only", { path: paths.journalFile });
    if (typeof process.getuid === "function" && Number(stat.uid) !== process.getuid()) {
      fail("journal file must be owned by the current user", { path: paths.journalFile });
    }
  }

  let bytes;
  try {
    bytes = await readRegularFileNoFollow(paths.journalFile, { maxBytes: JOURNAL_MAX_BYTES, allowMissing: true });
  } catch (error) {
    if (error.code === "EFBIG") fail("journal file exceeds the maximum journal size", { path: paths.journalFile });
    if (error.code === "ELOOP") fail("journal file is a symbolic link", { path: paths.journalFile });
    if (error.code === "EFTYPE" || error.code === "EBUSY") {
      fail("journal file is not a stable regular file", { path: paths.journalFile });
    }
    if (error.code === "EACCES" || error.code === "EPERM") {
      fail("journal file is not readable", { path: paths.journalFile });
    }
    throw error;
  }
  if (bytes === null) {
    if (allowMissing) return null;
    fail("journal is missing", { path: paths.journalFile });
  }

  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("journal is not valid JSON", { path: paths.journalFile });
  }
  const binding = { ...(expected ?? {}) };
  if (binding.controlDirectory !== undefined
    && path.resolve(String(binding.controlDirectory)) !== paths.controlDirectory) {
    fail("journal controlDirectory does not match the expected control directory");
  }
  // The paths argument is authoritative for where the journal was read.
  binding.controlDirectory = paths.controlDirectory;
  const document = validateJournal(parsed, binding);
  return { bytes, document, identity: fileIdentity(stat) };
}

/**
 * Reads and validates the journal. Missing returns null only with
 * `allowMissing: true`; everything else fails closed with JOURNAL_INVALID.
 * Optional expected bindings (root, scope, transactionId, controlDirectory,
 * stateDirectory) tie the read to the caller's control context.
 */
export async function readJournal(paths, options = {}) {
  validateJournalPaths(paths);
  if (!isPlainObject(options)) throw new TypeError("read options must be a plain object");
  for (const key of Object.keys(options)) {
    if (key !== "allowMissing" && !EXPECTED_BINDING_KEYS.includes(key)) {
      throw new TypeError(`unknown read option: ${boundedLabel(key)}`);
    }
  }
  const { allowMissing, ...expected } = options;
  if (allowMissing !== undefined && typeof allowMissing !== "boolean") {
    throw new TypeError("allowMissing must be a boolean");
  }
  const record = await readJournalRecord(paths, {
    allowMissing: allowMissing === true,
    expected,
  });
  return record ? record.document : null;
}

/* ------------------------------------------------------------------ *
 * create / update / remove
 * ------------------------------------------------------------------ */

async function findExistingJournal(paths) {
  try {
    return await fsp.lstat(paths.journalFile);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Durably creates the journal with an exclusive final-path create. It never
 * overwrites anything: a live journal is a RECOVERY_CONFLICT and a wrong-type
 * entry is JOURNAL_INVALID. The created bytes are reread and verified before
 * the lease is asserted again.
 */
export async function createJournal(paths, initial, { lease, now = Date.now } = {}) {
  validateJournalPaths(paths);
  await assertLeaseHeld(lease, "create the journal");

  const existing = await findExistingJournal(paths);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw invalid("journal path is occupied by a non-regular entry", { path: paths.journalFile });
    }
    throw conflict("a journal already exists", { path: paths.journalFile });
  }

  const document = validateJournal(initial, { controlDirectory: paths.controlDirectory });
  if (document.revision !== 0) fail("a new journal must start at revision 0");
  if (document.phase !== "prepared") fail("a new journal must start in phase prepared");
  if (document.mode !== "forward") fail("a new journal must start in mode forward");
  if (now !== undefined && typeof now !== "function") throw new TypeError("now must be a function");

  const bytes = canonicalBytes(document);
  await assertLeaseHeld(lease, "create the journal");
  try {
    await durableCreateFile(paths.journalFile, bytes, { mode: 0o600 });
  } catch (error) {
    if (error.code === "EEXIST") throw conflict("a journal already exists", { path: paths.journalFile });
    if (error.code === "ELOOP") fail("journal path is occupied by a symbolic link", { path: paths.journalFile });
    if (error.code === "EFTYPE") fail("journal path is occupied by a non-regular entry", { path: paths.journalFile });
    if (error.code === "ENOTSUP") {
      // The durable-create identity preflight refused the filesystem: no
      // journal, payload, or artifact was created there.
      throw conflict("the journal was not created: the filesystem does not report a stable file identity", {
        path: paths.journalFile,
      });
    }
    throw error;
  }

  const record = await readJournalRecord(paths, { allowMissing: false });
  if (!record.bytes.equals(bytes)) {
    throw conflict("the journal changed while it was being created", { path: paths.journalFile });
  }
  await assertLeaseHeld(lease, "create the journal");
  return document;
}

function mergePatch(baseline, patchOrNext) {
  const patch = typeof patchOrNext === "function" ? patchOrNext(baseline) : patchOrNext;
  requirePlainObject(patch, "the update patch");
  for (const key of Object.keys(patch)) {
    if (!JOURNAL_MUTABLE_KEYS.includes(key)) {
      fail(`the update patch may only set: ${JOURNAL_MUTABLE_KEYS.join(", ")}`);
    }
  }
  return { ...baseline, ...patch };
}

/**
 * Compare-and-swap update. The supplied `current` must byte-match the journal
 * on disk (RECOVERY_CONFLICT otherwise), only mutable keys may change,
 * revision/updatedAt are advanced monotonically, the transition table is
 * checked, and the replacement is a durable atomic write verified by reread.
 * The lease is asserted before and after the mutation.
 */
export async function updateJournal(paths, current, patchOrNext, { lease, now = Date.now, recovery = false } = {}) {
  validateJournalPaths(paths);
  await assertLeaseHeld(lease, "update the journal");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (recovery !== true && recovery !== false) throw new TypeError("recovery must be a boolean");

  const baseline = validateJournal(current, { controlDirectory: paths.controlDirectory });
  const record = await readJournalRecord(paths, { allowMissing: true });
  if (record === null) throw conflict("the journal is missing", { path: paths.journalFile });
  if (record.document.transactionId !== baseline.transactionId) {
    throw conflict("the journal on disk belongs to a different transaction", { path: paths.journalFile });
  }
  if (record.document.revision !== baseline.revision) {
    throw conflict("the journal revision on disk differs from the supplied document", { path: paths.journalFile });
  }
  if (!record.bytes.equals(canonicalBytes(baseline))) {
    throw conflict("the journal on disk differs from the supplied current document", { path: paths.journalFile });
  }

  const merged = mergePatch(baseline, patchOrNext);
  merged.revision = baseline.revision + 1;
  merged.updatedAt = monotonicTimestamp(baseline.updatedAt, now);
  const next = validateJournal(merged, { controlDirectory: paths.controlDirectory });
  assertLegalTransition(baseline, next, { recovery });

  await assertLeaseHeld(lease, "update the journal");
  try {
    await durableAtomicWrite(paths.journalFile, canonicalBytes(next), { mode: 0o600 });
  } catch (error) {
    if (error.code === "EEXIST" || error.code === "ELOOP" || error.code === "EFTYPE") {
      throw conflict("the journal path changed during the update", { path: paths.journalFile });
    }
    throw error;
  }
  const after = await readJournalRecord(paths, { allowMissing: false });
  if (!after.bytes.equals(canonicalBytes(next))) {
    throw conflict("the journal changed during the update", { path: paths.journalFile });
  }
  await assertLeaseHeld(lease, "update the journal");
  return next;
}

/**
 * Removes the journal: only a terminal, cleanup-complete document qualifies -
 * every recorded artifact and payload path must already be gone from disk.
 * The reread journal must byte-match `current` and the exact inode; then the
 * journal file itself is unlinked and its parent synced. The lease is asserted
 * before and after.
 */
export async function removeJournal(paths, current, { lease } = {}) {
  validateJournalPaths(paths);
  await assertLeaseHeld(lease, "remove the journal");

  const baseline = validateJournal(current, { controlDirectory: paths.controlDirectory });
  const record = await readJournalRecord(paths, { allowMissing: true });
  if (record === null) throw conflict("the journal is missing", { path: paths.journalFile });
  const sameTransaction = record.document.transactionId === baseline.transactionId
    && record.document.revision === baseline.revision;
  if (!sameTransaction) {
    throw conflict("the journal on disk belongs to a different transaction or revision", { path: paths.journalFile });
  }
  if (!record.bytes.equals(canonicalBytes(baseline))) {
    throw conflict("the journal on disk differs from the supplied current document", { path: paths.journalFile });
  }
  const document = record.document;

  if (!JOURNAL_TERMINAL_PHASES.includes(document.phase)) {
    fail("the journal is not terminal; finish or roll back the transaction before removing it", {
      path: paths.journalFile,
    });
  }
  const recordedPaths = [];
  if (document.state.stage !== null) recordedPaths.push(document.state.stage.path);
  if (document.state.backup !== null) recordedPaths.push(document.state.backup.path);
  for (const file of document.files) {
    if (file.before.payloadPath !== null) recordedPaths.push(file.before.payloadPath);
    recordedPaths.push(file.after.payloadPath);
  }
  for (const recorded of recordedPaths) {
    try {
      await fsp.lstat(recorded);
      fail(`the journal still records a live artifact or payload: ${recorded}`, { path: paths.journalFile });
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
  }

  await assertLeaseHeld(lease, "remove the journal");
  let currentStat;
  try {
    currentStat = await fsp.lstat(paths.journalFile);
  } catch (error) {
    if (error.code === "ENOENT") throw conflict("the journal is missing", { path: paths.journalFile });
    throw error;
  }
  const swapped = currentStat.isSymbolicLink()
    || !currentStat.isFile()
    || !identitiesEqual(fileIdentity(currentStat), record.identity);
  if (swapped) throw conflict("the journal file changed before removal", { path: paths.journalFile });
  // Removing the journal is a destructive exact-entry operation: the identity
  // this read observed must be strong and still exact. An unprovable identity
  // (an old journal that recorded a zero/invalid pair, or a filesystem that
  // stopped reporting one) preserves the journal and is never a deletion
  // authorization.
  if (!isIdentityAvailable(record.identity) || !isIdentityAvailable(fileIdentity(currentStat))) {
    throw conflict("the journal file does not carry a stable identity; it was preserved", { path: paths.journalFile });
  }
  if (process.platform !== "win32" && !isOwnerOnlyMode(currentStat.mode)) {
    throw conflict("the journal file permissions changed before removal", { path: paths.journalFile });
  }
  // Immediate lease assertion right before the unlink, after every
  // intervening probe of this removal.
  await assertLeaseHeld(lease, "remove the journal");
  try {
    // Attributed removal: the identity this removal already proved equal to
    // the journal read's identity is the identity the claim must match.
    await durableUnlink(paths.journalFile, fileIdentity(currentStat));
  } catch (error) {
    if (error && error.code === "ENOENT") throw conflict("the journal is missing", { path: paths.journalFile });
    if (error && error.code === "ENOTSUP") {
      throw conflict("the journal file identity cannot be proven; it was preserved", { path: paths.journalFile });
    }
    throw error;
  }
  await assertLeaseHeld(lease, "remove the journal");
  return true;
}

/* ------------------------------------------------------------------ *
 * Payloads
 * ------------------------------------------------------------------ */

function parsePayloadPath(payloadPath, label) {
  const checked = requireAbsolutePath(payloadPath, label);
  const match = PAYLOAD_NAME_PATTERN.exec(path.basename(checked));
  if (!match) fail(`${label} must be an exact payload path`);
  return { base: match[1], transactionId: match[2], side: match[3] };
}

async function readPayloadRecord(payloadPath, { maxBytes = DEFAULT_MAX_FILE_BYTES, allowLinkedPair = null } = {}) {
  let stat;
  try {
    stat = await fsp.lstat(payloadPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink()) fail("payload is a symbolic link", { path: payloadPath });
  if (!stat.isFile()) fail("payload is not a regular file", { path: payloadPath });
  if (process.platform !== "win32") {
    if (!isOwnerOnlyMode(stat.mode)) fail("payload must be owner-only", { path: payloadPath });
    if (typeof process.getuid === "function" && Number(stat.uid) !== process.getuid()) {
      fail("payload must be owned by the current user", { path: payloadPath });
    }
  }
  // B4 link topology: a payload is exactly one name (nlink 1). The single
  // exception is the explicitly proven interrupted publish pair - exactly two
  // links whose other member is the caller's derived transient path holding
  // the same strong identity. Any other alias means the payload cannot be
  // attributed to this journal and is refused (and preserved).
  if (Number(stat.nlink) !== 1) {
    if (Number(stat.nlink) !== 2 || typeof allowLinkedPair !== "string" || allowLinkedPair === "") {
      fail("payload must have exactly one link", { path: payloadPath });
    }
    let pair;
    try {
      pair = await fsp.lstat(allowLinkedPair);
    } catch (error) {
      if (error && error.code === "ENOENT") fail("payload has an unproven extra link", { path: payloadPath });
      throw error;
    }
    if (pair.isSymbolicLink() || !pair.isFile()) fail("payload has an unproven extra link", { path: payloadPath });
    if (Number(pair.nlink) !== 2 || !identitiesEqual(fileIdentity(pair), fileIdentity(stat))) {
      fail("payload has an unproven extra link", { path: payloadPath });
    }
  }
  let bytes;
  try {
    bytes = await readRegularFileNoFollow(payloadPath, { maxBytes, allowMissing: true });
  } catch (error) {
    if (error.code === "EFBIG") fail("payload exceeds the maximum payload size", { path: payloadPath });
    if (error.code === "ELOOP") fail("payload is a symbolic link", { path: payloadPath });
    if (error.code === "EFTYPE" || error.code === "EBUSY") {
      fail("payload is not a stable regular file", { path: payloadPath });
    }
    if (error.code === "EACCES" || error.code === "EPERM") fail("payload is not readable", { path: payloadPath });
    throw error;
  }
  if (bytes === null) return null;
  return { path: payloadPath, bytes, size: bytes.length, sha256: sha256Bytes(bytes), identity: fileIdentity(stat) };
}

/**
 * Reads one exact payload: strict name, no-follow regular owner-only file,
 * exactly one link (B4), bounded size, digest verified when an expected digest
 * is supplied. The single exception to the one-link rule is the explicitly
 * proven interrupted publish pair: pass `allowLinkedPair` with the derived
 * transient path and a two-link payload is accepted only while that exact
 * path holds the same strong identity. Missing returns null only with
 * `allowMissing: true`. The returned `identity` is the strong tagged file
 * identity of the exact bytes that were read; callers that later publish or
 * delete this payload must carry it through and re-verify it immediately
 * before the destructive step (B2/B3).
 */
export async function readPayload(
  payloadPath,
  { expectedSha256, allowMissing = false, maxBytes, allowLinkedPair = null } = {},
) {
  if (typeof payloadPath !== "string") throw new TypeError("payloadPath must be a string");
  parsePayloadPath(payloadPath, "payloadPath");
  if (expectedSha256 !== undefined && expectedSha256 !== null) requireDigest(expectedSha256, "expectedSha256");
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    throw new TypeError("maxBytes must be a non-negative safe integer");
  }
  if (allowLinkedPair !== null && (typeof allowLinkedPair !== "string" || allowLinkedPair === "")) {
    throw new TypeError("allowLinkedPair must be a non-empty path string");
  }
  // B4: the only tolerated second name is this payload's own derived
  // transient - an arbitrary alias can never be a proven interrupted pair.
  if (allowLinkedPair !== null && allowLinkedPair !== payloadTransientPath(payloadPath)) {
    fail("payload has an unproven extra link", { path: payloadPath });
  }
  const record = await readPayloadRecord(payloadPath, {
    ...(maxBytes === undefined ? {} : { maxBytes }),
    allowLinkedPair,
  });
  if (record === null) {
    if (allowMissing) return null;
    fail("payload is missing", { path: payloadPath });
  }
  if (expectedSha256 !== undefined && expectedSha256 !== null && record.sha256 !== expectedSha256) {
    throw conflict("payload content does not match the recorded digest", { path: payloadPath });
  }
  return Object.freeze({
    path: record.path,
    bytes: record.bytes,
    size: record.size,
    sha256: record.sha256,
    identity: record.identity,
  });
}

function mapTargetReadError(error) {
  const code = error && error.code;
  if (
    code === "ELOOP"
    || code === "EFTYPE"
    || code === "EBUSY"
    || code === "EFBIG"
    || code === "EACCES"
    || code === "EPERM"
  ) {
    return conflict("the file is not the readable regular file that was planned");
  }
  return error;
}

function validateFilePlans(transactionId, filePlans) {
  if (typeof transactionId !== "string" || !SHA256_PATTERN.test(transactionId)) {
    fail("transactionId must be a lowercase sha256 hex digest");
  }
  if (!Array.isArray(filePlans)) throw new TypeError("filePlans must be an array");
  if (filePlans.length > MAX_FILE_RECORDS) fail(`filePlans must hold at most ${MAX_FILE_RECORDS} entries`);
  const seen = new Set();
  return filePlans.map((plan, index) => {
    const label = `file plan ${index}`;
    requirePlainObject(plan, label);
    rejectUnknownKeys(plan, ["target", "role", "afterBytes", "expectedBefore"], label);
    requireKeys(plan, ["target", "role", "afterBytes"], label);
    const target = requireAbsolutePath(plan.target, `${label}.target`);
    if (seen.has(target)) fail("file plans must not repeat a target");
    seen.add(target);
    requireBoundedString(plan.role, `${label}.role`, { max: 64 });
    if (!FILE_ROLES.includes(plan.role)) fail(`${label}.role is not a supported role`);
    if (!(plan.afterBytes instanceof Uint8Array)) throw new TypeError(`${label}.afterBytes must be a Uint8Array`);
    if (plan.afterBytes.length > DEFAULT_MAX_FILE_BYTES) {
      fail(`${label}.afterBytes exceeds the maximum payload size`);
    }
    let expectedBefore = null;
    if (plan.expectedBefore !== undefined && plan.expectedBefore !== null) {
      const expected = plan.expectedBefore;
      requirePlainObject(expected, `${label}.expectedBefore`);
      rejectUnknownKeys(expected, ["exists", "sha256"], `${label}.expectedBefore`);
      requireKeys(expected, ["exists", "sha256"], `${label}.expectedBefore`);
      requireBoolean(expected.exists, `${label}.expectedBefore.exists`);
      if (expected.exists) {
        requireDigest(expected.sha256, `${label}.expectedBefore.sha256`);
      } else if (expected.sha256 !== null) {
        fail(`${label}.expectedBefore.sha256 must be null when the file is absent`);
      }
      expectedBefore = { exists: expected.exists, sha256: expected.exists ? expected.sha256 : null };
    }
    return { target, role: plan.role, afterBytes: plan.afterBytes, expectedBefore };
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const MAX_ADOPTION_ATTEMPTS = 20;
const ADOPTION_RETRY_DELAY_MS = 25;

async function createPayloadExclusive(payloadPath, bytes, created, lease = null) {
  const digest = sha256Bytes(bytes);
  // Immediate lease assertion right before each exclusive create.
  if (lease && typeof lease.assertHeld === "function") await lease.assertHeld();
  try {
    await durableCreateFile(payloadPath, bytes, { mode: 0o600 });
  } catch (error) {
    if (error.code === "EEXIST" || error.code === "ELOOP" || error.code === "EFTYPE") {
      // Only adopt an existing payload when it already holds exactly the
      // planned bytes; anything else (including a symlink) fails closed. A
      // concurrent creator can still be mid-write, so briefly retry reads of
      // an unstable file before deciding.
      let existing = null;
      for (let attempt = 0; attempt < MAX_ADOPTION_ATTEMPTS; attempt += 1) {
        try {
          existing = await readPayload(payloadPath, { allowMissing: true });
          break;
        } catch (readError) {
          const transient = readError.code === JOURNAL_ERROR_CODES.JOURNAL_INVALID
            && typeof readError.message === "string"
            && readError.message.includes("not a stable regular file");
          if (!transient || attempt === MAX_ADOPTION_ATTEMPTS - 1) throw readError;
          await delay(ADOPTION_RETRY_DELAY_MS);
        }
      }
      if (existing === null) throw conflict("the payload path disappeared while creating it", { path: payloadPath });
      if (existing.sha256 !== digest) {
        throw conflict("an existing payload does not match the planned content", { path: payloadPath });
      }
      return { created: false };
    }
    throw error;
  }
  const stat = await fsp.lstat(payloadPath);
  created.push({ path: payloadPath, identity: fileIdentity(stat), size: bytes.length, digest });
  return { created: true };
}

async function rollbackCreatedPayloads(created, lease = null) {
  for (const entry of [...created].reverse()) {
    try {
      const stat = await fsp.lstat(entry.path);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      if (!identitiesEqual(fileIdentity(stat), entry.identity)) continue;
      const bytes = await readRegularFileNoFollow(entry.path, { maxBytes: entry.size, allowMissing: true });
      if (bytes === null || bytes.length !== entry.size || sha256Bytes(bytes) !== entry.digest) continue;
      // Immediate lease assertion right before each compensating removal; a
      // lost lease stops the rollback and leaves the payload for recovery.
      // The removal is attributed (B1): only the exact identity this call
      // recorded and re-proved here may be unlinked, so a replacement
      // survives.
      if (lease && typeof lease.assertHeld === "function") await lease.assertHeld();
      await durableUnlink(entry.path, fileIdentity(stat));
      await syncDirectory(path.dirname(entry.path));
    } catch {
      // Best effort: the original failure is what the caller observes.
    }
  }
}

/**
 * Prepares exact before/after payload files adjacent to each target. Reads the
 * current target bytes no-follow (or records absence), optionally compares
 * them against an observed `expectedBefore`, exclusively and durably creates
 * both 0600 payloads, and returns strict journal-ready file records containing
 * only paths/digests - never raw bytes. On any failure only payloads this call
 * created are removed, after identity and digest checks. The lease is asserted
 * before and after.
 */
export async function prepareFilePayloads(transactionId, filePlans, { lease } = {}) {
  const plans = validateFilePlans(transactionId, filePlans);
  await assertLeaseHeld(lease, "prepare file payloads");

  const controlDirectory = lease && lease.paths ? lease.paths.controlDirectory : null;
  if (controlDirectory) {
    for (const plan of plans) {
      if (plan.target === controlDirectory || isInside(controlDirectory, plan.target)) {
        fail("file target must not overlap the control directory");
      }
    }
  }

  const created = [];
  const records = [];
  try {
    for (const plan of plans) {
      const beforePath = payloadPathFor(plan.target, transactionId, "before");
      const afterPath = payloadPathFor(plan.target, transactionId, "after");

      let targetBytes = null;
      try {
        targetBytes = await readRegularFileNoFollow(plan.target, {
          maxBytes: DEFAULT_MAX_FILE_BYTES,
          allowMissing: true,
        });
      } catch (error) {
        throw mapTargetReadError(error);
      }
      const beforeExists = targetBytes !== null;
      const beforeDigest = beforeExists ? sha256Bytes(targetBytes) : null;
      if (plan.expectedBefore !== null) {
        const matches = plan.expectedBefore.exists === beforeExists
          && (plan.expectedBefore.exists === false || plan.expectedBefore.sha256 === beforeDigest);
        if (!matches) throw conflict("the target changed since it was last observed", { path: plan.target });
      }

      const before = { exists: beforeExists, sha256: beforeDigest, payloadPath: null };
      if (beforeExists) {
        await createPayloadExclusive(beforePath, targetBytes, created, lease);
        before.payloadPath = beforePath;
      }
      await createPayloadExclusive(afterPath, plan.afterBytes, created, lease);

      records.push({
        target: plan.target,
        role: plan.role,
        status: "prepared",
        before,
        after: { exists: true, sha256: sha256Bytes(plan.afterBytes), payloadPath: afterPath },
      });
    }
  } catch (error) {
    await rollbackCreatedPayloads(created, lease);
    throw error;
  }

  await assertLeaseHeld(lease, "prepare file payloads");
  const frozen = records.map((record) => ({
    ...record,
    before: { ...record.before },
    after: { ...record.after },
  }));
  return deepFreeze(frozen);
}

/**
 * Classifies the observed target content against one validated file record and
 * returns `{ status, identity }`:
 *   - `status` is "after" (desired content present), "before" (pre-transaction
 *     content), "absent" (target missing), or "conflict" (anything else,
 *     including a non-regular/unreadable target).
 *   - `identity` is the strong tagged identity observed on the very handle the
 *     bytes were read through (null when absent/unreadable), so an apply or
 *     restore can carry *this classified entry's* identity through its
 *     claim-and-publish steps (B2).
 *
 * Read-only: concurrent content is preserved.
 */
export async function classifyJournalFileEntry(fileRecord) {
  const record = validateFileRecord(fileRecord, {});
  let read;
  try {
    read = await readRegularFileNoFollow(record.target, {
      maxBytes: DEFAULT_MAX_FILE_BYTES,
      allowMissing: true,
      withIdentity: true,
    });
  } catch (error) {
    if (error && error.code === "ENOENT") return { status: "absent", identity: null };
    const mapped = mapTargetReadError(error);
    if (mapped !== error) return { status: "conflict", identity: null };
    throw mapped;
  }
  if (read === null) return { status: "absent", identity: null };
  const digest = sha256Bytes(read.bytes);
  if (digest === record.after.sha256) return { status: "after", identity: read.identity };
  if (record.before.exists && digest === record.before.sha256) {
    return { status: "before", identity: read.identity };
  }
  return { status: "conflict", identity: read.identity };
}

/** Status-only view of `classifyJournalFileEntry` (historical contract). */
export async function classifyJournalFile(fileRecord) {
  return (await classifyJournalFileEntry(fileRecord)).status;
}

/**
 * Deletes only the exact recorded payload paths, each verified first:
 * strict payload name, regular owner-only current-uid file, bounded size, and
 * a content digest equal to the recorded descriptor. Altered, symlinked, or
 * foreign payloads are refused (altered => RECOVERY_CONFLICT, invalid type =>
 * JOURNAL_INVALID) and never deleted; already-absent payloads are skipped.
 * The lease is asserted before and after.
 */
export async function cleanupPayloads(fileRecords, { lease } = {}) {
  if (!Array.isArray(fileRecords)) throw new TypeError("fileRecords must be an array");
  if (fileRecords.length > MAX_FILE_RECORDS) fail(`fileRecords must hold at most ${MAX_FILE_RECORDS} records`);
  await assertLeaseHeld(lease, "clean up payloads");

  const validated = fileRecords.map((record) => validateFileRecord(record, {}));
  const targets = new Set();
  let transactionId = null;
  for (const record of validated) {
    if (targets.has(record.target)) fail("file records must not repeat a target");
    targets.add(record.target);
    const recordTransactionId = parsePayloadPath(record.after.payloadPath, "file after descriptor payloadPath")
      .transactionId;
    if (transactionId === null) transactionId = recordTransactionId;
    else if (transactionId !== recordTransactionId) fail("payload records belong to different transactions");
  }

  const removed = [];
  for (const record of validated) {
    const pairs = [];
    if (record.before.payloadPath !== null) {
      pairs.push({ path: record.before.payloadPath, sha256: record.before.sha256 });
    }
    pairs.push({ path: record.after.payloadPath, sha256: record.after.sha256 });
    for (const pair of pairs) {
      let stat;
      try {
        stat = await fsp.lstat(pair.path);
      } catch (error) {
        if (error && error.code === "ENOENT") continue;
        throw error;
      }
      if (stat.isSymbolicLink() || !stat.isFile()) fail("payload is not a regular file", { path: pair.path });
      if (process.platform !== "win32") {
        if (!isOwnerOnlyMode(stat.mode)) fail("payload must be owner-only", { path: pair.path });
        if (typeof process.getuid === "function" && Number(stat.uid) !== process.getuid()) {
          fail("payload must be owned by the current user", { path: pair.path });
        }
      }
      const identity = fileIdentity(stat);
      // Deleting a payload is a destructive exact-entry operation: a payload
      // this filesystem cannot prove by identity is preserved, never removed.
      if (!isIdentityAvailable(identity)) {
        throw conflict("payload file identity cannot be proven; it was preserved", { path: pair.path });
      }
      const payload = await readPayloadRecord(pair.path);
      if (payload === null) continue;
      if (payload.sha256 !== pair.sha256) {
        throw conflict("payload was altered and will not be deleted", { path: pair.path });
      }
      let again;
      try {
        again = await fsp.lstat(pair.path);
      } catch (error) {
        if (error && error.code === "ENOENT") continue;
        throw error;
      }
      if (!identitiesEqual(fileIdentity(again), identity)) {
        throw conflict("payload changed while it was being verified", { path: pair.path });
      }
      // Immediate lease assertion right before each destructive unlink, after
      // every intervening probe/read/stat of this iteration.
      await assertLeaseHeld(lease, "clean up payloads");
      try {
        // Claim-based exact removal (B1): durableUnlink renames to a fresh
        // unpredictable claim and unlinks only a claim that still matches the
        // exact identity this cleanup attributed to the payload; a replaced or
        // unprovable entry is preserved.
        await durableUnlink(pair.path, identity);
      } catch (error) {
        if (error && error.code === "ENOENT") continue;
        if (error && error.code === "ENOTSUP") {
          throw conflict("payload file identity cannot be proven; it was preserved", { path: pair.path });
        }
        if (error && error.code === "EBUSY") {
          throw conflict("the payload was replaced while it was being removed; it was preserved", { path: pair.path });
        }
        throw error;
      }
      removed.push(pair.path);
    }
  }
  await assertLeaseHeld(lease, "clean up payloads");
  return Object.freeze({ removed: Object.freeze(removed) });
}

/**
 * Removes only *proven* `<payload>.tmp` transients derived from recorded
 * payload paths (see `payloadTransientPath`).
 *
 * B3: a derived pathname is not ownership. This cleanup has no recorded
 * transient identity to compare against (the journal schema is unchanged), so
 * a transient is proven only by its content: it must be a regular, owner-only,
 * current-uid file with a strong identity whose bytes hash to exactly the
 * recorded payload digest for that side - the journal already owns those
 * bytes, so removing a content-identical file can destroy nothing that is not
 * reproducible from the journal. Partial (interrupted-write) or content-foreign
 * transients are *preserved*, never deleted; a symlinked, over-permissive, or
 * unprovable transient fails closed and is preserved. A proven transient is
 * removed through the claim-based exact removal (B1) with an immediate
 * re-verification. Missing transients are skipped, so this stays idempotent
 * and safe to run before payload and journal cleanup. The lease is asserted
 * before and after.
 */
export async function cleanupPayloadTransients(fileRecords, { lease } = {}) {
  if (!Array.isArray(fileRecords)) throw new TypeError("fileRecords must be an array");
  if (fileRecords.length > MAX_FILE_RECORDS) fail(`fileRecords must hold at most ${MAX_FILE_RECORDS} records`);
  await assertLeaseHeld(lease, "clean up payload transients");

  const validated = fileRecords.map((record) => validateFileRecord(record, {}));
  const removed = [];
  for (const record of validated) {
    const payloads = [
      { path: record.before.payloadPath, digest: record.before.sha256 },
      { path: record.after.payloadPath, digest: record.after.sha256 },
    ];
    for (const pair of payloads) {
      if (pair.path === null) continue;
      const transient = payloadTransientPath(pair.path);
      let stat;
      try {
        stat = await fsp.lstat(transient);
      } catch (error) {
        if (error && error.code === "ENOENT") continue;
        throw error;
      }
      if (stat.isSymbolicLink() || !stat.isFile()) {
        fail("payload transient is not a regular file", { path: transient });
      }
      if (process.platform !== "win32") {
        if (!isOwnerOnlyMode(stat.mode)) fail("payload transient must be owner-only", { path: transient });
        if (typeof process.getuid === "function" && Number(stat.uid) !== process.getuid()) {
          fail("payload transient must be owned by the current user", { path: transient });
        }
      }
      const identity = fileIdentity(stat);
      if (!isIdentityAvailable(identity)) {
        // Temp cleanup never removes an entry whose identity this filesystem
        // cannot prove: the transient is preserved for a human.
        throw conflict("payload transient identity cannot be proven; it was preserved", { path: transient });
      }
      // Content proof: only a transient holding exactly the recorded payload
      // bytes may ever be removed here. Partial or content-foreign transients
      // are preserved without failing the recovery.
      let bytes;
      try {
        bytes = await readRegularFileNoFollow(transient, { maxBytes: DEFAULT_MAX_FILE_BYTES, allowMissing: true });
      } catch (error) {
        if (error && (error.code === "ELOOP" || error.code === "EFTYPE" || error.code === "EBUSY")) {
          fail("payload transient is not a stable regular file", { path: transient });
        }
        throw error;
      }
      if (bytes === null || sha256Bytes(bytes) !== pair.digest) continue;
      // Immediate lease assertion right before each destructive unlink.
      await assertLeaseHeld(lease, "clean up payload transients");
      try {
        await durableUnlink(transient, identity);
      } catch (error) {
        if (error && error.code === "ENOENT") continue;
        if (error && error.code === "ENOTSUP") {
          throw conflict("payload transient identity cannot be proven; it was preserved", { path: transient });
        }
        if (error && error.code === "EBUSY") {
          throw conflict("the payload transient was replaced while it was being removed; it was preserved", {
            path: transient,
          });
        }
        throw error;
      }
      removed.push(transient);
    }
  }
  await assertLeaseHeld(lease, "clean up payload transients");
  return Object.freeze({ removed: Object.freeze(removed) });
}
