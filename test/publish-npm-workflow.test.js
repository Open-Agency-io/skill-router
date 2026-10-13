// Phase 12 workflow tests: the manual-only npm staging workflow must parse,
// stay dormant, keep exactly the OIDC permissions it needs, pin its single
// action, never check out or execute repository code, hold no npm or
// long-lived token, and never publish — only `npm stage publish` the exact
// release tarball it proved.
//
// The three things this suite exists to discriminate, matching the independent
// review's blockers:
//   1. the *remote* release asset contract is proven before anything is
//      downloaded (repository identity, exact tag, draft/prerelease, exactly
//      the two expected asset names, no duplicates/extras/renames, bounded
//      sizes, well-formed server digests) — exercised end to end against a
//      stubbed `gh`;
//   2. no checksum file ever becomes a path that is opened: SHA256SUMS is
//      read by descriptor, matched as one exact line against the *expected*
//      name, and only compared — proven with sentinel and FIFO fixtures;
//   3. the archive parser is deliberately strict about the exact npm-pack
//      shape (POSIX ustar only, canonical `package/` names, exact terminator,
//      bounded members) and refuses pax/GNU/link/device/unknown members.
//
// Everything is static or hermetic: the workflow YAML is parsed with the
// repository's own `yaml` dependency, the verifier is executed against
// archives this file builds itself, and the whole two-step pipeline runs
// against stubbed `gh` and `npm` binaries. No network, no credentials, no
// registry, and no live publish is involved, and no test writes outside
// `node_modules/.phase12-tmp`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { parse } from "yaml";

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WORKFLOWS = path.join(repository, ".github", "workflows");

/** The only action this workflow may use, and its reviewed immutable pin. */
const SETUP_NODE_SHA = "949feb2413d6458794dcd2491c4babbbce0c15c1"; // v7.1.0
const USES_PATTERN = /^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)@([0-9a-f]{40})$/;
const EXPRESSION = /\$\{\{([^}]*)\}\}/g;
/** The only expressions the publish workflow may contain, anywhere. */
const ALLOWED_EXPRESSION =
  /^(?:github\.token|github\.event\.inputs\.release_tag|steps\.verify\.outputs\.[a-z][a-z0-9_]*)$/;

const NPM_VERSION = "11.20.0";
const PACKAGE_NAME = "@openagency.io/skill-router";
const ORGANISATION_REPO = "Open-Agency-io/skill-router";
const RELEASE_TAG = "v0.1.0";
const PACKAGE_VERSION = "0.1.0";
const TARBALL_NAME = "openagency.io-skill-router-0.1.0.tgz";
const REPOSITORY_URL = "git+https://github.com/Open-Agency-io/skill-router.git";
const HOMEPAGE_URL = "https://github.com/Open-Agency-io/skill-router#readme";
const BUGS_URL = "https://github.com/Open-Agency-io/skill-router/issues";
const REGISTRY_URL = "https://registry.npmjs.org/";
const STAGE_COMMAND =
  'npm stage publish "./release-assets/${TARBALL_NAME}" --access public --tag latest --ignore-scripts';
const VERIFY_MARKER = "PUBLISH_NPM_VERIFY_EOF";
const VERIFIER_FILE = ".phase12-publish-verify.cjs";

/** The nine outputs the verify step hands to the stage step. */
const OUTPUT_KEYS = [
  "package_name",
  "package_version",
  "sums_mode",
  "sums_sha256",
  "sums_size",
  "tarball_mode",
  "tarball_name",
  "tarball_sha256",
  "tarball_size",
];

/** Lifecycle scripts a staged tarball must never carry. */
const FORBIDDEN_LIFECYCLE = [
  "install",
  "preinstall",
  "postinstall",
  "prepare",
  "prepack",
  "postpack",
  "prepublish",
  "prepublishOnly",
  "publish",
  "postpublish",
];

/** Context-derived shell variables that must never reach a bare word. */
const CONTEXT_NAMES = [
  "RELEASE_TAG",
  "TARBALL_NAME",
  "TARBALL_SIZE",
  "TARBALL_SHA256",
  "TARBALL_MODE",
  "SUMS_SIZE",
  "SUMS_SHA256",
  "SUMS_MODE",
  "PACKAGE_VERSION",
  "PACKAGE_NAME",
  "GITHUB_REPOSITORY",
  "GITHUB_OUTPUT",
];

const packageJson = JSON.parse(readFileSync(path.join(repository, "package.json"), "utf8"));
const packageLock = JSON.parse(readFileSync(path.join(repository, "package-lock.json"), "utf8"));

function workflow(name) {
  const file = path.join(WORKFLOWS, `${name}.yml`);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`workflow ${name}.yml is missing: ${error.code}`);
  }
  return { name, file, text, doc: parse(text) };
}

const publish = workflow("publish-npm");

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

function runStep(id) {
  const found = runStepsOf(publish.doc).find((entry) => entry.step.id === id);
  assert.ok(found, `the workflow must have a run step with id ${id}`);
  return found.run;
}

function expressionsIn(doc) {
  const found = [];
  const walk = (value, keys = []) => {
    if (typeof value === "string") {
      if (value.includes("${{")) {
        for (const match of value.matchAll(EXPRESSION)) found.push({ keys, expression: match[1].trim() });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, [...keys, String(index)]));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) walk(child, [...keys, key]);
    }
  };
  walk(doc);
  return found;
}

/** True when `index` sits inside a double-quoted region of `line`. */
function insideDoubleQuotes(line, index) {
  let quotes = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (line[cursor] === "\\") {
      cursor += 1;
      continue;
    }
    if (line[cursor] === '"') quotes += 1;
  }
  return quotes % 2 === 1;
}

/** Every context-derived variable must be quoted, or be a pure assignment. */
function assertContextQuoted(script, label) {
  for (const line of script.split("\n")) {
    for (const name of CONTEXT_NAMES) {
      const pattern = new RegExp(`\\$\\{?${name}\\b`, "g");
      for (const match of line.matchAll(pattern)) {
        const before = line.slice(0, match.index);
        if (insideDoubleQuotes(line, match.index)) continue;
        if (before.endsWith("=")) continue; // e.g. version=${RELEASE_TAG#v}
        assert.fail(`${label}: unquoted context variable in: ${line.trim()}`);
      }
    }
  }
}

/** Shell comment lines carry documentation; assertions on executable text
 *  must ignore them (they may legitimately say "no curl, no wget"). */
function executable(script) {
  return script
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/** Markers that must appear in this exact order inside a run script. */
function assertOrder(script, markers, label) {
  let previous = -1;
  let previousName = "(start)";
  for (const [name, pattern] of markers) {
    const index = script.search(pattern);
    assert.ok(index >= 0, `${label} is missing: ${name}`);
    assert.ok(index > previous, `${name} must come after ${previousName}`);
    previous = index;
    previousName = name;
  }
}

// ---------------------------------------------------------------------------
// Scratch space: repository-local, gitignored, and removed afterwards.
// ---------------------------------------------------------------------------

const scratchRoot = path.join(repository, "node_modules", ".phase12-tmp", "test");
mkdirSync(scratchRoot, { recursive: true });
const scratchDirs = [];

function scratch(prefix) {
  const dir = mkdtempSync(path.join(scratchRoot, prefix));
  scratchDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  rmSync(scratchRoot, { recursive: true, force: true });
});

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// ---------------------------------------------------------------------------
// The strict verifier, extracted from the workflow heredoc and run directly.
// ---------------------------------------------------------------------------

let verifierFile;

function verifierPath() {
  if (!verifierFile) {
    const verify = runStep("verify");
    const match = new RegExp(`<<'${VERIFY_MARKER}'\\n([\\s\\S]*?)\\n${VERIFY_MARKER}`).exec(verify);
    assert.ok(match, "the verify step must write the strict verifier from a quoted heredoc");
    const dir = scratch("verifier-");
    verifierFile = path.join(dir, VERIFIER_FILE);
    writeFileSync(verifierFile, `${match[1]}\n`);
  }
  return verifierFile;
}

function readOutputs(file) {
  const outputs = {};
  if (!existsSync(file)) return outputs;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    const index = line.indexOf("=");
    outputs[line.slice(0, index)] = line.slice(index + 1);
  }
  return outputs;
}

function runVerifier(mode, bundle, { version = PACKAGE_VERSION, name = PACKAGE_NAME, env = {} } = {}) {
  const output = path.join(bundle.dir, "outputs");
  rmSync(output, { force: true });
  const base = {
    TARBALL_PATH: bundle.tarballPath,
    SUMS_PATH: bundle.sumsPath,
    EXPECTED_TARBALL_NAME: bundle.tarballName,
    EXPECTED_VERSION: version,
    EXPECTED_PACKAGE_NAME: name,
    GITHUB_OUTPUT: output,
  };
  if (mode === "verify") {
    Object.assign(base, {
      REMOTE_TARBALL_SIZE: String(bundle.bytes.length),
      REMOTE_TARBALL_DIGEST: `sha256:${bundle.tarballSha}`,
      REMOTE_SUMS_SIZE: String(bundle.sumsBytes.length),
      REMOTE_SUMS_DIGEST: `sha256:${bundle.sumsSha}`,
    });
  } else {
    assert.ok(bundle.recorded, "reverify needs recorded identities from a verify run");
    Object.assign(base, {
      EXPECTED_TARBALL_SIZE: bundle.recorded.tarball_size,
      EXPECTED_TARBALL_SHA256: bundle.recorded.tarball_sha256,
      EXPECTED_TARBALL_MODE: bundle.recorded.tarball_mode,
      EXPECTED_SUMS_SIZE: bundle.recorded.sums_size,
      EXPECTED_SUMS_SHA256: bundle.recorded.sums_sha256,
      EXPECTED_SUMS_MODE: bundle.recorded.sums_mode,
    });
  }
  const result = spawnSync(process.execPath, [verifierPath(), mode], {
    encoding: "utf8",
    env: { ...process.env, ...base, ...env },
    timeout: 30000,
  });
  return { ...result, outputs: readOutputs(output) };
}

