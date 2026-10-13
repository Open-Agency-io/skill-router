/**
 * Dependency-free planning/validation helpers for the containerized harness
 * matrix (Phase 1 substrate, Gate 1 remediation).
 *
 * Everything here is pure (manifest/package data in, frozen specs and command
 * arrays out) so matrix expansion, image/package/version mapping, per-case
 * `docker run` construction, secret-name allowlisting, and redaction are
 * unit-testable without Docker and without a mocking dependency.
 *
 * Trust model:
 *   - builds record an immutable image id (`docker build --iidfile`);
 *   - every live run executes an `sha256:<64hex>` image id with `--pull=never`;
 *     mutable tags are display/plan-only;
 *   - live execution has exactly one route: `resolveSpecImage()` ->
 *     `runSpecToArgv()` -> `assertSafeRunSpec()` + `assertSafeRunArgv()` ->
 *     executor;
 *   - `host` networking, host namespaces, devices, env-files, the docker
 *     socket, and non-read-only binds are rejected during planning and again
 *     immediately before the image boundary.
 *
 * Secrets contract:
 *   - only allowlisted *names* are ever placed on a command line, as
 *     `--env=NAME` (Docker inherits the value from the runner process);
 *   - allowlists are scoped per harness (Claude cases take only
 *     `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` — never an API
 *     key — and OpenCode cases never receive that token), and names outside
 *     a harness's allowlist are excluded rather than fanned in;
 *   - present secret values shorter than 8 characters are rejected before
 *     execution, and every nonempty selected value is redacted centrally;
 *   - secret *values* never appear in argv, build args, labels, or output.
 *
 * Build context contract: `stageBuildContext()` copies exactly four files
 * (Dockerfile, verifier, case runner, and the immutable router wrapper) into a
 * private temporary directory; the Docker daemon never receives the repository,
 * the `scripts/` tree, HOME, or any secret.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

/** Repository-relative locations of the container substrate. */
export const CONTAINER_FILES = Object.freeze({
  matrix: path.join("test", "container", "matrix.json"),
  dockerfile: path.join("test", "container", "Dockerfile"),
  context: path.join("test", "container"),
  verifyScript: path.join("scripts", "container-verify.mjs"),
  caseRunner: path.join("scripts", "container-run-case.mjs"),
  routerWrapper: path.join("scripts", "router-wrapper.mjs"),
  stagedDockerfile: "Dockerfile",
  stagedVerifier: "container-verify.mjs",
  stagedCaseRunner: "run-case.mjs",
  stagedRouterWrapper: "router-wrapper.mjs",
});

export const LABELS = Object.freeze({
  case: "dev.openagency.skill-router.case",
  harness: "dev.openagency.skill-router.harness",
  run: "dev.openagency.skill-router.run",
  phase: "dev.openagency.skill-router.phase",
});

/** Container-local layout. Host repository/HOME/config are never mounted. */
export const RUNTIME = Object.freeze({
  user: "1000:1000",
  uid: 1000,
  gid: 1000,
  home: "/home/node",
  workspace: "/workspace",
  artifact: "/input/skill-router.tgz",
  artifactDir: "/input",
  installDir: "/opt/skill-router-install",
  /**
   * Package bin executed *through the immutable image-layer wrapper*: npm
   * package storage is non-executable under this substrate, so this path is
   * never placed on PATH.
   */
  installBin: "/opt/skill-router-install/node_modules/.bin",
  /**
   * Immutable wrapper directory baked into the read-only rootfs. It is already
   * on the standard image PATH; the case runner prepends it exactly once and
   * strips the package `.bin` so child PATHs are deterministic.
   */
  wrapperDir: "/usr/local/bin",
  wrapperPath: "/usr/local/bin/skill-router",
  verifyScript: "/usr/local/lib/skill-router/verify-harness.mjs",
  /** Phase 2 seam: in-container case entrypoint, not yet shipped. */
  caseEntrypoint: "/usr/local/lib/skill-router/run-case.mjs",
  /**
   * Fixed read-only credential directory mount for OpenCode cases. It always
   * contains exactly this invocation's two files: the byte-exact legacy
   * `auth.json` (v1 stages it) and `auth-import.json` (v2 imports it).
   */
  opencodeAuthDir: "/input/opencode-credential",
  /** File names inside that fixed credential directory. */
  opencodeAuthLegacy: "auth.json",
  opencodeAuthImport: "auth-import.json",
  /** Credential path relative to XDG_DATA_HOME inside the case container. */
  opencodeAuthData: "opencode/auth.json",
});

/** Fresh container-local writable filesystems (tmpfs, per container). */
/**
 * Fresh container-local writable filesystems (tmpfs, per container).
 *
 * Every writable mount is explicitly `noexec`: Docker Desktop reports `noexec`
 * for all four even when it is omitted, so we request it rather than assume it.
 * Nothing in this harness executes from a tmpfs — the router runs through the
 * immutable image-layer wrapper, harness binaries live in the rootfs, and node
 * *reads* package files instead of executing them.
 */
export const TMPFS = Object.freeze({
  tmp: "/tmp:rw,noexec,nosuid,nodev,size=67108864,mode=1777",
  home: "/home/node:rw,noexec,nosuid,nodev,size=134217728,mode=0700,uid=1000,gid=1000",
  workspace: "/workspace:rw,noexec,nosuid,nodev,size=268435456,mode=0700,uid=1000,gid=1000",
  install: "/opt/skill-router-install:rw,noexec,nosuid,nodev,size=268435456,mode=0700,uid=1000,gid=1000",
});

/** Hardening applied to every container run (exact, mandatory set). */
export const ISOLATION_FLAGS = Object.freeze([
  "--rm",
  "--init",
  "--read-only",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
  "--pids-limit=512",
]);

/** Immutable-image execution: never resolved through a mutable tag. */
export const PULL_POLICY = "--pull=never";

/** Flags/mount sources/host namespaces that must never appear in a run. */
export const FORBIDDEN_RUN_TOKENS = Object.freeze([
  "--privileged",
  "--privileged=true",
  "-v",
  "--volume",
  "--env-file",
  "--device",
  "--cap-add",
  "--pid=host",
  "--ipc=host",
  "--uts=host",
  "--cgroupns=host",
  "--userns=host",
  "--network=host",
  "--net=host",
  "/var/run/docker.sock",
]);

/** Docker run options the canonical construction may use, and nothing else. */
export const RUN_OPTION_WHITELIST = Object.freeze([
  "--rm",
  "--init",
  "--read-only",
  "--cap-drop",
  "--security-opt",
  "--pids-limit",
  "--name",
  "--cidfile",
  "--pull",
  "--label",
  "--network",
  "--user",
  "--tmpfs",
  "--mount",
  "--env",
  "--workdir",
]);

/** Options that may appear at most once in a run command. */
export const RUN_SCALAR_ONCE_OPTIONS = Object.freeze([
  "--rm",
  "--init",
  "--read-only",
  "--cap-drop",
  "--security-opt",
  "--pids-limit",
  "--name",
  "--cidfile",
  "--pull",
  "--network",
  "--user",
  "--workdir",
]);

export const ENV_KEYS = Object.freeze({
  baseImage: "SKILL_ROUTER_CONTAINER_BASE_IMAGE",
  imagePrefix: "SKILL_ROUTER_IMAGE_PREFIX",
  secretEnv: "SKILL_ROUTER_SECRET_ENV",
  network: "SKILL_ROUTER_CONTAINER_NETWORK",
  opencodeAuthFile: "SKILL_ROUTER_OPENCODE_AUTH_FILE",
});

export const SMOKE_NETWORK = "none";
export const DEFAULT_CASE_NETWORK = "bridge";
/** Minimum accepted length for a present secret value, enforced pre-execution. */
export const MIN_SECRET_LENGTH = 8;
/**
 * Claude Code long-lived subscription credential (`claude setup-token`).
 * Allowlisted globally, but scoped by the manifest to the Claude harness
 * only: OpenCode commands, host pack/build/probe commands, and smoke runs
 * never receive it, and it is always inherited by name (`--env=NAME`).
 */
export const CLAUDE_CODE_OAUTH_TOKEN = "CLAUDE_CODE_OAUTH_TOKEN";

/** Non-secret environment applied to every container run.
 * (`npm_config_update_notifier` is already baked into the image ENV.) */
export const RUNTIME_ENV = Object.freeze({
  HOME: RUNTIME.home,
  XDG_CONFIG_HOME: `${RUNTIME.home}/.config`,
  XDG_DATA_HOME: `${RUNTIME.home}/.local/share`,
  XDG_CACHE_HOME: `${RUNTIME.home}/.cache`,
  XDG_STATE_HOME: `${RUNTIME.home}/.local/state`,
  NO_COLOR: "1",
});

/**
 * Pinned identity of the immutable router wrapper
 * (`scripts/router-wrapper.mjs`, COPY'd to `RUNTIME.wrapperPath`).
 * The container-side copy of these constants is asserted equal here by tests,
 * and the Dockerfile embeds the same digest.
 */
export const ROUTER_WRAPPER_SHA256 = "6c0a7f4a60c40d2584f00ede1aca6ff5d8876f4fd9d58715ce84ec8cb890bf64";
/** Image-layer wrapper mode: readable + executable by everyone, writable by no one. */
export const ROUTER_WRAPPER_MODE = 0o555;

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const IMAGE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;
const IMAGE_PREFIX_RE = /^[a-z0-9][a-z0-9._/-]*$/;
export const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;
const DIGEST_PIN_RE = /@sha256:[0-9a-f]{64}$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const CASE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const NETWORK_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export class PlanError extends Error {
  constructor(message) {
    super(message);
    this.name = "PlanError";
    this.code = "PLAN_ERROR";
  }
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

export function assertVersion(value, label) {
  if (typeof value !== "string" || !VERSION_RE.test(value)) {
    throw new PlanError(`${label} must be an exact semantic version (e.g. 1.18.34), received "${String(value)}"`);
  }
  return value;
}

export function assertImageRef(value, label) {
  if (typeof value !== "string" || !IMAGE_REF_RE.test(value) || /\s/.test(value)) {
    throw new PlanError(`${label} is not a valid image reference: "${String(value)}"`);
  }
  return value;
}

export function assertImageId(value) {
  if (typeof value !== "string" || !IMAGE_ID_RE.test(value)) {
    throw new PlanError(
      `expected an immutable image id of the form sha256:<64 hex>, received "${String(value).slice(0, 80)}"`,
    );
  }
  return value;
}

export function isDigestPinned(imageRef) {
  return typeof imageRef === "string" && DIGEST_PIN_RE.test(imageRef);
}

export function assertEnvName(value) {
  if (typeof value !== "string" || !ENV_NAME_RE.test(value)) {
    throw new PlanError(`"${String(value)}" is not a valid uppercase environment variable name`);
  }
  return value;
}

/** Rejects host/container networking during planning and validation. */
export function assertNetwork(value) {
  const network = String(value ?? "");
  if (network === "host" || network.startsWith("container:")) {
    throw new PlanError(
      `container network "${network}" is forbidden: the matrix never shares the host network namespace ` +
        "(case runs use the isolated bridge network, smoke runs use --network=none; live bridge traffic " +
        "can reach the internet and potentially the host/LAN, but never the host network namespace)",
    );
  }
  if (!NETWORK_RE.test(network)) {
    throw new PlanError(`invalid container network "${network}"`);
  }
  return network;
}

export function isInside(candidate, root) {
  if (!candidate || !root) return false;
  const target = path.resolve(candidate);
  const base = path.resolve(root);
  return target === base || target.startsWith(`${base}${path.sep}`);
}

/** Docker/OCI architecture -> Node `process.arch` naming. */
export function dockerArchToNodeArch(architecture) {
  const table = { amd64: "x64", 386: "ia32", arm64: "arm64", aarch64: "arm64", arm: "arm" };
  return table[architecture] ?? architecture;
}

/* -------------------------------------------------------------------------- */
/* Manifest loading                                                            */
/* -------------------------------------------------------------------------- */

export function loadMatrix(repoRoot) {
  const file = path.join(repoRoot, CONTAINER_FILES.matrix);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new PlanError(`could not read the container matrix at ${CONTAINER_FILES.matrix}: ${error.code ?? error.message}`);
  }
  assertManifest(manifest);
  return manifest;
}

export function loadPackageMetadata(repoRoot) {
  const file = path.join(repoRoot, "package.json");
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed.name || !parsed.version) {
    throw new PlanError("package.json must declare name and version to predict the packed artifact name");
  }
  return { name: parsed.name, version: parsed.version };
}

