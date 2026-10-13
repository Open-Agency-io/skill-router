// Phase 11 gate-library tests: the pure claim-checking surface (tag/version
// match, tarball identity, checksum files, pack output, output bounds,
// environment scrubbing, anti-recursion) plus the bounded child-process
// primitive. Nothing here reaches the network, a credentialed service, a
// container, or the real repository.

import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  GateFailure,
  GATE_ENV_FLAG,
  assertNoNestedGate,
  assertTagMatchesVersion,
  boundTail,
  expectedTarballFilename,
  formatChecksumFile,
  formatGateFailure,
  parseChecksumFile,
  parsePackResult,
  readRegularFileBounded,
  resolveExecutable,
  runCommand,
  sanitizeDiagnostic,
  scrubEnvironment,
  sha256File,
} from "../scripts/gate-lib.mjs";

const POSIX = process.platform !== "win32";
const SHA_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const CONTROL_BYTES = /[\u0000-\u0008\u000B-\u001F\u007F]/;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function tempDirectory(label) {
  return mkdtemp(path.join(os.tmpdir(), `skill-router-${label}-`));
}

test("exact tag-to-version matching only", () => {
  assert.deepEqual(assertTagMatchesVersion("v0.1.0", "0.1.0"), { tag: "v0.1.0", version: "0.1.0", expected: "v0.1.0" });
  assert.equal(assertTagMatchesVersion("v0.1.0-rc.1", "0.1.0-rc.1").expected, "v0.1.0-rc.1");

  const refused = [
    [undefined, "0.1.0"],
    ["", "0.1.0"],
    ["0.1.0", "0.1.0"],
    ["v0.1", "0.1.0"],
    ["v0.1.0.0", "0.1.0"],
    ["V0.1.0", "0.1.0"],
    ["v01.0.0", "0.1.0"],
    ["vv0.1.0", "0.1.0"],
    ["v0.1.0 ", "0.1.0"],
    ["v0.1.0\n", "0.1.0"],
    [" v0.1.0", "0.1.0"],
    ["v0.1.0-rc.1", "0.1.0"],
    ["v0.1.0", "0.1.0-rc.1"],
    ["v0.1.0", "1.0.0"],
    ["v0.1.0", "0.1"],
    ["v0.1.0", "0.1.0\n"],
    ["v$(id)", "0.1.0"],
    ["v0.1.0`id`", "0.1.0"],
    ["v0.1.0;id", "0.1.0"],
    [42, "0.1.0"],
    ["v0.1.0", undefined],
    ["v0.1.0", "../1.0.0"],
    ["v0.1.0", "1.0.0+"],
  ];
  for (const [tag, version] of refused) {
    assert.throws(
      () => assertTagMatchesVersion(tag, version),
      GateFailure,
      `expected refusal for tag=${JSON.stringify(tag)} version=${JSON.stringify(version)}`,
    );
  }
  assert.throws(() => assertTagMatchesVersion(undefined, "0.1.0"), /release tag is required/);
  assert.throws(() => assertTagMatchesVersion("v0.1.0", "0.1"), /not an exact semantic version/);
  assert.throws(() => assertTagMatchesVersion("0.1.0", "0.1.0"), /does not exactly match package\.json version \(expected "v0\.1\.0"\)/);
});

test("tarball filename identity is derived only from a safe name and exact version", () => {
  assert.equal(expectedTarballFilename("@openagency.io/skill-router", "0.1.0"), "openagency.io-skill-router-0.1.0.tgz");
  assert.equal(expectedTarballFilename("plain", "1.2.3"), "plain-1.2.3.tgz");
  assert.equal(expectedTarballFilename("@scope/pkg", "1.0.0-rc.1"), "scope-pkg-1.0.0-rc.1.tgz");
  assert.throws(() => expectedTarballFilename("@scope/pkg", "../1.0.0"), /refusing to derive a tarball name/);
  assert.throws(() => expectedTarballFilename("@scope/pkg", "1.0.0/../../evil"), /refusing to derive a tarball name/);
  assert.throws(() => expectedTarballFilename("../evil", "1.0.0"), /not a safe npm name/);
  assert.throws(() => expectedTarballFilename("@scope/pkg/evil", "1.0.0"), /not a safe npm name/);
  assert.throws(() => expectedTarballFilename("has space", "1.0.0"), /not a safe npm name/);
  assert.throws(() => expectedTarballFilename("", "1.0.0"), /name is missing/);
});

