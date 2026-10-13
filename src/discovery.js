import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { BOUNDED_WALK_SKIP_NAMES, boundedWalk, createWalkBudget, isBoundedWalkLimit, readBoundedFile } from "./bounded-walk.js";
import { parseFrontmatter, skillMetadata } from "./frontmatter.js";
import { classifyId } from "./identifiers.js";

// Compatibility re-export: identifiers.js owns the shared grammar.
export { PORTABLE_ID } from "./identifiers.js";

/** Detailed invalid-ID diagnostics per source; the rest collapse to one summary. */
const MAX_INVALID_ID_SAMPLES = 20;
const MAX_PATH_DISPLAY = 160;

/**
 * Bounded, control-safe rendering of a source-relative path for diagnostics.
 * Control characters are replaced and long paths are truncated, so a hostile
 * directory name can never inject terminal escapes or unbounded text.
 */
function displayPath(relative) {
  const normalized = relative.split(path.sep).join("/").replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
  return normalized.length > MAX_PATH_DISPLAY ? `${normalized.slice(0, MAX_PATH_DISPLAY)}...` : normalized;
}

/**
 * Candidate skill files under one source directory, found with the shared
 * bounded, no-follow walk: `.git` and `node_modules` subtrees are counted but
 * never opened, symlinks and special files are silently skipped exactly as
 * before (their diagnostics belong to later reads), and the traversal stops
 * with a `BoundedWalkError` the moment any fixed limit is exceeded. Root-level
 * `*.md` files and any `SKILL.md` are candidates; nothing is read here, so the
 * caller can charge the candidate bodies against the same budget afterwards.
 */
async function walkSkillFiles(root, budget) {
  const files = [];

  await boundedWalk(root, {
    budget,
    skipNames: BOUNDED_WALK_SKIP_NAMES,
    onFile: (entry) => {
      const rootLevel = !entry.relative.includes("/");
      if ((rootLevel && entry.name.endsWith(".md")) || entry.name === "SKILL.md") {
        files.push({ absolute: entry.absolute, relative: entry.relative });
      }
    },
  });

  return files;
}

function deriveID(relative, directFile = false, absolute = relative) {
  return directFile && path.basename(relative) === "SKILL.md"
    ? path.basename(path.dirname(absolute))
    : relative === "SKILL.md"
    ? "SKILL"
    : path.basename(relative) === "SKILL.md"
    ? path.basename(path.dirname(relative))
    : path.basename(relative, ".md");
}

function diagnostic(level, code, message, details = {}) {
  return { level, code, message, ...details };
}

/**
 * One skill source, fully inventoried or fully refused.
 *
 * A `BoundedWalkError` from the shared bounded traversal or from any candidate
 * body read collapses the whole result to a single blocking `source-limit-exceeded`
 * diagnostic (carrying only the stable reason enum, never a path) with no
 * partial skill inventory and no partial candidate fingerprints.
 *
 * `options.limits` is a narrow test-only injection seam for the shared walk
 * budget; production callers pass nothing and get the fixed defaults.
 */
export async function discoverSource(source, sourceIndex = 0, options = {}) {
  const root = path.resolve(source);
  const diagnostics = [];
  const skills = [];
  const fingerprintEntries = [];

  let stat;
  try {
    stat = await lstat(root);
  } catch (error) {
    if (error.code === "ENOENT") {
      fingerprintEntries.push({ kind: "source", source: root, sourceIndex, status: "missing" });
      return {
        root,
        skills,
        fingerprintEntries,
        diagnostics: [diagnostic("error", "source-not-found", `Skill source does not exist: ${root}`)],
      };
    }
    throw error;
  }
  if (!stat.isDirectory() && !(stat.isFile() && root.endsWith(".md"))) {
    fingerprintEntries.push({ kind: "source", source: root, sourceIndex, status: "not-directory" });
    return {
      root,
      skills,
      fingerprintEntries,
      diagnostics: [diagnostic("error", "source-not-directory", `Skill source is not a directory: ${root}`)],
    };
  }

  const directFile = stat.isFile();
  const sourceEntry = {
    kind: "source",
    source: root,
    sourceIndex,
    status: directFile ? "file" : "directory",
  };

  // One budget spans the traversal and every candidate body read, so entries,
  // per-file bytes, and aggregate bytes are all decided by one bounded view of
  // the source. `options.limits` is a test-only injection seam; production
  // callers pass nothing and run on the fixed shared defaults.
  const budget = createWalkBudget(options.limits);
  let inventory;
  try {
    inventory = await collectSourceInventory(root, sourceIndex, directFile, budget);
  } catch (error) {
    if (!isBoundedWalkLimit(error)) throw error;
    // A bound failure blocks the whole source: no partial skill inventory and
    // no partial candidate fingerprints survive it — exactly one coded,
    // path-free diagnostic and the source entry itself.
    return {
      root,
      skills: [],
      fingerprintEntries: [sourceEntry],
      diagnostics: [
        diagnostic(
          "error",
          "source-limit-exceeded",
          `Skill source exceeds the supported size limits (reason: ${error.reason})`,
          { reason: error.reason },
        ),
      ],
    };
  }

  return {
    root,
    skills: inventory.skills,
    diagnostics: inventory.diagnostics,
    fingerprintEntries: [sourceEntry, ...inventory.fingerprintEntries],
  };
}

