import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { createJanitor, createRunner, repoRoot } from "../scripts/container-harness.mjs";
import {
  CONTAINER_FILES,
  IMAGE_ID_RE,
  LABELS,
  PlanError,
  classifyRemovalResult,
  createSanitizer,
  expectedCaseChain,
  expectedCaseOutcome,
  expandMatrix,
  loadMatrix,
  newRunId,
  planCaseRun,
  resolveSpecImage,
  runSpecToArgv,
  stageBuildContext,
} from "../scripts/container-lib.mjs";

const manifest = loadMatrix(repoRoot);
// The fake `npm pack` must produce the tarball name the real harness
// predicts from the actual package.json (name+version), or the lifecycle
// refuses the pack before any build runs.
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const PACKED_TARBALL_NAME = `openagency.io-skill-router-${PACKAGE_VERSION}.tgz`;
const MODEL_ENV = {
  SKILL_ROUTER_OPENCODE_MODEL: "openai/gpt-test-model",
  SKILL_ROUTER_CLAUDE_MODEL: "sonnet",
};
/** `claude setup-token` credential used by every live Claude case below. */
const OAUTH_SECRET = "sk-ant-oat01-lifecycle-token-0123456789";
const IMAGE_IDS = {
  "opencode-v1": `sha256:${"11".repeat(32)}`,
  "opencode-v2": `sha256:${"22".repeat(32)}`,
  claude: `sha256:${"33".repeat(32)}`,
};
const FAKE_CONTAINER_ID = "ab".repeat(32);
const ALLOWLIST = manifest.secretEnvAllowlist;

const tempDirs = [];
function tempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Fake docker/npm executor. It writes the artifacts a real daemon would
 * (iidfiles, cidfiles, packed tarball) so the lifecycle's reads behave
 * realistically, records every argv *and* executor env for assertions, and
 * supports scripted `docker rm -f` / `docker ps` outcomes for cleanup tests.
 */
function makeFake({
  reportTweak = null,
  labelFor = null,
  runFailure = null,
  caseOutput = null,
  rmQueue = [],
  rmFail = null,
  psFail = null,
  sweepLeftovers = [],
  sweepAlwaysLeftovers = false,
} = {}) {
  const calls = [];
  const seen = {
    records: [],
    pack: 0,
    builds: [],
    runs: [],
    rms: [],
    inspect: [],
    sweeps: [],
    artifactAtRun: [],
  };
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "", signal: null, error: null });
  let psCalls = 0;

  const executor = (argv, options = {}) => {
    calls.push(argv);
    seen.records.push({ argv, env: options.env ?? null });
    const [bin, sub] = argv;

    if (bin === "npm" && sub === "pack") {
      const destination = argv[argv.indexOf("--pack-destination") + 1];
      mkdirSync(destination, { recursive: true });
      const name = PACKED_TARBALL_NAME;
      writeFileSync(path.join(destination, name), "packed-artifact-bytes");
      seen.pack += 1;
      return ok(`${name}\n`);
    }
    if (bin === "docker" && sub === "version") return ok("29.4.0 29.4.0");
    if (bin === "docker" && sub === "info") return ok("linux arm64");

    if (bin === "docker" && sub === "ps") {
      const filter = argv[argv.indexOf("--filter") + 1];
      seen.sweeps.push(filter);
      psCalls += 1;
      if (psFail) return psFail;
      const leftovers = sweepAlwaysLeftovers || psCalls === 1 ? sweepLeftovers : [];
      return ok(`${leftovers.join("\n")}${leftovers.length ? "\n" : ""}`);
    }

    if (bin === "docker" && sub === "rm") {
      const target = argv[3];
      seen.rms.push(target);
      if (rmQueue.length) {
        const scripted = rmQueue.shift();
        return typeof scripted === "function" ? scripted(target) : scripted;
      }
      if (rmFail) return rmFail;
      return ok(`${target}\n`);
    }

    if (bin === "docker" && sub === "build") {
      if (argv.includes("--help")) return ok("  --iidfile string\n");
      const iidfile = argv[argv.indexOf("--iidfile") + 1];
      const harnessId = path.basename(iidfile, ".iid");
      writeFileSync(iidfile, IMAGE_IDS[harnessId]);
      seen.builds.push(harnessId);
      return ok();
    }

    if (bin === "docker" && sub === "run") {
      if (argv.includes("--help")) return ok("  --pull string\n  --cidfile string\n");
      const mount = argv.find((token) => token.startsWith("--mount=type=bind,"));
      if (mount) {
        const src = mount.match(/src=([^,]+)/)[1];
        const exists = existsSync(src);
        const sourceStat = exists ? statSync(src) : null;
        seen.artifactAtRun.push({
          src,
          exists,
          sha256: sourceStat?.isFile() ? createHash("sha256").update(readFileSync(src)).digest("hex") : null,
        });
      }
      const cidfile = argv.find((token) => token.startsWith("--cidfile="))?.slice("--cidfile=".length);
      assert.ok(cidfile, "every run declares a cidfile");
      mkdirSync(path.dirname(cidfile), { recursive: true });
      writeFileSync(cidfile, `${FAKE_CONTAINER_ID}\n`);
      seen.runs.push(argv);
      if (runFailure && runFailure(argv)) {
        return { status: 1, stdout: "", stderr: "container exploded Authorization: Bearer sk-ant-deadbeef0000", signal: null, error: null };
      }

      // Case runs: emit exactly one compact JSON report like the real runner
      // (derived structurally from the container's own inputs).
      const caseLabel = argv.find((token) => token.startsWith(`--label=${LABELS.case}=`));
      if (caseLabel) {
        if (caseOutput !== null) return ok(caseOutput);
        const caseId = caseLabel.slice(`--label=${LABELS.case}=`.length);
        const harness = argv
          .find((token) => token.startsWith(`--label=${LABELS.harness}=`))
          ?.slice(`--label=${LABELS.harness}=`.length);
        const container = argv.find((token) => token.startsWith("--name="))?.slice("--name=".length);
        const scenarioArg = argv.find((token) => token.startsWith("--scenario="))?.slice("--scenario=".length);
        const scenario = scenarioArg ?? (caseId.endsWith("-control") ? "control" : caseId.endsWith("-none") ? "none" : "select");
        const mount = argv.find((token) => token.startsWith("--mount=type=bind,"));
        const source = mount?.match(/src=([^,]+)/)?.[1];
        const artifactSha256 =
          source && existsSync(source) ? createHash("sha256").update(readFileSync(source)).digest("hex") : null;
        const outcome = expectedCaseOutcome(scenario);
        return ok(
          `${JSON.stringify({
            ok: true,
            case: caseId,
            harness,
            scenario,
            container,
            artifactSha256,
            sessionCount: 1,
            outcome: outcome.outcome,
            skillId: outcome.skillId,
            chain: expectedCaseChain(harness, scenario),
          })}\n`,
        );
      }

      const harnessArg = argv.find((token) => token.startsWith("--harness="));
      if (!harnessArg) return ok("");
      // auth-check: the in-image verifier's fake-auth report (structural only).
      if (argv.includes("--check-opencode-auth")) {
        const authPick = (flag) => argv.find((token) => token.startsWith(`${flag}=`))?.slice(flag.length + 1);
        const harnessId = authPick("--harness");
        return ok(
          `${JSON.stringify({
            ok: true,
            harnessId,
            package: authPick("--package"),
            packageVersion: authPick("--version"),
            binary: authPick("--binary"),
            binaryVersion: authPick("--version"),
            major: Number(authPick("--major")),
            uid: 1000,
            nonRoot: true,
            platform: { os: "linux", arch: "arm64", node: "v22.0.0" },
            providers: ["openai", "opencode-go"],
            recognition: "listed",
            auth: { mode: "snapshot" },
          })}\n`,
        );
      }
      const pick = (flag) => argv.find((token) => token.startsWith(`${flag}=`))?.slice(flag.length + 1);
      let report = {
        ok: true,
        harnessId: pick("--harness"),
        package: pick("--package"),
        packageVersion: pick("--version"),
        binary: pick("--binary"),
        binaryVersion: pick("--version"),
        major: Number(pick("--major")),
        uid: 1000,
        nonRoot: true,
        platform: { os: "linux", arch: "arm64", node: "v22.0.0" },
      };
      if (reportTweak) report = reportTweak(report);
      return ok(`${JSON.stringify(report)}\n`);
    }

    if (bin === "docker" && sub === "image" && argv[2] === "inspect") {
      const target = argv.at(-1);
      if (argv.includes("{{.Id}}")) {
        const harnessId = Object.keys(IMAGE_IDS).find((id) => target.includes(id));
        assert.ok(harnessId, `unknown image ref ${target}`);
        return ok(`${IMAGE_IDS[harnessId]}\n`);
      }
      const imageId = target;
      const harnessId = Object.keys(IMAGE_IDS).find((id) => IMAGE_IDS[id] === imageId);
      assert.ok(harnessId, `unknown image id ${imageId}`);
      seen.inspect.push(harnessId);
      return ok(
        JSON.stringify({
          Id: imageId,
          Os: "linux",
          Architecture: "arm64",
          RepoTags: [`skill-router/harness:${harnessId}`],
          Config: { Labels: { [LABELS.harness]: labelFor ? labelFor(harnessId) : harnessId } },
        }),
      );
    }

    throw new Error(`unexpected command: ${argv.join(" ")}`);
  };

  return { executor, calls, seen };
}

function makeRunner(fake, extra = {}) {
  const output = [];
  const runner = createRunner({
    executor: fake.executor,
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? "" },
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
    ...extra,
  });
  return { runner, output };
}

function resolvedCaseSpec() {
  const descriptor = expandMatrix(manifest).find((entry) => entry.id === "opencode-v1-select");
  const cidfile = path.join(tempDir("skill-router-janitor-"), "case.cid");
  const planned = planCaseRun({
    manifest,
    case: descriptor,
    artifactPath: path.join(os.tmpdir(), "skill-router-pack-unit", PACKED_TARBALL_NAME),
    runId: newRunId(),
    repoRoot,
    home: process.env.HOME,
    cidfile,
  });
  return resolveSpecImage(planned.spec, IMAGE_IDS["opencode-v1"]);
}

function workdirOf(fake) {
  const build = fake.calls.find((argv) => argv.includes("--iidfile"));
  const iidfile = build[build.indexOf("--iidfile") + 1];
  return path.dirname(path.dirname(iidfile));
}

function noSecretsIn(records) {
  for (const record of records) {
    if (!record.env) continue;
    for (const name of ALLOWLIST) {
      assert.ok(!(name in record.env), `credential ${name} leaked into executor env for ${record.argv.slice(0, 3).join(" ")}`);
    }
  }
}

/** Real container executions (not the `docker run --help` probe). */
function isContainerRun(argv) {
  return argv[0] === "docker" && argv[1] === "run" && argv.includes("--pull=never");
}

