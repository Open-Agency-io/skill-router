import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

async function snapshot(file) {
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Refusing to replace non-regular file: ${file}`);
    return await readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomic(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function applyManagedTransaction({ stateDirectory, stagedDirectory, files, verify }) {
  const stateBackup = `${stateDirectory}.backup-${randomUUID()}`;
  let hadState = false;
  let installedState = false;
  let backups = [];
  try {
    backups = await Promise.all(files.map(async (entry) => ({ ...entry, before: await snapshot(entry.path) })));
    await mkdir(path.dirname(stateDirectory), { recursive: true });
    let stateExists = false;
    try {
      await lstat(stateDirectory);
      stateExists = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (stateExists) {
      const stateStat = await lstat(stateDirectory);
      if (stateStat.isSymbolicLink() || !stateStat.isDirectory()) {
        throw new Error(`Refusing to replace non-directory router state: ${stateDirectory}`);
      }
      let marker;
      try {
        marker = await readFile(path.join(stateDirectory, ".skill-router-owned"), "utf8");
      } catch (error) {
        if (error.code === "ENOENT") throw new Error(`Refusing to replace unowned directory: ${stateDirectory}`);
        throw error;
      }
      if (marker.trim() !== "skill-router-state-v1") {
        throw new Error(`Refusing to replace unowned directory: ${stateDirectory}`);
      }
      await rename(stateDirectory, stateBackup);
      hadState = true;
    }
    await rename(stagedDirectory, stateDirectory);
    installedState = true;
    for (const entry of files) await writeAtomic(entry.path, entry.content);
    await verify?.();
    await rm(stateBackup, { recursive: true, force: true });
  } catch (error) {
    if (installedState) await rm(stateDirectory, { recursive: true, force: true });
    if (hadState) await rename(stateBackup, stateDirectory);
    for (const entry of backups.reverse()) {
      if (entry.before === null) await rm(entry.path, { force: true });
      else await writeAtomic(entry.path, entry.before);
    }
    await rm(stagedDirectory, { recursive: true, force: true });
    throw error;
  }
}

export const transactionInternals = { writeAtomic };
