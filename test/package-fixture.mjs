// Shared fixture for the Phase 11 clean-candidate and release tests: a tiny,
// dependency-free npm package inside its own private git repository, with an
// ignored secret (`.env`) and an ignored `dist/` directory. It exercises the
// real pipeline — enumerate -> temp repo -> clone -> `npm ci` -> `npm run
// check` -> `npm test` -> pack -> consumer install -> `skill-router --version`
// — entirely inside private temp directories, offline (zero dependencies), and
// without touching the real repository, any credential, or any host config.
//
// The suite runner executes everything under `test/` as a test file, so this
// module deliberately has no side effects at import time: it only exports
// helpers.

import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../scripts/gate-lib.mjs";
import { createIsolationEnvironment } from "../scripts/clean-candidate.mjs";
import { guardedFixtureGitMutation } from "./fixture-guard.mjs";

export const FIXTURE_NAME = "clean-candidate-fixture";
export const FIXTURE_VERSION = "3.4.5";
export const FIXTURE_TARBALL = "clean-candidate-fixture-3.4.5.tgz";
export const FIXTURE_SECRET = "SENTINEL_SECRET_VALUE_PHASE11";
export const FIXTURE_FAILURE = "fixture failure marker";

/** Files a candidate enumeration must always return for the fixture. */
export const FIXTURE_CANDIDATES = [".gitignore", "cli.js", "fail-tests.mjs", "package-lock.json", "package.json", "pass-tests.mjs"];

async function git(args, cwd, env) {
  const result = await runCommand({ command: "git", args, cwd, env, timeoutMs: 60000 });
  if (!result.ok) {
    throw new Error(`fixture git ${args.join(" ")} failed: ${result.stderr || result.error || `exit ${result.code}`}`);
  }
  return result;
}

/**
 * Create the fixture repository under a private temp directory.
 *
 * Returns `{ base, repo, isolation, cleanup }`; `base` also holds the isolated
 * git environment so no fixture file is ever a candidate. `failingTests`
 * switches the fixture's `test` script to a script that exits 1.
 */
export async function createFixtureRepository({ label = "phase11", failingTests = false } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), `skill-router-${label}-`));
  const repo = path.join(base, "repo");
  const isolation = createIsolationEnvironment(path.join(base, "iso"), process.env);
  mkdirSync(repo, { recursive: true });

  await git(["-c", "init.defaultBranch=main", "init", "--quiet", `--template=${isolation.templateDir}`], repo, isolation.env);

  const packageJson = {
    name: FIXTURE_NAME,
    version: FIXTURE_VERSION,
    private: true,
    type: "module",
    bin: { "skill-router": "./cli.js" },
    files: ["cli.js"],
    scripts: {
      check: "node --check cli.js",
      test: failingTests ? "node fail-tests.mjs" : "node pass-tests.mjs",
    },
    engines: { node: ">=20" },
  };
  const files = {
    ".gitignore": "dist/\n.env\nnode_modules/\n",
    ".env": `${FIXTURE_SECRET}\n`,
    "package.json": `${JSON.stringify(packageJson, null, 2)}\n`,
    "cli.js": `#!/usr/bin/env node\nprocess.stdout.write(process.argv.includes("--version") ? "${FIXTURE_VERSION}\\n" : "fixture\\n");\n`,
    "pass-tests.mjs": 'process.stdout.write("fixture tests passed\\n");\n',
    "fail-tests.mjs": `process.stderr.write("${FIXTURE_FAILURE}\\n"); process.exit(1);\n`,
  };
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(repo, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }

  // Every fixture `git add` and `git commit` guards its own call site
  // immediately before spawning Git: a fixture inside the real work tree
  // without its own `.git` would stage the real index and move the real HEAD
  // (see `test/fixture-guard.mjs`).
  await guardedFixtureGitMutation(repo, ["add", "--all"], (args) => git(args, repo, isolation.env));
  await guardedFixtureGitMutation(
    repo,
    [
      "-c",
      "user.name=skill-router fixture",
      "-c",
      "user.email=fixture@localhost.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--no-verify",
      "-m",
      "fixture candidate",
    ],
    (args) => git(args, repo, isolation.env),
  );

  // Generated (never hand-written) so `npm ci` sees a lockfile that is exactly
  // in sync with package.json; `--offline` keeps the suite network-free.
  const lock = await runCommand({
    command: "npm",
    args: ["install", "--package-lock-only", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
    cwd: repo,
    env: isolation.env,
    timeoutMs: 60000,
  });
  if (!lock.ok) {
    await rm(base, { recursive: true, force: true });
    throw new Error(`fixture lockfile generation failed: ${lock.stderr || lock.error}`);
  }

  return {
    base,
    repo,
    isolation,
    async cleanup() {
      await rm(base, { recursive: true, force: true });
    },
  };
}
