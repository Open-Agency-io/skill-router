import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyManagedTransaction } from "../src/transaction.js";

test("rolls back state and files when verification fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-transaction-"));
  const state = path.join(root, "state");
  const staged = path.join(root, "staged");
  const config = path.join(root, "config.json");
  await mkdir(state);
  await mkdir(staged);
  await writeFile(path.join(state, ".skill-router-owned"), "skill-router-state-v1\n");
  await writeFile(path.join(state, "value"), "old-state");
  await writeFile(path.join(staged, "value"), "new-state");
  await writeFile(config, "old-config");

  try {
    await assert.rejects(
      () =>
        applyManagedTransaction({
          stateDirectory: state,
          stagedDirectory: staged,
          files: [{ path: config, content: "new-config" }],
          verify: () => {
            throw new Error("verification failed");
          },
        }),
      /verification failed/,
    );
    assert.equal(await readFile(path.join(state, "value"), "utf8"), "old-state");
    assert.equal(await readFile(config, "utf8"), "old-config");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects symlinked configuration without removing staged or existing user data incorrectly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-transaction-"));
  const state = path.join(root, "state");
  const staged = path.join(root, "staged");
  const target = path.join(root, "target.json");
  const link = path.join(root, "config.json");
  await mkdir(staged);
  await writeFile(path.join(staged, ".skill-router-owned"), "skill-router-state-v1\n");
  await writeFile(target, "user-data");
  await symlink(target, link);
  try {
    await assert.rejects(
      () => applyManagedTransaction({ stateDirectory: state, stagedDirectory: staged, files: [{ path: link, content: "new" }] }),
      /non-regular file/,
    );
    assert.equal(await readFile(target, "utf8"), "user-data");
    await assert.rejects(() => access(staged), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
