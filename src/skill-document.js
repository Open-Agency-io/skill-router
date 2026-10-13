import { lstat } from "node:fs/promises";
import { isAlias, isMap, parseDocument, stringify } from "yaml";
import { boundedWalk, createWalkBudget, readBoundedFile } from "./bounded-walk.js";

const SKIPPED_SUPPORT_ENTRIES = new Set([".git", "node_modules"]);

/** OpenCode autoinvocation marker merged into generated OpenCode copies. */
export const OPENCODE_AUTOINVOKE_KEY = "opencode/autoinvoke";

/**
 * Upper bound on alias expansion, mirroring the library's own resource guard
 * (`toJS({ maxAliasCount })` rejects expansion bombs).
 */
const MAX_ALIAS_COUNT = 100;
/** Bound on nesting depth while checking for cycles, so hostile documents can
 * never exhaust the stack while being validated. */
const MAX_ALIAS_DEPTH = 256;

/**
 * Split a skill document into its raw frontmatter and body. Returns `null`
 * when the document carries no frontmatter so callers can decide whether to
 * synthesize one.
 */
export function splitSkillDocument(text) {
  const normalized = String(text).replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return null;
  const lines = normalized.split("\n");
  const closing = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closing === -1) throw new Error("frontmatter is missing its closing --- delimiter");
  return {
    yaml: lines.slice(1, closing).join("\n"),
    body: lines.slice(closing + 1).join("\n"),
  };
}

function frontmatterError(message) {
  return new Error(`Invalid skill frontmatter: ${message}`);
}

/** Bounded, frontmatter-scoped wrapper for alias-expansion failures. */
function aliasFailure(error) {
  const message = String(error?.message ?? error).split("\n")[0].trim();
  return frontmatterError(`alias resolution failed: ${message.slice(0, 160)}`);
}

/**
 * Values for `disable-model-invocation` that a YAML loader treats as "true":
 * YAML 1.2 resolves `true`/`True`/`TRUE`, YAML 1.1 additionally resolves
 * `y`, `yes`, and `on` (any case) to the boolean true, and `1` is truthy for
 * any loose comparison. Anything else — including the false side
 * (`false`, `no`, `off`) — is left alone.
 */
const TRUTHY_INVOCATION_VALUES = new Set(["true", "y", "yes", "on", "1"]);

export function disablesModelInvocation(value) {
  if (value === true) return true;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") return TRUTHY_INVOCATION_VALUES.has(value.trim().toLowerCase());
  return false;
}

/**
 * Reject cyclic or pathologically nested resolved structures without hanging.
 * Aliases may legitimately share sub-documents (a DAG), so ancestors are
 * tracked along the current path only.
 */
function assertResolvableStructure(value, depth = 0, ancestors = new Set()) {
  if (value === null || typeof value !== "object") return;
  if (depth > MAX_ALIAS_DEPTH) {
    throw frontmatterError("alias expansion exceeds the supported nesting depth");
  }
  if (ancestors.has(value)) throw frontmatterError("the document contains a cyclic alias");
  ancestors.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) assertResolvableStructure(child, depth + 1, ancestors);
  ancestors.delete(value);
}

/**
 * Effective, merge- and alias-resolved mapping of one source frontmatter.
 * Every security/control decision (the `disable-model-invocation` gate) and
 * the metadata patch operate on this value rather than on the raw AST, so
 * values inherited through `<<` or anchors are honored. Expansion is bounded
 * by `MAX_ALIAS_COUNT`; malformed, excessive, cyclic, or pathologically deep
 * alias structures fail closed with a frontmatter-scoped message.
 */
function effectiveMapping(doc) {
  let data;
  try {
    data = doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  } catch (error) {
    throw aliasFailure(error);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw frontmatterError("the document must be a YAML mapping");
  }
  assertResolvableStructure(data);
  return data;
}

/** Parse one source frontmatter block with merge-key resolution enabled,
 * failing closed on malformed input. */
