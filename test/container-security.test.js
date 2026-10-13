import assert from "node:assert/strict";
import { chmodSync, existsSync, fstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRunner, repoRoot } from "../scripts/container-harness.mjs";
import {
  LABELS,
  MIN_SECRET_LENGTH,
  OPENCODE_AUTH_MAX_BYTES,
  OPENCODE_AUTH_SUPPORTED_PROVIDERS,
  PULL_POLICY,
  PlanError,
  RUNTIME,
  TMPFS,
  assertNetwork,
  assertSafeRunArgv,
  assertSafeRunSpec,
  assertSecretValuesUsable,
  buildOpenCodeImportEntries,
  collectOpenCodeAuthValues,
  collectSecretValues,
  containerRunEnv,
  createOpenCodeAuthSnapshot,
  createSafeHostEnv,
  createSanitizer,
  dummyOpenCodeAuthBytes,
  expandMatrix,
  formatCommandFailure,
  loadMatrix,
  loadPackageMetadata,
  newRunId,
  openCodeCredentialId,
  parseOpenCodeAuthDocument,
  planBuild,
  planCaseRun,
  planMatrix,
  planSmoke,
  resolveOpenCodeAuthFile,
  resolveSecretEnvNames,
} from "../scripts/container-lib.mjs";

const manifest = loadMatrix(repoRoot);
const packageMetadata = loadPackageMetadata(repoRoot);
const SECRET_NAME = "ANTHROPIC_API_KEY";
const SECRET_VALUE = "sk-ant-unit-test-secret-0123456789";
/** `claude setup-token` credential shape used across the Claude tests. */
const OAUTH_NAME = "CLAUDE_CODE_OAUTH_TOKEN";
const OAUTH_VALUE = "sk-ant-oat01-unit-test-token-0123456789";
/** Keyword-free credential value: only value-based redaction can remove it. */
const OPAQUE_OAUTH_VALUE = "zzqxjvutsonmlkjihgfedcba9876543210";
const SYNTHETIC_CONTEXT = "/tmp/skill-router-container-plan/context";
const SYNTHETIC_IID = "/tmp/skill-router-container-plan/iid";

function casePlan(extra = {}) {
  const descriptor = expandMatrix(manifest)[0];
  return planCaseRun({
    manifest,
    case: descriptor,
    artifactPath: "/tmp/skill-router-pack-unit/openagency-skill-router-0.1.0.tgz",
    runId: newRunId(),
    repoRoot,
    home: "/Users/nobody-home",
    cidfile: "/tmp/skill-router-cid/unit.cid",
    ...extra,
  });
}

test("allowlisted secret names are inherited by name only, never by value", () => {
  const hostEnv = { [SECRET_NAME]: SECRET_VALUE, PATH: "/usr/bin" };
  const resolved = resolveSecretEnvNames({ requested: ["ANTHROPIC_API_KEY"], manifest, hostEnv });
  assert.deepEqual(resolved.names, [SECRET_NAME]);
  assert.deepEqual(resolved.missing, []);

  const run = casePlan({ secretEnvNames: resolved.names });
  assert.ok(run.argv.includes(`--env=${SECRET_NAME}`));
  for (const token of run.argv) {
    assert.ok(!token.includes(SECRET_VALUE), `secret value leaked into argv: ${token}`);
    assert.ok(!token.includes(`--env=${SECRET_NAME}=`), `secret must not be passed with a value: ${token}`);
  }

  // The Claude setup token behaves identically: name-only inheritance, on a
  // Claude case (the only harness whose allowlist contains it).
  const claudeDescriptor = expandMatrix(manifest).find((entry) => entry.harness === "claude");
  const tokenRun = planCaseRun({
    manifest,
    case: claudeDescriptor,
    artifactPath: "/tmp/skill-router-pack-unit/openagency-skill-router-0.1.0.tgz",
    runId: newRunId(),
    repoRoot,
    home: "/Users/nobody-home",
    cidfile: "/tmp/skill-router-cid/unit.cid",
    secretEnvNames: [OAUTH_NAME],
  });
  assert.ok(tokenRun.argv.includes(`--env=${OAUTH_NAME}`));
  for (const token of tokenRun.argv) {
    assert.ok(!token.includes(OAUTH_VALUE), `oauth value leaked into argv: ${token}`);
    assert.ok(!token.includes(`--env=${OAUTH_NAME}=`), `oauth must not be passed with a value: ${token}`);
  }

  for (const entry of planSmoke({ manifest, repoRoot, runId: newRunId(), contextDir: SYNTHETIC_CONTEXT, iidDir: SYNTHETIC_IID, cidfileDir: "/tmp/cid" }).runs) {
    for (const token of entry.argv) {
      assert.ok(!token.includes(SECRET_VALUE), "smoke must not carry secret values");
      assert.ok(!token.includes(`--env=${SECRET_NAME}`), "smoke must not request credentials at all");
      assert.ok(!token.includes(`--env=${OAUTH_NAME}`), "smoke must not request the setup token at all");
    }
  }

  for (const build of planBuild({ manifest, repoRoot, env: { [SECRET_NAME]: SECRET_VALUE, [OAUTH_NAME]: OAUTH_VALUE }, contextDir: SYNTHETIC_CONTEXT, iidDir: SYNTHETIC_IID })) {
    for (const token of build.argv) {
      assert.ok(!token.includes(SECRET_VALUE), "build args must never contain secret values");
      assert.ok(!token.includes(OAUTH_VALUE), "build args must never contain the setup token");
      assert.ok(!token.includes(SECRET_NAME), "build args must not reference secret env names");
      assert.ok(!token.includes(OAUTH_NAME), "build args must not reference the setup token name");
    }
  }
});

test("arbitrary secret env names are rejected with an actionable allowlist message", () => {
  for (const bad of ["AWS_SECRET_ACCESS_KEY", "MY_TOKEN", "ANTHROPIC_API_KEY_EXTRA", "anthropic_api_key", "PATH"]) {
    assert.throws(
      () => resolveSecretEnvNames({ requested: [bad], manifest, hostEnv: { [bad]: "value" } }),
      (error) =>
        error instanceof PlanError &&
        /non-allowlisted secret env name/.test(error.message) &&
        error.message.includes(SECRET_NAME),
      `expected rejection for ${bad}`,
    );
  }
  assert.throws(
    () => resolveSecretEnvNames({ requested: ["ANTHROPIC_API_KEY=oops"], manifest, hostEnv: {} }),
    /non-allowlisted secret env name/,
  );
});

