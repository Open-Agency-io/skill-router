// Phase 11 clean-candidate gate tests: candidate enumeration (tracked plus
// untracked, ignored files and secrets excluded, deleted files reported),
// symlink and path boundaries, the temporary-repository/clone proof, the
// repository-untouched fingerprint, anti-recursion, and the full gate
// pipeline against a tiny fixture package. Every run stays inside private temp
// directories: no network, no credentials, no Docker, no host config writes.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GATE_ENV_FLAG, GateFailure, formatGateFailure, inodeIdentity, runCommand, scrubEnvironment, sha256File } from "../scripts/gate-lib.mjs";
import {
  REPOSITORY,
  SOURCE_GIT_FLAGS,
  TEMP_PREFIX,
  assertRepositoryStateUnchanged,
  assertSourceUnchanged,
  buildCandidateManifest,
  buildCandidateRepository,
  cloneCandidateRepository,
  collectCandidates,
  compareCandidateManifests,
  createIsolationEnvironment,
  formatSummary,
  PACKAGE_JSON_MAX_BYTES,
  readPackageMetadata,
  repositoryState,
  runGate,
  verifyTempRootRemoval,
} from "../scripts/clean-candidate.mjs";
import {
  FIXTURE_CANDIDATES,
  FIXTURE_FAILURE,
  FIXTURE_SECRET,
  FIXTURE_TARBALL,
  FIXTURE_VERSION,
  createFixtureRepository,
} from "./package-fixture.mjs";
import { assertFixtureOutsideRealRepository, guardedFixtureGitMutation } from "./fixture-guard.mjs";

const SECRET = `SENTINEL_SECRET_VALUE_PHASE11_ENUMERATION`;
const OUTSIDE = `SENTINEL_OUTSIDE_TARGET_PHASE11`;
const GATE_SCRIPT = path.join(REPOSITORY, "scripts", "clean-candidate.mjs");

async function runGit(args, cwd, env) {
  const result = await runCommand({ command: "git", args, cwd, env, timeoutMs: 60000 });
  assert.ok(result.ok, `git ${args.join(" ")} failed: ${result.stderr || result.error}`);
  return result;
}

