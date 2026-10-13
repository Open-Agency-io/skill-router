import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LOCK_ERROR_CODES } from "../src/mutation-lock.js";
import { controlPaths } from "../src/mutation-lock.js";
import { normalizeConfig } from "../src/config.js";
import {
  assertConfigOutsideState,
  buildWorkspaceRegistry,
  createContext,
  ensureControlAnchor,
  isGitBoundary,
  isPathInside,
  normalizeRootPath,
  readControlAnchor,
  readRegistry,
  requestSpoolPaths,
  resolveControlContext,
  resolveProjectRoot,
} from "../src/workspace.js";

const VALID_CONFIG = `${JSON.stringify({ schemaVersion: 1, sources: [] }, null, 2)}\n`;

async function makeDirectories(base, relative) {
  const target = path.join(base, relative);
  await mkdir(target, { recursive: true });
  return target;
}

async function writeConfig(directory, content = VALID_CONFIG) {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, ".skill-router.json");
  await writeFile(file, content);
  return file;
}

async function withHome(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-workspace-"));
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  const previous = process.env.SKILL_ROUTER_HOME;
  process.env.SKILL_ROUTER_HOME = home;
  try {
    await run({ base: root, home });
  } finally {
    if (previous === undefined) delete process.env.SKILL_ROUTER_HOME;
    else process.env.SKILL_ROUTER_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("the nearest initialized ancestor wins among nested configs", async () => {
  await withHome(async ({ base }) => {
    const outer = await makeDirectories(base, path.join("project"));
    const inner = path.join(outer, "inner");
    const deep = path.join(inner, "deep");
    await makeDirectories(base, path.join("project", "inner", "deep"));
    await writeConfig(outer);
    await writeConfig(inner);

    assert.equal(await resolveProjectRoot(deep), inner, "the closest regular config wins");
    assert.equal(await resolveProjectRoot(inner), inner, "an initialized directory resolves to itself");
    assert.equal(await resolveProjectRoot(outer), outer, "an initialized directory resolves to itself");

    // Every context path is recomputed from the resolved root.
    const context = await createContext({ root: deep });
    assert.equal(context.root, inner);
    assert.equal(context.configFile, path.join(inner, ".skill-router.json"));
    assert.equal(context.stateDirectory, path.join(inner, ".skill-router"));
    assert.equal(context.openCodeConfig, path.join(inner, ".opencode", "opencode.json"));
    assert.equal(
      context.requestDirectory,
      path.join(inner, ".skill-router-requests"),
      "the stable spool follows the nearest initialized root",
    );
    assert.equal(
      context.legacyRequestDirectory,
      path.join(inner, ".skill-router", "requests"),
      "the legacy path stays inside the resolved state directory",
    );
    assert.deepEqual(context.ancestors, [inner], "source ancestors are recomputed from the resolved root");
  });
});

test("the stable request spool path is independent of the configured state directory", async () => {
  await withHome(async ({ base, home }) => {
    const outer = await makeDirectories(base, path.join("project"));
    const inner = path.join(outer, "inner");
    const deep = path.join(inner, "deep");
    await makeDirectories(base, path.join("project", "inner", "deep"));
    await writeConfig(outer);
    await writeConfig(inner);

    // Project scope: the spool is a sibling of state at the resolved root, so
    // it can never be swallowed by (or relocated with) the state directory.
    const context = await createContext({ root: deep });
    assert.equal(context.root, inner);
    assert.equal(context.stateDirectory, path.join(inner, ".skill-router"));
    assert.equal(context.requestDirectory, path.join(inner, ".skill-router-requests"));
    assert.equal(context.legacyRequestDirectory, path.join(inner, ".skill-router", "requests"));
    assert.equal(isPathInside(context.requestDirectory, context.stateDirectory), false, "the spool is outside state");

    // Global scope keys one shared spool off the router home.
    const global = await createContext({ root: deep, global: true });
    assert.equal(global.requestDirectory, path.join(home, ".local", "share", "skill-router-requests"));
    assert.equal(global.stateDirectory, path.join(home, ".local", "share", "skill-router"));
    assert.equal(global.legacyRequestDirectory, path.join(home, ".local", "share", "skill-router", "requests"));
    assert.equal(isPathInside(global.requestDirectory, global.stateDirectory), false);
    assert.notEqual(global.requestDirectory, global.legacyRequestDirectory);

    // Even a caller that resolves state elsewhere (the pure helper accepts any
    // state path) still gets the same fixed spool location: the spool never
    // derives from the state directory.
    for (const stateDirectory of ["/var/lib/elsewhere", path.join(inner, "custom-state")]) {
      const paths = requestSpoolPaths({ root: inner, home, global: false, stateDirectory });
      assert.equal(paths.requestDirectory, path.join(inner, ".skill-router-requests"));
      assert.equal(paths.legacyRequestDirectory, path.join(stateDirectory, "requests"));
    }
    const globalPaths = requestSpoolPaths({ root: deep, home, global: true, stateDirectory: "/var/lib/elsewhere" });
    assert.equal(globalPaths.requestDirectory, path.join(home, ".local", "share", "skill-router-requests"));
  });
});

test("a malformed nearest config is selected and errors instead of falling through", async () => {
  await withHome(async ({ base }) => {
    const outer = await makeDirectories(base, path.join("project"));
    const inner = path.join(outer, "inner");
    const deep = path.join(inner, "deep");
    await makeDirectories(base, path.join("project", "inner", "deep"));
    await writeConfig(outer);
    await writeConfig(inner, "{ malformed");

    assert.equal(
      await resolveProjectRoot(deep),
      inner,
      "selection is presence-based: the malformed nearest config is still the root",
    );
    await assert.rejects(() => createContext({ root: deep }), /Invalid JSON/, "normal config loading reports the error");
    await assert.rejects(
      () => createContext({ root: inner }),
      /Invalid JSON/,
      "the error surfaces from the selected root itself",
    );
  });
});

test("a .git directory or file boundary is checked but never crossed", async () => {
  await withHome(async ({ base }) => {
    const repo = await makeDirectories(base, path.join("repo"));
    const nested = path.join(repo, "sub", "deep");
    await makeDirectories(base, path.join("repo", "sub", "deep"));
    await writeConfig(base); // an initialized project *above* the worktree

    // `.git` directory boundary: the candidate at the boundary is checked
    // first, then the search stops without reaching the outer config.
    await mkdir(path.join(repo, ".git"), { recursive: true });
    assert.equal(await resolveProjectRoot(nested), nested, "a .git directory stops the search");

    // A config that sits exactly at the Git root is still selected.
    await writeConfig(repo);
    assert.equal(await resolveProjectRoot(nested), repo, "the boundary candidate itself is checked first");

    // `.git` file boundary (worktree/submodule) behaves the same way.
    await rm(path.join(repo, ".skill-router.json"));
    await rm(path.join(repo, ".git"), { recursive: true, force: true });
    await writeFile(path.join(repo, ".git"), "gitdir: ../elsewhere/.git\n");
    assert.equal(await resolveProjectRoot(nested), nested, "a .git file stops the search");
    await writeConfig(repo);
    assert.equal(await resolveProjectRoot(nested), repo, "the worktree root candidate is checked first");
    assert.notEqual(await resolveProjectRoot(nested), base, "the outer project is never used");
  });
});

test("a non-Git nested project still discovers its ancestor", async () => {
  await withHome(async ({ base }) => {
    const deep = await makeDirectories(base, path.join("plain", "a", "b", "c", "d"));
    await writeConfig(path.join(base, "plain"));
    assert.equal(
      await resolveProjectRoot(deep),
      path.join(base, "plain"),
      "the search crosses intermediate directories up to the filesystem root when no Git boundary exists",
    );

    // Nothing anywhere: the walk reaches the filesystem root, finds no config,
    // and keeps the requested directory.
    const isolated = await makeDirectories(base, path.join("unrelated", "x"));
    assert.equal(await resolveProjectRoot(isolated), isolated, "a fresh directory keeps itself as the root");
  });
});

test("symlinked and non-regular config candidates are never selected or followed", async () => {
  await withHome(async ({ base }) => {
    const outer = await makeDirectories(base, path.join("project"));
    const nested = path.join(outer, "nested");
    const deep = path.join(nested, "deep");
    await makeDirectories(base, path.join("project", "nested", "deep"));

    // A symlinked config at `nested` is skipped: discovery continues to the
    // next valid ancestor instead of following it.
    await writeConfig(outer);
    await writeFile(path.join(base, "elsewhere.json"), VALID_CONFIG);
    await symlink(path.join(base, "elsewhere.json"), path.join(nested, ".skill-router.json"));
    assert.equal(await resolveProjectRoot(deep), outer, "a symlinked candidate is skipped, not followed");

    // With no valid ancestor left, the requested directory is kept.
    await rm(path.join(outer, ".skill-router.json"));
    assert.equal(await resolveProjectRoot(deep), deep, "a symlink never makes an ancestor become the root");

    // A directory posing as the config file is ignored the same way.
    await rm(path.join(nested, ".skill-router.json"), { recursive: true, force: true });
    await mkdir(path.join(nested, ".skill-router.json"), { recursive: true });
    assert.equal(await resolveProjectRoot(deep), deep, "a non-regular candidate is not an initialization signal");
    await rm(path.join(nested, ".skill-router.json"), { recursive: true, force: true });
  });
});

test("an explicit config and global scope both bypass root discovery", async () => {
  await withHome(async ({ base, home }) => {
    const outer = await makeDirectories(base, path.join("project"));
    const nested = path.join(outer, "nested");
    const deep = path.join(nested, "deep");
    await makeDirectories(base, path.join("project", "nested", "deep"));
    await writeConfig(outer);
    await writeFile(path.join(nested, "custom.json"), VALID_CONFIG);

    assert.equal(await resolveProjectRoot(deep, { explicitConfig: true }), deep, "explicit config keeps the requested root");
    assert.equal(await resolveProjectRoot(deep, { global: true }), deep, "global scope performs no search");

    const explicit = await createContext({ root: deep, config: path.join(deep, "custom.json") });
    assert.equal(explicit.root, deep, "an explicit config disables discovery");
    assert.equal(explicit.configFile, path.join(deep, "custom.json"));
    assert.equal(explicit.stateDirectory, path.join(deep, ".skill-router"));
    assert.equal(explicit.openCodeConfig, path.join(deep, ".opencode", "opencode.json"));

    const global = await createContext({ root: deep, global: true });
    assert.equal(global.root, deep, "global scope keeps the requested root");
    assert.equal(global.configFile, path.join(home, ".config", "skill-router", "config.json"));
    assert.equal(global.stateDirectory, path.join(home, ".local", "share", "skill-router"));
    assert.deepEqual(global.ancestors, [], "global scope has no project ancestors");
  });
});

test("a symlinked .git marker is ignored by root discovery and by source ancestry", async () => {
  await withHome(async ({ base }) => {
    const work = await makeDirectories(base, "work");
    const repo = path.join(work, "repo");
    const inner = path.join(repo, "inner");
    await makeDirectories(base, path.join("work", "repo", "inner"));
    await makeDirectories(base, path.join("work", "repo", "a", "b"));
    await mkdir(path.join(work, "real-git"), { recursive: true });
    await mkdir(path.join(work, ".git"), { recursive: true });
    await writeConfig(work);
    await writeConfig(inner);
    await symlink(path.join(work, "real-git"), path.join(repo, ".git"));

    // Root discovery crosses the symlinked marker to reach the ancestor config.
    assert.equal(
      await resolveProjectRoot(path.join(repo, "a", "b")),
      work,
      "a symlinked .git never stops root discovery",
    );

    // Source ancestry crosses it too and stops at the next real boundary.
    const context = await createContext({ root: path.join(repo, "a", "b") });
    assert.equal(context.root, work, "the ancestor config above the symlink is selected");
    assert.equal(context.ancestors.at(-1), context.root, "ancestors end at the resolved root");
    assert.equal(context.configFile, path.join(context.root, ".skill-router.json"));

    const innerContext = await createContext({ root: inner });
    assert.equal(innerContext.root, inner, "the nearest config below the symlink resolves first");
    assert.deepEqual(
      innerContext.ancestors,
      [work, repo, inner],
      "ancestors cross the symlinked marker and stop at the real .git (outermost first)",
    );
    assert.equal(innerContext.ancestors.at(-1), innerContext.root, "root and ancestors agree");
  });
});

test("a dangling .git symlink is ignored by root discovery and by source ancestry", async () => {
  await withHome(async ({ base }) => {
    const work = await makeDirectories(base, "work");
    const repo = path.join(work, "repo");
    const inner = path.join(repo, "inner");
    await makeDirectories(base, path.join("work", "repo", "inner"));
    await makeDirectories(base, path.join("work", "repo", "a"));
    await mkdir(path.join(work, ".git"), { recursive: true });
    await writeConfig(work);
    await writeConfig(inner);
    await symlink(path.join(work, "does-not-exist"), path.join(repo, ".git"));

    assert.equal(
      await resolveProjectRoot(path.join(repo, "a")),
      work,
      "a dangling marker never stops root discovery",
    );
    const context = await createContext({ root: inner });
    assert.equal(context.root, inner);
    assert.deepEqual(
      context.ancestors,
      [work, repo, inner],
      "a dangling marker never stops the source-ancestor walk either (outermost first)",
    );
    assert.equal(context.ancestors.at(-1), context.root, "root and ancestors agree");
  });
});

test("normal .git directories and regular worktree files stop both paths consistently", async () => {
  await withHome(async ({ base }) => {
    const work = await makeDirectories(base, "work");
    const repo = path.join(work, "repo");
    const inner = path.join(repo, "inner");
    await makeDirectories(base, path.join("work", "repo", "inner", "deep"));
    await makeDirectories(base, path.join("work", "repo", "a"));
    await writeConfig(work); // an initialized project above the boundary

    for (const marker of ["directory", "worktree file"]) {
      await rm(path.join(repo, ".git"), { recursive: true, force: true });
      if (marker === "directory") await mkdir(path.join(repo, ".git"), { recursive: true });
      else await writeFile(path.join(repo, ".git"), "gitdir: ../elsewhere/.git\n");

      // (a) The nearest config below the boundary still wins.
      await writeConfig(inner);
      assert.equal(
        await resolveProjectRoot(path.join(repo, "inner", "deep")),
        inner,
        `a .git ${marker} still checks candidates below the boundary`,
      );

      // (b) A candidate exactly at the boundary is checked before the
      // boundary is applied.
      await rm(path.join(inner, ".skill-router.json"));
      await writeConfig(repo);
      assert.equal(
        await resolveProjectRoot(path.join(repo, "a")),
        repo,
        `a .git ${marker} still checks the boundary candidate itself`,
      );

      // (c) With nothing at or below the boundary, the search stops without
      // crossing into the initialized project above it.
      await rm(path.join(repo, ".skill-router.json"));
      assert.equal(
        await resolveProjectRoot(path.join(repo, "a")),
        path.join(repo, "a"),
        `a .git ${marker} stops the search without crossing it`,
      );

      // (d) Source ancestry stops at exactly the same boundary.
      await writeConfig(inner);
      const resolved = await createContext({ root: path.join(repo, "inner", "deep") });
      assert.equal(resolved.root, inner, "the nearest config below the boundary resolves first");
      assert.deepEqual(resolved.ancestors, [repo, inner], `a .git ${marker} stops source ancestry at the boundary`);
      assert.equal(resolved.ancestors.at(-1), resolved.root, "root and ancestors agree");
      await rm(path.join(inner, ".skill-router.json"));
    }
  });
});

test("isGitBoundary accepts only a regular .git file or directory", async () => {
  await withHome(async ({ base }) => {
    const directory = await makeDirectories(base, "marker");

    assert.equal(await isGitBoundary(directory), false, "no marker at all");
    await writeFile(path.join(directory, ".git"), "gitdir: ../elsewhere/.git\n");
    assert.equal(await isGitBoundary(directory), true, "a regular worktree file is a boundary");
    await rm(path.join(directory, ".git"));

    await mkdir(path.join(directory, ".git"), { recursive: true });
    assert.equal(await isGitBoundary(directory), true, "a directory is a boundary");
    await rm(path.join(directory, ".git"), { recursive: true });

    await writeFile(path.join(directory, "target"), "real\n");
    await symlink(path.join(directory, "target"), path.join(directory, ".git"));
    assert.equal(await isGitBoundary(directory), false, "a valid symlink is never a boundary (and is never followed)");
    await rm(path.join(directory, ".git"), { force: true });

    await symlink(path.join(directory, "missing"), path.join(directory, ".git"));
    assert.equal(await isGitBoundary(directory), false, "a dangling symlink is never a boundary");
    await rm(path.join(directory, ".git"), { force: true });

    // Platform limit: a FIFO is the portable non-regular fixture, but Windows
    // cannot create one, so that assertion only runs where `mkfifo` exists.
    if (process.platform !== "win32") {
      const created = spawnSync("mkfifo", [path.join(directory, ".git")]);
      if (created.status === 0) {
        assert.equal(await isGitBoundary(directory), false, "a special (non-regular) entry is never a boundary");
        await rm(path.join(directory, ".git"), { force: true });
      }
    }
  });
});

test("the router configuration must stay outside router-owned state", async () => {
  await withHome(async ({ base }) => {
    const root = await makeDirectories(base, "project");
    const state = path.join(root, ".skill-router");
    await mkdir(state, { recursive: true });
    const remedy = /Copy the configuration file outside the router-owned state directory and retry/;

    // Lexically inside state, existing leaf.
    await assert.rejects(
      () => assertConfigOutsideState(path.join(state, "router.json"), state),
      new RegExp(`is inside ${state.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
    await assert.rejects(() => assertConfigOutsideState(path.join(state, "router.json"), state), remedy);

    // Lexically inside state with a leaf that does not exist yet.
    await assert.rejects(() => assertConfigOutsideState(path.join(state, "nested", "router.json"), state), remedy);

    // The state directory itself, used as the configuration file.
    await assert.rejects(() => assertConfigOutsideState(state, state), remedy);

    // Resolved through an existing parent symlink that lands inside state.
    const alias = path.join(root, "state-alias");
    await symlink(state, alias);
    await assert.rejects(
      () => assertConfigOutsideState(path.join(alias, "router.json"), state),
      /resolves to .* which is inside the router-owned state directory/,
    );
    await assert.rejects(
      () => assertConfigOutsideState(path.join(alias, "nested", "router.json"), state),
      remedy,
      "a nonexistent leaf still resolves through its existing symlinked parent",
    );

    // A leaf symlink pointing into state: the target exists, so the link
    // resolves into state and is refused.
    const target = path.join(state, "router.json");
    await writeFile(target, "user config\n");
    const link = path.join(root, "linked-router.json");
    await symlink(target, link);
    await assert.rejects(() => assertConfigOutsideState(link, state), remedy);
    assert.equal(await readFile(target, "utf8"), "user config\n", "the invariant never writes");

    // Configurations that resolve outside state are accepted, symlinked or not.
    const outside = await makeDirectories(root, "config-home");
    const outsideAlias = path.join(root, "config-alias");
    await symlink(outside, outsideAlias);
    await assertConfigOutsideState(path.join(outsideAlias, "router.json"), state);
    await assertConfigOutsideState(path.join(root, ".skill-router.json"), state);

    // Fresh installations: state does not exist yet, the lexical check holds.
    const futureState = path.join(root, "future-state");
    await assert.rejects(
      () => assertConfigOutsideState(path.join(futureState, "router.json"), futureState),
      remedy,
    );

    // Nothing above wrote anything.
    await assert.rejects(() => access(path.join(state, "nested")), /ENOENT/);
    await assert.rejects(() => access(path.join(futureState, "router.json")), /ENOENT/);
    assert.equal(isPathInside(path.join(state, "a"), state), true);
    assert.equal(isPathInside(path.join(root, "a"), state), false);
    assert.equal(isPathInside(state, state), true);
  });
});

test("the invariant distinguishes project and global state layouts", async () => {
  await withHome(async ({ base, home }) => {
    const root = await makeDirectories(base, "project");
    const globalState = path.join(home, ".local", "share", "skill-router");
    await mkdir(globalState, { recursive: true });
    const remedy = /Copy the configuration file outside the router-owned state directory and retry/;

    // The global default configuration is outside the global state.
    await assertConfigOutsideState(path.join(home, ".config", "skill-router", "config.json"), globalState);
    // A project configuration is not inside the global state and vice versa.
    await assertConfigOutsideState(path.join(root, ".skill-router.json"), globalState);
    await assertConfigOutsideState(path.join(home, ".config", "skill-router", "config.json"), path.join(root, ".skill-router"));

    // ... but an explicit configuration placed inside either state is refused.
    await assert.rejects(() => assertConfigOutsideState(path.join(globalState, "config.json"), globalState), remedy);
    const alias = path.join(home, "state-alias");
    await symlink(globalState, alias);
    await assert.rejects(() => assertConfigOutsideState(path.join(alias, "config.json"), globalState), remedy);
  });
});

/* ---------------- Phase 6: control context and anchor ---------------- */

test("resolveControlContext never loads router config and keeps the scope contracts", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "skill-router-workspace-control-"));
  try {
    const root = await makeDirectories(base, "project");
    const nested = await makeDirectories(root, "a/b");

    // Nothing installed: requested root, project scope, fixed control paths.
    const fresh = await resolveControlContext({ root: nested });
    assert.equal(fresh.scope, "project");
    assert.equal(fresh.root, nested);
    assert.equal(fresh.anchorRoot, nested);
    assert.deepEqual(fresh.paths, controlPaths({ root: nested }));

    // A malformed configuration is still a regular candidate and is never read:
    // resolution must not load router config.
    await writeFile(path.join(root, ".skill-router.json"), "{ not json");
    const resolved = await resolveControlContext({ root: nested });
    assert.equal(resolved.root, root, "the nearest regular configuration wins without being parsed");

    // Explicit --config keeps the requested root (accepted Phase 3 contract).
    const explicit = await resolveControlContext({
      root: nested,
      config: path.join(root, ".skill-router.json"),
    });
    assert.equal(explicit.root, nested);
    assert.equal(explicit.explicitConfig, true);

    // Config missing but anchored: the anchor resolves the same root.
    const anchored = await makeDirectories(base, "anchored");
    const anchorPaths = controlPaths({ root: anchored });
    await mkdir(anchorPaths.controlDirectory, { recursive: true, mode: 0o700 });
    const created = await ensureControlAnchor({
      paths: anchorPaths,
      scope: "project",
      root: anchored,
      allowCreate: true,
    });
    assert.equal(created.created, true);
    assert.equal(created.anchor.owner, "skill-router");
    const anchorChild = await makeDirectories(anchored, "child");
    assert.equal((await resolveControlContext({ root: anchorChild })).root, anchored);
    // Read-only callers never create one.
    const readOnly = await ensureControlAnchor({
      paths: controlPaths({ root: await makeDirectories(base, "never-created") }),
      scope: "project",
      root: base,
      allowCreate: false,
    });
    assert.equal(readOnly.present, false);

    // Global scope performs no search and keys the router home instead.
    const home = await makeDirectories(base, "home");
    const previous = process.env.SKILL_ROUTER_HOME;
    process.env.SKILL_ROUTER_HOME = home;
    try {
      const global = await resolveControlContext({ root, global: true });
      assert.equal(global.scope, "global");
      assert.equal(global.root, path.resolve(root), "global keeps the requested root");
      assert.equal(global.anchorRoot, home, "the global anchor binds the home");
      assert.deepEqual(global.paths, controlPaths({ home, global: true }));
    } finally {
      if (previous === undefined) delete process.env.SKILL_ROUTER_HOME;
      else process.env.SKILL_ROUTER_HOME = previous;
    }

    // Root drift on an existing anchor refuses with the stable lock code.
    await assert.rejects(
      () => readControlAnchor(anchorPaths, { scope: "project", root: base }),
      (error) => error.code === LOCK_ERROR_CODES.LOCK_FOREIGN && /records root/.test(error.message),
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a malformed installed registry is inert inventory during rebuild", async () => {
  await withHome(async ({ base, home }) => {
    const project = await makeDirectories(base, "project");
    await writeConfig(project);
    const context = await createContext({ root: project });
    const control = "claude\u0001\u001b[31m";
    const huge = "x".repeat(100_000);

    // Legacy shape: poison `skills` and no `sourceRoots` inventory. The
    // rebuild must neither crash on it nor retain anything from it.
    const legacy = await buildWorkspaceRegistry(context, context.config, {
      installed: { schemaVersion: 1, skills: { [control]: { source: huge } } },
    });
    assert.deepEqual(legacy.registry.skills.map((skill) => skill.id), []);

    // Current shape: valid `sourceRoots` inventory but non-array `skills`,
    // with control/huge poison inside. Route/check refuse this document, but
    // the rebuild that a scan uses treats it as inert.
    const current = await buildWorkspaceRegistry(context, context.config, {
      installed: {
        schemaVersion: 1,
        sourceRoots: [path.join(base, "gone")],
        skills: { [huge]: { enabled: true } },
        workflows: control,
      },
    });
    assert.deepEqual(current.registry.skills.map((skill) => skill.id), []);

    // The poison never reaches the rebuilt registry or its diagnostics.
    const serialized = JSON.stringify(current.registry);
    assert.equal(serialized.includes(huge.slice(0, 80)), false, "no huge poison leaks");
    assert.equal(serialized.includes("\u0001"), false, "no control poison leaks");
    assert.equal(/[\u0000-\u001f]/.test(serialized), false, "the rebuild output is control-free");
  });
});

test("direct-source diagnostics identify the config key and never echo the source path", async () => {
  await withHome(async ({ base }) => {
    const project = await makeDirectories(base, "project");
    await writeConfig(project);
    const context = await createContext({ root: project });

    // The ancestor carries a terminal escape byte and sensitive components;
    // no diagnostic may re-expose it or any path beneath it.
    const hostileAncestor = await makeDirectories(base, "sent\u001binel");
    const empty = await makeDirectories(hostileAncestor, path.join("private", "empty"));
    const many = await makeDirectories(hostileAncestor, path.join("private", "many"));
    await writeFile(path.join(many, "one.md"), "---\nname: One\ndescription: One skill\n---\nBody\n");
    await writeFile(path.join(many, "two.md"), "---\nname: Two\ndescription: Two skill\n---\nBody\n");
    const only = await makeDirectories(hostileAncestor, path.join("private", "only"));
    await writeFile(path.join(only, "SKILL.md"), "---\nname: Other\ndescription: Other skill\n---\nBody\n");

    const diagnosticsFor = async (skills) => {
      const config = normalizeConfig({ schemaVersion: 2, skills });
      const built = await buildWorkspaceRegistry(context, config);
      return built.registry.diagnostics.filter((item) => item.code.startsWith("direct-source-"));
    };

    // 0 matches: the exact fixed message, no path suffix.
    const zero = await diagnosticsFor({ "safe-id": { source: empty } });
    assert.equal(zero.length, 1);
    assert.equal(zero[0].code, "direct-source-unresolved");
    assert.equal(zero[0].id, "safe-id");
    assert.equal(zero[0].message, "skills.safe-id.source must resolve to exactly one skill (0 found)");
    assert.equal(Object.hasOwn(zero[0], "path"), false);

    // Multiple matches: same shape with the bounded count phrase.
    const multiple = await diagnosticsFor({ "safe-id": { source: many } });
    assert.equal(multiple.length, 1);
    assert.equal(multiple[0].code, "direct-source-unresolved");
    assert.equal(multiple[0].message, "skills.safe-id.source must resolve to exactly one skill (2 found)");
    assert.equal(Object.hasOwn(multiple[0], "path"), false);

    // A resolved mismatch names only validated public IDs.
    const mismatch = await diagnosticsFor({ "safe-id": { source: only } });
    assert.equal(mismatch.length, 1);
    assert.equal(mismatch[0].code, "direct-source-id-mismatch");
    assert.equal(mismatch[0].id, "safe-id");
    assert.equal(mismatch[0].resolvedId, "only");
    assert.equal(
      mismatch[0].message,
      "skills.safe-id.source resolves to skill ID only, which must match the configuration key",
    );

    // Nothing carries the absolute source path, its escape byte, or controls.
    const serialized = JSON.stringify([...zero, ...multiple, ...mismatch]);
    assert.equal(serialized.includes(empty), false);
    assert.equal(serialized.includes(many), false);
    assert.equal(serialized.includes(only), false);
    assert.equal(serialized.includes(hostileAncestor), false);
    assert.equal(serialized.includes("\u001b"), false, "no escape byte survives");
    assert.equal(/[\u0000-\u001f]/.test(serialized), false, "diagnostics are control-free");
    assert.ok(serialized.length < 1000, "diagnostics stay bounded");
  });
});

test("root normalization expands ~ identically for control and operation contexts", async () => {
  await withHome(async ({ base, home }) => {
    const project = await makeDirectories(base, "project");
    await writeConfig(project);

    // Exact `~` and leading `~/...` expand through the router home in both
    // the control context and the operation context.
    assert.equal((await resolveControlContext({ root: "~" })).root, home);
    assert.equal((await createContext({ root: "~" })).root, home);
    assert.equal((await resolveControlContext({ root: "~/work" })).root, path.join(home, "work"));
    assert.equal((await createContext({ root: "~/work" })).root, path.join(home, "work"));
    assert.equal((await resolveControlContext({ root: "~", global: true })).root, home);
    assert.equal((await createContext({ root: "~/work", global: true })).root, path.join(home, "work"));

    // A `~user` prefix is rejected — never resolved against the wrong home.
    for (const run of [
      () => resolveControlContext({ root: "~alice" }),
      () => resolveControlContext({ root: "~alice/project" }),
      () => createContext({ root: "~alice" }),
      () => createContext({ root: "~alice/project" }),
    ]) {
      await assert.rejects(run, /must not use a ~user home prefix/);
    }

    // Any other embedded `~` stays a literal path character.
    const literal = await makeDirectories(base, "wi~ld");
    assert.equal((await resolveControlContext({ root: literal })).root, literal);
    assert.equal((await createContext({ root: literal })).root, literal);

    // The shared helper is exactly what both contexts apply.
    assert.equal(normalizeRootPath("~", home), home);
    assert.equal(normalizeRootPath("~/sub", home), path.join(home, "sub"));
    assert.equal(normalizeRootPath(literal, home), literal);
    assert.throws(() => normalizeRootPath("~alice", home), /must not use a ~user home prefix/);
  });
});

test("schema v1 direct sources normalize a skill directory like schema v2 does", async () => {
  await withHome(async ({ base }) => {
    const project = await makeDirectories(base, "project");
    await writeConfig(project);
    const context = await createContext({ root: project });
    const skills = await makeDirectories(base, "skills");
    const directory = await makeDirectories(skills, "other");
    await writeFile(path.join(directory, "SKILL.md"), "---\nname: Other\ndescription: Other skill\n---\nBody\n");

    // A declared directory containing SKILL.md resolves to that file, so the
    // v1 replacement names what discovery actually saw instead of the
    // directory (which used to fail as an unresolvable replacement).
    const config = normalizeConfig({ schemaVersion: 1, sources: [skills], skills: { other: { source: directory } } });
    const built = await buildWorkspaceRegistry(context, config);
    assert.equal(built.registry.diagnostics.some((item) => item.code === "invalid-replacement"), false);
    assert.equal(built.registry.skills.length, 1);
    assert.equal(built.registry.skills[0].source, path.join(directory, "SKILL.md"));
    assert.equal(built.registry.skills[0].enabled, true);

    // A directory without SKILL.md keeps v1's historical permissive failure.
    const empty = await makeDirectories(skills, "plain");
    const broken = normalizeConfig({ schemaVersion: 1, sources: [skills], skills: { other: { source: empty } } });
    const brokenBuilt = await buildWorkspaceRegistry(context, broken);
    assert.equal(brokenBuilt.registry.diagnostics.some((item) => item.code === "invalid-replacement"), true);

    // v1 keeps every other permissive property: a declared key whose
    // discovered skill carries another ID stays inert — no v2 id-mismatch or
    // single-match diagnostics appear.
    const mismatched = normalizeConfig({
      schemaVersion: 1,
      sources: [skills],
      skills: { "safe-id": { source: directory } },
    });
    const mismatchedBuilt = await buildWorkspaceRegistry(context, mismatched);
    assert.equal(
      mismatchedBuilt.registry.diagnostics.some((item) => String(item.code).startsWith("direct-source-")),
      false,
      "schema v1 never gains schema v2 direct-source diagnostics",
    );
    assert.equal(mismatchedBuilt.registry.diagnostics.some((item) => item.code === "invalid-replacement"), false);
  });
});

test("a malformed or unreadable installed registry fails with a bounded error", async () => {
  await withHome(async ({ base }) => {
    const project = await makeDirectories(base, "project");
    await writeConfig(project);
    const context = await createContext({ root: project });
    const state = path.join(project, ".skill-router");
    await mkdir(state, { recursive: true });
    const registryFile = path.join(state, "registry.json");
    const secret = "sk-live-9d2b7c0e4a1f5e3d";

    // A trailing-comma registry fails with file context only — never the
    // parser's snippet or the document bytes.
    await writeFile(registryFile, `{"skills": [${JSON.stringify(secret)}],}`);
    const error = await readRegistry(context).then(() => null, (failure) => failure);
    assert.ok(error instanceof Error);
    assert.match(error.message, /^Invalid registry JSON in .+/);
    assert.equal(error.message.includes(registryFile), true);
    assert.equal(error.message.includes(secret), false);
    assert.equal(/[\u0000-\u001f]/.test(error.message), false, "the message is control-free");

    // An unreadable registry gets the fixed mapped read error.
    await rm(registryFile);
    await mkdir(registryFile);
    const readError = await readRegistry(context).then(() => null, (failure) => failure);
    assert.ok(readError instanceof Error);
    assert.match(readError.message, /^Cannot read JSON document in .+ \(EISDIR\)$/);
    assert.equal(readError.code, "EISDIR");

    // A missing registry is still the ordinary null.
    await rm(registryFile, { recursive: true, force: true });
    assert.equal(await readRegistry(context), null);
  });
});
