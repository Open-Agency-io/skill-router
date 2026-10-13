// Phase 11 workflow tests: the two GitHub Actions files must parse, stay
// least-privilege, pin every external action to an immutable commit SHA, keep
// workflow context out of shell interpolation, split candidate-controlled work
// away from the job that can write, and never publish to npm.
//
// Every structural assertion walks the *parsed* YAML document, so an anchor, an
// alias, or a flow-style mapping (`{ uses: actions/…@sha }`) is checked exactly
// like a block-style one — no spelling of a step can evade a pin, permission,
// or command check. These are structural assertions only: no workflow is
// executed here, and no live runner, credential, or release is claimed.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WORKFLOW_NAMES = ["ci", "release"];

/** The reviewed, immutable pins each workflow is allowed to use. */
const PINS = {
  "actions/checkout": "3d3c42e5aac5ba805825da76410c181273ba90b1", // v7.0.1
  "actions/setup-node": "949feb2413d6458794dcd2491c4babbbce0c15c1", // v7.1.0
  "actions/upload-artifact": "cf430e030ddbb5b0abf93d22962f4752f3646cd9", // v7.0.2
  "actions/download-artifact": "9000827ccba6bdab643e8b6fd33ac0654aef8333", // v8.0.2
};
const USES_PATTERN = /^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)@([0-9a-f]{40})$/;
const EXPRESSION = /\$\{\{([^}]*)\}\}/g;
/** The only expressions any workflow may contain, anywhere at all. */
const ALLOWED_EXPRESSION =
  /^(?:github\.(?:ref_name|ref|token|workflow)|matrix\.node-version|steps\.[A-Za-z0-9_-]+\.outputs\.[A-Za-z0-9_-]+|needs\.[A-Za-z0-9_-]+\.outputs\.[A-Za-z0-9_-]+)$/;
/** Commands only candidate code could introduce; forbidden outside read-only jobs. */
const CANDIDATE_COMMAND = /\b(?:npm|npx|node|yarn|pnpm|deno)\b/;

function workflow(name) {
  const file = path.join(repository, ".github", "workflows", `${name}.yml`);
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`workflow ${name} is missing: ${error.code}`);
  }
  return { name, file, raw, doc: parse(raw) };
}

/** Deep walk over the parsed document (anchors/aliases/flow style resolved). */
function walk(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      visit(key, child);
      walk(child, visit);
    }
  }
}

/** Every value stored under `key`, at any depth — inline or anchored alike. */
function valuesForKey(doc, key) {
  const found = [];
  walk(doc, (candidate, value) => {
    if (candidate === key) found.push(value);
  });
  return found;
}

/** Every string in the document with the key path that leads to it. */
function stringsWithPath(value, keys = [], found = []) {
  if (typeof value === "string") {
    found.push({ keys, value });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => stringsWithPath(item, [...keys, String(index)], found));
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) stringsWithPath(child, [...keys, key], found);
  }
  return found;
}

function stepsOf(doc) {
  return Object.entries(doc.jobs ?? {}).flatMap(([jobName, job]) =>
    (job.steps ?? []).map((step, stepIndex) => ({ jobName, stepIndex, step })),
  );
}

function runStepsOf(doc) {
  return stepsOf(doc)
    .filter(({ step }) => typeof step.run === "string")
    .map(({ jobName, stepIndex, step }) => ({ jobName, stepIndex, run: step.run, step }));
}

/** The single `run` script of a job (each job owns exactly one shell script). */
function jobRun(doc, jobName) {
  const runs = runStepsOf(doc).filter((entry) => entry.jobName === jobName);
  assert.equal(runs.length, 1, `${jobName}: expected exactly one run step, found ${runs.length}`);
  return runs[0].run;
}

function expressionsIn(doc) {
  return stringsWithPath(doc)
    .filter(({ value }) => value.includes("${{"))
    .flatMap(({ value }) => [...value.matchAll(EXPRESSION)].map((match) => match[1].trim()));
}

