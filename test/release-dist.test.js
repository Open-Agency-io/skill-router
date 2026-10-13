// Phase 11 release-artifact tests: exact tag/version matching happens before
// any work, a correct tag turns a clean fixture candidate into exactly two
// files (the gate-validated tarball plus a verifiable `SHA256SUMS`) with the
// repository left untouched, and every boundary the release script claims is
// discriminated here — trusted-git resolution before any dist mutation,
// canonical paths, controlled-state removal, the exclusive no-follow checksum
// write, and fail-closed cleanup after the pack. No `gh`, no npm publication,
// no network, no credentials: attaching the files is the workflow's job, not
// the script's.

import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GateFailure, parseChecksumFile, runCommand, sha256File } from "../scripts/gate-lib.mjs";
import { buildReleaseArtifacts, formatReleaseSummary, writeChecksumExclusive } from "../scripts/release-dist.mjs";
import { FIXTURE_SECRET, FIXTURE_TARBALL, FIXTURE_VERSION, createFixtureRepository } from "./package-fixture.mjs";

async function statusOf(repo, env) {
  const result = await runCommand({ command: "git", args: ["--no-optional-locks", "status", "--porcelain=v1", "-z", "-uall"], cwd: repo, env, timeoutMs: 60000 });
  assert.ok(result.ok, `git status failed: ${result.stderr || result.error}`);
  return result.stdout;
}

/** Read-only view of what a release run must never disturb: status, HEAD, index. */
async function fingerprintOf(repo, env) {
  const status = await statusOf(repo, env);
  const head = await runCommand({ command: "git", args: ["rev-parse", "HEAD"], cwd: repo, env, timeoutMs: 60000 });
  assert.ok(head.ok, `git rev-parse HEAD failed: ${head.stderr || head.error}`);
  return { status, head: head.stdout, index: await sha256File(path.join(repo, ".git", "index")) };
}

/**
 * A `run` seam that records every child command and refuses to execute
 * anything: a release-level refusal must leave this list empty.
 */
function recordingRun(calls) {
  return (options) => {
    calls.push(`${options.command} ${(options.args ?? []).join(" ")}`);
    return Promise.resolve({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      ok: false,
      code: 97,
      signal: null,
      error: "no child command may run in this test",
      timedOut: false,
      stdout: "",
      stderr: "",
      truncated: false,
      durationMs: 0,
      pid: null,
      survived: false,
    });
  };
}

/** The real runner, except that the gate's consumer install is made to fail. */
function failAtConsumerInstall({ thenWrite = null } = {}) {
  return async (options) => {
    const args = Array.isArray(options.args) ? options.args : [];
    if (options.command === "npm" && args[0] === "install") {
      // The tarball is already packed into `dist/` at this point: the failure
      // is injected exactly where an artifact exists and must be cleaned up.
      if (thenWrite !== null) writeFileSync(thenWrite, "interference from outside the run\n");
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
        durationMs: 0,
        pid: null,
        survived: false,
      };
    }
    return runCommand(options);
  };
}

function failureOf(promise) {
  return promise.then(() => null, (error) => error);
}

