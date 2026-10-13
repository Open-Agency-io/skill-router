import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWalkBudget, isBoundedWalkLimit } from "../src/bounded-walk.js";
import { collectSupportFiles, readSkillDocument } from "../src/skill-document.js";

const SKILL = "---\nname: Tree\ndescription: Support tree\n---\n\nBody.\n";

async function makeSkillDirectory(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-skill-document-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "tree"), { recursive: true });
  const skillFile = path.join(root, "tree", "SKILL.md");
  await writeFile(skillFile, SKILL);
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, "tree", relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return { root, skillFile, directory: path.join(root, "tree") };
}

test("reading a skill document is bounded, no-follow, and charges its actual bytes", async (t) => {
  const { skillFile } = await makeSkillDirectory(t, {});

  const budget = createWalkBudget();
  const text = await readSkillDocument(skillFile, budget);
  assert.equal(text, SKILL);
  assert.equal(budget.bytesRead, Buffer.byteLength(SKILL), "the actual bytes are charged once");

  // A fresh call without a budget still runs on the fixed defaults.
  assert.equal(await readSkillDocument(skillFile), SKILL);

  // Per-file and aggregate bounds both refuse instead of loading the document.
  const perFile = createWalkBudget({ maxFileBytes: 4 });
  await assert.rejects(
    readSkillDocument(skillFile, perFile),
    (error) => isBoundedWalkLimit(error) && error.reason === "file-bytes",
  );
  const aggregate = createWalkBudget({ maxTotalBytes: 4 });
  await assert.rejects(
    readSkillDocument(skillFile, aggregate),
    (error) => isBoundedWalkLimit(error) && error.reason === "total-bytes",
  );

  // The refusal never echoes the path or the document.
  const error = await readSkillDocument(skillFile, perFile).then(
    () => null,
    (thrown) => thrown,
  );
  assert.equal(error.message.includes(skillFile), false);
  assert.equal(error.message.includes("Body."), false);
});

test("skill documents keep the established symlink, special-file, and missing diagnostics", async (t) => {
  const { root, skillFile } = await makeSkillDirectory(t, {});
  const linked = path.join(root, "linked.md");
  await symlink(skillFile, linked);
  await assert.rejects(readSkillDocument(linked), /must not be a symlink/);
  await assert.rejects(readSkillDocument(path.join(root, "absent.md")), /does not exist/);

  const pipe = path.join(root, "pipe");
  if (spawnSync("mkfifo", [pipe]).status === 0) {
    await assert.rejects(readSkillDocument(pipe), /must be a regular file/);
  }
});

test("support collection returns sorted files with content, modes, and slash-relative paths", async (t) => {
  const { skillFile, directory } = await makeSkillDirectory(t, {
    "reference.md": "keep\n",
    "docs/guide.md": "guide\n",
    "zeta.txt": "z\n",
  });
  const budget = createWalkBudget();
  const files = await collectSupportFiles(directory, skillFile, { budget });

  assert.deepEqual(files.map((file) => file.relative), ["docs/guide.md", "reference.md", "zeta.txt"]);
  assert.deepEqual(
    files.map((file) => file.content.toString("utf8")),
    ["guide\n", "keep\n", "z\n"],
  );
  for (const file of files) {
    assert.equal(path.isAbsolute(file.absolute), true);
    assert.equal(file.relative.includes("\\"), false, "relative paths are slash-separated");
    assert.equal(typeof file.mode, "number");
  }
  // Every planned byte fits and is charged exactly once, so the collected list
  // itself proves the copy it describes is inside the bounds.
  assert.equal(budget.bytesRead, Buffer.byteLength("guide\n") + Buffer.byteLength("keep\n") + Buffer.byteLength("z\n"));
});

test("support collection skips the skill document, embedded SKILL.md, .git, and node_modules", async (t) => {
  const { skillFile, directory } = await makeSkillDirectory(t, {
    "reference.md": "keep\n",
    "nested/SKILL.md": "---\nname: Nested\ndescription: Embedded\n---\n\nBody\n",
    ".git/config": "[core]\n",
    "node_modules/left-pad/index.js": "module\n",
  });
  const files = await collectSupportFiles(directory, skillFile, { budget: createWalkBudget() });
  assert.deepEqual(files.map((file) => file.relative), ["reference.md"]);
});

test("support collection preserves the symlink and special-file distinctions", async (t) => {
  const { root, skillFile, directory } = await makeSkillDirectory(t, { "reference.md": "keep\n" });
  await symlink(path.join(directory, "reference.md"), path.join(directory, "alias.md"));
  await assert.rejects(
    collectSupportFiles(directory, skillFile),
    /Support file must not be a symlink/,
  );
  await rm(path.join(directory, "alias.md"));

  const pipe = path.join(directory, "pipe");
  if (spawnSync("mkfifo", [pipe]).status === 0) {
    await assert.rejects(collectSupportFiles(directory, skillFile), /Unsupported support file/);
    await rm(pipe, { force: true });
  }
  // A symlinked skill document itself is the caller's assertion to make; the
  // collection never classifies or reads it.
  const linked = path.join(root, "linked-skill.md");
  await symlink(skillFile, linked);
  const files = await collectSupportFiles(directory, linked);
  assert.deepEqual(files.map((file) => file.relative), ["reference.md"]);
});

test("support collection proves every planned file and byte fits inside injected bounds", async (t) => {
  const { skillFile, directory } = await makeSkillDirectory(t, {
    "a.md": "1234",
    "b.md": "5678",
  });
  const supportBytes = 8;

  // Exactly at the aggregate bound: the whole list still collects.
  const exact = createWalkBudget({ maxTotalBytes: supportBytes });
  assert.deepEqual(
    (await collectSupportFiles(directory, skillFile, { budget: exact })).map((file) => file.relative),
    ["a.md", "b.md"],
  );
  assert.equal(exact.bytesRead, supportBytes);

  // One byte short: the collection refuses rather than returning a partial list.
  await assert.rejects(
    collectSupportFiles(directory, skillFile, { limits: { maxTotalBytes: supportBytes - 1 } }),
    (error) => isBoundedWalkLimit(error) && error.reason === "total-bytes",
  );
  await assert.rejects(
    collectSupportFiles(directory, skillFile, { limits: { maxFileBytes: 4, maxTotalBytes: 7 } }),
    (error) => isBoundedWalkLimit(error) && error.reason === "total-bytes",
  );
  // A single support file over the per-file bound refuses too.
  await assert.rejects(
    collectSupportFiles(directory, skillFile, { limits: { maxFileBytes: 3 } }),
    (error) => isBoundedWalkLimit(error) && error.reason === "file-bytes",
  );
  // The entry bound covers the whole support tree, skipped entries included.
  await assert.rejects(
    collectSupportFiles(directory, skillFile, { limits: { maxEntries: 2 } }),
    (error) => isBoundedWalkLimit(error) && error.reason === "entries",
  );
  assert.equal(
    (await collectSupportFiles(directory, skillFile, { limits: { maxEntries: 3 } })).length,
    2,
    "exactly at the entry bound the same tree still collects",
  );
});
