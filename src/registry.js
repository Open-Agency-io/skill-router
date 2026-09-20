import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sourceFingerprint(entries) {
  const material = entries
    .map((entry) => ({ ...entry }))
    .sort(
      (a, b) =>
        (a.sourceIndex ?? 0) - (b.sourceIndex ?? 0) ||
        (a.path ?? a.source ?? "").localeCompare(b.path ?? b.source ?? "") ||
        (a.kind ?? "").localeCompare(b.kind ?? ""),
    );
  return createHash("sha256").update(canonical(material)).digest("hex");
}

export function buildRegistry(discovery, options = {}) {
  const diagnostics = [...(discovery.diagnostics ?? [])];
  const replacements = options.replace ?? Object.create(null);
  const enabled = options.enabled ?? Object.create(null);
  const groups = new Map();
  for (const skill of discovery.skills) {
    const group = groups.get(skill.id) ?? [];
    group.push(skill);
    groups.set(skill.id, group);
  }

  const effective = [];
  for (const [id, candidates] of groups) {
    candidates.sort((a, b) => a.sourceIndex - b.sourceIndex || a.path.localeCompare(b.path));
    const topIndex = candidates.at(-1).sourceIndex;
    const winners = candidates.filter((candidate) => candidate.sourceIndex === topIndex);
    const hasReplacement = Object.hasOwn(replacements, id);
    if (winners.length > 1 && !hasReplacement) {
      diagnostics.push({
        level: "error",
        code: "duplicate-id",
        id,
        message: `Skill ${id} is defined more than once at the same precedence`,
        paths: winners.map((candidate) => candidate.path),
      });
      continue;
    }

    const winner = hasReplacement
      ? candidates.find((candidate) => candidate.path === replacements[id])
      : winners.at(-1);
    if (!winner) {
      diagnostics.push({
        level: "error",
        code: "invalid-replacement",
        id,
        message: `Replacement path for ${id} was not discovered`,
      });
      continue;
    }
    if (candidates.length > 1) {
      diagnostics.push({
        level: "warning",
        code: "overridden-id",
        id,
        message: `Skill ${id} uses the highest-precedence source`,
        selected: winner.path,
        overridden: candidates.filter((candidate) => candidate !== winner).map((candidate) => candidate.path),
      });
    }

    effective.push({
      id: winner.id,
      name: winner.name,
      description: winner.description,
      ...(winner.compatibility ? { compatibility: winner.compatibility } : {}),
      source: winner.path,
      enabled: Object.hasOwn(enabled, id) ? enabled[id] : true,
    });
  }

  effective.sort((a, b) => a.id.localeCompare(b.id));
  return {
    schemaVersion: 1,
    fingerprint: sourceFingerprint(discovery.fingerprintEntries ?? discovery.skills),
    skills: effective,
    diagnostics,
  };
}

export async function writeJsonAtomic(file, value) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