test("both workflows parse with read-only defaults, per-job permissions, timeouts, and concurrency", () => {
  for (const name of WORKFLOW_NAMES) {
    const { doc } = workflow(name);
    assert.equal(typeof doc.name, "string", `${name}: workflow needs a name`);
    assert.deepEqual(doc.permissions, { contents: "read" }, `${name}: workflow-level permissions must stay read-only`);
    assert.ok(typeof doc.concurrency?.group === "string" && doc.concurrency.group.length > 0, `${name}: concurrency group required`);
    assert.ok("cancel-in-progress" in doc.concurrency, `${name}: cancel-in-progress must be explicit`);

    assert.deepEqual(Object.keys(doc.on ?? {}), name === "ci" ? ["push", "pull_request"] : ["push"], `${name}: expected triggers`);
    if (name === "ci") assert.deepEqual(doc.on.push.branches, ["main"], "ci: pushes to main are the push trigger");
    if (name === "release") assert.deepEqual(doc.on.push.tags, ["v*"], "release: v* tags are the push trigger");

    const jobNames = Object.keys(doc.jobs ?? {});
    assert.ok(jobNames.length > 0, `${name}: at least one job`);
    for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
      assert.equal(job["runs-on"], "ubuntu-latest", `${name}.${jobName}: no Windows/macOS runner is claimed`);
      assert.ok(
        typeof job["timeout-minutes"] === "number" && job["timeout-minutes"] > 0,
        `${name}.${jobName}: every job needs a timeout`,
      );
      const permissions = job.permissions ?? doc.permissions;
      if (name === "release") {
        assert.deepEqual(
          permissions,
          jobName === "release" ? { contents: "write" } : { contents: "read" },
          `${name}.${jobName}: write only where needed`,
        );
      } else {
        assert.deepEqual(permissions, { contents: "read" }, `${name}.${jobName}: never escalates`);
      }
    }
  }

  const ci = workflow("ci").doc;
  assert.equal(ci.concurrency["cancel-in-progress"], true, "superseded CI runs are cancelled");
  assert.equal(ci.jobs["clean-gate"].needs, "verify", "the expensive clean gate waits for the check/test matrix");

  const release = workflow("release").doc;
  assert.equal(release.concurrency["cancel-in-progress"], false, "a release run is never cancelled midway");
  assert.equal(release.jobs.release.needs, "build", "the write job runs only after the read-only build job");
  const writeJobs = Object.entries(release.jobs)
    .filter(([, job]) => (job.permissions ?? release.permissions)?.contents === "write")
    .map(([jobName]) => jobName);
  assert.deepEqual(writeJobs, ["release"], "exactly one job may ever hold `contents: write`");
});

test("every uses entry, however it is spelled in the YAML, is pinned to a reviewed immutable commit SHA", () => {
  const seen = [];
  for (const name of WORKFLOW_NAMES) {
    const { doc, raw } = workflow(name);
    const uses = valuesForKey(doc, "uses");
    assert.ok(uses.length >= 2, `${name}: expected checkout and setup-node`);

    const rawCount = (raw.match(/\buses\s*:/g) ?? []).length;
    assert.equal(rawCount, uses.length, `${name}: every uses: key in the file must be visible to the parsed-document walk`);

    for (const reference of uses) {
      assert.equal(typeof reference, "string", `${name}: uses must be a string reference`);
      const match = USES_PATTERN.exec(reference);
      assert.ok(match, `${name}: must pin owner/repo@<40-character commit SHA>: ${reference}`);
      const [, action, sha] = match;
      assert.ok(action in PINS, `${name}: unexpected action ${action}`);
      assert.equal(sha, PINS[action], `${name}: ${action} must use the reviewed immutable pin`);
      assert.ok(raw.includes(`${sha} # v`), `${name}: pinned action needs a version comment: ${reference}`);
      seen.push(action);
    }
    assert.ok(!/uses:\s*\S+@(?:v\d|main|master|HEAD|branch)/i.test(raw), `${name}: tag/branch refs are not immutable`);
  }
  assert.deepEqual(
    [...new Set(seen)].sort(),
    ["actions/checkout", "actions/download-artifact", "actions/setup-node", "actions/upload-artifact"],
    "only the four reviewed official actions are used",
  );
});