test("executeRun forces docker rm -f and removes cidfile metadata on success, failure, and timeout", () => {
  for (const outcome of ["success", "failure", "timeout"]) {
    const fake = makeFake({ runFailure: () => outcome === "failure" });
    const original = fake.executor;
    fake.executor = (argv, options) => {
      if (argv[0] === "docker" && argv[1] === "run" && outcome === "timeout") {
        original(argv, options);
        return { status: null, stdout: "", stderr: "", signal: null, error: Object.assign(new Error("spawn docker ETIMEDOUT"), { code: "ETIMEDOUT" }) };
      }
      return original(argv, options);
    };
    const { runner: rebound } = makeRunner({ executor: fake.executor, calls: fake.calls, seen: fake.seen });
    const spec = resolvedCaseSpec();

    let error = null;
    try {
      rebound.executeRun(spec, { label: `case ${outcome}`, timeout: 50 });
    } catch (caught) {
      error = caught;
    }

    if (outcome === "success") assert.equal(error, null, "success must not throw");
    else if (outcome === "failure") {
      assert.ok(error);
      assert.ok(!String(error.message).includes("sk-ant-deadbeef0000"), "failure text stays sanitized");
      assert.ok(String(error.message).includes("[redacted"), "credential was redacted in failure text");
    } else {
      assert.ok(/ETIMEDOUT/.test(String(error.message)), "timeout surfaces as a spawn timeout");
    }

    assert.equal(fake.seen.runs.length, 1, `${outcome}: one container started`);
    assert.equal(fake.seen.rms.length, 1, `${outcome}: forced cleanup ran exactly once`);
    assert.equal(fake.seen.rms[0], FAKE_CONTAINER_ID, `${outcome}: cleanup targets the cidfile id`);
    assert.equal(existsSync(spec.cidfile), false, `${outcome}: cidfile removed`);
    assert.deepEqual(rebound.janitor.activeNames(), [], `${outcome}: no tracked containers remain`);
  }
});

test("janitor classifies cleanup outcomes: nonzero and spawn errors retained, already-absent cleaned", () => {
  const secret = "sk-ant-cleanup-secret-00000000";
  const sanitize = createSanitizer({});
  const cidfile = path.join(tempDir("skill-router-janitor-"), "case.cid");
  writeFileSync(cidfile, `${FAKE_CONTAINER_ID}\n`);

  // Nonzero exit without a no-such-container hint: hard failure, retained.
  const failing = makeFake({ rmQueue: [{ status: 1, stderr: `daemon error Bearer ${secret}` }] });
  const janitorFailing = createJanitor({ executor: failing.executor, env: {}, cwd: repoRoot, processRef: { on() {}, removeListener() {} }, sanitize });
  janitorFailing.track("skill-router-case-a-1", cidfile);
  const failed = janitorFailing.cleanup("skill-router-case-a-1", cidfile);
  assert.equal(failed.ok, false);
  assert.deepEqual(janitorFailing.activeNames(), ["skill-router-case-a-1"], "failed target retained for retry");
  assert.equal(existsSync(cidfile), true, "cidfile retained while cleanup is pending");
  const failureMessages = janitorFailing.failures();
  assert.equal(failureMessages.length, 1);
  assert.ok(!failureMessages[0].includes(secret), "cleanup failure text is sanitized");

  // Retry succeeds: bookkeeping and cidfile dropped.
  const retried = janitorFailing.cleanup("skill-router-case-a-1", cidfile);
  assert.equal(retried.ok, true);
  assert.deepEqual(janitorFailing.activeNames(), []);
  assert.deepEqual(janitorFailing.failures(), []);
  assert.equal(existsSync(cidfile), false);

  // Spawn/daemon error: retained, reason names the spawn error code.
  const daemon = makeFake({ rmFail: { status: null, stdout: "", stderr: "", signal: null, error: Object.assign(new Error("spawn docker ECONNREFUSED"), { code: "ECONNREFUSED" }) } });
  const janitorDaemon = createJanitor({ executor: daemon.executor, env: {}, cwd: repoRoot, processRef: { on() {}, removeListener() {} }, sanitize });
  janitorDaemon.track("skill-router-case-a-2", cidfile);
  const daemonOutcome = janitorDaemon.cleanup("skill-router-case-a-2", cidfile);
  assert.equal(daemonOutcome.ok, false);
  assert.match(daemonOutcome.reason, /ECONNREFUSED/);
  assert.deepEqual(janitorDaemon.activeNames(), ["skill-router-case-a-2"]);

  // Already absent (explicit no-such-container): treated as cleaned.
  const absent = makeFake({ rmQueue: [{ status: 1, stderr: "Error: No such container: xyz", stdout: "" , signal: null, error: null }] });
  const janitorAbsent = createJanitor({ executor: absent.executor, env: {}, cwd: repoRoot, processRef: { on() {}, removeListener() {} }, sanitize });
  writeFileSync(cidfile, `${FAKE_CONTAINER_ID}\n`);
  janitorAbsent.track("skill-router-case-a-3", cidfile);
  const absentOutcome = janitorAbsent.cleanup("skill-router-case-a-3", cidfile);
  assert.equal(absentOutcome.ok, true);
  assert.equal(absentOutcome.alreadyAbsent, true);
  assert.deepEqual(janitorAbsent.activeNames(), []);
  assert.equal(existsSync(cidfile), false, "already-absent container still clears metadata");

  // Termination signal during cleanup: failure, cidfile + bookkeeping retained.
  const signaled = makeFake({ rmQueue: [{ status: null, signal: "SIGKILL", error: null, stdout: "", stderr: "" }] });
  const janitorSignaled = createJanitor({ executor: signaled.executor, env: {}, cwd: repoRoot, processRef: { on() {}, removeListener() {} }, sanitize });
  writeFileSync(cidfile, `${FAKE_CONTAINER_ID}\n`);
  janitorSignaled.track("skill-router-case-a-4", cidfile);
  const signaledOutcome = janitorSignaled.cleanup("skill-router-case-a-4", cidfile);
  assert.equal(signaledOutcome.ok, false, "signal result is not cleaned");
  assert.match(signaledOutcome.reason, /killed by signal SIGKILL/);
  assert.deepEqual(janitorSignaled.activeNames(), ["skill-router-case-a-4"], "bookkeeping retained on signal result");
  assert.equal(existsSync(cidfile), true, "cidfile retained on signal result");

  // Missing exit status (no signal, no spawn error): same retention.
  const noStatus = makeFake({ rmQueue: [{ status: null, signal: null, error: null, stdout: "", stderr: "" }] });
  const janitorNoStatus = createJanitor({ executor: noStatus.executor, env: {}, cwd: repoRoot, processRef: { on() {}, removeListener() {} }, sanitize });
  writeFileSync(cidfile, `${FAKE_CONTAINER_ID}\n`);
  janitorNoStatus.track("skill-router-case-a-5", cidfile);
  const noStatusOutcome = janitorNoStatus.cleanup("skill-router-case-a-5", cidfile);
  assert.equal(noStatusOutcome.ok, false, "null status is not cleaned");
  assert.match(noStatusOutcome.reason, /no exit status/);
  assert.deepEqual(janitorNoStatus.activeNames(), ["skill-router-case-a-5"], "bookkeeping retained on null status");
  assert.equal(existsSync(cidfile), true, "cidfile retained on null status");
});

test("classifyRemovalResult distinguishes success, already-absent, and failures", () => {
  assert.equal(classifyRemovalResult({ status: 0, stdout: "x", stderr: "" }).cleaned, true);
  const absent = classifyRemovalResult({ status: 1, stdout: "", stderr: "Error: No such container: abc" });
  assert.equal(absent.cleaned, true);
  assert.equal(absent.alreadyAbsent, true);
  const nonzero = classifyRemovalResult({ status: 1, stdout: "", stderr: "daemon exploded" });
  assert.equal(nonzero.cleaned, false);
  assert.equal(nonzero.reason, "exit status 1");
  const spawn = classifyRemovalResult({ status: null, error: { code: "ENOENT" } });
  assert.equal(spawn.cleaned, false);
  assert.match(spawn.reason, /ENOENT/);

  // Only status 0 or an explicit no-such-container status counts as cleaned.
  const nullStatus = classifyRemovalResult({ status: null, signal: null, error: null, stdout: "", stderr: "" });
  assert.equal(nullStatus.cleaned, false, "null/undefined status is never cleaned");
  assert.match(nullStatus.reason, /no exit status/);
  const undefinedStatus = classifyRemovalResult({});
  assert.equal(undefinedStatus.cleaned, false);
  const signaled = classifyRemovalResult({ status: null, signal: "SIGKILL", error: null, stdout: "", stderr: "" });
  assert.equal(signaled.cleaned, false, "a termination signal is never cleaned");
  assert.match(signaled.reason, /killed by signal SIGKILL/);
  const signaledSuccess = classifyRemovalResult({ status: 0, signal: "SIGKILL", error: null });
  assert.equal(signaledSuccess.cleaned, false, "signal wins over a stray status");
  const absentButNull = classifyRemovalResult({ status: null, signal: null, error: null, stdout: "", stderr: "Error: No such container: abc" });
  assert.equal(absentButNull.cleaned, false, "no-such-container text requires an explicit exit status");
});

test("janitor installs bounded signal cleanup and removes handlers when idle", () => {
  const fake = makeFake();
  const handlers = new Map();
  const exits = [];
  const processRef = {
    on(signal, handler) {
      handlers.set(signal, handler);
    },
    removeListener(signal) {
      handlers.delete(signal);
    },
    exit(code) {
      exits.push(code);
    },
  };
  const cidfile = path.join(tempDir("skill-router-signal-"), "signal.cid");
  const janitor = createJanitor({ executor: fake.executor, env: {}, cwd: repoRoot, processRef });

  janitor.track("skill-router-case-x-1", cidfile);
  assert.deepEqual(janitor.signalNames().sort(), ["SIGHUP", "SIGINT", "SIGTERM"]);
  assert.deepEqual(janitor.activeNames(), ["skill-router-case-x-1"]);

  handlers.get("SIGINT")();
  assert.equal(fake.seen.rms.length, 1, "interrupt force-removes the active container");
  assert.equal(fake.seen.rms[0], "skill-router-case-x-1", "unknown cidfile falls back to the unique name");
  assert.deepEqual(janitor.activeNames(), []);
  assert.deepEqual(janitor.signalNames(), [], "handlers removed once idle");
  assert.deepEqual(exits, [130]);
});

test("janitor cleanupAll reports a structured summary and keeps failures pending", () => {
  const fake = makeFake();
  const processRef = { on() {}, removeListener() {} };
  const janitor = createJanitor({ executor: fake.executor, env: {}, cwd: repoRoot, processRef });
  janitor.track("c-one", "/tmp/missing-one.cid");
  janitor.track("c-two", "/tmp/missing-two.cid");
  const summary = janitor.cleanupAll();
  assert.deepEqual([...summary.removed].sort(), ["c-one", "c-two"]);
  assert.deepEqual(summary.failed, []);
  assert.deepEqual(summary.pending, []);
  assert.deepEqual(fake.seen.rms.sort(), ["c-one", "c-two"]);

  const failing = makeFake({ rmFail: { status: 1, stdout: "", stderr: "nope", signal: null, error: null } });
  const janitorFailing = createJanitor({ executor: failing.executor, env: {}, cwd: repoRoot, processRef });
  janitorFailing.track("c-three", "/tmp/missing-three.cid");
  const failedSummary = janitorFailing.cleanupAll();
  assert.deepEqual(failedSummary.removed, []);
  assert.equal(failedSummary.failed.length, 1);
  assert.deepEqual(failedSummary.pending, ["c-three"], "failed target stays tracked for retry");
  assert.equal(janitorFailing.failures().length, 1);
});

