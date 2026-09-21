import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { planOpenCodeConfig } from "../src/opencode.js";

test("preserves strict JSON fields and adds the managed source idempotently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-opencode-"));
  const file = path.join(root, "opencode.json");
  try {
    await writeFile(file, JSON.stringify({ model: "example/model", skills: ["./team"] }));
    const first = await planOpenCodeConfig(file, "/managed");
    assert.equal(first.config.model, "example/model");
    assert.deepEqual(first.config.skills, ["./team", "/managed"]);
    await writeFile(file, first.content);
    const second = await planOpenCodeConfig(file, "/managed");
    assert.deepEqual(second.config.skills, ["./team", "/managed"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns a usable manual action rather than rewriting JSONC comments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-opencode-"));
  const file = path.join(root, "opencode.json");
  try {
    await writeFile(file, '{\n  // keep this\n  "skills": []\n}\n');
    const plan = await planOpenCodeConfig(file, "/managed");
    assert.equal(plan.manual, true);
    assert.equal(plan.content, null);
    assert.match(plan.instruction, /Add.*managed.*skills array/);
    await writeFile(file, '{\n  // keep this\n  "skills": ["/managed"],\n}\n');
    const configured = await planOpenCodeConfig(file, "/managed");
    assert.equal(configured.manual, true);
    assert.equal(configured.content, null);
    assert.equal(configured.instruction, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