test("pack output must match exact name, version, filename, and required files", () => {
  const entry = {
    name: "@openagency.io/skill-router",
    version: "0.1.0",
    filename: "openagency.io-skill-router-0.1.0.tgz",
    size: 192930,
    files: [{ path: "LICENSE" }, { path: "README.md" }, { path: "package.json" }, { path: "src/cli.js" }],
  };
  const options = { name: "@openagency.io/skill-router", version: "0.1.0", requiredFiles: ["package.json", "src/cli.js"] };
  const parsed = parsePackResult(JSON.stringify([entry]), options);
  assert.equal(parsed.filename, "openagency.io-skill-router-0.1.0.tgz");
  assert.equal(parsed.size, 192930);
  assert.deepEqual(parsed.files, ["LICENSE", "README.md", "package.json", "src/cli.js"]);

  const cases = [
    ["", /no JSON output/],
    ["not json", /not valid JSON/],
    [JSON.stringify({}), /expected exactly one/],
    [JSON.stringify([entry, entry]), /expected exactly one/],
    [JSON.stringify([{ ...entry, name: "other" }]), /does not match package name/],
    [JSON.stringify([{ ...entry, version: "0.2.0" }]), /does not match package version/],
    [JSON.stringify([{ ...entry, filename: "wrong-0.1.0.tgz" }]), /does not match expected/],
    [JSON.stringify([{ ...entry, files: [] }]), /reported no file list/],
    [JSON.stringify([{ ...entry, files: [{ path: "package/../secrets" }] }]), /traversing path/],
    [JSON.stringify([{ ...entry, files: [{ path: "/etc/passwd" }] }]), /unsafe path/],
    [JSON.stringify([{ ...entry, files: [{ path: "C:/evil" }] }]), /absolute path/],
    [JSON.stringify([{ ...entry, files: [{ path: "node_modules/yaml/index.js" }] }]), /build state leaked/],
    [JSON.stringify([{ ...entry, files: [{ path: ".git/config" }] }]), /build state leaked/],
    [JSON.stringify([{ ...entry, files: [{ path: "src\\cli.js" }] }]), /unsafe path/],
    [JSON.stringify([{ ...entry, files: [{ path: "./package.json" }] }]), /traversing path/],
    [JSON.stringify([{ ...entry, files: [{ path: "README.md" }] }]), /missing required file/],
    [JSON.stringify([{ ...entry, files: [{ path: null }] }]), /unsafe path in pack output/],
  ];
  for (const [raw, pattern] of cases) {
    assert.throws(() => parsePackResult(raw, options), pattern, `expected refusal for ${raw.slice(0, 80)}`);
  }

  // A malformed pack keeps only a bounded copy of the offending output.
  let failure = null;
  try {
    parsePackResult("x".repeat(50000), options);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof GateFailure, "malformed pack output must fail closed");
  const rendered = formatGateFailure(failure);
  assert.ok(rendered.length < 40000, `diagnostic must stay bounded, got ${rendered.length}`);
});