test("per-harness allowlists scope secrets so keys are never fanned into every harness", () => {
  const both = {
    requested: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    manifest,
    hostEnv: {
      ANTHROPIC_API_KEY: SECRET_VALUE,
      OPENAI_API_KEY: "sk-openai-0123456789",
      CLAUDE_CODE_OAUTH_TOKEN: OAUTH_VALUE,
    },
  };

  const claudeScoped = resolveSecretEnvNames({ ...both, harnessId: "claude" });
  assert.deepEqual(claudeScoped.names, ["CLAUDE_CODE_OAUTH_TOKEN"], "Claude cases inherit only the setup-token credential");
  assert.deepEqual(claudeScoped.excluded, ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"], "API keys are excluded, never fanned in");

  const opencodeScoped = resolveSecretEnvNames({ ...both, harnessId: "opencode-v2" });
  assert.deepEqual(opencodeScoped.names, ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
  assert.deepEqual(opencodeScoped.excluded, ["CLAUDE_CODE_OAUTH_TOKEN"], "the Claude OAuth token never reaches OpenCode");

  const plan = planMatrix({
    manifest,
    repoRoot,
    packageMetadata,
    destination: "/tmp/plan-workdir",
    runId: newRunId(),
    home: "/Users/nobody-home",
    secretEnvNames: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    cidfileDir: "/tmp/cid",
  });
  for (const entry of plan.cases) {
    if (entry.harness === "claude") {
      assert.deepEqual(entry.secretEnvNames, ["CLAUDE_CODE_OAUTH_TOKEN"], `${entry.caseId} keeps only the setup token`);
      assert.ok(!entry.argv.includes("--env=OPENAI_API_KEY"), "Claude must not receive other providers' keys");
      assert.ok(!entry.argv.includes("--env=ANTHROPIC_API_KEY"), "Claude must not receive an API key");
      assert.deepEqual(entry.excludedSecretNames, ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
    } else {
      assert.deepEqual(entry.secretEnvNames, ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
      assert.ok(!entry.argv.includes("--env=CLAUDE_CODE_OAUTH_TOKEN"), "OpenCode must not receive the Claude OAuth token");
      assert.deepEqual(entry.excludedSecretNames, ["CLAUDE_CODE_OAUTH_TOKEN"]);
    }
    assertSafeRunSpec(entry.spec, { repoRoot, home: "/Users/nobody-home", manifest, requireImageId: false });
  }

  const claudeSpec = plan.cases.find((entry) => entry.harness === "claude").spec;
  assert.throws(
    () => assertSafeRunSpec({ ...claudeSpec, secretNames: ["ANTHROPIC_API_KEY"] }, { manifest, requireImageId: false }),
    /does not accept secret/,
  );
  assert.throws(
    () => assertSafeRunSpec({ ...claudeSpec, secretNames: ["OPENAI_API_KEY"] }, { manifest, requireImageId: false }),
    /does not accept secret/,
  );
});

test("secret values shorter than 8 characters are rejected before execution", () => {
  assert.equal(MIN_SECRET_LENGTH, 8);
  assert.throws(() => assertSecretValuesUsable({ [SECRET_NAME]: "xyzzy" }, [SECRET_NAME]), (error) => {
    assert.ok(error instanceof PlanError);
    assert.ok(error.message.includes(SECRET_NAME));
    assert.ok(!error.message.includes("xyzzy"), "the value itself must not appear in the message");
    return true;
  });
  assert.doesNotThrow(() => assertSecretValuesUsable({ [SECRET_NAME]: SECRET_VALUE }, [SECRET_NAME]));
  assert.doesNotThrow(() => assertSecretValuesUsable({}, [SECRET_NAME]), "absent values are Phase 1 compatible");

  assert.throws(
    () => resolveSecretEnvNames({ requested: [SECRET_NAME], manifest, hostEnv: { [SECRET_NAME]: "xyzzy" }, requirePresent: true, harnessId: "opencode-v1" }),
    (error) => error instanceof PlanError && error.message.includes(SECRET_NAME) && !error.message.includes("xyzzy"),
  );
  assert.throws(
    () =>
      resolveSecretEnvNames({
        requested: [OAUTH_NAME],
        manifest,
        hostEnv: { [OAUTH_NAME]: "xyzzy" },
        requirePresent: true,
        harnessId: "claude",
      }),
    (error) =>
      error instanceof PlanError &&
      error.message.includes(OAUTH_NAME) &&
      error.message.includes(String(MIN_SECRET_LENGTH)) &&
      !error.message.includes("xyzzy"),
    "a short setup-token value is rejected for the Claude harness too",
  );
});

test("missing allowlisted secrets are reported instead of silently planned", () => {
  const missing = resolveSecretEnvNames({ requested: ["OPENAI_API_KEY"], manifest, hostEnv: {} });
  assert.deepEqual(missing.names, ["OPENAI_API_KEY"]);
  assert.deepEqual(missing.missing, ["OPENAI_API_KEY"]);
  assert.throws(
    () => resolveSecretEnvNames({ requested: ["OPENAI_API_KEY"], manifest, hostEnv: {}, requirePresent: true }),
    (error) => error instanceof PlanError && /not set in the host environment/.test(error.message),
  );
});

test("collectSecretValues harvests every nonempty selected value for redaction", () => {
  assert.deepEqual(collectSecretValues({ A: undefined }, ["A"]), []);
  assert.deepEqual(collectSecretValues({}, ["ANTHROPIC_API_KEY"]), []);
  assert.deepEqual(collectSecretValues({ ANTHROPIC_API_KEY: "" }, ["ANTHROPIC_API_KEY"]), []);
  assert.deepEqual(collectSecretValues({ ANTHROPIC_API_KEY: "abc" }, ["ANTHROPIC_API_KEY"]), ["abc"]);
  assert.deepEqual(collectSecretValues({ ANTHROPIC_API_KEY: SECRET_VALUE }, ["ANTHROPIC_API_KEY"]), [SECRET_VALUE]);
});

test("central sanitizer removes tokens, values, short secrets, and host paths", () => {
  const repoRootPath = repoRoot;
  const home = "/Users/ci-home";
  const tmp = "/tmp/ci-tmp";
  const sanitize = createSanitizer({
    paths: [
      { value: tmp, label: "[tmp]" },
      { value: repoRootPath, label: "[repository]" },
      { value: home, label: "[home]" },
    ],
    secrets: [SECRET_VALUE, "zz9"],
  });

  const raw =
    `failed with Authorization: Bearer ${SECRET_VALUE} at ${path.join(repoRootPath, "src", "cli.js")} ` +
    `using ${home}/.claude/credentials and ${tmp}/session.ndjson key=abc123456789 ` +
    `token: supersecrettoken99 jwt=eyJhbGciOi.eyJzdWIiOi.SIGNATURE ses_abc123 zz9 sk-ant-api03-abcdef123456`;

  const cleaned = sanitize(raw);
  assert.ok(!cleaned.includes(SECRET_VALUE), "known secret value must be redacted");
  assert.ok(!cleaned.includes(repoRoot), "repository path must be redacted");
  assert.ok(!cleaned.includes(home), "home path must be redacted");
  assert.ok(!cleaned.includes(tmp), "temp path must be redacted");
  assert.ok(!cleaned.includes("supersecrettoken99"), "token-shaped value redacted");
  assert.ok(!cleaned.includes("abc123456789"), "key=value redacted");
  assert.ok(!cleaned.includes("sk-ant-api03-abcdef123456"), "anthropic key shape redacted");
  assert.ok(!cleaned.includes("eyJhbGciOi"), "jwt redacted");
  assert.ok(!/\bzz9\b/.test(cleaned), "short selected secret redacted on word boundaries");
  assert.ok(cleaned.includes("[repository]"));
  assert.ok(cleaned.includes("[home]"));
  assert.ok(cleaned.includes("[tmp]"));
  assert.equal(sanitize(""), "");
});

test("formatCommandFailure keeps only sanitized tails", () => {
  const sanitize = createSanitizer({
    paths: [
      { value: "/tmp/ci-tmp", label: "[tmp]" },
      { value: repoRoot, label: "[repository]" },
      { value: "/Users/ci-home", label: "[home]" },
    ],
    secrets: [SECRET_VALUE],
  });
  const result = {
    status: 1,
    signal: null,
    error: null,
    stdout: `preamble ${SECRET_VALUE}`,
    stderr: `${"filler ".repeat(1000)} ${SECRET_VALUE} ${repoRoot}/src/operations.js /Users/ci-home/.claude tail-marker`,
  };
  const message = formatCommandFailure({
    label: "docker run smoke",
    argv: ["docker", "run", "--rm", "image"],
    result,
    sanitize,
  });
  assert.ok(message.includes("docker run smoke failed"));
  assert.ok(message.includes("exit status: 1"));
  assert.ok(!message.includes(SECRET_VALUE), "failure text must not contain the secret value");
  assert.ok(!message.includes(repoRoot), "failure text must not contain the repository path");
  assert.ok(!message.includes("/Users/ci-home"), "failure text must not contain the home path");
  assert.ok(message.includes("tail-marker"), "tail must be preserved");
  assert.ok(message.length < 5000, "failure text must be bounded");
  assert.ok(!/filler fill fill/.test(message), "only the tail of stderr is reported");
});

function probeExecutor(overrides = {}) {
  return (argv) => {
    const joined = argv.join(" ");
    if (argv[1] === "version") return { status: 0, stdout: "29.4.0 29.4.0", stderr: "", signal: null, error: null };
    if (argv[1] === "info") return { status: 0, stdout: "linux arm64", stderr: "", signal: null, error: null };
    if (joined === "docker build --help") return { status: 0, stdout: "  --iidfile string\n", stderr: "", signal: null, error: null };
    if (joined === "docker run --help") return { status: 0, stdout: "  --pull string\n  --cidfile string\n", stderr: "", signal: null, error: null };
    if (overrides.build) return overrides.build(argv);
    return { status: 0, stdout: "", stderr: "", signal: null, error: null };
  };
}

test("runner failures are sanitized end to end (secret values and host paths)", () => {
  const env = { PATH: process.env.PATH ?? "", [SECRET_NAME]: SECRET_VALUE };
  const fakeHome = "/Users/ci-home";
  const fakeTmp = mkdtempSync(path.join(os.tmpdir(), "skill-router-tmp-"));
  const runner = createRunner({
    executor: probeExecutor({
      build: (argv) => {
        assert.ok(argv[1] === "build");
        return {
          status: 1,
          signal: null,
          error: null,
          stdout: "",
          stderr:
            `npm ERR! while installing harness ${SECRET_NAME}=${SECRET_VALUE}\n` +
            `Bearer ${SECRET_VALUE}\n` +
            `at ${path.join(repoRoot, "test", "container", "Dockerfile")}\n` +
            `cache ${fakeHome}/.npm/_logs and ${path.join(fakeTmp, "npm-debug.log")}`,
        };
      },
    }),
    cwd: repoRoot,
    homedir: fakeHome,
    tmpdir: fakeTmp,
    stdout: () => {},
    stderr: () => {},
    env,
  });

  try {
    assert.throws(
      () => runner.build({ harnessIds: ["opencode-v1"] }),
      (error) => {
        const message = String(error.message);
        assert.ok(!message.includes(SECRET_VALUE), "leaked secret value");
        assert.ok(
          !new RegExp(`${SECRET_NAME}=(?!\\[redacted\\])`).test(message),
          "leaked a non-redacted secret assignment",
        );
        assert.ok(!message.includes(repoRoot), "leaked repository path");
        assert.ok(!message.includes(fakeHome), "leaked home path");
        assert.ok(!message.includes(fakeTmp), "leaked temp path");
        assert.ok(message.includes("[repository]"), "repository placeholder expected");
        assert.ok(message.includes("[home]"), "home placeholder expected");
        assert.ok(message.includes("[tmp]"), "tmp placeholder expected");
        assert.ok(message.includes("exit status: 1"));
        return true;
      },
    );
  } finally {
    rmSync(fakeTmp, { recursive: true, force: true });
  }
});

test("runner plan output never prints secret values or host paths", () => {
  const env = { PATH: process.env.PATH ?? "", [SECRET_NAME]: SECRET_VALUE };
  const lines = [];
  const runner = createRunner({
    executor: () => {
      throw new Error("plan must not execute");
    },
    cwd: repoRoot,
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
    env,
  });

  const plan = runner.plan({ secretEnv: [SECRET_NAME] });
  assert.equal(plan.cases.length, 7);
  const output = lines.join("\n");
  assert.ok(!output.includes(SECRET_VALUE), "printed plan leaked the secret value");
  assert.ok(!output.includes(repoRoot), "printed plan leaked the repository path");
  assert.ok(!output.includes(process.env.HOME ?? "__unset__"), "printed plan leaked HOME");
  assert.ok(output.includes("--env=ANTHROPIC_API_KEY"), "plan should show the inherited env name");
  assert.ok(output.includes("[tmp]"), "plan should render temp paths through the sanitizer");
  assert.ok(output.includes("one fresh container each"));
  assert.ok(output.includes("digest-pinned multi-arch manifest"));
});

test("host networking is rejected during planning and validation", () => {
  assert.throws(() => assertNetwork("host"), (error) => error instanceof PlanError && /host network namespace/.test(error.message));
  assert.throws(() => assertNetwork("container:abc"), /forbidden/);
  assert.equal(assertNetwork("bridge"), "bridge");
  assert.equal(assertNetwork("none"), "none");

  const descriptor = expandMatrix(manifest)[0];
  assert.throws(
    () =>
      planCaseRun({
        manifest,
        case: descriptor,
        artifactPath: "/tmp/skill-router-pack-unit/openagency-skill-router-0.1.0.tgz",
        runId: newRunId(),
        repoRoot,
        home: "/Users/nobody-home",
        cidfile: "/tmp/skill-router-cid/unit.cid",
        network: "host",
      }),
    (error) => error instanceof PlanError && /host network namespace/.test(error.message),
  );

  const spec = casePlan().spec;
  assert.throws(() => assertSafeRunSpec({ ...spec, network: "host" }, { manifest }), /forbidden/);
  const argv = casePlan().argv.map((token) => (token.startsWith("--network=") ? "--network=host" : token));
  assert.throws(
    () => assertSafeRunArgv(argv),
    (error) => error instanceof PlanError && /--network=host|host network/.test(error.message),
  );
});

test("assertSafeRunArgv enforces the exact option set before the image boundary", () => {
  const base = casePlan({ secretEnvNames: [SECRET_NAME] }).argv;
  assert.ok(assertSafeRunArgv(base, { repoRoot, home: "/Users/nobody-home", secretNames: [SECRET_NAME] }));

  const required = [
    "--rm",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    PULL_POLICY,
    `--user=${RUNTIME.user}`,
    "--pids-limit=512",
  ];
  for (const flag of required) {
    assert.throws(
      () => assertSafeRunArgv(base.filter((token) => token !== flag), { repoRoot }),
      (error) => error instanceof PlanError && /missing required isolation flag/.test(error.message),
      `removal of ${flag} must be rejected`,
    );
  }
  assert.throws(() => assertSafeRunArgv(base.filter((token) => !token.startsWith("--cidfile=")), { repoRoot }), /--cidfile/);
  assert.throws(() => assertSafeRunArgv(base.filter((token) => !token.startsWith("--name=")), { repoRoot }), /--name/);
  assert.throws(
    () => assertSafeRunArgv(base.filter((token) => !token.startsWith(`--tmpfs=${TMPFS.home.split(":")[0]}`)), { repoRoot }),
    /tmpfs destination \/home\/node/,
  );
  assert.throws(
    () => assertSafeRunArgv(base.filter((token) => !token.startsWith(`--tmpfs=${TMPFS.tmp.split(":")[0]}`)), { repoRoot }),
    /tmpfs destination \/tmp/,
  );
  assert.throws(() => assertSafeRunArgv(base.filter((token) => !token.startsWith("--network=")), { repoRoot }), /--network/);
  assert.throws(() => assertSafeRunArgv([...base, "--privileged"], { repoRoot }), /forbidden/);
  assert.throws(() => assertSafeRunArgv([...base, "--network=host"], { repoRoot }), (error) => /--network=host|host network/.test(error.message));
  assert.throws(() => assertSafeRunArgv([...base, "--pid=host"], { repoRoot }), /forbidden/);
  assert.throws(() => assertSafeRunArgv([...base, "/var/run/docker.sock:/var/run/docker.sock"], { repoRoot }), /forbidden/);
  assert.throws(() => assertSafeRunArgv([...base, "-v", `${repoRoot}:/mnt/repo`], { repoRoot }), /forbidden/);

  // Mutable tags are rejected for live (credential-bearing) execution.
  assert.throws(() => assertSafeRunArgv(base, { repoRoot, requireImageId: true }), (error) => /immutable image id/.test(error.message));

  const withValue = base.map((token) => (token === `--env=${SECRET_NAME}` ? `--env=${SECRET_NAME}=${SECRET_VALUE}` : token));
  assert.throws(() => assertSafeRunArgv(withValue, { repoRoot, secretNames: [SECRET_NAME] }), /secret env/);
  const missingName = base.filter((token) => token !== `--env=${SECRET_NAME}`);
  assert.throws(() => assertSafeRunArgv(missingName, { repoRoot, secretNames: [SECRET_NAME] }), /must be passed as/);
  assert.throws(
    () => assertSafeRunArgv([...base, `--env=${SECRET_NAME}=${SECRET_VALUE}`], { repoRoot, secretAllowlist: [SECRET_NAME] }),
    /duplicate\/conflicting env/,
    "a value-shaped secret smuggled in beside the inherited name is a conflict",
  );
  assert.throws(
    () => assertSafeRunArgv([...missingName, `--env=${SECRET_NAME}=${SECRET_VALUE}`], { repoRoot, secretAllowlist: [SECRET_NAME] }),
    /never be given a value/,
  );
  assert.throws(() => assertSafeRunArgv(["docker", "build", "--rm"], { repoRoot }), /must start with `docker run`/);
});

test("matrix plan secret arguments stay name-only across every case", () => {
  const plan = planMatrix({
    manifest,
    repoRoot,
    packageMetadata,
    destination: "/tmp/plan-workdir",
    runId: newRunId(),
    home: "/Users/nobody-home",
    secretEnvNames: [SECRET_NAME, OAUTH_NAME],
    cidfileDir: "/tmp/cid",
  });
  const requested = [SECRET_NAME, OAUTH_NAME];
  for (const entry of plan.cases) {
    const harnessAllowlist = manifest.harnesses[entry.harness].secretAllowlist;
    const expected = requested.filter((name) => harnessAllowlist.includes(name));
    const secretTokens = entry.argv
      .filter((token) => token.startsWith("--env="))
      .map((token) => token.slice("--env=".length).split("=")[0])
      .filter((name) => manifest.secretEnvAllowlist.includes(name));
    assert.deepEqual(secretTokens, expected, `${entry.caseId} secret shape`);
    assert.deepEqual(entry.secretEnvNames, expected, `${entry.caseId} scoped secret names`);
    for (const token of entry.argv) {
      assert.ok(!token.includes(SECRET_VALUE), `${entry.caseId} must not carry an API key value`);
      assert.ok(!token.includes(OAUTH_VALUE), `${entry.caseId} must not carry the OAuth token value`);
      assert.ok(!token.startsWith(`--env=${OAUTH_NAME}=`), "the setup token is inherited by name, never assigned");
    }
    assertSafeRunArgv(entry.argv, { repoRoot, home: "/Users/nobody-home", secretNames: expected });
  }
});

function insertOption(argv, token) {
  const imageIndex = argv.findIndex((entry, index) => index >= 2 && !entry.startsWith("--"));
  assert.notEqual(imageIndex, -1, "expected an image token");
  return [...argv.slice(0, imageIndex), token, ...argv.slice(imageIndex)];
}

test("assertSafeRunArgv rejects duplicate/conflicting options and unsupported options", () => {
  const run = casePlan();
  const base = run.argv;

  // Capability additions are forbidden wherever they appear.
  assert.throws(() => assertSafeRunArgv(insertOption(base, "--cap-add=SYS_ADMIN"), { repoRoot }), /forbidden/);
  assert.throws(() => assertSafeRunArgv([...base, "--cap-add=SYS_ADMIN"], { repoRoot }), /forbidden/);

  // Repeated scalar options are conflicting.
  assert.throws(
    () => assertSafeRunArgv(insertOption(base, "--user=0:0"), { repoRoot }),
    /duplicate\/conflicting option: --user/,
  );
  assert.throws(
    () => assertSafeRunArgv(insertOption(base, "--network=bridge"), { repoRoot }),
    /duplicate\/conflicting option: --network/,
  );
  assert.throws(
    () => assertSafeRunArgv(insertOption(base, "--workdir=/etc"), { repoRoot }),
    /duplicate\/conflicting option: --workdir/,
  );

  // Unknown Docker options are rejected by the whitelist.
  assert.throws(
    () => assertSafeRunArgv(insertOption(base, "--expose=1234"), { repoRoot }),
    /unsupported option: --expose/,
  );

  // Repeatable options may not conflict.
  assert.throws(
    () => assertSafeRunArgv(insertOption(base, `--label=${LABELS.harness}=opencode-v2`), { repoRoot }),
    /duplicate label/,
  );
  assert.throws(
    () => assertSafeRunArgv(insertOption(base, "--tmpfs=/workspace:rw,nosuid,nodev,mode=0700,uid=1000,gid=1000"), { repoRoot }),
    /duplicate tmpfs destination/,
  );
  assert.throws(
    () => assertSafeRunArgv(insertOption(base, "--env=NO_COLOR=0"), { repoRoot }),
    /duplicate\/conflicting env: NO_COLOR/,
  );
});

test("assertSafeRunArgv requires deep-equality with the canonical argv for its spec", () => {
  const run = casePlan();
  const spec = run.spec;

  // Canonical argv passes when the spec is supplied.
  assertSafeRunArgv(run.argv, { repoRoot, home: "/Users/nobody-home", spec, requireImageId: false });

  // Any deviation that survives the granular checks is still rejected.
  const extraLabel = insertOption(run.argv, "--label=dev.openagency.skill-router.extra=x");
  assert.doesNotThrow(() => assertSafeRunArgv(extraLabel, { repoRoot }), "granular checks accept the extra label");
  assert.throws(
    () => assertSafeRunArgv(extraLabel, { repoRoot, spec }),
    /does not deep-equal the canonical typed construction/,
  );

  const networkIndex = run.argv.findIndex((token) => token.startsWith("--network="));
  const userIndex = run.argv.findIndex((token) => token.startsWith("--user="));
  assert.notEqual(networkIndex, -1);
  assert.notEqual(userIndex, -1);
  const reordered = [...run.argv];
  [reordered[networkIndex], reordered[userIndex]] = [reordered[userIndex], reordered[networkIndex]];
  assert.doesNotThrow(() => assertSafeRunArgv(reordered, { repoRoot }), "granular checks accept the swapped options");
  assert.throws(
    () => assertSafeRunArgv(reordered, { repoRoot, spec }),
    /does not deep-equal the canonical typed construction/,
  );
});

test("safe host env strips every allowlisted credential; container env adds only selected names", () => {
  const host = {
    PATH: "/usr/bin",
    HOME: "/home/ci",
    [SECRET_NAME]: SECRET_VALUE,
    OPENAI_API_KEY: "sk-openai-live-0123456789",
    GEMINI_API_KEY: "AIza-not-requested-0123456789",
    [OAUTH_NAME]: OAUTH_VALUE,
  };
  const safe = createSafeHostEnv(host, manifest.secretEnvAllowlist);
  assert.deepEqual(Object.keys(safe).sort(), ["HOME", "PATH"], "every provider credential is deleted");
  for (const name of manifest.secretEnvAllowlist) assert.ok(!(name in safe));
  assert.ok(!(OAUTH_NAME in safe), "the setup token never survives into host pack/build/probe commands");

  const caseEnv = containerRunEnv({
    safeEnv: safe,
    hostEnv: host,
    spec: { secretNames: [SECRET_NAME] },
    allowlist: manifest.secretEnvAllowlist,
  });
  assert.deepEqual(Object.keys(caseEnv).sort(), [SECRET_NAME, "HOME", "PATH"], "exactly the selected secret is added");
  assert.ok(!("GEMINI_API_KEY" in caseEnv), "unselected credentials never reach a case command");
  assert.equal(caseEnv[SECRET_NAME], SECRET_VALUE);

  // Claude cases receive the setup token and nothing else; OpenCode cases the
  // inverse. Neither harness can see the other's credential.
  const claudeEnv = containerRunEnv({
    safeEnv: safe,
    hostEnv: host,
    spec: { secretNames: [OAUTH_NAME] },
    allowlist: manifest.secretEnvAllowlist,
  });
  assert.deepEqual(Object.keys(claudeEnv).sort(), ["HOME", "PATH", OAUTH_NAME].sort());
  assert.ok(!(SECRET_NAME in claudeEnv), "Claude case env carries no API key");
  assert.equal(claudeEnv[OAUTH_NAME], OAUTH_VALUE, "inherited by name from the host environment");
  const openCodeEnv = containerRunEnv({
    safeEnv: safe,
    hostEnv: host,
    spec: { secretNames: [SECRET_NAME, "OPENAI_API_KEY"] },
    allowlist: manifest.secretEnvAllowlist,
  });
  assert.ok(!(OAUTH_NAME in openCodeEnv), "OpenCode case env never carries the Claude setup token");

  const absent = containerRunEnv({
    safeEnv: safe,
    hostEnv: host,
    spec: { secretNames: ["GROQ_API_KEY"] },
    allowlist: manifest.secretEnvAllowlist,
  });
  assert.ok(!("GROQ_API_KEY" in absent), "missing selected secret is simply absent, never invented");

  const smokeEnv = containerRunEnv({ safeEnv: safe, hostEnv: host, spec: { secretNames: [] }, allowlist: manifest.secretEnvAllowlist });
  assert.deepEqual(Object.keys(smokeEnv).sort(), ["HOME", "PATH"], "credential-free commands inherit nothing");
});

/* ----------------- Claude setup-token transport (Milestone A) ------------------ */

test("plan output carries only the setup-token name, never its value (text and JSON)", () => {
  const env = { PATH: process.env.PATH ?? "", [OAUTH_NAME]: OPAQUE_OAUTH_VALUE };
  const lines = [];
  const runner = createRunner({
    executor: () => {
      throw new Error("plan must not execute");
    },
    cwd: repoRoot,
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
    env,
  });

  const plan = runner.plan({ secretEnv: [OAUTH_NAME, "OPENAI_API_KEY"] });
  runner.plan({ secretEnv: [OAUTH_NAME, "OPENAI_API_KEY"], json: true });
  const output = lines.join("\n");

  // The opaque value has no credential-shaped pattern: only value-based
  // redaction of the selected secret can keep it out of the output.
  assert.ok(!output.includes(OPAQUE_OAUTH_VALUE), "the setup-token value never reaches plan output");
  assert.ok(!output.includes(OPAQUE_OAUTH_VALUE.slice(0, 16)), "no prefix of the value survives either");
  assert.ok(!runner.sanitize(`leak ${OPAQUE_OAUTH_VALUE}`).includes(OPAQUE_OAUTH_VALUE), "central sanitizer redacts the value");
  assert.ok(output.includes(`--env=${OAUTH_NAME}`), "the env name stays visible for auditability");

  for (const entry of plan.cases) {
    if (entry.harness === "claude") {
      assert.ok(entry.argv.includes(`--env=${OAUTH_NAME}`), `${entry.caseId} receives the setup token by name`);
      assert.ok(!entry.argv.some((token) => token.startsWith(`--env=${OAUTH_NAME}=`)), "never assigned a value");
    } else {
      assert.ok(!entry.argv.includes(`--env=${OAUTH_NAME}`), `${entry.caseId} never receives the Claude setup token`);
    }
    assert.ok(!entry.argv.join(" ").includes(OPAQUE_OAUTH_VALUE), `${entry.caseId} argv stays value-free`);
  }
});

test("case runs mount only the packed artifact and never a host OAuth/config surface", () => {
  const plan = planMatrix({
    manifest,
    repoRoot,
    packageMetadata,
    destination: "/tmp/plan-workdir",
    runId: newRunId(),
    home: "/Users/nobody-home",
    secretEnvNames: [OAUTH_NAME, SECRET_NAME],
    cidfileDir: "/tmp/cid",
  });
  assert.equal(plan.cases.length, 7);
  for (const entry of plan.cases) {
    assert.equal(entry.spec.mounts.length, 1, `${entry.caseId} mounts exactly one path`);
    assert.equal(entry.spec.mounts[0].dst, "/input/skill-router.tgz");
    assert.equal(entry.spec.mounts[0].readonly, true);
    for (const envEntry of entry.spec.env) {
      assert.ok(!envEntry.name.includes("OAUTH"), `${entry.caseId} must not carry a literal OAuth env`);
      assert.ok(!envEntry.value.includes(OAUTH_VALUE), `${entry.caseId} literal env must never be a credential`);
      assert.ok(!/auth\.json|settings\.json|\.claude/.test(envEntry.value), `${entry.caseId} literal env must not be host config`);
    }
    for (const token of entry.argv) {
      assert.ok(!token.includes("auth.json"), `auth file surfaced: ${token}`);
      assert.ok(!token.includes("settings.json"), `settings file surfaced: ${token}`);
      assert.ok(!token.includes(".mcp.json"), `mcp config surfaced: ${token}`);
      assert.ok(!token.includes(".claude"), `claude config path surfaced: ${token}`);
      assert.ok(!token.includes(OPAQUE_OAUTH_VALUE), `oauth value surfaced: ${token}`);
      assert.ok(!token.startsWith("--env-file"), "no env-file transport");
      assert.ok(token !== "--mount" && !token.startsWith("--volume") && token !== "-v", "no extra mounts");
      if (token.startsWith(`--env=${OAUTH_NAME}=`)) assert.fail("setup token must be inherited by name");
    }
  }
});


/* --------- OpenCode credential snapshot (auth-bridge remediation) ----------- */

const AUTH_SECRET_VALUE = "sk-real-opencode-secret-0123456789abcdef";
const OAUTH_ACCESS = "sk-dummy-access-0123456789";
const OAUTH_REFRESH = "sk-dummy-refresh-0123456789";

function authDocument() {
  return {
    openai: {
      type: "oauth",
      accessToken: AUTH_SECRET_VALUE,
      refreshToken: `${AUTH_SECRET_VALUE}-refresh`,
      expiresAt: 4102444800000,
    },
    "opencode-go": { type: "api", key: "sk-dummy-opencode-go-000000000000000000" },
  };
}

function writeAuthFile(root, name, content, mode = 0o600) {
  const target = path.join(root, name);
  writeFileSync(target, typeof content === "string" ? content : `${JSON.stringify(content)}\n`, { mode });
  chmodSync(target, mode);
  return target;
}

test("explicit OpenCode auth file validation rejects unsafe inputs without echoing anything", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-router-auth-validate-"));
  try {
    // Never defaulted: an absent request is an error, not a discovery step.
    assert.throws(
      () => resolveOpenCodeAuthFile({}),
      (error) =>
        error instanceof PlanError &&
        /no OpenCode auth file was requested/.test(error.message) &&
        error.message.includes("SKILL_ROUTER_OPENCODE_AUTH_FILE") &&
        error.message.includes("--opencode-auth-file"),
    );
    assert.throws(() => resolveOpenCodeAuthFile({ requested: "   " }), /no OpenCode auth file was requested/);

    // Missing file: path withheld.
    const missing = path.join(root, "missing.json");
    assert.throws(
      () => resolveOpenCodeAuthFile({ requested: missing }),
      (error) => error instanceof PlanError && /does not exist/.test(error.message) && !error.message.includes(root),
    );

    // Non-regular file (directory) and symlinks are rejected outright.
    const directory = path.join(root, "directory.json");
    mkdirSync(directory);
    assert.throws(() => resolveOpenCodeAuthFile({ requested: directory }), /must be a regular file/);
    const real = writeAuthFile(root, "real.json", authDocument());
    const link = path.join(root, "link.json");
    symlinkSync(real, link);
    assert.throws(
      () => resolveOpenCodeAuthFile({ requested: link }),
      (error) => error instanceof PlanError && /must not be a symlink/.test(error.message) && !error.message.includes(root),
      "O_NOFOLLOW rejects a symlinked final component",
    );

    // Size bound (owner-only but oversized).
    const oversized = path.join(root, "oversized.json");
    writeFileSync(oversized, "x".repeat(OPENCODE_AUTH_MAX_BYTES + 1), { mode: 0o600 });
    chmodSync(oversized, 0o600);
    assert.throws(
      () => resolveOpenCodeAuthFile({ requested: oversized }),
      new RegExp(`${OPENCODE_AUTH_MAX_BYTES} byte limit`),
    );

    // Any group/other bit is rejected; an unreadable file cannot be opened.
    for (const mode of [0o644, 0o640, 0o604, 0o660, 0o666]) {
      const loose = writeAuthFile(root, `mode-${mode.toString(8)}.json`, authDocument(), mode);
      assert.throws(
        () => resolveOpenCodeAuthFile({ requested: loose }),
        (error) => error instanceof PlanError && /owner-only/.test(error.message) && !error.message.includes(root),
        `mode ${mode.toString(8)} must be rejected`,
      );
    }
    const writeOnly = writeAuthFile(root, "write-only.json", authDocument(), 0o200);
    assert.throws(
      () => resolveOpenCodeAuthFile({ requested: writeOnly }),
      (error) =>
        error instanceof PlanError &&
        /could not be opened|not readable by its owner/.test(error.message) &&
        !error.message.includes(root),
      "an unreadable file is rejected at open time",
    );

    // Malformed and non-object documents: content never echoed.
    const malformed = writeAuthFile(root, "malformed.json", `{ "openai": ${AUTH_SECRET_VALUE}`);
    assert.throws(
      () => resolveOpenCodeAuthFile({ requested: malformed }),
      (error) =>
        /not valid JSON/.test(error.message) &&
        !error.message.includes(AUTH_SECRET_VALUE) &&
        !error.message.includes(root),
    );
    assert.throws(
      () => resolveOpenCodeAuthFile({ requested: writeAuthFile(root, "array.json", "[1,2,3]") }),
      /JSON object at the top level/,
    );
    assert.throws(
      () => resolveOpenCodeAuthFile({ requested: writeAuthFile(root, "scalar.json", "42") }),
      /JSON object at the top level/,
    );

    // Entry-shape attacks.
    const badEntries = [
      [JSON.stringify({ openai: AUTH_SECRET_VALUE }), /entry "openai" must be a JSON object/],
      [JSON.stringify({ "OpenAI!": { type: "api", key: AUTH_SECRET_VALUE } }), /not a lowercase provider identifier/],
      [JSON.stringify({ "": { type: "api", key: AUTH_SECRET_VALUE } }), /not a lowercase provider identifier/],
      [JSON.stringify({ openai: { key: AUTH_SECRET_VALUE } }), /entry "openai" is missing a valid type/],
      [JSON.stringify({ openai: { type: 42 } }), /entry "openai" is missing a valid type/],
      [JSON.stringify({ openai: { type: "API KEY" } }), /entry "openai" is missing a valid type/],
      [JSON.stringify({ openai: [] }), /entry "openai" must be a JSON object/],
      [JSON.stringify({ openai: { type: "smart" } }), /credential type "smart", which this runner cannot convert/],
      [JSON.stringify({ openai: { type: "api" } }), /key credential without a key/],
      [JSON.stringify({ openai: { type: "oauth", accessToken: OAUTH_ACCESS } }), /without refresh\/access material/],
      [JSON.stringify({ "opencode-go": { type: "oauth", refresh: OAUTH_REFRESH } }), /without refresh\/access material/],
      [JSON.stringify({ "opencode-go": { type: "wellknown" } }), /key credential without a key/],
      ["{}", /no provider entries/],
    ];
    for (let index = 0; index < badEntries.length; index += 1) {
      const [content, pattern] = badEntries[index];
      const file = writeAuthFile(root, `bad-${index}.json`, content);
      assert.throws(
        () => resolveOpenCodeAuthFile({ requested: file }),
        (error) =>
          error instanceof PlanError &&
          pattern.test(error.message) &&
          !error.message.includes(AUTH_SECRET_VALUE) &&
          !error.message.includes(OAUTH_ACCESS) &&
          !error.message.includes(root),
        `entry attack ${index} must be rejected structurally`,
      );
    }

    // Entry-count bound.
    const many = {};
    for (let index = 0; index < 70; index += 1) many[`p${index}`] = { type: "api", key: `value-${index}-0123456789` };
    assert.throws(
      () => resolveOpenCodeAuthFile({ requested: writeAuthFile(root, "many.json", JSON.stringify(many)) }),
      /more than 64 provider entries/,
    );

    // Unsupported *provider* ids stay tolerated (they never widen support).
    const foreign = writeAuthFile(root, "foreign.json", { acme: { type: "api", key: "acme-key-0123456789abcdef" } });
    const foreignDescriptor = resolveOpenCodeAuthFile({ requested: foreign });
    assert.deepEqual([...foreignDescriptor.providers], ["acme"]);
    assert.deepEqual([...foreignDescriptor.supported], []);
    assert.deepEqual(foreignDescriptor.importEntries, [], "unsupported providers are never converted");

    // Valid document: ids/types interpreted, long values and keys collected,
    // and both supported providers convert into v2 import entries.
    const descriptor = resolveOpenCodeAuthFile({ requested: real });
    assert.equal(descriptor.size, readFileSync(real).length);
    assert.deepEqual([...descriptor.providers], ["openai", "opencode-go"]);
    assert.deepEqual([...descriptor.supported], [...OPENCODE_AUTH_SUPPORTED_PROVIDERS]);
    assert.deepEqual(descriptor.entries.map((entry) => entry.type), ["oauth", "api"]);
    assert.equal(descriptor.importEntries.length, 2, "both supported providers convert");
    assert.ok(descriptor.values.includes(AUTH_SECRET_VALUE), "long values are collected for redaction");
    assert.ok(descriptor.values.includes("refreshToken"), "credential-shaped keys are collected too");
    assert.ok(!descriptor.values.includes("type"), "neutral short keys stay out of the redaction set");
    assert.ok(
      !JSON.stringify({ providers: descriptor.providers, supported: descriptor.supported }).includes(AUTH_SECRET_VALUE),
      "audit-shaped metadata never carries values",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the auth file is validated and read through one no-follow descriptor (TOCTOU)", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-router-auth-toctou-"));
  try {
    const target = path.join(root, "auth.json");
    const originalBytes = `${JSON.stringify(authDocument(), null, 2)}\n`;
    writeFileSync(target, originalBytes, { mode: 0o600 });
    chmodSync(target, 0o600);

    // 1) Replacing the path after open cannot change what is validated: the
    //    byte read happens on the same descriptor that was fstat'ed.
    let swapped = false;
    const swapTo = (replacement) => {
      rmSync(target, { force: true });
      writeFileSync(target, JSON.stringify(replacement), { mode: 0o600 });
      chmodSync(target, 0o600);
    };
    const swappingIo = {
      readFileSync: (fd) => {
        if (!swapped) {
          swapped = true;
          swapTo({ openai: { type: "api", key: "sk-replacement-0123456789abcdef" } });
        }
        return readFileSync(fd);
      },
    };
    const descriptor = resolveOpenCodeAuthFile({ requested: target, io: swappingIo });
    assert.equal(swapped, true, "the deterministic swap hook actually ran");
    assert.deepEqual(descriptor.bytes, Buffer.from(originalBytes), "bytes come from the original descriptor");
    assert.deepEqual([...descriptor.providers], ["openai", "opencode-go"], "validation saw the original document");
    assert.ok(!descriptor.values.includes("sk-replacement-0123456789abcdef"), "replacement content is never parsed");

    // 2) A symlink swapped in after open is likewise irrelevant to the read,
    //    and a symlink present at open time is refused by O_NOFOLLOW.
    rmSync(target, { force: true });
    writeFileSync(target, originalBytes, { mode: 0o600 });
    chmodSync(target, 0o600);
    let symlinked = false;
    const linkTarget = path.join(root, "elsewhere.json");
    writeFileSync(linkTarget, JSON.stringify({ openai: { type: "api", key: "sk-elsewhere-0123456789abcdef" } }), { mode: 0o600 });
    const linkIo = {
      readFileSync: (fd) => {
        if (!symlinked) {
          symlinked = true;
          rmSync(target, { force: true });
          symlinkSync(linkTarget, target);
        }
        return readFileSync(fd);
      },
    };
    const afterLink = resolveOpenCodeAuthFile({ requested: target, io: linkIo });
    assert.equal(symlinked, true, "the symlink swap hook actually ran");
    assert.deepEqual(afterLink.bytes, Buffer.from(originalBytes), "the read still comes from the original descriptor");

    rmSync(target, { force: true });
    symlinkSync(linkTarget, target);
    assert.throws(
      () => resolveOpenCodeAuthFile({ requested: target }),
      (error) => error instanceof PlanError && /must not be a symlink/.test(error.message),
    );
    rmSync(target, { force: true });
    writeFileSync(target, originalBytes, { mode: 0o600 });
    chmodSync(target, 0o600);

    // 3) Post-read fstat invariants: size drift and mode drift are rejected.
    let sizeDriftCalls = 0;
    assert.throws(
      () =>
        resolveOpenCodeAuthFile({
          requested: target,
          io: {
            fstatSync: (fd) => {
              sizeDriftCalls += 1;
              const stat = fstatSync(fd);
              if (sizeDriftCalls === 1) return stat;
              return { isFile: () => true, size: stat.size + 1, mode: stat.mode };
            },
          },
        }),
      /changed while it was being read/,
    );
    assert.equal(sizeDriftCalls, 2, "both fstat calls happened on the same descriptor");

    let modeDriftCalls = 0;
    assert.throws(
      () =>
        resolveOpenCodeAuthFile({
          requested: target,
          io: {
            fstatSync: (fd) => {
              modeDriftCalls += 1;
              const stat = fstatSync(fd);
              if (modeDriftCalls === 1) return stat;
              return { isFile: () => true, size: stat.size, mode: 0o644 };
            },
          },
        }),
      /permissions changed while it was being read/,
    );

    // 4) A platform without no-follow semantics is refused, never downgraded.
    assert.throws(
      () => resolveOpenCodeAuthFile({ requested: target, io: { constants: { O_RDONLY: 0 } } }),
      /no-follow open semantics/,
    );
    assert.throws(
      () => resolveOpenCodeAuthFile({ requested: target, io: { constants: { O_RDONLY: 0, O_NOFOLLOW: undefined } } }),
      /no-follow open semantics/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the credential snapshot writes only the requested providers, owner-only, and verifies them byte-for-byte", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-router-auth-snapshot-"));
  try {
    const original = writeAuthFile(root, "auth.json", authDocument());
    const originalBytes = readFileSync(original);
    const descriptor = resolveOpenCodeAuthFile({ requested: original });
    const credentialDir = path.join(root, "lifecycle", "opencode-credential");
    const providers = ["openai", "opencode-go"];

    const snapshot = createOpenCodeAuthSnapshot({ descriptor, credentialDir, providers });
    assert.deepEqual(Object.keys(snapshot).sort(), ["dir", "importPath", "legacyPath"]);
    assert.equal(snapshot.dir, credentialDir);
    assert.equal(path.basename(snapshot.legacyPath), RUNTIME.opencodeAuthLegacy);
    assert.equal(path.basename(snapshot.importPath), RUNTIME.opencodeAuthImport);

    assert.equal(statSync(credentialDir).mode & 0o7777, 0o700, "credential directory is exactly 0700");
    for (const file of [snapshot.legacyPath, snapshot.importPath]) {
      assert.equal(statSync(file).mode & 0o7777, 0o600, `${path.basename(file)} is exactly 0600`);
    }

    // Legacy file: exactly the requested providers, values taken verbatim from
    // the validated document (the original file itself is never touched).
    const legacyText = readFileSync(snapshot.legacyPath, "utf8");
    assert.deepEqual(Object.keys(JSON.parse(legacyText)).sort(), [...providers].sort(), "exactly the requested providers");
    assert.deepEqual(JSON.parse(legacyText), JSON.parse(originalBytes.toString("utf8")), "values from the document");
    assert.deepEqual(readFileSync(original), originalBytes, "the original is untouched");

    const importText = readFileSync(snapshot.importPath, "utf8");
    const importJson = JSON.parse(importText);
    assert.ok(Array.isArray(importJson) && importJson.length === 2, "the generated v2 import array is written");
    assert.deepEqual(importJson.map((entry) => entry.integrationID).sort(), [...providers].sort());
    assert.ok(!importText.includes(descriptor.path), "no host path inside the snapshot");

    // The mounted directory holds exactly the two credential files.
    assert.deepEqual(readdirSync(credentialDir).sort(), [RUNTIME.opencodeAuthImport, RUNTIME.opencodeAuthLegacy]);

    // Provider filtering: a single selected provider yields files that carry
    // nothing else — no unrelated entries, values, or labels.
    const singleDir = path.join(root, "single", "opencode-credential");
    const single = createOpenCodeAuthSnapshot({ descriptor, credentialDir: singleDir, providers: ["opencode-go"] });
    const singleLegacy = readFileSync(single.legacyPath, "utf8");
    const singleImport = readFileSync(single.importPath, "utf8");
    assert.deepEqual(Object.keys(JSON.parse(singleLegacy)), ["opencode-go"]);
    assert.deepEqual(JSON.parse(singleImport).map((entry) => entry.integrationID), ["opencode-go"]);
    for (const text of [singleLegacy, singleImport]) {
      assert.ok(!text.includes("openai"), "no unrelated provider id");
      assert.ok(!text.includes(AUTH_SECRET_VALUE), "no unrelated credential value");
      assert.ok(!text.includes('"OAuth"'), "no unrelated label");
      assert.ok(!text.includes(descriptor.path), "no host path");
    }

    // Read-back mismatch (write corruption) fails and removes the partial dir.
    const corruptDir = path.join(root, "corrupt", "opencode-credential");
    assert.throws(
      () =>
        createOpenCodeAuthSnapshot({
          descriptor,
          credentialDir: corruptDir,
          providers,
          hooks: { afterWrite: (file) => writeFileSync(file, "corrupted-after-write") },
        }),
      /read-back check/,
    );
    assert.equal(existsSync(corruptDir), false, "partial creation is removed after a failed read-back");

    // A write failure also leaves nothing behind (partial creation cleanup).
    const failingDir = path.join(root, "failing", "opencode-credential");
    assert.throws(
      () =>
        createOpenCodeAuthSnapshot({
          descriptor,
          credentialDir: failingDir,
          providers,
          io: {
            writeFileSync: () => {
              throw Object.assign(new Error("no space"), { code: "ENOSPC" });
            },
          },
        }),
      (error) => error instanceof PlanError && /could not be written/.test(error.message),
    );
    assert.equal(existsSync(failingDir), false, "partial creation is removed after a write failure");

    // Argument guards: no implicit "all providers" default, no unknown ids.
    assert.throws(() => createOpenCodeAuthSnapshot({ descriptor: null, credentialDir, providers }), /validated auth descriptor/);
    assert.throws(() => createOpenCodeAuthSnapshot({ descriptor, credentialDir: null, providers }), /absolute host path/);
    assert.throws(() => createOpenCodeAuthSnapshot({ descriptor, credentialDir: "relative/dir", providers }), /absolute host path/);
    assert.throws(() => createOpenCodeAuthSnapshot({ descriptor, credentialDir }), /explicit provider list/);
    assert.throws(() => createOpenCodeAuthSnapshot({ descriptor, credentialDir, providers: [] }), /explicit provider list/);
    assert.throws(
      () => createOpenCodeAuthSnapshot({ descriptor, credentialDir, providers: ["not-a-provider"] }),
      /does not carry provider "not-a-provider"/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auth redaction collection traverses the whole document without truncation", () => {
  // Depth beyond the old 8-level cap.
  let deep = { leaf: AUTH_SECRET_VALUE };
  for (let level = 0; level < 24; level += 1) deep = { [`level${String(level).padStart(4, "0")}`]: deep };
  const deepValues = collectOpenCodeAuthValues(deep, []);
  assert.ok(deepValues.includes(AUTH_SECRET_VALUE), "deeply nested values are collected");
  assert.ok(deepValues.includes("level0023"), "keys at depth are collected too");

  // Count beyond the old 512-entry cap.
  const many = {};
  const expected = [];
  for (let index = 0; index < 700; index += 1) {
    const value = `secret-material-${String(index).padStart(6, "0")}`;
    many[`field${index}`] = value;
    expected.push(value);
  }
  const manyValues = collectOpenCodeAuthValues(many, []);
  assert.ok(manyValues.length >= 700, "no count truncation");
  for (const value of expected) assert.ok(manyValues.includes(value), `${value} collected`);

  // Key handling: long keys and credential-shaped keys are collected at any
  // depth; short neutral keys are not (they would over-redact everything).
  const keyed = {
    "sk-ant-material-key-0123456789": "value-0123456789",
    apiKey: "value-0123456789",
    type: "oauth",
    nested: { accessToken: "value-0123456789", id: "plain" },
  };
  const keyedValues = collectOpenCodeAuthValues(keyed, []);
  assert.ok(keyedValues.includes("sk-ant-material-key-0123456789"), "long secret-shaped keys collected");
  assert.ok(keyedValues.includes("apiKey"), "credential-shaped keys collected");
  assert.ok(keyedValues.includes("accessToken"), "credential-shaped keys collected at depth");
  assert.ok(keyedValues.includes("value-0123456789"), "values collected");
  assert.ok(!keyedValues.includes("type"), "neutral short keys stay out");
  assert.ok(!keyedValues.includes("nested"), "neutral short keys stay out");
  assert.ok(!keyedValues.includes("id"), "neutral short keys stay out");

  // The sanitizer really removes what was collected.
  const sanitize = createSanitizer({ secrets: [...new Set(keyedValues)] });
  assert.ok(!sanitize(`leak apiKey=abc value-0123456789 end`).includes("apiKey"), "collected key is redacted");
  assert.ok(!sanitize(`leak value-0123456789 end`).includes("value-0123456789"), "collected value is redacted");
  assert.ok(sanitize("type oauth still visible").includes("type oauth"), "unrelated text survives");
});

test("legacy documents convert into deterministic pinned v2 import entries", () => {
  const document = parseOpenCodeAuthDocument({
    openai: {
      type: "oauth",
      accessToken: OAUTH_ACCESS,
      refreshToken: OAUTH_REFRESH,
      expiresAt: 4102444800000,
      accountId: "acct_dummy_000000",
    },
    "opencode-go": { type: "api", key: "sk-dummy-opencode-go-000000000000000000", metadata: { region: "eu" } },
    anthropic: { type: "api", key: "sk-dummy-anthropic-0000000000000000" },
    acme: { type: "wellknown", token: "wellknown-token-0123456789" },
  });

  const entries = buildOpenCodeImportEntries(document);
  assert.deepEqual(entries.map((entry) => entry.integrationID), ["openai", "opencode-go"], "supported providers only");
  for (const entry of entries) {
    assert.equal(entry.id, openCodeCredentialId(entry.integrationID), "id is derived from the provider id");
    assert.equal(entry.id, /^[0-9a-f]{64}$/.test(entry.id) ? entry.id : null, "id is a deterministic hex hash");
    assert.ok(!entry.id.includes("dummy") && !entry.id.includes("sk-"), "ids never embed credential material");
    assert.equal(entry.active, true, "imported entries are active");
  }
  assert.equal(entries[0].label, "OAuth");
  assert.deepEqual(entries[0].value, {
    type: "oauth",
    methodID: "chatgpt-browser",
    refresh: OAUTH_REFRESH,
    access: OAUTH_ACCESS,
    expires: 4102444800000,
    metadata: { accountID: "acct_dummy_000000" },
  });
  assert.equal(entries[1].label, "API key");
  assert.deepEqual(entries[1].value, {
    type: "key",
    key: "sk-dummy-opencode-go-000000000000000000",
    metadata: { region: "eu" },
  });

  // Generic oauth uses the plain `oauth` method id.
  const generic = buildOpenCodeImportEntries(
    parseOpenCodeAuthDocument({ "opencode-go": { type: "oauth", access: OAUTH_ACCESS, refresh: OAUTH_REFRESH } }),
  );
  assert.equal(generic[0].value.methodID, "oauth");

  // wellknown converts to a key credential from its token.
  const wellknown = buildOpenCodeImportEntries(
    parseOpenCodeAuthDocument({ openai: { type: "wellknown", token: "wellknown-token-0123456789" } }),
  );
  assert.deepEqual(wellknown[0].value, { type: "key", key: "wellknown-token-0123456789" });

  // Deterministic across calls, and never throws on unconvertible material.
  assert.deepEqual(
    buildOpenCodeImportEntries(document).map((entry) => entry.id),
    entries.map((entry) => entry.id),
    "ids are stable",
  );
  assert.deepEqual(
    buildOpenCodeImportEntries(parseOpenCodeAuthDocument({ acme: { type: "wellknown", token: "acme-token-0123456789" } })),
    [],
    "unsupported providers convert to nothing",
  );
  assert.throws(() => buildOpenCodeImportEntries(null), /validated auth document/);
});

test("the generated dummy auth document is credential-free and validates through the real path", () => {
  const bytes = dummyOpenCodeAuthBytes();
  assert.ok(bytes.includes(Buffer.from("dummy")), "dummy entries are obviously fake");
  assert.ok(!bytes.includes(Buffer.from(AUTH_SECRET_VALUE)), "never derived from a real credential");

  const document = parseOpenCodeAuthDocument(JSON.parse(bytes.toString("utf8")));
  assert.deepEqual([...document.providers], ["openai", "opencode-go"]);
  assert.deepEqual([...document.supported], [...OPENCODE_AUTH_SUPPORTED_PROVIDERS]);
  assert.deepEqual(document.entries.map((entry) => entry.type), ["api", "api"]);

  const entries = buildOpenCodeImportEntries(document);
  assert.deepEqual(entries.map((entry) => entry.integrationID), ["openai", "opencode-go"]);
  assert.equal(entries[0].label, "API key");
  assert.equal(entries[0].value.type, "key");

  const root = mkdtempSync(path.join(os.tmpdir(), "skill-router-auth-dummy-"));
  try {
    const source = path.join(root, "source-auth.json");
    writeFileSync(source, bytes, { mode: 0o600 });
    chmodSync(source, 0o600);
    const descriptor = resolveOpenCodeAuthFile({ requested: source });
    assert.deepEqual([...descriptor.supported], [...OPENCODE_AUTH_SUPPORTED_PROVIDERS]);
    assert.equal(descriptor.importEntries.length, 2);
    assert.ok(descriptor.values.length > 0);
    assert.ok(
      descriptor.values.every((value) => value.includes("dummy") || ["openai", "opencode-go"].includes(value)),
      "only dummy values and provider-id keys are collected",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