function parseSkillYaml(yaml) {
  const doc = parseDocument(yaml, { prettyErrors: true, merge: true });
  if (doc.errors.length) throw frontmatterError(doc.errors[0].message.split("\n")[0]);
  return doc;
}

/**
 * Merge a harness-specific metadata patch into the document's *effective*
 * top-level `metadata` (merge- and alias-resolved). Existing effective keys
 * are preserved; only keys the patch names are set, so a generated OpenCode
 * copy may override a pre-existing `opencode/autoinvoke` value to `false`:
 *
 *   - absent → create an explicit mapping carrying the patch;
 *   - effective value that is not a mapping (scalar, sequence, null) fails
 *     closed rather than being silently replaced;
 *   - an explicit top-level mapping node — including one that itself uses `<<`
 *     — is patched in place, keeping its comments and key order;
 *   - a mapping inherited through a top-level merge (no explicit node) or
 *     represented by an alias is *materialized* as an explicit top-level
 *     mapping holding every effective key/value, then patched. Inherited keys
 *     are never discarded and the patch always wins explicitly.
 */
function applyMetadataPatch(doc, name, effective, patch) {
  if (effective === undefined) {
    doc.set("metadata", { ...patch });
    return;
  }
  const isMapping = effective !== null && typeof effective === "object" && !Array.isArray(effective);
  if (!isMapping) {
    throw new Error(
      `Skill ${JSON.stringify(name)} frontmatter metadata must be a YAML mapping to merge harness metadata; refusing to replace ${JSON.stringify("metadata")}`,
    );
  }
  const node = doc.get("metadata", true);
  if (node !== undefined && !isAlias(node) && isMap(node)) {
    for (const [key, value] of Object.entries(patch)) node.set(key, value);
    return;
  }
  // Merge-derived (no explicit node) or alias-represented metadata: the AST
  // alone cannot carry the inherited keys, so materialize the full effective
  // mapping and then apply the patch.
  doc.set("metadata", { ...effective, ...patch });
}

/**
 * Shared YAML-backed frontmatter transformation for every harness generation
 * path. It parses the *source* document with the `yaml` dependency and
 * merge-key resolution, and bases everything on the effective resolved
 * mapping: every source field is preserved semantically (including unknown
 * harness-specific fields, anchors, and `<<` merges outside the materialized
 * metadata), key order and comments are kept where the library supports them,
 * the body is copied verbatim, only the canonical `name` and the effective
 * registry `description` are overridden, and an optional harness-specific
 * `metadata` patch is applied to the effective metadata. Documents without
 * frontmatter synthesize the canonical identity (plus the patch, when given)
 * and keep the original content as the body. Malformed, duplicate, excessive,
 * cyclic, or pathologically deep YAML fails closed.
 */
export function transformSkillDocument({ text, name, description, metadata = null }) {
  const source = String(text);
  const split = splitSkillDocument(source);
  const effectiveDescription = typeof description === "string" ? description : "";
  if (!split) {
    const synthesized = { name, description: effectiveDescription };
    if (metadata) synthesized.metadata = { ...metadata };
    return `---\n${stringify(synthesized)}---\n${source}`;
  }
  const doc = parseSkillYaml(split.yaml);
  const data = effectiveMapping(doc);
  doc.set("name", name);
  doc.set("description", effectiveDescription);
  if (metadata) applyMetadataPatch(doc, name, data.metadata, metadata);
  let yaml = doc.toString({ lineWidth: 0 });
  if (!yaml.endsWith("\n")) yaml += "\n";
  // `split.body` holds everything after the closing `---` line, so the
  // delimiter's own newline is re-added here and the body stays verbatim.
  return `---\n${yaml}---\n${split.body}`;
}