test("checksum files are deterministic, verifiable, and refuse unsafe records", () => {
  const text = formatChecksumFile([
    { filename: "b.tgz", digest: DIGEST_B },
    { filename: "a.tgz", digest: DIGEST_A },
  ]);
  assert.equal(text, `${DIGEST_A}  a.tgz\n${DIGEST_B}  b.tgz\n`);
  assert.deepEqual(parseChecksumFile(text), [
    { filename: "a.tgz", digest: DIGEST_A },
    { filename: "b.tgz", digest: DIGEST_B },
  ]);

  assert.throws(() => formatChecksumFile([]), /at least one artifact/);
  assert.throws(() => formatChecksumFile([{ filename: "a.tgz", digest: DIGEST_A.toUpperCase() }]), /lowercase sha256/);
  assert.throws(() => formatChecksumFile([{ filename: "a.tgz", digest: "abc" }]), /lowercase sha256/);
  assert.throws(() => formatChecksumFile([{ filename: "dir/a.tgz", digest: DIGEST_A }]), /plain name/);
  assert.throws(() => formatChecksumFile([{ filename: "../a.tgz", digest: DIGEST_A }]), /plain name/);
  assert.throws(
    () => formatChecksumFile([{ filename: "a.tgz", digest: DIGEST_A }, { filename: "a.tgz", digest: DIGEST_B }]),
    /duplicate artifact/,
  );
  assert.throws(() => formatChecksumFile([{ filename: "", digest: DIGEST_A }]), /filename is missing/);
  assert.throws(() => formatChecksumFile([{ filename: "a.tgz" }]), /lowercase sha256/);

  assert.throws(() => parseChecksumFile(""), /empty/);
  assert.throws(() => parseChecksumFile(`${DIGEST_A}  a.tgz`), /must end with a newline/);
  assert.throws(() => parseChecksumFile(`${DIGEST_A}  a.tgz\r\n`), /LF line endings/);
  assert.throws(() => parseChecksumFile(`${DIGEST_A} a.tgz\n`), /not a valid sha256sum record/);
  assert.throws(() => parseChecksumFile(`${DIGEST_A}  a.tgz\n${DIGEST_A}  a.tgz\n`), /duplicate artifact/);
  assert.throws(() => parseChecksumFile(`${DIGEST_A}  ../a.tgz\n`), /plain name/);
  assert.throws(() => parseChecksumFile(`${DIGEST_A}  *a.tgz\n`), /plain name/);
  assert.throws(() => parseChecksumFile("garbage\n"), /not a valid sha256sum record/);
  assert.throws(() => parseChecksumFile(`${"a".repeat(63)}  a.tgz\n`), /not a valid sha256sum record/);
});

test("output bounds keep a bounded tail and diagnostics stay sanitized", () => {
  assert.deepEqual(boundTail("abc", 10), { text: "abc", truncated: false });
  const cut = boundTail("x".repeat(100), 10);
  assert.equal(cut.text, "x".repeat(10));
  assert.ok(cut.truncated);
  assert.equal(boundTail("HEAD-TAIL", 4).text, "TAIL");
  assert.deepEqual(boundTail(null, 4), { text: "", truncated: false });

  const failure = new GateFailure("step", "boom\u0007", [["stderr", "line\n".repeat(5000)]]);
  const rendered = formatGateFailure(failure);
  assert.match(rendered, /^gate: failed \| step step \| boom/);
  assert.ok(!CONTROL_BYTES.test(rendered), "control bytes must be sanitized");
  assert.ok(rendered.length < 60000, `rendered diagnostic must stay bounded, got ${rendered.length}`);
  assert.ok(rendered.includes("… truncated"), "truncation must be visible");
  assert.equal(sanitizeDiagnostic("a\u0007b\u001bc\nd"), "a\u00b7b\u00b7c\nd");
  assert.match(formatGateFailure(new Error("plain failure")), /^gate: failed \| step gate \| Error: plain failure/);
});