test("workflow context reaches a shell only through env, and only allowlisted expressions exist", () => {
  for (const name of WORKFLOW_NAMES) {
    const { doc, raw } = workflow(name);

    for (const { jobName, stepIndex, run } of runStepsOf(doc)) {
      assert.ok(
        !run.includes("${{"),
        `${name}.${jobName} step ${stepIndex}: workflow expressions must not be interpolated into a shell command`,
      );
    }
    for (const expression of expressionsIn(doc)) {
      assert.match(expression, ALLOWED_EXPRESSION, `${name}: expression outside the allowlist: ${expression}`);
    }

    // Context that ends up in a shell must arrive as an `env` value, and the
    // only two pieces of privileged context are pinned to named env keys.
    for (const { keys, value } of stringsWithPath(doc)) {
      if (value.includes("github.token")) {
        assert.deepEqual(keys.slice(-2), ["env", "GH_TOKEN"], `${name}: github.token may only be read into env.GH_TOKEN (${keys.join(".")})`);
      }
      if (value.includes("github.ref_name")) {
        assert.deepEqual(keys.slice(-2), ["env", "RELEASE_TAG"], `${name}: github.ref_name may only be read into env.RELEASE_TAG (${keys.join(".")})`);
      }
      if (keys.at(-1) === "run" && value.includes("github.")) {
        assert.fail(`${name}: a run script must not read the github context directly: ${value.slice(0, 120)}`);
      }
    }
    assert.ok(!/^\s*env:.*\$\{\{/.test(raw), `${name}: environment values are plain assignments`);
  }

  const release = workflow("release").doc;
  const build = runStepsOf(release).find(({ run }) => run.includes("gate:release"));
  assert.ok(build, "release: the artifact build step must exist");
  assert.equal(build.step.env.RELEASE_TAG, "${{ github.ref_name }}", "the tag is passed through env, never inline");

  const create = runStepsOf(release).find(({ run }) => run.includes("gh release create"));
  assert.ok(create, "release: the gh release step must exist");
  assert.equal(create.step.env.RELEASE_TAG, "${{ github.ref_name }}");
  assert.equal(create.step.env.GH_TOKEN, "${{ github.token }}");
  assert.ok(create.step.run.includes('"$RELEASE_TAG"'), "the tag is quoted from the environment");
  assert.ok(!create.step.run.includes("github.ref_name"), "the tag expression never appears in the script");
  assert.match(create.step.run, /case "\$RELEASE_TAG" in/, "the tag is re-validated in the script itself");
  assert.match(create.step.run, /\[\[ ! "\$RELEASE_TAG" =~ \^v/, "the tag is re-validated as an exact semantic version too");
  for (const key of ["ARTIFACT_NAME", "ARTIFACT_SIZE", "ARTIFACT_SHA256", "SUMS_SIZE", "SUMS_SHA256"]) {
    assert.ok(
      String(create.step.env[key]).startsWith("${{ needs.build.outputs."),
      `release: ${key} must come from the read-only build job's recorded bundle`,
    );
    assert.ok(create.step.run.includes(`"$${key}"`), `release: ${key} must be quoted in the script`);
  }
});

test("the release workflow confines candidate code to the read-only job and never clobbers an existing release", () => {
  const { doc, raw } = workflow("release");
  const buildRuns = runStepsOf(doc).filter(({ jobName }) => jobName === "build").map(({ run }) => run);
  for (const required of ["npm ci", "npm run check", "npm test", "npm run gate:release"]) {
    assert.ok(
      buildRuns.some((run) => run === required),
      `release: candidate command \`${required}\` must run in the read-only build job`,
    );
  }

  for (const { jobName, run } of runStepsOf(doc)) {
    if (jobName === "build") continue;
    assert.ok(
      !CANDIDATE_COMMAND.test(run),
      `release.${jobName}: the write job must never execute candidate-controlled commands: ${run.slice(0, 120)}`,
    );
    assert.ok(!/checkout|setup-node|scripts\/|\.[cm]?js\b|npmrc/i.test(run), `release.${jobName}: no repository code or toolchain setup`);
    assert.ok(!run.includes("GITHUB_PATH"), `release.${jobName}: a fresh job must not persist PATH additions`);
    assert.ok(!/persist-credentials|GH_TOKEN=.*(curl|wget)/.test(run), `release.${jobName}: no credential plumbing`);
  }

  const buildUses = (doc.jobs.build.steps ?? []).map((step) => step.uses).filter(Boolean);
  const releaseUses = (doc.jobs.release.steps ?? []).map((step) => step.uses).filter(Boolean);
  assert.ok(buildUses.some((use) => use.startsWith("actions/upload-artifact@")), "the build job uploads the bundle");
  assert.deepEqual(
    releaseUses,
    [`actions/download-artifact@${PINS["actions/download-artifact"]}`],
    "the write job's only action is the pinned artifact download — no checkout, no setup-node",
  );
  assert.equal(doc.jobs.build.permissions.contents, "read", "the job that runs candidate code stays read-only");
  assert.equal(doc.jobs.release.permissions.contents, "write", "only the release job may write");

  const upload = (doc.jobs.build.steps ?? []).find((step) => String(step.uses ?? "").startsWith("actions/upload-artifact@"));
  assert.equal(upload.with.name, "release-artifacts", "the bundle has one fixed name");
  assert.equal(upload.with.path, "dist/", "exactly the artifacts directory is transferred");
  assert.equal(upload.with["if-no-files-found"], "error", "an empty bundle must fail the build");
  const download = (doc.jobs.release.steps ?? []).find((step) => String(step.uses ?? "").startsWith("actions/download-artifact@"));
  assert.equal(download.with.name, "release-artifacts");
  assert.equal(download.with.path, "release-assets", "the bundle lands in a fresh directory");

  const script = jobRun(doc, "release");
  const verifyIndex = script.indexOf("sha256sum --check SHA256SUMS");
  const refuseIndex = script.indexOf('if gh release view "$RELEASE_TAG"');
  const createMatch = /^\s*gh release create\b/m.exec(script);
  const enumerateMatch = /^\s*gh api "repos\//m.exec(script);
  assert.ok(verifyIndex >= 0, "the downloaded bundle is checksummed locally");
  assert.ok(refuseIndex > verifyIndex, "local verification happens before anything is published");
  assert.ok(createMatch, "the release is created with the built-in gh CLI");
  assert.ok(enumerateMatch, "the release's assets are read back from the API");
  assert.ok(createMatch.index > refuseIndex, "an existing release is refused before the create step");
  assert.ok(enumerateMatch.index > createMatch.index, "release assets are enumerated after creation");
  assert.ok(!raw.includes("--clobber"), "an existing release is never overwritten");
  assert.ok(!/\bgh release upload\b/.test(raw), "assets are never pushed onto an existing release");
  assert.match(script, /already exists; refusing to overwrite/, "the refusal is explicit and fails the job");
  assert.ok(script.includes("--verify-tag"), "the tag must exist before the release is created");
  assert.ok(script.includes('"$tarball"') && script.includes('"release-assets/SHA256SUMS"'), "only the two files are attached");

  assert.ok(script.includes(".assets[]"), "the API response's asset list is walked");
  assert.ok(
    script.includes('if [ "${#uploaded[@]}" -ne 2 ]; then'),
    "exactly two assets must come back from the server",
  );
  assert.ok(script.includes("expected_size"), "each asset's size is compared with the verified size");
  assert.ok(script.includes("seen_tarball") && script.includes("seen_sums"), "each expected asset name must be seen exactly once");
  assert.ok(script.includes("unexpected asset on the release"), "an extra asset fails the job");
  assert.ok(script.includes('sha256:$expected_sha'), "the server digest is compared when GitHub publishes one");
  assert.ok(script.includes("digests_checked"), "a missing server digest is reported, never assumed");

  assert.ok(!/npm\s+publish/.test(raw), "npm publication is Phase 12 and must not happen here");
  assert.ok(!/NPM_TOKEN|NODE_AUTH_TOKEN|registry-url|--access\s+public/.test(raw), "no npm credential or registry configuration");
  assert.ok(!/\bdocker\b/i.test(raw), "containers are a later gate");
});

test("the release build job records and verifies the exact bundle before it is uploaded", () => {
  const { doc } = workflow("release");
  const build = doc.jobs.build;

  const verify = (build.steps ?? []).find((step) => step["working-directory"] === "dist");
  assert.ok(verify, "the build job verifies SHA256SUMS in dist before uploading");
  assert.equal(verify.run, "sha256sum --check SHA256SUMS", "the local verification must be the exact sha256sum invocation");

  const bundleIndex = (build.steps ?? []).findIndex((step) => step.id === "bundle");
  assert.ok(bundleIndex >= 0, "the build job must record the bundle it hands over");
  const bundle = build.steps[bundleIndex];
  assert.deepEqual(
    Object.keys(build.outputs ?? {}).sort(),
    ["sums_sha256", "sums_size", "tarball_name", "tarball_sha256", "tarball_size"],
    "the five values that define the bundle are the job's outputs",
  );
  for (const [key, value] of Object.entries(build.outputs ?? {})) {
    assert.equal(value, `\${{ steps.bundle.outputs.${key} }}`, `output ${key} must come from the recorded bundle step`);
  }
  assert.ok(!bundle.run.includes("${{"), "the bundle step reads no workflow expression");
  assert.ok(bundle.run.includes("entries=(dist/*)"), "the step enumerates the whole directory, hidden entries included");
  assert.ok(bundle.run.includes('-ne 2'), "it refuses anything other than exactly two entries");
  assert.ok(bundle.run.includes("tarball_name="), "it records the artifact name");
  assert.ok(bundle.run.includes("wc -c"), "it records both sizes");
  assert.ok(bundle.run.includes("sha256sum"), "it records both digests");
  assert.ok(bundle.run.includes('"$GITHUB_OUTPUT"'), "the values are written to the job output file");
  assert.ok(bundle.run.includes("tarballs=(dist/*.tgz)"), "exactly one tarball must be found in dist");

  const uploadIndex = (build.steps ?? []).findIndex((step) => String(step.uses ?? "").startsWith("actions/upload-artifact@"));
  assert.ok(uploadIndex > bundleIndex, "the bundle is recorded and verified before the upload");

  const releaseSteps = doc.jobs.release.steps ?? [];
  const create = releaseSteps.find((step) => typeof step.run === "string");
  const envValues = Object.values(create.env ?? {}).map(String);
  for (const key of Object.keys(build.outputs ?? {})) {
    assert.ok(
      envValues.some((value) => value.includes(`needs.build.outputs.${key}`)),
      `the write job must receive the recorded ${key}`,
    );
  }
});

test("CI checks and tests both Node lines and runs one clean gate, in order", () => {
  const { doc, raw } = workflow("ci");
  const matrix = doc.jobs.verify.strategy.matrix["node-version"].map(String);
  assert.ok(matrix.includes("20"), "the declared engines minimum must be tested");
  assert.ok(matrix.includes("24"), "a current maintained line must be tested");
  assert.equal(matrix.length, 2, "no duplicate Node lines");
  assert.equal(doc.jobs.verify.strategy["fail-fast"], false, "both Node lines must report independently");

  const runs = runStepsOf(doc).map(({ run }) => run);
  for (const required of ["npm ci", "npm run check", "npm test", "npm run gate:clean"]) {
    assert.ok(runs.includes(required), `ci must run \`${required}\``);
  }
  assert.equal(runs.filter((run) => run === "npm run gate:clean").length, 1, "the full clean gate runs exactly once");
  assert.equal(runs.filter((run) => run === "npm test").length, 1, "the test suite is one step, executed per matrix line");
  assert.ok(!runs.includes("npm run gate:release"), "ci never builds release artifacts");

  const verifyRuns = (doc.jobs.verify.steps ?? []).filter((step) => typeof step.run === "string").map((step) => step.run);
  assert.ok(verifyRuns.indexOf("npm ci") < verifyRuns.indexOf("npm run check"), "install precedes the check gate");
  assert.ok(verifyRuns.indexOf("npm run check") < verifyRuns.indexOf("npm test"), "check precedes the test suite");
  assert.ok(!verifyRuns.includes("npm run gate:clean"), "the clean gate is not duplicated inside the matrix");

  const gateRuns = (doc.jobs["clean-gate"].steps ?? []).filter((step) => typeof step.run === "string").map((step) => step.run);
  assert.deepEqual(gateRuns, ["npm run gate:clean"], "the gate job does exactly one thing");
  assert.equal(doc.jobs["clean-gate"].needs, "verify", "dependency ordering is explicit");

  const checkouts = stepsOf(doc).filter(({ step }) => String(step.uses ?? "").startsWith("actions/checkout@"));
  assert.equal(checkouts.length, 2, "both jobs check out cleanly");
  for (const { step } of checkouts) {
    assert.equal(step.with["persist-credentials"], false, "candidate code must never see a persisted token");
  }

  const packageJson = JSON.parse(readFileSync(path.join(repository, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["gate:clean"], "node scripts/clean-candidate.mjs", "the CI gate command must exist locally");
  assert.equal(packageJson.scripts["gate:release"], "node scripts/release-dist.mjs", "the release command must exist locally");

  assert.ok(!/npm\s+publish/.test(raw), "ci never publishes");
  assert.ok(!/\bdocker\b/i.test(raw), "containers are a later gate");
});
