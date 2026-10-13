import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRunner, parseArgs, repoRoot } from "../scripts/container-harness.mjs";
import {
  PROJECT_DIR,
  ROUTER_TARGET,
  ROUTER_WRAPPER_DIR,
  ROUTER_WRAPPER_FORBIDDEN_ROOTS,
  ROUTER_WRAPPER_SHA256,
  ROUTER_WRAPPER_PATH,
} from "../scripts/container-run-case.mjs";
import {
  AUTH_CHECK_REPORT_FIELDS,
  CONTAINER_FILES,
  DEFAULT_CASE_NETWORK,
  IMAGE_ID_RE,
  ISOLATION_FLAGS,
  LABELS,
  OPENCODE_AUTH_SUPPORTED_PROVIDERS,
  RUNTIME,
  SMOKE_NETWORK,
  TMPFS,
  PlanError,
  assertSafeRunArgv,
  assertSafeRunSpec,
  expandHarnesses,
  expandMatrix,
  isDigestPinned,
  loadMatrix,
  loadPackageMetadata,
  newRunId,
  planAuthCheckRun,
  planBuild,
  planCaseRun,
  planMatrix,
  planSmoke,
  planSmokeRun,
  predictedTarballName,
  resolveBaseImageInfo,
  resolveSpecImage,
  runSpecToArgv,
  validateAuthCheckReport,
  validateSmokeReport,
} from "../scripts/container-lib.mjs";

const manifest = loadMatrix(repoRoot);
const packageMetadata = loadPackageMetadata(repoRoot);

test("repeatable list options also accept comma-separated values", () => {
  const options = parseArgs([
    "run",
    "--case", "claude-select, claude-none",
    "--harness=claude,opencode-v2",
    "--secret-env", "FIRST,SECOND",
  ]);
  assert.deepEqual(options.caseIds, ["claude-select", "claude-none"]);
  assert.deepEqual(options.harnessIds, ["claude", "opencode-v2"]);
  assert.deepEqual(options.secretEnv, ["FIRST", "SECOND"]);
  assert.deepEqual(options.errors, []);
});
const EXPECTED_CASE_IDS = [
  "opencode-v1-select",
  "opencode-v1-none",
  "opencode-v2-select",
  "opencode-v2-none",
  "claude-control",
  "claude-select",
  "claude-none",
];

const EXPECTED_HARNESSES = {
  "opencode-v1": { package: "opencode-ai", version: "1.18.34", binary: "opencode", major: 1, target: "opencode-v1" },
  "opencode-v2": { package: "@opencode/cli", version: "2.0.24", binary: "opencode", major: 2, target: "opencode-v2" },
  claude: { package: "@anthropic-ai/claude-code", version: "2.1.291", binary: "claude", major: 2, target: "claude" },
};

const SYNTHETIC_CONTEXT = "/tmp/skill-router-container-plan/context";
const SYNTHETIC_IID = "/tmp/skill-router-container-plan/iid";
const SYNTHETIC_CID = "/tmp/skill-router-container-plan/cidfiles";