/** Build a release-assets directory holding a tarball and its SHA256SUMS. */
function bundleFixture({
  entries,
  tarballName = TARBALL_NAME,
  rawTarball,
  gzip = true,
  sumsText,
  extraFiles = {},
} = {}) {
  const dir = scratch("bundle-");
  const release = path.join(dir, "release-assets");
  mkdirSync(release, { recursive: true });
  const tarballPath = path.join(release, tarballName);
  const bytes = rawTarball ?? (gzip ? zlib.gzipSync(buildArchive(entries)) : buildArchive(entries));
  writeFileSync(tarballPath, bytes);
  const sumsBytes = Buffer.from(sumsText ?? `${sha256(bytes)}  ${tarballName}\n`);
  writeFileSync(path.join(release, "SHA256SUMS"), sumsBytes);
  for (const [name, content] of Object.entries(extraFiles)) {
    writeFileSync(path.join(release, name), content);
  }
  const bundle = {
    dir,
    release,
    tarballPath,
    sumsPath: path.join(release, "SHA256SUMS"),
    tarballName,
    bytes,
    sumsBytes,
    tarballSha: sha256(bytes),
    sumsSha: sha256(sumsBytes),
  };
  return bundle;
}

function refused(result, pattern, label = "") {
  const prefix = label ? `${label}: ` : "";
  assert.ok(result.error === undefined, `${prefix}the verifier must not fail to run: ${result.error}`);
  assert.notEqual(result.status, 0, `${prefix}expected refusal, got: ${result.stdout}`);
  assert.match(result.stderr, pattern, prefix);
}

function accepted(result) {
  assert.equal(result.status, 0, `expected acceptance, got: ${result.stderr}`);
}

// ---------------------------------------------------------------------------
// A faithful npm-pack tar builder: POSIX ustar, node-tar's numeric field
// spelling (zero-padded octal, then a space and a NUL), uid/gid left as NUL
// bytes, `ustar` + NUL + `00` magic, and a sealed header checksum.
// ---------------------------------------------------------------------------

function writeNumericField(header, offset, length, value) {
  const digits = length - 2;
  const text = value.toString(8);
  if (text.length > digits) throw new Error(`value ${value} does not fit in ${digits} octal digits`);
  header.write(text.padStart(digits, "0"), offset, digits, "latin1");
  header[offset + digits] = 0x20;
  header[offset + digits + 1] = 0x00;
}

function headerChecksum(header) {
  let sum = 0;
  for (let index = 0; index < 512; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  return sum;
}

function sealChecksum(header) {
  writeNumericField(header, 148, 8, headerChecksum(header));
}

function tarEntry(entry) {
  const body = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content ?? "", "utf8");
  const header = Buffer.alloc(512);
  if (entry.nameBytes) entry.nameBytes.copy(header, 0);
  else header.write(entry.name, 0, 100, "utf8");
  writeNumericField(header, 100, 8, entry.mode ?? 0o644);
  // uid (108..116) and gid (116..124) stay NUL bytes, exactly as npm writes them.
  writeNumericField(header, 124, 12, entry.size ?? body.length);
  writeNumericField(header, 136, 12, entry.mtime ?? 499156500);
  header.write("        ", 148, 8, "latin1");
  header[156] = entry.typeCode ?? (entry.type ?? "0").charCodeAt(0);
  if (entry.linkname) header.write(entry.linkname, 157, 100, "utf8");
  header[257] = 0x75; // u
  header[258] = 0x73; // s
  header[259] = 0x74; // t
  header[260] = 0x61; // a
  header[261] = 0x72; // r
  header[262] = 0x00; // NUL
  header.write("00", 263, 2, "latin1");
  writeNumericField(header, 329, 8, 0);
  writeNumericField(header, 337, 8, 0);
  sealChecksum(header);
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

function buildArchive(entries, { terminator = 1024 } = {}) {
  return Buffer.concat([...entries.map(tarEntry), Buffer.alloc(terminator)]);
}

/** Byte offset of the `index`-th member header inside a built archive. */
function memberOffsets(archive) {
  const offsets = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    offsets.push(offset);
    const digits = archive
      .subarray(offset + 124, offset + 136)
      .toString("latin1")
      .split(/[^0-7]/)
      .filter(Boolean)
      .join("");
    const size = Number.parseInt(digits || "0", 8);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return offsets;
}

/** Edit one member header (and re-seal the checksum unless told otherwise). */
function patchArchive(archive, index, edit, { seal = true } = {}) {
  const offset = memberOffsets(archive)[index];
  const header = archive.subarray(offset, offset + 512);
  edit(header);
  if (seal) sealChecksum(header);
  return archive;
}

function manifestJson(overrides = {}) {
  return JSON.stringify(
    {
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      repository: { type: "git", url: REPOSITORY_URL },
      homepage: HOMEPAGE_URL,
      bugs: { url: BUGS_URL },
      publishConfig: { registry: REGISTRY_URL, access: "public", tag: "latest" },
      bin: { "skill-router": "./src/cli.js" },
      ...overrides,
    },
    null,
    2,
  );
}

const MANIFEST_ENTRY = { name: "package/package.json", content: manifestJson() };
const CLI_ENTRY = { name: "package/src/cli.js", content: "#!/usr/bin/env node\n" };

// ---------------------------------------------------------------------------

test("the publish workflow is manual-only with least-privilege permissions", () => {
  const { doc, text } = publish;
  assert.equal(typeof doc.name, "string", "the workflow needs a name");

  assert.deepEqual(
    Object.keys(doc.on ?? {}),
    ["workflow_dispatch"],
    "workflow_dispatch is the only trigger: no push, tag, release, or schedule",
  );
  const inputs = doc.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs), ["release_tag"], "exactly one required input");
  assert.equal(inputs.release_tag.required, true, "the release tag is mandatory");
  assert.equal(inputs.release_tag.type, "string");
  assert.deepEqual(Object.keys(doc.on.workflow_dispatch), ["inputs"], "workflow_dispatch carries inputs only");

  assert.deepEqual(doc.permissions, { contents: "read" }, "workflow-level permissions stay read-only");

  const jobs = Object.entries(doc.jobs ?? {});
  assert.equal(jobs.length, 1, "exactly one job");
  const [jobName, job] = jobs[0];
  assert.equal(job["runs-on"], "ubuntu-latest", "GitHub-hosted Ubuntu only");
  assert.ok(typeof job["timeout-minutes"] === "number" && job["timeout-minutes"] > 0, "a job timeout is required");
  assert.deepEqual(Object.keys(job.permissions ?? {}).sort(), ["contents", "id-token"], "exactly two permissions");
  assert.equal(job.permissions.contents, "read");
  assert.equal(job.permissions["id-token"], "write", "OIDC needs id-token: write");
  assert.ok(typeof doc.concurrency?.group === "string" && doc.concurrency.group.length > 0, "concurrency group");
  assert.equal(doc.concurrency["cancel-in-progress"], false, "a staging run is never cancelled midway");
  assert.ok(jobName === "stage", "the job stages the release tarball");
  assert.ok(text.length > 0);
});

test("the sole action is the pinned setup-node and nothing is checked out", () => {
  const { doc, text } = publish;
  const uses = stepsOf(doc).map(({ step }) => step.uses).filter(Boolean);
  assert.equal(uses.length, 1, "exactly one action step");
  const match = USES_PATTERN.exec(uses[0]);
  assert.ok(match, `actions must pin owner/repo@<40-hex>: ${uses[0]}`);
  assert.equal(match[1], "actions/setup-node");
  assert.equal(match[2], SETUP_NODE_SHA, "the reviewed immutable pin");
  assert.ok(text.includes(`${SETUP_NODE_SHA} # v7.1.0`), "the pin carries its version comment");
  assert.ok(!/uses:\s*\S+@(v\d|main|master|HEAD)/.test(text), "no floating tag or branch ref");
  assert.ok(
    !/actions\/checkout|actions\/download-artifact|actions\/upload-artifact/.test(text),
    "no checkout or transfer action",
  );

  const setup = stepsOf(doc).find(({ step }) => step.uses).step;
  assert.equal(setup.with["node-version"], "24", "Node 24");
  assert.equal(setup.with["registry-url"], "https://registry.npmjs.org", "the public npm registry");
  assert.ok(!setup.with.cache, "dependency caching is disabled");

  for (const { run, step } of runStepsOf(doc)) {
    const label = `step ${step.id ?? step.name}`;
    assert.ok(!run.includes("${{"), `${label}: workflow expressions never reach a shell`);
    assert.ok(!/\bnpm ci\b|\bnpm test\b|\bnpm run\b/.test(run), `${label}: no candidate or dependency command runs`);
    assert.ok(!/checkout|scripts\/|\bsrc\/|\btest\/|\.mjs\b|GITHUB_PATH/.test(run), `${label}: no repository code or PATH write`);
    assert.ok(
      !/\bnpm install\b/.test(run.replace(/npm install --global npm@\d+\.\d+\.\d+/, "")),
      `${label}: the only install is the pinned global npm`,
    );
    assert.ok(
      !/\bsha256sum\b|\bshasum\b|\bopenssl\b|\btar\s+-|\bcurl\b|\bwget\b/.test(executable(run)),
      `${label}: no external checker, archiver, or fetcher`,
    );
  }
  assert.ok(!/persist-credentials/.test(text), "there is no checkout to persist");
});