/**
 * Claude plugin copy: the shared transformation without any metadata patch, so
 * no OpenCode marker is ever injected. Skills that disable model invocation
 * cannot be routed as Claude plugin skills, so the *effective* resolved
 * mapping is checked up front — including values inherited through `<<` merge
 * keys or anchors, multiple merges, and explicit-key precedence — with the
 * complete truthy-value rule.
 */
export function renderClaudeSkill({ text, name, description }) {
  const split = splitSkillDocument(text);
  if (split) {
    const data = effectiveMapping(parseSkillYaml(split.yaml));
    const invocationFlag = data["disable-model-invocation"];
    if (disablesModelInvocation(invocationFlag)) {
      throw new Error(
        `Skill ${JSON.stringify(name)} sets disable-model-invocation: true, which is incompatible with ` +
          `Claude Code plugin skills (resolved from ${JSON.stringify(String(invocationFlag))})`,
      );
    }
  }
  return transformSkillDocument({ text, name, description });
}

/**
 * OpenCode managed copy: the shared transformation plus the harness-specific
 * metadata patch that hides this generated copy from inferred loading. The
 * patch merges into an existing metadata mapping (every other key survives)
 * and may override a pre-existing `opencode/autoinvoke` value, because this
 * generated copy is intentionally hidden.
 */
export function renderOpenCodeSkill({ text, name, description }) {
  return transformSkillDocument({
    text,
    name,
    description,
    metadata: { [OPENCODE_AUTOINVOKE_KEY]: false },
  });
}

/** Rejects symlinks and special files before any document or support copy. */
export async function assertRegularSkillFile(file) {
  let stat;
  try {
    stat = await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Skill document does not exist: ${file}`);
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`Skill document must not be a symlink: ${file}`);
  if (!stat.isFile()) throw new Error(`Skill document must be a regular file: ${file}`);
  return stat;
}

/**
 * Bounded, no-follow read of one source skill document. The regular-file
 * assertion keeps the established symlink/special diagnostics; the bytes are
 * then read through the shared bounded reader, so an oversized document (or an
 * aggregate that no longer fits its budget) fails as a `BoundedWalkError`
 * instead of being loaded whole.
 */
export async function readSkillDocument(file, budget) {
  await assertRegularSkillFile(file);
  return (await readBoundedFile(file, budget)).toString("utf8");
}

/**
 * Support files that belong to a source skill directory. Entries are visited
 * in deterministic lexical order; symlinks and special files are rejected
 * rather than silently skipped so a plugin can never depend on an ambiguous
 * path. Traversal and content reads share one bounded budget (the fixed
 * production limits, or the caller's injected test limits), and every file's
 * actual bytes are charged as they are read — so a collected list always
 * proves that every planned file and byte fits inside the limits before a
 * caller stages a single copy. Entries are returned as
 * `{ absolute, relative, mode, content }` with `/`-separated relative paths.
 */
export async function collectSupportFiles(sourceDirectory, skillFile, options = {}) {
  const budget = options.budget ?? createWalkBudget(options.limits);
  const files = [];

  await boundedWalk(sourceDirectory, {
    budget,
    skipNames: SKIPPED_SUPPORT_ENTRIES,
    // Skipped before typing: the skill document itself is never classified or
    // read here, and an embedded SKILL.md is only skipped when it is a file.
    skip: (entry, dirent) => entry.absolute === skillFile || (dirent.isFile() && entry.name === "SKILL.md"),
    onSymlink: (entry) => {
      throw new Error(`Support file must not be a symlink: ${entry.absolute}`);
    },
    onSpecial: (entry) => {
      throw new Error(`Unsupported support file: ${entry.absolute}`);
    },
    onFile: async (entry) => {
      const content = await readBoundedFile(entry.absolute, budget);
      const stat = await lstat(entry.absolute);
      if (stat.isSymbolicLink()) throw new Error(`Support file must not be a symlink: ${entry.absolute}`);
      files.push({ absolute: entry.absolute, relative: entry.relative, mode: stat.mode & 0o777, content });
    },
  });

  return files;
}