export function assertManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1) {
    throw new PlanError("matrix.json must declare schemaVersion 1");
  }
  if (!manifest.baseImage || !IMAGE_REF_RE.test(manifest.baseImage)) {
    throw new PlanError("matrix.json baseImage is missing or invalid");
  }
  if (!isDigestPinned(manifest.baseImage)) {
    throw new PlanError(
      "matrix.json baseImage must be pinned by multi-architecture manifest digest " +
        "(<image>@sha256:<64 hex>); re-verify the digest with `docker buildx imagetools inspect`",
    );
  }
  if (!manifest.imagePrefix || !IMAGE_PREFIX_RE.test(manifest.imagePrefix)) {
    throw new PlanError("matrix.json imagePrefix is missing or invalid");
  }
  if (!manifest.providerKeyMap || typeof manifest.providerKeyMap !== "object" || Array.isArray(manifest.providerKeyMap)) {
    throw new PlanError("matrix.json must declare providerKeyMap (provider id -> secret env name)");
  }
  const providerEntries = Object.entries(manifest.providerKeyMap);
  if (providerEntries.length === 0) throw new PlanError("matrix.json providerKeyMap must not be empty");
  for (const [provider, keyName] of providerEntries) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(provider)) {
      throw new PlanError(`matrix.json providerKeyMap key "${provider}" is not a valid provider id`);
    }
    assertEnvName(keyName);
    if (!manifest.secretEnvAllowlist.includes(keyName)) {
      throw new PlanError(`matrix.json providerKeyMap["${provider}"] = "${keyName}" is not in the secret allowlist`);
    }
  }
  if (!Array.isArray(manifest.secretEnvAllowlist) || manifest.secretEnvAllowlist.length === 0) {
    throw new PlanError("matrix.json must declare a non-empty secretEnvAllowlist");
  }
  for (const name of manifest.secretEnvAllowlist) assertEnvName(name);
  if (!manifest.harnesses || Object.keys(manifest.harnesses).length === 0) {
    throw new PlanError("matrix.json must declare harnesses");
  }
  for (const [id, harness] of Object.entries(manifest.harnesses)) {
    assertHarness(id, harness, manifest.secretEnvAllowlist);
  }
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    throw new PlanError("matrix.json must declare cases");
  }
  const seen = new Set();
  for (const entry of manifest.cases) {
    if (!entry.id || !CASE_ID_RE.test(entry.id)) {
      throw new PlanError(`case id "${String(entry.id)}" must match ${CASE_ID_RE}`);
    }
    if (seen.has(entry.id)) throw new PlanError(`duplicate case id "${entry.id}"`);
    seen.add(entry.id);
    if (!manifest.harnesses[entry.harness]) {
      throw new PlanError(`case "${entry.id}" references unknown harness "${entry.harness}"`);
    }
    if (typeof entry.scenario !== "string" || !entry.scenario) {
      throw new PlanError(`case "${entry.id}" must declare a scenario`);
    }
    if (!Number.isInteger(entry.phase)) {
      throw new PlanError(`case "${entry.id}" must declare an integer phase`);
    }
  }
  return manifest;
}

function assertHarness(id, harness, globalAllowlist) {
  if (!harness.package || typeof harness.package !== "string") {
    throw new PlanError(`harness "${id}" must declare an npm package`);
  }
  assertVersion(harness.version, `harness "${id}" pinned version`);
  if (!ENV_NAME_RE.test(harness.versionEnv ?? "")) {
    throw new PlanError(`harness "${id}" versionEnv must be an uppercase env variable name`);
  }
  if (!harness.binary || !/^[A-Za-z0-9._-]+$/.test(harness.binary)) {
    throw new PlanError(`harness "${id}" binary name is invalid`);
  }
  if (!Number.isInteger(harness.major) || harness.major < 1) {
    throw new PlanError(`harness "${id}" must declare an integer major`);
  }
  if (!harness.dockerTarget || !/^[a-z0-9][a-z0-9-]*$/.test(harness.dockerTarget)) {
    throw new PlanError(`harness "${id}" dockerTarget is invalid`);
  }
  if (!Array.isArray(harness.secretAllowlist) || harness.secretAllowlist.length === 0) {
    throw new PlanError(`harness "${id}" must declare a non-empty per-harness secretAllowlist`);
  }
  for (const name of harness.secretAllowlist) {
    assertEnvName(name);
    if (!globalAllowlist.includes(name)) {
      throw new PlanError(`harness "${id}" secretAllowlist entry "${name}" is not in the manifest allowlist`);
    }
  }
  if (harness.runtimeEnv !== undefined) {
    if (typeof harness.runtimeEnv !== "object" || harness.runtimeEnv === null || Array.isArray(harness.runtimeEnv)) {
      throw new PlanError(`harness "${id}" runtimeEnv must be an object`);
    }
    for (const [key, value] of Object.entries(harness.runtimeEnv)) {
      assertEnvName(key);
      if (typeof value !== "string" || value.includes("\n")) {
        throw new PlanError(`harness "${id}" runtimeEnv.${key} must be a single-line string`);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Overrides and image references                                              */
/* -------------------------------------------------------------------------- */

/**
 * Base image resolution. A digest-pinned default is reproducible; an override
 * is reported by the runner so the weakened claim stays visible.
 */
export function resolveBaseImageInfo(manifest, env = {}) {
  const override = env[ENV_KEYS.baseImage]?.trim();
  const image = assertImageRef(override || manifest.baseImage, ENV_KEYS.baseImage);
  return {
    image,
    tag: image.split("@", 1)[0],
    digest: image.includes("@") ? image.slice(image.indexOf("@") + 1) : null,
    pinned: isDigestPinned(image),
    overridden: Boolean(override && override !== manifest.baseImage),
    overrideEnv: ENV_KEYS.baseImage,
  };
}

export function resolveBaseImage(manifest, env = {}) {
  return resolveBaseImageInfo(manifest, env).image;
}

export function resolveImagePrefix(manifest, env = {}) {
  const value = env[ENV_KEYS.imagePrefix]?.trim() || manifest.imagePrefix;
  if (!IMAGE_PREFIX_RE.test(value)) {
    throw new PlanError(`${ENV_KEYS.imagePrefix} is not a valid image name prefix: "${value}"`);
  }
  return value;
}

export function resolveHarnessVersion(harness, env = {}) {
  const override = env[harness.versionEnv]?.trim();
  return assertVersion(override || harness.version, harness.versionEnv);
}

export function imageReference(manifest, harnessId, version, env = {}) {
  const prefix = resolveImagePrefix(manifest, env);
  return assertImageRef(`${prefix}:${harnessId}-${version}`, "image reference");
}

/* -------------------------------------------------------------------------- */
/* Matrix expansion                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Expand the manifest into fully resolved case descriptors (pins applied,
 * image reference computed, per-harness secret allowlist attached). Filters
 * are opt-in; the default is every case.
 */
export function expandMatrix(manifest, { env = {}, cases = null, harnesses = null } = {}) {
  assertManifest(manifest);
  const wantedCases = cases && cases.length ? new Set(cases) : null;
  const wantedHarnesses = harnesses && harnesses.length ? new Set(harnesses) : null;
  const expanded = [];
  for (const entry of manifest.cases) {
    const harness = manifest.harnesses[entry.harness];
    if (wantedCases && !wantedCases.has(entry.id)) continue;
    if (wantedHarnesses && !wantedHarnesses.has(entry.harness)) continue;
    const version = resolveHarnessVersion(harness, env);
    expanded.push({
      id: entry.id,
      scenario: entry.scenario,
      phase: entry.phase,
      harness: entry.harness,
      displayName: harness.displayName ?? entry.harness,
      package: harness.package,
      version,
      binary: harness.binary,
      major: harness.major,
      target: harness.dockerTarget,
      image: imageReference(manifest, entry.harness, version, env),
      runtimeEnv: { ...(harness.runtimeEnv ?? {}) },
      secretAllowlist: [...harness.secretAllowlist],
    });
  }
  if (wantedCases) {
    for (const id of wantedCases) {
      if (!manifest.cases.some((entry) => entry.id === id)) {
        throw new PlanError(`unknown case id "${id}"; known ids: ${manifest.cases.map((c) => c.id).join(", ")}`);
      }
    }
  }
  if (wantedHarnesses) {
    for (const id of wantedHarnesses) {
      if (!manifest.harnesses[id]) {
        throw new PlanError(`unknown harness id "${id}"; known ids: ${Object.keys(manifest.harnesses).join(", ")}`);
      }
    }
  }
  return expanded;
}

/** Resolved build descriptors for one or all harness images. */
export function expandHarnesses(manifest, { env = {}, harnesses = null } = {}) {
  assertManifest(manifest);
  const wanted = harnesses && harnesses.length ? new Set(harnesses) : null;
  if (wanted) {
    for (const id of wanted) {
      if (!manifest.harnesses[id]) {
        throw new PlanError(`unknown harness id "${id}"; known ids: ${Object.keys(manifest.harnesses).join(", ")}`);
      }
    }
  }
  return Object.entries(manifest.harnesses)
    .filter(([id]) => !wanted || wanted.has(id))
    .map(([id, harness]) => {
      const version = resolveHarnessVersion(harness, env);
      return {
        id,
        displayName: harness.displayName ?? id,
        package: harness.package,
        version,
        binary: harness.binary,
        major: harness.major,
        target: harness.dockerTarget,
        image: imageReference(manifest, id, version, env),
        runtimeEnv: { ...(harness.runtimeEnv ?? {}) },
        secretAllowlist: [...harness.secretAllowlist],
      };
    });
}

/* -------------------------------------------------------------------------- */
/* Secret environment handling                                                 */
/* -------------------------------------------------------------------------- */

function requestedSecretNames(requested, env) {
  const raw = [...(requested ?? [])];
  const fromEnvironment = env[ENV_KEYS.secretEnv];
  if (fromEnvironment) raw.push(fromEnvironment);
  const names = [];
  for (const entry of raw) {
    for (const part of String(entry).split(",")) {
      const name = part.trim();
      if (name) names.push(name);
    }
  }
  return [...new Set(names)];
}

/**
 * Validate requested secret env *names* against the manifest allowlist and,
 * when a harness is given, scope them to that harness's allowlist.
 *
 * Values are never returned or printed; callers only ever place names on
 * command lines. `excluded` lists globally-allowed names that this harness
 * must not receive (they are dropped, never fanned in).
 */
export function resolveSecretEnvNames({
  requested = [],
  manifest,
  hostEnv = {},
  requirePresent = false,
  harnessId = null,
} = {}) {
  assertManifest(manifest);
  const names = requestedSecretNames(requested, hostEnv);
  const allowlist = manifest.secretEnvAllowlist;
  const rejected = [];
  const missing = [];
  for (const name of names) {
    if (!ENV_NAME_RE.test(name) || !allowlist.includes(name)) {
      rejected.push(name);
      continue;
    }
    if (hostEnv[name] === undefined || hostEnv[name] === "") missing.push(name);
  }
  if (rejected.length) {
    throw new PlanError(
      `refusing to pass non-allowlisted secret env name(s): ${rejected.join(", ")}. ` +
        `Allowlisted names: ${allowlist.join(", ")}. Values are inherited with --env=NAME, never placed on the command line.`,
    );
  }
  let scoped = names;
  let excluded = [];
  if (harnessId) {
    const harness = manifest.harnesses[harnessId];
    if (!harness) {
      throw new PlanError(`unknown harness id "${harnessId}"; known ids: ${Object.keys(manifest.harnesses).join(", ")}`);
    }
    scoped = names.filter((name) => harness.secretAllowlist.includes(name));
    excluded = names.filter((name) => !harness.secretAllowlist.includes(name));
  }
  if (requirePresent && missing.length) {
    throw new PlanError(
      `allowlisted secret env not set in the host environment: ${missing.join(", ")}. ` +
        "Export it, or drop it from --secret-env; Phase 1 smoke/build/list/plan need no credentials at all.",
    );
  }
  if (requirePresent) assertSecretValuesUsable(hostEnv, scoped);
  return { names: scoped, missing, excluded };
}

/** Present secret values must be plausible credentials (>= 8 chars). */
export function assertSecretValuesUsable(hostEnv, names) {
  const implausible = [];
  for (const name of names) {
    const value = hostEnv[name];
    if (value === undefined || value === "") continue;
    if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) implausible.push(name);
  }
  if (implausible.length) {
    throw new PlanError(
      `secret env value(s) shorter than ${MIN_SECRET_LENGTH} characters: ${implausible.join(", ")}. ` +
        "Refusing to execute with a implausible credential (values withheld from this message).",
    );
  }
  return names;
}

/**
 * Every nonempty selected value, for redaction only. Long values are replaced
 * wherever they appear; very short values (possible in a hostile environment)
 * are replaced on word boundaries so failure text cannot leak them either.
 */
export function collectSecretValues(hostEnv, names) {
  const values = [];
  for (const name of names ?? []) {
    const value = hostEnv[name];
    if (typeof value === "string" && value.length > 0) values.push(value);
  }
  return [...new Set(values)];
}

/**
 * Credential-free copy of the host environment for every host-side
 * subprocess (npm pack, docker build/probe/inspect/ps/rm): every allowlisted
 * provider credential is deleted, never inherited.
 */
export function createSafeHostEnv(hostEnv, allowlist) {
  const blocked = new Set(allowlist ?? []);
  const safe = {};
  for (const [key, value] of Object.entries(hostEnv ?? {})) {
    if (blocked.has(key)) continue;
    safe[key] = value;
  }
  return safe;
}

/**
 * Environment for one Docker case/smoke command: the credential-free host
 * environment plus exactly the spec's selected secret names (values are
 * required for `--env NAME` inheritance) and nothing else from the allowlist.
 */
export function containerRunEnv({ safeEnv, hostEnv, spec, allowlist }) {
  const base = { ...(safeEnv ?? {}) };
  const selected = [...(spec?.secretNames ?? [])];
  for (const name of selected) assertEnvName(name);
  for (const name of allowlist ?? []) delete base[name];
  for (const name of selected) {
    const value = hostEnv?.[name];
    if (value !== undefined && value !== "") base[name] = value;
  }
  return base;
}

/* -------------------------------------------------------------------------- */
/* OpenCode legacy auth.json snapshot (explicit, never defaulted)             */
/* -------------------------------------------------------------------------- */

/**
 * Hard bound on an explicitly requested OpenCode auth file. Real legacy
 * `auth.json` files hold a handful of credentials, so 64 KiB is generous;
 * anything larger is rejected before parsing (and before any subprocess).
 */
export const OPENCODE_AUTH_MAX_BYTES = 64 * 1024;
/** Maximum provider entries accepted in one auth document. */
export const OPENCODE_AUTH_MAX_ENTRIES = 64;
/**
 * Provider ids a snapshot may satisfy. A fixed allowlist — never derived from
 * file contents — so an unknown entry in the file can never widen the set of
 * supported providers (every other provider stays bound to `providerKeyMap`).
 */
export const OPENCODE_AUTH_SUPPORTED_PROVIDERS = Object.freeze(["openai", "opencode-go"]);
/**
 * Legacy credential types this runner can convert into the pinned v2
 * `Credential.Entry[]` shape (`api`/`wellknown` -> key, `oauth` -> oauth).
 * A supported provider with any other type is rejected before subprocesses.
 */
export const OPENCODE_AUTH_IMPORTABLE_TYPES = Object.freeze(["api", "wellknown", "oauth"]);
export const OPENCODE_AUTH_PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const OPENCODE_AUTH_TYPE_RE = /^[a-z][a-z0-9-]{0,15}$/;
/** Strings at least this long inside a validated auth document join the
 * in-memory redaction set; they are never logged or stored anywhere else. */
export const OPENCODE_AUTH_REDACTION_MIN_LENGTH = 8;

/** True for the OpenCode harnesses (the only auth-snapshot-eligible harnesses). */
export function isOpenCodeHarness(harness) {
  return harness?.binary === "opencode";
}

/** Harness ids that may receive the OpenCode auth snapshot. */
export function openCodeHarnessIds(manifest) {
  assertManifest(manifest);
  return Object.entries(manifest.harnesses)
    .filter(([, harness]) => isOpenCodeHarness(harness))
    .map(([id]) => id);
}

/** Credential-shaped key names that must be redacted even when short. */
const OPENCODE_AUTH_CREDENTIAL_KEY_RE = /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)$/i;

/**
 * Full traversal of a validated auth document, for redaction only. JSON is
 * acyclic and the document is already bounded by `OPENCODE_AUTH_MAX_BYTES`,
 * so there is deliberately **no** depth or count truncation: every object key
 * and every string value at or above the redaction threshold is collected
 * (plus credential-shaped keys down to 4 characters). Nothing collected here
 * is ever logged or serialized.
 */
export function collectOpenCodeAuthValues(node, out = []) {
  if (typeof node === "string") {
    if (node.length >= OPENCODE_AUTH_REDACTION_MIN_LENGTH) out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const entry of node) collectOpenCodeAuthValues(entry, out);
    return out;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (
        key.length >= OPENCODE_AUTH_REDACTION_MIN_LENGTH ||
        (key.length >= 4 && OPENCODE_AUTH_CREDENTIAL_KEY_RE.test(key))
      ) {
        out.push(key);
      }
      collectOpenCodeAuthValues(value, out);
    }
  }
  return out;
}