/** Synchronous seam: a helper that throws is turned into a comparable failure. */
function failureOfCall(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

test("a tag that does not exactly match package.json fails before anything is built", async () => {
  const fx = await createFixtureRepository({ label: "release-tag" });
  try {
    const dist = path.join(fx.repo, "dist");
    const gateTmp = path.join(fx.base, "gate-tmp");
    mkdirSync(gateTmp, { recursive: true });
    const refused = [
      `v${FIXTURE_VERSION}0`,
      `v9.9.9`,
      `${FIXTURE_VERSION}`,
      `v${FIXTURE_VERSION}-rc.1`,
      `V${FIXTURE_VERSION}`,
      `v${FIXTURE_VERSION} `,
      `v${FIXTURE_VERSION}\n`,
      "",
      null,
      `v$(id)`,
    ];
    for (const tag of refused) {
      const failure = await failureOf(
        buildReleaseArtifacts({ repository: fx.repo, tag, env: fx.isolation.env, dist, tmpParent: gateTmp }),
      );
      assert.ok(failure instanceof GateFailure, `expected a GateFailure for tag ${JSON.stringify(tag)}`);
      assert.equal(failure.step, "tag", `unexpected step for tag ${JSON.stringify(tag)}`);
      assert.match(failure.message, /release tag is required|does not exactly match|not an exact semantic version/);
    }
    assert.ok(!existsSync(dist), "a refused tag must not create the dist directory");
    assert.deepEqual(await readdir(gateTmp), [], "a refused tag must not create a gate temp root");
  } finally {
    await fx.cleanup();
  }
});

test("an exact tag produces exactly the validated tarball and SHA256SUMS", async () => {
  const fx = await createFixtureRepository({ label: "release-build" });
  const gateTmp = path.join(fx.base, "gate-tmp");
  mkdirSync(gateTmp, { recursive: true });
  try {
    const dist = path.join(fx.repo, "dist");
    const statusBefore = await statusOf(fx.repo, fx.isolation.env);
    const tag = `v${FIXTURE_VERSION}`;

    const result = await buildReleaseArtifacts({
      repository: fx.repo,
      tag,
      dist,
      tmpParent: gateTmp,
      env: fx.isolation.env,
    });

    assert.equal(result.tag, tag);
    assert.equal(result.version, FIXTURE_VERSION);
    assert.equal(result.gate.tarball.directory, dist, "the tarball is packed from the clean clone into dist");
    assert.equal(result.gate.tarball.filename, FIXTURE_TARBALL);
    assert.equal(result.gate.consumer.version, FIXTURE_VERSION);
    assert.ok(result.gate.tarball.files.includes("package.json"));
    assert.ok(
      result.gate.tarball.files.every((file) => !file.includes(".env")),
      "the released tarball carries no ignored file",
    );
    assert.deepEqual(result.removedStale, [], "a clean dist has no stale state to remove");

    const entries = readdirSync(dist).sort();
    assert.deepEqual(entries, ["SHA256SUMS", FIXTURE_TARBALL].sort(), "dist holds exactly the tarball and the checksum file");
    assert.deepEqual(
      result.artifacts.map((artifact) => artifact.filename).sort(),
      ["SHA256SUMS", FIXTURE_TARBALL].sort(),
    );

    // Sizes handed to the workflow must be the sizes on disk, verified last.
    for (const artifact of result.artifacts) {
      assert.equal(lstatSync(path.join(dist, artifact.filename)).size, artifact.size, `${artifact.filename}: reported size`);
      assert.equal(await sha256File(path.join(dist, artifact.filename)), artifact.sha256, `${artifact.filename}: reported digest`);
    }

    const tarballRecord = result.artifacts.find((artifact) => artifact.filename === FIXTURE_TARBALL);
    const checksums = readFileSync(path.join(dist, "SHA256SUMS"), "utf8");
    assert.equal(checksums, `${tarballRecord.sha256}  ${FIXTURE_TARBALL}\n`, "SHA256SUMS is sha256sum-compatible and deterministic");

    const parsed = parseChecksumFile(checksums);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].filename, FIXTURE_TARBALL);
    assert.equal(await sha256File(path.join(dist, FIXTURE_TARBALL)), parsed[0].digest, "an independent re-hash verifies the file");
    assert.equal(tarballRecord.sha256, parsed[0].digest);

    const summary = formatReleaseSummary(result);
    const lines = summary.split("\n");
    assert.equal(lines.length, 3, "the release summary is a fixed three-line report");
    assert.match(lines[0], /^release: ready \| tag v3\.4\.5 \| version 3\.4\.5 \| candidates 6$/);
    assert.ok(summary.includes(FIXTURE_TARBALL));
    assert.ok(summary.includes("SHA256SUMS"));
    assert.ok(summary.length < 2000, `release summary must stay bounded, got ${summary.length}`);

    assert.deepEqual(await readdir(gateTmp), [], "the gate's temporary root is removed");
    assert.equal(await statusOf(fx.repo, fx.isolation.env), statusBefore, "building release artifacts never dirties the repository");
    assert.ok(readFileSync(path.join(fx.repo, ".env"), "utf8").includes(FIXTURE_SECRET), "the ignored secret stays untouched");
  } finally {
    await rm(path.join(fx.repo, "dist"), { recursive: true, force: true });
    await fx.cleanup();
  }
});

