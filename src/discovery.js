import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter, skillMetadata } from "./frontmatter.js";

export const PORTABLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function walkSkillFiles(root) {
  const files = [];

  async function visit(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.join(relativeDirectory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(absolute, relative);
      } else if (
        entry.isFile() &&
        ((relativeDirectory === "" && entry.name.endsWith(".md")) || entry.name === "SKILL.md")
      ) {
        files.push({ absolute, relative });
      }
    }
  }

  await visit(root);
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

export async function discoverSource(source, sourceIndex = 0) {
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
  fingerprintEntries.push({
    kind: "source",
    source: root,
    sourceIndex,
    status: directFile ? "file" : "directory",
  });

  const candidates = directFile
    ? [{ absolute: root, relative: path.basename(root) }]
    : await walkSkillFiles(root);

  for (const file of candidates) {
    const id = deriveID(file.relative, directFile, file.absolute);
    if (id === "SKILL" && file.relative === "SKILL.md" && !directFile) {
      diagnostics.push(
        diagnostic("warning", "root-skill-id", "A source-root SKILL.md has the literal ID SKILL", {
          path: file.absolute,
          id,
        }),
      );
    }
    if (!PORTABLE_ID.test(id) || id.length > 64) {
      diagnostics.push(
        diagnostic("warning", "non-portable-id", `Skill ID is not portable: ${id}`, {
          path: file.absolute,
          id,
        }),
      );
    }

    let text;
    let parsed;
    try {
      text = await readFile(file.absolute, "utf8");
      fingerprintEntries.push({
        kind: "candidate",
        source: root,
        sourceIndex,
        path: file.absolute,
        contentHash: createHash("sha256").update(text).digest("hex"),
      });
      parsed = parseFrontmatter(text);
    } catch (error) {
      if (text === undefined) {
        fingerprintEntries.push({
          kind: "candidate",
          source: root,
          sourceIndex,
          path: file.absolute,
          status: "unreadable",
        });
      }
      diagnostics.push(
        diagnostic("error", "invalid-skill", `Cannot parse ${file.absolute}: ${error.message}`, {
          path: file.absolute,
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

  return { root, skills, diagnostics, fingerprintEntries };
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
