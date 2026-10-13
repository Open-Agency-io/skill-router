// Phase 6 safety — the fake Claude CLI must never write a real user
// configuration. User-scope mutations are allowed only inside a test temp
// directory (a proven-isolated `CLAUDE_CONFIG_DIR` or `HOME`), and the real
// `~/.claude/settings.json` is refused before any write happens.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertFakeClaudeUserSettingsWritable, emptyFakeClaudeState, runFakeClaude } from "./fake-claude.js";

// The true user home: `os.homedir()` follows $HOME, and the suite itself runs
// under a temporary HOME, so the password database is the only stable source.
function realHome() {
  try {
    return os.userInfo().homedir;
  } catch {
    return os.homedir();
  }
}

const realSettings = path.join(realHome(), ".claude", "settings.json");

async function digestOf(file) {
  try {
    return createHash("sha256").update(await readFile(file)).digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function marketplaceDirectory(root) {
  const directory = path.join(root, "marketplace");
  await mkdir(path.join(directory, ".claude-plugin"), { recursive: true });
  await writeFile(
    path.join(directory, ".claude-plugin", "marketplace.json"),
    `${JSON.stringify(
      {
        name: "skill-router-sentinel",
        description: "sentinel marketplace",
        owner: { name: "skill-router" },
        plugins: [{ name: "demo", source: "./plugins/demo", version: "0.0.1", description: "demo" }],
      },
      null,
      2,
    )}\n`,
  );
  return directory;
}

test("user-scope fake writes refuse a real or unisolated HOME before touching it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-fake-claude-"));
  const before = await digestOf(realSettings);
  try {
    const directory = await marketplaceDirectory(root);
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const argv = ["plugin", "marketplace", "add", "--scope", "user", directory];
    const removeArgv = ["plugin", "marketplace", "remove", "skill-router-sentinel", "--scope", "user"];

    // 1. Real HOME and no CLAUDE_CONFIG_DIR: refused before any write.
    const state = emptyFakeClaudeState();
    await assert.rejects(
      () => runFakeClaude(state, argv, { cwd, env: { HOME: realHome() } }),
      /refusing to write user-scope Claude settings outside a temporary directory/,
    );
    assert.deepEqual(state.marketplaces, [], "no marketplace state was mutated");
    assert.equal(await digestOf(realSettings), before, "the real user settings digest is unchanged");

    // 2. A CLAUDE_CONFIG_DIR that points at the real configuration refuses too.
    await assert.rejects(
      () => runFakeClaude(state, argv, { cwd, env: { CLAUDE_CONFIG_DIR: path.join(realHome(), ".claude") } }),
      /refusing to write user-scope Claude settings/,
    );
    assert.equal(await digestOf(realSettings), before);

    // 3. Removal is guarded by the same barrier.
    await assert.rejects(
      () => runFakeClaude(state, removeArgv, { cwd, env: { HOME: realHome() } }),
      /refusing to write user-scope Claude settings/,
    );
    assert.equal(await digestOf(realSettings), before);

    // 4. A temp CLAUDE_CONFIG_DIR (the isolated pattern every test uses) works.
    const isolated = path.join(root, "claude-config");
    await mkdir(isolated, { recursive: true });
    await runFakeClaude(state, argv, { cwd, env: { CLAUDE_CONFIG_DIR: isolated } });
    assert.equal(state.marketplaces.length, 1, "the isolated write lands");
    const settings = JSON.parse(await readFile(path.join(isolated, "settings.json"), "utf8"));
    assert.equal(settings.extraKnownMarketplaces["skill-router-sentinel"].source.path, directory);
    await runFakeClaude(state, removeArgv, { cwd, env: { CLAUDE_CONFIG_DIR: isolated } });
    assert.equal(state.marketplaces.length, 0, "the isolated removal lands");
    assert.equal(await digestOf(realSettings), before, "the real settings never changed");
  } finally {
    await rm(root, { recursive: true, force: true });
    assert.equal(await digestOf(realSettings), before, "cleanup leaves the real settings identical");
  }
});

test("the explicit escape hatch only bypasses the path check, never a write", async () => {
  const real = path.join(realHome(), ".claude", "settings.json");
  assert.throws(() => assertFakeClaudeUserSettingsWritable(real, {}), /refusing to write user-scope/);
  assert.doesNotThrow(
    () => assertFakeClaudeUserSettingsWritable(real, { SKILL_ROUTER_TEST_ALLOW_REAL_CLAUDE_SETTINGS: "1" }),
    "the documented escape hatch admits the path (it never writes by itself)",
  );
  const temp = await mkdtemp(path.join(os.tmpdir(), "skill-router-fake-claude-"));
  try {
    assert.equal(assertFakeClaudeUserSettingsWritable(path.join(temp, "settings.json"), {}), path.join(temp, "settings.json"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