test("enclosing lifecycle executes cases itself, packs once, shares the artifact, and cleans up", () => {
  const hostEnv = {
    PATH: process.env.PATH ?? "",
    ...MODEL_ENV,
    CLAUDE_CODE_OAUTH_TOKEN: OAUTH_SECRET,
    ANTHROPIC_API_KEY: "sk-ant-live-0123456789abcdef",
    OPENAI_API_KEY: "sk-openai-live-0123456789",
    GEMINI_API_KEY: "AIza-not-requested-0123456789",
  };
  const fake = makeFake();
  const { runner, output } = makeRunner(fake, { env: hostEnv });

  const result = runner.run({
    secretEnv: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
    executeCases: true,
  });

  // pack exactly once, hash locked, artifact alive during every case
  assert.equal(fake.seen.pack, 1, "npm pack runs exactly once per lifecycle");
  assert.match(result.packed.sha256, /^[0-9a-f]{64}$/);
  assert.equal(fake.seen.artifactAtRun.length, 7, "every case run mounts the artifact");
  const artifactPaths = new Set(fake.seen.artifactAtRun.map((entry) => entry.src));
  assert.equal(artifactPaths.size, 1, "every planned case receives the same artifact path");
  assert.ok(fake.seen.artifactAtRun.every((entry) => entry.exists), "artifact exists while cases execute");
  assert.ok(
    fake.seen.artifactAtRun.every((entry) => entry.sha256 === result.packed.sha256),
    "every case consumed the same locked artifact hash",
  );

  // production runner owns execution: recorded argv deep-equals canonical
  assert.equal(result.executed.length, 7, "production runner executed every case");
  assert.equal(fake.seen.runs.length, 7, "one fresh container per case");
  const runsByName = new Map(fake.seen.runs.map((argv) => [argv.find((token) => token.startsWith("--name=")), argv]));
  for (const executed of result.executed) {
    const recorded = runsByName.get(`--name=${executed.spec.name}`);
    assert.deepEqual(recorded, runSpecToArgv(executed.spec), "live argv deep-equals the canonical typed construction");
    assert.ok(recorded.includes("--pull=never"));
    assert.match(recorded.find((token) => token.startsWith("sha256:")) ?? "", IMAGE_ID_RE);

    // production in-container command carries the full case contract
    const command = executed.spec.command;
    assert.equal(command[0], "node");
    assert.equal(command[1], "/usr/local/lib/skill-router/run-case.mjs");
    assert.ok(command.includes(`--case=${executed.caseId}`));
    assert.ok(command.includes(`--harness=${executed.spec.harnessId}`));
    assert.ok(command.includes(`--scenario=${executed.report.scenario}`));
    assert.ok(command.includes(`--artifact-sha256=${result.packed.sha256}`), "command carries the locked artifact hash");
    assert.ok(command.includes(`--container-name=${executed.spec.name}`), "command carries the unique container name");

    // model env is non-secret, harness-specific, and lives in argv (not env)
    const modelTokens = recorded.filter((token) => token.startsWith("--env=SKILL_ROUTER_"));
    if (executed.spec.harnessId === "claude") {
      assert.deepEqual(modelTokens, ["--env=SKILL_ROUTER_CLAUDE_MODEL=sonnet"]);
    } else {
      assert.deepEqual(modelTokens, ["--env=SKILL_ROUTER_OPENCODE_MODEL=openai/gpt-test-model"]);
    }

    // validated report per case
    assert.equal(executed.report.case, executed.caseId);
    assert.equal(executed.report.artifactSha256, result.packed.sha256);
    assert.equal(executed.report.sessionCount, 1);
    assert.deepEqual(executed.report.chain, expectedCaseChain(executed.spec.harnessId, executed.report.scenario));
  }
  assert.equal(
    output.filter((line) => line.startsWith("case ") && line.includes(": ok outcome=")).length,
    7,
    "one concise sanitized success line per executed case",
  );
  assert.ok(output.some((line) => line.includes("cases executed: 7 across 7 unique containers")));

  // per-harness secret scoping end to end
  const withOpenAI = fake.seen.runs.filter((argv) => argv.includes("--env=OPENAI_API_KEY"));
  const withAnthropic = fake.seen.runs.filter((argv) => argv.includes("--env=ANTHROPIC_API_KEY"));
  const withOAuth = fake.seen.runs.filter((argv) => argv.includes("--env=CLAUDE_CODE_OAUTH_TOKEN"));
  assert.equal(withOpenAI.length, 4, "only the four OpenCode cases receive the OpenAI key");
  assert.equal(withAnthropic.length, 4, "only the four OpenCode cases receive the Anthropic key");
  assert.equal(withOAuth.length, 3, "only the three Claude cases receive the setup token");
  const claudeRuns = fake.seen.runs.filter((argv) => argv.includes(`--label=${LABELS.harness}=claude`));
  assert.equal(claudeRuns.length, 3);
  assert.ok(claudeRuns.every((argv) => !argv.includes("--env=OPENAI_API_KEY")));
  assert.ok(claudeRuns.every((argv) => !argv.includes("--env=ANTHROPIC_API_KEY")), "Claude cases never receive an API key");
  assert.ok(claudeRuns.every((argv) => argv.includes("--env=CLAUDE_CODE_OAUTH_TOKEN")), "Claude cases receive the setup token");
  for (const argv of fake.seen.runs) {
    const tokenCount = argv.filter((token) => token === "--env=CLAUDE_CODE_OAUTH_TOKEN").length;
    assert.ok(tokenCount <= 1, "the setup token is inherited by name at most once");
    assert.ok(!argv.some((token) => token.startsWith("--env=CLAUDE_CODE_OAUTH_TOKEN=")), "never given a value on argv");
    assert.ok(!argv.includes(OAUTH_SECRET), "the token value never reaches argv");
  }

  // credential-free host subprocesses; scoped env only for case containers
  noSecretsIn(fake.seen.records.filter((record) => !isContainerRun(record.argv)));
  for (const record of fake.seen.records) {
    if (!isContainerRun(record.argv) || !record.env) continue;
    assert.ok(!("GEMINI_API_KEY" in record.env), "unrequested provider key must never reach a container command");
    const claude = record.argv.includes(`--label=${LABELS.harness}=claude`);
    if (claude) {
      assert.ok("CLAUDE_CODE_OAUTH_TOKEN" in record.env, "Claude case env carries the setup token");
      assert.ok(!("ANTHROPIC_API_KEY" in record.env), "Claude case env carries no API key");
      assert.ok(!("OPENAI_API_KEY" in record.env), "Claude case env carries only its own selected secret");
    } else {
      assert.ok("OPENAI_API_KEY" in record.env && "ANTHROPIC_API_KEY" in record.env);
      assert.ok(!("CLAUDE_CODE_OAUTH_TOKEN" in record.env), "OpenCode case env never carries the Claude setup token");
    }
  }
  for (const line of output) {
    assert.ok(!line.includes(OAUTH_SECRET), "the token value never reaches host output");
  }

  // forced cleanup per container plus the label sweep, all verified
  assert.equal(fake.seen.rms.length, 7, "docker rm -f ran for every container");
  assert.equal(fake.seen.sweeps.length, 2, "label sweep lists before and after removal");
  assert.ok(fake.seen.sweeps.every((filter) => filter.startsWith(`label=${LABELS.run}=`)));
  assert.equal(new Set(fake.seen.sweeps).size, 1, "sweep uses the exact run label");
  assert.equal(result.sweep.verifiedAbsent, true);
  assert.deepEqual(result.cleanup.pending, []);
  assert.deepEqual(runner.janitor.activeNames(), []);

  assert.equal(existsSync(workdirOf(fake)), false, "lifecycle temp dir removed in finally");
  assert.equal(existsSync(result.packed.artifactPath), false, "artifact metadata removed with the temp dir");
  assert.ok(output.some((line) => line.startsWith("lifecycle: staged context")));
  assert.ok(output.some((line) => line.includes("cleanup: verified")), "cleanup is only claimed after the sweep verifies absence");
});

test("CLI run preflight fails before any pack, build, probe, or container when model envs are missing", () => {
  const fake = makeFake();
  const { runner } = makeRunner(fake, { env: { PATH: process.env.PATH ?? "" } });

  assert.throws(
    () => runner.run({}),
    (error) => {
      assert.ok(error instanceof PlanError);
      assert.ok(/refusing to start live case containers/.test(error.message), "aggregated preflight message");
      assert.ok(error.message.includes("SKILL_ROUTER_OPENCODE_MODEL"), "OpenCode model required, never defaulted");
      assert.ok(error.message.includes("SKILL_ROUTER_CLAUDE_MODEL"), "Claude model required, never defaulted");
      assert.ok(error.message.includes("CLAUDE_CODE_OAUTH_TOKEN"), "Claude setup token required, never defaulted");
      assert.ok(!error.message.includes("ANTHROPIC_API_KEY"), "an API key is never demanded for Claude cases");
      assert.ok(!error.message.includes(repoRoot), "no host repository path in the message");
      return true;
    },
  );
  assert.equal(fake.calls.length, 0, "preflight failure happens before any subprocess (no pack/build/probe/container)");
  assert.equal(fake.seen.runs.length, 0, "no case container started");
  assert.equal(fake.seen.pack, 0, "no pack happened");
  assert.equal(fake.seen.builds.length, 0, "no build happened");
});

test("executeCases=false keeps the lifecycle credential-free and skips case containers", () => {
  const fake = makeFake();
  const { runner, output } = makeRunner(fake, { env: { PATH: process.env.PATH ?? "" } });

  const result = runner.run({ executeCases: false });
  assert.equal(result.executed.length, 0);
  assert.equal(fake.seen.runs.length, 0, "no case container was started");
  assert.equal(fake.seen.pack, 1, "lifecycle still packs once");
  assert.equal(fake.seen.builds.length, 3, "lifecycle still resolves immutable images");
  assert.equal(result.freshness.containers, 7, "seven cases were still planned with unique containers");
  assert.ok(output.some((line) => line.includes("cases not executed (executeCases=false)")));
  assert.ok(output.some((line) => line.includes("cleanup: verified")));
  assert.equal(existsSync(workdirOf(fake)), false, "temp dir removed");
});