test("the repository identity gates every GitHub call, and no npm token exists", () => {
  const { doc, text } = publish;
  const executable = text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert.ok(
    !/NPM_TOKEN|NODE_AUTH_TOKEN|_authToken|--otp|secrets\.|\b--token\b/i.test(executable),
    "no npm token, OTP, or secret reference in executable text",
  );
  assert.ok(!/\bcurl\b|\bwget\b/.test(executable), "assets come from gh, not an ad-hoc client");
  assert.equal((text.match(/id-token/g) ?? []).length, 1, "id-token appears exactly once, as the OIDC permission");

  const tokenValues = [];
  for (const { keys, expression } of expressionsIn(doc)) {
    if (expression.includes("github.token")) tokenValues.push(keys);
    if (expression.includes("github.event.inputs")) {
      assert.deepEqual(keys.slice(-2), ["env", "RELEASE_TAG"], "the release tag is read into env.RELEASE_TAG");
    }
    if (expression.includes("steps.verify.outputs.")) {
      assert.deepEqual(keys.slice(0, 5), ["jobs", "stage", "steps", "3", "env"], "outputs reach the stage step only through env");
    }
    if (keys.at(-1) === "run") assert.fail("a run script must not read the github context directly");
  }
  assert.deepEqual(
    tokenValues,
    [["jobs", "stage", "steps", "2", "env", "GH_TOKEN"]],
    "github.token is read into exactly one env.GH_TOKEN",
  );

  const verify = runStep("verify");
  const stage = runStep("stage");
  assert.ok(!/\$GH_TOKEN|\$\{GH_TOKEN\}|GITHUB_TOKEN/.test(verify), "the token is never expanded by a script");
  assert.ok(!/\$GH_TOKEN|\$\{GH_TOKEN\}|GITHUB_TOKEN/.test(stage), "the staging step never sees a token");
  assert.ok(!/\bgh\b/.test(stage), "the staging step performs no GitHub operation");

  // The repository identity is checked before the first `gh` call.
  const repoIndex = verify.indexOf('!= "Open-Agency-io/skill-router"');
  const firstGh = verify.search(/\bgh\s/);
  assert.ok(repoIndex >= 0, "the workflow pins GITHUB_REPOSITORY to its own repository");
  assert.ok(firstGh > repoIndex, "the repository identity is proven before any gh call");

  const ghLines = verify
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /\bgh /.test(line));
  assert.equal(ghLines.length, 2, `exactly two gh invocations: ${ghLines.join(" | ")}`);
  assert.match(ghLines[0], /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/releases\/tags\/\$\{RELEASE_TAG\}" --jq/);
  assert.match(ghLines[1], /^gh release download "\$RELEASE_TAG" --repo "\$GITHUB_REPOSITORY" /);
  assert.ok(!/gh release (create|upload|delete|edit)/.test(text), "the workflow never touches the release");
});

test("npm is installed at exactly 11.20.0 and re-verified", () => {
  const pin = runStepsOf(publish.doc).find(({ run }) => run.includes("npm install --global npm@"));
  assert.ok(pin, "the workflow pins npm explicitly");
  assert.match(pin.run, /npm install --global npm@11\.20\.0 --no-audit --no-fund/);
  assert.match(pin.run, /\[ "\$installed" != "11\.20\.0" \]/, "the installed version is asserted");
  const versions = [...publish.text.matchAll(/npm@\d+\.\d+\.\d+/g)].map((match) => match[0]);
  assert.deepEqual(versions, [`npm@${NPM_VERSION}`], "exactly one npm version is ever named");
  const setup = stepsOf(publish.doc).find(({ step }) => step.uses).step;
  assert.equal(setup.with["node-version"], "24");
});

test("context reaches the shell only through env, and every variable is quoted", () => {
  const { doc } = publish;
  for (const expression of expressionsIn(doc)) {
    assert.match(expression.expression, ALLOWED_EXPRESSION, `expression outside the allowlist: ${expression.expression}`);
  }
  const verifyStep = runStepsOf(doc).find((entry) => entry.step.id === "verify").step;
  assert.equal(verifyStep.env.GH_TOKEN, "${{ github.token }}");
  assert.equal(verifyStep.env.RELEASE_TAG, "${{ github.event.inputs.release_tag }}");

  const stageStep = runStepsOf(doc).find((entry) => entry.step.id === "stage").step;
  const stageEnv = Object.entries(stageStep.env);
  assert.deepEqual(
    stageEnv.map(([key]) => key.toLowerCase()).sort(),
    OUTPUT_KEYS.slice().sort(),
    "the stage step receives exactly the nine recorded values",
  );
  for (const [key, value] of stageEnv) {
    assert.match(String(value), /^\$\{\{ steps\.verify\.outputs\.[a-z][a-z0-9_]* \}\}$/, `stage env ${key} comes from the verify step`);
  }

  for (const { run, step } of runStepsOf(doc)) {
    assertContextQuoted(run, `step ${step.id ?? step.name}`);
  }
});

