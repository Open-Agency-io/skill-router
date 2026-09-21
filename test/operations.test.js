import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addOperation,
  checkOperation,
  initOperation,
  routeFileOperation,
  routeOperation,
  scanOperation,
} from "../src/operations.js";
import { parseFrontmatter } from "../src/frontmatter.js";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "skill-router-operations-"));
  const home = path.join(directory, "home");
  const root = path.join(directory, "project");
  await mkdir(home, { recursive: true });
  await mkdir(root, { recursive: true });
  return { directory, home, root };
}

async function writeSkill(file, name, description) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `---\nname: ${name}\ndescription: ${description}\n---\n\n${name} instructions.\n`);
}

test("initializes idempotently, hides routed skills, routes, scans, and checks", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    const sourceSkill = path.join(environment.root, ".agents", "skills", "release", "SKILL.md");
    await writeSkill(sourceSkill, "Release", "Prepare notes and publish a release");

    const first = await initOperation({ root: environment.root });
    const second = await initOperation({ root: environment.root });
    assert.equal(first.fingerprint, second.fingerprint);
    assert.equal(first.skillCount, 1);

    const managed = path.join(first.skillsDirectory, "release", "SKILL.md");
    const managedMetadata = parseFrontmatter(await readFile(managed, "utf8")).attributes;
    assert.equal(managedMetadata.metadata["opencode/autoinvoke"], false);
    const routerMetadata = parseFrontmatter(
      await readFile(path.join(first.skillsDirectory, "skill-router", "SKILL.md"), "utf8"),
    ).attributes;
    assert.notEqual(routerMetadata.metadata?.["opencode/autoinvoke"], false);
    const routerText = await readFile(path.join(first.skillsDirectory, "skill-router", "SKILL.md"), "utf8");
    assert.ok(routerText.length / 4 < 300, "router skill should remain below the 300-token estimate");

    assert.equal((await routeOperation("release", { root: environment.root })).skillId, "release");
    const sentinel = path.join(environment.directory, "must-not-exist");
    const requestToken = "0123456789abcdef0123456789abcdef";
    const requestFile = path.join(environment.root, ".skill-router", "requests", `${requestToken}.txt`);
    await mkdir(path.dirname(requestFile), { recursive: true });
    await writeFile(requestFile, `$(touch ${sentinel})`);
    assert.equal((await routeFileOperation(requestToken, { root: environment.root })).outcome, "none");
    await assert.rejects(() => access(requestFile), /ENOENT/);
    await assert.rejects(() => access(sentinel), /ENOENT/);
    assert.equal((await checkOperation({ root: environment.root })).healthy, true);
    await rm(managed);
    const unloadable = await checkOperation({ root: environment.root });
    assert.equal(unloadable.healthy, false);
    assert.equal(unloadable.diagnostics.some((item) => item.code === "managed-skill-invalid"), true);
    await scanOperation({ root: environment.root });
    assert.deepEqual((await scanOperation({ root: environment.root })).diff, {
      added: [],
      removed: [],
      changed: [],
    });

    await writeSkill(sourceSkill, "Release", "Publish version notes and artifacts");
    const stale = await checkOperation({ root: environment.root });
    assert.equal(stale.healthy, false);
    assert.equal(stale.diagnostics.some((item) => item.code === "registry-stale"), true);
    const refreshed = await scanOperation({ root: environment.root });
    assert.deepEqual(refreshed.diff.changed, ["release"]);
    assert.equal((await checkOperation({ root: environment.root })).healthy, true);
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("refuses to replace an unowned state directory", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    const state = path.join(environment.root, ".skill-router");
    await mkdir(state);
    await writeFile(path.join(state, "keep.txt"), "keep\n");
    await assert.rejects(() => initOperation({ root: environment.root }), /unowned directory/);
    assert.equal(await readFile(path.join(state, "keep.txt"), "utf8"), "keep\n");
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("rejects skill sources that overlap router-owned state", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    const state = path.join(environment.root, ".skill-router");
    await mkdir(state);
    await writeFile(path.join(state, ".skill-router-owned"), "skill-router-state-v1\n");
    await writeFile(
      path.join(environment.root, ".skill-router.json"),
      JSON.stringify({ schemaVersion: 1, sources: [state] }),
    );
    await assert.rejects(() => initOperation({ root: environment.root }), /overlaps router-owned state/);
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("discovers JSONC-configured sources and completes with a manual OpenCode action", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    const source = path.join(environment.directory, "configured-skills");
    await writeSkill(path.join(source, "configured", "SKILL.md"), "Configured", "Handle configured work");
    const configFile = path.join(environment.root, ".opencode", "opencode.jsonc");
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(configFile, `{\n  // retained\n  "skills": [${JSON.stringify(source)}],\n}\n`);
    const result = await initOperation({ root: environment.root });
    assert.equal(result.skillCount, 1);
    assert.match(result.manualAction, /skills array/);
    assert.match(await readFile(configFile, "utf8"), /retained/);
    assert.equal((await checkOperation({ root: environment.root })).healthy, false);

    await writeFile(
      configFile,
      `{\n  // retained\n  "skills": [${JSON.stringify(source)}, ${JSON.stringify(result.skillsDirectory)}],\n}\n`,
    );
    assert.equal((await checkOperation({ root: environment.root })).healthy, true);
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("adds direct paths with overrides and supports dry-run without writes", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    await initOperation({ root: environment.root });
    const external = path.join(environment.directory, "external", "review", "SKILL.md");
    await writeSkill(external, "Review", "Review code for correctness");
    const original = await readFile(external, "utf8");
    await mkdir(path.join(path.dirname(external), "references"), { recursive: true });
    await writeFile(path.join(path.dirname(external), "references", "guide.md"), "Review guide\n");

    const dry = await addOperation(path.dirname(external), { root: environment.root, dryRun: true });
    assert.equal(dry.dryRun, true);
    const before = JSON.parse(await readFile(path.join(environment.root, ".skill-router.json"), "utf8"));
    assert.deepEqual(before.sources, []);

    const added = await addOperation(path.dirname(external), {
      root: environment.root,
      aliases: ["inspect this"],
      description: "Inspect a change carefully",
    });
    assert.deepEqual(added.added, ["review"]);
    assert.equal(await readFile(external, "utf8"), original);
    assert.equal(
      await readFile(path.join(added.skillsDirectory, "review", "references", "guide.md"), "utf8"),
      "Review guide\n",
    );
    assert.equal((await routeOperation("inspect this", { root: environment.root })).skillId, "review");

    const disabledSkill = path.join(environment.directory, "external", "format", "SKILL.md");
    await writeSkill(disabledSkill, "Format", "Format source files");
    await addOperation(path.dirname(disabledSkill), { root: environment.root, noEnable: true });
    assert.equal((await routeOperation("format", { root: environment.root })).outcome, "none");
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("replace accepts an exact skill file without selecting a duplicate arbitrarily", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    await initOperation({ root: environment.root });
    const source = path.join(environment.directory, "duplicates");
    const flat = path.join(source, "duplicate.md");
    await writeSkill(flat, "Chosen Duplicate", "Use the chosen duplicate skill");
    await writeSkill(path.join(source, "duplicate", "SKILL.md"), "Other Duplicate", "Other definition");
    await assert.rejects(
      () => addOperation("duplicate", { root: environment.root, source, replace: true }),
      /exact skill file or directory/,
    );
    const result = await addOperation(flat, { root: environment.root, replace: true });
    assert.deepEqual(result.added, ["duplicate"]);
    const config = JSON.parse(await readFile(path.join(environment.root, ".skill-router.json"), "utf8"));
    assert.equal(config.skills.duplicate.source, flat);
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("directory add requires confirmation when multiple skills are found", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    await initOperation({ root: environment.root });
    const source = path.join(environment.directory, "collection");
    await writeSkill(path.join(source, "one", "SKILL.md"), "One", "Handle first tasks");
    await writeSkill(path.join(source, "two", "SKILL.md"), "Two", "Handle second tasks");
    const dryRun = await addOperation(source, { root: environment.root, dryRun: true });
    assert.deepEqual(dryRun.added, ["one", "two"]);
    await assert.rejects(() => addOperation(source, { root: environment.root }), /--yes/);
    const result = await addOperation(source, { root: environment.root, yes: true });
    assert.deepEqual(result.added, ["one", "two"]);
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("add resolves an installed exact ID before a same-named local path", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    await writeSkill(
      path.join(environment.root, ".agents", "skills", "review", "SKILL.md"),
      "Installed Review",
      "Review installed code",
    );
    await mkdir(path.join(environment.root, "review"));
    await writeSkill(path.join(environment.root, "review", "SKILL.md"), "Path Review", "Review path code");
    await initOperation({ root: environment.root });
    const result = await addOperation("review", { root: environment.root });
    assert.deepEqual(result.added, ["review"]);
    const config = JSON.parse(await readFile(path.join(environment.root, ".skill-router.json"), "utf8"));
    assert.deepEqual(config.sources, []);
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});

test("global init remains isolated from project configuration", async () => {
  const environment = await fixture();
  const previousHome = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = environment.home;
  try {
    await writeSkill(
      path.join(environment.home, ".agents", "skills", "global-review", "SKILL.md"),
      "Global Review",
      "Review changes globally",
    );
    const result = await initOperation({ root: environment.root, global: true });
    assert.equal(result.scope, "global");
    assert.equal(result.skillCount, 1);
    await access(path.join(environment.home, ".config", "skill-router", "config.json"));
    await assert.rejects(() => access(path.join(environment.root, ".skill-router.json")), /ENOENT/);
  } finally {
    if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previousHome;
    await rm(environment.directory, { recursive: true, force: true });
  }
});