test("run rejects --no-build before touching Docker or credentials", () => {
  const fake = makeFake();
  const { runner } = makeRunner(fake, { env: { PATH: process.env.PATH ?? "", ANTHROPIC_API_KEY: "sk-ant-live-0123456789abcdef" } });
  assert.throws(
    () => runner.run({ skipBuild: true, secretEnv: ["ANTHROPIC_API_KEY"], executeCases: true }),
    (error) => error instanceof PlanError && /--no-build`? is forbidden/.test(error.message),
  );
  assert.equal(fake.calls.length, 0, "rejection happens before any subprocess");
});

test("live case execution rejects missing credentials before build or container", () => {
  const fake = makeFake();
  const { runner } = makeRunner(fake, {
    env: { PATH: process.env.PATH ?? "", ANTHROPIC_API_KEY: "sk-ant-live-0123456789abcdef", ...MODEL_ENV },
  });

  assert.throws(
    () => runner.run({ executeCases: true, secretEnv: ["OPENAI_API_KEY"] }),
    (error) => error instanceof PlanError && /refusing to start live case containers/.test(error.message) && /OPENAI_API_KEY must be set in the host environment/.test(error.message),
    "the selected provider credential is absent",
  );
  assert.equal(fake.calls.length, 0, "missing credential fails before pack, build, probe, or container");

  assert.throws(
    () => runner.run({ executeCases: true }),
    (error) =>
      error instanceof PlanError &&
      /requires --secret-env OPENAI_API_KEY/.test(error.message) &&
      error.message.includes("CLAUDE_CODE_OAUTH_TOKEN") &&
      !error.message.includes("ANTHROPIC_API_KEY"),
    "no credential selected at all is rejected even with model envs present",
  );
  assert.equal(fake.calls.length, 0, "still no subprocess");

  // Planning still reports missing secrets without executing anything.
  const plan = runner.plan({ secretEnv: ["OPENAI_API_KEY"] });
  assert.equal(plan.cases.length, 7);
  assert.equal(fake.calls.length, 0, "planning never executes");
});

test("case adapters supply only the in-container command; host argv stays canonical", () => {
  const fake = makeFake();
  const { runner } = makeRunner(fake, {
    env: {
      PATH: process.env.PATH ?? "",
      ...MODEL_ENV,
      CLAUDE_CODE_OAUTH_TOKEN: OAUTH_SECRET,
      ANTHROPIC_API_KEY: "sk-ant-live-0123456789abcdef",
      OPENAI_API_KEY: "sk-openai-live-0123456789",
    },
  });
  const seenCases = [];
  const runOptions = { executeCases: true, secretEnv: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] };

  const result = runner.run({
    ...runOptions,
    caseCommander: ({ case: caseDescriptor }) => {
      seenCases.push(caseDescriptor.id);
      return { command: ["node", "/usr/local/lib/skill-router/adapt.mjs", `--case=${caseDescriptor.id}`] };
    },
  });
  assert.equal(result.executed.length, 7);
  assert.deepEqual([...seenCases].sort(), [...expectedCaseIds()].sort(), "adapter receives case definitions, not docker argv");

  const runsByName = new Map(fake.seen.runs.map((argv) => [argv.find((token) => token.startsWith("--name=")), argv]));
  for (const executed of result.executed) {
    const recorded = runsByName.get(`--name=${executed.spec.name}`);
    assert.deepEqual(recorded, runSpecToArgv(executed.spec), "argv still deep-equals canonical output");
    assert.deepEqual(recorded.slice(-3), ["node", "/usr/local/lib/skill-router/adapt.mjs", `--case=${executed.caseId}`]);
    assert.ok(recorded.includes("--pull=never"), "docker options are untouched by the adapter");
    assert.ok(recorded.includes("--read-only"), "docker options are untouched by the adapter");
    assert.equal(executed.report.case, executed.caseId, "report still validated against the case");
  }

  assert.throws(
    () => runner.run({ ...runOptions, caseCommander: () => ["--cap-add=SYS_ADMIN"] }),
    (error) => error instanceof PlanError && /in-container executable/.test(error.message),
  );
  assert.throws(
    () => runner.run({ ...runOptions, caseCommander: () => "node /bin/true" }),
    (error) => error instanceof PlanError && /invalid in-container command/.test(error.message),
  );
});

function expectedCaseIds() {
  return expandMatrix(manifest).map((entry) => entry.id);
}

test("persistent cleanup failure fails the command and never claims a clean state", () => {
  const leakedTmpPath = path.join(os.tmpdir(), "skill-router-leak", "x");
  const fake = makeFake({
    rmFail: { status: 1, stdout: "", stderr: `daemon error for sk-ant-cleanup-0123456789 at ${leakedTmpPath}`, signal: null, error: null },
  });
  const { runner, output } = makeRunner(fake, { env: { PATH: process.env.PATH ?? "" } });

  assert.throws(
    () => runner.smoke({}),
    (error) => {
      const message = String(error.message);
      assert.ok(/cleanup could not be verified/.test(message), "cleanup failure is aggregated");
      assert.ok(/forced cleanup failed/.test(message), "per-target failure retained and reported");
      assert.ok(!message.includes("sk-ant-cleanup-0123456789"), "sanitized: no credential in cleanup failure");
      assert.ok(!message.includes(os.tmpdir()), "sanitized: no host temp path in cleanup failure");
      assert.ok(message.includes("[tmp]"), "host temp path replaced by placeholder");
      return true;
    },
  );
  const text = output.join("\n");
  assert.ok(!text.includes("cleanup: verified"), "no false cleanup claim without proven absence");
  assert.ok(!/\b0 active\b/.test(text), "no false 0-active claim");
  assert.ok(fake.seen.rms.length >= 2, "cleanup retried (executeRun attempt plus finalize retry)");
});

test("final label sweep discovers and force-removes leftover containers, then verifies absence", () => {
  const leftoverId = "cd".repeat(32);
  const fake = makeFake({ sweepLeftovers: [leftoverId] });
  const { runner, output } = makeRunner(fake);
  const result = runner.smoke({});

  assert.equal(fake.seen.sweeps.length, 2, "list, remove, then re-list");
  assert.ok(fake.seen.sweeps.every((filter) => filter === `label=${LABELS.run}=${result.runId}`), "exact managed run label");
  assert.ok(fake.seen.rms.includes(leftoverId), "leftover container force-removed by id");
  assert.equal(result.sweep.matched, 1);
  assert.equal(result.sweep.verifiedAbsent, true);
  assert.ok(output.some((line) => line.includes("label sweep matched 1")));
});

test("final sweep fails closed when verification still sees leftovers", () => {
  const leftoverId = "ef".repeat(32);
  const fake = makeFake({ sweepLeftovers: [leftoverId], sweepAlwaysLeftovers: true });
  const { runner, output } = makeRunner(fake);
  assert.throws(
    () => runner.smoke({}),
    (error) => /leftover sweep failed verification/.test(String(error.message)) && /remain for run/.test(String(error.message)),
  );
  assert.ok(!output.join("\n").includes("cleanup: verified"), "absence was never proven, so it is never claimed");
});

test("final sweep fails closed when Docker cannot prove absence", () => {
  const fake = makeFake({ psFail: { status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon", signal: null, error: null } });
  const { runner } = makeRunner(fake);
  assert.throws(
    () => runner.smoke({}),
    (error) => /cannot prove absence/.test(String(error.message)),
  );
});

test("smoke executes each harness by immutable image id and validates every report field", () => {
  const fake = makeFake();
  const { runner, output } = makeRunner(fake, {
    env: { PATH: process.env.PATH ?? "", ANTHROPIC_API_KEY: "sk-ant-live-0123456789abcdef" },
  });

  const result = runner.smoke({});
  assert.equal(fake.seen.builds.length, 3);
  assert.equal(fake.seen.runs.length, 3);
  assert.equal(fake.seen.rms.length, 3, "forced cleanup for every smoke container");
  noSecretsIn(fake.seen.records);

  for (const argv of fake.seen.runs) {
    assert.ok(argv.includes("--pull=never"));
    const imageToken = argv.find((token) => token.startsWith("sha256:"));
    assert.match(imageToken ?? "", IMAGE_ID_RE);
    assert.ok(!argv.some((token) => token.startsWith("skill-router/harness:")), "mutable tag never executed");
    assert.ok(argv.includes("--network=none"));
  }

  assert.equal(result.verified.length, 3);
  const byId = Object.fromEntries(result.verified.map((entry) => [entry.harnessId, entry]));
  assert.equal(byId["opencode-v1"].packageVersion, "1.18.34");
  assert.equal(byId["opencode-v2"].binaryVersion, "2.0.24");
  assert.equal(byId.claude.packageVersion, "2.1.291");
  assert.equal(byId.claude.platform.arch, "arm64");
  assert.equal(byId.claude.imageId, IMAGE_IDS.claude);

  const text = output.join("\n");
  assert.ok(text.includes("smoke opencode-v1: ok opencode-ai@1.18.34"));
  assert.ok(text.includes("smoke claude: ok @anthropic-ai/claude-code@2.1.291"));
  assert.ok(text.includes("runtime coverage: linux/arm64 (native daemon architecture only"));
  assert.ok(text.includes("cleanup: verified"), "cleanup claim only after sweep verification");

  assert.equal(existsSync(workdirOf(fake)), false, "smoke temp dir removed in finally");
  assert.deepEqual(runner.janitor.activeNames(), []);
});

test("host-side validation rejects a wrong report field instead of trusting ok=true", () => {
  const tweaks = [
    [(report) => ({ ...report, binaryVersion: "9.9.9" }), /binaryVersion mismatch/],
    [(report) => ({ ...report, packageVersion: "0.0.1" }), /packageVersion mismatch/],
    [(report) => ({ ...report, harnessId: "opencode-v2" }), /harnessId mismatch/],
    [(report) => ({ ...report, uid: 0, nonRoot: false }), /uid mismatch/],
    [(report) => ({ ...report, platform: { os: "linux", arch: "amd64", node: "v22.0.0" } }), /platform.arch mismatch/],
    [(report) => ({ ...report, major: 3 }), /major mismatch/],
  ];
  for (const [tweak, pattern] of tweaks) {
    const fake = makeFake({ reportTweak: tweak });
    const { runner } = makeRunner(fake);
    assert.throws(() => runner.smoke({}), pattern);
    assert.deepEqual(runner.janitor.activeNames(), [], "cleanup still runs when validation fails");
    assert.ok(fake.seen.rms.length >= 1, "container from the failing validation was force-removed");
  }
});

test("host-side image inspection rejects a wrong harness label", () => {
  const fake = makeFake({ labelFor: (harnessId) => (harnessId === "claude" ? "opencode-v1" : harnessId) });
  const { runner } = makeRunner(fake);
  assert.throws(() => runner.build({}), (error) => /image label/.test(error.message) && error.message.includes("claude"));
  assert.equal(fake.seen.runs.length, 0, "no container runs with an untrusted image");
  noSecretsIn(fake.seen.records);
});

test("smoke failure still forces cleanup and removes temp metadata", () => {
  const fake = makeFake({ runFailure: () => true });
  const { runner } = makeRunner(fake);
  assert.throws(() => runner.smoke({}), (error) => {
    assert.ok(!String(error.message).includes("sk-ant-deadbeef0000"), "raw credential text never surfaces");
    assert.ok(/smoke opencode-v1 failed/.test(error.message));
    return true;
  });
  assert.equal(fake.seen.rms.length, 1, "the failed container was force-removed");
  assert.deepEqual(runner.janitor.activeNames(), []);
  assert.equal(existsSync(workdirOf(fake)), false, "temp dir removed after failure");
});

test("staged build context contains exactly the four audited files", () => {
  const stage = tempDir("skill-router-context-");
  const staged = stageBuildContext({ repoRoot, stageDir: stage });
  const expected = ["Dockerfile", "container-verify.mjs", "router-wrapper.mjs", "run-case.mjs"];
  assert.deepEqual(staged.files.sort(), expected, "exactly four audited files are staged");
  assert.equal(staged.files.length, 4, "exactly four files");
  assert.deepEqual(readdirSync(stage).sort(), expected, "no other file reaches the daemon");
  for (const [stagedName, sourceKey] of [
    ["Dockerfile", "dockerfile"],
    ["container-verify.mjs", "verifyScript"],
    ["run-case.mjs", "caseRunner"],
    ["router-wrapper.mjs", "routerWrapper"],
  ]) {
    assert.equal(
      readFileSync(path.join(stage, stagedName), "utf8"),
      readFileSync(path.join(repoRoot, CONTAINER_FILES[sourceKey]), "utf8"),
      `${stagedName} must be an exact copy of ${CONTAINER_FILES[sourceKey]}`,
    );
  }
  // The staged wrapper keeps its shebang, and the staged set contains no
  // repository, HOME, or secret material.
  assert.ok(readFileSync(path.join(stage, "router-wrapper.mjs"), "utf8").startsWith("#!/usr/local/bin/node\n"));
  for (const stagedName of expected) {
    assert.ok(!stagedName.includes(".."), "no path traversal in staged names");
  }
});

test("run rejects an implausibly short present secret before any build or container", () => {
  const fake = makeFake();
  const { runner } = makeRunner(fake, {
    env: { PATH: process.env.PATH ?? "", CLAUDE_CODE_OAUTH_TOKEN: "xyzzy", ...MODEL_ENV },
  });
  assert.throws(
    () => runner.run({ secretEnv: ["CLAUDE_CODE_OAUTH_TOKEN"], executeCases: true }),
    (error) =>
      error instanceof PlanError &&
      /at least 8 characters/.test(error.message) &&
      /requires --secret-env OPENAI_API_KEY/.test(error.message) &&
      !error.message.includes("xyzzy"),
  );
  assert.equal(fake.calls.length, 0, "no subprocess at all");
  assert.equal(fake.seen.builds.length, 0, "no build happened");
  assert.equal(fake.seen.runs.length, 0, "no container ran");
});

test("case reporter receives only the validated sanitized report summary, never raw output", () => {
  const secret = "sk-ant-report-secret-0123456789";
  const fake = makeFake();
  const { runner, output } = makeRunner(fake, {
    env: {
      PATH: process.env.PATH ?? "",
      CLAUDE_CODE_OAUTH_TOKEN: OAUTH_SECRET,
      ANTHROPIC_API_KEY: secret,
      OPENAI_API_KEY: "sk-openai-live-0123456789",
      ...MODEL_ENV,
    },
  });
  const received = [];
  const result = runner.run({
    executeCases: true,
    secretEnv: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
    caseReporter: (summary) => received.push(summary),
  });

  assert.equal(result.executed.length, 7);
  assert.equal(received.length, 7, "reporter invoked once per executed case");
  const allowedKeys = ["artifactSha256", "case", "chain", "container", "harness", "outcome", "scenario", "sessionCount", "skillId"].sort();
  for (const summary of received) {
    assert.deepEqual(Object.keys(summary).sort(), allowedKeys, "reporter payload is exactly the validated field set");
    assert.equal(summary.ok, undefined, "no raw fields on the summary");
    const serialized = JSON.stringify(summary);
    assert.ok(!serialized.includes(secret), "raw credential never reaches the reporter");
    assert.ok(!serialized.includes(OAUTH_SECRET), "the setup token never reaches the reporter");
    assert.ok(!serialized.includes(os.tmpdir()), "host temp path never reaches the reporter");
    assert.ok(!serialized.includes(repoRoot), "repository path never reaches the reporter");
    assert.ok(!serialized.includes(process.env.HOME ?? "__unset__"), "home path never reaches the reporter");
    assert.ok(!/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/.test(serialized), "no request token in the reporter payload");
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(serialized), "no session id in the reporter payload");
  }
  // Raw stdout never surfaces in host output either.
  const printed = output.join("\n");
  assert.ok(!printed.includes(secret), "no credential in host output");
  assert.ok(!printed.includes(OAUTH_SECRET), "the setup token never reaches host output");
  assert.equal(printed.split("\n").filter((line) => line.startsWith("case ") && line.includes(": ok")).length, 7);
});

test("raw or multi-line case stdout fails structurally without echoing content", () => {
  const secret = "sk-ant-raw-stdout-secret-0123456789";
  const fake = makeFake({
    caseOutput: `RAW MODEL TEXT ${secret}\n${JSON.stringify({ ok: true, case: "opencode-v1-select" })}`,
  });
  const { runner } = makeRunner(fake, {
    env: {
      PATH: process.env.PATH ?? "",
      CLAUDE_CODE_OAUTH_TOKEN: OAUTH_SECRET,
      ANTHROPIC_API_KEY: secret,
      OPENAI_API_KEY: "sk-openai-live-0123456789",
      ...MODEL_ENV,
    },
  });

  assert.throws(
    () => runner.run({ executeCases: true, secretEnv: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] }),
    (error) => {
      const message = String(error.message);
      assert.ok(/emitted 2 stdout line\(s\); expected exactly one compact JSON report/.test(message), "structural failure message");
      assert.ok(!message.includes(secret), "raw stdout never echoed");
      assert.ok(!message.includes("RAW MODEL TEXT"), "raw model content never echoed");
      return true;
    },
  );
});

test("JSON audit reports the executed (adapter) argv from final specs, sanitized", () => {
  const oauthValue = "oauth-should-never-leave-the-host-0123456789";
  const fake = makeFake();
  const output = [];
  const runner = createRunner({
    executor: fake.executor,
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH ?? "",
      ...MODEL_ENV,
      ANTHROPIC_API_KEY: "sk-ant-live-0123456789abcdef",
      OPENAI_API_KEY: "sk-openai-live-0123456789",
      CLAUDE_CODE_OAUTH_TOKEN: oauthValue,
    },
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
  });

  const result = runner.run({
    json: true,
    executeCases: true,
    secretEnv: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
    caseCommander: ({ case: caseDescriptor }) => [
      "node",
      "/usr/local/lib/skill-router/adapter.mjs",
      `--case=${caseDescriptor.id}`,
    ],
  });

  const jsonText = output.filter((line) => line.trim().startsWith("{")).join("\n");
  assert.ok(jsonText.length > 0, "json mode emits an audit document");
  const parsed = JSON.parse(jsonText);
  assert.equal(parsed.executed, true, "cases were executed");
  assert.equal(parsed.skipped, null, "nothing was skipped");
  assert.equal(parsed.cases.length, 7);
  assert.equal(parsed.executedCases.length, 7);

  // Preflight evidence: explicit models, notes (e.g. OAuth never used).
  assert.equal(parsed.preflight.models.opencode, MODEL_ENV.SKILL_ROUTER_OPENCODE_MODEL);
  assert.equal(parsed.preflight.models.claude, MODEL_ENV.SKILL_ROUTER_CLAUDE_MODEL);
  assert.ok(parsed.preflight.notes.some((note) => note.includes("CLAUDE_CODE_OAUTH_TOKEN")), "OAuth host state noted as never passed");

  // Freshness invariant: seven unique containers, one case per container.
  const names = parsed.cases.map((entry) => entry.name);
  assert.equal(new Set(names).size, 7, "seven unique container names");
  assert.equal(new Set(parsed.cases.map((entry) => entry.cidfile)).size, 7, "seven unique cidfiles");
  assert.deepEqual(
    parsed.freshness,
    { containers: 7, uniqueContainerNames: 7, uniqueCidfiles: 7, oneCasePerContainer: true },
    "audit proves one case per container with no shared HOME/workspace/session",
  );
  for (const entry of parsed.cases) {
    assert.equal(entry.labels["dev.openagency.skill-router.case"], entry.id, "container label maps to exactly one case");
    assert.equal(entry.artifactMount, parsed.artifact.path, "every case mounts the same locked artifact");
    assert.equal(entry.imageId, parsed.images.find((image) => image.harnessId === entry.labels["dev.openagency.skill-router.harness"]).imageId);
  }

  const adapterCommand = (caseId) => ["node", "/usr/local/lib/skill-router/adapter.mjs", `--case=${caseId}`];
  for (const entry of parsed.cases) {
    const executed = result.executed.find((item) => item.caseId === entry.id);
    assert.ok(executed, `audit entry exists for executed case ${entry.id}`);
    assert.deepEqual(
      entry.argv,
      runSpecToArgv(executed.spec).map((token) => runner.sanitize(token)),
      `audit argv is the sanitized canonical argv of the executed final spec (${entry.id})`,
    );
    assert.deepEqual(entry.argv.slice(-3), adapterCommand(entry.id), "adapter command reported exactly");
    assert.deepEqual(entry.command, adapterCommand(entry.id));
    assert.ok(!entry.argv.join(" ").includes("run-case.mjs"), "pre-adapter default command is never audited");

    // Harness-specific model env is visible in argv, scoped to its harness.
    if (entry.labels["dev.openagency.skill-router.harness"] === "claude") {
      assert.ok(entry.argv.includes(`--env=SKILL_ROUTER_CLAUDE_MODEL=${MODEL_ENV.SKILL_ROUTER_CLAUDE_MODEL}`));
      assert.ok(!entry.argv.some((token) => token.startsWith("--env=SKILL_ROUTER_OPENCODE_MODEL")));
      assert.ok(entry.argv.includes("--env=CLAUDE_CODE_OAUTH_TOKEN"), "Claude argv carries the token name only");
      assert.ok(
        !entry.argv.some((token) => token.startsWith("--env=CLAUDE_CODE_OAUTH_TOKEN=")),
        "the token is never assigned a value in argv",
      );
      assert.ok(!entry.argv.includes("--env=ANTHROPIC_API_KEY"), "Claude argv carries no API key");
    } else {
      assert.ok(entry.argv.includes(`--env=SKILL_ROUTER_OPENCODE_MODEL=${MODEL_ENV.SKILL_ROUTER_OPENCODE_MODEL}`));
      assert.ok(!entry.argv.some((token) => token.startsWith("--env=SKILL_ROUTER_CLAUDE_MODEL")));
      assert.ok(!entry.argv.includes("--env=CLAUDE_CODE_OAUTH_TOKEN"), "OpenCode argv never carries the Claude token");
    }
  }
  for (const executedCase of parsed.executedCases) {
    const executed = result.executed.find((item) => item.caseId === executedCase.caseId);
    assert.deepEqual(executedCase.argv, runSpecToArgv(executed.spec).map((token) => runner.sanitize(token)));
    assert.deepEqual(executedCase.command, adapterCommand(executedCase.caseId));
    assert.equal(executedCase.exitStatus, 0);
    assert.equal(executedCase.report.sessionCount, 1, "report proves a single session");
    assert.equal(executedCase.report.container, executed.spec.name, "report proves the case's own container");
    assert.deepEqual(executedCase.report.chain, expectedCaseChain(executed.spec.harnessId, executedCase.report.scenario));
  }

  // Audit output stays sanitized: no host paths, credentials, or OAuth state.
  assert.ok(!jsonText.includes(repoRoot), "no repository path in audit output");
  assert.ok(!jsonText.includes(os.tmpdir()), "no host temp path in audit output");
  assert.ok(!jsonText.includes(process.env.HOME ?? "__unset__"), "no home path in audit output");
  assert.ok(!jsonText.includes(oauthValue), "OAuth token value never appears in audit output");
  assert.ok(!jsonText.includes("sk-ant-live-0123456789abcdef"), "API key value never appears in audit output");
  const claudeAuditEntries = parsed.cases.filter(
    (entry) => entry.labels["dev.openagency.skill-router.harness"] === "claude",
  );
  assert.equal(claudeAuditEntries.length, 3, "three Claude cases audited");
  assert.ok(
    claudeAuditEntries.every((entry) => entry.argv.includes("--env=CLAUDE_CODE_OAUTH_TOKEN")),
    "the setup token name is audited for Claude cases",
  );
  assert.ok(
    parsed.cases
      .filter((entry) => entry.labels["dev.openagency.skill-router.harness"] !== "claude")
      .every((entry) => !entry.argv.includes("--env=CLAUDE_CODE_OAUTH_TOKEN")),
    "the setup token name never appears in an OpenCode audit entry",
  );
});

/* ------------- OpenCode credential lifecycle (auth remediation) ------------- */

const AUTH_OPENAI_KEY = "sk-real-openai-secret-0123456789abcdef";
const AUTH_GO_KEY = "sk-dummy-opencode-go-000000000000000000";
const AUTH_OPENAI_ACCESS = "sk-real-openai-oauth-access-0123456789";
const AUTH_OPENAI_REFRESH = "sk-real-openai-oauth-refresh-0123456789";
const AUTH_ACCOUNT_LABEL = "acct_dummy_000000";
const AUTH_HOST_VALUES = [AUTH_OPENAI_KEY, AUTH_GO_KEY, AUTH_OPENAI_ACCESS, AUTH_OPENAI_REFRESH, AUTH_ACCOUNT_LABEL];
const AUTH_DESTINATION = "/input/opencode-credential";
const AUTH_MOUNT_PREFIX = `--mount=type=bind,src=`;

/** API credentials for both supported providers: valid for the full four-case
 * OpenCode selection with an `openai/*` model. */
function writeHostAuthFile() {
  const dir = tempDir("skill-router-host-auth-");
  const file = path.join(dir, "auth.json");
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        openai: { type: "api", key: AUTH_OPENAI_KEY, metadata: { accountID: AUTH_ACCOUNT_LABEL } },
        "opencode-go": { type: "api", key: AUTH_GO_KEY },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  chmodSync(file, 0o600);
  return file;
}

/** Mixed document: `openai` is OAuth, `opencode-go` is API — used to prove the
 * snapshot carries only the selected provider. */
function writeMixedAuthFile() {
  const dir = tempDir("skill-router-mixed-auth-");
  const file = path.join(dir, "auth.json");
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        openai: {
          type: "oauth",
          accessToken: AUTH_OPENAI_ACCESS,
          refreshToken: AUTH_OPENAI_REFRESH,
          expiresAt: 4102444800000,
          account_id: AUTH_ACCOUNT_LABEL,
        },
        "opencode-go": { type: "api", key: AUTH_GO_KEY },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  chmodSync(file, 0o600);
  return file;
}

function authRunEnv() {
  return {
    PATH: process.env.PATH ?? "",
    ...MODEL_ENV,
    CLAUDE_CODE_OAUTH_TOKEN: OAUTH_SECRET,
  };
}

function credentialDirOf(fake) {
  return path.join(workdirOf(fake), "opencode-credential");
}

function authRunner(fake, extra = {}) {
  const output = [];
  const runner = createRunner({
    executor: fake.executor,
    cwd: repoRoot,
    env: authRunEnv(),
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
    opencodeAuthFile: extra.opencodeAuthFile,
    ...extra,
  });
  return { runner, output };
}

test("OpenCode cases mount only the lifecycle credential directory; Claude cases never do; it is removed", () => {
  const hostAuth = writeHostAuthFile();
  const originalBytes = readFileSync(hostAuth);
  const fake = makeFake();

  // Capture what the mounted directory contains while containers are running.
  const credentialListing = [];
  const output = [];
  const runner = createRunner({
    executor: (argv, options) => {
      if (isContainerRun(argv) && credentialListing.length === 0) {
        const dir = credentialDirOf(fake);
        if (existsSync(dir)) credentialListing.push(...readdirSync(dir).sort());
      }
      return fake.executor(argv, options);
    },
    cwd: repoRoot,
    env: authRunEnv(),
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
    opencodeAuthFile: hostAuth,
  });

  const result = runner.run({ executeCases: true, secretEnv: ["CLAUDE_CODE_OAUTH_TOKEN"] });
  assert.equal(result.executed.length, 7, "API credentials satisfy every OpenCode case");
  assert.deepEqual(
    credentialListing,
    ["auth-import.json", "auth.json"],
    "the mounted directory holds exactly the legacy and generated import files while containers run",
  );

  const credentialDir = credentialDirOf(fake);
  let openCodeRuns = 0;
  for (const argv of fake.seen.runs) {
    const joined = argv.join(" ");
    const claude = argv.includes(`--label=${LABELS.harness}=claude`);
    const authMounts = argv.filter((token) => token.includes(`dst=${AUTH_DESTINATION}`));
    if (claude) {
      assert.deepEqual(authMounts, [], "Claude case never receives the credential bind");
      assert.ok(!joined.includes("opencode-credential"), "Claude argv never references a credential path");
    } else {
      openCodeRuns += 1;
      assert.equal(authMounts.length, 1, "exactly one credential bind");
      assert.equal(authMounts[0], `${AUTH_MOUNT_PREFIX}${credentialDir},dst=${AUTH_DESTINATION},readonly`);
      assert.ok(authMounts[0].endsWith(",readonly"));
    }
    assert.ok(!joined.includes(hostAuth), "the original auth file is never mounted");
    for (const value of AUTH_HOST_VALUES) assert.ok(!joined.includes(value), "values never reach argv");
  }
  assert.equal(openCodeRuns, 4, "the four OpenCode cases carry the bind");

  for (const executed of result.executed) {
    if (executed.spec.harnessId === "claude") {
      assert.equal(executed.spec.auth, null, `${executed.caseId} carries no auth field`);
    } else {
      assert.ok(executed.spec.auth, `${executed.caseId} carries the auth field`);
      assert.equal(executed.spec.auth.src, credentialDir, "sourced from this lifecycle's credential directory");
      assert.equal(executed.spec.auth.dst, AUTH_DESTINATION, "at the fixed destination");
      assert.notEqual(executed.spec.auth.src, hostAuth, "never the original file");
    }
  }

  // The original is untouched and the credentials are gone with the lifecycle.
  assert.deepEqual(readFileSync(hostAuth), originalBytes, "the original file is byte-identical");
  assert.equal(statSync(hostAuth).mode & 0o7777, 0o600, "the original keeps its owner-only mode");
  assert.equal(existsSync(credentialDir), false, "credential directory removed");
  assert.equal(existsSync(workdirOf(fake)), false, "lifecycle temp dir removed");

  const printed = output.join("\n");
  assert.ok(printed.includes("auth snapshot"), "the snapshot note is printed");
  assert.ok(!printed.includes(hostAuth), "the original path never reaches output");
  assert.ok(!printed.includes("opencode-credential"), "the credential directory never reaches output");
  for (const value of AUTH_HOST_VALUES) assert.ok(!printed.includes(value), "values never reach output");
  assert.equal(printed.split("\n").filter((line) => line.startsWith("case ") && line.includes(": ok")).length, 7);
});

test("--keep retains the lifecycle workdir but never the credential directory", () => {
  const hostAuth = writeHostAuthFile();
  const fake = makeFake();
  const { runner } = authRunner(fake, { opencodeAuthFile: hostAuth });
  try {
    runner.run({ executeCases: true, secretEnv: ["CLAUDE_CODE_OAUTH_TOKEN"], keepWorkdir: true });
    const workdir = workdirOf(fake);
    const credentialDir = path.join(workdir, "opencode-credential");
    assert.equal(existsSync(workdir), true, "non-secret lifecycle artifacts may be retained");
    assert.equal(existsSync(credentialDir), false, "credential directory removed anyway");
    assert.equal(existsSync(path.join(credentialDir, "auth.json")), false, "legacy file removed anyway");
    assert.equal(existsSync(path.join(credentialDir, "auth-import.json")), false, "import file removed anyway");
  } finally {
    rmSync(workdirOf(fake), { recursive: true, force: true });
  }
});

test("execution and container-cleanup failures still remove the credential directory", () => {
  // Execution failure: malformed case output.
  {
    const hostAuth = writeHostAuthFile();
    const fake = makeFake({ caseOutput: `RAW OUTPUT\n${JSON.stringify({ ok: true })}` });
    const { runner } = authRunner(fake, { opencodeAuthFile: hostAuth });
    try {
      assert.throws(
        () => runner.run({ executeCases: true, secretEnv: ["CLAUDE_CODE_OAUTH_TOKEN"], keepWorkdir: true }),
        /emitted 2 stdout line/,
      );
      assert.equal(existsSync(path.join(workdirOf(fake), "opencode-credential")), false, "removed after execution failure");
      assert.equal(existsSync(workdirOf(fake)), true, "workdir retained by --keep");
    } finally {
      rmSync(workdirOf(fake), { recursive: true, force: true });
    }
  }

  // Container-cleanup failure: `docker rm -f` keeps failing.
  {
    const hostAuth = writeHostAuthFile();
    const fake = makeFake({
      rmFail: { status: 1, stdout: "", stderr: "daemon error for sk-ant-cleanup-0123456789", signal: null, error: null },
    });
    const { runner, output } = authRunner(fake, { opencodeAuthFile: hostAuth });
    try {
      assert.throws(
        () => runner.run({ executeCases: true, secretEnv: ["CLAUDE_CODE_OAUTH_TOKEN"], keepWorkdir: true }),
        (error) => {
          const message = String(error.message);
          assert.ok(/cleanup could not be verified/.test(message), "cleanup failure is a hard failure");
          assert.ok(
            /leftover container may still hold the already-mounted credential inode/.test(message),
            "the unverified mounted-inode risk is stated",
          );
          assert.ok(!message.includes(hostAuth), "the original path is never echoed");
          for (const value of AUTH_HOST_VALUES) assert.ok(!message.includes(value), "values are never echoed");
          return true;
        },
      );
      const printed = output.join("\n");
      assert.ok(!printed.includes("cleanup: verified"), "absence is never claimed when cleanup failed");
      const workdir = workdirOf(fake);
      assert.equal(existsSync(path.join(workdir, "opencode-credential")), false, "removed despite cleanup failure");
      assert.equal(existsSync(workdir), true, "workdir retained by --keep");
    } finally {
      rmSync(workdirOf(fake), { recursive: true, force: true });
    }
  }

  // Executor failure while a container still exists: containers are removed
  // first, then the credentials are scrubbed, and no clean state is claimed.
  {
    const hostAuth = writeHostAuthFile();
    const fake = makeFake({ runFailure: () => true });
    const { runner } = authRunner(fake, { opencodeAuthFile: hostAuth });
    try {
      assert.throws(
        () => runner.run({ executeCases: true, secretEnv: ["CLAUDE_CODE_OAUTH_TOKEN"], keepWorkdir: true }),
        /smoke opencode-v1 failed|case opencode-v1-select failed/,
      );
      const workdir = workdirOf(fake);
      assert.equal(fake.seen.rms.length >= 1, true, "containers were force-removed before the scrub");
      assert.equal(existsSync(path.join(workdir, "opencode-credential")), false, "credentials scrubbed afterwards");
      assert.equal(existsSync(workdir), true, "workdir retained by --keep");
    } finally {
      rmSync(workdirOf(fake), { recursive: true, force: true });
    }
  }
});

test("a credential directory removal failure is a hard failure that never claims clean", () => {
  const hostAuth = writeHostAuthFile();
  const fake = makeFake();
  const lines = [];
  const runner = createRunner({
    executor: fake.executor,
    cwd: repoRoot,
    env: authRunEnv(),
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
    opencodeAuthFile: hostAuth,
    removeDir: (target, options) => {
      if (String(target).includes("opencode-credential")) {
        throw Object.assign(new Error("EACCES: credential directory is busy"), { code: "EACCES" });
      }
      return rmSync(target, options);
    },
  });
  let workdir = null;
  try {
    assert.throws(
      () => runner.run({ executeCases: true, secretEnv: ["CLAUDE_CODE_OAUTH_TOKEN"], keepWorkdir: true }),
      (error) => {
        const message = String(error.message);
        assert.ok(/credential snapshot could not be removed/.test(message), "credential removal failure is reported");
        assert.ok(message.includes("EACCES"), "the underlying reason is retained");
        assert.ok(!message.includes(hostAuth), "the original path is never echoed");
        return true;
      },
    );
    workdir = workdirOf(fake);
    const printed = lines.join("\n");
    assert.ok(!printed.includes("cleanup: verified"), "a failed credential cleanup is never reported as clean");
    assert.equal(existsSync(path.join(workdir, "opencode-credential")), true, "the failing directory is what failed");
  } finally {
    if (workdir) rmSync(workdir, { recursive: true, force: true });
  }
});

test("an interrupt during a live container removes the credential directory (best effort)", () => {
  const hostAuth = writeHostAuthFile();
  const fake = makeFake();
  const handlers = new Map();
  const exits = [];
  const processRef = {
    on: (signal, handler) => handlers.set(signal, handler),
    removeListener: (signal) => handlers.delete(signal),
    exit: (code) => exits.push(code),
  };
  let fired = false;
  const runner = createRunner({
    executor: (argv, options) => {
      if (!fired && isContainerRun(argv)) {
        fired = true;
        handlers.get("SIGINT")?.();
      }
      return fake.executor(argv, options);
    },
    cwd: repoRoot,
    env: authRunEnv(),
    processRef,
    stdout: () => {},
    stderr: () => {},
    opencodeAuthFile: hostAuth,
  });
  let workdir = null;
  try {
    assert.throws(() =>
      runner.run({ executeCases: true, secretEnv: ["CLAUDE_CODE_OAUTH_TOKEN"], keepWorkdir: true }),
    );
    workdir = workdirOf(fake);
    assert.ok(fired, "the interruption was triggered during a live container run");
    assert.deepEqual(exits, [130], "the interrupt handler exits with 130");
    assert.equal(existsSync(workdir), true, "workdir retained by --keep");
    assert.equal(existsSync(path.join(workdir, "opencode-credential")), false, "credential directory removed on interrupt");
  } finally {
    if (workdir) rmSync(workdir, { recursive: true, force: true });
  }
});

test("the lifecycle signal lease survives container cleanup and is only released at finalization", () => {
  const scrubbed = [];
  const handlers = new Map();
  const exits = [];
  const processRef = {
    on: (signal, handler) => handlers.set(signal, handler),
    removeListener: (signal) => handlers.delete(signal),
    exit: (code) => exits.push(code),
  };
  const fake = makeFake();
  const janitor = createJanitor({
    executor: fake.executor,
    env: {},
    cwd: repoRoot,
    processRef,
    onInterrupt: () => scrubbed.push("credential-scrub"),
  });
  const cid = path.join(tempDir("skill-router-lease-"), "lease.cid");
  writeFileSync(cid, `${FAKE_CONTAINER_ID}\n`);

  assert.deepEqual(janitor.signalNames(), [], "no handlers by construction");
  assert.equal(janitor.hasLease(), false, "no lease by construction");

  // The runner takes the lease before credential creation and pack/build,
  // with zero containers tracked.
  janitor.arm();
  assert.equal(janitor.hasLease(), true, "lease held");
  assert.deepEqual(janitor.signalNames().sort(), ["SIGHUP", "SIGINT", "SIGTERM"], "armed with no container tracked");

  // Between sequential cases: after a container's cleanup the count is zero,
  // but the lease keeps the handlers armed.
  janitor.track("lease-case-1", cid);
  assert.deepEqual(janitor.activeNames(), ["lease-case-1"]);
  const cleaned = janitor.cleanup("lease-case-1", cid);
  assert.equal(cleaned.ok, true);
  assert.deepEqual(janitor.activeNames(), [], "container cleaned");
  assert.equal(janitor.hasLease(), true, "lease is unaffected by container count");
  assert.deepEqual(
    janitor.signalNames().sort(),
    ["SIGHUP", "SIGINT", "SIGTERM"],
    "handlers stay armed between sequential cases",
  );

  // The next case can be tracked again under the same lease.
  janitor.track("lease-case-2", cid);
  assert.deepEqual(janitor.signalNames().sort(), ["SIGHUP", "SIGINT", "SIGTERM"]);
  janitor.cleanup("lease-case-2", cid);
  assert.deepEqual(janitor.activeNames(), []);
  assert.deepEqual(
    janitor.signalNames().sort(),
    ["SIGHUP", "SIGINT", "SIGTERM"],
    "handlers stay armed after the final container, before finalization",
  );

  // An interrupt in that window still scrubs credentials and exits.
  handlers.get("SIGINT")();
  assert.deepEqual(scrubbed, ["credential-scrub"], "the credential scrub runs on interrupt");
  assert.deepEqual(exits, [130], "the interrupt exits with 130");
  assert.deepEqual(
    janitor.signalNames().sort(),
    ["SIGHUP", "SIGINT", "SIGTERM"],
    "the lease is still held during interruption handling",
  );

  // Normal release at finalization: handlers dropped, no leak.
  janitor.disarm();
  assert.equal(janitor.hasLease(), false, "lease released");
  assert.deepEqual(janitor.signalNames(), [], "handlers released at finalization");
  scrubbed.length = 0;
  assert.deepEqual(scrubbed, [], "no further callbacks after release");
});

test("without a lifecycle lease, an idle janitor still drops its handlers (no leak)", () => {
  const handlers = new Map();
  const processRef = {
    on: (signal, handler) => handlers.set(signal, handler),
    removeListener: (signal) => handlers.delete(signal),
    exit: () => {},
  };
  const fake = makeFake();
  const janitor = createJanitor({
    executor: fake.executor,
    env: {},
    cwd: repoRoot,
    processRef,
    onInterrupt: () => {},
  });
  const cid = path.join(tempDir("skill-router-nolease-"), "nolease.cid");
  writeFileSync(cid, `${FAKE_CONTAINER_ID}\n`);

  janitor.track("nolease-case", cid);
  assert.equal(handlers.size, 3, "tracked container arms handlers");
  janitor.cleanup("nolease-case", cid);
  assert.equal(handlers.size, 0, "idle without a lease drops handlers");
  assert.equal(janitor.hasLease(), false);
});

test("an interrupt during pack — before any container exists — still removes the credentials", () => {
  const hostAuth = writeHostAuthFile();
  const fake = makeFake();
  const handlers = new Map();
  const exits = [];
  const processRef = {
    on: (signal, handler) => handlers.set(signal, handler),
    removeListener: (signal) => handlers.delete(signal),
    exit: (code) => exits.push(code),
  };
  let fired = false;
  let armedAtPack = null;
  const runner = createRunner({
    executor: (argv, options) => {
      if (!fired && argv[0] === "npm" && argv[1] === "pack") {
        fired = true;
        armedAtPack = handlers.size;
        handlers.get("SIGINT")?.();
      }
      return fake.executor(argv, options);
    },
    cwd: repoRoot,
    env: authRunEnv(),
    processRef,
    stdout: () => {},
    stderr: () => {},
    opencodeAuthFile: hostAuth,
  });
  let workdir = null;
  try {
    runner.run({ executeCases: true, secretEnv: ["CLAUDE_CODE_OAUTH_TOKEN"], keepWorkdir: true });
    workdir = workdirOf(fake);
    assert.ok(fired, "the interruption was triggered during npm pack");
    assert.equal(armedAtPack, 3, "handlers were already armed before pack/build started");
    assert.deepEqual(exits, [130], "the interrupt handler exits with 130");
    assert.equal(existsSync(workdir), true, "workdir retained by --keep");
    assert.equal(
      existsSync(path.join(workdir, "opencode-credential")),
      false,
      "credential directory removed even though no container ever ran",
    );
    assert.deepEqual(
      runner.janitor.signalNames(),
      [],
      "handlers are not left armed after finalization",
    );
  } finally {
    if (workdir) rmSync(workdir, { recursive: true, force: true });
  }
});

test("the JSON audit reports only a neutral auth mode and provider ids", () => {
  const hostAuth = writeHostAuthFile();
  const fake = makeFake();
  const output = [];
  const runner = createRunner({
    executor: fake.executor,
    cwd: repoRoot,
    env: authRunEnv(),
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
    opencodeAuthFile: hostAuth,
  });
  runner.run({ json: true, executeCases: true, secretEnv: ["CLAUDE_CODE_OAUTH_TOKEN"] });

  const jsonText = output.filter((line) => line.trim().startsWith("{")).join("\n");
  assert.ok(jsonText.length > 0, "json mode emits an audit document");
  const parsed = JSON.parse(jsonText);

  assert.deepEqual(Object.keys(parsed.auth).sort(), ["mode", "providers"], "auth metadata is exactly mode + provider ids");
  assert.equal(parsed.auth.mode, "snapshot");
  assert.deepEqual(parsed.auth.providers, ["openai"], "only the selected (mounted) provider is reported");
  assert.ok(parsed.preflight.notes.some((note) => note.includes("auth snapshot")), "the transport is documented");

  // Nothing about the file itself may appear: no host path, hash, account
  // label, or value — the legacy path, the import path, and the credential
  // directory all render as placeholders (the fixed container destination is
  // a public constant and is expected to be visible).
  const credentialDir = credentialDirOf(fake);
  for (const needle of [
    hostAuth,
    credentialDir,
    path.join(credentialDir, "auth.json"),
    path.join(credentialDir, "auth-import.json"),
    "acct_dummy_000000",
    ...AUTH_HOST_VALUES,
  ]) {
    assert.ok(!jsonText.includes(needle), `audit leaked: ${needle}`);
  }
  // The auth object itself carries no hash field, and image ids (`sha256:…`)
  // are the only hashes allowed anywhere in the audit.
  assert.deepEqual(Object.keys(parsed.auth).sort(), ["mode", "providers"]);

  const openCodeCase = parsed.cases.find((entry) => entry.labels["dev.openagency.skill-router.harness"] !== "claude");
  const claudeCase = parsed.cases.find((entry) => entry.labels["dev.openagency.skill-router.harness"] === "claude");
  assert.ok(
    openCodeCase.argv.some(
      (token) => token === `--mount=type=bind,src=[opencode-auth-dir],dst=${AUTH_DESTINATION},readonly`,
    ),
    "the credential directory renders as a placeholder in audit argv",
  );
  assert.ok(!claudeCase.argv.some((token) => token.includes(AUTH_DESTINATION)), "Claude audit argv has no credential mount");
  assert.equal(existsSync(credentialDir), false, "credentials removed before the audit is printed");
});

test("case failures render the credential directory as a placeholder and never echo values", () => {
  const hostAuth = writeHostAuthFile();
  const fake = makeFake({ runFailure: () => true });
  const { runner } = authRunner(fake, { opencodeAuthFile: hostAuth });
  let workdir = null;
  try {
    assert.throws(
      () => runner.run({ executeCases: true, secretEnv: ["CLAUDE_CODE_OAUTH_TOKEN"], keepWorkdir: true }),
      (error) => {
        const message = String(error.message);
        assert.ok(message.includes(`src=[opencode-auth-dir]`), "the credential directory renders as a placeholder");
        assert.ok(!message.includes(workdirOf(fake)), "the host credential path is never printed");
        assert.ok(!message.includes(hostAuth), "the original path is never printed");
        assert.ok(!message.includes("auth-import.json"), "credential file names never leave the container boundary");
        for (const value of AUTH_HOST_VALUES) assert.ok(!message.includes(value), "values are never printed");
        return true;
      },
    );
    workdir = workdirOf(fake);
    assert.equal(existsSync(path.join(workdir, "opencode-credential")), false, "removed after the failure");
  } finally {
    if (workdir) rmSync(workdir, { recursive: true, force: true });
  }
});

test("auth-check executes the credential-free fake-auth validation and removes its credentials", () => {
  const fake = makeFake();
  const credentialListing = [];
  const output = [];
  const runner = createRunner({
    executor: (argv, options) => {
      if (isContainerRun(argv) && credentialListing.length === 0) {
        const dir = path.join(workdirOf(fake), "opencode-credential");
        if (existsSync(dir)) credentialListing.push(...readdirSync(dir).sort());
      }
      return fake.executor(argv, options);
    },
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? "" },
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
  });

  const result = runner.authCheck({});
  assert.equal(result.verified.length, 2, "both pinned OpenCode images are checked");
  for (const entry of result.verified) {
    assert.deepEqual(entry.providers, ["openai", "opencode-go"]);
    assert.equal(entry.recognition, "listed", "both images must prove a real listing");
  }
  assert.deepEqual(
    credentialListing,
    ["auth-import.json", "auth.json"],
    "the mounted directory holds exactly the two generated credential files (no staging source)",
  );
  assert.equal(fake.seen.runs.length, 2, "one fresh container per OpenCode harness");
  for (const argv of fake.seen.runs) {
    assert.ok(argv.includes("--network=none"), "no network access is possible");
    assert.ok(argv.includes("--check-opencode-auth"));
    assert.equal(argv.filter((token) => token.includes(`dst=${AUTH_DESTINATION}`)).length, 1);
    assert.ok(argv.some((token) => /^sha256:[0-9a-f]{64}$/.test(token)), "immutable image id");
    assert.ok(!argv.some((token) => token.startsWith("--env=CLAUDE_CODE_OAUTH_TOKEN")));
    assert.ok(!argv.some((token) => token.includes("sk-dummy")), "dummy values never reach argv");
  }
  noSecretsIn(fake.seen.records);
  assert.equal(existsSync(path.join(workdirOf(fake), "opencode-credential")), false, "generated credentials removed");

  const printed = output.join("\n");
  assert.ok(printed.includes("auth-check opencode-v1: ok"));
  assert.ok(printed.includes("auth-check opencode-v2: ok"));
  assert.equal(printed.split("\n").filter((line) => line.includes("recognition=listed")).length, 2, "both verdicts are listed");
  assert.ok(!printed.includes("recognition=staged"), "no staged verdict exists anymore");
  assert.ok(printed.includes("cleanup: verified"));
  assert.ok(!printed.includes("sk-dummy"), "dummy values never reach output");
});

test("auth-check --keep retains the workdir but never the generated credential directory", () => {
  const fake = makeFake();
  const { runner } = makeRunner(fake, {});
  try {
    runner.authCheck({ keepWorkdir: true });
    const workdir = workdirOf(fake);
    assert.equal(existsSync(workdir), true, "workdir retained by --keep");
    assert.equal(existsSync(path.join(workdir, "opencode-credential")), false, "credential directory removed anyway");
  } finally {
    rmSync(workdirOf(fake), { recursive: true, force: true });
  }
});

test("auth-check dry-run and JSON output stay credential-free and never execute", () => {
  const lines = [];
  const runner = createRunner({
    executor: () => {
      throw new Error("dry run must not execute");
    },
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? "" },
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
  });

  const plans = runner.authCheck({ dryRun: true });
  assert.deepEqual(plans.map((entry) => entry.harnessId), ["opencode-v1", "opencode-v2"]);
  const text = lines.join("\n");
  assert.ok(text.includes("--network=none"));
  assert.ok(text.includes("never a real host credential"));
  assert.ok(!text.includes(repoRoot), "no repository path");
  assert.ok(!text.includes("sk-dummy"), "no dummy values");

  lines.length = 0;
  const jsonPlans = runner.authCheck({ dryRun: true, json: true });
  assert.equal(jsonPlans.length, 2);
  const parsed = JSON.parse(lines.filter((line) => line.trim().startsWith("{")).join("\n"));
  assert.equal(parsed.executed, false);
  assert.deepEqual(parsed.providers, ["openai", "opencode-go"]);
  assert.equal(parsed.commands.length, 2);
  for (const command of parsed.commands) {
    assert.ok(command.argv.some((token) => token.startsWith("--mount=type=bind,src=[tmp]/")), "paths render as placeholders");
    assert.ok(!command.argv.some((token) => token.includes(repoRoot)));
  }
});

test("a mixed auth file snapshots and imports only the selected opencode-go provider", () => {
  const mixed = writeMixedAuthFile();
  const fake = makeFake();
  const captured = {};
  const output = [];
  const runner = createRunner({
    executor: (argv, options) => {
      if (isContainerRun(argv) && !captured.dir) {
        const dir = path.join(workdirOf(fake), "opencode-credential");
        if (existsSync(dir)) {
          captured.dir = dir;
          captured.legacy = readFileSync(path.join(dir, "auth.json"), "utf8");
          captured.importFile = readFileSync(path.join(dir, "auth-import.json"), "utf8");
        }
      }
      return fake.executor(argv, options);
    },
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? "", SKILL_ROUTER_OPENCODE_MODEL: "opencode-go/some-model" },
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
    opencodeAuthFile: mixed,
  });

  const result = runner.run({ harnessIds: ["opencode-v1", "opencode-v2"], secretEnv: [], json: true });
  assert.equal(result.executed.length, 4, "the full four-case OpenCode selection ran");

  // Both mounted files carry exactly the selected provider — no unrelated
  // entries, values, or labels.
  assert.ok(captured.legacy, "the credential directory existed while containers ran");
  const legacy = JSON.parse(captured.legacy);
  const importFile = JSON.parse(captured.importFile);
  assert.deepEqual(Object.keys(legacy), ["opencode-go"], "legacy snapshot is provider-filtered");
  assert.equal(legacy["opencode-go"].type, "api");
  assert.deepEqual(importFile.map((entry) => entry.integrationID), ["opencode-go"], "import array is provider-filtered");
  assert.equal(importFile.length, 1);
  assert.equal(importFile[0].label, "API key");
  assert.equal(importFile[0].value.type, "key");
  for (const text of [captured.legacy, captured.importFile]) {
    assert.ok(!text.includes("openai"), "no OpenAI provider id in either file");
    assert.ok(!text.includes('"OAuth"'), "no unrelated label");
    for (const value of [AUTH_OPENAI_KEY, AUTH_OPENAI_ACCESS, AUTH_OPENAI_REFRESH, AUTH_ACCOUNT_LABEL]) {
      assert.ok(!text.includes(value), "no unrelated OpenAI secret or account label");
    }
  }

  for (const argv of fake.seen.runs) {
    assert.equal(argv.filter((token) => token.includes(`dst=${AUTH_DESTINATION}`)).length, 1, "one credential mount per case");
  }

  // Audit: neutral mode + the single selected provider, no OpenAI material.
  const jsonText = output.filter((line) => line.trim().startsWith("{")).join("\n");
  const parsed = JSON.parse(jsonText);
  assert.deepEqual(parsed.auth, { mode: "snapshot", providers: ["opencode-go"] });
  for (const needle of [mixed, AUTH_OPENAI_KEY, AUTH_OPENAI_ACCESS, AUTH_OPENAI_REFRESH, AUTH_ACCOUNT_LABEL]) {
    assert.ok(!jsonText.includes(needle), `audit leaked: ${needle}`);
  }
  assert.equal(existsSync(captured.dir), false, "credentials scrubbed");
  assert.equal(existsSync(workdirOf(fake)), false, "temp dir removed");
});