test("dist and every component below the repository must be a real directory, never a link", async () => {
  const fx = await createFixtureRepository({ label: "release-symlink" });
  try {
    const outside = path.join(fx.base, "outside");
    mkdirSync(outside, { recursive: true });
    const tag = `v${FIXTURE_VERSION}`;

    // (a) `dist` itself is a symlink pointing out of the work tree.
    const linked = path.join(fx.repo, "dist");
    symlinkSync(outside, linked);
    const asLink = await failureOf(buildReleaseArtifacts({ repository: fx.repo, tag, dist: linked, env: fx.isolation.env }));
    assert.ok(asLink instanceof GateFailure, "a symlinked dist must be refused");
    assert.equal(asLink.step, "release");
    assert.match(asLink.message, /symlinked path component/);
    assert.ok(lstatSync(linked).isSymbolicLink(), "the link itself is never touched");
    assert.deepEqual(readdirSync(outside), [], "nothing was ever written through the link");
    unlinkSync(linked);

    // (b) an intermediate component is a symlink that would move `dist`
    //     (and therefore the pack destination) somewhere else entirely.
    const elsewhere = path.join(fx.base, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    const nested = path.join(fx.repo, "nested");
    symlinkSync(elsewhere, nested);
    const nestedDist = path.join(nested, "dist");
    const asNested = await failureOf(buildReleaseArtifacts({ repository: fx.repo, tag, dist: nestedDist, env: fx.isolation.env }));
    assert.ok(asNested instanceof GateFailure, "a symlinked ancestor must be refused");
    assert.equal(asNested.step, "release");
    assert.match(asNested.message, /symlinked path component/);
    assert.match(asNested.message, /nested/);
    assert.ok(!existsSync(nestedDist), "no directory was created under the link");
    assert.deepEqual(readdirSync(elsewhere), [], "nothing was written outside the repository");
    unlinkSync(nested);

    // (c) `dist` exists but is a plain file, so packing into it is impossible.
    const asFile = path.join(fx.repo, "dist");
    writeFileSync(asFile, "not a directory\n");
    const fileFailure = await failureOf(buildReleaseArtifacts({ repository: fx.repo, tag, dist: asFile, env: fx.isolation.env }));
    assert.ok(fileFailure instanceof GateFailure, "a regular file at dist must be refused");
    assert.match(fileFailure.message, /not a directory/);
    assert.equal(readFileSync(asFile, "utf8"), "not a directory\n", "the file is left untouched");
    unlinkSync(asFile);

    // (d) escaping the repository entirely is refused before any write.
    const escape = await failureOf(buildReleaseArtifacts({ repository: fx.repo, tag, dist: outside, env: fx.isolation.env }));
    assert.ok(escape instanceof GateFailure, "an artifacts directory outside the repository must be refused");
    assert.match(escape.message, /outside the repository|must not be the repository root/);
    assert.deepEqual(readdirSync(outside), [], "nothing was written outside the repository");
  } finally {
    await fx.cleanup();
  }
});

test("uncontrolled state in dist is never removed and the gate never starts", async () => {
  const fx = await createFixtureRepository({ label: "release-uncontrolled" });
  try {
    const dist = path.join(fx.repo, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(path.join(dist, "notes.txt"), "written by a human\n");
    const gateTmp = path.join(fx.base, "gate-tmp");
    mkdirSync(gateTmp, { recursive: true });

    const failure = await failureOf(
      buildReleaseArtifacts({
        repository: fx.repo,
        tag: `v${FIXTURE_VERSION}`,
        dist,
        tmpParent: gateTmp,
        env: fx.isolation.env,
      }),
    );

    assert.ok(failure instanceof GateFailure, "unknown state in dist must fail closed");
    assert.equal(failure.step, "release");
    assert.match(failure.message, /uncontrolled state/);
    assert.equal(readFileSync(path.join(dist, "notes.txt"), "utf8"), "written by a human\n", "the file is preserved, not deleted");
    assert.deepEqual(readdirSync(dist), ["notes.txt"], "nothing else was removed or created");
    assert.deepEqual(await readdir(gateTmp), [], "the gate never started");
  } finally {
    await fx.cleanup();
  }
});

test("stale controlled state is cleared, and a failure after the pack removes every artifact this run created", async () => {
  const fx = await createFixtureRepository({ label: "release-cleanup" });
  const gateTmp = path.join(fx.base, "gate-tmp");
  mkdirSync(gateTmp, { recursive: true });
  const dist = path.join(fx.repo, "dist");
  try {
    const statusBefore = await statusOf(fx.repo, fx.isolation.env);
    // Controlled generated state from an earlier run: the script owns both
    // names, so it must be cleared before packing — never followed, never
    // merged with the new artifacts.
    mkdirSync(dist, { recursive: true });
    writeFileSync(path.join(dist, "SHA256SUMS"), "stale checksum file\n");
    writeFileSync(path.join(dist, "stale-build-0.0.1.tgz"), "stale tarball\n");

    const failure = await failureOf(
      buildReleaseArtifacts({
        repository: fx.repo,
        tag: `v${FIXTURE_VERSION}`,
        dist,
        tmpParent: gateTmp,
        env: fx.isolation.env,
        run: failAtConsumerInstall(),
      }),
    );

    assert.ok(failure instanceof GateFailure, "the injected gate failure must surface");
    assert.match(failure.step, /^consumer install$/, `unexpected failing step: ${failure.step}`);
    assert.deepEqual(readdirSync(dist), [], "cleanup is proven: no tarball, no checksum file, no temp file, no stale state");
    assert.deepEqual(await readdir(gateTmp), [], "the gate's temporary root is removed");
    assert.equal(await statusOf(fx.repo, fx.isolation.env), statusBefore, "a failed release never dirties the repository");
  } finally {
    await rm(dist, { recursive: true, force: true });
    await fx.cleanup();
  }
});

test("cleanup that cannot be proven fails closed and never deletes a file this run did not create", async () => {
  const fx = await createFixtureRepository({ label: "release-cleanup-unproven" });
  const gateTmp = path.join(fx.base, "gate-tmp");
  mkdirSync(gateTmp, { recursive: true });
  const dist = path.join(fx.repo, "dist");
  try {
    // While the gate runs, something else drops a file into `dist/`: it is not
    // this run's artifact, so it must survive — and the run must say so
    // instead of reporting a clean failure.
    const failure = await failureOf(
      buildReleaseArtifacts({
        repository: fx.repo,
        tag: `v${FIXTURE_VERSION}`,
        dist,
        tmpParent: gateTmp,
        env: fx.isolation.env,
        run: failAtConsumerInstall({ thenWrite: path.join(dist, "interference.txt") }),
      }),
    );

    assert.ok(failure instanceof GateFailure, "the injected gate failure must surface");
    assert.equal(failure.step, "cleanup", "an unproven cleanup is reported as a cleanup failure");
    assert.match(failure.message, /cleanup could not be proven/);
    assert.match(failure.message, /consumer install/, "the original failure is still reported");
    const details = (failure.details ?? []).map(([, value]) => String(value)).join("\n");
    assert.match(details, /interference\.txt/, "the leftover that blocked the proof is named");
    assert.deepEqual(readdirSync(dist), ["interference.txt"], "this run's artifacts are gone; the foreign file is not");
    assert.equal(readFileSync(path.join(dist, "interference.txt"), "utf8"), "interference from outside the run\n");
    assert.deepEqual(await readdir(gateTmp), [], "the gate's temporary root is removed");
  } finally {
    await rm(dist, { recursive: true, force: true });
    await fx.cleanup();
  }
});

test("SHA256SUMS is written through an exclusive no-follow temp file with identity checks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "skill-router-checksum-"));
  try {
    const content = `${"a".repeat(64)}  pkg-1.0.0.tgz\n`;
    const record = writeChecksumExclusive({ directory, content });

    assert.equal(record.path, path.join(directory, "SHA256SUMS"));
    assert.deepEqual(readdirSync(directory), ["SHA256SUMS"], "no temp file survives the rename");
    const stats = lstatSync(record.path);
    assert.ok(stats.isFile() && !stats.isSymbolicLink(), "the result is a plain regular file");
    assert.equal(stats.size, record.size);
    assert.equal(stats.dev, record.dev);
    assert.equal(stats.ino, record.ino);
    assert.equal(readFileSync(record.path, "utf8"), content, "the content round-trips exactly");
    assert.equal(parseChecksumFile(readFileSync(record.path, "utf8")).length, 1);

    // An existing entry at the destination — a file or a link — is never
    // replaced, and the temp file that was created for the attempt is gone.
    writeFileSync(path.join(directory, "SHA256SUMS"), "original\n");
    const refused = failureOfCall(() => writeChecksumExclusive({ directory, content: `${"b".repeat(64)}  pkg-1.0.0.tgz\n` }));
    assert.ok(refused instanceof GateFailure, "an existing SHA256SUMS must be refused, not clobbered");
    assert.match(refused.message, /refusing to replace an existing SHA256SUMS/);
    assert.equal(readFileSync(path.join(directory, "SHA256SUMS"), "utf8"), "original\n", "the existing file is untouched");
    assert.deepEqual(readdirSync(directory), ["SHA256SUMS"], "the failed attempt left no temp file behind");

    // A link at the destination is refused the same way and is not followed.
    unlinkSync(path.join(directory, "SHA256SUMS"));
    const target = path.join(directory, "target.txt");
    writeFileSync(target, "linked content\n");
    symlinkSync(target, path.join(directory, "SHA256SUMS"));
    const refusedLink = failureOfCall(() => writeChecksumExclusive({ directory, content }));
    assert.ok(refusedLink instanceof GateFailure, "a symlink at the destination must be refused");
    assert.match(refusedLink.message, /refusing to replace an existing SHA256SUMS/);
    assert.ok(lstatSync(path.join(directory, "SHA256SUMS")).isSymbolicLink(), "the link is not replaced or followed");
    assert.equal(readFileSync(target, "utf8"), "linked content\n", "the link target is untouched");
    assert.deepEqual(
      readdirSync(directory).filter((name) => name !== "SHA256SUMS" && name !== "target.txt"),
      [],
      "no temp file is left behind",
    );

    // Empty content is refused up front.
    const empty = failureOfCall(() => writeChecksumExclusive({ directory, content: "" }));
    assert.ok(empty instanceof GateFailure, "an empty checksum file must be refused");
    assert.match(empty.message, /empty checksum file/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a hostile PATH (empty component, relative component, or empty PATH) fails closed before any dist change", async () => {
  const fx = await createFixtureRepository({ label: "release-hostile-path" });
  try {
    const dist = path.join(fx.repo, "dist");
    const tag = `v${FIXTURE_VERSION}`;
    const cases = [
      { label: "empty PATH component", path: `${path.delimiter}${process.env.PATH}`, expected: /PATH contains an empty component/ },
      { label: "relative '.' component", path: `.${path.delimiter}${process.env.PATH}`, expected: /PATH contains a relative component/ },
      { label: "no PATH at all", path: null, expected: /PATH is missing or empty/ },
    ];
    for (const { label, path: hostile, expected } of cases) {
      const env = { ...fx.isolation.env };
      if (hostile === null) delete env.PATH;
      else env.PATH = hostile;
      const before = await fingerprintOf(fx.repo, fx.isolation.env);
      const calls = [];
      const failure = await failureOf(
        buildReleaseArtifacts({ repository: fx.repo, tag, dist, env, run: recordingRun(calls) }),
      );
      assert.ok(failure instanceof GateFailure, `${label}: expected a GateFailure`);
      assert.equal(failure.step, "release", `${label}: unexpected step ${failure.step}`);
      assert.match(failure.message, expected, `${label}: unexpected message`);
      assert.deepEqual(calls, [], `${label}: no child command may run`);
      assert.ok(!existsSync(dist), `${label}: dist must not be created`);
      assert.deepEqual(await fingerprintOf(fx.repo, fx.isolation.env), before, `${label}: repository must be untouched`);
    }
  } finally {
    await fx.cleanup();
  }
});

test("a repository-local fake git on an absolute PATH is refused, never executes, and changes nothing", async () => {
  const fx = await createFixtureRepository({ label: "release-fake-git" });
  try {
    const dist = path.join(fx.repo, "dist");
    const marker = path.join(fx.base, "fake-git-executed");
    // An absolute PATH component that points *inside* the repository: the only
    // way to satisfy it would be to execute candidate-controlled code.
    const fake = path.join(fx.repo, "git");
    writeFileSync(fake, `#!/bin/sh\nprintf executed > "${marker}"\nexit 0\n`);
    chmodSync(fake, 0o755);

    const before = await fingerprintOf(fx.repo, fx.isolation.env);
    const calls = [];
    const failure = await failureOf(
      buildReleaseArtifacts({
        repository: fx.repo,
        tag: `v${FIXTURE_VERSION}`,
        dist,
        env: { ...fx.isolation.env, PATH: `${fx.repo}${path.delimiter}${process.env.PATH}` },
        run: recordingRun(calls),
      }),
    );

    assert.ok(failure instanceof GateFailure, "expected a GateFailure");
    assert.equal(failure.step, "release", `unexpected step ${failure.step}`);
    assert.match(failure.message, /inside the candidate repository/, "the refusal must name the repository-local tool");
    assert.deepEqual(calls, [], "no child command may run");
    assert.ok(!existsSync(marker), "the fake git must never execute");
    assert.ok(existsSync(fake), "the test's own file is untouched");
    assert.ok(!existsSync(dist), "dist must not be created, listed, or emptied");
    assert.deepEqual(await fingerprintOf(fx.repo, fx.isolation.env), before, "repository status, HEAD, and index must be untouched");
  } finally {
    await fx.cleanup();
  }
});
