import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseJsonc } from "./jsonc.js";

export async function planOpenCodeConfig(file, skillsDirectory) {
  let config;
  let strict = true;
  try {
    const text = await readFile(file, "utf8");
    try {
      config = JSON.parse(text);
    } catch {
      config = parseJsonc(text, file);
      strict = false;
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      config = { $schema: "https://opencode.ai/config.json" };
    } else {
      throw error;
    }
  }

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`OpenCode configuration must be an object: ${file}`);
  }
  if (config.skills !== undefined && !Array.isArray(config.skills)) {
    throw new Error(`OpenCode skills must be an array: ${file}`);
  }
  const skills = [...(config.skills ?? [])];
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
        : `Add ${JSON.stringify(skillsDirectory)} to the skills array in ${file}`,
    };
  }
  return {
    file,
    config: { ...config, skills },
    content: `${JSON.stringify({ ...config, skills }, null, 2)}\n`,
    manual: false,
  };
}

export async function ensureOpenCodeDirectory(file) {
  await mkdir(path.dirname(file), { recursive: true });
}