test("environment scrubbing drops credentials and host lifecycle configuration", () => {
  const scrubbed = scrubEnvironment(
    {
      PATH: "/usr/bin",
      HOME: "/Users/example",
      LANG: "C",
      CI: "true",
      GITHUB_TOKEN: "t",
      NPM_TOKEN: "t",
      ANTHROPIC_API_KEY: "k",
      OPENAI_API_KEY: "k",
      AWS_ACCESS_KEY_ID: "id",
      MY_PAT: "abc",
      SOME_SESSION_ID: "1",
      npm_config_registry: "https://example.invalid",
      NPM_CONFIG_USERCONFIG: "/tmp/user.npmrc",
      GIT_CONFIG_PARAMETERS: "core.hooksPath=/tmp/hooks",
      GIT_DIR: "/tmp/elsewhere",
      NODE_OPTIONS: "--require /tmp/hook.js",
      NODE_ENV: "production",
      NODE_PATH: "/tmp/modules",
      INIT_CWD: "/tmp/elsewhere",
      SKILL_ROUTER_OPENCODE_MODEL: "provider/model",
      // CI command-file and configuration channels (Phase 11 blocker 2).
      GITHUB_ENV: "/runner/gITHUB_ENV",
      GITHUB_PATH: "/runner/GITHUB_PATH",
      GITHUB_OUTPUT: "/runner/GITHUB_OUTPUT",
      GITHUB_STATE: "/runner/GITHUB_STATE",
      GITHUB_ACTIONS: "true",
      RUNNER_TEMP: "/runner/temp",
      RUNNER_TOOL_CACHE: "/runner/tool-cache",
      ACTIONS_CACHE_URL: "https://cache.invalid",
      DOCKER_CONFIG: "/host/.docker",
      KUBECONFIG: "/host/.kube/config",
      AWS_CONFIG_FILE: "/host/.aws/config",
      AWS_SHARED_CREDENTIALS_FILE: "/host/.aws/credentials",
      CLOUDSDK_CONFIG: "/host/.config/gcloud",
      AZURE_CONFIG_DIR: "/host/.azure",
      GOOGLE_APPLICATION_CREDENTIALS: "/host/sa.json",
      SSH_AUTH_SOCK: "/host/ssh-agent",
      SSLKEYLOGFILE: "/host/keys.log",
      // Shell and step working-directory context: on a hosted runner these
      // carry the host workspace path (e.g. PWD=/home/runner/work/...), so
      // they are host-path channels, not configuration.
      PWD: "/home/runner/work/skill-router/skill-router",
      OLDPWD: "/home/runner/work",
      _: "/opt/hostedtoolcache/node/24.21.0/x64/bin/node",
    },
    { HOME: "/tmp/gate-home", [GATE_ENV_FLAG]: "1" },
  );
  assert.equal(scrubbed.PATH, "/usr/bin");
  assert.equal(scrubbed.LANG, "C");
  assert.equal(scrubbed.CI, "true");
  assert.equal(scrubbed.HOME, "/tmp/gate-home");
  assert.equal(scrubbed[GATE_ENV_FLAG], "1");
  for (const key of [
    "GITHUB_TOKEN",
    "NPM_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "MY_PAT",
    "SOME_SESSION_ID",
    "npm_config_registry",
    "NPM_CONFIG_USERCONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_DIR",
    "NODE_OPTIONS",
    "NODE_ENV",
    "NODE_PATH",
    "INIT_CWD",
    "GITHUB_ENV",
    "GITHUB_PATH",
    "GITHUB_OUTPUT",
    "GITHUB_STATE",
    "GITHUB_ACTIONS",
    "RUNNER_TEMP",
    "RUNNER_TOOL_CACHE",
    "ACTIONS_CACHE_URL",
    "DOCKER_CONFIG",
    "KUBECONFIG",
    "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "CLOUDSDK_CONFIG",
    "AZURE_CONFIG_DIR",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "SSH_AUTH_SOCK",
    "SSLKEYLOGFILE",
    "PWD",
    "OLDPWD",
    "_",
  ]) {
    assert.ok(!(key in scrubbed), `${key} must be scrubbed`);
  }
  assert.equal(scrubbed.SKILL_ROUTER_OPENCODE_MODEL, "provider/model", "non-secret tool configuration is preserved");
  const input = { KEEP: "1" };
  scrubEnvironment(input, { EXTRA: "2" });
  assert.deepEqual(input, { KEEP: "1" }, "the source environment is never mutated");
});