test("an env-backed OpenCode run never reads, creates, or mounts a credential snapshot", () => {
  const missing = path.join(tempDir("skill-router-env-auth-"), "must-not-be-read.json");
  const fake = makeFake();
  const output = [];
  const runner = createRunner({
    executor: fake.executor,
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH ?? "",
      ...MODEL_ENV,
      OPENAI_API_KEY: "sk-openai-live-0123456789",
      CLAUDE_CODE_OAUTH_TOKEN: OAUTH_SECRET,
    },
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
    opencodeAuthFile: missing, // reading this would fail the run
  });

  const result = runner.run({
    json: true,
    executeCases: true,
    secretEnv: ["CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY"],
  });
  assert.equal(result.executed.length, 7, "env mode still executes every case");

  // No snapshot directory, no credential mount anywhere.
  assert.equal(existsSync(path.join(workdirOf(fake), "opencode-credential")), false, "no snapshot directory created");
  for (const argv of fake.seen.runs) {
    assert.ok(!argv.some((token) => token.includes(`dst=${AUTH_DESTINATION}`)), "no credential mount in env mode");
  }

  const jsonText = output.filter((line) => line.trim().startsWith("{")).join("\n");
  const parsed = JSON.parse(jsonText);
  assert.deepEqual(Object.keys(parsed.auth).sort(), ["mode", "providers"], "auth metadata stays neutral");
  assert.deepEqual(parsed.auth, { mode: "environment", providers: ["openai"] }, "env mode + provider only");
  assert.ok(!jsonText.includes(missing), "the auth file path never appears");
  assert.ok(!jsonText.includes("opencode-credential"), "no credential directory in the audit");
  assert.ok(!jsonText.includes("sk-openai-live-0123456789"), "the mapped key value never appears");
  assert.equal(existsSync(workdirOf(fake)), false, "temp dir removed");
});

