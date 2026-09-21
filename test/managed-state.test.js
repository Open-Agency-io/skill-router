import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stageManagedState } from "../src/managed-state.js";

test("rejects case-insensitive managed destination collisions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  const lower = path.join(root, "lower.md");
  const upper = path.join(root, "upper.md");
  await writeFile(lower, "lower\n");
  await writeFile(upper, "upper\n");
  const registry = {
    skills: [
      { id: "skill", name: "skill", description: "lower", source: lower, enabled: true },
      { id: "SKILL", name: "SKILL", description: "upper", source: upper, enabled: true },
    ],
  };
  try {
    await assert.rejects(() => stageManagedState(path.join(root, "state"), registry), /collide/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reserves the generated router ID case-insensitively", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-managed-"));
  const source = path.join(root, "source.md");
  await writeFile(source, "source\n");
  try {
    await assert.rejects(
      () =>
        stageManagedState(path.join(root, "state"), {
          skills: [{ id: "Skill-Router", name: "Collision", description: "Collision", source, enabled: true }],
        }),
      /collide/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