/**
 * Structural validation of a parsed auth document: only provider ids and their
 * `type` are interpreted, and everything else is treated as credential
 * material for the redaction set. Error messages never carry values, file
 * content, or paths; an offending entry is named only by an id that already
 * matched the provider-id pattern.
 */
export function parseOpenCodeAuthDocument(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PlanError("the OpenCode auth file must contain a JSON object at the top level (content is never reported)");
  }
  const pairs = Object.entries(parsed);
  if (pairs.length === 0) throw new PlanError("the OpenCode auth file contains no provider entries");
  if (pairs.length > OPENCODE_AUTH_MAX_ENTRIES) {
    throw new PlanError(`the OpenCode auth file declares more than ${OPENCODE_AUTH_MAX_ENTRIES} provider entries`);
  }
  const providers = [];
  const typed = [];
  for (const [id, value] of pairs) {
    if (!OPENCODE_AUTH_PROVIDER_ID_RE.test(id)) {
      throw new PlanError("the OpenCode auth file contains a provider id that is not a lowercase provider identifier");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new PlanError(`OpenCode auth entry "${id}" must be a JSON object`);
    }
    if (typeof value.type !== "string" || !OPENCODE_AUTH_TYPE_RE.test(value.type)) {
      throw new PlanError(`OpenCode auth entry "${id}" is missing a valid type`);
    }
    // A supported provider must be convertible *and* carry usable credential
    // material, otherwise the run would fail inside the container instead of
    // here, before any subprocess. No values are ever echoed.
    if (OPENCODE_AUTH_SUPPORTED_PROVIDERS.includes(id)) assertOpenCodeCredentialShape(id, value);
    providers.push(id);
    typed.push(Object.freeze({ id, type: value.type, value }));
  }
  providers.sort();
  const supported = OPENCODE_AUTH_SUPPORTED_PROVIDERS.filter((id) => providers.includes(id));
  // Redaction material comes from the *entries* only: root keys are validated
  // provider ids, which this substrate deliberately prints as neutral metadata
  // (preflight and the JSON audit report provider ids by design).
  const redaction = [];
  for (const [, value] of pairs) collectOpenCodeAuthValues(value, redaction);
  return Object.freeze({
    providers: Object.freeze(providers),
    supported: Object.freeze(supported),
    entries: Object.freeze(typed),
    values: Object.freeze([...new Set(redaction)]),
  });
}

/**
 * Fail-fast shape checks for providers this runner actually uses: the type
 * must be convertible and the credential material required by the pinned v2
 * import schema must be present. Messages name the provider id only.
 */
function assertOpenCodeCredentialShape(id, value) {
  if (!OPENCODE_AUTH_IMPORTABLE_TYPES.includes(value.type)) {
    throw new PlanError(
      `OpenCode auth entry "${id}" has credential type "${value.type}", which this runner cannot convert ` +
        `(supported: ${OPENCODE_AUTH_IMPORTABLE_TYPES.join(", ")})`,
    );
  }
  if (value.type === "oauth") {
    const refresh = value.refresh ?? value.refreshToken;
    const access = value.access ?? value.accessToken;
    if (typeof refresh !== "string" || refresh.length === 0 || typeof access !== "string" || access.length === 0) {
      throw new PlanError(`OpenCode auth entry "${id}" is an oauth credential without refresh/access material`);
    }
    return;
  }
  const key = value.type === "api" ? value.key : (value.token ?? value.key);
  if (typeof key !== "string" || key.length === 0) {
    throw new PlanError(`OpenCode auth entry "${id}" is a key credential without a key`);
  }
}

/** Deterministic, non-secret credential id derived from the provider id. */
export function openCodeCredentialId(providerId) {
  return createHash("sha256").update(String(providerId)).digest("hex");
}

/**
 * Convert the validated legacy document into the pinned v2
 * `Credential.Entry[]` accepted by `opencode auth import <file> --standalone`.
 *
 * Only supported providers and convertible legacy types are emitted; the id is
 * a deterministic hash of the provider id (never a credential value), the
 * label follows the pinned schema (`API key` / `OAuth`), `active` is true, and
 * OpenAI oauth uses method `chatgpt-browser` while other oauth providers use
 * `oauth`. Returned entries contain credential values: private memory and the
 * private snapshot file only.
 *
 * `providers` narrows the result to exactly those provider ids (the selected
 * model provider in production, both supported ids for the `auth-check` seam);
 * a requested id that the validated document does not carry is an error rather
 * than a silent omission.
 */
export function buildOpenCodeImportEntries(document, { providers = null } = {}) {
  if (!document || !Array.isArray(document.entries)) {
    throw new PlanError("buildOpenCodeImportEntries requires a validated auth document");
  }
  const wanted = providers ? [...new Set(providers.map((id) => String(id).toLowerCase()))] : null;
  if (wanted) {
    for (const id of wanted) {
      if (!document.entries.some((entry) => entry.id === id)) {
        throw new PlanError(`the validated OpenCode auth document does not carry provider "${id}"`);
      }
    }
  }
  const entries = [];
  for (const entry of document.entries) {
    if (!OPENCODE_AUTH_SUPPORTED_PROVIDERS.includes(entry.id)) continue;
    if (wanted && !wanted.includes(entry.id)) continue;
    const value = openCodeCredentialValue(entry);
    if (!value) continue;
    entries.push({
      id: openCodeCredentialId(entry.id),
      integrationID: entry.id,
      label: entry.type === "oauth" ? "OAuth" : "API key",
      active: true,
      value,
    });
  }
  if (wanted) {
    const emitted = new Set(entries.map((entry) => entry.integrationID));
    const missing = wanted.filter((id) => !emitted.has(id));
    if (missing.length) {
      throw new PlanError(`provider "${missing.join(", ")}" could not be converted into a v2 import entry`);
    }
  }
  return entries;
}

/**
 * Legacy `auth.json` document containing **exactly** the requested providers,
 * with their values taken from the validated document (nothing else — no
 * unrelated entries, values, or labels are ever written into a snapshot).
 */
export function filteredLegacyAuthBytes(document, providers) {
  if (!document || !Array.isArray(document.entries)) {
    throw new PlanError("filteredLegacyAuthBytes requires a validated auth document");
  }
  const out = {};
  for (const id of providers ?? []) {
    const entry = document.entries.find((candidate) => candidate.id === String(id).toLowerCase());
    if (!entry) throw new PlanError(`the validated OpenCode auth document does not carry provider "${String(id)}"`);
    out[entry.id] = entry.value;
  }
  return Buffer.from(`${JSON.stringify(out, null, 2)}\n`);
}

/** Legacy -> v2 credential value mapping (values stay in private memory). */
function openCodeCredentialValue(entry) {
  const raw = entry.value;
  if (entry.type === "api") {
    const out = { type: "key", key: raw.key };
    if (raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)) out.metadata = raw.metadata;
    return out;
  }
  if (entry.type === "wellknown") {
    const key = typeof raw.token === "string" ? raw.token : raw.key;
    return typeof key === "string" ? { type: "key", key } : null;
  }
  if (entry.type === "oauth") {
    const refresh = raw.refresh ?? raw.refreshToken;
    const access = raw.access ?? raw.accessToken;
    const expires = raw.expires ?? raw.expiresAt;
    if (typeof refresh !== "string" || typeof access !== "string") return null;
    const out = {
      type: "oauth",
      methodID: entry.id === "openai" ? "chatgpt-browser" : "oauth",
      refresh,
      access,
    };
    if (Number.isFinite(expires)) out.expires = expires;
    const metadata = {};
    if (typeof raw.accountId === "string") metadata.accountID = raw.accountId;
    if (typeof raw.enterpriseUrl === "string") metadata.enterpriseUrl = raw.enterpriseUrl;
    if (Object.keys(metadata).length > 0) out.metadata = metadata;
    return out;
  }
  return null;
}

/**
 * Resolve and validate an *explicitly* requested OpenCode auth file. There is
 * no default: an empty request is an error.
 *
 * TOCTOU-safe by construction: the file is opened **once** with
 * `O_RDONLY | O_NOFOLLOW`, every check (`fstat`) and the byte read happen on
 * that same descriptor, and a second `fstat` after the read must still agree
 * with the first (type/size/mode). The path is never re-opened, so a
 * replacement or symlink swap cannot change what is validated. A platform
 * without `O_NOFOLLOW` is rejected rather than downgraded.
 *
 * Failures are structural and never echo path, content, or values. `io` is
 * injectable so tests can exercise descriptor races deterministically.
 */
export function resolveOpenCodeAuthFile({ requested, io = null }) {
  if (typeof requested !== "string" || requested.trim() === "") {
    throw new PlanError(
      "no OpenCode auth file was requested; pass --opencode-auth-file <path> or set " +
        `${ENV_KEYS.opencodeAuthFile} (there is never a default)`,
    );
  }
  const target = path.resolve(requested);
  const open = io?.openSync ?? openSync;
  const fstat = io?.fstatSync ?? fstatSync;
  const read = io?.readFileSync ?? readFileSync;
  const close = io?.closeSync ?? closeSync;
  const constants = io?.constants ?? fsConstants;

  if (typeof constants?.O_RDONLY !== "number" || typeof constants?.O_NOFOLLOW !== "number") {
    throw new PlanError(
      "this platform cannot provide no-follow open semantics for the OpenCode auth file; " +
        "refusing to read it rather than weakening the check (path withheld)",
    );
  }

  let fd;
  try {
    fd = open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = error?.code;
    if (code === "ELOOP") throw new PlanError("the requested OpenCode auth file must not be a symlink (path withheld)");
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new PlanError("the requested OpenCode auth file does not exist (path withheld)");
    }
    throw new PlanError("the requested OpenCode auth file could not be opened (path withheld)");
  }

  try {
    const before = fstat(fd);
    if (!before.isFile()) throw new PlanError("the requested OpenCode auth file must be a regular file");
    if (before.size > OPENCODE_AUTH_MAX_BYTES) {
      throw new PlanError(`the requested OpenCode auth file exceeds the ${OPENCODE_AUTH_MAX_BYTES} byte limit`);
    }
    if ((before.mode & 0o400) === 0) throw new PlanError("the requested OpenCode auth file is not readable by its owner");
    if ((before.mode & 0o077) !== 0) {
      throw new PlanError(
        "the requested OpenCode auth file must be owner-only (no group/other permission bits); " +
          "`chmod 600` it first (path withheld)",
      );
    }

    let bytes;
    try {
      bytes = read(fd);
    } catch {
      throw new PlanError("the requested OpenCode auth file could not be read (path withheld)");
    }
    if (bytes.length > OPENCODE_AUTH_MAX_BYTES) {
      throw new PlanError(`the requested OpenCode auth file exceeds the ${OPENCODE_AUTH_MAX_BYTES} byte limit`);
    }

    const after = fstat(fd);
    if (!after.isFile() || after.size !== before.size || after.size !== bytes.length) {
      throw new PlanError("the requested OpenCode auth file changed while it was being read (path withheld)");
    }
    if ((after.mode & 0o7777) !== (before.mode & 0o7777)) {
      throw new PlanError(
        "the requested OpenCode auth file permissions changed while it was being read (path withheld)",
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new PlanError("the OpenCode auth file is not valid JSON (content is never reported)");
    }
    const document = parseOpenCodeAuthDocument(parsed);
    const importEntries = buildOpenCodeImportEntries(document);
    return Object.freeze({ path: target, size: bytes.length, bytes, importEntries, ...document });
  } finally {
    try {
      close(fd);
    } catch {
      // Closing is best effort; validation already finished.
    }
  }
}