test("the signal lease stays held across every case window until finalization", () => {
  const hostAuth = writeHostAuthFile();
  const fake = makeFake();
  const handlers = new Map();
  const processRef = {
    on: (signal, handler) => handlers.set(signal, handler),
    removeListener: (signal) => handlers.delete(signal),
    exit: () => {},
  };
  const handlerCounts = [];
  const runner = createRunner({
    executor: fake.executor,
    cwd: repoRoot,
    env: authRunEnv(),
    processRef,
    stdout: () => {},
    stderr: () => {},
    opencodeAuthFile: hostAuth,
  });

  runner.run({
    executeCases: true,
    secretEnv: ["CLAUDE_CODE_OAUTH_TOKEN"],
    // `caseReporter` runs after the container is cleaned up and the report is
    // parsed — exactly the windows the lease must cover.
    caseReporter: () => handlerCounts.push(handlers.size),
  });
  assert.equal(handlerCounts.length, 7, "one report per case");
  assert.deepEqual(
    handlerCounts,
    new Array(7).fill(3),
    "handlers stay armed between cases, during/after report parsing, and after the last case",
  );
  assert.equal(runner.janitor.hasLease(), false, "lease released at finalization");
  assert.deepEqual(runner.janitor.signalNames(), [], "no handler leak after finalization");
});