function fakeImageId(seed) {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

test("matrix manifest expands to the seven required cases", () => {
  const cases = expandMatrix(manifest);
  assert.deepEqual(cases.map((entry) => entry.id), EXPECTED_CASE_IDS);
  assert.equal(cases.filter((entry) => entry.harness === "opencode-v1").length, 2);
  assert.equal(cases.filter((entry) => entry.harness === "opencode-v2").length, 2);
  assert.equal(cases.filter((entry) => entry.harness === "claude").length, 3);
  assert.deepEqual(
    [...new Set(cases.filter((entry) => entry.harness === "claude").map((entry) => entry.scenario))].sort(),
    ["control", "none", "select"],
  );
  for (const entry of cases) assert.equal(entry.phase, 2);
});

test("image, package, version, binary, and secret mapping is exact and overridable", () => {
  for (const [id, expected] of Object.entries(EXPECTED_HARNESSES)) {
    const harness = expandHarnesses(manifest).find((entry) => entry.id === id);
    assert.equal(harness.package, expected.package, `${id} package`);
    assert.equal(harness.version, expected.version, `${id} version`);
    assert.equal(harness.binary, expected.binary, `${id} binary`);
    assert.equal(harness.major, expected.major, `${id} major`);
    assert.equal(harness.target, expected.target, `${id} docker target`);
    assert.equal(harness.image, `skill-router/harness:${id}-${expected.version}`);
    assert.ok(Array.isArray(harness.secretAllowlist) && harness.secretAllowlist.length > 0, `${id} secret allowlist`);
  }
  const claude = expandHarnesses(manifest, { harnesses: ["claude"] })[0];
  assert.deepEqual(claude.secretAllowlist, ["CLAUDE_CODE_OAUTH_TOKEN"], "Claude cases accept only the setup-token credential");
  assert.ok(!claude.secretAllowlist.includes("ANTHROPIC_API_KEY"), "Claude cases never inherit an API key in this mode");
  for (const id of ["opencode-v1", "opencode-v2"]) {
    const harness = expandHarnesses(manifest, { harnesses: [id] })[0];
    assert.ok(
      !harness.secretAllowlist.includes("CLAUDE_CODE_OAUTH_TOKEN"),
      `${id} must never receive the Claude OAuth token`,
    );
  }
  assert.ok(
    manifest.secretEnvAllowlist.includes("CLAUDE_CODE_OAUTH_TOKEN"),
    "the OAuth token is globally allowlisted so it can be requested by name",
  );

  const overridden = expandHarnesses(manifest, {
    env: { SKILL_ROUTER_OPENCODE_V1_VERSION: "1.18.99" },
  }).find((entry) => entry.id === "opencode-v1");
  assert.equal(overridden.version, "1.18.99");
  assert.equal(overridden.image, "skill-router/harness:opencode-v1-1.18.99");

  assert.throws(
    () => expandHarnesses(manifest, { env: { SKILL_ROUTER_OPENCODE_V1_VERSION: "latest" } }),
    (error) => error instanceof PlanError && /exact semantic version/.test(error.message),
    "version overrides must be exact pins",
  );
  assert.throws(
    () => expandHarnesses(manifest, { env: { SKILL_ROUTER_IMAGE_PREFIX: "bad prefix!" } }),
    (error) => error instanceof PlanError,
  );
});

test("base image is digest-pinned, and an override is reported as weakened reproducibility", () => {
  assert.ok(isDigestPinned(manifest.baseImage), "manifest base image must carry a sha256 manifest digest");
  assert.match(manifest.baseImage, /^node:22-bookworm-slim@sha256:[0-9a-f]{64}$/);
  const info = resolveBaseImageInfo(manifest, {});
  assert.equal(info.pinned, true);
  assert.equal(info.overridden, false);
  assert.equal(info.image, manifest.baseImage);

  const overridden = resolveBaseImageInfo(manifest, { SKILL_ROUTER_CONTAINER_BASE_IMAGE: "node:22-bookworm-slim" });
  assert.equal(overridden.overridden, true);
  assert.equal(overridden.pinned, false);
  assert.equal(overridden.overrideEnv, "SKILL_ROUTER_CONTAINER_BASE_IMAGE");
});

test("Dockerfile ARG defaults match the manifest pins and the context stays minimal", () => {
  const dockerfile = readFileSync(path.join(repoRoot, CONTAINER_FILES.dockerfile), "utf8");
  const declaredBase = dockerfile.match(/^ARG NODE_IMAGE=(.+)$/m)?.[1];
  assert.equal(declaredBase, manifest.baseImage, "Dockerfile default base must equal the digest pin");

  const sections = dockerfile.split(/^FROM /m);
  for (const [id, expected] of Object.entries(EXPECTED_HARNESSES)) {
    const section = sections.find((chunk) => chunk.startsWith(`harness-common AS ${id}\n`));
    assert.ok(section, `missing Dockerfile target ${id}`);
    assert.ok(section.includes(`ARG HARNESS_PACKAGE=${expected.package}\n`), `${id} HARNESS_PACKAGE`);
    assert.ok(section.includes(`ARG HARNESS_VERSION=${expected.version}\n`), `${id} HARNESS_VERSION`);
    assert.ok(section.includes(`ARG HARNESS_BINARY=${expected.binary}\n`), `${id} HARNESS_BINARY`);
    assert.ok(section.includes(`ARG HARNESS_MAJOR=${expected.major}\n`), `${id} HARNESS_MAJOR`);
    assert.ok(section.includes(`ARG HARNESS_ID=${id}\n`), `${id} HARNESS_ID`);
    assert.ok(section.includes("USER node"), `${id} must run non-root`);
    assert.ok(section.includes("--expect-non-root"), `${id} must verify non-root at build time`);
    assert.ok(section.includes('--harness="${HARNESS_ID}"'), `${id} verifier call must declare the harness id`);
  }
  /**
   * System ripgrep: audited ARG/ENV defaults in the v1 target only, installed
   * while root and before `USER node`, with apt lists removed and both the
   * exact package pin and the bounded reported major asserted at build time.
   */
  const ripgrep = manifest.harnesses["opencode-v1"].ripgrep;
  assert.ok(ripgrep, "matrix must pin the v1 system ripgrep");
  const v1Section = sections.find((chunk) => chunk.startsWith(`harness-common AS opencode-v1\n`));
  assert.ok(v1Section.includes(`ARG RIPGREP_PACKAGE=${ripgrep.package}\n`), "v1 RIPGREP_PACKAGE default");
  assert.ok(v1Section.includes(`ARG RIPGREP_VERSION=${ripgrep.version}\n`), "v1 RIPGREP_VERSION default");
  assert.ok(v1Section.includes(`ARG RIPGREP_MAJOR=${ripgrep.major}\n`), "v1 RIPGREP_MAJOR default");
  assert.ok(v1Section.includes("ENV RIPGREP_PACKAGE=${RIPGREP_PACKAGE} \\\n"), "pin published as image ENV for runtime checks");
  assert.ok(v1Section.includes("RIPGREP_VERSION=${RIPGREP_VERSION} \\\n"), "pin published as image ENV for runtime checks");
  assert.ok(v1Section.includes("RIPGREP_MAJOR=${RIPGREP_MAJOR}"), "bounded major published as image ENV");
  assert.ok(
    v1Section.includes(`"\${RIPGREP_PACKAGE}=\${RIPGREP_VERSION}"`),
    "exact apt pin, never an unversioned install",
  );
  assert.ok(v1Section.includes("rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*"), "apt lists and caches removed");
  assert.ok(v1Section.includes("dpkg-query -W ripgrep"), "installed Debian version is compared to the pin");
  assert.ok(v1Section.includes("test -f /usr/bin/rg"), "rg is a regular file");
  assert.ok(v1Section.includes("test ! -L /usr/bin/rg"), "rg is not a symlink");
  assert.ok(v1Section.includes('test "$(stat -c %U /usr/bin/rg)" = "root"'), "rg is image-root owned");
  assert.ok(v1Section.includes('test "$(stat -c %a /usr/bin/rg)" = "755"'), "rg mode is exactly 0755");
  assert.ok(
    v1Section.includes('grep -Eq "^ripgrep ${RIPGREP_MAJOR}'),
    "reported major is bounded at build time",
  );
  assert.ok(v1Section.includes("command -v rg"), "rg is on PATH");
  const installIndex = v1Section.indexOf("apt-get install -y --no-install-recommends");
  const userIndex = v1Section.search(/^USER node$/m);
  assert.ok(installIndex > 0 && userIndex > 0 && installIndex < userIndex, "ripgrep is installed before USER node");

  // Target isolation: neither the shared stages nor the other two targets gain
  // an rg requirement (they inherit no ripgrep layer and never mention it).
  const sharedSections = ["AS os-base", "AS harness-common"].map(
    (marker) => sections.find((chunk) => chunk.includes(marker)) ?? "",
  );
  for (const chunk of sharedSections) {
    assert.ok(
      !chunk.includes("ripgrep") && !chunk.includes("RIPGREP_"),
      "shared stage (os-base/harness-common) must not install ripgrep",
    );
  }
  for (const id of ["opencode-v2", "claude"]) {
    const section = sections.find((chunk) => chunk.startsWith(`harness-common AS ${id}\n`));
    assert.ok(section, `missing Dockerfile target ${id}`);
    assert.ok(!section.includes("ripgrep"), `${id} must not install ripgrep`);
    assert.ok(!section.includes("RIPGREP_"), `${id} must not declare ripgrep ARG/ENV`);
    assert.ok(!section.includes("/usr/bin/rg"), `${id} must not reference the system rg path`);
    assert.ok(!section.includes("apt-get install"), `${id} must not run apt-get install`);
  }

  assert.ok(dockerfile.includes("COPY container-verify.mjs "), "verifier is copied from the staged context");
  assert.ok(!dockerfile.includes("--from="), "no named build context: the daemon only sees the staged files");
  assert.ok(!/^COPY \./m.test(dockerfile), "build context must not copy the repository");
});

test("build plan emits one docker build per image with pinned args, iidfile, and staged context", () => {
  const plans = planBuild({ manifest, repoRoot, contextDir: SYNTHETIC_CONTEXT, iidDir: SYNTHETIC_IID });
  assert.equal(plans.length, 3);
  for (const plan of plans) {
    const expected = EXPECTED_HARNESSES[plan.harnessId];
    assert.deepEqual(plan.argv.slice(0, 2), ["docker", "build"]);
    assert.equal(plan.argv[plan.argv.indexOf("--file") + 1], path.join(SYNTHETIC_CONTEXT, "Dockerfile"));
    assert.equal(plan.argv[plan.argv.indexOf("--tag") + 1], `skill-router/harness:${plan.harnessId}-${expected.version}`);
    assert.equal(plan.argv[plan.argv.indexOf("--target") + 1], expected.target);
    assert.equal(plan.argv[plan.argv.indexOf("--iidfile") + 1], path.join(SYNTHETIC_IID, `${plan.harnessId}.iid`));
    assert.ok(plan.argv.includes(`HARNESS_PACKAGE=${expected.package}`));
    assert.ok(plan.argv.includes(`HARNESS_VERSION=${expected.version}`));
    assert.ok(plan.argv.includes(`HARNESS_BINARY=${expected.binary}`));
    assert.ok(plan.argv.includes(`HARNESS_MAJOR=${expected.major}`));
    assert.ok(plan.argv.includes(`HARNESS_ID=${plan.harnessId}`));
    assert.ok(plan.argv.includes(`NODE_IMAGE=${manifest.baseImage}`), "digest-pinned base image build arg");
    assert.equal(plan.argv.at(-1), SYNTHETIC_CONTEXT, "context is the staged two-file directory");
    assert.ok(!plan.argv.some((token) => token.startsWith("--build-context")), "named scripts context removed");
    assert.equal(plan.argv.filter((token) => token === "docker").length, 1);
  }
  assert.throws(() => planBuild({ manifest, repoRoot }), /staged contextDir/);
  assert.throws(() => planBuild({ manifest, repoRoot, contextDir: SYNTHETIC_CONTEXT }), /iidDir/);
});

test("matrix plan packs once and creates exactly one fresh docker run per case", () => {
  const runId = newRunId();
  const plan = planMatrix({
    manifest,
    repoRoot,
    packageMetadata,
    destination: "/tmp/plan-workdir",
    runId,
    home: "/Users/nobody-home",
    secretEnvNames: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    cidfileDir: SYNTHETIC_CID,
  });

  assert.equal(plan.pack.argv.slice(0, 2).join(" "), "npm pack");
  assert.equal(plan.pack.argv.filter((token) => token === "pack").length, 1, "pack exactly once");
  const artifact = plan.pack.predictedArtifact;
  assert.equal(path.basename(artifact), predictedTarballName(packageMetadata));

  assert.equal(plan.cases.length, EXPECTED_CASE_IDS.length);
  const runCommands = plan.cases.filter((entry) => entry.argv.slice(0, 2).join(" ") === "docker run");
  assert.equal(runCommands.length, EXPECTED_CASE_IDS.length, "one docker run invocation per case");

  const names = new Set();
  const cidfiles = new Set();
  for (const entry of plan.cases) {
    assert.ok(entry.argv.some((token) => token.includes(artifact)), `${entry.caseId} mounts the shared packed artifact`);
    assert.ok(!names.has(entry.name), "container names are unique");
    names.add(entry.name);
    cidfiles.add(entry.cidfile);
    assert.match(entry.name, new RegExp(`^skill-router-case-${entry.caseId}-${runId}$`));
    assert.ok(entry.argv.includes(`--label=dev.openagency.skill-router.case=${entry.caseId}`));
    assert.ok(entry.argv.includes(`--label=dev.openagency.skill-router.run=${runId}`));
    assert.ok(entry.argv.includes("--pull=never"), "immutable execution: never pull");
    assert.ok(entry.argv.some((token) => token === `--cidfile=${entry.cidfile}`), "cidfile declared per container");
    if (entry.harness === "claude") {
      assert.ok(entry.argv.includes("--env=CLAUDE_CODE_OAUTH_TOKEN"), "Claude secret inherited by name");
      assert.ok(!entry.argv.includes("--env=ANTHROPIC_API_KEY"), "Claude cases never inherit an API key");
      assertSafeRunArgv(entry.argv, { repoRoot, home: "/Users/nobody-home", secretNames: ["CLAUDE_CODE_OAUTH_TOKEN"] });
    } else {
      assert.ok(entry.argv.includes("--env=ANTHROPIC_API_KEY"), "secret inherited by name");
      assert.ok(!entry.argv.includes("--env=CLAUDE_CODE_OAUTH_TOKEN"), "OpenCode cases never inherit the Claude OAuth token");
      assertSafeRunArgv(entry.argv, { repoRoot, home: "/Users/nobody-home", secretNames: ["ANTHROPIC_API_KEY"] });
    }
    assert.equal(entry.spec.imageId, null, "image id is resolved only at execution time");
    assertSafeRunSpec(entry.spec, { repoRoot, home: "/Users/nobody-home", manifest, requireImageId: false });
  }
  assert.equal(names.size, plan.cases.length);
  assert.equal(cidfiles.size, plan.cases.length, "one cidfile per container");
});

test("case runs are isolated, immutable-ready, and never mount repository/HOME/config", () => {
  const entry = expandMatrix(manifest).find((item) => item.id === "opencode-v1-select");
  const artifact = "/tmp/skill-router-pack-abc/openagency.io-skill-router-0.1.0.tgz";
  const run = planCaseRun({
    manifest,
    case: entry,
    artifactPath: artifact,
    runId: newRunId(),
    repoRoot,
    home: process.env.HOME,
    network: DEFAULT_CASE_NETWORK,
  });
  const tokens = run.argv;

  for (const flag of ISOLATION_FLAGS) assert.ok(tokens.includes(flag), `missing ${flag}`);
  assert.ok(tokens.includes("--pull=never"));
  assert.ok(tokens.includes(`--tmpfs=${TMPFS.tmp}`));
  assert.ok(tokens.includes(`--tmpfs=${TMPFS.home}`));
  assert.ok(tokens.includes(`--tmpfs=${TMPFS.workspace}`));
  assert.ok(tokens.includes(`--tmpfs=${TMPFS.install}`));
  assert.ok(tokens.includes(`--user=${RUNTIME.user}`));
  assert.ok(tokens.includes(`--workdir=${RUNTIME.workspace}`));
  assert.ok(tokens.includes(`--network=${DEFAULT_CASE_NETWORK}`));
  assert.ok(tokens.some((token) => token.startsWith("--cidfile=")));

  const bind = tokens.find((token) => token.startsWith("--mount=type=bind"));
  assert.ok(bind, "artifact mount present");
  assert.ok(bind.includes(`src=${artifact}`));
  assert.ok(bind.includes(`dst=${RUNTIME.artifact}`));
  assert.match(bind, /readonly$/, "artifact mount is read-only");

  const home = process.env.HOME ?? "/nonexistent-home";
  for (const token of tokens) {
    assert.ok(!token.includes(repoRoot), `token must not reference the repository: ${token}`);
    assert.ok(!token.includes(home), `token must not reference HOME: ${token}`);
    assert.ok(!/\.skill-router\.json|auth\.json|\.claude\//.test(token), `token must not reference host config: ${token}`);
    assert.ok(!token.startsWith("--privileged"), "no privileged mode");
    assert.ok(!token.includes("docker.sock"), "no docker socket mount");
    assert.ok(token !== "-v" && !token.startsWith("--volume"), "no short volume mounts");
    if (/^--env=(HOME|XDG_)/.test(token)) {
      assert.ok(token.includes("/home/node"), `container-local env only: ${token}`);
    }
  }

  // Typed spec -> immutable execution argv: a mutable tag can never be run.
  const resolved = resolveSpecImage(run.spec, fakeImageId("a1"));
  assert.equal(resolved.imageId, fakeImageId("a1"));
  const liveArgv = runSpecToArgv(resolved);
  assert.ok(liveArgv.includes(fakeImageId("a1")), "live argv executes the sha256 image id");
  assert.ok(!liveArgv.includes(entry.image), "live argv never falls back to the mutable tag");
  assert.throws(() => runSpecToArgv(run.spec), /sha256/);
  assertSafeRunArgv(liveArgv, { repoRoot, requireImageId: true });

  assert.throws(() => assertSafeRunArgv([...tokens.slice(0, -1), "--privileged"]), PlanError);
  assert.throws(
    () => assertSafeRunArgv([...tokens, `--mount=type=bind,src=${repoRoot},dst=${RUNTIME.artifact},readonly`], { repoRoot }),
    /must not mount the host repository/,
  );
  assert.throws(() => assertSafeRunArgv([...tokens, "--env-file=/Users/nobody/.env"]), /forbidden/);
  assert.throws(() => assertSafeRunArgv([...tokens, `--mount=type=bind,src=${artifact},dst=/input/x`]), /read-only/);
});

test("artifact path guards reject repository and HOME sources", () => {
  const entry = expandMatrix(manifest)[0];
  assert.throws(
    () =>
      planCaseRun({
        manifest,
        case: entry,
        artifactPath: path.join(repoRoot, "openagency.io-skill-router-0.1.0.tgz"),
        runId: newRunId(),
        repoRoot,
        home: process.env.HOME,
      }),
    /must not be read from inside the repository/,
  );
  assert.throws(
    () =>
      planCaseRun({
        manifest,
        case: entry,
        artifactPath: path.join(process.env.HOME ?? "", "Downloads", "openagency.io-skill-router-0.1.0.tgz"),
        runId: newRunId(),
        repoRoot,
        home: process.env.HOME,
      }),
    /must not be read from HOME/,
  );
});

test("smoke plan builds every image and verifies exact versions in network-isolated fresh containers", () => {
  const runId = newRunId();
  const plan = planSmoke({
    manifest,
    repoRoot,
    runId,
    contextDir: SYNTHETIC_CONTEXT,
    iidDir: SYNTHETIC_IID,
    cidfileDir: SYNTHETIC_CID,
  });
  assert.equal(plan.builds.length, 3);
  assert.equal(plan.runs.length, 3);

  for (const run of plan.runs) {
    const harness = EXPECTED_HARNESSES[run.harnessId];
    assert.deepEqual(run.argv.slice(0, 2), ["docker", "run"]);
    assert.ok(run.argv.includes(`--network=${SMOKE_NETWORK}`), "smoke needs no network");
    assert.ok(run.argv.includes("--pull=never"));
    assert.ok(run.argv.some((token) => token === `--cidfile=${run.cidfile}`));
    assert.ok(run.argv.includes("--expect-non-root"));
    assert.ok(run.argv.includes(`--package=${harness.package}`));
    assert.ok(run.argv.includes(`--version=${harness.version}`));
    assert.ok(run.argv.includes(`--binary=${harness.binary}`));
    assert.ok(run.argv.includes(`--major=${harness.major}`));
    assert.ok(run.argv.includes(`--harness=${run.harnessId}`));
    assert.ok(run.argv.includes(RUNTIME.verifyScript));
    assert.equal(run.argv.filter((token) => token === "docker").length, 1, "fresh container per harness");
    assert.equal(run.spec.mounts.length, 0, "smoke mounts nothing");
    assertSafeRunArgv(run.argv, { repoRoot, home: process.env.HOME });
    assertSafeRunSpec(run.spec, { manifest, requireImageId: false });
    for (const token of run.argv.filter((value) => value.startsWith("--env="))) {
      const assignment = token.slice("--env=".length);
      const name = assignment.split("=")[0];
      if (manifest.secretEnvAllowlist.includes(name)) {
        assert.fail(`smoke must not carry secret env names: ${token}`);
      }
    }
    const resolved = resolveSpecImage(run.spec, fakeImageId("c9"));
    assert.match(runSpecToArgv(resolved).find((token) => token.startsWith("sha256:")) ?? "", IMAGE_ID_RE);
  }
});

test("runner list and plan are side-effect free (executor never called)", () => {
  const calls = [];
  const output = [];
  const runner = createRunner({
    executor: (argv) => {
      calls.push(argv);
      throw new Error(`executor must not be called, got ${argv.join(" ")}`);
    },
    cwd: repoRoot,
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
    env: { PATH: process.env.PATH ?? "" },
  });

  const listed = runner.list({});
  assert.equal(listed.cases.length, 7);
  assert.equal(listed.harnesses.length, 3);
  assert.ok(output.some((line) => line.includes("digest-pinned multi-arch manifest")));
  assert.ok(output.some((line) => line.includes("native daemon architecture only")));

  const plan = runner.plan({});
  assert.equal(plan.cases.length, 7);
  assert.equal(calls.length, 0, "list/plan must not execute anything");

  const drySmoke = runner.smoke({ dryRun: true });
  assert.equal(drySmoke.runs.length, 3);
  assert.equal(calls.length, 0, "dry-run smoke must not execute anything");

  const dryBuild = runner.build({ dryRun: true });
  assert.equal(dryBuild.length, 3);
  assert.equal(calls.length, 0, "dry-run build must not execute anything");
});

test("runner build refuses when the Docker CLI is missing, with an actionable message", () => {
  const runner = createRunner({
    executor: (argv) => ({
      status: null,
      stdout: "",
      stderr: "",
      signal: null,
      error: Object.assign(new Error(`spawn ${argv[0]} ENOENT`), { code: "ENOENT" }),
    }),
    cwd: repoRoot,
    stdout: () => {},
    stderr: () => {},
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.throws(
    () => runner.build({}),
    (error) => /Docker CLI not found on PATH/.test(error.message) && /Install Docker Desktop/.test(error.message),
  );
});

test("runner build refuses when the daemon is unreachable, with an actionable message", () => {
  const runner = createRunner({
    executor: (argv) => {
      if (argv[1] === "version") {
        return {
          status: 1,
          stdout: "",
          stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
          signal: null,
          error: null,
        };
      }
      return { status: 0, stdout: "", stderr: "", signal: null, error: null };
    },
    cwd: repoRoot,
    stdout: () => {},
    stderr: () => {},
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.throws(
    () => runner.build({}),
    (error) => /daemon is not reachable/.test(error.message) && /Start Docker Desktop/.test(error.message),
  );
});

test("runner rejects unknown case ids before planning", () => {
  const runner = createRunner({
    executor: () => {
      throw new Error("executor must not be called");
    },
    cwd: repoRoot,
    stdout: () => {},
    stderr: () => {},
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.throws(() => runner.plan({ caseIds: ["nope"] }), /unknown case id "nope"/);
});

test("documented container:run npm script exists and resolves to the production runner", () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["container:run"], "node scripts/container-harness.mjs run");
  assert.ok(pkg.scripts["container:run"].endsWith("scripts/container-harness.mjs run"));
  assert.equal(typeof createRunner, "function", "production runner entrypoint is importable from the scripted file");
  const runner = createRunner({
    executor: () => {
      throw new Error("executor must not be called by this test");
    },
    cwd: repoRoot,
    env: { PATH: "" },
    stdout: () => {},
    stderr: () => {},
  });
  assert.equal(typeof runner.run, "function", "runner exposes the production run command the script invokes");
  for (const script of ["container:list", "container:plan", "container:pack", "container:build", "container:smoke", "container:run"]) {
    assert.equal(pkg.scripts[script], `node scripts/container-harness.mjs ${script.split(":")[1]}`, `${script} targets the runner`);
  }
});

/* ---------------- OpenCode credential bind (auth remediation) --------------- */

const AUTH_CREDENTIAL_DIR = "/tmp/skill-router-run-unit/opencode-credential";
const OPENCODE_HARNESS_IDS = ["opencode-v1", "opencode-v2"];
const AUTH_MOUNT_TOKEN = `--mount=type=bind,src=${AUTH_CREDENTIAL_DIR},dst=${RUNTIME.opencodeAuthDir},readonly`;

function authCasePlan(caseId, extra = {}) {
  const descriptor = expandMatrix(manifest).find((entry) => entry.id === caseId);
  return planCaseRun({
    manifest,
    case: descriptor,
    artifactPath: "/tmp/skill-router-pack-unit/openagency.io-skill-router-0.1.0.tgz",
    runId: newRunId(),
    repoRoot,
    home: "/Users/nobody-home",
    cidfile: "/tmp/skill-router-cid/unit.cid",
    authPath: AUTH_CREDENTIAL_DIR,
    credentialDir: AUTH_CREDENTIAL_DIR,
    ...extra,
  });
}

test("OpenCode case specs carry exactly one fixed credential bind; Claude cases never do", () => {
  const plan = planMatrix({
    manifest,
    repoRoot,
    packageMetadata,
    destination: "/tmp/plan-workdir",
    runId: newRunId(),
    home: "/Users/nobody-home",
    secretEnvNames: [],
    cidfileDir: SYNTHETIC_CID,
    authPath: AUTH_CREDENTIAL_DIR,
    credentialDir: AUTH_CREDENTIAL_DIR,
  });
  assert.equal(plan.cases.length, EXPECTED_CASE_IDS.length);

  for (const entry of plan.cases) {
    assertSafeRunSpec(entry.spec, {
      repoRoot,
      home: "/Users/nobody-home",
      manifest,
      credentialDir: AUTH_CREDENTIAL_DIR,
      requireImageId: false,
    });
    const authMounts = entry.argv.filter((token) => token.includes(`dst=${RUNTIME.opencodeAuthDir}`));
    if (entry.harness === "claude") {
      assert.equal(entry.spec.auth, null, `${entry.caseId} carries no auth field`);
      assert.deepEqual(authMounts, [], `${entry.caseId} never mounts credentials`);
      assert.ok(!entry.argv.join(" ").includes("opencode-credential"), `${entry.caseId} never references a credential path`);
    } else {
      assert.deepEqual(
        { ...entry.spec.auth },
        { src: AUTH_CREDENTIAL_DIR, dst: RUNTIME.opencodeAuthDir },
        `${entry.caseId} auth field is the fixed directory bind`,
      );
      assert.deepEqual(authMounts, [AUTH_MOUNT_TOKEN], `${entry.caseId} exactly one fixed credential mount`);
      const artifactIndex = entry.argv.findIndex((token) => token.includes(`dst=${RUNTIME.artifact}`));
      const authIndex = entry.argv.findIndex((token) => token.includes(`dst=${RUNTIME.opencodeAuthDir}`));
      assert.equal(authIndex, artifactIndex + 1, `${entry.caseId} credential bind follows the artifact bind`);
      // Canonical both with and without the typed spec.
      assertSafeRunArgv(entry.argv, {
        repoRoot,
        home: "/Users/nobody-home",
        credentialDir: AUTH_CREDENTIAL_DIR,
        openCodeHarnessIds: OPENCODE_HARNESS_IDS,
        spec: entry.spec,
      });
      assertSafeRunArgv(entry.argv, {
        repoRoot,
        home: "/Users/nobody-home",
        credentialDir: AUTH_CREDENTIAL_DIR,
        openCodeHarnessIds: OPENCODE_HARNESS_IDS,
      });
      assert.deepEqual(
        runSpecToArgv(resolveSpecImage(entry.spec, fakeImageId("a1"))).filter((token) =>
          token.includes(`dst=${RUNTIME.opencodeAuthDir}`),
        ),
        [AUTH_MOUNT_TOKEN],
      );
    }
  }

  // The bind is unusable without this invocation's credential directory.
  const opencodeSpec = plan.cases.find((entry) => entry.harness === "opencode-v1").spec;
  assert.throws(
    () => assertSafeRunSpec(opencodeSpec, { repoRoot, home: "/Users/nobody-home", manifest, requireImageId: false }),
    /credential directory is required/,
  );
  // Without a snapshot request nothing is mounted at all.
  const withoutAuth = planMatrix({
    manifest,
    repoRoot,
    packageMetadata,
    destination: "/tmp/plan-workdir",
    runId: newRunId(),
    home: "/Users/nobody-home",
    cidfileDir: SYNTHETIC_CID,
  });
  for (const entry of withoutAuth.cases) {
    assert.equal(entry.spec.auth, null);
    assert.ok(!entry.argv.some((token) => token.includes(`dst=${RUNTIME.opencodeAuthDir}`)));
  }
});

test("arbitrary, misplaced, or duplicated credential mounts are rejected before the image boundary", () => {
  const valid = authCasePlan("opencode-v1-select");
  const spec = valid.spec;
  const auth = (src, dst = RUNTIME.opencodeAuthDir) => ({ src, dst });

  // Source outside this invocation's credential directory.
  assert.throws(
    () =>
      assertSafeRunSpec(
        { ...spec, auth: auth("/tmp/elsewhere/opencode-credential") },
        { repoRoot, home: "/Users/nobody-home", manifest, credentialDir: AUTH_CREDENTIAL_DIR, requireImageId: false },
      ),
    /must come from this invocation's credential directory/,
  );
  // A nested directory inside the credential directory is not the directory.
  assert.throws(
    () =>
      assertSafeRunSpec(
        { ...spec, auth: auth(path.join(AUTH_CREDENTIAL_DIR, "nested")) },
        { repoRoot, home: "/Users/nobody-home", manifest, credentialDir: AUTH_CREDENTIAL_DIR, requireImageId: false },
      ),
    /must come from this invocation's credential directory/,
  );
  // Repository and HOME sources are rejected even when named like a mount.
  const repoCredentialDir = path.join(repoRoot, ".credential");
  assert.throws(
    () =>
      assertSafeRunSpec(
        { ...spec, auth: auth(repoCredentialDir) },
        { repoRoot, home: "/Users/nobody-home", manifest, credentialDir: repoCredentialDir, requireImageId: false },
      ),
    /host repository/,
  );
  const homeCredentialDir = "/Users/nobody-home/lifecycle/opencode-credential";
  assert.throws(
    () =>
      assertSafeRunSpec(
        { ...spec, auth: auth(homeCredentialDir) },
        { repoRoot, home: "/Users/nobody-home", manifest, credentialDir: homeCredentialDir, requireImageId: false },
      ),
    /host HOME/,
  );
  // Wrong destination and non-absolute source.
  assert.throws(
    () =>
      assertSafeRunSpec(
        { ...spec, auth: auth(AUTH_CREDENTIAL_DIR, "/input/opencode-auth.json") },
        { repoRoot, home: "/Users/nobody-home", manifest, credentialDir: AUTH_CREDENTIAL_DIR, requireImageId: false },
      ),
    /must be mounted at/,
  );
  assert.throws(
    () =>
      assertSafeRunSpec(
        { ...spec, auth: auth("relative/credential-dir") },
        { repoRoot, home: "/Users/nobody-home", manifest, credentialDir: AUTH_CREDENTIAL_DIR, requireImageId: false },
      ),
    /absolute host path/,
  );

  // Claude and smoke specs must never carry one.
  const claudeSpec = authCasePlan("claude-select").spec;
  assert.equal(claudeSpec.auth, null, "planCaseRun drops the request for a Claude case");
  assert.throws(
    () =>
      assertSafeRunSpec(
        { ...claudeSpec, auth: auth(AUTH_CREDENTIAL_DIR) },
        { repoRoot, home: "/Users/nobody-home", manifest, credentialDir: AUTH_CREDENTIAL_DIR, requireImageId: false },
      ),
    /must not receive OpenCode credentials/,
  );
  const smokeSpec = planSmoke({
    manifest,
    repoRoot,
    runId: newRunId(),
    contextDir: SYNTHETIC_CONTEXT,
    iidDir: SYNTHETIC_IID,
    cidfileDir: SYNTHETIC_CID,
  }).runs[0].spec;
  assert.throws(
    () =>
      assertSafeRunSpec(
        { ...smokeSpec, auth: auth(AUTH_CREDENTIAL_DIR) },
        { manifest, credentialDir: AUTH_CREDENTIAL_DIR, requireImageId: false },
      ),
    /only case runs may mount/,
  );

  // Argv-level rejections, without a spec to lean on.
  const argv = valid.argv;
  assert.throws(
    () =>
      assertSafeRunArgv([...argv, AUTH_MOUNT_TOKEN], {
        repoRoot,
        home: "/Users/nobody-home",
        credentialDir: AUTH_CREDENTIAL_DIR,
        openCodeHarnessIds: OPENCODE_HARNESS_IDS,
      }),
    /duplicate credential mount/,
  );
  assert.throws(
    () => assertSafeRunArgv(argv, { repoRoot, home: "/Users/nobody-home", openCodeHarnessIds: OPENCODE_HARNESS_IDS }),
    /credential directory is required to mount OpenCode credentials/,
  );
  assert.throws(
    () =>
      assertSafeRunArgv(argv, {
        repoRoot,
        home: "/Users/nobody-home",
        credentialDir: AUTH_CREDENTIAL_DIR,
        openCodeHarnessIds: [],
      }),
    /only allowed for OpenCode case runs/,
  );
  const foreignSource = argv.map((token) =>
    token.startsWith(`--mount=type=bind,src=${AUTH_CREDENTIAL_DIR}`)
      ? `--mount=type=bind,src=/tmp/other/opencode-credential,dst=${RUNTIME.opencodeAuthDir},readonly`
      : token,
  );
  assert.throws(
    () =>
      assertSafeRunArgv(foreignSource, {
        repoRoot,
        home: "/Users/nobody-home",
        credentialDir: AUTH_CREDENTIAL_DIR,
        openCodeHarnessIds: OPENCODE_HARNESS_IDS,
      }),
    /must come from this invocation's credential directory/,
  );
  const noCaseLabel = argv.filter((token) => !token.startsWith(`--label=${LABELS.case}=`));
  assert.throws(
    () =>
      assertSafeRunArgv(noCaseLabel, {
        repoRoot,
        home: "/Users/nobody-home",
        credentialDir: AUTH_CREDENTIAL_DIR,
        openCodeHarnessIds: OPENCODE_HARNESS_IDS,
      }),
    /only allowed for OpenCode case runs/,
  );
  const claudeArgv = authCasePlan("claude-select").argv;
  assert.throws(
    () =>
      assertSafeRunArgv([...claudeArgv, AUTH_MOUNT_TOKEN], {
        repoRoot,
        home: "/Users/nobody-home",
        credentialDir: AUTH_CREDENTIAL_DIR,
        openCodeHarnessIds: OPENCODE_HARNESS_IDS,
      }),
    /only allowed for OpenCode case runs/,
  );
});

test("auth-check plans a credential-free network-isolated run per OpenCode harness", () => {
  const runId = newRunId();
  for (const id of OPENCODE_HARNESS_IDS) {
    const harness = expandHarnesses(manifest).find((entry) => entry.id === id);
    const plan = planAuthCheckRun({
      manifest,
      harness,
      runId,
      credentialDir: AUTH_CREDENTIAL_DIR,
      cidfile: path.join(SYNTHETIC_CID, `skill-router-authcheck-${id}-${runId}.cid`),
    });
    const argv = plan.argv;
    assert.equal(plan.spec.kind, "case");
    assert.ok(argv.includes("--network=none"), `${id} never reaches the network`);
    assert.ok(argv.includes("--check-opencode-auth"));
    assert.ok(argv.includes(`--providers=${OPENCODE_AUTH_SUPPORTED_PROVIDERS.join(",")}`));
    assert.ok(argv.includes(RUNTIME.verifyScript), `${id} runs the baked-in verifier`);
    assert.deepEqual(
      argv.filter((token) => token.includes(`dst=${RUNTIME.opencodeAuthDir}`)),
      [AUTH_MOUNT_TOKEN],
      `${id} mounts only the generated credential directory`,
    );
    assert.equal(plan.spec.mounts.length, 0, "auth-check mounts nothing else (no artifact)");
    assert.deepEqual([...plan.spec.secretNames], [], "auth-check carries no secret env");
    for (const token of argv.filter((entry) => entry.startsWith("--env="))) {
      const name = token.slice("--env=".length).split("=")[0];
      assert.ok(!manifest.secretEnvAllowlist.includes(name), `auth-check must not request ${name}`);
    }
    assertSafeRunSpec(plan.spec, { manifest, credentialDir: AUTH_CREDENTIAL_DIR, requireImageId: false });
    assertSafeRunArgv(argv, { credentialDir: AUTH_CREDENTIAL_DIR, openCodeHarnessIds: OPENCODE_HARNESS_IDS, spec: plan.spec });
    assertSafeRunArgv(argv, { credentialDir: AUTH_CREDENTIAL_DIR, openCodeHarnessIds: OPENCODE_HARNESS_IDS });
    const live = runSpecToArgv(resolveSpecImage(plan.spec, fakeImageId("c3")));
    assert.ok(live.includes(fakeImageId("c3")), "auth-check executes an immutable image id");
    assert.ok(live.includes("--pull=never"));
  }

  const claudeHarness = expandHarnesses(manifest).find((entry) => entry.id === "claude");
  assert.throws(
    () => planAuthCheckRun({ manifest, harness: claudeHarness, runId: newRunId(), credentialDir: AUTH_CREDENTIAL_DIR }),
    /requires an OpenCode harness/,
  );
  assert.throws(
    () => planAuthCheckRun({ manifest, harness: expandHarnesses(manifest)[0], runId: newRunId(), credentialDir: null }),
    /absolute credential directory/,
  );
});

test("auth-check report validation demands exact fields and neutral metadata", () => {
  const harness = expandHarnesses(manifest).find((entry) => entry.id === "opencode-v1");
  const v2Harness = expandHarnesses(manifest).find((entry) => entry.id === "opencode-v2");
  const validReport = {
    ok: true,
    harnessId: "opencode-v1",
    package: harness.package,
    packageVersion: harness.version,
    binary: "opencode",
    binaryVersion: harness.version,
    major: 1,
    uid: 1000,
    nonRoot: true,
    platform: { os: "linux", arch: "arm64", node: "v22.0.0" },
    providers: ["opencode-go", "openai"],
    recognition: "listed",
    auth: { mode: "snapshot" },
  };
  assert.deepEqual(Object.keys(validReport).sort(), [...AUTH_CHECK_REPORT_FIELDS].sort(), "exact field set");
  const summary = validateAuthCheckReport({ report: validReport, harness });
  assert.deepEqual(summary.providers, ["openai", "opencode-go"]);
  assert.equal(summary.recognition, "listed");
  assert.equal(summary.uid, 1000);

  // The pinned v2 must prove the same thing as v1: a real listing.
  assert.doesNotThrow(() =>
    validateAuthCheckReport({
      report: { ...validReport, harnessId: "opencode-v2", package: v2Harness.package, packageVersion: v2Harness.version, binaryVersion: v2Harness.version, major: 2 },
      harness: v2Harness,
    }),
  );

  const mutations = [
    [{ ...validReport, extra: "path=/tmp/x/auth.json" }, /fields drifted/],
    // The ripgrep verdict is never part of the audited auth-check field set:
    // that seam stages credentials, so the system-ripgrep probe does not run
    // there (the version/smoke path proves it instead).
    [{ ...validReport, ripgrep: "system-ok" }, /fields drifted/],
    [(({ providers, ...rest }) => rest)({ ...validReport }), /fields drifted/],
    [(({ recognition, ...rest }) => rest)({ ...validReport }), /fields drifted/],
    [{ ...validReport, ok: false }, /ok is not true/],
    [{ ...validReport, packageVersion: "9.9.9" }, /packageVersion mismatch/],
    [{ ...validReport, uid: 0 }, /uid mismatch/],
    [{ ...validReport, providers: ["openai"] }, /providers mismatch/],
    [{ ...validReport, providers: ["openai", "anthropic"] }, /providers mismatch/],
    [{ ...validReport, recognition: "staged" }, /recognition must be one of/],
    [{ ...validReport, recognition: "assumed" }, /recognition must be one of/],
    [{ ...validReport, recognition: undefined }, /recognition must be one of/],
    [{ ...validReport, auth: { mode: "snapshot", path: "/tmp/x/auth.json" } }, /auth marker/],
    [{ ...validReport, auth: { mode: "none" } }, /auth marker/],
    [null, /missing or not a JSON object/],
  ];
  for (const [report, pattern] of mutations) {
    assert.throws(() => validateAuthCheckReport({ report, harness }), pattern);
  }
  // The validated summary never carries a path, hash, account label, or value.
  const serialized = JSON.stringify(summary);
  for (const needle of ["sha256", "auth.json", "opencode-credential", "sk-", "accessToken"]) {
    assert.ok(!serialized.includes(needle), `summary leaked ${needle}`);
  }
});

test("every writable tmpfs is explicitly noexec and validated as such", () => {
  // Empirical platform contract: Docker Desktop reports noexec for all four
  // writable mounts even when it is omitted, so we request it explicitly and
  // validate it. Nothing executes from a tmpfs — the router runs through the
  // immutable image-layer wrapper and node only reads package files.
  const options = (spec) => String(spec).split(":").slice(1).join(":");
  assert.equal(Object.keys(TMPFS).length, 4, "four writable mounts");
  for (const [name, spec] of Object.entries(TMPFS)) {
    const destination = String(spec).split(":")[0];
    assert.ok(options(spec).includes("noexec"), `${name} (${destination}) is explicitly noexec`);
    assert.ok(options(spec).includes("nosuid"), `${name} keeps nosuid`);
  }
  assert.equal(TMPFS.workspace.split(":")[0], "/workspace", "workspace tmpfs mounts /workspace");
  assert.equal(TMPFS.install.split(":")[0], RUNTIME.installDir, "install tmpfs mounts the install dir");
  assert.ok(options(TMPFS.tmp).includes("mode=1777"), "/tmp keeps mode=1777");

  const plan = planCaseRun({
    manifest,
    case: expandMatrix(manifest).find((entry) => entry.id === "opencode-v1-select"),
    artifactPath: "/tmp/skill-router-pack-unit/openagency.io-skill-router-0.1.0.tgz",
    runId: newRunId(),
    repoRoot,
    home: "/Users/nobody-home",
    cidfile: "/tmp/skill-router-cid/unit.cid",
  });
  const tmpfsTokens = plan.argv.filter((token) => token.startsWith("--tmpfs="));
  assert.equal(tmpfsTokens.length, 4, "one tmpfs per writable mount");
  for (const token of tmpfsTokens) assert.ok(token.includes("noexec"), `argv tmpfs must be noexec: ${token}`);
  assert.ok(plan.argv.includes("--read-only"));
  assert.ok(plan.argv.includes("--cap-drop=ALL"));
  assert.ok(!plan.argv.some((token) => token.startsWith("--env-file")), "no env-file transport");
  assert.ok(!plan.argv.some((token) => token.includes("opencode-credential")), "no credential mount without a snapshot");
  assert.ok(!plan.argv.some((token) => token.includes(ROUTER_TARGET)), "the package bin never appears in docker argv");

  // The typed spec is validated against the same constants (presence + options)
  // and the argv gate rejects a hand-built option string without noexec.
  assertSafeRunSpec(plan.spec, { manifest, repoRoot, home: "/Users/nobody-home", requireImageId: false });
  for (const entry of plan.spec.tmpfs) assert.ok(String(entry).includes("noexec"), `spec tmpfs must be noexec: ${entry}`);
  assert.throws(
    () =>
      assertSafeRunArgv(
        plan.argv.map((token) => (token === `--tmpfs=${TMPFS.workspace}` ? token.replace(",noexec", "") : token)),
        { repoRoot },
      ),
    /must be noexec/,
  );
});

test("the Dockerfile bakes the wrapper root-owned, mode 0555, with a pinned digest", () => {
  const dockerfile = readFileSync(path.join(repoRoot, CONTAINER_FILES.dockerfile), "utf8");
  const wrapperSource = readFileSync(path.join(repoRoot, CONTAINER_FILES.routerWrapper), "utf8");
  const sha = createHash("sha256").update(wrapperSource).digest("hex");

  assert.equal(sha, ROUTER_WRAPPER_SHA256, "the pinned digest is the staged wrapper source digest");
  const copyLine = "COPY --chown=root:root --chmod=0555 router-wrapper.mjs /usr/local/bin/skill-router";
  assert.ok(dockerfile.includes(copyLine), "wrapper is COPY'd root-owned and mode 0555 at the fixed path");
  assert.equal((dockerfile.match(/COPY --chown=root:root --chmod=0555 router-wrapper\.mjs/g) ?? []).length, 1, "copied exactly once");

  // Shared by all three targets: staged in harness-common, before every target,
  // and re-verified after each target's global package install (no collision).
  const commonIndex = dockerfile.indexOf("AS harness-common");
  const copyIndex = dockerfile.indexOf(copyLine);
  const firstTarget = dockerfile.indexOf("AS opencode-v1");
  assert.ok(commonIndex > 0 && copyIndex > commonIndex, "wrapper COPY is inside harness-common");
  assert.ok(copyIndex < firstTarget, "wrapper exists before every image target");
  assert.equal((dockerfile.match(new RegExp(sha, "g")) ?? []).length, 5, "digest pinned in the header + guard + 3 targets");
  assert.equal(
    (dockerfile.match(/test "\$\(stat -c %a \/usr\/local\/bin\/skill-router\)" = "555"/g) ?? []).length,
    4,
    "mode 0555 is guarded once per shared stage plus each target",
  );
  assert.ok(dockerfile.includes('test "$code" -eq 1'), "build-time executability probe with the fixed expected status");
  // The global harness packages are opencode/claude only: no package ARG ever
  // installs a `skill-router` bin that could replace the wrapper.
  assert.ok(!/HARNESS_PACKAGE=[^\n]*skill-router/.test(dockerfile), "no harness package is the router package");
  assert.equal((dockerfile.match(/HARNESS_PACKAGE=/g) ?? []).length, 3, "three harness packages, none a router package");
  assert.ok(!dockerfile.includes("0777"), "no world-writable modes");
  assert.ok(!dockerfile.includes("--tmpfs"), "tmpfs mounts stay with the runner, never in the Dockerfile");
  // The wrapper source is what the Dockerfile copies: no runtime generation.
  assert.ok(wrapperSource.startsWith("#!/usr/local/bin/node\n"), "staged wrapper keeps its shebang");
});

test("the system ripgrep pin is audited, exact, and confined to the opencode-v1 target", () => {
  const declared = Object.entries(manifest.harnesses)
    .filter(([, harness]) => harness.ripgrep)
    .map(([id]) => id);
  assert.deepEqual(declared, ["opencode-v1"], "only the v1 harness declares an image ripgrep");

  const pin = manifest.harnesses["opencode-v1"].ripgrep;
  assert.equal(pin.package, "ripgrep");
  assert.match(pin.version, /^\d+\.\d+\.\d+-\d+\+[a-z0-9]+$/, "exact Debian package version (13.0.0-4+b2)");
  assert.equal(pin.major, Number.parseInt(pin.version, 10), "bounded major derives from the pinned version");
  assert.equal(pin.binary, "/usr/bin/rg");
  assert.equal(pin.scope, "target-only");
  assert.ok(pin.pinSource.includes("ripgrep") && pin.pinSource.includes("sha256:"), "pin provenance is recorded");
  assert.ok(pin.why.includes("noexec"), "root cause is documented in the manifest itself");

  const dockerfile = readFileSync(path.join(repoRoot, CONTAINER_FILES.dockerfile), "utf8");
  assert.equal((dockerfile.match(/^ARG RIPGREP_VERSION=/gm) ?? []).length, 1, "one audited pin declaration");
  assert.equal((dockerfile.match(/^ARG RIPGREP_PACKAGE=/gm) ?? []).length, 1, "one package declaration");
  assert.equal((dockerfile.match(/^ARG RIPGREP_MAJOR=/gm) ?? []).length, 1, "one bounded major declaration");
  assert.ok(dockerfile.includes(`ARG RIPGREP_PACKAGE=${pin.package}\n`), "Dockerfile package default equals the pin");
  assert.ok(dockerfile.includes(`ARG RIPGREP_VERSION=${pin.version}\n`), "Dockerfile version default equals the pin");
  assert.ok(dockerfile.includes(`ARG RIPGREP_MAJOR=${pin.major}\n`), "Dockerfile major default equals the pin");
  // The pin travels as an ARG default (the build never needs a build-arg), so
  // the Dockerfile and matrix are the two audited copies that must agree.
  assert.equal(
    (dockerfile.match(/apt-get install -y --no-install-recommends/g) ?? []).length,
    2,
    "exactly two apt installs: ca-certificates in os-base and the pinned v1 ripgrep",
  );
  assert.equal(
    (dockerfile.match(/apt-get install -y --no-install-recommends "\$\{RIPGREP_PACKAGE\}/g) ?? []).length,
    1,
    "the ripgrep install happens exactly once, in the v1 target",
  );
  const v1SectionForPaths = dockerfile.split(/^FROM /m).find((chunk) => chunk.startsWith("harness-common AS opencode-v1\n"));
  assert.equal((dockerfile.match(/\/usr\/bin\/rg/g) ?? []).length, 4, "four structural rg checks in the Dockerfile");
  assert.equal(
    (v1SectionForPaths.match(/\/usr\/bin\/rg/g) ?? []).length,
    4,
    "every rg reference lives inside the opencode-v1 target",
  );
  for (const forbidden of ["HARNESS_PACKAGE=ripgrep", "npm install -g ripgrep"]) {
    assert.ok(!dockerfile.includes(forbidden), `no npm path installs ripgrep: ${forbidden}`);
  }

  // The image ENV mirrors the ARGs so runtime checks (build and smoke) compare
  // against the same audited pin without any build-arg plumbing.
  assert.ok(
    dockerfile.includes(
      "ENV RIPGREP_PACKAGE=${RIPGREP_PACKAGE} \\\n    RIPGREP_VERSION=${RIPGREP_VERSION} \\\n    RIPGREP_MAJOR=${RIPGREP_MAJOR}",
    ),
    "one ENV block publishes package, version, and bounded major",
  );
  assert.equal((dockerfile.match(/^ENV RIPGREP_/gm) ?? []).length, 1, "exactly one ENV block, in the v1 target");
});

test("the credential-free smoke seam proves the system ripgrep under network=none", () => {
  const harness = expandHarnesses(manifest).find((entry) => entry.id === "opencode-v1");
  const smoke = planSmokeRun({ manifest, harness, runId: newRunId() });
  assert.ok(smoke.argv.includes("--network=none"), "the smoke container never reaches the network");
  assert.ok(smoke.argv.includes("--expect-non-root"), "the seam runs as uid 1000");
  assert.ok(smoke.argv.includes("--harness=opencode-v1"), "the verifier learns the harness id");
  assert.ok(
    !smoke.argv.includes("--check-opencode-auth"),
    "smoke takes the version path, which is exactly where the ripgrep seam runs",
  );
  assert.ok(smoke.argv.includes(RUNTIME.verifyScript), "smoke runs the baked-in verifier");
  assertSafeRunArgv(smoke.argv, { repoRoot, spec: smoke.spec });
  assertSafeRunSpec(smoke.spec, { manifest, requireImageId: false });

  const verifySource = readFileSync(path.join(repoRoot, CONTAINER_FILES.verifyScript), "utf8");
  assert.ok(
    verifySource.includes('const RIPGREP_REQUIRED_HARNESS = "opencode-v1"'),
    "the seam is gated on the v1 harness id (v2 and Claude require nothing)",
  );
  assert.ok(verifySource.includes("harness !== RIPGREP_REQUIRED_HARNESS"), "non-v1 harnesses are skipped");
  assert.ok(verifySource.includes("!options.checkOpencodeAuth"), "the auth-check field set stays untouched");
  assert.ok(verifySource.includes('"debug", "rg", "files"'), "the pinned internal ripgrep path is executed");
  assert.ok(verifySource.includes('"system-ok"'), "the verdict is the neutral system-ok marker");
  assert.ok(verifySource.includes("RIPGREP_PROBE_FILE"), "the probe project carries one harmless file");
  assert.ok(verifySource.includes("materialized in writable storage"), "a downloaded rg is never accepted");
  assert.ok(verifySource.includes("rmSync(root"), "the probe directory is always removed");
});