/**
 * Write the validated snapshot into a private owner-only credential directory:
 *   - `auth.json`        a legacy document containing **exactly** the requested
 *                        providers (v1 stages it);
 *   - `auth-import.json` the generated v2 `Credential.Entry[]` for exactly
 *                        those providers (v2 imports it).
 *
 * `providers` is required so a snapshot can never carry an unrelated
 * credential: production passes the single selected model provider, the
 * `auth-check` seam passes both supported ids for its generated dummy.
 *
 * Both files are read back and byte/hash-compared, with modes exactly 0600 and
 * a directory mode exactly 0700. Any throw (including a failed read-back) first
 * removes the partial directory, so a failed creation leaves nothing behind.
 * The caller must register the directory for signal cleanup *before* calling.
 * Returns `{ dir, legacyPath, importPath }` — only this directory is ever
 * mounted, and only for OpenCode cases.
 */
export function createOpenCodeAuthSnapshot({ descriptor, credentialDir, providers, io = null, hooks = null }) {
  if (!descriptor?.entries || !Array.isArray(descriptor.entries) || !Array.isArray(descriptor.importEntries)) {
    throw new PlanError("createOpenCodeAuthSnapshot requires a validated auth descriptor");
  }
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new PlanError("createOpenCodeAuthSnapshot requires the explicit provider list to snapshot");
  }
  if (!credentialDir || !path.isAbsolute(credentialDir)) {
    throw new PlanError("credential directory must be an absolute host path");
  }
  const legacyBytes = filteredLegacyAuthBytes(descriptor, providers);
  const importBytes = Buffer.from(
    `${JSON.stringify(buildOpenCodeImportEntries(descriptor, { providers }), null, 2)}\n`,
  );
  const mkdir = io?.mkdirSync ?? mkdirSync;
  const chmod = io?.chmodSync ?? chmodSync;
  const write = io?.writeFileSync ?? writeFileSync;
  const read = io?.readFileSync ?? readFileSync;
  const stat = io?.statSync ?? statSync;
  const remove = io?.rmSync ?? rmSync;

  const legacyPath = path.join(credentialDir, RUNTIME.opencodeAuthLegacy);
  const importPath = path.join(credentialDir, RUNTIME.opencodeAuthImport);
  const files = [
    { path: legacyPath, bytes: legacyBytes },
    { path: importPath, bytes: importBytes },
  ];

  try {
    mkdir(credentialDir, { recursive: true, mode: 0o700 });
    chmod(credentialDir, 0o700);
    for (const file of files) {
      write(file.path, file.bytes, { mode: 0o600 });
      chmod(file.path, 0o600);
      hooks?.afterWrite?.(file.path);

      // Read-back: byte- and hash-identical to what we intended to write.
      const written = read(file.path);
      const expectedHash = createHash("sha256").update(file.bytes).digest("hex");
      const actualHash = createHash("sha256").update(written).digest("hex");
      if (!written.equals(file.bytes) || actualHash !== expectedHash) {
        throw new PlanError("the OpenCode auth snapshot failed its read-back check (path withheld)");
      }
      const fileStat = stat(file.path);
      if (!fileStat.isFile() || fileStat.size !== file.bytes.length || (fileStat.mode & 0o7777) !== 0o600) {
        throw new PlanError("the OpenCode auth snapshot is not an exact 0600 regular file (path withheld)");
      }
    }
    const dirStat = stat(credentialDir);
    if (!dirStat.isDirectory() || (dirStat.mode & 0o7777) !== 0o700) {
      throw new PlanError("the credential directory is not an exact 0700 directory (path withheld)");
    }
  } catch (error) {
    // Partial creation is never left behind.
    try {
      remove(credentialDir, { recursive: true, force: true });
    } catch {
      // The caller's registered cleanup still owns this directory.
    }
    throw error instanceof PlanError
      ? error
      : new PlanError("the OpenCode auth snapshot could not be written (path withheld)");
  }

  return Object.freeze({ dir: credentialDir, legacyPath, importPath });
}

/**
 * Credential-free dummy document for the `auth-check` seam: generated, never a
 * real host credential, and always written through the same validation +
 * snapshot path as a real one.
 */
export function dummyOpenCodeAuthBytes() {
  return Buffer.from(
    `${JSON.stringify(
      {
        openai: { type: "api", key: "sk-dummy-openai-000000000000000000000000" },
        "opencode-go": { type: "api", key: "sk-dummy-opencode-go-000000000000000000" },
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * Classify a `docker rm -f` result. Only an explicit success (status 0) or an
 * explicit already-absent/no-such-container outcome counts as cleaned;
 * a nonzero status without that hint, a missing exit status, a termination
 * signal, or a spawn error remains a cleanup failure whose target and
 * bookkeeping are retained for retry.
 */
export function classifyRemovalResult(result) {
  if (result?.error) {
    return {
      cleaned: false,
      alreadyAbsent: false,
      reason: `spawn error: ${result.error.code ?? "unknown"}`,
      detail: "",
    };
  }
  if (result?.signal) {
    return {
      cleaned: false,
      alreadyAbsent: false,
      reason: `killed by signal ${result.signal}`,
      detail: "",
    };
  }
  const status = result?.status;
  const detail = `${String(result?.stderr ?? "")}\n${String(result?.stdout ?? "")}`.trim().slice(-600);
  if (status === 0) {
    return { cleaned: true, alreadyAbsent: false, reason: "removed", detail };
  }
  if (typeof status === "number" && /no such container/i.test(detail)) {
    return { cleaned: true, alreadyAbsent: true, reason: "already absent", detail };
  }
  if (typeof status !== "number") {
    return { cleaned: false, alreadyAbsent: false, reason: "no exit status reported by docker rm", detail };
  }
  return { cleaned: false, alreadyAbsent: false, reason: `exit status ${status}`, detail };
}

/** Exact argv equality (element-by-element, order-sensitive). */
export function argvsEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((token, index) => token === right[index]);
}

/* -------------------------------------------------------------------------- */
/* Redaction                                                                   */
/* -------------------------------------------------------------------------- */

function normalizePaths(paths) {
  return paths
    .map((entry) => (typeof entry === "string" ? { value: entry, label: "[path]" } : entry))
    .filter((entry) => entry && typeof entry.value === "string" && entry.value.length > 1)
    .sort((a, b) => b.value.length - a.value.length);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Central sanitizer: every command failure, log line, and rendered argv in
 * this substrate flows through one of these instances. Redacts every nonempty
 * selected secret value, credential-shaped tokens, and host paths
 * (repository, HOME, tmp).
 */
export function createSanitizer({ paths = [], secrets = [] } = {}) {
  const knownPaths = normalizePaths(paths);
  const nonempty = [...new Set(secrets.filter((value) => typeof value === "string" && value.length > 0))]
    .sort((a, b) => b.length - a.length);
  const longSecrets = nonempty.filter((value) => value.length >= 4);
  const shortSecrets = nonempty.filter((value) => value.length < 4);
  return (value) => {
    if (typeof value !== "string" || value === "") return "";
    let output = value;
    for (const secret of longSecrets) output = output.split(secret).join("[redacted]");
    for (const secret of shortSecrets) {
      output = output.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(secret)}(?![A-Za-z0-9])`, "g"), "[redacted]");
    }
    output = output
      .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[redacted-credential]")
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/\bAuthorization["']?\s*[:=]\s*(?:"[^"]*"|\S+)/gi, "Authorization: [redacted]")
      .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, "[redacted-jwt]")
      .replace(/\b(?:sk|pat|api|key|token|secret|auth|password|passwd|bearer)[-_:][A-Za-z0-9_./+=-]{8,}\b/gi, "[redacted]")
      .replace(
        /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Za-z0-9_]*)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
        (_match, key) => `${key}=[redacted]`,
      )
      .replace(/\bses_[A-Za-z0-9]+\b/g, "ses_[redacted]");
    for (const entry of knownPaths) output = output.split(entry.value).join(entry.label);
    return output;
  };
}