test("an unprovable sweep never claims cleanup and states the mounted-inode risk", () => {
  const hostAuth = writeHostAuthFile();
  const fake = makeFake({
    psFail: { status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon", signal: null, error: null },
  });
  const { runner, output } = authRunner(fake, { opencodeAuthFile: hostAuth });
  let workdir = null;
  try {
    assert.throws(
      () => runner.run({ executeCases: true, secretEnv: ["CLAUDE_CODE_OAUTH_TOKEN"], keepWorkdir: true }),
      (error) => {
        const message = String(error.message);
        assert.ok(/cleanup could not be verified/.test(message), "cleanup is never verified");
        assert.ok(/cannot prove absence|leftover sweep/.test(message), "the sweep failure is reported");
        assert.ok(
          /leftover container may still hold the already-mounted credential inode/.test(message),
          "the unverified mounted-inode risk is stated",
        );
        assert.ok(/Docker daemon and its administrators are trusted/.test(message), "daemon trust limit is stated");
        assert.ok(!message.includes(hostAuth), "the original path is never echoed");
        for (const value of AUTH_HOST_VALUES) assert.ok(!message.includes(value), "values are never echoed");
        return true;
      },
    );
    workdir = workdirOf(fake);
    const printed = output.join("\n");
    assert.ok(!printed.includes("cleanup: verified"), "absence is never claimed when it was not proven");
    assert.equal(existsSync(path.join(workdir, "opencode-credential")), false, "host credentials scrubbed best-effort");
  } finally {
    if (workdir) rmSync(workdir, { recursive: true, force: true });
  }
});