test("the anti-recursion boundary refuses only a gate running against its own repository, canonically", async () => {
  const root = await tempDirectory("anti-recursion");
  try {
    const owner = path.join(root, "owner");
    mkdirSync(owner, { recursive: true });
    const fixture = path.join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    const alias = path.join(root, "owner-alias");
    symlinkSync(owner, alias);

    // Without the flag (or with a non-"1" value) this is not a gate child.
    assertNoNestedGate({}, owner, owner);
    assertNoNestedGate({ [GATE_ENV_FLAG]: "0" }, owner, owner);

    // With the flag set, the gate's own repository is refused in every spelling
    // — exact, `..`-normalized, trailing separator, and *symlink alias*: the
    // comparison canonicalizes both sides instead of comparing strings.
    assert.throws(() => assertNoNestedGate({ [GATE_ENV_FLAG]: "1" }, null, null), /nested clean-candidate gate refused/);
    assert.throws(() => assertNoNestedGate({ [GATE_ENV_FLAG]: "1" }, owner, owner), /nested clean-candidate gate refused/);
    assert.throws(
      () => assertNoNestedGate({ [GATE_ENV_FLAG]: "1" }, path.join(owner, "..", path.basename(owner)), owner),
      /nested clean-candidate gate refused/,
      "a `repo/../repo` spelling must not slip through",
    );
    assert.throws(() => assertNoNestedGate({ [GATE_ENV_FLAG]: "1" }, `${owner}${path.sep}`, owner), /nested clean-candidate gate refused/);
    assert.throws(
      () => assertNoNestedGate({ [GATE_ENV_FLAG]: "1" }, alias, owner),
      /nested clean-candidate gate refused/,
      "a symlink alias of the gate's own repository is the same repository",
    );

    // A genuinely different repository stays allowed; an unresolvable path is
    // never assumed to be "some other repository" — it fails closed.
    assertNoNestedGate({ [GATE_ENV_FLAG]: "1" }, fixture, owner);
    const missing = path.join(root, "does-not-exist");
    assert.throws(() => assertNoNestedGate({ [GATE_ENV_FLAG]: "1" }, missing, owner), /nested clean-candidate gate refused/);
    assert.throws(() => assertNoNestedGate({ [GATE_ENV_FLAG]: "1" }, owner, missing), /nested clean-candidate gate refused/);
    assert.ok(
      /cannot canonicalize/.test(formatGateFailure(assertCapture(() => assertNoNestedGate({ [GATE_ENV_FLAG]: "1" }, missing, owner)))),
      "an unresolvable path says so in the diagnostic",
    );

    assert.match(formatGateFailure(new GateFailure("gate", `nested clean-candidate gate refused: ${GATE_ENV_FLAG}=1`)), /step gate/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** A synchronous assertion helper: return the thrown error instead of failing. */
function assertCapture(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

test("bounded no-follow reads prove identity and refuse unsafe files", async () => {
  const root = await tempDirectory("bounded-read");
  try {
    const file = path.join(root, "data.txt");
    await writeFile(file, "abc");
    const read = readRegularFileBounded(file, { step: "read", label: "data.txt", maxBytes: 1024 });
    assert.equal(read.text, "abc");
    assert.equal(read.sha256, SHA_ABC, "the digest covers exactly the bytes returned");
    assert.equal(read.nlink, 1);
    assert.equal(read.mode, 0o644, "the normalized mode is reported");
    assert.ok(read.identity === null || /^[0-9]+:[0-9]+$/.test(read.identity));

    // The limit is enforced before allocation: a too-large file is refused.
    const big = path.join(root, "big.txt");
    writeFileSync(big, "y".repeat(64));
    assert.throws(() => readRegularFileBounded(big, { label: "big", maxBytes: 16 }), /exceeds the 16-byte read limit/);

    // Strict UTF-8: invalid bytes fail closed instead of becoming replacement
    // characters in a path or a manifest.
    const bad = path.join(root, "bad.bin");
    writeFileSync(bad, Buffer.from([0x61, 0xff, 0x62]));
    const badFailure = assertCapture(() => readRegularFileBounded(bad, { label: "bad" }));
    assert.ok(badFailure instanceof GateFailure);
    assert.match(badFailure.message, /not valid UTF-8/);

    // Symlink and hardlink are refused by lstat, before anything is opened.
    const link = path.join(root, "link.txt");
    await symlink(file, link);
    const linkFailure = assertCapture(() => readRegularFileBounded(link, { label: "link" }));
    assert.ok(linkFailure instanceof GateFailure);
    assert.match(linkFailure.message, /ordinary regular file/);
    linkSync(file, path.join(root, "alias.txt"));
    const hardFailure = assertCapture(() => readRegularFileBounded(file, { label: "data.txt" }));
    assert.ok(hardFailure instanceof GateFailure);
    assert.match(hardFailure.message, /single-link/);

    // Diagnostics never carry an absolute path or any file bytes.
    for (const failure of [badFailure, linkFailure, hardFailure]) {
      const rendered = formatGateFailure(failure);
      assert.ok(!rendered.includes(root), "no absolute path is disclosed");
      assert.ok(!rendered.includes("abc") && !rendered.includes("yyy"), "no file bytes are disclosed");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sha256 hashing accepts regular files only", async () => {
  const root = await tempDirectory("sha");
  try {
    const file = path.join(root, "abc.txt");
    await writeFile(file, "abc");
    assert.equal(await sha256File(file), SHA_ABC);
    const link = path.join(root, "link.txt");
    await symlink(file, link);
    await assert.rejects(sha256File(link), /non-regular file/);
    await assert.rejects(sha256File(path.join(root, "missing.txt")), /cannot stat/);
    await mkdir(path.join(root, "a-directory"));
    await assert.rejects(sha256File(path.join(root, "a-directory")), /non-regular file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runCommand reports success, failure, and spawn errors with bounded output", async () => {
  const ok = await runCommand({
    command: process.execPath,
    args: ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
    env: process.env,
    timeoutMs: 30000,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout, "out");
  assert.equal(ok.stderr, "err");
  assert.equal(ok.truncated, false);
  assert.equal(ok.survived, false);

  const failed = await runCommand({
    command: process.execPath,
    args: ["-e", "process.stderr.write('boom'); process.exit(3)"],
    env: process.env,
    timeoutMs: 30000,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 3);
  assert.match(failed.stderr, /boom/);

  const noisy = await runCommand({
    command: process.execPath,
    args: ["-e", "process.stdout.write('y'.repeat(100000))"],
    env: process.env,
    timeoutMs: 30000,
    maxOutputChars: 128,
  });
  assert.equal(noisy.ok, true);
  assert.equal(noisy.stdout.length, 128);
  assert.ok(noisy.truncated);
  assert.ok(noisy.stdout.endsWith("yyyy"));

  const missing = await runCommand({ command: "skill-router-no-such-command", args: [], env: process.env, timeoutMs: 30000 });
  assert.equal(missing.ok, false);
  assert.ok(missing.error, "a spawn failure must be reported");
  assert.match(missing.error, /ENOENT|spawn/i);
});

test("runCommand enforces its timeout and reaps the child", { skip: !POSIX }, async () => {
  const started = Date.now();
  const result = await runCommand({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    env: process.env,
    timeoutMs: 300,
    killGraceMs: 500,
  });
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.ok(elapsed < 10000, `timeout must settle quickly, took ${elapsed}ms`);
  assert.ok(result.pid, "the child pid is reported for reaping");
  assert.equal(alive(result.pid), false, "the timed-out child must be gone before the step settles");
});

test("runCommand terminates lingering same-group descendants before settling", { skip: !POSIX }, async () => {
  // The child spawns a grandchild that ignores its pipes, then exits at once:
  // without group termination the grandchild would outlive the step.
  const script = [
    'const { spawn } = require("node:child_process");',
    'const { writeSync } = require("node:fs");',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore"] });',
    'writeSync(1, String(child.pid));',
    "process.exit(0);",
  ].join("\n");
  const result = await runCommand({
    command: process.execPath,
    args: ["-e", script],
    env: process.env,
    timeoutMs: 30000,
    killGraceMs: 500,
  });
  assert.equal(result.ok, true, result.stderr);
  const grandchild = Number.parseInt(result.stdout.slice(-20), 10);
  assert.ok(Number.isInteger(grandchild) && grandchild > 0, `expected a grandchild pid, got ${JSON.stringify(result.stdout)}`);
  assert.equal(alive(grandchild), false, "a lingering descendant must not survive the step");
  assert.equal(result.survived, false);
});

test("child output survives chunk-split UTF-8 and fails closed on invalid bytes", async () => {
  // € is e2 82 ac: written in two separate flushes so a naive per-chunk
  // toString() would corrupt it at exactly the boundary git `-z` output hits.
  const split = await runCommand({
    command: process.execPath,
    args: ["-e", "process.stdout.write(Buffer.from([0xe2,0x82])); setTimeout(() => process.stdout.write(Buffer.from([0xac,0x0a])), 40)"],
    env: process.env,
    timeoutMs: 30000,
  });
  assert.equal(split.ok, true, split.error ?? split.stderr);
  assert.equal(split.stdout, "€\n", "a multi-byte character split across two reads must decode intact");
  assert.equal(split.invalidEncoding, false);

  const invalid = await runCommand({
    command: process.execPath,
    args: ["-e", "process.stdout.write(Buffer.from([0x61,0xff,0x62]))"],
    env: process.env,
    timeoutMs: 30000,
  });
  assert.equal(invalid.ok, false, "invalid output must fail the step closed");
  assert.equal(invalid.invalidEncoding, true);
  assert.match(String(invalid.error), /UTF-8/);
  assert.ok(!invalid.stdout.includes("�"), "invalid bytes are never silently replaced into a candidate path");
});

test("sha256 hashing refuses hard links and detects a swap and a mutation mid-hash", async () => {
  const root = await tempDirectory("sha-hardened");
  try {
    const file = path.join(root, "abc.txt");
    await writeFile(file, "abc");
    linkSync(file, path.join(root, "alias.txt"));
    await assert.rejects(sha256File(file), /hard links/, "a second link could rewrite the content from outside the gate");
    rmSync(path.join(root, "alias.txt"));
    assert.equal(await sha256File(file), SHA_ABC, "a single-link file hashes normally again");

    // (a) lstat -> open swap: the path becomes a symlink between the two calls.
    const outside = path.join(root, "outside.txt");
    writeFileSync(outside, "outside");
    await assert.rejects(
      sha256File(file, {
        hook: (point) => {
          if (point !== "after-lstat") return;
          rmSync(file);
          symlinkSync(outside, file);
        },
      }),
      /symbolic link/,
      "the open must not follow a link planted after the lstat",
    );
    assert.equal(readFileSync(outside, "utf8"), "outside", "the link target is never read");

    // (b) same-size in-place rewrite between the two digest passes.
    const mutable = path.join(root, "mutable.txt");
    writeFileSync(mutable, "abc");
    await assert.rejects(
      sha256File(mutable, {
        hook: (point) => {
          if (point === "mid-hash") writeFileSync(mutable, "abd");
        },
      }),
      /changed while it was being hashed/,
    );

    // (c) truncation between the pre-read fstat and the read itself.
    const truncating = path.join(root, "trunc.txt");
    writeFileSync(truncating, "abcdef");
    await assert.rejects(
      sha256File(truncating, {
        hook: (point) => {
          if (point === "after-pre") writeFileSync(truncating, "x");
        },
      }),
      /changed while it was being hashed/,
    );

    // The seam is inert when it only observes.
    const observed = path.join(root, "observed.txt");
    writeFileSync(observed, "abc");
    const points = [];
    assert.equal(await sha256File(observed, { hook: (point) => points.push(point) }), SHA_ABC);
    assert.deepEqual(points, ["after-lstat", "after-open", "after-pre", "mid-hash"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("command resolution is absolute, PATH-strict, and never inside the candidate repository", async () => {
  const root = await tempDirectory("resolve");
  try {
    const repository = path.join(root, "repo");
    mkdirSync(repository, { recursive: true });
    const fakeTool = path.join(repository, "git");
    writeFileSync(fakeTool, `#!/bin/sh\ntouch "${path.join(root, "executed")}"\n`);
    chmodSync(fakeTool, 0o755);

    // Relative or empty PATH components are refused outright — before a child
    // cwd could make `git` or `npm` resolve inside a candidate tree.
    assert.throws(() => resolveExecutable("git", { env: { PATH: "." } }), /relative component/);
    assert.throws(() => resolveExecutable("git", { env: { PATH: `subdir${path.delimiter}/usr/bin` } }), /relative component/);
    assert.throws(() => resolveExecutable("git", { env: { PATH: "" } }), /PATH is missing or empty/);
    assert.throws(() => resolveExecutable("git", { env: { PATH: `${root}${path.delimiter}` } }), /empty component/);
    assert.throws(() => resolveExecutable("./node", { env: process.env }), /relative command path/);

    // A repository-local fake tool is refused even though it resolves cleanly.
    assert.throws(() => resolveExecutable("git", { env: { PATH: repository }, forbiddenRoot: repository }), /inside the candidate repository/);
    assert.throws(() => resolveExecutable("git", { env: { PATH: `${repository}${path.delimiter}/usr/bin` }, forbiddenRoot: repository }), /inside the candidate repository/);
    assert.ok(!existsSync(path.join(root, "executed")), "the repository-local fake tool is never executed");

    const real = resolveExecutable("git", { env: process.env, forbiddenRoot: repository });
    assert.ok(path.isAbsolute(real), "a resolved tool is absolute");
    assert.ok(!real.startsWith(`${repository}${path.sep}`), "the real git is outside the repository");

    let missing = null;
    try {
      resolveExecutable("skill-router-definitely-not-a-tool", { env: process.env });
    } catch (error) {
      missing = error;
    }
    assert.equal(missing?.code, "ENOENT", "an absent tool reports ENOENT rather than a silent fallback");
    assert.match(String(missing?.message), /command not found in PATH/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runCommand executes a pre-resolved absolute tool and refuses a relative one", async () => {
  const resolved = await runCommand({
    command: "not-the-real-name",
    resolvedCommand: process.execPath,
    args: ["-e", "process.stdout.write('resolved')"],
    env: process.env,
    timeoutMs: 30000,
  });
  assert.equal(resolved.ok, true, resolved.error ?? resolved.stderr);
  assert.equal(resolved.stdout, "resolved");

  const relative = await runCommand({
    command: "not-the-real-name",
    resolvedCommand: "./node",
    args: [],
    env: process.env,
    timeoutMs: 30000,
  });
  assert.equal(relative.ok, false);
  assert.match(String(relative.error), /not absolute/);

  const relativePathEnv = await runCommand({
    command: "skill-router-no-such-command",
    args: [],
    env: { ...process.env, PATH: "." },
    timeoutMs: 30000,
  });
  assert.equal(relativePathEnv.ok, false, "a relative PATH component must not be resolved");
  assert.match(String(relativePathEnv.error), /relative component/);
});

test("an inherited pipe held by a detached descendant cannot hang the step", { skip: !POSIX }, async () => {
  // The grandchild is deliberately detached: it leaves this process group, so
  // it is *outside* the gate's portable containment boundary. It inherits the
  // pipes on purpose, which is exactly the case that used to keep `close`
  // (and therefore the whole gate) pending forever.
  const script = [
    'const { spawn } = require("node:child_process");',
    'const { writeSync } = require("node:fs");',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"], detached: true });',
    "child.unref();",
    "writeSync(1, String(child.pid));",
    "process.exit(0);",
  ].join("\n");

  let escaped = null;
  try {
    const started = Date.now();
    const result = await runCommand({
      command: process.execPath,
      args: ["-e", script],
      env: process.env,
      timeoutMs: 20000,
      killGraceMs: 500,
    });
    const elapsed = Date.now() - started;
    escaped = Number.parseInt(result.stdout.slice(-20), 10);
    assert.ok(Number.isInteger(escaped) && escaped > 0, `expected a detached grandchild pid, got ${JSON.stringify(result.stdout)}`);
    assert.equal(result.ok, true, result.error ?? result.stderr);
    assert.equal(result.timedOut, false, "settlement is driven by exit plus a bounded drain, not by pipe closure");
    assert.ok(elapsed < 10000, `the step settled promptly, took ${elapsed}ms`);
    // `survived` describes the child's own process group only; an escaped
    // descendant is never reported as killed, and never reported as contained.
    assert.equal(result.survived, false, "the child's process group is empty, so no survivor is claimed there");
    assert.equal(alive(escaped), true, "a detached descendant is outside this boundary — the gate makes no claim about it");
  } finally {
    if (escaped !== null && alive(escaped)) {
      try {
        process.kill(escaped, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
});