function write(root, relative, contents) {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

async function scratch(label) {
  const base = await mkdtemp(path.join(os.tmpdir(), `skill-router-${label}-`));
  const isolation = createIsolationEnvironment(path.join(base, "iso"), process.env);
  const repo = path.join(base, "repo");
  mkdirSync(repo, { recursive: true });
  await runGit(["-c", "init.defaultBranch=main", "init", "--quiet", `--template=${isolation.templateDir}`], repo, isolation.env);
  return {
    base,
    repo,
    isolation,
    async cleanup() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

async function commitAll(repo, env) {
  // Both mutations guard their own call site immediately before spawning Git;
  // the runner never runs when the guard refuses.
  await guardedFixtureGitMutation(repo, ["add", "--all"], (args) => runGit(args, repo, env));
  await guardedFixtureGitMutation(
    repo,
    ["-c", "user.name=skill-router test", "-c", "user.email=test@localhost.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "--no-verify", "-m", "fixture"],
    (args) => runGit(args, repo, env),
  );
}

async function statusOf(repo, env) {
  return (await runGit(["--no-optional-locks", "status", "--porcelain=v1", "-z", "-uall"], repo, env)).stdout;
}

test("enumeration covers tracked and untracked candidates and excludes ignored secrets", async () => {
  const fx = await scratch("enumerate");
  try {
    write(fx.repo, ".gitignore", "ignored.txt\nsecrets/\n*.log\n");
    write(fx.repo, "tracked.txt", "tracked\n");
    write(fx.repo, "deleted.txt", "deleted\n");
    await commitAll(fx.repo, fx.isolation.env);
    rmSync(path.join(fx.repo, "deleted.txt"));
    write(fx.repo, "untracked.txt", "untracked\n");
    write(fx.repo, "nested/deep file.txt", "space in name\n");
    write(fx.repo, "unicode-ünicode.txt", "unicode\n");
    write(fx.repo, "ignored.txt", `IGNORED ${SECRET}\n`);
    write(fx.repo, "secrets/secret.env", `${SECRET}\n`);
    write(fx.repo, "debug.log", `log ${SECRET}\n`);

    const candidates = await collectCandidates({ repository: fx.repo, env: fx.isolation.env });
    assert.deepEqual(candidates.files, [
      ".gitignore",
      "nested/deep file.txt",
      "tracked.txt",
      "unicode-ünicode.txt",
      "untracked.txt",
    ]);
    assert.deepEqual(candidates.missing, ["deleted.txt"]);
    assert.equal(candidates.listed, 6);
    assert.ok(
      candidates.files.every((file) => !file.includes("secret") && !file.endsWith(".env") && file !== "ignored.txt" && !file.endsWith(".log")),
      "ignored files must never be candidates",
    );
    for (const file of candidates.files) {
      assert.ok(!readFileSync(path.join(fx.repo, file), "utf8").includes(SECRET), `${file} must not carry the secret`);
    }
  } finally {
    await fx.cleanup();
  }
});

test("host global git configuration cannot change the candidate set", async () => {
  const fx = await scratch("gitconfig");
  try {
    write(fx.repo, ".gitignore", "ignored.txt\n");
    write(fx.repo, "tracked.txt", "tracked\n");
    await commitAll(fx.repo, fx.isolation.env);
    write(fx.repo, "ignored.txt", "ignored\n");
    write(fx.repo, "local-note.txt", "untracked, only hidden by host global config\n");

    const hostileConfig = path.join(fx.base, "host-global.gitconfig");
    const hostileExcludes = path.join(fx.base, "host-excludes");
    writeFileSync(hostileExcludes, "local-note.txt\n");
    writeFileSync(hostileConfig, `[core]\n\texcludesfile = ${hostileExcludes}\n`);
    const hostile = scrubEnvironment(process.env, {
      GIT_CONFIG_GLOBAL: hostileConfig,
      GIT_CONFIG_SYSTEM: hostileConfig,
      GIT_CONFIG_NOSYSTEM: "0",
    });

    const underHostConfig = await collectCandidates({ repository: fx.repo, env: hostile });
    assert.ok(!underHostConfig.files.includes("local-note.txt"), "a global excludesfile does hide files when it is active");
    assert.ok(!underHostConfig.files.includes("ignored.txt"));

    const isolated = await collectCandidates({ repository: fx.repo, env: fx.isolation.env });
    assert.ok(isolated.files.includes("local-note.txt"), "the isolated environment neutralizes host global git config");
    assert.ok(isolated.files.includes("tracked.txt"));
    assert.ok(!isolated.files.includes("ignored.txt"), "the repository's own ignore rules still apply");

    assert.equal(fx.isolation.env.GIT_CONFIG_GLOBAL, fx.isolation.gitConfig);
    assert.equal(fx.isolation.env.GIT_CONFIG_SYSTEM, fx.isolation.gitConfig);
    assert.equal(fx.isolation.env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(readFileSync(fx.isolation.gitConfig, "utf8"), "", "the isolated git config is empty");
    assert.equal(fx.isolation.env[GATE_ENV_FLAG], "1");

    const withHostSecrets = createIsolationEnvironment(path.join(fx.base, "iso-secrets"), {
      ...process.env,
      GITHUB_TOKEN: "gh-secret",
      npm_config_registry: "https://registry.invalid",
      NODE_OPTIONS: "--require /tmp/hook.js",
    });
    assert.ok(!("GITHUB_TOKEN" in withHostSecrets.env), "tokens never reach a gate child");
    assert.ok(!("npm_config_registry" in withHostSecrets.env), "host npm configuration never reaches a gate child");
    assert.ok(!("NODE_OPTIONS" in withHostSecrets.env), "host node options never reach a gate child");
  } finally {
    await fx.cleanup();
  }
});

test("symlink candidates are refused and the link target is never read", async () => {
  const fx = await scratch("symlink");
  try {
    write(fx.repo, ".gitignore", "ignored.txt\n");
    write(fx.repo, "tracked.txt", "tracked\n");
    await commitAll(fx.repo, fx.isolation.env);
    write(fx.repo, "ignored.txt", "ignored\n");
    const outside = path.join(fx.base, "outside.txt");
    writeFileSync(outside, OUTSIDE);
    symlinkSync(outside, path.join(fx.repo, "link.txt"));

    await assert.rejects(collectCandidates({ repository: fx.repo, env: fx.isolation.env }), /refusing symlink candidate/);
    assert.equal(readFileSync(outside, "utf8"), OUTSIDE, "the outside target stays untouched");

    // Even a force-fed candidate — a baseline that claims `link.txt` is an
    // ordinary file — is refused at copy time, before any descriptor work.
    const destination = path.join(fx.base, "candidate-repo");
    const forceFed = [{ path: "link.txt", type: "file", size: 1, sha256: "0".repeat(64), mode: 0o644, perm: 0o644, nlink: 1, identity: null }];
    await assert.rejects(
      buildCandidateRepository({
        repository: fx.repo,
        files: ["link.txt"],
        destination,
        env: fx.isolation.env,
        templateDir: path.join(fx.base, "git-template"),
        baseline: forceFed,
      }),
      /no longer a regular file/,
    );
    assert.equal(readFileSync(outside, "utf8"), OUTSIDE, "the outside target stays untouched by the copy either");
    assert.throws(() => readdirSync(destination), "a refused build must not leave a partial candidate repository");
    assert.equal((await statusOf(fx.repo, fx.isolation.env)).includes("link.txt"), true, "the real repository keeps its entry");
  } finally {
    await fx.cleanup();
  }
});

test("the candidate repository and its clean clone hold exactly the candidate set", async () => {
  const fx = await scratch("build-clone");
  try {
    write(fx.repo, ".gitignore", "ignored.txt\nsecrets/\n");
    write(fx.repo, "package.json", `${JSON.stringify({ name: "build-clone-fixture", version: "1.0.0", bin: { "skill-router": "./cli.js" } })}\n`);
    write(fx.repo, "tracked.txt", "tracked\n");
    write(fx.repo, "deleted.txt", "deleted\n");
    await commitAll(fx.repo, fx.isolation.env);
    rmSync(path.join(fx.repo, "deleted.txt"));
    write(fx.repo, "untracked.txt", "untracked\n");
    write(fx.repo, "nested/deep.txt", "deep\n");
    write(fx.repo, "ignored.txt", `ignored ${SECRET}\n`);
    write(fx.repo, "secrets/secret.env", `${SECRET}\n`);

    const statusBefore = await statusOf(fx.repo, fx.isolation.env);
    const candidates = await collectCandidates({ repository: fx.repo, env: fx.isolation.env });
    const destination = path.join(fx.base, "candidate-repo");
    const templateDir = path.join(fx.base, "git-template");
    await buildCandidateRepository({
      repository: fx.repo,
      files: candidates.files,
      destination,
      env: fx.isolation.env,
      templateDir,
    });

    const committed = (await runGit(["ls-files", "-z", "--full-name"], destination, fx.isolation.env)).stdout.split("\0").filter(Boolean).sort();
    assert.deepEqual(committed, [...candidates.files].sort());

    // No secret bytes anywhere in the candidate repository (lstat-only walk).
    const leaked = [];
    const walk = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          leaked.push(`symlink:${target}`);
        } else if (entry.isDirectory()) {
          if (entry.name !== ".git") walk(target);
        } else if (readFileSync(target, "utf8").includes(SECRET)) {
          leaked.push(target);
        }
      }
    };
    walk(destination);
    assert.deepEqual(leaked, [], "no ignored file or secret may enter the candidate repository");

    const clone = path.join(fx.base, "clone");
    await cloneCandidateRepository({ source: destination, destination: clone, files: candidates.files, env: fx.isolation.env, baseline: candidates.manifest });
    const cloned = (await runGit(["ls-files", "-z", "--full-name"], clone, fx.isolation.env)).stdout.split("\0").filter(Boolean).sort();
    assert.deepEqual(cloned, [...candidates.files].sort());
    assert.equal(await statusOf(clone, fx.isolation.env), "", "the clone is a genuinely clean work tree");

    // Package metadata is bound to the committed snapshot: the clone's
    // package.json hashes to the manifest digest and parses to the same
    // identity the source declared.
    const sourceEntry = candidates.manifest.find((entry) => entry.path === "package.json");
    assert.ok(sourceEntry, "package.json is in the candidate manifest");
    assert.equal(await sha256File(path.join(clone, "package.json")), sourceEntry.sha256, "the committed package.json bytes match the manifest");
    assert.deepEqual(readPackageMetadata(clone).bin, readPackageMetadata(fx.repo).bin);

    assert.equal(await statusOf(fx.repo, fx.isolation.env), statusBefore, "building the candidate repository never touches the real one");
  } finally {
    await fx.cleanup();
  }
});

test("the repository fingerprint detects status, index, and root-entry drift", async () => {
  const fx = await scratch("state");
  try {
    write(fx.repo, "tracked.txt", "tracked\n");
    await commitAll(fx.repo, fx.isolation.env);
    const before = await repositoryState({ repository: fx.repo, env: fx.isolation.env });

    assert.equal(assertRepositoryStateUnchanged(before, { ...before }), true);
    assert.equal(before.head.detached, false, "the fingerprint carries the exact HEAD state");
    assert.equal(before.head.unborn, false);
    assert.equal(before.head.symbolic, "refs/heads/main");
    assert.match(before.head.oid, /^[0-9a-f]{40,64}$/);
    assert.throws(() => assertRepositoryStateUnchanged(before, { ...before, status: `${before.status}?? extra\0` }), /status changed/);
    assert.throws(
      () => assertRepositoryStateUnchanged(before, { ...before, head: { ...before.head, oid: "f".repeat(before.head.oid.length) } }),
      /HEAD moved/,
    );
    assert.throws(
      () => assertRepositoryStateUnchanged(before, { ...before, head: null }),
      /HEAD moved/,
      "a missing HEAD fingerprint is drift, not a pass",
    );
    assert.throws(
      () => assertRepositoryStateUnchanged(before, { ...before, index: { ...before.index, mtimeMs: 1 } }),
      /index was modified/,
    );
    assert.throws(
      () => assertRepositoryStateUnchanged(before, { ...before, rootEntries: [...before.rootEntries, "dist"] }),
      /top-level entries changed/,
    );

    write(fx.repo, "extra.txt", "extra\n");
    const after = await repositoryState({ repository: fx.repo, env: fx.isolation.env });
    assert.throws(() => assertRepositoryStateUnchanged(before, after), /status changed/);
    rmSync(path.join(fx.repo, "extra.txt"));
    const restored = await repositoryState({ repository: fx.repo, env: fx.isolation.env });
    assert.equal(restored.status, before.status);
    assert.deepEqual(restored.index, before.index);
    assert.deepEqual(restored.rootEntries, before.rootEntries);
  } finally {
    await fx.cleanup();
  }
});

test("a gate invocation nested in its own child environment fails closed before any work", async () => {
  const fx = await scratch("nested");
  const privateTmp = path.join(fx.base, "private-tmp");
  mkdirSync(privateTmp, { recursive: true });
  try {
    await assert.rejects(
      runGate({
        repository: REPOSITORY,
        tmpParent: privateTmp,
        env: { ...process.env, SKILL_ROUTER_GATE_ACTIVE: "1" },
      }),
      /nested clean-candidate gate refused/,
    );
    assert.deepEqual(await readdir(privateTmp), [], "a refused gate must not create a temp root");

    const cli = await runCommand({
      command: process.execPath,
      args: [GATE_SCRIPT],
      env: {
        ...process.env,
        SKILL_ROUTER_GATE_ACTIVE: "1",
        TMPDIR: privateTmp,
        TMP: privateTmp,
        TEMP: privateTmp,
        HOME: path.join(fx.base, "home"),
      },
      timeoutMs: 60000,
    });
    assert.equal(cli.code, 1, cli.stdout);
    assert.match(cli.stderr, /nested clean-candidate gate refused/);
    assert.ok(!cli.stdout.includes("gate: clean"), "the nested CLI must not reach a summary");
    assert.deepEqual(await readdir(privateTmp), [], "the nested CLI must not create a temp root");
  } finally {
    await fx.cleanup();
  }
});

test("the temporary root must live outside the repository", async () => {
  const fx = await scratch("tmp-parent");
  try {
    write(fx.repo, "package.json", `${JSON.stringify({ name: "tmp-parent-fixture", version: "1.0.0", bin: { "skill-router": "./cli.js" } })}\n`);
    const inside = path.join(fx.repo, "gate-tmp");
    mkdirSync(inside, { recursive: true });
    const statusBefore = await statusOf(fx.repo, fx.isolation.env);
    await assert.rejects(
      runGate({ repository: fx.repo, tmpParent: inside, env: fx.isolation.env }),
      /must be outside the repository/,
    );
    assert.deepEqual(await readdir(inside), [], "no temp root may be created inside the repository");
    assert.equal(await statusOf(fx.repo, fx.isolation.env), statusBefore);
  } finally {
    await fx.cleanup();
  }
});

test("a candidate set without a lockfile fails closed and cleans up", async () => {
  const fx = await scratch("lockfile");
  try {
    write(
      fx.repo,
      "package.json",
      `${JSON.stringify(
        {
          name: "no-lock-fixture",
          version: "1.0.0",
          bin: { "skill-router": "./cli.js" },
          scripts: { check: "node --check cli.js", test: "node cli.js" },
        },
        null,
        2,
      )}\n`,
    );
    write(fx.repo, "cli.js", 'process.stdout.write("no-lock\\n");\n');
    await commitAll(fx.repo, fx.isolation.env);
    const gateTmp = path.join(fx.base, "gate-tmp");
    mkdirSync(gateTmp, { recursive: true });

    await assert.rejects(
      runGate({ repository: fx.repo, tmpParent: gateTmp, env: fx.isolation.env }),
      (error) => error instanceof GateFailure && error.step === "package" && /package-lock\.json is missing/.test(error.message),
    );
    assert.deepEqual(await readdir(gateTmp), [], "a failed gate must remove its temporary root");
  } finally {
    await fx.cleanup();
  }
});

test("an exhausted time budget fails closed at the next step and cleans up", async () => {
  const fx = await createFixtureRepository({ label: "budget" });
  try {
    const gateTmp = path.join(fx.base, "gate-tmp");
    mkdirSync(gateTmp, { recursive: true });
    const statusBefore = await statusOf(fx.repo, fx.isolation.env);
    await assert.rejects(
      runGate({ repository: fx.repo, tmpParent: gateTmp, env: fx.isolation.env, budgetMs: 0 }),
      /time budget exhausted/,
    );
    assert.deepEqual(await readdir(gateTmp), [], "a budget failure must remove its temporary root");
    assert.equal(await statusOf(fx.repo, fx.isolation.env), statusBefore, "the repository stays untouched");
  } finally {
    await fx.cleanup();
  }
});

test("the full gate passes for a clean candidate and leaves nothing behind", async () => {
  const fx = await createFixtureRepository({ label: "gate-pass" });
  try {
    const gateTmp = path.join(fx.base, "gate-tmp");
    mkdirSync(gateTmp, { recursive: true });
    const statusBefore = await statusOf(fx.repo, fx.isolation.env);

    const summary = await runGate({ repository: fx.repo, tmpParent: gateTmp, env: fx.isolation.env });

    assert.equal(summary.candidates.files, FIXTURE_CANDIDATES.length);
    assert.deepEqual(summary.candidates.missing, []);
    assert.deepEqual(summary.steps, [
      "npm ci",
      "npm run check",
      "npm test",
      "npm pack",
      "consumer install",
      "installed skill-router --version",
    ]);
    assert.equal(summary.tarball.filename, FIXTURE_TARBALL);
    assert.match(summary.tarball.sha256, /^[0-9a-f]{64}$/);
    assert.ok(summary.tarball.size > 0);
    assert.ok(summary.tarball.files.includes("package.json"));
    assert.ok(summary.tarball.files.includes("cli.js"));
    assert.ok(
      summary.tarball.files.every((file) => !file.includes(".env") && !file.includes("dist/")),
      "the tarball carries no ignored file",
    );
    assert.equal(summary.consumer.version, FIXTURE_VERSION);
    assert.equal(summary.consumer.bin, "skill-router");
    assert.ok(
      readFileSync(path.join(fx.repo, ".env"), "utf8").includes(FIXTURE_SECRET),
      "the ignored secret stays in the repository, untouched",
    );

    const line = formatSummary(summary);
    assert.ok(line.startsWith("gate: clean |"), line);
    assert.ok(line.includes(`candidates ${FIXTURE_CANDIDATES.length} |`), line);
    assert.ok(line.includes(FIXTURE_TARBALL), line);
    assert.ok(line.includes("temp cleaned"), line);
    assert.ok(!line.includes("\n"), "the summary is a single bounded line");
    assert.ok(line.length < 2000, `summary must stay bounded, got ${line.length}`);

    assert.deepEqual(await readdir(gateTmp), [], "no temporary root may survive a passing gate");
    assert.ok(summary.tempRoot.startsWith(`${gateTmp}${path.sep}`), "the temp root was created under the caller's temp parent");
    assert.ok(!existsSync(summary.tempRoot), "the temp root is removed before the gate returns");
    assert.equal(await statusOf(fx.repo, fx.isolation.env), statusBefore, "the repository stays untouched");
  } finally {
    await fx.cleanup();
  }
});

test("a failing candidate test run fails closed with bounded diagnostics", async () => {
  const fx = await createFixtureRepository({ label: "gate-fail", failingTests: true });
  try {
    const gateTmp = path.join(fx.base, "gate-tmp");
    mkdirSync(gateTmp, { recursive: true });
    const statusBefore = await statusOf(fx.repo, fx.isolation.env);

    const failure = await runGate({ repository: fx.repo, tmpParent: gateTmp, env: fx.isolation.env }).then(
      () => null,
      (error) => error,
    );
    assert.ok(failure instanceof GateFailure, "a failing candidate must fail the gate");
    assert.equal(failure.step, "npm test");
    assert.match(failure.message, /`npm test` failed/);

    const rendered = formatGateFailure(failure);
    assert.ok(rendered.includes(FIXTURE_FAILURE), "the candidate's own failure output must reach the diagnostics");
    assert.ok(rendered.length < 40000, `diagnostics must stay bounded, got ${rendered.length}`);

    assert.deepEqual(await readdir(gateTmp), [], "no temporary root may survive a failing gate");
    assert.equal(await statusOf(fx.repo, fx.isolation.env), statusBefore, "the repository stays untouched");
  } finally {
    await fx.cleanup();
  }
});

/** The real runner, except that the gate's consumer install fails on purpose. */
function failAtConsumerInstall() {
  return async (options) => {
    const args = Array.isArray(options.args) ? options.args : [];
    if (options.command === "npm" && args[0] === "install") {
      return {
        command: options.command,
        args,
        cwd: options.cwd,
        ok: false,
        code: 1,
        signal: null,
        error: null,
        timedOut: false,
        stdout: "",
        stderr: "injected consumer install failure\n",
        truncated: false,
        invalidEncoding: false,
        durationMs: 0,
        pid: null,
        survived: false,
      };
    }
    return runCommand(options);
  };
}

test("the candidate manifest records type, size, digest, normalized mode, and link count", async () => {
  const fx = await scratch("manifest");
  try {
    write(fx.repo, ".gitignore", "ignored.txt\n");
    write(fx.repo, "tracked.txt", "tracked\n");
    write(fx.repo, "run.sh", "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(fx.repo, "run.sh"), 0o755);
    await commitAll(fx.repo, fx.isolation.env);
    write(fx.repo, "untracked.txt", "untracked\n");

    const candidates = await collectCandidates({ repository: fx.repo, env: fx.isolation.env });
    const byPath = new Map(candidates.manifest.map((entry) => [entry.path, entry]));
    assert.deepEqual([...byPath.keys()].sort(), [".gitignore", "run.sh", "tracked.txt", "untracked.txt"]);

    const executable = byPath.get("run.sh");
    assert.equal(executable.type, "file");
    assert.equal(executable.nlink, 1, "the link-count policy is recorded");
    assert.equal(executable.mode, 0o755, "an execute bit normalizes to the git executable mode");
    assert.equal(executable.perm & 0o111, 0o111, "the permission bits are kept as well");
    assert.equal(executable.size, readFileSync(path.join(fx.repo, "run.sh"), "utf8").length);
    assert.match(executable.sha256, /^[0-9a-f]{64}$/);
    assert.equal(executable.sha256, await sha256File(path.join(fx.repo, "run.sh")), "the manifest digest is the file's own content digest");
    assert.equal(byPath.get("tracked.txt").mode, 0o644, "a non-executable file normalizes to 0644");

    const again = await buildCandidateManifest({ repository: fx.repo, files: candidates.files });
    assert.deepEqual(again, candidates.manifest, "the manifest is deterministic");
    assert.deepEqual(compareCandidateManifests(candidates.manifest, again), [], "an unchanged tree has no drift");
  } finally {
    await fx.cleanup();
  }
});

test("a hard-linked candidate is refused before anything is copied", async () => {
  const fx = await scratch("hardlink");
  try {
    write(fx.repo, ".gitignore", "ignored.txt\n");
    write(fx.repo, "tracked.txt", "tracked\n");
    await commitAll(fx.repo, fx.isolation.env);
    linkSync(path.join(fx.repo, "tracked.txt"), path.join(fx.repo, "alias.txt"));

    await assert.rejects(collectCandidates({ repository: fx.repo, env: fx.isolation.env }), /hard-linked candidate/);
    await assert.rejects(buildCandidateManifest({ repository: fx.repo, files: ["tracked.txt"] }), /hard-linked candidate/);
    await assert.rejects(
      buildCandidateRepository({
        repository: fx.repo,
        files: ["tracked.txt"],
        destination: path.join(fx.base, "candidate-repo"),
        env: fx.isolation.env,
      }),
      /hard-linked candidate/,
    );
    assert.ok(!existsSync(path.join(fx.base, "candidate-repo")), "a refused build leaves no directory behind");
  } finally {
    await fx.cleanup();
  }
});

test("an ancestor swapped for a symlink is refused deterministically", async () => {
  const fx = await scratch("ancestor");
  try {
    write(fx.repo, ".gitignore", "ignored.txt\n");
    write(fx.repo, "nested/file.txt", "inside\n");
    await commitAll(fx.repo, fx.isolation.env);
    // Keep `nested/file.txt` tracked while making the *directory entry* itself
    // untracked: `.git/info/exclude` is repo-local metadata (never a candidate),
    // so the swapped symlink drops out of `--others` and the tracked file
    // beneath it is what reaches the ancestor walk. The fixture's empty git
    // template means `.git/info` does not exist yet.
    mkdirSync(path.join(fx.repo, ".git", "info"), { recursive: true });
    appendFileSync(path.join(fx.repo, ".git", "info", "exclude"), "nested\n");
    const outside = path.join(fx.base, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "file.txt"), OUTSIDE);

    rmSync(path.join(fx.repo, "nested"), { recursive: true, force: true });
    symlinkSync(outside, path.join(fx.repo, "nested"));

    await assert.rejects(
      collectCandidates({ repository: fx.repo, env: fx.isolation.env }),
      (error) =>
        error instanceof GateFailure &&
        /crosses a symbolic link/.test(error.message) &&
        error.message.includes("nested"),
      "the tracked file beneath the swapped ancestor must be refused",
    );
    assert.equal(readFileSync(path.join(outside, "file.txt"), "utf8"), OUTSIDE, "the outside target is never read");
  } finally {
    await fx.cleanup();
  }
});

test("status-identical content drift is reported from the manifest, not from git status", async () => {
  const fx = await scratch("drift");
  try {
    write(fx.repo, ".gitignore", "ignored.txt\n");
    write(fx.repo, "tracked.txt", "tracked\n");
    await commitAll(fx.repo, fx.isolation.env);
    // Both files are already dirty, so a *second* edit keeps git status
    // byte-identical: untracked stays `??`, tracked stays ` M`.
    write(fx.repo, "untracked.txt", "untracked v1\n");
    write(fx.repo, "tracked.txt", "modified v1\n");

    const baseline = await collectCandidates({ repository: fx.repo, env: fx.isolation.env });
    const before = await repositoryState({ repository: fx.repo, env: fx.isolation.env });

    write(fx.repo, "untracked.txt", "untracked v2\n"); // same length, different bytes
    write(fx.repo, "tracked.txt", "modified v2\n"); // same length, different bytes
    const after = await repositoryState({ repository: fx.repo, env: fx.isolation.env });

    assert.equal(after.status, before.status, "git status is byte-identical: a status-only proof would miss this");
    assert.deepEqual(after.index, before.index, "the index does not move either");
    assert.equal(assertRepositoryStateUnchanged(before, after), true, "the status/index/root-entry fingerprint passes");

    await assert.rejects(
      assertSourceUnchanged({ repository: fx.repo, files: baseline.files, baseline: baseline.manifest, env: fx.isolation.env }),
      (error) =>
        error instanceof GateFailure &&
        /changed during the gate run/.test(error.message) &&
        (error.details ?? []).some(([, value]) => /untracked\.txt|tracked\.txt/.test(String(value))),
      "the manifest catches same-size, same-status drift",
    );
  } finally {
    await fx.cleanup();
  }
});

test("an executable-only flip with an unchanged status is drift", async () => {
  const fx = await scratch("execdrift");
  try {
    write(fx.repo, ".gitignore", "ignored.txt\n");
    await commitAll(fx.repo, fx.isolation.env);
    // Untracked: git reports `??` for it whatever its mode, so the only
    // witness to an execute-bit flip is the manifest.
    write(fx.repo, "tool.sh", "#!/bin/sh\nexit 0\n");

    const baseline = await collectCandidates({ repository: fx.repo, env: fx.isolation.env });
    const before = await repositoryState({ repository: fx.repo, env: fx.isolation.env });
    chmodSync(path.join(fx.repo, "tool.sh"), 0o755);
    const after = await repositoryState({ repository: fx.repo, env: fx.isolation.env });

    assert.equal(after.status, before.status, "an untracked file's status does not encode its mode");
    await assert.rejects(
      assertSourceUnchanged({ repository: fx.repo, files: baseline.files, baseline: baseline.manifest, env: fx.isolation.env }),
      (error) => error instanceof GateFailure && (error.details ?? []).some(([, value]) => /mode/.test(String(value))),
      "the mode change must appear in the drift diagnostics",
    );
  } finally {
    await fx.cleanup();
  }
});

test("host ignore rules that hide a file refuse the gate generically, before copying", async () => {
  const fx = await scratch("privacy");
  try {
    write(fx.repo, ".gitignore", "ignored.txt\n");
    write(fx.repo, "package.json", `${JSON.stringify({ name: "privacy-fixture", version: "1.0.0", bin: { "skill-router": "./cli.js" } })}\n`);
    write(fx.repo, "tracked.txt", "tracked\n");
    await commitAll(fx.repo, fx.isolation.env);
    write(fx.repo, "ignored.txt", "ignored\n");
    const hiddenName = "local-note.txt";
    write(fx.repo, hiddenName, `${SECRET}\n`);
    const statusBefore = await statusOf(fx.repo, fx.isolation.env);

    const hostileConfig = path.join(fx.base, "host-global.gitconfig");
    const hostileExcludes = path.join(fx.base, "host-excludes");
    writeFileSync(hostileExcludes, `${hiddenName}\n`);
    writeFileSync(hostileConfig, `[core]\n\texcludesfile = ${hostileExcludes}\n`);
    const hostile = scrubEnvironment(process.env, {
      GIT_CONFIG_GLOBAL: hostileConfig,
      GIT_CONFIG_SYSTEM: hostileConfig,
      GIT_CONFIG_NOSYSTEM: "0",
    });

    const gateTmp = path.join(fx.base, "gate-tmp");
    mkdirSync(gateTmp, { recursive: true });

    const failure = await runGate({ repository: fx.repo, tmpParent: gateTmp, env: hostile }).then(() => null, (error) => error);
    assert.ok(failure instanceof GateFailure, "the gate must refuse rather than copy a host-hidden file");
    assert.equal(failure.step, "enumerate");
    assert.match(failure.message, /ignore configuration hides files/);
    const rendered = formatGateFailure(failure);
    assert.ok(rendered.includes(".gitignore"), "the refusal points at the repository's own ignore rules");
    assert.ok(!rendered.includes(hiddenName), "the hidden filename is never disclosed");
    assert.ok(!rendered.includes(SECRET), "no content from the hidden file is disclosed");
    assert.deepEqual(await readdir(gateTmp), [], "the refused run leaves no temp root behind");
    assert.equal(await statusOf(fx.repo, fx.isolation.env), statusBefore, "the repository stays untouched");
  } finally {
    await fx.cleanup();
  }
});

test("a repository-configured fsmonitor hook is never invoked by source commands", async () => {
  const fx = await scratch("fsmonitor");
  try {
    write(fx.repo, ".gitignore", "ignored.txt\n");
    write(fx.repo, "tracked.txt", "tracked\n");
    await commitAll(fx.repo, fx.isolation.env);
    write(fx.repo, "untracked.txt", "untracked\n");

    const marker = path.join(fx.base, "fsmonitor-invoked");
    const hook = path.join(fx.base, "fsmonitor-hook.sh");
    writeFileSync(hook, `#!/bin/sh\necho invoked >> "${marker}"\nexit 0\n`);
    chmodSync(hook, 0o755);
    await guardedFixtureGitMutation(fx.repo, ["config", "core.fsmonitor", hook], (args) => runGit(args, fx.repo, fx.isolation.env));

    // Control: git really does execute this hook when nothing disables it, so
    // the absence below is evidence rather than an accident of configuration.
    const control = await runCommand({ command: "git", args: ["status", "--porcelain"], cwd: fx.repo, env: fx.isolation.env, timeoutMs: 60000 });
    assert.ok(control.ok, control.stderr || control.error);
    assert.ok(existsSync(marker), "control: the configured fsmonitor hook is invoked by a plain git status");
    rmSync(marker);

    await collectCandidates({ repository: fx.repo, env: fx.isolation.env });
    await repositoryState({ repository: fx.repo, env: fx.isolation.env });
    assert.ok(!existsSync(marker), "the gate's source commands must never invoke fsmonitor");
  } finally {
    await fx.cleanup();
  }
});

test("every source git command carries the external-behaviour kill switches", async () => {
  const fx = await scratch("gitflags");
  try {
    write(fx.repo, ".gitignore", "ignored.txt\n");
    write(fx.repo, "tracked.txt", "tracked\n");
    await commitAll(fx.repo, fx.isolation.env);

    const recorded = [];
    const recordingRun = async (options) => {
      recorded.push({ command: options.command, args: [...(options.args ?? [])] });
      return runCommand(options);
    };
    const hooksDir = path.join(fx.base, "no-hooks");
    await collectCandidates({ repository: fx.repo, env: fx.isolation.env, run: recordingRun, hooksDir });
    await repositoryState({ repository: fx.repo, env: fx.isolation.env, run: recordingRun, hooksDir });

    assert.ok(recorded.length >= 3, "several source commands were observed");
    for (const call of recorded) {
      assert.equal(call.command, "git");
      assert.deepEqual(call.args.slice(0, 2), ["-c", "core.fsmonitor=false"], `fsmonitor must be disabled first: ${call.args.join(" ")}`);
      assert.ok(call.args.includes("core.useBuiltinFSMonitor=false"));
      assert.ok(call.args.includes("core.untrackedCache=false"));
      assert.ok(call.args.includes(`core.hooksPath=${hooksDir}`), "hooks are redirected to the gate-owned empty directory");
    }
    assert.deepEqual(
      [...SOURCE_GIT_FLAGS].filter((_, index) => index % 2 === 1),
      ["core.fsmonitor=false", "core.useBuiltinFSMonitor=false", "core.untrackedCache=false", "gc.auto=0"],
    );
  } finally {
    await fx.cleanup();
  }
});

test("a git path list that is not valid UTF-8 fails the enumeration closed", async () => {
  const fx = await scratch("utf8");
  try {
    write(fx.repo, ".gitignore", "ignored.txt\n");
    write(fx.repo, "tracked.txt", "tracked\n");
    await commitAll(fx.repo, fx.isolation.env);

    // A `git` that answers rev-parse correctly but emits raw invalid bytes for
    // `ls-files -z` — the shape a non-UTF-8 filename would produce. The path is
    // resolved from PATH like any other tool, and the failure is fail-closed.
    const bin = path.join(fx.base, "fake-bin");
    mkdirSync(bin, { recursive: true });
    const fakeGit = path.join(bin, "git");
    writeFileSync(
      fakeGit,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        'if (args.includes("rev-parse")) { process.stdout.write(process.cwd() + "\\n"); process.exit(0); }',
        'if (args.includes("ls-files")) { process.stdout.write(Buffer.from([0x61, 0xff, 0x00])); process.exit(0); }',
        "process.exit(0);",
        "",
      ].join("\n"),
    );
    chmodSync(fakeGit, 0o755);

    const env = { ...fx.isolation.env, PATH: `${bin}${path.delimiter}${fx.isolation.env.PATH}` };
    await assert.rejects(
      collectCandidates({ repository: fx.repo, env }),
      (error) => error instanceof GateFailure && /not valid UTF-8/.test(error.message) && error.step === "enumerate",
    );
  } finally {
    await fx.cleanup();
  }
});

test("a relative or repository-local PATH cannot supply git or npm", async () => {
  const fx = await scratch("path");
  try {
    write(
      fx.repo,
      "package.json",
      `${JSON.stringify({ name: "path-fixture", version: "1.0.0", bin: { "skill-router": "./cli.js" } })}\n`,
    );
    write(fx.repo, "cli.js", 'process.stdout.write("path\\n");\n');
    const gateTmp = path.join(fx.base, "gate-tmp");
    mkdirSync(gateTmp, { recursive: true });

    // (a) a relative PATH component is refused before the temp root exists.
    const relative = await runGate({ repository: fx.repo, tmpParent: gateTmp, env: { ...fx.isolation.env, PATH: "." } }).then(
      () => null,
      (error) => error,
    );
    assert.ok(relative instanceof GateFailure, "PATH=. must be refused");
    assert.equal(relative.step, "setup");
    assert.match(relative.message, /relative component/);
    assert.deepEqual(await readdir(gateTmp), [], "tool resolution runs before any temp root is created");

    // (b) a repository-local fake `git` is refused and never executed.
    const marker = path.join(fx.base, "fake-git-ran");
    writeFileSync(path.join(fx.repo, "git"), `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(path.join(fx.repo, "git"), 0o755);
    const fake = await runGate({
      repository: fx.repo,
      tmpParent: gateTmp,
      env: { ...fx.isolation.env, PATH: `${fx.repo}${path.delimiter}${process.env.PATH}` },
    }).then(() => null, (error) => error);
    assert.ok(fake instanceof GateFailure, "a repository-local tool must be refused");
    assert.equal(fake.step, "setup");
    assert.match(fake.message, /inside the candidate repository/);
    assert.ok(!existsSync(marker), "the repository-local fake git is never executed");
    assert.deepEqual(await readdir(gateTmp), [], "no temp root is created for a refused tool either");
  } finally {
    await fx.cleanup();
  }
});

test("the core gate environment carries no credentials, config channels, or host temp path", async () => {
  const ambientTemp = path.join(REPOSITORY, "node_modules", "ambient-inside-source");
  const base = {
    ...process.env,
    GITHUB_ENV: "/runner/env",
    GITHUB_PATH: "/runner/path",
    GITHUB_OUTPUT: "/runner/output",
    GITHUB_STATE: "/runner/state",
    GITHUB_ACTIONS: "true",
    RUNNER_TEMP: "/runner/temp",
    RUNNER_TOOL_CACHE: "/runner/tool-cache",
    ACTIONS_CACHE_URL: "https://cache.invalid",
    DOCKER_CONFIG: "/host/docker",
    KUBECONFIG: "/host/kube/config",
    AWS_CONFIG_FILE: "/host/aws/config",
    AWS_SHARED_CREDENTIALS_FILE: "/host/aws/credentials",
    AWS_ACCESS_KEY_ID: "AKIA-SENTINEL",
    CLOUDSDK_CONFIG: "/host/gcloud",
    AZURE_CONFIG_DIR: "/host/azure",
    GOOGLE_APPLICATION_CREDENTIALS: "/host/service-account.json",
    SSH_AUTH_SOCK: "/host/ssh-agent",
    SSLKEYLOGFILE: "/host/keys.log",
    npm_config_registry: "https://registry.invalid",
    NPM_CONFIG_USERCONFIG: "/host/.npmrc",
    NPM_TOKEN: "SENTINEL_NPM_SECRET",
    GITHUB_TOKEN: "SENTINEL_GH_SECRET",
    ANTHROPIC_API_KEY: "SENTINEL_MODEL_SECRET",
    NODE_OPTIONS: "--require /host/hook.js",
    INIT_CWD: "/host/project",
    GIT_CONFIG_PARAMETERS: "core.hooksPath=/host/hooks",
    GIT_DIR: "/host/elsewhere",
    // Realistic GitHub-hosted runner values: the step's working directory and
    // shell context leak the host workspace path through PWD/OLDDPWD unless
    // the scrub drops them. The gate child must never see any of them.
    PWD: "/home/runner/work/skill-router/skill-router",
    OLDPWD: "/home/runner/work",
    _: "/opt/hostedtoolcache/node/24.21.0/x64/bin/node",
    TMPDIR: ambientTemp,
    TMP: ambientTemp,
    TEMP: ambientTemp,
    KEEP_ME: "kept",
  };
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-env-"));
  try {
    const isolation = createIsolationEnvironment(root, base);
    const env = isolation.env;
    const injectedChannels = [
      "GITHUB_ENV",
      "GITHUB_PATH",
      "GITHUB_OUTPUT",
      "GITHUB_STATE",
      "GITHUB_ACTIONS",
      "GITHUB_TOKEN",
      "RUNNER_TEMP",
      "RUNNER_TOOL_CACHE",
      "ACTIONS_CACHE_URL",
      "DOCKER_CONFIG",
      "KUBECONFIG",
      "AWS_CONFIG_FILE",
      "AWS_SHARED_CREDENTIALS_FILE",
      "AWS_ACCESS_KEY_ID",
      "CLOUDSDK_CONFIG",
      "AZURE_CONFIG_DIR",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "SSH_AUTH_SOCK",
      "SSLKEYLOGFILE",
      "npm_config_registry",
      "NPM_CONFIG_USERCONFIG",
      "NPM_TOKEN",
      "ANTHROPIC_API_KEY",
      "NODE_OPTIONS",
      "INIT_CWD",
      "GIT_CONFIG_PARAMETERS",
      "GIT_DIR",
      "PWD",
      "OLDPWD",
      "_",
    ];
    for (const key of injectedChannels) {
      assert.ok(!(key in env), `${key} must not reach a gate child`);
    }
    assert.equal(env.KEEP_ME, "kept", "an unrelated variable still passes through");
    assert.equal(env.PATH, base.PATH, "PATH stays so node and npm keep resolving");
    assert.equal(env[GATE_ENV_FLAG], "1");
    assert.equal(env.TMPDIR, isolation.tempDir, "children get the gate-owned temp directory, never the ambient one");
    assert.ok(!String(env.TMPDIR).startsWith(ambientTemp), "the ambient TMPDIR is never inherited");

    const serialized = JSON.stringify(env);
    for (const secret of ["SENTINEL_", "AKIA-", "/host/", "/runner/", "registry.invalid", "/host/project"]) {
      assert.ok(!serialized.includes(secret), `no credential or host-config value may survive: ${secret}`);
    }
    assert.ok(!existsSync(ambientTemp), "the ambient temp path inside the source is never created");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an ambient TMPDIR inside the source repository is never written to", async () => {
  const fx = await createFixtureRepository({ label: "tmpdir" });
  try {
    const insideRepo = path.join(fx.repo, "ambient-tmp");
    mkdirSync(insideRepo, { recursive: true });
    const gateTmp = path.join(fx.base, "gate-tmp");
    mkdirSync(gateTmp, { recursive: true });
    const statusBefore = await statusOf(fx.repo, fx.isolation.env);

    const summary = await runGate({
      repository: fx.repo,
      tmpParent: gateTmp,
      env: { ...fx.isolation.env, TMPDIR: insideRepo, TMP: insideRepo, TEMP: insideRepo },
    });

    assert.deepEqual(readdirSync(insideRepo), [], "no child may write into a temp directory that lives inside the source");
    assert.deepEqual(await readdir(gateTmp), [], "the gate's own temp root is removed");
    assert.ok(summary.tempRoot.startsWith(`${gateTmp}${path.sep}`), "the temp root is created under the caller's temp parent");
    assert.ok(summary.tempRoot.includes(`${TEMP_PREFIX}`), "the temp root uses the gate prefix");
    assert.equal(await statusOf(fx.repo, fx.isolation.env), statusBefore, "the repository stays untouched");
  } finally {
    await fx.cleanup();
  }
});

test("a symlinked temp parent is refused before anything is created", async () => {
  const fx = await scratch("tmp-symlink");
  try {
    const real = path.join(fx.base, "real-tmp");
    mkdirSync(real, { recursive: true });
    const link = path.join(fx.base, "link-tmp");
    symlinkSync(real, link);

    const failure = await runGate({ repository: fx.repo, tmpParent: link, env: fx.isolation.env }).then(() => null, (error) => error);
    assert.ok(failure instanceof GateFailure, "a symlinked temp parent must be refused");
    assert.equal(failure.step, "setup");
    assert.match(failure.message, /symbolic link/);
    assert.deepEqual(await readdir(real), [], "nothing is created through the link");
    assert.deepEqual(await readdir(link), []);
  } finally {
    await fx.cleanup();
  }
});

test("package bin must be exactly {\"skill-router\": \"<safe relative path>\"}", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-bin-"));
  try {
    const base = { name: "bin-fixture", version: "1.2.3" };
    const writePackage = (pkg) => writeFileSync(path.join(root, "package.json"), `${JSON.stringify(pkg)}\n`);
    const refused = [
      [base, /must declare exactly one object bin entry/, "missing bin"],
      [{ ...base, bin: "./cli.js" }, /must declare exactly one object bin entry/, "string bin"],
      [{ ...base, bin: ["./cli.js"] }, /must declare exactly one object bin entry/, "array bin"],
      [{ ...base, bin: {} }, /must declare a bin entry/, "empty bin map"],
      [{ ...base, bin: { cli: "./cli.js" } }, /exactly one entry named "skill-router"/, "missing skill-router key"],
      [{ ...base, bin: { other: "./other.js", "skill-router": "./cli.js" } }, /exactly one entry named "skill-router"/, "other bin first"],
      [{ ...base, bin: { "skill-router": "./cli.js", other: "./other.js" } }, /exactly one entry named "skill-router"/, "reordered with an extra key"],
      [{ ...base, bin: { "skill-router": "../escape.js" } }, /unsafe path/, "escaping path"],
      [{ ...base, bin: { "skill-router": "/abs.js" } }, /unsafe path/, "absolute path"],
      [{ ...base, bin: { "skill-router": "./a/../../b.js" } }, /unsafe path/, "traversing path"],
      [{ ...base, bin: { "skill-router": 42 } }, /is not a path/, "non-string target"],
    ];
    for (const [pkg, pattern, label] of refused) {
      writePackage(pkg);
      assert.throws(() => readPackageMetadata(root), pattern, `expected refusal for ${label}`);
    }

    writePackage({ ...base, bin: { "skill-router": "./cli.js" } });
    const accepted = readPackageMetadata(root);
    assert.deepEqual(accepted.bin, { "skill-router": "./cli.js" });
    assert.deepEqual(accepted.requiredFiles, ["package.json", "cli.js"]);
    assert.equal(accepted.version, "1.2.3");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("temp-root removal is proven by inode, including a renamed same-inode root", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "skill-router-rootproof-"));
  try {
    const root = path.join(parent, `${TEMP_PREFIX}AAAAAA`);
    mkdirSync(root, { recursive: true });
    const identity = inodeIdentity(lstatSync(root));

    if (identity !== null) {
      // A rename keeps the inode: the gate must notice even though the original
      // path is gone. (Portable wherever inode identity exists.)
      renameSync(root, path.join(parent, "renamed-root"));
      assert.throws(() => verifyTempRootRemoval({ parent, root, identity }), /renamed path/);
      renameSync(path.join(parent, "renamed-root"), root); // put the same directory back
    }

    rmSync(root, { recursive: true, force: true });
    assert.equal(verifyTempRootRemoval({ parent, root, identity }).proven, true, "an absent root is proven removed");

    mkdirSync(root, { recursive: true });
    assert.throws(() => verifyTempRootRemoval({ parent, root, identity }), /leftover temporary directory/);
    rmSync(root, { recursive: true, force: true });
    assert.equal(verifyTempRootRemoval({ parent, root, identity }).proven, true, "removal is proven again");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a failure after the pack removes the artifact this run created", async () => {
  const fx = await createFixtureRepository({ label: "artifact-cleanup" });
  const gateTmp = path.join(fx.base, "gate-tmp");
  mkdirSync(gateTmp, { recursive: true });
  const dist = path.join(fx.repo, "dist");
  try {
    mkdirSync(dist, { recursive: true });
    const statusBefore = await statusOf(fx.repo, fx.isolation.env);

    const failure = await runGate({
      repository: fx.repo,
      tmpParent: gateTmp,
      env: fx.isolation.env,
      artifactDir: dist,
      run: failAtConsumerInstall(),
    }).then(() => null, (error) => error);

    assert.ok(failure instanceof GateFailure, "the injected failure must surface");
    assert.equal(failure.step, "consumer install");
    assert.deepEqual(readdirSync(dist), [], "the tarball packed into the caller's directory is removed on failure");
    assert.deepEqual(await readdir(gateTmp), [], "the temp root is removed");
    assert.equal(await statusOf(fx.repo, fx.isolation.env), statusBefore, "the repository stays untouched");
  } finally {
    await rm(dist, { recursive: true, force: true });
    await fx.cleanup();
  }
});

test("a primary failure still reports source drift found by the final reconciliation", async () => {
  const fx = await createFixtureRepository({ label: "drift-on-failure", failingTests: true });
  const gateTmp = path.join(fx.base, "gate-tmp");
  mkdirSync(gateTmp, { recursive: true });
  try {
    // Make a tracked file dirty first, so a *second* edit leaves git status
    // byte-identical while the content digest still moves.
    const target = path.join(fx.repo, "cli.js");
    writeFileSync(target, `${readFileSync(target, "utf8")}// dirty v1\n`);
    const statusBefore = await statusOf(fx.repo, fx.isolation.env);

    const run = async (options) => {
      const result = await runCommand(options);
      if (options.command === "npm" && (options.args ?? []).includes("test")) {
        writeFileSync(target, readFileSync(target, "utf8").replace("// dirty v1", "// dirty v2"));
      }
      return result;
    };

    const failure = await runGate({ repository: fx.repo, tmpParent: gateTmp, env: fx.isolation.env, run }).then(
      () => null,
      (error) => error,
    );
    assert.ok(failure instanceof GateFailure, "the candidate's own failure must surface");
    assert.equal(failure.step, "npm test", "the primary step is preserved");
    assert.match(failure.message, /`npm test` failed/);

    const details = (failure.details ?? []).map(([label, value]) => `${label}: ${value}`).join("\n");
    assert.match(details, /source candidate set changed during the gate run/, "drift diagnostics ride along with the primary failure");
    assert.match(details, /cli\.js/);

    const rendered = formatGateFailure(failure);
    assert.ok(rendered.includes(FIXTURE_FAILURE), "the candidate's own output is still reported");
    assert.equal(await statusOf(fx.repo, fx.isolation.env), statusBefore, "status alone cannot see this drift — that is the point");
    assert.deepEqual(await readdir(gateTmp), [], "the temp root is still removed");
  } finally {
    await fx.cleanup();
  }
});

/** A synchronous assertion helper: return the thrown error instead of failing. */
function thrownBy(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

test("HEAD drift is detected when status, index, root entries, and worktree bytes all match", async () => {
  const fx = await scratch("head-commit");
  try {
    write(fx.repo, ".gitignore", "ignored.txt\n");
    write(fx.repo, "tracked.txt", "tracked\n");
    await commitAll(fx.repo, fx.isolation.env);
    const before = await repositoryState({ repository: fx.repo, env: fx.isolation.env });

    assert.equal(before.head.detached, false, "HEAD starts attached to its branch");
    assert.equal(before.head.unborn, false);
    assert.equal(before.head.symbolic, "refs/heads/main");
    assert.match(before.head.oid, /^[0-9a-f]{40,64}$/);
    const bytesBefore = readFileSync(path.join(fx.repo, "tracked.txt"), "utf8");

    // An empty commit moves HEAD and changes nothing else at all: status stays
    // byte-identical, the index bytes stay identical, the top-level entries
    // stay identical, and the worktree bytes are byte-for-byte the same.
    await guardedFixtureGitMutation(
      fx.repo,
      [
        "-c",
        "user.name=skill-router test",
        "-c",
        "user.email=test@localhost.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "--quiet",
        "--no-verify",
        "-m",
        "head drift",
      ],
      (args) => runGit(args, fx.repo, fx.isolation.env),
    );

    const after = await repositoryState({ repository: fx.repo, env: fx.isolation.env });
    assert.equal(after.status, before.status, "status is byte-identical");
    assert.deepEqual(after.index, before.index, "the index bytes are identical");
    assert.deepEqual(after.rootEntries, before.rootEntries, "top-level entries are identical");
    assert.equal(readFileSync(path.join(fx.repo, "tracked.txt"), "utf8"), bytesBefore, "worktree bytes are identical");
    assert.notEqual(after.head.oid, before.head.oid, "only HEAD moved");

    const failure = thrownBy(() => assertRepositoryStateUnchanged(before, after));
    assert.ok(failure instanceof GateFailure, "a commit that moves HEAD must fail the fingerprint");
    assert.equal(failure.step, "state");
    assert.match(failure.message, /HEAD moved/);
    const rendered = formatGateFailure(failure);
    assert.ok(rendered.includes("oid"), "the changed field is named");
    assert.ok(!rendered.includes(before.head.oid) && !rendered.includes(after.head.oid), "object ids are never disclosed");
    assert.ok(!rendered.includes("refs/heads/"), "ref names are never disclosed");
    assert.ok(!rendered.includes(path.resolve(fx.repo)), "paths are never disclosed");
  } finally {
    await fx.cleanup();
  }
});

test("a branch/ref move and a detached HEAD are reported as HEAD drift without disclosing refs", async () => {
  const fx = await scratch("head-ref");
  try {
    write(fx.repo, "tracked.txt", "tracked\n");
    await commitAll(fx.repo, fx.isolation.env);
    const before = await repositoryState({ repository: fx.repo, env: fx.isolation.env });

    // Same commit, different ref: status, index, root entries and the commit
    // id are all unchanged — only HEAD's symbolic ref moved. Each mutation
    // guards its own call site immediately before spawning Git.
    await guardedFixtureGitMutation(fx.repo, ["branch", "alt"], (args) => runGit(args, fx.repo, fx.isolation.env));
    await guardedFixtureGitMutation(fx.repo, ["symbolic-ref", "HEAD", "refs/heads/alt"], (args) => runGit(args, fx.repo, fx.isolation.env));
    const moved = await repositoryState({ repository: fx.repo, env: fx.isolation.env });
    assert.equal(moved.status, before.status, "status is byte-identical");
    assert.deepEqual(moved.index, before.index, "the index is identical");
    assert.deepEqual(moved.rootEntries, before.rootEntries, "top-level entries are identical");
    assert.equal(moved.head.oid, before.head.oid, "the commit itself did not move");
    assert.equal(moved.head.symbolic, "refs/heads/alt");

    const refFailure = thrownBy(() => assertRepositoryStateUnchanged(before, moved));
    assert.ok(refFailure instanceof GateFailure, "a ref move must fail the fingerprint");
    assert.match(refFailure.message, /HEAD moved/);
    const refRendered = formatGateFailure(refFailure);
    assert.ok(refRendered.includes("symbolic"), "the changed field is named");
    assert.ok(!refRendered.includes("refs/heads/"), "ref names are never disclosed");
    assert.ok(!refRendered.includes(path.resolve(fx.repo)), "paths are never disclosed");

    // Detaching HEAD at the same commit: again only the HEAD state differs.
    await guardedFixtureGitMutation(fx.repo, ["checkout", "--quiet", "--detach"], (args) => runGit(args, fx.repo, fx.isolation.env));
    const detached = await repositoryState({ repository: fx.repo, env: fx.isolation.env });
    assert.equal(detached.head.detached, true, "a detached HEAD is fingerprinted");
    assert.equal(detached.head.symbolic, null, "a detached HEAD has no symbolic ref");
    assert.equal(detached.head.oid, before.head.oid, "same commit, detached");
    assert.equal(detached.status, before.status, "status is still byte-identical");
    assert.deepEqual(detached.index, before.index, "the index is still identical");
    const detachFailure = thrownBy(() => assertRepositoryStateUnchanged(before, detached));
    assert.ok(detachFailure instanceof GateFailure, "detaching HEAD must fail the fingerprint");
    assert.match(detachFailure.message, /HEAD moved/);
    assert.ok(formatGateFailure(detachFailure).includes("detached"), "the changed field is named");
  } finally {
    await fx.cleanup();
  }
});

test("an unborn HEAD is fingerprinted and the first commit is detected", async () => {
  const fx = await scratch("head-unborn");
  try {
    // `scratch` only runs `git init`, so this repository has no commit yet.
    write(fx.repo, "tracked.txt", "tracked\n");
    const unborn = await repositoryState({ repository: fx.repo, env: fx.isolation.env });
    assert.equal(unborn.head.unborn, true, "a repository without commits is fingerprinted as unborn");
    assert.equal(unborn.index, null, "an ordinary fresh repository has no index yet, and that is normal");
    assert.equal(unborn.head.oid, null, "no commit id exists yet");
    assert.equal(unborn.head.detached, false);
    assert.equal(unborn.head.symbolic, "refs/heads/main");

    await commitAll(fx.repo, fx.isolation.env);
    const committed = await repositoryState({ repository: fx.repo, env: fx.isolation.env });
    assert.equal(committed.head.unborn, false, "the first commit leaves the unborn state");
    assert.match(committed.head.oid, /^[0-9a-f]{40,64}$/);
    assert.equal(committed.head.symbolic, "refs/heads/main");

    const failure = thrownBy(() => assertRepositoryStateUnchanged(unborn, committed));
    assert.ok(failure instanceof GateFailure, "the first commit must be detected");
    assert.match(failure.message, /HEAD moved/);
    const rendered = formatGateFailure(failure);
    assert.ok(rendered.includes("unborn") && rendered.includes("oid"), "the changed fields are named");
    assert.ok(!rendered.includes(committed.head.oid), "object ids are never disclosed");
  } finally {
    await fx.cleanup();
  }
});

test("HEAD drift found in the final reconciliation is reported alongside the primary failure", async () => {
  const fx = await createFixtureRepository({ label: "head-on-failure", failingTests: true });
  const gateTmp = path.join(fx.base, "gate-tmp");
  mkdirSync(gateTmp, { recursive: true });
  try {
    const before = await repositoryState({ repository: fx.repo, env: fx.isolation.env });
    const statusBefore = before.status;

    const run = async (options) => {
      const result = await runCommand(options);
      if (options.command === "npm" && (options.args ?? []).includes("test")) {
        // Move HEAD with an empty commit while the candidate's own tests fail:
        // status and worktree bytes stay byte-identical throughout. The guard
        // runs immediately before this spawn, inside the gate's own run seam.
        const commit = await guardedFixtureGitMutation(
          fx.repo,
          [
            "-c",
            "user.name=skill-router test",
            "-c",
            "user.email=test@localhost.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "--quiet",
            "--no-verify",
            "-m",
            "head move during the gate",
          ],
          (args) => runCommand({ command: "git", args, cwd: fx.repo, env: fx.isolation.env, timeoutMs: 60000 }),
        );
        assert.ok(commit.ok, commit.stderr || commit.error);
      }
      return result;
    };

    const failure = await runGate({ repository: fx.repo, tmpParent: gateTmp, env: fx.isolation.env, run }).then(
      () => null,
      (error) => error,
    );
    assert.ok(failure instanceof GateFailure, "the candidate's own failure must surface");
    assert.equal(failure.step, "npm test", "the primary step is preserved");
    assert.match(failure.message, /`npm test` failed/);

    const details = (failure.details ?? []).map(([label, value]) => `${label}: ${value}`).join("\n");
    assert.match(details, /repository HEAD moved during the gate run/, "HEAD drift rides along with the primary failure");
    assert.match(details, /changed fields: oid/);

    const rendered = formatGateFailure(failure);
    assert.ok(rendered.includes(FIXTURE_FAILURE), "the candidate's own output is still reported");
    assert.ok(!rendered.includes("refs/heads/"), "ref names are never disclosed");

    const after = await repositoryState({ repository: fx.repo, env: fx.isolation.env });
    assert.notEqual(after.head.oid, before.head.oid, "HEAD really did move during the gate run");
    assert.equal(after.status, statusBefore, "a status-only comparison would not have noticed");
    assert.deepEqual(await readdir(gateTmp), [], "the temp root is still removed");
  } finally {
    await fx.cleanup();
  }
});

test("package metadata is read through a bounded no-follow descriptor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-pkgread-"));
  try {
    const valid = `${JSON.stringify({ name: "pkg-fixture", version: "1.2.3", bin: { "skill-router": "./cli.js" } })}\n`;
    const manifest = path.join(root, "package.json");
    writeFileSync(manifest, valid);

    const accepted = readPackageMetadata(root);
    assert.equal(accepted.name, "pkg-fixture");
    assert.equal(accepted.version, "1.2.3");
    assert.equal(accepted.packageJsonBytes, valid.length);
    assert.match(accepted.packageJsonSha256, /^[0-9a-f]{64}$/);
    assert.equal(accepted.packageJsonSha256, await sha256File(manifest), "the digest covers exactly the bytes that were read");
    assert.ok(PACKAGE_JSON_MAX_BYTES >= 4096 && PACKAGE_JSON_MAX_BYTES <= 4 * 1024 * 1024, "the default limit is sane");

    // (a) symlink: the outside target is never consumed and never disclosed.
    const outside = path.join(root, "outside.json");
    writeFileSync(outside, `SENTINEL_OUTSIDE ${"x".repeat(64)}\n`);
    rmSync(manifest);
    symlinkSync(outside, manifest);
    const symlinked = thrownBy(() => readPackageMetadata(root));
    assert.ok(symlinked instanceof GateFailure, "a symlinked manifest is refused");
    assert.equal(symlinked.step, "package");
    const symlinkRendered = formatGateFailure(symlinked);
    assert.ok(!symlinkRendered.includes("SENTINEL_OUTSIDE"), "the outside target's content is never disclosed");
    assert.ok(!symlinkRendered.includes("outside.json"), "the outside target's path is never disclosed");
    assert.ok(!symlinkRendered.includes(root), "no absolute path is disclosed");
    assert.ok(readFileSync(outside, "utf8").startsWith("SENTINEL_OUTSIDE"), "the outside target is untouched");

    // (b) hardlink: content could be rewritten from outside this gate.
    rmSync(manifest);
    writeFileSync(manifest, valid);
    linkSync(manifest, path.join(root, "alias.json"));
    assert.match(thrownBy(() => readPackageMetadata(root)).message, /single-link/);
    rmSync(path.join(root, "alias.json"));

    // (c) non-regular: a directory, refused by lstat before anything opens.
    rmSync(manifest);
    mkdirSync(manifest);
    assert.match(thrownBy(() => readPackageMetadata(root)).message, /ordinary regular file/);
    rmSync(manifest, { recursive: true });

    // (d) a FIFO — refused by lstat, so no open can ever block (where the
    //     platform can create one).
    if (spawnSync("mkfifo", [manifest]).status === 0) {
      const fifo = thrownBy(() => readPackageMetadata(root));
      assert.ok(fifo instanceof GateFailure, "a FIFO manifest is refused before it is opened");
      assert.match(fifo.message, /ordinary regular file/);
      rmSync(manifest, { force: true });
    }

    // (e) oversized: the limit is enforced before any allocation.
    writeFileSync(manifest, "x".repeat(PACKAGE_JSON_MAX_BYTES + 1));
    assert.match(thrownBy(() => readPackageMetadata(root)).message, /exceeds the \d+-byte read limit/);
    writeFileSync(manifest, valid);
    assert.match(thrownBy(() => readPackageMetadata(root, { maxBytes: 16 })).message, /exceeds the 16-byte read limit/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package metadata refuses an lstat-to-open swap and a mutation during the read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-pkgswap-"));
  try {
    const valid = `${JSON.stringify({ name: "pkg-fixture", version: "1.2.3", bin: { "skill-router": "./cli.js" } })}\n`;
    const manifest = path.join(root, "package.json");
    const outside = path.join(root, "outside.json");
    writeFileSync(outside, "SENTINEL_BODY\n");
    writeFileSync(manifest, valid);

    // (a) the path becomes a symlink between lstat and open: O_NOFOLLOW wins.
    const swapped = thrownBy(() =>
      readPackageMetadata(root, {
        hook: (point) => {
          if (point !== "after-lstat") return;
          rmSync(manifest);
          symlinkSync(outside, manifest);
        },
      }),
    );
    assert.ok(swapped instanceof GateFailure, "an lstat-to-open swap is refused");
    assert.match(swapped.message, /symbolic link/);
    assert.ok(!formatGateFailure(swapped).includes("SENTINEL_BODY"), "the swapped-in content is never disclosed");
    assert.equal(readFileSync(outside, "utf8"), "SENTINEL_BODY\n", "the swapped-in target is never read");

    // (b) the file shrinks between the pre-fstat and the read.
    rmSync(manifest);
    writeFileSync(manifest, valid);
    const mutated = thrownBy(() =>
      readPackageMetadata(root, {
        hook: (point) => {
          if (point === "after-pre") writeFileSync(manifest, "{}");
        },
      }),
    );
    assert.ok(mutated instanceof GateFailure, "a mutation during the read is refused");
    assert.match(mutated.message, /changed while it was being read/);

    // (c) the seam is inert when it only observes.
    rmSync(manifest);
    writeFileSync(manifest, valid);
    const points = [];
    readPackageMetadata(root, { hook: (point) => points.push(point) });
    assert.deepEqual(points, ["after-lstat", "after-open", "after-pre", "mid-read"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a refused package.json fails the gate before any temp or build mutation", async () => {
  const fx = await scratch("pkg-refuse");
  try {
    write(fx.repo, "package.json", `${JSON.stringify({ name: "refuse-fixture", version: "1.0.0", bin: { "skill-router": "./cli.js" } })}\n`);
    write(fx.repo, "cli.js", "process.exit(0);\n");
    await commitAll(fx.repo, fx.isolation.env);
    const gateTmp = path.join(fx.base, "gate-tmp");
    mkdirSync(gateTmp, { recursive: true });

    const outside = path.join(fx.base, "outside.json");
    writeFileSync(outside, "SENTINEL_SECRET\n");
    rmSync(path.join(fx.repo, "package.json"));
    symlinkSync(outside, path.join(fx.repo, "package.json"));

    const failure = await runGate({ repository: fx.repo, tmpParent: gateTmp, env: fx.isolation.env }).then(
      () => null,
      (error) => error,
    );
    assert.ok(failure instanceof GateFailure, "the gate must refuse the manifest");
    assert.equal(failure.step, "package");
    assert.match(failure.message, /package\.json/);
    const rendered = formatGateFailure(failure);
    assert.ok(!rendered.includes("SENTINEL_SECRET"), "outside content is never disclosed");
    assert.ok(!rendered.includes("outside.json"), "the outside target path is never disclosed");
    assert.deepEqual(await readdir(gateTmp), [], "no temp root is created for a refused manifest");
    assert.equal(readFileSync(outside, "utf8"), "SENTINEL_SECRET\n", "the outside target is untouched and unconsumed");
  } finally {
    await fx.cleanup();
  }
});

test("an unusable rev-parse answer is never read as an unborn HEAD", async () => {
  const fx = await scratch("head-shapes");
  try {
    write(fx.repo, "tracked.txt", "tracked\n");
    await commitAll(fx.repo, fx.isolation.env);

    const shapes = [
      ["exit 128", { ok: false, code: 128, signal: null, error: null, timedOut: false, stdout: "", stderr: "fatal: not a valid object name" }],
      ["spawn error", { ok: false, code: null, signal: null, error: "ENOENT: spawn failed", timedOut: false, stdout: "", stderr: "" }],
      ["timeout", { ok: false, code: null, signal: null, error: null, timedOut: true, stdout: "", stderr: "" }],
      ["signal", { ok: false, code: null, signal: "SIGKILL", error: null, timedOut: false, stdout: "", stderr: "" }],
      ["invalid encoding", { ok: false, code: 1, signal: null, error: null, timedOut: false, invalidEncoding: true, stdout: "", stderr: "" }],
      ["truncated output", { ok: false, code: 1, signal: null, error: null, timedOut: false, truncated: true, stdout: "", stderr: "" }],
    ];
    for (const [label, patch] of shapes) {
      const run = async (options) => {
        const result = await runCommand(options);
        if ((options.args ?? []).includes("rev-parse") && (options.args ?? []).includes("HEAD")) {
          return { ...result, ...patch };
        }
        return result;
      };
      const failure = await repositoryState({ repository: fx.repo, env: fx.isolation.env, run }).then(() => null, (error) => error);
      assert.ok(failure instanceof GateFailure, `${label} must fail closed, not read as unborn`);
      assert.equal(failure.step, "state", label);
      assert.match(failure.message, /cannot determine HEAD|not valid UTF-8|output bound/, label);
      assert.ok(!formatGateFailure(failure).includes("refs/heads/"), `${label}: no ref names disclosed`);
    }

    // Positive control: the ordinary answer still fingerprints.
    const ok = await repositoryState({ repository: fx.repo, env: fx.isolation.env });
    assert.match(ok.head.oid, /^[0-9a-f]{40,64}$/);
    assert.equal(ok.head.unborn, false, "a committed HEAD is not unborn");
    assert.equal(ok.head.symbolic, "refs/heads/main");
  } finally {
    await fx.cleanup();
  }
});

test("symlinked, malformed, and special .git entries fail the fingerprint closed", async () => {
  const fx = await scratch("gitdir");
  try {
    write(fx.repo, "tracked.txt", "tracked\n");
    await commitAll(fx.repo, fx.isolation.env);
    const stateOf = (repository) => repositoryState({ repository, env: fx.isolation.env }).then(() => null, (error) => error);

    // (a) `.git` swapped for a symlink: refused by us, deterministically,
    //     before git is even asked (the layout check runs first).
    const moved = path.join(fx.base, "dotgit-real");
    renameSync(path.join(fx.repo, ".git"), moved);
    symlinkSync(moved, path.join(fx.repo, ".git"));
    const linked = await stateOf(fx.repo);
    assert.ok(linked instanceof GateFailure, "a symlinked .git is refused");
    assert.equal(linked.step, "state");
    assert.match(linked.message, /\.git must be an ordinary directory or a gitfile, never a symbolic link/);
    rmSync(path.join(fx.repo, ".git")); // unlinks the link only
    renameSync(moved, path.join(fx.repo, ".git"));

    // (b) a malformed gitfile (a directory that is not a repository at all).
    const malformedDir = path.join(fx.base, "malformed");
    mkdirSync(malformedDir, { recursive: true });
    writeFileSync(path.join(malformedDir, ".git"), "this is not a gitfile\n");
    const malformed = await stateOf(malformedDir);
    assert.ok(malformed instanceof GateFailure, "a malformed gitfile is refused");
    assert.equal(malformed.step, "state");
    assert.match(malformed.message, /malformed gitfile/);

    // (c) a gitfile that points nowhere.
    writeFileSync(path.join(malformedDir, ".git"), "gitdir: ./missing-gitdir\n");
    const dangling = await stateOf(malformedDir);
    assert.ok(dangling instanceof GateFailure, "a dangling gitdir is refused");
    assert.match(dangling.message, /cannot be resolved|does not resolve to an ordinary directory/);

    // (d) a special-file `.git`, where the platform can make one.
    const specialDir = path.join(fx.base, "special");
    mkdirSync(specialDir, { recursive: true });
    if (spawnSync("mkfifo", [path.join(specialDir, ".git")]).status === 0) {
      const special = await stateOf(specialDir);
      assert.ok(special instanceof GateFailure, "a FIFO .git is refused");
      assert.match(special.message, /not a special file/);
    }

    // (e) positive: an ordinary gitfile-backed repository still fingerprints —
    //     including its index, which lives behind the declared gitdir.
    const gitfileRepo = path.join(fx.base, "gitfile-repo");
    const gitdir = path.join(fx.base, "gitfile-dir");
    mkdirSync(gitfileRepo, { recursive: true });
    renameSync(path.join(fx.repo, ".git"), gitdir);
    writeFileSync(path.join(gitfileRepo, ".git"), `gitdir: ${gitdir}\n`);
    const viaGitfile = await repositoryState({ repository: gitfileRepo, env: fx.isolation.env });
    assert.ok(viaGitfile.index !== null, "the index is found through a well-formed gitfile");
    assert.match(viaGitfile.index.sha256, /^[0-9a-f]{64}$/);
    assert.match(viaGitfile.head.oid, /^[0-9a-f]{40,64}$/, "HEAD is fingerprinted through the gitfile too");
  } finally {
    await fx.cleanup();
  }
});

test("the nested-gate boundary is canonical and runs before any temp creation", async () => {
  const fx = await scratch("nested-canonical");
  try {
    const gateTmp = path.join(fx.base, "gate-tmp");
    mkdirSync(gateTmp, { recursive: true });
    const flagged = { ...fx.isolation.env, [GATE_ENV_FLAG]: "1" };

    // (a) a `repo/../repo` spelling of the gate's own repository.
    const dotted = path.join(REPOSITORY, "..", path.basename(REPOSITORY));
    await assert.rejects(
      runGate({ repository: dotted, tmpParent: gateTmp, env: flagged }),
      /nested clean-candidate gate refused/,
      "a normalized spelling of the gate's own repository is the same repository",
    );

    // (b) a symlink alias of the gate's own repository (lexical compare would
    //     allow it; the canonical compare refuses it).
    const alias = path.join(fx.base, "owner-alias");
    symlinkSync(REPOSITORY, alias);
    await assert.rejects(
      runGate({ repository: alias, tmpParent: gateTmp, env: flagged }),
      /nested clean-candidate gate refused/,
      "a symlink alias of the gate's own repository is the same repository",
    );

    // (c) an unresolvable repository path fails closed rather than assuming it
    //     is some other repository.
    await assert.rejects(
      runGate({ repository: path.join(fx.base, "missing-repo"), tmpParent: gateTmp, env: flagged }),
      /nested clean-candidate gate refused/,
    );

    assert.deepEqual(await readdir(gateTmp), [], "a refused nested gate creates no temp root");
  } finally {
    await fx.cleanup();
  }
});

test("the fixture guard refuses the original incident shape before git add/commit", async () => {
  const fx = await scratch("incident");
  try {
    // The original incident: a directory inside an ignored, repository-local
    // temp root with no `git init`, so `git add`/`git commit` would resolve to
    // the *real* repository and stage its index.
    const probe = path.join(fx.base, "probe-repo");
    mkdirSync(probe, { recursive: true });
    writeFileSync(path.join(probe, "note.txt"), "would be staged by the real repository\n");

    const realBefore = await repositoryState({ repository: REPOSITORY, env: fx.isolation.env });
    assert.throws(() => assertFixtureOutsideRealRepository(probe), /not its own repository/);
    await assert.rejects(commitAll(probe, fx.isolation.env), /not its own repository/, "the guard runs before git add and git commit");

    const realAfter = await repositoryState({ repository: REPOSITORY, env: fx.isolation.env });
    assert.deepEqual(realAfter.head, realBefore.head, "the real HEAD (ref, oid, detached/unborn) is untouched");
    assert.deepEqual(realAfter.index, realBefore.index, "the real index bytes are untouched");
    assert.ok(readFileSync(path.join(probe, "note.txt"), "utf8").includes("would be staged"), "the probe file was never staged");

    // The other refusals: the real repository, an ancestor containing it, a
    // symlinked .git, and a file-form .git.
    assert.throws(() => assertFixtureOutsideRealRepository(REPOSITORY), /real repository/);
    assert.throws(() => assertFixtureOutsideRealRepository(path.dirname(REPOSITORY)), /contains the real repository/);
    symlinkSync(path.join(fx.repo, ".git"), path.join(probe, ".git"));
    assert.throws(() => assertFixtureOutsideRealRepository(probe), /symbolic link/);
    rmSync(path.join(probe, ".git"));
    writeFileSync(path.join(probe, ".git"), "gitdir: /nowhere\n");
    assert.throws(() => assertFixtureOutsideRealRepository(probe), /ordinary directory, not a file/);

    // Positive control: an independent nested repository under the very same
    // repo-local temp root is accepted (every other fixture in this file is).
    assert.equal(assertFixtureOutsideRealRepository(fx.repo), path.resolve(fx.repo));
  } finally {
    await fx.cleanup();
  }
});

test("guarded fixture git mutations refuse before spawning Git when .git is missing, replaced, or a link", async () => {
  const fx = await scratch("guard-final");
  // Deliberately repo-local *and* ignored: `node_modules/` is in the real
  // repository's .gitignore, so this nested fixture never surfaces in the real
  // status — and it sits inside the real work tree, which is exactly the shape
  // that must be refused the moment it stops being its own repository.
  const ignoredRules = readFileSync(path.join(REPOSITORY, ".gitignore"), "utf8").split("\n");
  assert.ok(ignoredRules.includes("node_modules/"), "node_modules/ must be ignored by the real repository");
  const fixtureRoot = mkdtempSync(path.join(REPOSITORY, "node_modules", "phase11-guard-"));
  const repo = path.join(fixtureRoot, "nested");
  const savedGit = path.join(fixtureRoot, ".git-saved");
  const dotGit = path.join(repo, ".git");
  // Every spawn is recorded; the runner is only reachable through the guard.
  const spawns = [];
  const spawn = (args) => {
    spawns.push(args.join(" "));
    return runGit(args, repo, fx.isolation.env);
  };
  const commitArgs = [
    "-c",
    "user.name=skill-router test",
    "-c",
    "user.email=test@localhost.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--no-verify",
    "-m",
    "guarded fixture",
  ];
  let realBefore = null;
  try {
    mkdirSync(repo, { recursive: true });
    // `init` is deliberately outside the guard: there is no `.git` yet, and an
    // init cannot reach the real index (see `test/fixture-guard.mjs`).
    await runGit(["-c", "init.defaultBranch=main", "init", "--quiet"], repo, fx.isolation.env);
    realBefore = await repositoryState({ repository: REPOSITORY, env: fx.isolation.env });

    // (1) the positive case: a safely initialized, repo-local nested fixture
    //     is added and committed through the guard.
    writeFileSync(path.join(repo, "note.txt"), "nested fixture\n");
    await guardedFixtureGitMutation(repo, ["add", "--all"], spawn);
    await guardedFixtureGitMutation(repo, commitArgs, spawn);
    assert.equal(spawns.length, 2, "both allowed mutations spawned git exactly once each");
    assert.equal(assertFixtureOutsideRealRepository(repo), path.resolve(repo), "an independent nested repo is accepted");

    // (2) missing `.git`: both mutations refuse before any spawn.
    renameSync(dotGit, savedGit);
    let beforeRefusal = spawns.length;
    await assert.rejects(guardedFixtureGitMutation(repo, ["add", "--all"], spawn), /not its own repository/);
    await assert.rejects(guardedFixtureGitMutation(repo, commitArgs, spawn), /not its own repository/);
    assert.equal(spawns.length, beforeRefusal, "no git process is spawned after a missing-.git refusal");

    // (3) `.git` replaced by a symlink to the saved gitdir.
    symlinkSync(savedGit, dotGit);
    beforeRefusal = spawns.length;
    await assert.rejects(guardedFixtureGitMutation(repo, commitArgs, spawn), /symbolic link/);
    assert.equal(spawns.length, beforeRefusal, "no git process is spawned after a symlinked-.git refusal");

    // (4) `.git` replaced by a file (gitfile form).
    rmSync(dotGit, { force: true }); // unlinks the link itself, never its target
    writeFileSync(dotGit, "gitdir: /nowhere\n");
    beforeRefusal = spawns.length;
    await assert.rejects(guardedFixtureGitMutation(repo, commitArgs, spawn), /ordinary directory, not a file/);
    assert.equal(spawns.length, beforeRefusal, "no git process is spawned after a file-form-.git refusal");

    // The real repository is untouched: HEAD and the actual `.git/index` bytes
    // (size + sha256 from the fingerprint) are both identical.
    const realAfter = await repositoryState({ repository: REPOSITORY, env: fx.isolation.env });
    assert.deepEqual(realAfter.head, realBefore.head, "the real HEAD (ref, oid, detached/unborn) is unchanged");
    assert.deepEqual(realAfter.index, realBefore.index, "the real .git/index size and hash are unchanged");
    assert.equal(spawns.length, 2, "after the refusals, no further git process was ever spawned");
  } finally {
    // No-follow cleanup: unlink a replaced `.git` *link* first so nothing can
    // be traversed or deleted through it, then recurse over ordinary entries.
    try {
      if (lstatSync(dotGit).isSymbolicLink()) rmSync(dotGit, { force: true });
    } catch {
      /* absent, or already an ordinary entry */
    }
    rmSync(fixtureRoot, { recursive: true, force: true });
    await fx.cleanup();
  }
});