/**
 * The bounded candidate loop behind `discoverSource`. Throws any
 * `BoundedWalkError` upward — including one raised by a candidate body read —
 * so the caller can drop everything collected here and report the single
 * blocking diagnostic instead of a partial inventory.
 */
async function collectSourceInventory(root, sourceIndex, directFile, budget) {
  const diagnostics = [];
  const skills = [];
  const fingerprintEntries = [];

  const candidates = directFile
    ? [{ absolute: root, relative: path.basename(root) }]
    : await walkSkillFiles(root, budget);

  let invalidIdCount = 0;

  for (const file of candidates) {
    const id = deriveID(file.relative, directFile, file.absolute);
    const problem = classifyId(id);

    // Candidate freshness covers rejected files too: fixing or removing an
    // invalid file must change the source fingerprint. The body is always
    // read and hashed when readable, and parsing is always attempted.
    let text;
    let parsed;
    let failure = null;
    try {
      text = (await readBoundedFile(file.absolute, budget)).toString("utf8");
      fingerprintEntries.push({
        kind: "candidate",
        source: root,
        sourceIndex,
        path: file.absolute,
        contentHash: createHash("sha256").update(text).digest("hex"),
      });
    } catch (error) {
      // Only a bound failure aborts the source; every other read problem keeps
      // the established bounded "unreadable candidate" treatment.
      if (isBoundedWalkLimit(error)) throw error;
      failure = "read";
      fingerprintEntries.push({
        kind: "candidate",
        source: root,
        sourceIndex,
        path: file.absolute,
        status: "unreadable",
      });
    }
    if (failure === null) {
      try {
        parsed = parseFrontmatter(text);
      } catch {
        failure = "frontmatter";
      }
    }

    if (problem) {
      // A derived ID that is not a portable public ID rejects the candidate
      // outright — even when the body is unreadable or unparseable. Exactly
      // one capped invalid-ID diagnostic describes it; no parallel parse
      // error may leak the raw cause, the absolute path, or the ID.
      invalidIdCount += 1;
      if (invalidIdCount <= MAX_INVALID_ID_SAMPLES) {
        diagnostics.push(
          diagnostic(
            "error",
            "invalid-skill-id",
            `Skill file was omitted: derived skill ID is not a portable public ID (reason: ${problem})`,
            { reason: problem, path: displayPath(file.relative) },
          ),
        );
      }
      continue;
    }

    if (failure !== null) {
      // A valid ID whose body cannot be loaded keeps the established error
      // code, but its shape is fixed and bounded: a source-relative display
      // path, a fixed reason code, and the (already validated, therefore
      // bounded and control-free) ID — never the raw cause, errno, syscall
      // text, absolute path, or file content.
      diagnostics.push(
        diagnostic("error", "invalid-skill", `Skill file cannot be loaded (reason: ${failure})`, {
          reason: failure,
          path: displayPath(file.relative),
          id,
        }),
      );
      continue;
    }

    const metadata = skillMetadata(parsed.attributes);
    if (!metadata.description) {
      diagnostics.push(
        diagnostic("warning", "missing-description", `Skill ${id} has no routing description`, {
          path: file.absolute,
          id,
        }),
      );
    }

    skills.push({
      id,
      name: metadata.name || id,
      description: metadata.description || "",
      compatibility: metadata.compatibility,
      opencodeAutoinvoke: metadata.opencodeAutoinvoke,
      source: root,
      path: file.absolute,
      relativePath: file.relative.split(path.sep).join("/"),
      sourceIndex,
      contentHash: fingerprintEntries.at(-1).contentHash,
    });
  }

  if (invalidIdCount > MAX_INVALID_ID_SAMPLES) {
    diagnostics.push(
      diagnostic(
        "error",
        "invalid-skill-id-overflow",
        `Source omitted ${invalidIdCount} files with invalid skill IDs; only the first ${MAX_INVALID_ID_SAMPLES} are reported in detail`,
        { suppressed: invalidIdCount - MAX_INVALID_ID_SAMPLES },
      ),
    );
  }

  return { skills, diagnostics, fingerprintEntries };
}

export async function discoverSources(sources) {
  const results = await Promise.all(sources.map((source, index) => discoverSource(source, index)));
  return {
    skills: results.flatMap((result) => result.skills),
    diagnostics: results.flatMap((result) => result.diagnostics),
    fingerprintEntries: results.flatMap((result) => result.fingerprintEntries),
    sources: results.map((result) => result.root),
  };
}