/** Render an argv for humans with every token passed through the sanitizer. */
export function displayArgv(argv, sanitize = (value) => value) {
  return argv
    .map((token) => {
      const value = sanitize(String(token));
      return /[\s"'$`\\]/.test(value) ? JSON.stringify(value) : value;
    })
    .join(" ");
}

/**
 * Single failure-reporting path: raw stdout/stderr never reach logs or
 * assertion text before sanitization, and only tails are kept.
 */
export function formatCommandFailure({ label, argv, result, sanitize = (value) => value }) {
  const lines = [`${label} failed`];
  lines.push(`command: ${displayArgv(argv, sanitize)}`);
  if (result?.error) lines.push(`spawn error: ${result.error.code ?? "unknown"}`);
  if (result?.signal) lines.push(`signal: ${result.signal}`);
  if (result?.status !== undefined && result?.status !== null) lines.push(`exit status: ${result.status}`);
  const stderr = sanitize(String(result?.stderr ?? "")).trim();
  if (stderr) lines.push(`stderr (tail):\n${stderr.slice(-4000)}`);
  const stdout = sanitize(String(result?.stdout ?? "")).trim();
  if (stdout) lines.push(`stdout (tail):\n${stdout.slice(-2000)}`);
  return lines.join("\n");
}

/** Structured, sanitized success line for smoke reports (never raw output). */
export function formatSmokeSuccess({ harnessId, report, imageInfo, containerName, sanitize = (value) => value }) {
  const line =
    `smoke ${harnessId}: ok ${report.package}@${report.packageVersion} via ${report.binary} ${report.binaryVersion} ` +
    `(uid ${report.uid}, harness ${report.harnessId}, ${report.platform?.os}/${report.platform?.arch}, ` +
    `image ${imageInfo?.imageId ?? "unknown"}, fresh container ${containerName})`;
  return sanitize(line);
}

/* -------------------------------------------------------------------------- */
/* Build context staging                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Copy exactly the Dockerfile and the verifier into a private temporary
 * context. The Docker daemon therefore never receives the repository or the
 * `scripts/` directory.
 */
export function stageBuildContext({ repoRoot, stageDir }) {
  if (!repoRoot || !stageDir) throw new PlanError("stageBuildContext requires repoRoot and stageDir");
  const staged = [];
  mkdirSync(stageDir, { recursive: true });
  // Exactly four audited files: Dockerfile, verifier, case runner, and the
  // immutable router wrapper. Nothing else (no repository, HOME, or secret)
  // ever reaches the Docker daemon.
  const sources = [
    [path.join(repoRoot, CONTAINER_FILES.dockerfile), CONTAINER_FILES.stagedDockerfile],
    [path.join(repoRoot, CONTAINER_FILES.verifyScript), CONTAINER_FILES.stagedVerifier],
    [path.join(repoRoot, CONTAINER_FILES.caseRunner), CONTAINER_FILES.stagedCaseRunner],
    [path.join(repoRoot, CONTAINER_FILES.routerWrapper), CONTAINER_FILES.stagedRouterWrapper],
  ];
  for (const [source, name] of sources) {
    const target = path.join(stageDir, name);
    copyFileSync(source, target);
    staged.push(name);
  }
  return { stageDir, files: staged };
}

/* -------------------------------------------------------------------------- */
/* Command construction                                                        */
/* -------------------------------------------------------------------------- */

export function newRunId() {
  return `${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

/** npm turns `@scope/name` into `scope-name` for the tarball file name. */
export function predictedTarballName(packageMetadata) {
  const base = packageMetadata.name.replace(/^@/, "").replace(/\//g, "-");
  return `${base}-${packageMetadata.version}.tgz`;
}

/** The artifact is packed exactly once per lifecycle, then reused until cleanup. */
export function planPack({ repoRoot, packageMetadata, destination }) {
  if (!destination) throw new PlanError("planPack requires a destination directory");
  const argv = ["npm", "pack", "--silent", "--pack-destination", destination];
  return {
    argv,
    cwd: repoRoot,
    destination,
    predictedArtifact: path.join(destination, predictedTarballName(packageMetadata)),
  };
}

/**
 * One `docker build` per image, writing an immutable image id through
 * `--iidfile`. `contextDir` must be the staged minimal context (or a
 * synthetic path when dry-running) and `iidDir` the directory that receives
 * `<harnessId>.iid`.
 */
export function planBuild({ manifest, repoRoot, env = {}, harnesses = null, contextDir, iidDir }) {
  assertManifest(manifest);
  if (!contextDir) throw new PlanError("planBuild requires the staged contextDir (see stageBuildContext)");
  if (!iidDir) throw new PlanError("planBuild requires iidDir for docker build --iidfile");
  const dockerfile = path.join(contextDir, CONTAINER_FILES.stagedDockerfile);
  const base = resolveBaseImageInfo(manifest, env);
  return expandHarnesses(manifest, { env, harnesses }).map((harness) => ({
    harnessId: harness.id,
    image: harness.image,
    contextDir,
    dockerfile,
    iidfile: path.join(iidDir, `${harness.id}.iid`),
    baseImage: base,
    argv: [
      "docker",
      "build",
      "--file", dockerfile,
      "--tag", harness.image,
      "--target", harness.target,
      "--iidfile", path.join(iidDir, `${harness.id}.iid`),
      "--build-arg", `NODE_IMAGE=${base.image}`,
      "--build-arg", `HARNESS_PACKAGE=${harness.package}`,
      "--build-arg", `HARNESS_VERSION=${harness.version}`,
      "--build-arg", `HARNESS_BINARY=${harness.binary}`,
      "--build-arg", `HARNESS_MAJOR=${harness.major}`,
      "--build-arg", `HARNESS_ID=${harness.id}`,
      contextDir,
    ],
  }));
}

/* -------------------------------------------------------------------------- */
/* Typed safe run specs                                                        */
/* -------------------------------------------------------------------------- */

function tmpfsTokens(base = true) {
  const tokens = [`--tmpfs=${TMPFS.tmp}`, `--tmpfs=${TMPFS.home}`, `--tmpfs=${TMPFS.workspace}`];
  if (base) tokens.push(`--tmpfs=${TMPFS.install}`);
  return tokens;
}

function assertArtifactIsSafe(artifactPath, { repoRoot, home }) {
  if (!artifactPath) throw new PlanError("artifactPath is required");
  const resolved = path.resolve(artifactPath);
  if (isInside(resolved, repoRoot)) {
    throw new PlanError("the packed artifact must not be read from inside the repository; pack into a temp workdir instead");
  }
  if (home && isInside(resolved, home)) {
    throw new PlanError(
      `the packed artifact must not be read from HOME (${home}); set TMPDIR outside HOME and re-pack`,
    );
  }
  return resolved;
}

function buildSpec({
  kind,
  harnessId,
  imageRef,
  name,
  cidfile,
  network,
  labels,
  includeInstallTmpfs,
  mounts,
  auth = null,
  env,
  secretNames,
  excludedSecretNames,
  workdir,
  command,
}) {
  return Object.freeze({
    kind,
    harnessId,
    imageRef: assertImageRef(imageRef, "image reference"),
    imageId: null,
    name,
    cidfile,
    network: assertNetwork(network),
    user: RUNTIME.user,
    pull: PULL_POLICY,
    labels: Object.freeze({ ...labels }),
    tmpfs: Object.freeze(
      includeInstallTmpfs
        ? [TMPFS.tmp, TMPFS.home, TMPFS.workspace, TMPFS.install]
        : [TMPFS.tmp, TMPFS.home, TMPFS.workspace],
    ),
    mounts: Object.freeze(mounts.map((mount) => Object.freeze({ ...mount }))),
    /** Optional read-only OpenCode credential-dir bind (OpenCode cases only). */
    auth: auth ? Object.freeze({ src: auth.src, dst: RUNTIME.opencodeAuthDir }) : null,
    env: Object.freeze(env.map((entry) => Object.freeze({ ...entry }))),
    secretNames: Object.freeze([...secretNames]),
    excludedSecretNames: Object.freeze([...(excludedSecretNames ?? [])]),
    workdir,
    command: Object.freeze([...command]),
  });
}

function baseSpecFields({ kind, harnessId, imageRef, name, cidfile, network, labels, runtimeEnv, command }) {
  if (!CONTAINER_NAME_RE.test(String(name))) throw new PlanError(`invalid container name "${String(name)}"`);
  if (!cidfile || !path.isAbsolute(cidfile)) throw new PlanError("cidfile must be an absolute host path");
  return {
    kind,
    harnessId,
    imageRef,
    name,
    cidfile,
    network,
    labels,
    env: [
      ...Object.entries(RUNTIME_ENV).map(([key, value]) => ({ name: key, value })),
      ...Object.entries(runtimeEnv ?? {}).map(([key, value]) => ({ name: key, value })),
    ],
    workdir: RUNTIME.workspace,
    command,
  };
}

/**
 * One fresh container for one case, as a typed spec. The returned `argv` is a
 * *preview* (mutable tag, for display and unit tests); live execution must go
 * through `resolveSpecImage()` + `runSpecToArgv()` so only immutable image ids
 * reach the daemon.
 */
export function planCaseRun({
  manifest,
  case: caseDescriptor,
  artifactPath,
  runId,
  secretEnvNames = [],
  excludedSecretNames = [],
  network = DEFAULT_CASE_NETWORK,
  repoRoot,
  home = null,
  command = null,
  cidfile = null,
  authPath = null,
  credentialDir = null,
}) {
  assertManifest(manifest);
  if (!caseDescriptor) throw new PlanError("planCaseRun requires a case descriptor");
  if (!runId) throw new PlanError("planCaseRun requires a runId");
  if (!CASE_ID_RE.test(runId)) throw new PlanError(`runId "${runId}" must match ${CASE_ID_RE}`);
  const artifact = assertArtifactIsSafe(artifactPath, { repoRoot, home });
  const harness = manifest.harnesses[caseDescriptor.harness];
  if (!harness) throw new PlanError(`case "${caseDescriptor.id}" references unknown harness "${caseDescriptor.harness}"`);
  // Only OpenCode cases may ever carry the auth snapshot; a snapshot request
  // for any other harness is dropped here rather than mounted.
  const wantsAuth = Boolean(authPath) && isOpenCodeHarness(harness);
  const name = `skill-router-case-${caseDescriptor.id}-${runId}`;
  const cidfilePath = cidfile ?? path.join(os.tmpdir(), "skill-router-cidfiles", `${name}.cid`);

  const spec = buildSpec({
    ...baseSpecFields({
      kind: "case",
      harnessId: caseDescriptor.harness,
      imageRef: caseDescriptor.image,
      name,
      cidfile: cidfilePath,
      network,
      labels: {
        [LABELS.case]: caseDescriptor.id,
        [LABELS.harness]: caseDescriptor.harness,
        [LABELS.run]: runId,
        [LABELS.phase]: String(caseDescriptor.phase),
      },
      runtimeEnv: caseDescriptor.runtimeEnv,
      command: command ?? ["node", RUNTIME.caseEntrypoint, `--case=${caseDescriptor.id}`],
    }),
    includeInstallTmpfs: true,
    mounts: [{ type: "bind", src: artifact, dst: RUNTIME.artifact, readonly: true }],
    auth: wantsAuth ? { src: authPath } : null,
    secretNames: secretEnvNames,
    excludedSecretNames,
  });

  assertSafeRunSpec(spec, { repoRoot, home, manifest, credentialDir, requireImageId: false });
  return {
    caseId: caseDescriptor.id,
    harness: caseDescriptor.harness,
    image: caseDescriptor.image,
    name,
    cidfile: cidfilePath,
    secretEnvNames: [...secretEnvNames],
    excludedSecretNames: [...(excludedSecretNames ?? [])],
    spec,
    argv: runSpecToArgv(spec, { preview: true }),
  };
}

/**
 * Smoke run: fresh container per harness, no artifact, no credentials,
 * `--network=none`, verifying exact package/binary version as non-root.
 */
export function planSmokeRun({ manifest, harness, runId, cidfile = null }) {
  assertManifest(manifest);
  if (!harness) throw new PlanError("planSmokeRun requires a harness descriptor");
  if (!runId) throw new PlanError("planSmokeRun requires a runId");
  const name = `skill-router-smoke-${harness.id}-${runId}`;
  const cidfilePath = cidfile ?? path.join(os.tmpdir(), "skill-router-cidfiles", `${name}.cid`);

  const spec = buildSpec({
    ...baseSpecFields({
      kind: "smoke",
      harnessId: harness.id,
      imageRef: harness.image,
      name,
      cidfile: cidfilePath,
      network: SMOKE_NETWORK,
      labels: {
        [LABELS.harness]: harness.id,
        [LABELS.run]: runId,
        [LABELS.phase]: "1",
      },
      runtimeEnv: harness.runtimeEnv,
      command: [
        "node",
        RUNTIME.verifyScript,
        `--package=${harness.package}`,
        `--version=${harness.version}`,
        `--binary=${harness.binary}`,
        `--major=${harness.major}`,
        `--harness=${harness.id}`,
        "--expect-non-root",
      ],
    }),
    includeInstallTmpfs: false,
    mounts: [],
    secretNames: [],
    excludedSecretNames: [],
  });

  assertSafeRunSpec(spec, { repoRoot: null, home: null, manifest, requireImageId: false });
  return { harnessId: harness.id, image: harness.image, name, cidfile: cidfilePath, spec, argv: runSpecToArgv(spec, { preview: true }) };
}

/**
 * Credential-free fake-auth validation run (the `auth-check` seam): one fresh
 * `--network=none` container per OpenCode harness mounting a *generated* dummy
 * snapshot at the fixed destination, proving the pinned image recognizes both
 * supported providers locally, without a model request and without ever
 * reading a real host auth file.
 */
export function planAuthCheckRun({ manifest, harness, runId, credentialDir, cidfile = null }) {
  assertManifest(manifest);
  if (!harness || !isOpenCodeHarness(harness)) throw new PlanError("auth-check requires an OpenCode harness");
  if (!runId || !CASE_ID_RE.test(runId)) throw new PlanError(`runId "${String(runId)}" must match ${CASE_ID_RE}`);
  if (!credentialDir || !path.isAbsolute(credentialDir)) {
    throw new PlanError("auth-check requires an absolute credential directory");
  }
  const name = `skill-router-authcheck-${harness.id}-${runId}`;
  const cidfilePath = cidfile ?? path.join(os.tmpdir(), "skill-router-cidfiles", `${name}.cid`);

  const spec = buildSpec({
    ...baseSpecFields({
      kind: "case",
      harnessId: harness.id,
      imageRef: harness.image,
      name,
      cidfile: cidfilePath,
      network: SMOKE_NETWORK,
      labels: {
        [LABELS.harness]: harness.id,
        [LABELS.run]: runId,
        [LABELS.phase]: "1",
      },
      runtimeEnv: harness.runtimeEnv,
      command: [
        "node",
        RUNTIME.verifyScript,
        `--package=${harness.package}`,
        `--version=${harness.version}`,
        `--binary=${harness.binary}`,
        `--major=${harness.major}`,
        `--harness=${harness.id}`,
        "--check-opencode-auth",
        `--providers=${OPENCODE_AUTH_SUPPORTED_PROVIDERS.join(",")}`,
        "--expect-non-root",
      ],
    }),
    includeInstallTmpfs: true,
    mounts: [],
    auth: { src: credentialDir },
    secretNames: [],
    excludedSecretNames: [],
  });

  assertSafeRunSpec(spec, { repoRoot: null, home: null, manifest, credentialDir, requireImageId: false });
  return {
    harnessId: harness.id,
    image: harness.image,
    name,
    cidfile: cidfilePath,
    spec,
    argv: runSpecToArgv(spec, { preview: true }),
  };
}

/** Attach the immutable image id resolved from `docker build --iidfile`. */
export function resolveSpecImage(spec, imageId) {
  assertSafeRunSpecFields(spec, { requireImageId: false });
  return Object.freeze({ ...spec, imageId: assertImageId(imageId) });
}

/**
 * The single argv constructor for live runs. Refuses to emit a command for a
 * spec without an immutable image id unless explicitly previewing.
 */
export function runSpecToArgv(spec, { preview = false } = {}) {
  assertSafeRunSpecFields(spec, { requireImageId: false });
  if (!preview) assertImageId(spec.imageId);
  const image = preview && !spec.imageId ? spec.imageRef : spec.imageId;
  return [
    "docker",
    "run",
    ...ISOLATION_FLAGS,
    `--name=${spec.name}`,
    `--cidfile=${spec.cidfile}`,
    PULL_POLICY,
    ...Object.entries(spec.labels).map(([key, value]) => `--label=${key}=${value}`),
    `--network=${spec.network}`,
    `--user=${RUNTIME.user}`,
    ...spec.tmpfs.map((mount) => `--tmpfs=${mount}`),
    ...spec.mounts.map((mount) => `--mount=type=bind,src=${mount.src},dst=${mount.dst},readonly`),
    ...(spec.auth ? [`--mount=type=bind,src=${spec.auth.src},dst=${spec.auth.dst},readonly`] : []),
    ...spec.env.map((entry) => `--env=${entry.name}=${entry.value}`),
    ...spec.secretNames.map((envName) => `--env=${envName}`),
    `--workdir=${spec.workdir}`,
    image,
    ...spec.command,
  ];
}

/* -------------------------------------------------------------------------- */
/* Safe-run validation                                                         */
/* -------------------------------------------------------------------------- */

function assertSafeRunSpecFields(spec, { requireImageId }) {
  if (!spec || typeof spec !== "object") throw new PlanError("run spec must be an object");
  for (const key of ["kind", "harnessId", "imageRef", "name", "cidfile", "network", "workdir"]) {
    if (typeof spec[key] !== "string" || !spec[key]) throw new PlanError(`run spec is missing ${key}`);
  }
  if (spec.kind !== "smoke" && spec.kind !== "case") throw new PlanError(`run spec kind "${spec.kind}" is not supported`);
  if (!CONTAINER_NAME_RE.test(spec.name)) throw new PlanError(`invalid container name "${spec.name}"`);
  if (!path.isAbsolute(spec.cidfile)) throw new PlanError("run spec cidfile must be an absolute path");
  assertNetwork(spec.network);
  if (spec.imageId !== null && spec.imageId !== undefined) assertImageId(spec.imageId);
  if (requireImageId) assertImageId(spec.imageId);
  if (!Array.isArray(spec.command) || spec.command.length === 0) throw new PlanError("run spec must declare a command");
  if (spec.workdir !== RUNTIME.workspace) throw new PlanError(`run spec workdir must be ${RUNTIME.workspace}`);
  for (const entry of spec.env ?? []) {
    assertEnvName(entry.name);
    if (typeof entry.value !== "string" || entry.value.includes("\n")) {
      throw new PlanError(`run spec env ${entry.name} must be a single-line string`);
    }
  }
  for (const name of spec.secretNames ?? []) {
    assertEnvName(name);
    if ((spec.env ?? []).some((entry) => entry.name === name)) {
      throw new PlanError(`secret ${name} must be inherited by name, not given a literal value`);
    }
  }
  if (spec.auth !== null && spec.auth !== undefined) {
    const auth = spec.auth;
    if (typeof auth !== "object" || Array.isArray(auth)) throw new PlanError("auth credential field must be an object or null");
    if (typeof auth.src !== "string" || !path.isAbsolute(auth.src)) {
      throw new PlanError("auth credential directory must be an absolute host path");
    }
    if (auth.dst !== RUNTIME.opencodeAuthDir) {
      throw new PlanError(`auth credentials must be mounted at ${RUNTIME.opencodeAuthDir}`);
    }
  }
  return spec;
}

/**
 * Exact pre-image-boundary validation of a typed run spec: hardening flags,
 * uid/gid, tmpfs destinations and options, read-only artifact bind, network
 * policy, cidfile/name, and (for live runs) the immutable image id.
 */
export function assertSafeRunSpec(spec, { repoRoot = null, home = null, manifest = null, credentialDir = null, requireImageId = false } = {}) {
  assertSafeRunSpecFields(spec, { requireImageId });

  if (spec.user !== RUNTIME.user) throw new PlanError("run spec must use the non-root container user");
  if (spec.pull !== PULL_POLICY) throw new PlanError(`run spec pull policy must be ${PULL_POLICY}`);

  const requiredTmpfs = spec.kind === "case" ? [TMPFS.tmp, TMPFS.home, TMPFS.workspace, TMPFS.install] : [TMPFS.tmp, TMPFS.home, TMPFS.workspace];
  for (const required of requiredTmpfs) {
    if (!spec.tmpfs.includes(required)) {
      throw new PlanError(`run spec is missing required tmpfs mount "${required.split(":")[0]}"`);
    }
  }
  for (const mount of spec.tmpfs) {
    const [destination, options = ""] = mount.split(":");
    if (!options.includes("nosuid")) throw new PlanError(`tmpfs ${destination} must be nosuid`);
    // Empirically every writable tmpfs is noexec on the supported engine, and
    // nothing here executes from one (the router runs from the immutable
    // image-layer wrapper) — so noexec is required, not merely preferred.
    if (!options.includes("noexec")) throw new PlanError(`tmpfs ${destination} must be noexec`);
    if (destination === "/tmp" && !(options.includes("noexec") && options.includes("mode=1777"))) {
      throw new PlanError("/tmp tmpfs must be noexec with mode=1777");
    }
    if (destination !== "/tmp" && !(options.includes("uid=1000") && options.includes("gid=1000") && options.includes("mode=0700"))) {
      throw new PlanError(`tmpfs ${destination} must be uid=1000,gid=1000,mode=0700`);
    }
  }

  for (const mount of spec.mounts) {
    if (mount.type !== "bind") throw new PlanError(`unsupported mount type "${mount.type}"`);
    if (mount.readonly !== true) throw new PlanError(`mount ${mount.dst} must be read-only`);
    if (mount.dst !== RUNTIME.artifact) throw new PlanError(`only the packed artifact may be mounted (unexpected ${mount.dst})`);
    if (!path.isAbsolute(mount.src)) throw new PlanError("artifact mount source must be an absolute path");
    if (repoRoot && isInside(mount.src, repoRoot)) throw new PlanError("run spec must not mount the host repository");
    if (home && isInside(mount.src, home)) throw new PlanError("run spec must not mount the host HOME");
  }
  if (spec.kind === "smoke" && spec.mounts.length > 0) {
    throw new PlanError("smoke runs must not mount anything");
  }

  /**
   * Optional OpenCode credential-directory bind: exactly one, fixed
   * destination, read-only, OpenCode cases only, and sourced from *this*
   * invocation's credential directory exactly (never a nested, foreign, or
   * original host path) — never the repository and never the host HOME.
   */
  if (spec.auth) {
    if (spec.kind !== "case") throw new PlanError("only case runs may mount OpenCode credentials");
    if (!manifest) throw new PlanError("manifest is required to validate an OpenCode credential mount");
    if (!isOpenCodeHarness(manifest.harnesses[spec.harnessId])) {
      throw new PlanError(`harness "${spec.harnessId}" must not receive OpenCode credentials`);
    }
    if (!credentialDir || !path.isAbsolute(credentialDir)) {
      throw new PlanError("the invocation credential directory is required to validate an OpenCode credential mount");
    }
    if (path.resolve(spec.auth.src) !== path.resolve(credentialDir)) {
      throw new PlanError("auth credentials must come from this invocation's credential directory");
    }
    if (repoRoot && isInside(spec.auth.src, repoRoot)) {
      throw new PlanError("auth credentials must not come from the host repository");
    }
    if (home && isInside(spec.auth.src, home)) {
      throw new PlanError("auth credentials must not come from the host HOME");
    }
  }

  if (home && isInside(spec.cidfile, home)) throw new PlanError("cidfile must not be created inside HOME");
  if (repoRoot && isInside(spec.cidfile, repoRoot)) throw new PlanError("cidfile must not be created inside the repository");

  if (manifest) {
    const globalAllowlist = manifest.secretEnvAllowlist;
    const harnessAllowlist = manifest.harnesses[spec.harnessId]?.secretAllowlist ?? null;
    if (!harnessAllowlist) throw new PlanError(`run spec references unknown harness "${spec.harnessId}"`);
    for (const name of spec.secretNames) {
      if (!globalAllowlist.includes(name)) throw new PlanError(`secret ${name} is not in the manifest allowlist`);
      if (!harnessAllowlist.includes(name)) {
        throw new PlanError(`harness "${spec.harnessId}" does not accept secret ${name}`);
      }
    }
    for (const name of spec.excludedSecretNames ?? []) {
      if (spec.secretNames.includes(name)) throw new PlanError(`${name} is excluded but still selected`);
    }
  }
  return spec;
}

/**
 * Final gate immediately before the image boundary: re-derives the exact
 * option set from argv so no execution path can smuggle in a weaker command.
 *
 * Rejects forbidden options/host namespaces, unknown or unsupported options,
 * duplicate/conflicting scalar options (user, network, name, cidfile, pull,
 * ...), duplicate labels/env/tmpfs/bind destinations, capability additions,
 * and — when a `spec` is supplied — any argv that is not deep-equal to the
 * canonical `runSpecToArgv(spec)` output.
 */
export function assertSafeRunArgv(
  argv,
  {
    repoRoot = null,
    home = null,
    secretNames = [],
    secretAllowlist = [],
    credentialDir = null,
    openCodeHarnessIds = [],
    requireImageId = false,
    spec = null,
  } = {},
) {
  if (!Array.isArray(argv) || argv[0] !== "docker" || argv[1] !== "run") {
    throw new PlanError("run command must start with `docker run`");
  }
  const tokens = argv.slice(2);
  for (const forbidden of FORBIDDEN_RUN_TOKENS) {
    const matched = forbidden === "-v"
      ? tokens.includes("-v")
      : tokens.some((token) => token.includes(forbidden));
    if (matched) {
      throw new PlanError(`run command contains forbidden option or mount source: ${forbidden}`);
    }
  }

  const imageIndex = tokens.findIndex((token) => !token.startsWith("--"));
  if (imageIndex === -1) throw new PlanError("run command is missing an image");
  const optionTokens = tokens.slice(0, imageIndex);
  const image = tokens[imageIndex];

  for (const required of [...ISOLATION_FLAGS, PULL_POLICY, `--user=${RUNTIME.user}`]) {
    if (!optionTokens.includes(required)) {
      throw new PlanError(`run command is missing required isolation flag: ${required}`);
    }
  }

  // Option whitelist: nothing outside the canonical construction is accepted.
  const kindCount = new Map();
  for (const token of optionTokens) {
    const kind = token.split("=")[0];
    if (!RUN_OPTION_WHITELIST.includes(kind)) {
      throw new PlanError(`run command contains unsupported option: ${kind}`);
    }
    kindCount.set(kind, (kindCount.get(kind) ?? 0) + 1);
  }
  for (const kind of RUN_SCALAR_ONCE_OPTIONS) {
    if ((kindCount.get(kind) ?? 0) > 1) {
      throw new PlanError(`run command contains duplicate/conflicting option: ${kind}`);
    }
  }
  const scalarValue = (kind) => optionTokens.find((token) => token.startsWith(`${kind}=`))?.slice(kind.length + 1);
  if (scalarValue("--workdir") !== RUNTIME.workspace) {
    throw new PlanError(`run command must use --workdir=${RUNTIME.workspace}`);
  }

  // Conflict detection for repeatable options. These prefixes are checked
  // across the whole argv (including appended tokens) so tampering is caught
  // even without a spec; our canonical in-container commands never contain
  // them.
  const repeatable = (prefix) => tokens.filter((token) => token.startsWith(`${prefix}=`));
  const duplicates = (values) => values.filter((value, index) => values.indexOf(value) !== index);
  const labelKeys = repeatable("--label").map((token) => token.slice("--label=".length).split("=")[0]);
  const dupLabels = duplicates(labelKeys);
  if (dupLabels.length) throw new PlanError(`run command contains duplicate label: ${dupLabels[0]}`);
  const envNames = repeatable("--env").map((token) => token.slice("--env=".length).split("=")[0]);
  const dupEnv = duplicates(envNames);
  if (dupEnv.length) throw new PlanError(`run command contains duplicate/conflicting env: ${dupEnv[0]}`);
  const tmpfsDestinations = repeatable("--tmpfs").map((token) => token.slice("--tmpfs=".length));
  const dupTmpfs = duplicates(tmpfsDestinations.map((entry) => entry.split(":")[0]));
  if (dupTmpfs.length) throw new PlanError(`run command contains duplicate tmpfs destination: ${dupTmpfs[0]}`);

  const name = scalarValue("--name");
  if (!name || !CONTAINER_NAME_RE.test(name)) throw new PlanError("run command must declare a valid unique --name");
  const cidfile = scalarValue("--cidfile");
  if (!cidfile || !path.isAbsolute(cidfile)) throw new PlanError("run command must declare an absolute --cidfile");
  if (repoRoot && isInside(cidfile, repoRoot)) throw new PlanError("cidfile must not be created inside the repository");
  if (home && isInside(cidfile, home)) throw new PlanError("cidfile must not be created inside HOME");

  const network = scalarValue("--network");
  if (!network) throw new PlanError("run command must declare --network");
  assertNetwork(network);
  if (scalarValue("--pull") !== PULL_POLICY.slice("--pull=".length)) {
    throw new PlanError(`run command must use ${PULL_POLICY}`);
  }

  const requiredDestinations = ["/tmp", RUNTIME.home, RUNTIME.workspace];
  for (const destination of requiredDestinations) {
    if (!tmpfsDestinations.some((entry) => entry.split(":")[0] === destination)) {
      throw new PlanError(`run command is missing required tmpfs destination ${destination}`);
    }
  }
  for (const entry of tmpfsDestinations) {
    const [destination, options = ""] = entry.split(":");
    if (!options.includes("nosuid")) throw new PlanError(`tmpfs ${destination} must be nosuid`);
    if (!options.includes("noexec")) throw new PlanError(`tmpfs ${destination} must be noexec`);
    if (destination === "/tmp" && !(options.includes("noexec") && options.includes("mode=1777"))) {
      throw new PlanError("/tmp tmpfs must be noexec with mode=1777");
    }
    if (destination !== "/tmp" && !(options.includes("uid=1000") && options.includes("gid=1000") && options.includes("mode=0700"))) {
      throw new PlanError(`tmpfs ${destination} must be uid=1000,gid=1000,mode=0700`);
    }
  }

  const bindTokens = repeatable("--mount");
  const bindDestinations = [];
  const labelTokens = repeatable("--label");
  const harnessLabel = labelTokens
    .find((token) => token.startsWith(`--label=${LABELS.harness}=`))
    ?.slice(`--label=${LABELS.harness}=`.length);
  const caseLabel = labelTokens.some((token) => token.startsWith(`--label=${LABELS.case}=`));
  const commandTokens = tokens.slice(imageIndex + 1);
  let authMounts = 0;
  for (const token of bindTokens) {
    if (!token.startsWith("--mount=type=bind")) throw new PlanError(`unsupported mount: ${token}`);
    if (!/(^|,)readonly(,|$)/.test(token) && !/(^|,)ro(,|$)/.test(token)) {
      throw new PlanError(`bind mounts must be read-only: ${token}`);
    }
    const source = token.match(/(?:^|,)src=([^,]+)/)?.[1];
    const destination = token.match(/(?:^|,)dst=([^,]+)/)?.[1];
    if (!source) throw new PlanError(`bind mount is missing src=: ${token}`);

    // The optional OpenCode auth snapshot bind: fixed destination, OpenCode
    // harness, this invocation's credential directory, exactly once. Its
    // source path is never echoed into an error message.
    if (destination === RUNTIME.opencodeAuthDir) {
      authMounts += 1;
      if (authMounts > 1) throw new PlanError("run command contains a duplicate credential mount");
      if (!harnessLabel || !openCodeHarnessIds.includes(harnessLabel)) {
        throw new PlanError("an OpenCode credential mount is only allowed for OpenCode case runs");
      }
      const isAuthCheck = commandTokens.includes("--check-opencode-auth");
      if (!caseLabel && !isAuthCheck) {
        throw new PlanError("an OpenCode credential mount is only allowed for OpenCode case runs");
      }
      if (!credentialDir) {
        throw new PlanError("the invocation credential directory is required to mount OpenCode credentials");
      }
      if (path.resolve(source) !== path.resolve(credentialDir)) {
        throw new PlanError("auth credentials must come from this invocation's credential directory");
      }
      if (repoRoot && isInside(source, repoRoot)) throw new PlanError("run command must not mount the host repository");
      if (home && isInside(source, home)) throw new PlanError("run command must not mount the host HOME");
      continue;
    }
    if (destination !== RUNTIME.artifact) throw new PlanError(`only the packed artifact may be mounted: ${destination}`);
    if (repoRoot && isInside(source, repoRoot)) throw new PlanError("run command must not mount the host repository");
    if (home && isInside(source, home)) throw new PlanError("run command must not mount the host HOME");
    bindDestinations.push(destination);
  }
  const dupMount = duplicates(bindDestinations);
  if (dupMount.length) throw new PlanError(`run command contains duplicate mount destination: ${dupMount[0]}`);

  if (requireImageId) assertImageId(image);
  else if (!IMAGE_ID_RE.test(image)) assertImageRef(image, "run image");

  for (const allowName of secretAllowlist) {
    if (tokens.some((token) => token === `--env=${allowName}=` || token.startsWith(`--env=${allowName}=`))) {
      throw new PlanError(`secret ${allowName} must never be given a value on the command line`);
    }
  }
  for (const name of secretNames) {
    const token = `--env=${name}`;
    if (!tokens.includes(token)) {
      throw new PlanError(`allowlisted secret env name must be passed as ${token} (inheritance), never with a value`);
    }
    if (tokens.some((existing) => existing.startsWith(`${token}=`))) {
      throw new PlanError(`secret env ${name} must not be given a value on the command line`);
    }
  }

  if (spec) {
    const canonical = runSpecToArgv(spec, { preview: spec.imageId === null || spec.imageId === undefined });
    if (!argvsEqual(argv, canonical)) {
      throw new PlanError("run argv does not deep-equal the canonical typed construction for its spec");
    }
  }
  return argv;
}

/* -------------------------------------------------------------------------- */
/* Image inspection and report validation                                      */
/* -------------------------------------------------------------------------- */

export function parseImageInspect(stdout) {
  try {
    return JSON.parse(String(stdout).trim());
  } catch {
    throw new PlanError("docker image inspect returned unparseable output");
  }
}

/** Host-side image trust: id, OS/arch, and harness label must all match. */
export function validateImageInspect({ harness, imageId, inspect }) {
  assertImageId(imageId);
  if (!inspect || typeof inspect !== "object") throw new PlanError("image inspect payload is missing");
  const reportedId = inspect.Id ?? inspect.ID;
  if (reportedId !== imageId) {
    throw new PlanError(`image id mismatch: requested ${imageId}, daemon reported ${String(reportedId)}`);
  }
  if (inspect.Os !== "linux") throw new PlanError(`image OS is "${String(inspect.Os)}", expected linux`);
  const architecture = inspect.Architecture;
  if (!architecture || typeof architecture !== "string") throw new PlanError("image architecture missing from inspect output");
  const labels = inspect.Config?.Labels ?? {};
  const reportedHarness = labels[LABELS.harness];
  if (reportedHarness !== harness.id) {
    throw new PlanError(`image label ${LABELS.harness} is "${String(reportedHarness)}", expected "${harness.id}"`);
  }
  return {
    imageId,
    os: inspect.Os,
    architecture,
    nodeArch: dockerArchToNodeArch(architecture),
    harnessLabel: reportedHarness,
    tags: Array.isArray(inspect.RepoTags) ? inspect.RepoTags.filter(Boolean) : [],
  };
}

/**
 * Host-side smoke report validation: every field the verifier promised must
 * match the manifest pin and the inspected image. Nothing is trusted just
 * because `ok` is true.
 */
export function validateSmokeReport({ report, harness, imageInfo, expectedNodeArch = null }) {
  const mismatch = (field, actual, expected) => {
    throw new PlanError(`smoke report ${field} mismatch: reported "${String(actual)}", expected "${String(expected)}"`);
  };
  if (!report || typeof report !== "object") throw new PlanError("smoke report is missing or not JSON");
  if (report.ok !== true) throw new PlanError(`smoke report ok=false (${String(report.error ?? "no detail")})`);
  if (report.harnessId !== harness.id) mismatch("harnessId", report.harnessId, harness.id);
  if (report.package !== harness.package) mismatch("package", report.package, harness.package);
  if (report.packageVersion !== harness.version) mismatch("packageVersion", report.packageVersion, harness.version);
  if (report.binary !== harness.binary) mismatch("binary", report.binary, harness.binary);
  if (report.binaryVersion !== harness.version) mismatch("binaryVersion", report.binaryVersion, harness.version);
  if (report.major !== harness.major) mismatch("major", report.major, harness.major);
  if (report.uid !== RUNTIME.uid) mismatch("uid", report.uid, RUNTIME.uid);
  if (report.nonRoot !== true) mismatch("nonRoot", report.nonRoot, true);
  if (!report.platform || typeof report.platform !== "object") throw new PlanError("smoke report platform missing");
  if (report.platform.os !== "linux") mismatch("platform.os", report.platform.os, "linux");
  const expectedArch = expectedNodeArch ?? imageInfo?.nodeArch;
  if (expectedArch && report.platform.arch !== expectedArch) mismatch("platform.arch", report.platform.arch, expectedArch);
  if (imageInfo && report.imageId && report.imageId !== imageInfo.imageId) mismatch("imageId", report.imageId, imageInfo.imageId);
  return {
    harnessId: report.harnessId,
    package: report.package,
    packageVersion: report.packageVersion,
    binary: report.binary,
    binaryVersion: report.binaryVersion,
    major: report.major,
    uid: report.uid,
    nonRoot: report.nonRoot,
    platform: report.platform,
    imageId: imageInfo?.imageId ?? report.imageId ?? null,
    imageArchitecture: imageInfo?.architecture ?? null,
  };
}

/** Exact field set of an auth-check report; nothing else may be emitted. */
export const AUTH_CHECK_REPORT_FIELDS = Object.freeze([
  "auth",
  "binary",
  "binaryVersion",
  "harnessId",
  "major",
  "nonRoot",
  "ok",
  "package",
  "packageVersion",
  "platform",
  "providers",
  "recognition",
  "uid",
]);
/**
 * The only accepted auth-check verdict: the pinned harness must name every
 * requested provider in a standalone `opencode auth list` after the snapshot
 * was staged (v1) or explicitly imported (v2). An empty/absent listing fails.
 */
export const AUTH_CHECK_RECOGNITIONS = Object.freeze(["listed"]);

/**
 * Host-side validation of the credential-free fake-auth report: exact fields,
 * `ok === true`, exact pin/version match, non-root execution, the fixed dummy
 * provider set, and a neutral `{ mode: "snapshot" }` marker. No path, hash,
 * account label, or credential value may ever ride along.
 */
export function validateAuthCheckReport({ report, harness }) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new PlanError("auth-check report is missing or not a JSON object");
  }
  if (report.ok !== true) throw new PlanError("auth-check report ok is not true");
  const keys = Object.keys(report).sort();
  const unexpected = keys.filter((key) => !AUTH_CHECK_REPORT_FIELDS.includes(key));
  const missing = AUTH_CHECK_REPORT_FIELDS.filter((key) => !keys.includes(key));
  if (unexpected.length || missing.length) {
    throw new PlanError(
      `auth-check report fields drifted (unexpected: ${unexpected.join(", ") || "none"}; missing: ${missing.join(", ") || "none"})`,
    );
  }
  const mismatch = (field, actual, expected) => {
    throw new PlanError(`auth-check ${field} mismatch: reported "${String(actual)}", expected "${String(expected)}"`);
  };
  if (report.harnessId !== harness.id) mismatch("harnessId", report.harnessId, harness.id);
  if (report.package !== harness.package) mismatch("package", report.package, harness.package);
  if (report.packageVersion !== harness.version) mismatch("packageVersion", report.packageVersion, harness.version);
  if (report.binary !== harness.binary) mismatch("binary", report.binary, harness.binary);
  if (report.binaryVersion !== harness.version) mismatch("binaryVersion", report.binaryVersion, harness.version);
  if (report.major !== harness.major) mismatch("major", report.major, harness.major);
  if (report.uid !== RUNTIME.uid) mismatch("uid", report.uid, RUNTIME.uid);
  if (report.nonRoot !== true) mismatch("nonRoot", report.nonRoot, true);
  if (!report.platform || typeof report.platform !== "object" || typeof report.platform.os !== "string") {
    throw new PlanError("auth-check report platform is missing");
  }
  const expectedProviders = [...OPENCODE_AUTH_SUPPORTED_PROVIDERS].sort();
  const providers = Array.isArray(report.providers) ? [...report.providers].sort() : null;
  if (!providers || providers.length !== expectedProviders.length || providers.some((id, index) => id !== expectedProviders[index])) {
    throw new PlanError(
      `auth-check providers mismatch: reported [${(report.providers ?? []).join(", ")}], expected [${expectedProviders.join(", ")}]`,
    );
  }
  const authKeys = report.auth && typeof report.auth === "object" && !Array.isArray(report.auth) ? Object.keys(report.auth) : null;
  if (!authKeys || authKeys.length !== 1 || authKeys[0] !== "mode" || report.auth.mode !== "snapshot") {
    throw new PlanError('auth-check report auth marker must be exactly { mode: "snapshot" }');
  }
  if (!AUTH_CHECK_RECOGNITIONS.includes(report.recognition)) {
    throw new PlanError(`auth-check recognition must be one of: ${AUTH_CHECK_RECOGNITIONS.join(", ")}`);
  }
  return {
    harnessId: report.harnessId,
    packageVersion: report.packageVersion,
    binaryVersion: report.binaryVersion,
    providers: [...expectedProviders],
    recognition: report.recognition,
    uid: report.uid,
    platform: report.platform,
  };
}

/* -------------------------------------------------------------------------- */
/* Higher-level plans                                                          */
/* -------------------------------------------------------------------------- */

/** Build + smoke plan for all (or selected) harness images. */
export function planSmoke({ manifest, repoRoot, env = {}, harnesses = null, runId, contextDir, iidDir, cidfileDir }) {
  const builds = planBuild({ manifest, repoRoot, env, harnesses, contextDir, iidDir });
  const descriptors = expandHarnesses(manifest, { env, harnesses });
  const cidDir = cidfileDir ?? path.join(os.tmpdir(), "skill-router-cidfiles");
  return {
    runId,
    builds,
    runs: descriptors.map((harness) =>
      planSmokeRun({ manifest, harness, runId, cidfile: path.join(cidDir, `skill-router-smoke-${harness.id}-${runId}.cid`) }),
    ),
  };
}

/**
 * Phase 1 case plan: pack the artifact once, then exactly one fresh
 * `docker run --rm` per case, with per-harness secret scoping. No Docker
 * execution happens here; live runs additionally require immutable image ids.
 */
export function planMatrix({
  manifest,
  repoRoot,
  packageMetadata,
  destination,
  artifactPath,
  runId,
  secretEnvNames = [],
  network = DEFAULT_CASE_NETWORK,
  cases = null,
  harnesses = null,
  home = null,
  env = {},
  command = null,
  cidfileDir = null,
  authPath = null,
  credentialDir = null,
}) {
  const expanded = expandMatrix(manifest, { env, cases, harnesses });
  const pack = planPack({ repoRoot, packageMetadata, destination });
  const cidDir = cidfileDir ?? path.join(destination, "cidfiles");
  return {
    runId,
    pack,
    cases: expanded.map((caseDescriptor) => {
      const harnessAllowlist = manifest.harnesses[caseDescriptor.harness].secretAllowlist;
      const scoped = secretEnvNames.filter((name) => harnessAllowlist.includes(name));
      const excluded = secretEnvNames.filter((name) => !harnessAllowlist.includes(name));
      return planCaseRun({
        manifest,
        case: caseDescriptor,
        artifactPath: artifactPath ?? pack.predictedArtifact,
        runId,
        secretEnvNames: scoped,
        excludedSecretNames: excluded,
        network,
        repoRoot,
        home,
        command,
        cidfile: path.join(cidDir, `skill-router-case-${caseDescriptor.id}-${runId}.cid`),
        authPath,
        credentialDir,
      });
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Case execution contract (Phase 2)                                           */
/* -------------------------------------------------------------------------- */

/** Required non-secret model envs. No default billable model is ever chosen. */
export const CASE_ENV = Object.freeze({
  opencodeModel: "SKILL_ROUTER_OPENCODE_MODEL",
  claudeModel: "SKILL_ROUTER_CLAUDE_MODEL",
});

/** provider/model format for OpenCode model envs (strict). */
export const MODEL_FORMAT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
/**
 * Claude Code model input: documented aliases (sonnet/opus/haiku) or Anthropic
 * model ids (`claude-...`). OpenCode's `provider/model` syntax is rejected.
 */
export const CLAUDE_MODEL_RE = /^(?:sonnet|opus|haiku|claude-[A-Za-z0-9][A-Za-z0-9.-]*)$/;
export const CLAUDE_MODEL_ALIASES = Object.freeze(["sonnet", "opus", "haiku"]);

/** Container-local path prefixes stripped from case failure text. */
export const CONTAINER_PATH_PREFIXES = Object.freeze([
  { value: "/workspace/", label: "[container]/" },
  { value: "/home/node/", label: "[container]/" },
  { value: "/opt/skill-router-install/", label: "[container]/" },
  { value: "/usr/local/lib/", label: "[container]/" },
  { value: "/input/", label: "[container]/" },
]);

/** Exact field set of a case success report; nothing else may be emitted. */
export const CASE_REPORT_FIELDS = Object.freeze([
  "artifactSha256",
  "case",
  "chain",
  "container",
  "harness",
  "ok",
  "outcome",
  "scenario",
  "sessionCount",
  "skillId",
]);

/**
 * Independent host-side expectation of the structural chain each case must
 * prove. The in-container runner builds its chain from observed events; the
 * host validates it against this list, so neither side can drift silently.
 */
export function expectedCaseChain(harness, scenario) {
  if (scenario === "control") return ["router-unavailable"];
  const tail = scenario === "select" ? ["release-skill-loaded", "marker-emitted"] : ["abstained"];
  // Both harnesses must prove the shell-safe request-file write between the
  // router load and the route invocation.
  void harness;
  return ["router-skill-loaded", "request-token-written", "route-invoked", "route-result", ...tail];
}

/** Expected outcome/skillId per scenario. */
export function expectedCaseOutcome(scenario) {
  if (scenario === "select") return { outcome: "select", skillId: "release" };
  if (scenario === "none") return { outcome: "none", skillId: null };
  if (scenario === "control") return { outcome: "unavailable", skillId: null };
  throw new PlanError(`unknown case scenario "${scenario}"`);
}

/**
 * The case runner emits exactly one compact JSON line on stdout. Anything
 * else is a structural failure whose text never includes raw container output.
 */
export function parseCaseReportStdout(stdout) {
  const lines = String(stdout ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  if (lines.length !== 1) {
    throw new PlanError(`case runner emitted ${lines.length} stdout line(s); expected exactly one compact JSON report`);
  }
  let parsed;
  try {
    parsed = JSON.parse(lines[0]);
  } catch {
    throw new PlanError("case runner stdout line was not a JSON report");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PlanError("case runner report was not a JSON object");
  }
  return parsed;
}

/**
 * Validate every expected report field: identity, locked artifact hash,
 * container freshness, exactly one session, exact structural chain, and the
 * scenario outcome. Unknown fields are rejected so raw content can never ride
 * along in a success report.
 */
export function validateCaseReport({ report, caseDescriptor, containerName, artifactSha256 }) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new PlanError("case report is missing or not an object");
  }
  if (report.ok !== true) {
    const stage = typeof report.stage === "string" && /^[a-z-]+$/.test(report.stage) ? report.stage : "unknown";
    const detail = typeof report.error === "string" ? report.error.slice(0, 300) : "no detail";
    const structuralEvents = Array.isArray(report.events)
      ? report.events.slice(0, 25).flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          const fields = [entry.kind, entry.tool, entry.status, entry.name]
            .filter((value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(value));
          return fields.length ? [fields.join(":")] : [];
        })
      : [];
    const evidence = structuralEvents.length ? `; events=[${structuralEvents.join(",")}]` : "";
    const failure = new PlanError(
      `case ${String(report.case ?? caseDescriptor.id)} failed in stage ${stage}: ${detail}${evidence}`,
    );
    failure.caseReport = report;
    throw failure;
  }
  const keys = Object.keys(report).sort();
  const expectedKeys = [...CASE_REPORT_FIELDS].sort();
  const unexpected = keys.filter((key) => !expectedKeys.includes(key));
  const missing = expectedKeys.filter((key) => !keys.includes(key));
  if (unexpected.length || missing.length) {
    throw new PlanError(
      `case report fields drifted (unexpected: ${unexpected.join(", ") || "none"}; missing: ${missing.join(", ") || "none"})`,
    );
  }
  if (report.case !== caseDescriptor.id) throw new PlanError(`case report case mismatch: "${String(report.case)}" != "${caseDescriptor.id}"`);
  if (report.harness !== caseDescriptor.harness) throw new PlanError(`case report harness mismatch: "${String(report.harness)}"`);
  if (report.scenario !== caseDescriptor.scenario) throw new PlanError(`case report scenario mismatch: "${String(report.scenario)}"`);
  if (report.container !== containerName) {
    throw new PlanError(`case report container mismatch: "${String(report.container)}" != "${containerName}"`);
  }
  if (report.artifactSha256 !== artifactSha256) {
    throw new PlanError("case report artifact sha256 does not match the lifecycle-locked artifact hash");
  }
  if (!Number.isInteger(report.sessionCount) || report.sessionCount !== 1) {
    throw new PlanError(`case report sessionCount must be exactly 1, received ${String(report.sessionCount)}`);
  }
  const chain = report.chain;
  if (!Array.isArray(chain) || chain.length === 0 || chain.some((entry) => typeof entry !== "string")) {
    throw new PlanError("case report chain must be a non-empty array of strings");
  }
  const expected = expectedCaseChain(caseDescriptor.harness, caseDescriptor.scenario);
  if (chain.length !== expected.length || chain.some((entry, index) => entry !== expected[index])) {
    throw new PlanError(`case report chain mismatch: got [${chain.join(", ")}], expected [${expected.join(", ")}]`);
  }
  const outcome = expectedCaseOutcome(caseDescriptor.scenario);
  if (report.outcome !== outcome.outcome) {
    throw new PlanError(`case report outcome mismatch: "${String(report.outcome)}" != "${outcome.outcome}"`);
  }
  const skillId = report.skillId ?? null;
  if (skillId !== outcome.skillId) {
    throw new PlanError(`case report skillId mismatch: "${String(skillId)}" != "${String(outcome.skillId)}"`);
  }
  return {
    case: report.case,
    harness: report.harness,
    scenario: report.scenario,
    container: report.container,
    artifactSha256: report.artifactSha256,
    sessionCount: report.sessionCount,
    outcome: report.outcome,
    skillId,
    chain: [...chain],
  };
}

/** Concise, sanitized success line for one executed case. */
export function formatCaseSuccess(summary, sanitize = (value) => value) {
  const skill = summary.skillId ? ` skill=${summary.skillId}` : "";
  return sanitize(
    `case ${summary.case}: ok outcome=${summary.outcome}${skill} sessions=${summary.sessionCount} ` +
      `container=${summary.container} chain=[${summary.chain.join(",")}]`,
  );
}

/**
 * Preflight for live case execution: explicit model envs (OpenCode strict
 * `provider/model`, Claude aliases/Anthropic ids), provider-bound key
 * requirements from the audited `providerKeyMap`, and required credentials —
 * Claude cases require `--secret-env CLAUDE_CODE_OAUTH_TOKEN` (non-bare
 * `claude setup-token` auth; an API key never satisfies it) — all resolved
 * against both case and harness filters *before* any pack, build, probe, or
 * container starts. No default billable model is ever chosen.
 */
export function preflightLiveCases({
  manifest,
  env = {},
  caseIds = [],
  harnessIds = [],
  selectedSecretNames = [],
  authFile = null,
}) {
  assertManifest(manifest);
  const cases = expandMatrix(manifest, { env, cases: caseIds, harnesses: harnessIds });
  const selected = new Set(selectedSecretNames ?? []);
  const needsOpenCode = cases.some((entry) => entry.harness !== "claude");
  const needsClaude = cases.some((entry) => entry.harness === "claude");
  const issues = [];
  const notes = [];
  const models = {};
  /**
   * Chosen OpenCode authentication. Deterministic precedence:
   *   1. a *usable* selected mapped key -> `environment` (the auth file is
   *      never read, never snapshotted, never mounted);
   *   2. otherwise an explicitly requested auth file that carries the selected
   *      provider -> `snapshot` (provider-filtered);
   *   3. otherwise an actionable issue.
   * `provider` is the selected model provider in both successful modes; only
   * mode + provider id are ever reported (neutral audit metadata).
   */
  let auth = { mode: "none", provider: null, snapshot: null };

  if (needsOpenCode) {
    const raw = env[CASE_ENV.opencodeModel];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) {
      issues.push(
        `${CASE_ENV.opencodeModel} is required for OpenCode cases (provider/model format); ` +
          "no default billable model is ever chosen",
      );
    } else if (!MODEL_FORMAT_RE.test(value)) {
      issues.push(`${CASE_ENV.opencodeModel} must use provider/model format (for example provider/model-id)`);
    } else {
      models.opencode = value;
      const provider = value.split("/", 1)[0].toLowerCase();
      const keyName = manifest.providerKeyMap[provider];
      const envKeySelected = Boolean(keyName) && selected.has(keyName);
      const envKeyUsable =
        envKeySelected && typeof env[keyName] === "string" && env[keyName].length >= MIN_SECRET_LENGTH;

      // The auth file is read at most once, and only when the mapped key was
      // not selected at all — an env-backed run never touches the file, and a
      // selected-but-broken key is an error rather than a silent fallback.
      const authDocument = authFile && !envKeySelected ? resolveOpenCodeAuthFile({ requested: authFile }) : null;
      const providerInFile =
        Boolean(authDocument) &&
        OPENCODE_AUTH_SUPPORTED_PROVIDERS.includes(provider) &&
        authDocument.providers.includes(provider);

      if (envKeySelected && !envKeyUsable) {
        issues.push(`${keyName} must be set in the host environment with at least ${MIN_SECRET_LENGTH} characters`);
      } else if (envKeyUsable) {
        auth = { mode: "environment", provider, snapshot: null };
        notes.push(
          `provider "${provider}" is satisfied by the mapped environment key; ` +
            "no OpenCode credential file is read, snapshotted, or mounted",
        );
      } else if (providerInFile) {
        auth = { mode: "snapshot", provider, snapshot: authDocument };
        notes.push(
          `provider "${provider}" is satisfied by the validated OpenCode auth snapshot ` +
            "(its path, contents, and values are never printed)",
        );
        // Refresh policy applies to the *selected* (and therefore mounted)
        // entry only: an OAuth snapshot is a single immutable copy of a
        // rotating refresh token. Replaying it across a multi-case selection
        // risks invalidating later cases when the token rotates mid-run (the
        // host file is never written back), so it is limited to exactly one
        // filtered OpenCode case.
        const snapshotEntry = authDocument.entries.find((entry) => entry.id === provider);
        const openCodeCaseCount = cases.filter((entry) => isOpenCodeHarness(manifest.harnesses[entry.harness])).length;
        if (snapshotEntry?.type === "oauth" && openCodeCaseCount > 1) {
          issues.push(
            `provider "${provider}" is an OAuth credential in the auth snapshot, but ${openCodeCaseCount} OpenCode cases ` +
              "are selected: the snapshot is copied once and scrubbed, so a refresh-token rotation during the run " +
              "cannot be written back and would invalidate the remaining cases replaying the same token. Run exactly " +
              'one filtered OpenCode case with an OAuth snapshot, use an API credential (type "api") for ' +
              "multi-case/full runs, or select the provider key with --secret-env instead",
          );
        } else if (snapshotEntry?.type === "oauth") {
          notes.push(
            `provider "${provider}" uses an OAuth snapshot credential; permitted because exactly one OpenCode case ` +
              "is selected (no cross-case refresh-token replay)",
          );
        }
      } else if (!keyName) {
        const supported = Object.keys(manifest.providerKeyMap).sort().join(", ");
        const snapshotProvidersList = [...OPENCODE_AUTH_SUPPORTED_PROVIDERS].sort().join(", ");
        issues.push(
          `unsupported OpenCode provider "${provider}" for this runner; supported providers are: ${supported} ` +
            `(auth-snapshot providers, when supplied: ${snapshotProvidersList}; google/gemini are not mapped to a key name and are rejected)`,
        );
      } else {
        issues.push(
          `provider "${provider}" requires --secret-env ${keyName} (or --opencode-auth-file carrying "${provider}"); ` +
            "an unrelated selected key does not satisfy it",
        );
      }
    }
  }

  if (needsClaude) {
    const raw = env[CASE_ENV.claudeModel];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) {
      issues.push(
        `${CASE_ENV.claudeModel} is required for Claude cases (alias like sonnet/opus/haiku, or an Anthropic model id); ` +
          "no default billable model is ever chosen",
      );
    } else if (!CLAUDE_MODEL_RE.test(value)) {
      if (/^[A-Za-z0-9][A-Za-z0-9._-]*\//.test(value)) {
        issues.push(
          `${CASE_ENV.claudeModel} must be a Claude Code alias (sonnet/opus/haiku) or Anthropic model id (claude-...), ` +
            "not OpenCode provider/model syntax",
        );
      } else {
        issues.push(
          `${CASE_ENV.claudeModel} must be a Claude Code alias (${CLAUDE_MODEL_ALIASES.join("/")}) or an Anthropic model id (claude-...)`,
        );
      }
    } else {
      models.claude = value;
    }
    if (!selected.has(CLAUDE_CODE_OAUTH_TOKEN)) {
      issues.push(
        `Claude cases require non-bare setup-token auth: pass --secret-env ${CLAUDE_CODE_OAUTH_TOKEN} ` +
          "(generate one with `claude setup-token`); an API key never satisfies this requirement, " +
          "and host login state is never read",
      );
    } else if (typeof env[CLAUDE_CODE_OAUTH_TOKEN] !== "string" || env[CLAUDE_CODE_OAUTH_TOKEN].length < MIN_SECRET_LENGTH) {
      issues.push(`${CLAUDE_CODE_OAUTH_TOKEN} must be set in the host environment with at least ${MIN_SECRET_LENGTH} characters`);
    } else {
      // Transport statement only: the value is never rendered anywhere.
      notes.push(
        `${CLAUDE_CODE_OAUTH_TOKEN} is inherited by name into Claude case containers only ` +
          "(never on argv, never into OpenCode cases, and never into host pack/build/probe commands)",
      );
    }
  }

  if (issues.length) {
    throw new PlanError(`refusing to start live case containers:\n- ${issues.join("\n- ")}`);
  }
  return { cases: cases.map((entry) => entry.id), models, notes, auth };
}