test("the verify step proves the remote contract before downloading, then inspects the archive", () => {
  const verify = runStep("verify");
  assertOrder(
    verify,
    [
      ["repository identity", /!= "Open-Agency-io\/skill-router"/],
      ["tag shape check", /case "\$RELEASE_TAG" in/],
      ["exact stable semver", /\[\[ ! "\$RELEASE_TAG" =~ \^v\(0\|\[1-9\]\[0-9\]\*\)/],
      ["expected tarball name", /expected_name="\$\{unscoped_name\/\/\\\/\/-\}-\$\{version\}\.tgz"/],
      ["release query", /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/releases\/tags\/\$\{RELEASE_TAG\}"/],
      ["bounded response", /\$\{#contract\}" -gt 4096/],
      ["five fields", /contract_fields\[@\]\}" -ne 5/],
      ["exact tag", /contract_fields\[0\]\}" != "\$RELEASE_TAG"/],
      ["draft refusal", /refusing a draft release/],
      ["prerelease refusal", /refusing a prerelease release for tag latest/],
      ["exactly two assets", /contract_fields\[3\]\}" != "2"/],
      ["two asset entries", /asset_entries\[@\]\}" -ne 2/],
      ["tarball size bound", /refusing a tarball size outside 100\.\.67108864 bytes/],
      ["server digest shape", /refusing a server digest that is not 64 hex characters/],
      ["checksum size bound", /refusing a SHA256SUMS size outside 1\.\.1024 bytes/],
      ["one of each asset", /seen_tarball" -ne 1/],
      ["download", /gh release download "\$RELEASE_TAG"/],
      ["downloaded asset count", /\$\{#entries\[@\]\}" -ne 2/],
      ["one tarball", /\$\{#tarballs\[@\]\}" -ne 1/],
      ["no links", /\[ -L "\$tarball" \]/],
      ["promised filename", /tarball_name" != "\$expected_name"/],
      ["verifier written", new RegExp(`<<'${VERIFY_MARKER}'`)],
      ["verifier run", /node "\$VERIFY_SCRIPT" verify/],
    ],
    "verify step",
  );

  const semver = /\[\[ ! "\$RELEASE_TAG" =~ (.*) \]\]; then/.exec(verify);
  assert.ok(semver, "the tag is re-validated as an exact semantic version");
  assert.equal(semver[1], "^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$");
  const outsideCharacterClasses = semver[1].replace(/\[[^\]]*\]/g, "");
  assert.ok(!/[-+]/.test(outsideCharacterClasses), "a prerelease or build suffix can never stage `latest`");

  assert.match(verify, /--pattern '\*\.tgz'/, "only tarballs are downloaded");
  assert.match(verify, /--pattern 'SHA256SUMS'/, "the checksum file is downloaded");
  assert.match(verify, /shopt -s nullglob dotglob/, "hidden entries are counted too");
  assert.match(verify, /package_name='@openagency\.io\/skill-router'/, "the verified package name is pinned");
  assert.ok(!/sha256sum|shasum|openssl|\btar\s+-/.test(verify), "no external checksum or archive utility is invoked");
  const shellOnly = verify.replace(new RegExp(`<<'${VERIFY_MARKER}'[\\s\\S]*?\\n${VERIFY_MARKER}`), "<verifier>");
  assert.ok(
    !/ >> | > /.test(shellOnly.replace(/cat > "\$VERIFY_SCRIPT"/g, "")),
    "the verifier heredoc is the only file written",
  );
});

test("the stage step revalidates with the same verifier immediately before staging", () => {
  const stage = runStep("stage");
  assertOrder(
    stage,
    [
      ["shape checks", /refusing an unsafe recorded asset name/],
      ["mode shape", /recorded tarball mode must be octal/],
      ["package name shape", /refusing an unexpected recorded package name/],
      ["exactly two assets", /\$\{#entries\[@\]\}" -ne 2/],
      ["one tarball", /\$\{#tarballs\[@\]\}" -ne 1/],
      ["no links", /\[ -L "\$tarball" \]/],
      ["recorded filename", /\$\(basename "\$tarball"\)" != "\$TARBALL_NAME"/],
      ["verifier present", /the strict verifier written by the verify step is missing/],
      ["reverify", /node "\$VERIFY_SCRIPT" reverify/],
      ["stage", /npm stage publish /],
    ],
    "stage step",
  );
  assert.equal(stage.trim().split("\n").at(-1), STAGE_COMMAND, "staging is the final action of the workflow");
  assert.ok(!/\bgh\b|sha256sum|shasum|openssl|\btar\s+-|\bcurl\b|\bwget\b/.test(stage), "the stage step only re-reads local files");
});

test("package metadata is exact, and no lifecycle script can run at publication", () => {
  assert.equal(packageJson.name, PACKAGE_NAME, "the scoped package name is exactly the verified organization name");
  assert.equal(packageJson.license, "MIT");
  assert.deepEqual(packageJson.repository, { type: "git", url: REPOSITORY_URL }, "full repository object with the exact URL");
  assert.equal(packageJson.homepage, HOMEPAGE_URL);
  assert.deepEqual(packageJson.bugs, { url: BUGS_URL });
  assert.deepEqual(packageJson.publishConfig, { registry: REGISTRY_URL, access: "public", tag: "latest" });
  assert.deepEqual(packageJson.bin, { "skill-router": "./src/cli.js" }, "the bin target is unchanged");
  assert.ok(!("author" in packageJson) && !("funding" in packageJson), "no invented author or funding");
  for (const name of FORBIDDEN_LIFECYCLE) {
    assert.ok(!(name in packageJson.scripts), `package.json must not define the ${name} script`);
  }
  assert.deepEqual(packageJson.files, ["src", "README.md", "LICENSE"], "the package allowlist contains only shipped public surfaces");

  // Phase 14 adds one field and nothing else: the npm platform contract.
  assert.deepEqual(packageJson.os, ["darwin", "linux"], "the Phase 14 platform contract is exactly darwin and linux");

  const root = packageLock.packages[""];
  assert.equal(root.name, packageJson.name);
  assert.equal(root.version, packageJson.version);
  assert.equal(root.license, packageJson.license);
  assert.deepEqual(root.bin, { "skill-router": "src/cli.js" }, "npm normalises the leading ./ in the lock root");
  assert.deepEqual(root.engines, packageJson.engines);
  assert.deepEqual(root.dependencies, packageJson.dependencies);
  assert.deepEqual(root.os, packageJson.os, "a package-lock-only update records the platform contract in the lock root");
  for (const field of ["repository", "homepage", "bugs", "publishConfig"]) {
    assert.ok(!(field in root), `npm does not record ${field} in the lock root`);
  }
});

test("the verifier is static, in-memory, and reads only the two known paths", () => {
  const source = readFileSync(verifierPath(), "utf8");
  // Everything outside the quoted heredoc: the shell the runner actually
  // executes, where the seam variable must never appear.
  const shellWorkflow = publish.text.replace(
    new RegExp(`<<'${VERIFY_MARKER}'[\\s\\S]*?\\n[ \\t]*${VERIFY_MARKER}`),
    "<verifier>",
  );
  for (const constant of [REPOSITORY_URL, HOMEPAGE_URL, BUGS_URL, REGISTRY_URL]) {
    assert.ok(source.includes(constant), `the verifier pins ${constant}`);
  }
  for (const name of FORBIDDEN_LIFECYCLE) {
    assert.ok(source.includes(`"${name}"`), `the verifier refuses the ${name} script`);
  }
  assert.ok(source.includes("O_RDONLY | fs.constants.O_NOFOLLOW"), "files are opened without following links");
  assert.ok(source.includes("fs.lstatSync"), "the type is proven before anything is opened");
  assert.ok(source.includes("initial.nlink !== 1"), "hard-linked files are refused");
  assert.ok(source.includes('TextDecoder("utf-8", { fatal: true })'), "strict UTF-8 decoding");
  assert.ok(source.includes("maxOutputLength"), "decompression is bounded");
  assert.ok(source.includes("USTAR_MAGIC"), "the exact POSIX ustar magic is required");
  assert.ok(source.includes("base-256 encodings are refused"), "non-octal numerics are refused");
  assert.ok(source.includes("duplicate member name"), "duplicate members are refused");
  assert.ok(source.includes("single zero block"), "the two-block terminator is required");
  assert.ok(source.includes("non-zero bytes after its terminator"), "trailing bytes must be zero");
  assert.ok(source.includes("sha256:"), "the server digest is reconciled");
  assert.ok(/EXPECTED_TARBALL_SIZE/.test(source) && /tarball mode drifted/.test(source), "recorded identities are rechecked");
  assert.ok(!/child_process|execSync|spawn/.test(source), "the verifier runs no command");
  assert.ok(!/mkdirSync|createWriteStream|writeFileSync|mkdtempSync/.test(source), "nothing is extracted or written");
  assert.ok(!/require\("node:path"\)\.resolve|readFileSync\(.*\+/.test(source), "no path is ever derived from checksum text");
  assert.match(source, /fs\.appendFileSync\(target, text\)/, "the only write is the GITHUB_OUTPUT record");
  assert.ok(!/\bsha256sum\b|\bshasum\b|\bopenssl\b|\btar\s+-/.test(source), "no external utility is used for hashing or listing");

  // Exactly one gzip member, decompressed and verified here.
  assert.ok(!/zlib\.gunzipSync\s*\(/.test(source), "concatenated members are never handed to gunzipSync");
  assert.ok(source.includes("inflateRawSync") && source.includes("consumed"), "the DEFLATE payload is consumed exactly once");
  assert.ok(source.includes("0x1f") && source.includes("0x8b"), "the gzip magic is checked");
  assert.ok(source.includes("compressed[3] !== 0"), "optional/reserved gzip flags are refused");
  assert.ok(source.includes("crc32(output)") && source.includes("ISIZE"), "the gzip footer is verified");
  assert.ok(source.includes("Uint32Array(256)"), "CRC32 is implemented locally and bounded");
  assert.ok(source.includes("directory member with a body"), "directory bodies are refused");

  // The stable read: bigint stats, settled identity incl. size/mtime/ctime,
  // a label-gated test seam the workflow never arms, and the honest
  // statement of the residual boundary.
  assert.ok(source.includes("{ bigint: true }"), "stats are taken as exact bigints");
  assert.ok(source.includes("settled.mtimeNs") && source.includes("settled.ctimeNs"), "the settled lstat compares timestamps");
  assert.ok(source.includes("settled.size") && source.includes("settled.nlink") && source.includes("settled.mode"), "the settled lstat compares size, mode, and links");
  assert.ok(source.includes('process.env.PUBLISH_NPM_TEST_SEAM === label'), "the mutation seam is gated on the file's own label");
  assert.ok(source.includes("fs.chmodSync(filePath, 0o444)"), "the seam mutates metadata deterministically");
  assert.ok(!shellWorkflow.includes("PUBLISH_NPM_TEST_SEAM"), "the workflow never arms the test seam");
  assert.ok(!/^\s*PUBLISH_NPM_TEST_SEAM\s*=/m.test(source), "the seam is only ever read, never assigned");
  assert.ok(
    /atomically[\s\S]{0,60}to npm/.test(source),
    "the residual boundary (verifier exit vs npm's later pathname open) is stated",
  );
});

test("the verifier accepts a real npm pack tarball", (t) => {
  const probe = spawnSync("npm", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    t.skip("npm is unavailable");
    return;
  }
  const dir = scratch("npmpack-");
  const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", dir], {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, TMPDIR: scratchRoot, TMP: scratchRoot, TEMP: scratchRoot },
    timeout: 120000,
  });
  assert.equal(packed.status, 0, `npm pack failed: ${packed.stderr}`);
  const files = packed.stdout.trim().split("\n").filter(Boolean);
  assert.equal(files.length, 1, `npm pack must produce exactly one tarball: ${files}`);
  assert.equal(files.at(-1), TARBALL_NAME, "npm pack names the tarball npm publishes");

  const bytes = readFileSync(path.join(dir, TARBALL_NAME));
  const bundle = bundleFixture({ entries: [], rawTarball: bytes, tarballName: TARBALL_NAME });
  const result = runVerifier("verify", bundle);
  accepted(result);
  assert.match(result.stdout, /verify ok/);
  assert.match(result.stdout, new RegExp(`package ${PACKAGE_NAME.replace(/[/.]/g, "\\$&")}@${PACKAGE_VERSION}`));
  assert.ok(Number(/\| members (\d+)/.exec(result.stdout)[1]) >= 2, "the real archive carries its members");
});

test("the strict archive parser refuses every non-npm-pack shape", () => {
  const cases = [
    ["pax extended header", [MANIFEST_ENTRY, { name: "package/x", type: "x", content: "30 path=package/evil" }], /pax extended header/],
    ["pax global header", [MANIFEST_ENTRY, { name: "package/x", type: "g", content: "20 comment=x" }], /pax global header/],
    ["malformed pax payload", [MANIFEST_ENTRY, { name: "package/x", type: "x", content: "not-a-pax-record" }], /pax extended header/],
    ["GNU long name", [MANIFEST_ENTRY, { name: "package/x", type: "L", content: "package/long" }], /GNU long name/],
    ["GNU long link name", [MANIFEST_ENTRY, { name: "package/x", type: "K", content: "package/long" }], /GNU long link name/],
    ["GNU sparse", [MANIFEST_ENTRY, { name: "package/x", type: "S", content: "" }], /GNU sparse/],
    ["hard link member", [MANIFEST_ENTRY, { name: "package/x", type: "1", linkname: "package/package.json" }], /hard link/],
    ["symbolic link member", [MANIFEST_ENTRY, { name: "package/x", type: "2", linkname: "/etc/passwd" }], /symbolic link/],
    ["character device", [MANIFEST_ENTRY, { name: "package/x", type: "3", content: "" }], /character device/],
    ["block device", [MANIFEST_ENTRY, { name: "package/x", type: "4", content: "" }], /block device/],
    ["FIFO member", [MANIFEST_ENTRY, { name: "package/x", type: "6", content: "" }], /FIFO/],
    ["directory member with a body", [MANIFEST_ENTRY, { name: "package/dir/", type: "5", content: "x" }], /directory member with a body/],
    ["unknown member type", [MANIFEST_ENTRY, { name: "package/x", typeCode: 57, content: "" }], /unknown member type \(57\)/],
    ["link name on a regular member", [MANIFEST_ENTRY, { name: "package/x", linkname: "package/package.json" }], /link entry/],
    ["ustar prefix field", [MANIFEST_ENTRY, CLI_ENTRY], /ustar prefix field/, (archive) =>
      patchArchive(archive, 1, (header) => {
        header[345] = 0x70;
      }),
    ],
    ["non-u star magic", [MANIFEST_ENTRY], /strict POSIX ustar format/, (archive) =>
      patchArchive(archive, 0, (header) => {
        header[262] = 0x20; // GNU writes "ustar " here
      }),
    ],
    ["non-zero ustar version", [MANIFEST_ENTRY], /strict POSIX ustar format/, (archive) =>
      patchArchive(archive, 0, (header) => {
        header[263] = 0x20;
      }),
    ],
    ["base-256 size", [MANIFEST_ENTRY], /not octal \(base-256 encodings are refused\)/, (archive) =>
      patchArchive(archive, 0, (header) => {
        header[124] = 0x80;
      }),
    ],
    ["non-zero-padded size", [MANIFEST_ENTRY], /size field is not zero-padded octal/, (archive) =>
      patchArchive(archive, 0, (header) => {
        header.fill(0, 124, 136);
        header.write("644", 124, 3, "latin1");
      }),
    ],
    ["header checksum mismatch", [MANIFEST_ENTRY], /header checksum does not match/, (archive) =>
      patchArchive(archive, 0, (header) => {
        header[0] = 0x71; // rewrite "package/..." without re-sealing
      }, { seal: false }),
    ],
    ["mode above the bound", [MANIFEST_ENTRY], /mode field exceeds the accepted bound/, (archive) =>
      patchArchive(archive, 0, (header) => {
        writeNumericField(header, 100, 8, 0o100777);
      }),
    ],
    ["duplicate literal member", [MANIFEST_ENTRY, MANIFEST_ENTRY], /duplicate member name/],
    [
      "aliased directory/file pair",
      [{ name: "package/src", content: "x" }, { name: "package/src/", type: "5", content: "" }],
      /duplicate member name/,
    ],
    ["dot path segment", [MANIFEST_ENTRY, { name: "package/./a.js", content: "x" }], /dot path segment/],
    ["dot-dot path segment", [MANIFEST_ENTRY, { name: "package/src/../../a.js", content: "x" }], /dot path segment/],
    ["empty path segment", [MANIFEST_ENTRY, { name: "package//a.js", content: "x" }], /empty path segment/],
    ["backslash in name", [MANIFEST_ENTRY, { name: "package/a\\b.js", content: "x" }], /backslash/],
    ["member outside package/", [MANIFEST_ENTRY, { name: "other/a.js", content: "x" }], /inside the package\/ directory/],
    ["leading slash name", [MANIFEST_ENTRY, { name: "/package/a.js", content: "x" }], /inside the package\/ directory/],
    ["file name ending in slash", [MANIFEST_ENTRY, { name: "package/dir/", content: "x" }], /file member name must not end with a slash/],
    ["directory name without slash", [MANIFEST_ENTRY, { name: "package/dir", type: "5", content: "" }], /directory member name must end with a slash/],
    [
      "control byte in name",
      [MANIFEST_ENTRY, { nameBytes: Buffer.concat([Buffer.from("package/a"), Buffer.from([1]), Buffer.from("b.js")]), content: "x" }],
      /control byte/,
    ],
    ["unterminated name field", [MANIFEST_ENTRY, { nameBytes: Buffer.alloc(100, 0x61), content: "x" }], /not NUL-terminated/],
    [
      "non-zero name padding",
      [MANIFEST_ENTRY, { nameBytes: (() => { const bytes = Buffer.alloc(100); bytes.write("package/ok.js"); bytes[50] = 0x7a; return bytes; })(), content: "x" }],
      /non-zero padding/,
    ],
    ["missing manifest", [{ name: "package/src/cli.js", content: "#!/usr/bin/env node\n" }], /exactly one package\/package\.json/],
    [
      "oversized member",
      [MANIFEST_ENTRY, { name: "package/big.bin", content: Buffer.alloc(4 * 1024 * 1024 + 1, 0x61) }],
      /member exceeds the accepted size bound/,
    ],
    ["oversized manifest", [{ name: "package/package.json", content: JSON.stringify({ pad: "x".repeat(300 * 1024) }) }], /package\/package\.json is outside the accepted size bound/],
    ["invalid UTF-8 manifest", [{ name: "package/package.json", content: Buffer.from([0x7b, 0xff, 0x7d]) }], /not valid UTF-8/],
    ["unparsable manifest", [{ name: "package/package.json", content: "{not json" }], /not valid JSON/],
    ["too many members", Array.from({ length: 513 }, (_, index) => ({ name: `package/f${index}`, content: "" })), /more members than accepted/],
  ];

  for (const [label, entries, pattern, mutate] of cases) {
    let archive = buildArchive(entries);
    if (mutate) archive = mutate(archive);
    const bundle = bundleFixture({ entries: [], rawTarball: zlib.gzipSync(archive) });
    refused(runVerifier("verify", bundle), pattern, label);
  }
});

test("the strict archive parser bounds structure, padding, and termination", () => {
  const structural = [
    ["whole-block requirement", { entries: [MANIFEST_ENTRY], slice: 1000 }, /not a whole number of 512-byte blocks/],
    [
      "truncated member data",
      { entries: [{ name: "package/big.bin", content: Buffer.alloc(600, 0x61) }, MANIFEST_ENTRY], slice: 1024 },
      /truncated inside a member/,
    ],
    ["missing terminator", { entries: [MANIFEST_ENTRY], terminator: 0 }, /ends without a two-block terminator/],
    ["single zero terminator", { entries: [MANIFEST_ENTRY], terminator: 512 }, /single zero block/],
    [
      "non-zero trailing bytes",
      { entries: [MANIFEST_ENTRY], terminator: 1024, trailer: Buffer.alloc(512, 0x41) },
      /non-zero bytes after its terminator/,
    ],
    [
      "concatenated archive",
      { entries: [MANIFEST_ENTRY], terminator: 1024, trailer: buildArchive([MANIFEST_ENTRY]) },
      /non-zero bytes after its terminator/,
    ],
    ["empty gzip member", { raw: zlib.gzipSync(Buffer.alloc(0)) }, /expands to nothing/],
    ["gzip output bomb", { raw: zlib.gzipSync(Buffer.alloc(40 * 1024 * 1024)) }, /expands beyond the accepted bound/],
    ["stored raw tar (no gzip)", { entries: [MANIFEST_ENTRY], gzip: false }, /not an acceptable gzip stream/],
    [
      "total member bytes",
      {
        entries: Array.from({ length: 5 }, (_, index) => ({
          name: `package/f${index}`,
          content: Buffer.alloc(4 * 1024 * 1024, 0x61),
        })),
      },
      /members exceed the accepted total size bound/,
    ],
    [
      "non-zero member padding",
      { entries: [MANIFEST_ENTRY, CLI_ENTRY], corruptPadding: 1 },
      /padding is not zero/,
    ],
  ];

  for (const [label, spec, pattern] of structural) {
    let bytes;
    if (spec.raw) {
      bytes = spec.raw;
    } else {
      let archive = buildArchive(spec.entries, { terminator: spec.terminator ?? 1024 });
      if (spec.slice) archive = archive.subarray(0, spec.slice);
      if (spec.trailer) archive = Buffer.concat([archive, spec.trailer]);
      if (spec.corruptPadding !== undefined) {
        const offset = memberOffsets(archive)[spec.corruptPadding];
        const digits = archive
          .subarray(offset + 124, offset + 136)
          .toString("latin1")
          .split(/[^0-7]/)
          .filter(Boolean)
          .join("");
        const dataEnd = offset + 512 + Number.parseInt(digits, 8);
        assert.ok(dataEnd < archive.length - 1024, `${label}: the fixture must still carry its terminator`);
        archive[dataEnd] = 0x7a;
      }
      bytes = spec.gzip === false ? archive : zlib.gzipSync(archive);
    }
    refused(runVerifier("verify", bundleFixture({ entries: [], rawTarball: bytes })), pattern, label);
  }

  // Positive control: an empty directory member is the only body-free form
  // the format allows, and the real npm-pack shape still passes.
  accepted(runVerifier("verify", bundleFixture({ entries: [MANIFEST_ENTRY, { name: "package/dir/", type: "5", content: "" }] })));
});

test("the gzip layer accepts exactly one fully consumed member and verifies its footer", () => {
  const archive = buildArchive([MANIFEST_ENTRY]);
  const single = zlib.gzipSync(archive);
  // The observed npm-pack header contract: magic, deflate method, no flags.
  assert.deepEqual([...single.subarray(0, 4)], [0x1f, 0x8b, 8, 0], "the observed gzip header is magic + deflate + FLG 0");

  const withByte = (buffer, index, value) => {
    const copy = Buffer.from(buffer);
    copy[index] = value;
    return copy;
  };
  const footer = single.length - 8;

  const cases = [
    ["second member: empty gzip", Buffer.concat([single, zlib.gzipSync(Buffer.alloc(0))]), /trailing bytes after its deflate payload/],
    [
      "second member: zero-filled gzip",
      Buffer.concat([single, zlib.gzipSync(Buffer.alloc(4096))]),
      /trailing bytes after its deflate payload/,
    ],
    [
      "second member: gzip carrying data",
      Buffer.concat([single, zlib.gzipSync(buildArchive([CLI_ENTRY]))]),
      /trailing bytes after its deflate payload/,
    ],
    ["trailing bytes after the footer", Buffer.concat([single, Buffer.from([1, 2, 3, 4])]), /trailing bytes after its deflate payload/],
    ["zero padding after the footer", Buffer.concat([single, Buffer.alloc(64)]), /trailing bytes after its deflate payload/],
    [
      "junk injected before the footer",
      Buffer.concat([single.subarray(0, footer), Buffer.from("JUNKJUNK"), single.subarray(footer)]),
      /trailing bytes after its deflate payload/,
    ],
    ["truncated deflate payload", single.subarray(0, single.length - 12), /deflate payload is truncated or corrupt/],
    ["FNAME flag", withByte(single, 3, 0x08), /optional or reserved flags/],
    ["FHCRC flag", withByte(single, 3, 0x02), /optional or reserved flags/],
    ["reserved flag bit", withByte(single, 3, 0x01), /optional or reserved flags/],
    ["unknown method", withByte(single, 2, 9), /not an acceptable gzip stream/],
    ["broken magic", withByte(single, 1, 0x8c), /not an acceptable gzip stream/],
    ["unknown XFL", withByte(single, 8, 9), /unknown XFL value/],
    ["truncated header", single.subarray(0, 6), /not an acceptable gzip stream/],
    ["too short for a footer", single.subarray(0, 14), /not an acceptable gzip stream/],
    ["corrupt CRC32 footer", withByte(single, footer, single[footer] ^ 0xff), /CRC32 footer does not match/],
    ["corrupt ISIZE footer", withByte(single, footer + 4, single[footer + 4] ^ 0x01), /ISIZE footer does not match/],
  ];
  for (const [label, bytes, pattern] of cases) {
    refused(runVerifier("verify", bundleFixture({ entries: [], rawTarball: bytes })), pattern, label);
  }

  // The honest single member is still accepted, footer and all.
  accepted(runVerifier("verify", bundleFixture({ entries: [], rawTarball: single })));
});

test("the settled lstat refuses a deterministic post-read mutation on either file", () => {
  const tarballSeam = bundleFixture({ entries: [MANIFEST_ENTRY] });
  refused(
    runVerifier("verify", tarballSeam, { env: { PUBLISH_NPM_TEST_SEAM: "the release tarball" } }),
    /the release tarball changed after it was read/,
    "tarball seam",
  );

  // The same reader is used for SHA256SUMS: aiming the seam at the checksum
  // file lets the tarball read succeed and proves the second read is guarded.
  const sumsSeam = bundleFixture({ entries: [MANIFEST_ENTRY] });
  refused(
    runVerifier("verify", sumsSeam, { env: { PUBLISH_NPM_TEST_SEAM: "SHA256SUMS" } }),
    /SHA256SUMS changed after it was read/,
    "checksum seam",
  );

  // An unrelated seam value never fires.
  const offTarget = bundleFixture({ entries: [MANIFEST_ENTRY] });
  accepted(runVerifier("verify", offTarget, { env: { PUBLISH_NPM_TEST_SEAM: "some other file" } }));
});

test("SHA256SUMS is matched as one exact line and never turned into a path", () => {
  const good = bundleFixture({ entries: [MANIFEST_ENTRY] });

  // Sanity: the honest fixture is accepted and records identities.
  const ok = runVerifier("verify", good);
  accepted(ok);
  assert.deepEqual(Object.keys(ok.outputs).sort(), OUTPUT_KEYS, "all nine identities are recorded");
  assert.equal(ok.outputs.tarball_name, TARBALL_NAME);
  assert.equal(ok.outputs.tarball_size, String(good.bytes.length));
  assert.equal(ok.outputs.tarball_sha256, good.tarballSha);
  assert.equal(ok.outputs.tarball_mode, "644");

  const digest = good.tarballSha;
  const malformed = [
    ["digest of another file", `${"a".repeat(64)}  ${TARBALL_NAME}\n`, /does not match the release tarball digest/],
    ["two lines", `${digest}  ${TARBALL_NAME}\n${digest}  ${TARBALL_NAME}\n`, /must be exactly one line/],
    ["missing newline", `${digest}  ${TARBALL_NAME}`, /must be exactly one line/],
    ["extra newline", `${digest}  ${TARBALL_NAME}\n\n`, /must be exactly one line/],
    ["single space", `${digest} ${TARBALL_NAME}\n`, /must be exactly one line/],
    ["three spaces", `${digest}   ${TARBALL_NAME}\n`, /must be exactly one line/],
    ["uppercase digest", `${digest.toUpperCase()}  ${TARBALL_NAME}\n`, /must be exactly one line/],
    ["short digest", `${digest.slice(0, 63)}  ${TARBALL_NAME}\n`, /must be exactly one line/],
    ["absolute path", `${digest}  /etc/passwd\n`, /must be exactly one line/],
    ["traversal path", `${digest}  ../../sentinel\n`, /must be exactly one line/],
    ["wrong file name", `${digest}  other-0.1.0.tgz\n`, /must be exactly one line/],
    ["trailing carriage return", `${digest}  ${TARBALL_NAME}\r\n`, /must be exactly one line/],
  ];
  for (const [label, sumsText, pattern] of malformed) {
    refused(runVerifier("verify", bundleFixture({ entries: [MANIFEST_ENTRY], sumsText })), pattern);
  }

  // A NUL byte and invalid UTF-8 are refused before any comparison.
  const nulBytes = Buffer.concat([Buffer.from(`${digest}  ${TARBALL_NAME}`), Buffer.from([0]), Buffer.from("\n")]);
  refused(
    runVerifier("verify", bundleFixture({ entries: [MANIFEST_ENTRY], sumsText: nulBytes })),
    /must not contain a NUL byte/,
  );
  refused(
    runVerifier("verify", bundleFixture({ entries: [MANIFEST_ENTRY], sumsText: Buffer.from([0x61, 0xff, 0x0a]) })),
    /SHA256SUMS is not valid UTF-8/,
  );

  // Oversize is refused by the reader bound, before the content is parsed.
  const oversize = `${digest}  ${TARBALL_NAME}\n${"0".repeat(5000)}`;
  refused(
    runVerifier("verify", bundleFixture({ entries: [MANIFEST_ENTRY], sumsText: oversize })),
    /SHA256SUMS size \d+ is outside the accepted bound/,
  );

  // The checksum may name a FIFO: the verifier must refuse without blocking,
  // proving no path from the checksum file is ever opened.
  const fifoDir = scratch("fifo-");
  const fifoPath = path.join(fifoDir, "sentinel.fifo");
  const mk = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
  if (!mk.error) {
    const bundle = bundleFixture({ entries: [MANIFEST_ENTRY], sumsText: `${digest}  sentinel.fifo\n` });
    const started = Date.now();
    const run = spawnSync(process.execPath, [verifierPath(), "verify"], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        TARBALL_PATH: bundle.tarballPath,
        SUMS_PATH: bundle.sumsPath,
        EXPECTED_TARBALL_NAME: bundle.tarballName,
        EXPECTED_VERSION: PACKAGE_VERSION,
        EXPECTED_PACKAGE_NAME: PACKAGE_NAME,
        REMOTE_TARBALL_SIZE: String(bundle.bytes.length),
        REMOTE_TARBALL_DIGEST: "",
        REMOTE_SUMS_SIZE: String(bundle.sumsBytes.length),
        REMOTE_SUMS_DIGEST: "",
      },
    });
    assert.ok(run.error === undefined, "the verifier must not block on the named FIFO");
    assert.ok(Date.now() - started < 5000, "the verifier returned promptly");
    assert.match(run.stderr, /must be exactly one line/, "the checksum line naming a FIFO is refused outright");
  }

  // The checksum *file itself* as a FIFO is refused by lstat, without opening.
  const sumsFifoBundle = bundleFixture({ entries: [MANIFEST_ENTRY] });
  rmSync(sumsFifoBundle.sumsPath, { force: true });
  const sumsFifo = path.join(sumsFifoBundle.release, "SHA256SUMS");
  if (!spawnSync("mkfifo", [sumsFifo], { encoding: "utf8" }).error) {
    const started = Date.now();
    const run = spawnSync(process.execPath, [verifierPath(), "verify"], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        TARBALL_PATH: sumsFifoBundle.tarballPath,
        SUMS_PATH: sumsFifo,
        EXPECTED_TARBALL_NAME: TARBALL_NAME,
        EXPECTED_VERSION: PACKAGE_VERSION,
        EXPECTED_PACKAGE_NAME: PACKAGE_NAME,
        REMOTE_TARBALL_SIZE: String(sumsFifoBundle.bytes.length),
        REMOTE_TARBALL_DIGEST: "",
        REMOTE_SUMS_SIZE: "100",
        REMOTE_SUMS_DIGEST: "",
      },
    });
    assert.ok(run.error === undefined, "the verifier must not block on a FIFO checksum file");
    assert.ok(Date.now() - started < 5000, "the verifier returned promptly");
    assert.match(run.stderr, /SHA256SUMS must be a regular file/);
  }
});

test("both files are proven by lstat/open identity, and drift fails the pre-stage pass", () => {
  const base = bundleFixture({ entries: [MANIFEST_ENTRY] });
  const ok = runVerifier("verify", base);
  accepted(ok);
  base.recorded = ok.outputs;

  // A second, identical verification (the pre-stage pass) succeeds.
  accepted(runVerifier("reverify", base));

  // Replacement: a different tarball behind the same name.
  const replaced = bundleFixture({ entries: [MANIFEST_ENTRY, CLI_ENTRY] });
  const replaceRun = runVerifier("reverify", {
    ...base,
    tarballPath: replaced.tarballPath,
    sumsPath: replaced.sumsPath,
    recorded: base.recorded,
  });
  refused(replaceRun, /size drifted|digest drifted/);

  // Mode drift is detected against the recorded mode.
  chmodSync(base.tarballPath, 0o600);
  refused(runVerifier("reverify", base), /tarball mode drifted/);
  chmodSync(base.tarballPath, 0o644);

  // Symlinks are refused before anything is opened.
  const linked = bundleFixture({ entries: [MANIFEST_ENTRY] });
  const linkTarget = path.join(linked.dir, "real.tgz");
  writeFileSync(linkTarget, linked.bytes);
  rmSync(linked.tarballPath, { force: true });
  symlinkSync(linkTarget, linked.tarballPath);
  refused(runVerifier("verify", linked), /must not be a symbolic link/);

  // A hard-linked tarball (nlink > 1) is refused.
  const hardlinked = bundleFixture({ entries: [MANIFEST_ENTRY] });
  const second = path.join(hardlinked.dir, "second.tgz");
  linkSync(hardlinked.tarballPath, second);
  refused(runVerifier("verify", hardlinked), /must be a single-link file/);

  // A directory in place of a file is refused without being opened.
  const asDirectory = bundleFixture({ entries: [MANIFEST_ENTRY] });
  rmSync(asDirectory.sumsPath, { force: true });
  mkdirSync(asDirectory.sumsPath);
  refused(runVerifier("verify", asDirectory), /SHA256SUMS must be a regular file/);

  // A missing checksum file is refused.
  const missing = bundleFixture({ entries: [MANIFEST_ENTRY] });
  rmSync(missing.sumsPath, { force: true });
  refused(runVerifier("verify", missing), /SHA256SUMS is missing/);

  // The remote contract is reconciled against the downloaded bytes.
  const remote = bundleFixture({ entries: [MANIFEST_ENTRY] });
  refused(
    runVerifier("verify", remote, { env: { REMOTE_TARBALL_SIZE: "99999" } }),
    /downloaded tarball size does not match/,
  );
  refused(
    runVerifier("verify", remote, { env: { REMOTE_TARBALL_DIGEST: `sha256:${"0".repeat(64)}` } }),
    /release asset digest does not match the downloaded tarball/,
  );
  refused(runVerifier("verify", remote, { env: { REMOTE_SUMS_SIZE: "200" } }), /downloaded SHA256SUMS size does not match/);
  refused(
    runVerifier("verify", remote, { env: { REMOTE_TARBALL_SIZE: "0" } }),
    /release tarball size is outside the accepted bound/,
  );
  refused(runVerifier("verify", remote, { env: { REMOTE_SUMS_SIZE: "9999999999" } }), /SHA256SUMS size is outside the accepted bound/);

  // Missing/absent digests are allowed (GitHub does not always publish one).
  accepted(runVerifier("verify", remote, { env: { REMOTE_TARBALL_DIGEST: "", REMOTE_SUMS_DIGEST: "" } }));

  // Metadata refusals still hold through the full pipeline.
  const metadataCases = [
    ["wrong version", { version: "0.2.0" }, /does not match the release tag/],
    ["wrong package name", { name: "@openagency.io/other" }, /package name mismatch/],
    ["stale provisional package name", { name: "@openagency/skill-router" }, /package name mismatch/],
  ];
  for (const [label, options, pattern] of metadataCases) {
    refused(runVerifier("verify", bundleFixture({ entries: [MANIFEST_ENTRY] }), options), pattern);
  }
  const manifestVariants = [
    ["string repository", manifestJson({ repository: REPOSITORY_URL }), /full object/],
    ["wrong repository URL", manifestJson({ repository: { type: "git", url: "git+https://example.invalid/x.git" } }), /repository\.url must be exactly/],
    ["wrong homepage", manifestJson({ homepage: "https://example.invalid/" }), /homepage must be exactly/],
    ["missing bugs", manifestJson({ bugs: undefined }), /bugs\.url must be exactly/],
    ["publishConfig tag", manifestJson({ publishConfig: { registry: REGISTRY_URL, access: "public", tag: "next" } }), /exactly "latest"/],
    [
      "publishConfig extra key",
      manifestJson({ publishConfig: { registry: REGISTRY_URL, access: "public", tag: "latest", otp: "1" } }),
      /exactly registry, access, and tag/,
    ],
    ["lifecycle script", manifestJson({ scripts: { postinstall: "curl example.invalid" } }), /lifecycle script: postinstall/],
    ["prepare script", manifestJson({ scripts: { prepare: "node build.js" } }), /lifecycle script: prepare/],
    ["bare bin", manifestJson({ bin: "./cli.js" }), /bin must be an object/],
    ["second bin", manifestJson({ bin: { "skill-router": "./src/cli.js", other: "./o.js" } }), /exactly the entry "skill-router"/],
  ];
  for (const [label, json, pattern] of manifestVariants) {
    refused(runVerifier("verify", bundleFixture({ entries: [{ name: "package/package.json", content: json }] })), pattern);
  }
});

test("the release contract is proven before download and gates npm (stubbed gh)", () => {
  const dir = scratch("pipeline-");
  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const assetsDir = path.join(dir, "stub-assets");
  mkdirSync(assetsDir, { recursive: true });

  // A real, valid bundle the stub will hand to the workflow.
  const source = bundleFixture({ entries: [MANIFEST_ENTRY, CLI_ENTRY] });
  writeFileSync(path.join(assetsDir, TARBALL_NAME), source.bytes);
  writeFileSync(path.join(assetsDir, "SHA256SUMS"), source.sumsBytes);
  const digests = {
    [TARBALL_NAME]: `sha256:${source.tarballSha}`,
    SHA256SUMS: `sha256:${source.sumsSha}`,
  };

  const ghLog = path.join(dir, "gh.log");
  const npmLog = path.join(dir, "npm.log");
  const contractFile = path.join(dir, "contract.tsv");
  const output = path.join(dir, "gh-output");

  writeFileSync(
    path.join(bin, "gh"),
    [
      "#!/bin/sh",
      `printf 'gh %s\\n' "$*" >> "$GH_STUB_LOG"`,
      'if [ "$1" = "api" ]; then',
      '  if [ -n "${GH_STUB_CONTRACT:-}" ] && [ -f "$GH_STUB_CONTRACT" ]; then cat "$GH_STUB_CONTRACT"; exit 0; fi',
      "  exit 1",
      "fi",
      'if [ "$1" = "release" ] && [ "$2" = "download" ]; then',
      '  target=""',
      '  previous=""',
      '  for argument in "$@"; do',
      '    if [ "$previous" = "--dir" ]; then target="$argument"; fi',
      '    previous="$argument"',
      "  done",
      '  if [ -z "$target" ]; then exit 1; fi',
      '  mkdir -p "$target"',
      '  if [ -z "$(ls -A "$GH_STUB_ASSETS" 2>/dev/null)" ]; then exit 1; fi',
      '  for asset in "$GH_STUB_ASSETS"/*; do cp "$asset" "$target"/; done',
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(path.join(bin, "npm"), '#!/bin/sh\nprintf \'npm %s\\n\' "$*" >> "$NPM_STUB_LOG"\nexit 0\n', { mode: 0o755 });
  writeFileSync(path.join(dir, "verify.sh"), runStep("verify"));
  writeFileSync(path.join(dir, "stage.sh"), runStep("stage"));

  function contract({ tag = RELEASE_TAG, draft = false, prerelease = false, assets }) {
    return [
      tag,
      String(draft),
      String(prerelease),
      String(assets.length),
      assets
        .map((asset) => `${asset.name}=${asset.size}=${asset.digest ?? "-"}`)
        .sort()
        .join(","),
    ].join("\t");
  }

  const honest = [
    { name: TARBALL_NAME, size: source.bytes.length, digest: digests[TARBALL_NAME] },
    { name: "SHA256SUMS", size: source.sumsBytes.length, digest: digests.SHA256SUMS },
  ];

  function runPipeline({ contractText, repositoryId = ORGANISATION_REPO, tag = RELEASE_TAG, emptyAssets = false, thirdAsset = false, seam } = {}) {
    // Every scenario starts from a clean workspace: the previous scenario's
    // downloaded assets and verifier must never leak into this one.
    rmSync(path.join(dir, "release-assets"), { recursive: true, force: true });
    rmSync(path.join(dir, VERIFIER_FILE), { force: true });
    rmSync(ghLog, { force: true });
    rmSync(npmLog, { force: true });
    rmSync(output, { force: true });
    rmSync(contractFile, { force: true });
    if (contractText !== undefined) writeFileSync(contractFile, contractText);
    if (thirdAsset) writeFileSync(path.join(assetsDir, "extra.txt"), "extra\n");
    else rmSync(path.join(assetsDir, "extra.txt"), { force: true });
    if (emptyAssets) {
      for (const name of [TARBALL_NAME, "SHA256SUMS"]) rmSync(path.join(assetsDir, name), { force: true });
    } else {
      writeFileSync(path.join(assetsDir, TARBALL_NAME), source.bytes);
      writeFileSync(path.join(assetsDir, "SHA256SUMS"), source.sumsBytes);
    }

    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      GH_TOKEN: "read-only-dummy",
      RELEASE_TAG: tag,
      GITHUB_REPOSITORY: repositoryId,
      GITHUB_OUTPUT: output,
      GH_STUB_LOG: ghLog,
      GH_STUB_CONTRACT: contractFile,
      GH_STUB_ASSETS: assetsDir,
      NPM_STUB_LOG: npmLog,
      ...(seam ? { PUBLISH_NPM_TEST_SEAM: seam } : {}),
    };
    const verify = spawnSync("bash", [path.join(dir, "verify.sh")], { cwd: dir, encoding: "utf8", env, timeout: 60000 });
    const outputs = readOutputs(output);
    const stageEnv = { ...env };
    const mapping = {
      TARBALL_NAME: outputs.tarball_name,
      TARBALL_SIZE: outputs.tarball_size,
      TARBALL_SHA256: outputs.tarball_sha256,
      TARBALL_MODE: outputs.tarball_mode,
      SUMS_SIZE: outputs.sums_size,
      SUMS_SHA256: outputs.sums_sha256,
      SUMS_MODE: outputs.sums_mode,
      PACKAGE_VERSION: outputs.package_version,
      PACKAGE_NAME: outputs.package_name,
    };
    for (const [key, value] of Object.entries(mapping)) {
      if (value === undefined) delete stageEnv[key];
      else stageEnv[key] = value;
    }
    const stage = spawnSync("bash", [path.join(dir, "stage.sh")], { cwd: dir, encoding: "utf8", env: stageEnv, timeout: 60000 });
    const read = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
    return { verify, stage, outputs, ghLog: read(ghLog), npmLog: read(npmLog) };
  }

  function assertNeverDownloaded(result, label) {
    assert.notEqual(result.verify.status, 0, `${label}: the verify step must refuse`);
    assert.ok(
      !result.ghLog.some((line) => line.includes("release download")),
      `${label}: nothing may be downloaded before the contract is proven (log: ${result.ghLog.join(" | ")})`,
    );
    assert.deepEqual(result.npmLog, [], `${label}: npm must never be invoked`);
  }

  // The happy path downloads exactly the two assets and stages once.
  const happy = runPipeline({ contractText: contract({ assets: honest }) });
  assert.equal(happy.verify.status, 0, `happy path must verify: ${happy.verify.stderr}`);
  assert.ok(happy.ghLog.some((line) => line.includes("release download")), "the happy path downloads the assets");
  assert.equal(happy.stage.status, 0, `happy path must stage: ${happy.stage.stderr}`);
  assert.deepEqual(happy.npmLog, [
    `npm stage publish ./release-assets/${TARBALL_NAME} --access public --tag latest --ignore-scripts`,
  ]);
  assert.deepEqual(Object.keys(happy.outputs).sort(), OUTPUT_KEYS);

  // Missing server digests are tolerated (reconciliation happens when present).
  const withoutDigests = runPipeline({
    contractText: contract({ assets: honest.map((asset) => ({ ...asset, digest: undefined })) }),
  });
  assert.equal(withoutDigests.verify.status, 0, `digest-less contract must verify: ${withoutDigests.verify.stderr}`);
  assert.equal(withoutDigests.stage.status, 0);

  const scenarios = [
    [
      "the repository identity is wrong",
      { repositoryId: "someone-else/skill-router" },
      [],
    ],
    ["the release does not exist", { contractText: undefined }, ["gh api"]],
    ["the release is a draft", { contractText: contract({ draft: true, assets: honest }) }, ["gh api"]],
    ["the release is a prerelease", { contractText: contract({ prerelease: true, assets: honest }) }, ["gh api"]],
    ["the tag does not match", { contractText: contract({ tag: "v9.9.9", assets: honest }) }, ["gh api"]],
    [
      "an asset is missing",
      { contractText: contract({ assets: [honest[0]] }) },
      ["gh api"],
    ],
    [
      "an extra asset is present",
      { contractText: contract({ assets: [...honest, { name: "notes.txt", size: 12, digest: "-" }] }) },
      ["gh api"],
    ],
    [
      "an asset is renamed",
      {
        contractText: contract({
          assets: [{ ...honest[0], name: "openagency.io-skill-router-9.9.9.tgz" }, honest[1]],
        }),
      },
      ["gh api"],
    ],
    [
      "an asset name is duplicated",
      { contractText: contract({ assets: [honest[0], { ...honest[0], size: honest[1].size }] }) },
      ["gh api"],
    ],
    [
      "the tarball size is oversized",
      { contractText: contract({ assets: [{ ...honest[0], size: 70000000 }, honest[1]] }) },
      ["gh api"],
    ],
    [
      "the checksum size is oversized",
      { contractText: contract({ assets: [honest[0], { ...honest[1], size: 2048 }] }) },
      ["gh api"],
    ],
    [
      "the tarball size is absurdly small",
      { contractText: contract({ assets: [{ ...honest[0], size: 10 }, honest[1]] }) },
      ["gh api"],
    ],
    [
      "the server digest is malformed",
      { contractText: contract({ assets: [{ ...honest[0], digest: "sha256:zz" }, honest[1]] }) },
      ["gh api"],
    ],
    [
      "the response has too few fields",
      { contractText: [RELEASE_TAG, "false", "false", "2"].join("\t") },
      ["gh api"],
    ],
    [
      "the response is oversized",
      { contractText: contract({ assets: [{ name: "x".repeat(5000), size: 1, digest: "-" }, honest[1]] }) },
      ["gh api"],
    ],
  ];
  for (const [label, options, expectedCalls] of scenarios) {
    const result = runPipeline(options);
    assertNeverDownloaded(result, label);
    for (const call of expectedCalls) {
      assert.ok(result.ghLog.some((line) => line.startsWith(call)), `${label}: expected a ${call} call`);
    }
  }
  // The wrong-repository case must not even ask.
  assert.deepEqual(runPipeline({ repositoryId: "someone-else/skill-router" }).ghLog, [], "no gh call outside this repository");

  // A downloaded bundle that does not match the contract still never stages.
  const thirdFile = runPipeline({ contractText: contract({ assets: honest }), thirdAsset: true });
  assert.ok(thirdFile.ghLog.some((line) => line.includes("release download")), "the download itself happened");
  assert.notEqual(thirdFile.verify.status, 0, "three downloaded files must be refused");
  assert.deepEqual(thirdFile.npmLog, [], "npm is never invoked");

  const emptyBundle = runPipeline({ contractText: contract({ assets: honest }), emptyAssets: true });
  assert.ok(emptyBundle.ghLog.some((line) => line.includes("release download")), "the download was attempted");
  assert.notEqual(emptyBundle.verify.status, 0, "an empty download must be refused");
  assert.deepEqual(emptyBundle.npmLog, [], "npm is never invoked");

  // A server digest that disagrees with the downloaded bytes is refused.
  const lying = runPipeline({
    contractText: contract({
      assets: [{ ...honest[0], digest: `sha256:${"0".repeat(64)}` }, honest[1]],
    }),
  });
  assert.ok(lying.ghLog.some((line) => line.includes("release download")), "the download happened");
  assert.notEqual(lying.verify.status, 0, "a mismatched server digest must be refused");
  assert.match(lying.verify.stderr, /release asset digest does not match the downloaded tarball/);
  assert.deepEqual(lying.npmLog, [], "npm is never invoked");

  // A deterministic post-read mutation — armed through the verifier's own
  // label-gated seam, never by the workflow — must refuse the bundle and
  // keep npm out of the run entirely.
  const seamRun = runPipeline({ contractText: contract({ assets: honest }), seam: "the release tarball" });
  assert.ok(seamRun.ghLog.some((line) => line.includes("release download")), "the download happened before the mutation");
  assert.notEqual(seamRun.verify.status, 0, "a settled-lstat mutation must refuse");
  assert.match(seamRun.verify.stderr, /changed after it was read/);
  assert.deepEqual(seamRun.npmLog, [], "npm is never invoked when the settled lstat detects drift");
});

test("the Phase 11 workflows still hold no npm authority", () => {
  for (const name of ["ci", "release"]) {
    const { text } = workflow(name);
    assert.ok(!/\bnpm (publish|stage|unpublish|ping|token|login|logout|adduser|whoami)\b/.test(text), `${name}.yml has no npm authority`);
    assert.ok(!/NPM_TOKEN|NODE_AUTH_TOKEN|_authToken|id-token/.test(text), `${name}.yml carries no npm credential or OIDC mint`);
    assert.ok(!/publish-npm/.test(text), `${name}.yml never references the publish workflow`);
  }
});

test("the README documents the deferred bootstrap and never suggests the taken unscoped name", () => {
  const readme = readFileSync(path.join(repository, "README.md"), "utf8");
  assert.ok(readme.includes(REPOSITORY_URL.replace("git+", "")), "the repository link is documented");
  assert.ok(readme.includes(HOMEPAGE_URL), "the homepage link is documented");
  assert.ok(readme.includes("not published"), "the package is documented as unpublished");
  assert.ok(!readme.includes("@openagency/skill-router"), "the retired provisional scope is gone from the README");
  assert.ok(!/unconfirmed/i.test(readme), "the obsolete unconfirmed-scope blocker is gone");
  assert.ok(
    /ownership was\s+verified/i.test(readme) || /ownership is verified/i.test(readme),
    "organization ownership is documented as verified",
  );
  assert.ok(!readme.includes("Stop unless the scope rights are confirmed"), "the scope-rights stop gate is gone");
  assert.ok(readme.includes("--ignore-scripts"), "the manual bootstrap disables scripts");
  assert.ok(
    readme.includes(`npm stage publish ./release-assets/${TARBALL_NAME}`),
    "the bootstrap stages the exact tarball file",
  );
  assert.ok(readme.includes("0.0.0-stage"), "the staged bootstrap placeholder is documented");
  assert.ok(readme.includes("do not run now"), "the bootstrap carries an explicit do-not-run warning");
  assert.ok(readme.includes("mkdir fresh-bootstrap"), "the bootstrap uses a fresh directory of its own");
  assert.ok(readme.includes("ls -A release-assets"), "the bootstrap checks for exactly two assets");
  assert.ok(readme.includes("--json tagName,isDraft,isPrerelease,assets"), "the bootstrap reads the exact release first");
  assert.ok(
    readme.includes("Never pipe") && readme.includes("sha256sum --check"),
    "the bootstrap refuses a checksum file that names paths",
  );
  assert.ok(/cannot carry\s+>?\s*trusted-publisher\/OIDC provenance/.test(readme), "the first version has no OIDC provenance");
  assert.ok(readme.includes("automatic provenance"), "later staged versions get automatic provenance");
  assert.ok(readme.includes("publish-npm.yml"), "the trusted publisher workflow filename is documented");
  assert.ok(readme.includes("stage-only"), "the trusted publisher permission is documented");
  assert.ok(readme.includes("within two days"), "the trusted-publisher activation window is documented");
  assert.ok(readme.includes("restrict any traditional npm tokens"), "token restriction after activation is documented");
  assert.ok(/has\s+\*\*not been configured yet\*\*/.test(readme), "the trusted publisher is not claimed to be configured");
  assert.ok(readme.includes("NPM_CONFIG_USERCONFIG"), "the setup-node npmrc placeholder is documented");
  assert.ok(readme.includes("placeholder"), "the placeholder is described as a placeholder, not a token");
  assert.ok(!/no `NODE_AUTH_TOKEN`, no\s+`NPM_TOKEN`, no\s+`\.npmrc` written/.test(readme), "the old npmrc claim is gone");
  assert.ok(/2FA/.test(readme), "approval still requires 2FA");
  assert.ok(
    /atomically bind the verifier/.test(readme) && /outside this control/.test(readme),
    "the residual boundary of the pre-stage revalidation is documented",
  );
  assert.ok(!/npm\s+(?:i|install|add)\s+(?:-g|--global\s+)?skill-router\b/.test(readme), "the taken unscoped name is never installable");
  assert.match(
    readme,
    /not on npm yet[\s\S]{0,400}npm install --global @openagency\.io\/skill-router/,
    "the install command carries the unpublished caveat",
  );
});
