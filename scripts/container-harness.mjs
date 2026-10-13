#!/usr/bin/env node
/**
 * Containerized harness matrix runner (Phase 1 substrate, Gate 1 remediation).
 *
 * Commands:
 *   list    show the stable case/harness/version matrix
 *   plan    dry-run: pack-once + one hardened `docker run --rm` per case
 *   pack    pack the repository artifact once and report its digest
 *   build   stage a minimal context, build pinned images, record immutable
 *           image ids, and inspect labels/OS/architecture host-side
 *   smoke   full lifecycle, then verify exact versions in one fresh
 *           credential-free container per harness, executed by image id with
 *           `--pull=never` and every report field validated host-side
 *   run     Phase 2 seam: runs the enclosing lifecycle (temp dir -> stage ->
 *           pack once -> hash -> build/resolve immutable images -> plan cases)
 *           and stops before model-backed case execution
 *
 * Enclosing lifecycle (shared by build/smoke/run):
 *   private temp dir -> stage minimal build context -> npm pack once ->
 *   hash/lock artifact -> build/resolve immutable image ids ->
 *   execute selected containers sequentially -> forced cleanup
 *   (`docker rm -f` in `finally` + bounded signal cleanup) -> remove temp dir.
 *
 * Guarantees:
 *   - Docker is invoked with argv arrays only (no shell interpolation);
 *   - the daemon only ever receives a two-file staged build context;
 *   - repository/HOME/config are never mounted; only the packed artifact is
 *     mounted read-only, into container-local tmpfs-backed runtime dirs;
 *   - live runs go through one typed route: resolveSpecImage() ->
 *     runSpecToArgv() -> assertSafeRunSpec()/assertSafeRunArgv() -> executor;
 *   - secrets travel as allowlisted, per-harness *names* (`--env=NAME`),
 *     never values; every failure/success line passes the central sanitizer.
 *
 * The executor is injectable so tests assert command construction, cleanup,
 * and lifecycle ordering without Docker and without a mocking dependency.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CASE_ENV,
  CONTAINER_PATH_PREFIXES,
  DEFAULT_CASE_NETWORK,
  ENV_KEYS,
  LABELS,
  MIN_SECRET_LENGTH,
  OPENCODE_AUTH_MAX_BYTES,
  OPENCODE_AUTH_SUPPORTED_PROVIDERS,
  RUNTIME,
  PlanError,
  assertImageId,
  assertSafeRunArgv,
  assertSafeRunSpec,
  assertSecretValuesUsable,
  classifyRemovalResult,
  collectSecretValues,
  containerRunEnv,
  createOpenCodeAuthSnapshot,
  createSafeHostEnv,
  createSanitizer,
  displayArgv,
  dummyOpenCodeAuthBytes,
  expandHarnesses,
  expandMatrix,
  formatCaseSuccess,
  formatCommandFailure,
  formatSmokeSuccess,
  isInside,
  loadMatrix,
  loadPackageMetadata,
  newRunId,
  openCodeHarnessIds,
  parseCaseReportStdout,
  parseImageInspect,
  planAuthCheckRun,
  planBuild,
  planMatrix,
  planPack,
  planSmoke,
  predictedTarballName,
  preflightLiveCases,
  resolveBaseImageInfo,
  resolveOpenCodeAuthFile,
  resolveSecretEnvNames,
  resolveSpecImage,
  runSpecToArgv,
  stageBuildContext,
  validateAuthCheckReport,
  validateCaseReport,
  validateImageInspect,
  validateSmokeReport,
} from "./container-lib.mjs";

export const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const TIMEOUTS = Object.freeze({
  probe: 30_000,
  pack: 180_000,
  build: 1_800_000,
  run: 300_000,
  rm: 15_000,
});

const USAGE = `usage: node scripts/container-harness.mjs <command> [options]

Commands:
  list    print the case matrix, harness pins, digest-pinned base image, tags
  plan    dry-run the pack-once + one-docker-run-per-case plan (no Docker calls)
  pack    pack the repository artifact once; prints sha256 and size
  build   stage a minimal context and build harness images; records immutable
          image ids and validates labels/OS/architecture host-side
  smoke   full lifecycle + credential-free verification by immutable image id
  run     execute the seven manifest cases: lifecycle + one fresh container
          per case (requires explicit model envs and credentials; refuses to
          start without them)
  auth-check  credential-free fake-auth validation: builds/resolves the
          OpenCode images and runs one --network=none container per
          OpenCode harness with a *generated* dummy auth.json mounted at the
          fixed destination, proving locally — without any model request —
          that each pinned harness runs against the snapshot (v1 lists the
          dummy providers; v2 reports its fresh-store verdict). Never reads a
          real host auth file

Options:
  --list                 alias for the list command
  --case <id>            limit to a case id (repeatable, comma-separated)
  --harness <id>         limit to a harness id (repeatable, comma-separated)
  --secret-env <NAME>    allowlisted env name to inherit into containers
                         (repeatable, comma-separated; values never on argv)
  --opencode-auth-file <path>   explicit legacy OpenCode auth.json for OpenCode
                         cases (never defaulted; owner-only file, max
                         ${OPENCODE_AUTH_MAX_BYTES} bytes, validated before any
                         subprocess, copied once into a private 0700 directory
                         as a provider-filtered legacy file plus a generated v2
                         import file, mounted read-only at
                         /input/opencode-credential, always removed). Used only
                         when the model provider has no selected mapped key —
                         a usable --secret-env key wins and the file is then
                         never read)
  --network <name>       container network for planned case runs (default ${DEFAULT_CASE_NETWORK};
                         "host" is always rejected)
  --json                 machine-readable output (sanitized)
  --dry-run              print commands without executing them
  --keep                 keep the lifecycle temp dir and print its host path
  --no-build             build/smoke only: resolve existing images by id
                         (forbidden for "run": live cases must build/verify
                         their own immutable image ids)
  --no-cache             build: pass --no-cache
  -h, --help             show this help

Environment overrides:
  ${ENV_KEYS.baseImage}          base Node image (digest-pinned by default;
                         an override weakens the reproducibility claim and is
                         reported in output)
  ${ENV_KEYS.imagePrefix}        image name prefix (default skill-router/harness)
  ${ENV_KEYS.secretEnv}          comma-separated allowlisted secret env names
  ${ENV_KEYS.network}            default network for case runs
  ${ENV_KEYS.opencodeAuthFile}   explicit legacy OpenCode auth.json path for
                                 OpenCode cases (same as --opencode-auth-file;
                                 never defaulted, never printed)
  SKILL_ROUTER_OPENCODE_V1_VERSION / SKILL_ROUTER_OPENCODE_V2_VERSION /
  SKILL_ROUTER_CLAUDE_CODE_VERSION   harness version overrides

Phase 1 needs no credentials: list, plan, pack, build, smoke, and auth-check are
all credential-free. Secret values shorter than ${MIN_SECRET_LENGTH} characters are
rejected before any execution. Live case execution (Phase 2) injects model
credentials by name only, scoped per harness: Claude cases require
--secret-env CLAUDE_CODE_OAUTH_TOKEN (from \`claude setup-token\`, exported only
in the shell/server that launches this runner), OpenCode cases require either
the provider key bound to the chosen model or an explicitly supplied
--opencode-auth-file snapshot carrying that provider (a selected, usable mapped
key always wins and the file is then never read; snapshots carry only the
selected provider), and neither receives the other's secret.
`;

/** Default executor: argv array in, raw result out (never a shell). */
export function execute(argv, options = {}) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? TIMEOUTS.run,
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    signal: result.signal ?? null,
    error: result.error ?? null,
  };
}

export function createHostSanitizer({ env = process.env, cwd = repoRoot, homedir = os.homedir(), tmpdir = os.tmpdir(), manifest = null } = {}) {
  const allowlist = manifest?.secretEnvAllowlist ?? [];
  return createSanitizer({
    paths: [
      { value: path.join(tmpdir, ""), label: "[tmp]" },
      { value: path.join(cwd, ""), label: "[repository]" },
      { value: homedir, label: "[home]" },
    ],
    secrets: collectSecretValues(env, allowlist),
  });
}

/**
 * Deterministic container cleanup: every tracked container is force-removed
 * with `docker rm -f` (id from the cidfile when available, else the known
 * unique name), its cidfile/temp metadata is deleted, and bounded signal
 * handlers cover client interruption while a container is active.
 */
export function createJanitor({
  executor,
  env,
  cwd,
  processRef = process,
  rmTimeout = TIMEOUTS.rm,
  stderr = () => {},
  sanitize = (value) => value,
  fsRead = (file) => readFileSync(file, "utf8"),
  fsRemove = (file) => rmSync(file, { force: true }),
  /** Best-effort hook run on interruption (e.g. credential snapshot removal). */
  onInterrupt = null,
} = {}) {
  const active = new Map();
  const activeFailures = new Map();
  const handlers = new Map();
  const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

  function cidTarget(name, cidfile) {
    try {
      const raw = String(fsRead(cidfile) ?? "").trim();
      if (/^[0-9a-f]{12,64}$/.test(raw)) return raw;
      if (/^sha256:[0-9a-f]{64}$/.test(raw)) return raw;
    } catch {
      // cidfile missing (container never started, or already removed).
    }
    return name;
  }

  function usableTarget(target) {
    return /^[0-9a-f]{12,64}$/.test(target) ||
      /^sha256:[0-9a-f]{64}$/.test(target) ||
      NAME_RE.test(target);
  }

  function recordFailure(name, reason) {
    activeFailures.set(name, reason);
  }

  /**
   * Force-remove one tracked container. Success and the explicit
   * already-absent outcome count as cleaned (cidfile + bookkeeping removed).
   * Any other result keeps the target in `active` with its cidfile so the
   * caller can retry; the reason is sanitized and retained for aggregation.
   */
  function cleanup(name, cidfile) {
    if (!active.has(name)) return { ok: true, untracked: true, target: null };
    const target = cidTarget(name, cidfile);
    if (!usableTarget(target)) {
      const reason = "refused unexpected container target format";
      recordFailure(name, reason);
      return { ok: false, target, reason };
    }
    let result;
    try {
      result = executor(["docker", "rm", "-f", target], { cwd, timeout: rmTimeout, env });
    } catch (error) {
      result = { error: { code: error?.code ?? "SPAWN_ERROR" }, status: null, stdout: "", stderr: "" };
    }
    const verdict = classifyRemovalResult(result);
    if (!verdict.cleaned) {
      const detail = verdict.detail ? sanitize(verdict.detail).slice(-300) : "";
      const reason = `${verdict.reason}${detail ? `: ${detail}` : ""}`;
      recordFailure(name, reason);
      return { ok: false, target, reason };
    }
    try {
      fsRemove(cidfile);
    } catch (error) {
      const reason = `cidfile metadata not removed: ${sanitize(error?.code ?? "error")}`;
      recordFailure(name, reason);
      return { ok: false, target, reason };
    }
    active.delete(name);
    activeFailures.delete(name);
    if (active.size === 0) releaseIfUnleased();
    return { ok: true, target, alreadyAbsent: verdict.alreadyAbsent };
  }

  /**
   * Retry-capable sweep of everything still tracked. Failed targets stay
   * tracked (with cidfile) so a later call retries them.
   */
  function cleanupAll() {
    const removed = [];
    const failed = [];
    for (const [name, cidfile] of [...active.entries()]) {
      const outcome = cleanup(name, cidfile);
      if (outcome.ok && !outcome.untracked) removed.push(name);
      else if (!outcome.ok) failed.push({ name, target: outcome.target, reason: outcome.reason });
    }
    if (active.size === 0) releaseIfUnleased();
    return { removed, failed, pending: [...active.keys()] };
  }

  function failures() {
    return [...activeFailures.entries()].map(([name, reason]) => `forced cleanup failed for ${name}: ${reason}`);
  }

  function handleSignal(signal) {
    try {
      cleanupAll();
    } catch {
      // Never mask the interruption with a cleanup error.
    }
    if (onInterrupt) {
      try {
        onInterrupt(signal);
      } catch {
        // Best effort only: the interruption path must still exit with code.
      }
    }
    const code = signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
    processRef.exit(code);
  }

  function installSignals() {
    if (handlers.size > 0 || typeof processRef.on !== "function") return;
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const handler = () => handleSignal(signal);
      handlers.set(signal, handler);
      processRef.on(signal, handler);
    }
  }

  function removeSignals() {
    if (typeof processRef.removeListener !== "function") return;
    for (const [signal, handler] of handlers) processRef.removeListener(signal, handler);
    handlers.clear();
  }

  /**
   * Lifecycle signal lease. Taken by `arm()` before credential creation and
   * pack/build, and held — regardless of the active container count — until
   * `finalizeLifecycle` explicitly calls `disarm()`. While the lease is held,
   * per-container cleanup never disarms the handlers, so there is no
   * interruption gap between sequential cases, during/after report parsing, or
   * after the final container before finalization. Releasing drops the
   * handlers, preserving the no-handler-leak behavior after finalization.
   */
  let lifecycleLease = false;

  function releaseIfUnleased() {
    if (!lifecycleLease) removeSignals();
  }

  return {
    track(name, cidfile) {
      active.set(name, cidfile);
      activeFailures.delete(name);
      installSignals();
    },
    /** Take the lifecycle signal lease (idempotent) and arm the handlers. */
    arm() {
      lifecycleLease = true;
      installSignals();
    },
    /** Release the lifecycle lease and drop handlers (finalization only). */
    disarm() {
      lifecycleLease = false;
      removeSignals();
    },
    hasLease: () => lifecycleLease,
    cleanup,
    cleanupAll,
    cidTarget,
    failures,
    activeNames: () => [...active.keys()],
    signalNames: () => [...handlers.keys()],
  };
}

export function createRunner({
  executor = execute,
  env = process.env,
  cwd = repoRoot,
  homedir = os.homedir(),
  tmpdir = os.tmpdir(),
  stdout = (line) => process.stdout.write(`${line}\n`),
  stderr = (line) => process.stderr.write(`${line}\n`),
  manifest = null,
  makeTempDir = mkdtempSync,
  removeDir = rmSync,
  processRef = process,
  /** Explicit legacy OpenCode auth file (flag > env > none; never defaulted). */
  opencodeAuthFile = null,
} = {}) {
  const matrix = manifest ?? loadMatrix(cwd);
  const packageMetadata = loadPackageMetadata(cwd);
  const baseSanitize = createHostSanitizer({ env, cwd, homedir, tmpdir, manifest: matrix });
  /**
   * Snapshot redaction (paths + every long value in the validated auth
   * document) is layered on only *after* an explicit auth file is validated,
   * so a run that never touches credentials builds no credential knowledge and
   * a Claude-only run never reads a credential file at all.
   */
  let snapshotSanitizer = null;
  const sanitize = (value) => {
    // Credential paths/values first, so the snapshot never survives as a
    // half-redacted tmp path; the base sanitizer then handles repo/home/tmp.
    const first = typeof value === "string" && snapshotSanitizer ? snapshotSanitizer(value) : value;
    return baseSanitize(first);
  };
  /** Case-run failure text additionally strips container-local absolute paths. */
  const containerPathSanitize = createSanitizer({ paths: CONTAINER_PATH_PREFIXES });
  const caseSanitize = (message) => sanitize(containerPathSanitize(String(message ?? "")));
  /** Every host-side subprocess runs credential-free: allowlisted provider
   * keys are deleted from this copy of the host environment. */
  const safeEnv = createSafeHostEnv(env, matrix.secretEnvAllowlist);
  const openCodeIds = openCodeHarnessIds(matrix);
  /** Credential snapshot state for this invocation: registered before any
   * write, removed unconditionally at finalization. */
  const credential = { dir: null, legacyPath: null, importPath: null, stagingPath: null };

  /**
   * Remove the lifecycle credential directory *and* any staging file
   * unconditionally. Returns a structured result so the finalizer can turn a
   * failure into a hard, non-zero outcome (never a "clean" claim).
   */
  function removeCredentialSnapshot() {
    let reason = null;
    const scrub = (target) => {
      if (!target) return;
      try {
        if (existsSync(target)) removeDir(target, { recursive: true, force: true });
      } catch (error) {
        reason ??= sanitize(error?.code ?? String(error?.message ?? error));
      }
    };
    if (!credential.dir && !credential.stagingPath) return { ok: true, removed: false };
    const target = credential.dir;
    scrub(credential.dir);
    scrub(credential.stagingPath);
    if (target && existsSync(target)) reason ??= "credential directory is still present after removal";
    if (credential.stagingPath && existsSync(credential.stagingPath)) {
      reason ??= "credential staging file is still present after removal";
    }
    if (reason) return { ok: false, reason };
    credential.dir = null;
    credential.legacyPath = null;
    credential.importPath = null;
    credential.stagingPath = null;
    return { ok: true, removed: Boolean(target) };
  }

  let daemonArch = null;
  const janitor = createJanitor({
    executor,
    env: safeEnv,
    cwd,
    processRef,
    stderr,
    sanitize,
    onInterrupt: () => {
      // Best effort: the credential snapshot must not outlive an interrupt.
      removeCredentialSnapshot();
    },
  });

  function write(line) {
    stdout(line);
  }

  function jsonWrite(value) {
    write(JSON.stringify(sanitizeDeep(value), null, 2));
  }

  function sanitizeDeep(value) {
    if (typeof value === "string") return sanitize(value);
    if (Array.isArray(value)) return value.map(sanitizeDeep);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeDeep(entry)]));
    }
    return value;
  }

  function run(argv, { label, cwd: commandCwd = cwd, timeout = TIMEOUTS.run, safe = false, secretNames = [], execEnv = null } = {}) {
    if (safe) {
      assertSafeRunArgv(argv, {
        repoRoot: cwd,
        home: homedir,
        secretNames,
        secretAllowlist: matrix.secretEnvAllowlist,
        credentialDir: credential.dir,
        openCodeHarnessIds: openCodeIds,
        requireImageId: true,
      });
    }
    const result = executor(argv, { cwd: commandCwd, timeout, env: execEnv ?? safeEnv });
    if (result.error || (result.status ?? 0) !== 0) {
      throw new Error(formatCommandFailure({ label, argv, result, sanitize }));
    }
    return result;
  }

  /** Docker case/smoke env: safe host env + exactly the spec's secrets. */
  function caseRunEnv(spec) {
    return containerRunEnv({ safeEnv, hostEnv: env, spec, allowlist: matrix.secretEnvAllowlist });
  }

  /**
   * The single live container route, owned by the production runner:
   * typed spec -> canonical argv -> exact validation (including deep-equality
   * with `runSpecToArgv(spec)`) -> executor with the spec's scoped env ->
   * forced `docker rm -f` cleanup whose result is inspected. A cleanup
   * failure is a hard failure: the target stays tracked for retry and the
   * error is reported through the aggregated cleanup failure path.
   */
  function executeRun(spec, { label, timeout = TIMEOUTS.run }) {
    assertSafeRunSpec(spec, {
      repoRoot: cwd,
      home: homedir,
      manifest: matrix,
      credentialDir: credential.dir,
      requireImageId: true,
    });
    const argv = runSpecToArgv(spec);
    assertSafeRunArgv(argv, {
      repoRoot: cwd,
      home: homedir,
      secretNames: [...spec.secretNames],
      secretAllowlist: matrix.secretEnvAllowlist,
      credentialDir: credential.dir,
      openCodeHarnessIds: openCodeIds,
      requireImageId: true,
      spec,
    });
    janitor.track(spec.name, spec.cidfile);
    const failSanitize = spec.kind === "case" ? caseSanitize : sanitize;
    let primary = null;
    let result = null;
    try {
      result = executor(argv, { cwd, timeout, env: caseRunEnv(spec) });
      if (result.error || (result.status ?? 0) !== 0) {
        primary = new Error(formatCommandFailure({ label, argv, result, sanitize: failSanitize }));
      }
    } catch (error) {
      primary = error instanceof Error ? error : new Error(String(error));
    }
    const cleanup = janitor.cleanup(spec.name, spec.cidfile);
    if (!cleanup.ok) {
      const detail = janitor.failures().map((message) => failSanitize(message)).join("\n");
      const original = primary ? `original failure: ${failSanitize(primary.message)}` : null;
      throw new Error(
        `cleanup failed after ${label} (${failSanitize(cleanup.reason ?? "unknown")}); target retained for retry\n` +
          [detail, original].filter(Boolean).join("\n"),
      );
    }
    if (primary) throw primary;
    return result;
  }

  function checkDocker() {
    const probe = executor(["docker", "version", "--format", "{{.Client.Version}} {{.Server.Version}}"], {
      cwd,
      timeout: TIMEOUTS.probe,
      env: safeEnv,
    });
    if (probe.error && probe.error.code === "ENOENT") {
      throw new PlanError(
        "Docker CLI not found on PATH. Install Docker Desktop (macOS/Windows: https://docs.docker.com/get-started/get-docker/) " +
          "or the docker engine package on Linux, confirm `docker version` works, then re-run.",
      );
    }
    if (probe.error || (probe.status ?? 0) !== 0) {
      const detail = sanitize(String(probe.stderr || probe.stdout || "").trim().split(/\r?\n/).slice(-3).join(" ")).slice(0, 600);
      throw new PlanError(
        "Docker CLI is present but the daemon is not reachable" +
          (detail ? `: ${detail}` : "") +
          ". Start Docker Desktop, or on Linux start the service (`sudo systemctl start docker`), " +
          "then verify with `docker version` and re-run.",
      );
    }
    const infoProbe = executor(["docker", "info", "--format", "{{.OSType}} {{.Architecture}}"], {
      cwd,
      timeout: TIMEOUTS.probe,
      env: safeEnv,
    });
    if ((infoProbe.status ?? 0) !== 0) {
      throw new PlanError("Docker daemon responded to `version` but `info` failed; check `docker info` and re-run.");
    }
    const [osType = "", arch = ""] = infoProbe.stdout.trim().split(/\s+/);
    if (osType !== "linux") {
      throw new PlanError(
        `Docker is configured for "${osType || "unknown"}" containers; the harness matrix requires Linux containers ` +
          "(switch Docker Desktop to Linux containers and re-run).",
      );
    }
    daemonArch = arch || null;
    return { osType, architecture: daemonArch };
  }

  function checkBuildSupport() {
    const buildHelp = executor(["docker", "build", "--help"], { cwd, timeout: TIMEOUTS.probe, env: safeEnv });
    if ((buildHelp.status ?? 0) !== 0) {
      throw new PlanError("could not run `docker build --help`; check your Docker installation and re-run.");
    }
    if (!String(buildHelp.stdout).includes("--iidfile")) {
      throw new PlanError(
        "`docker build` does not support --iidfile (required to record immutable image ids). " +
          "Upgrade to Docker 20.10+ with BuildKit, then re-run.",
      );
    }
    const runHelp = executor(["docker", "run", "--help"], { cwd, timeout: TIMEOUTS.probe, env: safeEnv });
    if ((runHelp.status ?? 0) !== 0) {
      throw new PlanError("could not run `docker run --help`; check your Docker installation and re-run.");
    }
    const runHelpText = String(runHelp.stdout);
    for (const flag of ["--pull", "--cidfile"]) {
      if (!runHelpText.includes(flag)) {
        throw new PlanError(`\`docker run\` does not support ${flag} (required for immutable-id execution and cleanup). Upgrade Docker, then re-run.`);
      }
    }
    return true;
  }

  function baseImageLine() {
    const info = resolveBaseImageInfo(matrix, env);
    if (info.overridden) {
      return `base image: ${info.image} (OVERRIDE via ${info.overrideEnv}: reproducibility claim weakened, not digest-pinned)`;
    }
    return `base image: ${info.image} (digest-pinned multi-arch manifest)`;
  }

  function selectedSecretNames(requested, { requirePresent = false } = {}) {
    return resolveSecretEnvNames({ requested, manifest: matrix, hostEnv: env, requirePresent });
  }

  function makeLifecycleDirs(prefix) {
    const workdirRoot = path.join(tmpdir, prefix);
    mkdirSync(tmpdir, { recursive: true });
    const workdir = makeTempDir(workdirRoot);
    const dirs = {
      workdir,
      contextDir: path.join(workdir, "context"),
      iidDir: path.join(workdir, "iid"),
      cidDir: path.join(workdir, "cid"),
      artifactDir: path.join(workdir, "artifact"),
    };
    // Every lifecycle path must exist before Docker writes iidfiles/cidfiles.
    for (const dir of [dirs.iidDir, dirs.cidDir, dirs.artifactDir]) {
      mkdirSync(dir, { recursive: true });
    }
    return dirs;
  }

  function removeLifecycleDirs(dirs, { keep = false } = {}) {
    if (keep) {
      stderr(`note: lifecycle temp dir kept on request: ${sanitize(dirs.workdir)}`);
      return false;
    }
    try {
      removeDir(dirs.workdir, { recursive: true, force: true });
      return true;
    } catch (error) {
      stderr(`warning: could not remove lifecycle temp dir: ${sanitize(error?.code ?? String(error?.message))}`);
      return false;
    }
  }

  /** Pack once into the lifecycle temp dir. The caller owns the artifact's
   * lifetime: nothing here deletes it before cases can consume it. */
  function packArtifact({ destination }) {
    const plan = planPack({ repoRoot: cwd, packageMetadata, destination });
    const result = run(plan.argv, { label: "npm pack", timeout: TIMEOUTS.pack });
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    const fileName = lines.at(-1);
    if (!fileName) throw new Error("npm pack produced no tarball name");
    if (fileName !== predictedTarballName(packageMetadata)) {
      throw new Error(`npm pack produced "${sanitize(fileName)}", expected "${predictedTarballName(packageMetadata)}"`);
    }
    const artifactPath = path.join(destination, fileName);
    const bytes = readFileSync(artifactPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return { plan, artifactPath, sha256, bytes: bytes.length, fileName };
  }

  function readImageId(iidfile, { image }) {
    if (existsSync(iidfile)) {
      const raw = String(readFileSync(iidfile, "utf8")).trim();
      if (raw) return assertImageId(raw);
    }
    // --no-build: resolve the existing tag to its immutable id.
    const result = run(["docker", "image", "inspect", "--format", "{{.Id}}", image], {
      label: `docker image inspect ${image}`,
      timeout: TIMEOUTS.probe,
    });
    return assertImageId(result.stdout.trim());
  }

  /** Build (or resolve) immutable images and validate them host-side. */
  function buildOrResolveImages({ dirs, harnessIds, noCache = false, skipBuild = false, quiet = false }) {
    const plans = planBuild({ manifest: matrix, repoRoot: cwd, env, harnesses: harnessIds, contextDir: dirs.contextDir, iidDir: dirs.iidDir });
    const images = new Map();
    for (const entry of plans) {
      const argv = noCache ? insertAfter(entry.argv, "--no-cache", 2) : entry.argv;
      if (!skipBuild) {
        run(argv, { label: `docker build ${entry.harnessId}`, timeout: TIMEOUTS.build });
        if (!quiet) write(`built ${entry.image}`);
      }
      const imageId = readImageId(entry.iidfile, { image: entry.image });
      const inspect = parseImageInspect(
        run(["docker", "image", "inspect", "--format", "{{json .}}", imageId], {
          label: `docker image inspect ${entry.harnessId}`,
          timeout: TIMEOUTS.probe,
        }).stdout,
      );
      const harness = expandHarnesses(matrix, { env, harnesses: [entry.harnessId] })[0];
      const info = validateImageInspect({ harness, imageId, inspect });
      images.set(entry.harnessId, { ...harness, imageId, info });
      if (!quiet) {
        write(`image ${entry.harnessId}: ${imageId} (${info.os}/${info.architecture}, label ok${info.tags.length ? `, tags ${info.tags.join(",")}` : ""})`);
      }
    }
    return images;
  }

  function stageContext(dirs) {
    return stageBuildContext({ repoRoot: cwd, stageDir: dirs.contextDir });
  }

  function parseReport(result, { label, argv }) {
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    const last = lines.at(-1);
    try {
      return JSON.parse(last);
    } catch {
      throw new Error(formatCommandFailure({ label: `${label} (output was not the expected JSON report)`, argv, result, sanitize }));
    }
  }

  /**
   * Final label-based leftover sweep for the current run: list containers by
   * the exact managed run label, force-remove whatever is returned, then
   * re-list to prove absence. Fails closed whenever Docker cannot prove
   * absence (probe failure, removal failure, or leftovers still listed).
   */
  function finalSweep(runId) {
    if (!runId) throw new PlanError("final leftover sweep requires a run id");
    const filter = `label=${LABELS.run}=${runId}`;
    const list = () => {
      const result = executor(["docker", "ps", "-aq", "--filter", filter], {
        cwd,
        timeout: TIMEOUTS.probe,
        env: safeEnv,
      });
      if (result.error || (result.status ?? 0) !== 0) {
        const detail = sanitize(String(result.stderr || result.stdout || "").trim().slice(-300));
        throw new Error(`leftover sweep cannot prove absence: docker ps failed${detail ? `: ${detail}` : ""}`);
      }
      return String(result.stdout ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[0-9a-f]{12,64}$/.test(line));
    };
    const before = list();
    const removed = [];
    for (const id of before) {
      const result = executor(["docker", "rm", "-f", id], { cwd, timeout: TIMEOUTS.rm, env: safeEnv });
      const verdict = classifyRemovalResult(result);
      if (!verdict.cleaned) {
        const detail = verdict.detail ? sanitize(verdict.detail).slice(-300) : "";
        throw new Error(
          `leftover sweep could not force-remove container ${id} (${verdict.reason}${detail ? `: ${detail}` : ""})`,
        );
      }
      removed.push(id);
    }
    const after = list();
    if (after.length) {
      throw new Error(`leftover sweep failed verification: ${after.length} container(s) remain for run ${runId}`);
    }
    return { matched: before.length, removed, verifiedAbsent: true };
  }

  /**
   * Deterministic end-of-lifecycle finalization: retry force-removal of
   * everything still tracked, run the label sweep, drop temp metadata, and
   * aggregate failures. Cleanup failures are hard failures — success output
   * is only produced after absence is proven, and the original error (if
   * any) is preserved in sanitized form.
   */
  function finalizeLifecycle({ runId = null, dirs = null, keep = false, primary = null } = {}) {
    const failures = [];
    /**
     * Order matters: containers first (force-remove everything tracked, then
     * prove absence with the label sweep) and only afterwards scrub the
     * credential directory — never delete the credential path first while a
     * container of this run may still be mounting it. The scrub is
     * unconditional afterwards: `--keep`, execution failures, and cleanup
     * failures never retain it, and a scrub failure is a hard failure.
     */
    let cleanup = { removed: [], failed: [], pending: [] };
    let sweep = null;
    try {
      cleanup = janitor.cleanupAll();
      failures.push(...janitor.failures());
    } catch (error) {
      failures.push(`forced cleanup could not run: ${sanitize(error?.message ?? String(error))}`);
    }
    if (runId) {
      try {
        sweep = finalSweep(runId);
      } catch (error) {
        failures.push(sanitize(error?.message ?? String(error)));
      }
    }
    // Absence is only ever claimed when the sweep proved it. Credentials were
    // mounted by this run if a credential directory still exists here.
    const absenceProven = failures.length === 0 && sweep?.verifiedAbsent === true;
    const credentialsMounted = Boolean(credential.dir || credential.stagingPath);

    let credentialFailure = null;
    const firstCredentialPass = removeCredentialSnapshot();
    if (!firstCredentialPass.ok) credentialFailure = firstCredentialPass.reason;

    if (dirs) removeLifecycleDirs(dirs, { keep });
    if (credentialFailure) {
      const retry = removeCredentialSnapshot();
      if (retry.ok) credentialFailure = null;
      else failures.push(`credential snapshot could not be removed: ${credentialFailure}${retry.reason ? `; retry: ${retry.reason}` : ""}`);
    }
    janitor.disarm();
    if (failures.length) {
      const lines = failures.map((message) => sanitize(message));
      if (primary) lines.push(`original failure: ${sanitize(primary.message ?? String(primary))}`);
      // Truthful failure path: containers may still exist, and an
      // already-mounted inode keeps the scrubbed bytes readable for as long as
      // that container lives. Never claim absence here.
      if (credentialsMounted && !absenceProven) {
        lines.push(
          sanitize(
            "container absence was NOT proven for this run: a leftover container may still hold the already-mounted " +
              "credential inode with its bytes even though the host credential paths were scrubbed " +
              "(the Docker daemon and its administrators are trusted)",
          ),
        );
      }
      throw new Error(`cleanup could not be verified:\n${lines.join("\n")}`);
    }
    if (primary) throw primary;
    return { cleanup, sweep };
  }

  const api = {
    sanitize,
    matrix,
    packageMetadata,
    janitor,
    checkDocker,
    checkBuildSupport,
    executeRun,
    packArtifact,
    finalSweep,
    finalizeLifecycle,

    get safeEnv() {
      return safeEnv;
    },

    get daemonArch() {
      return daemonArch;
    },

    list({ json = false } = {}) {
      const harnesses = expandHarnesses(matrix, { env });
      const cases = expandMatrix(matrix, { env });
      const base = resolveBaseImageInfo(matrix, env);
      if (json) {
        jsonWrite({
          schemaVersion: matrix.schemaVersion,
          baseImage: base,
          harnesses,
          cases,
          secretEnvAllowlist: matrix.secretEnvAllowlist,
          harnessSecretAllowlists: Object.fromEntries(
            Object.entries(matrix.harnesses).map(([id, harness]) => [id, harness.secretAllowlist]),
          ),
        });
        return { harnesses, cases };
      }
      write("container harness matrix (build/smoke are credential-free; `run` executes the seven cases with explicit model envs)");
      write(baseImageLine());
      if (base.pinned) write(`  digest source: ${matrix.baseImageDigestNote ?? "re-verify with docker buildx imagetools inspect"}`);
      write("  coverage: native daemon architecture only (this matrix does not claim multi-arch coverage)");
      write("");
      write("harness images:");
      for (const harness of harnesses) {
        write(
          `  ${harness.id.padEnd(12)} ${harness.package}@${harness.version} -> ${harness.image} ` +
            `(target ${harness.target}, binary ${harness.binary} major ${harness.major}, ` +
            `secrets: ${harness.secretAllowlist.join(",")})`,
        );
      }
      write("");
      write("cases (one fresh `docker run --rm` each, executed by immutable image id):");
      for (const entry of cases) {
        write(`  ${entry.id.padEnd(20)} harness=${entry.harness} scenario=${entry.scenario} phase=${entry.phase}`);
      }
      write("");
      write(`secret env allowlist (global): ${matrix.secretEnvAllowlist.join(", ")}`);
      write(
        "per-harness allowlists are enforced; Claude cases inherit only CLAUDE_CODE_OAUTH_TOKEN " +
          "(claude setup-token, non-bare), and OpenCode cases never receive it.",
      );
      write("no credentials are required for list/plan/pack/build/smoke/auth-check.");
      return { harnesses, cases };
    },

    plan({ caseIds = [], harnessIds = [], secretEnv = [], json = false, network = null } = {}) {
      const { names, missing } = selectedSecretNames(secretEnv);
      const containerNetwork = network ?? env[ENV_KEYS.network] ?? DEFAULT_CASE_NETWORK;
      const runId = newRunId();
      const destination = path.join(tmpdir, "skill-router-container-plan");
      const plan = planMatrix({
        manifest: matrix,
        repoRoot: cwd,
        packageMetadata,
        destination,
        artifactPath: path.join(destination, predictedTarballName(packageMetadata)),
        runId,
        secretEnvNames: names,
        network: containerNetwork,
        cases: caseIds,
        harnesses: harnessIds,
        home: homedir,
        env,
        cidfileDir: path.join(destination, "cidfiles"),
      });
      const builds = planBuild({
        manifest: matrix,
        repoRoot: cwd,
        env,
        harnesses: harnessIds,
        contextDir: path.join(destination, "context"),
        iidDir: path.join(destination, "iid"),
      });
      const warnings = missing.length
        ? [`warning: allowlisted secret env not set in the host environment: ${missing.join(", ")} (Phase 1 does not need it)`]
        : [];
      const excluded = [...new Set(plan.cases.flatMap((entry) => entry.excludedSecretNames))];
      if (excluded.length) {
        warnings.push(`note: secrets excluded per harness allowlist: ${excluded.join(", ")}`);
      }
      if (json) {
        jsonWrite({
          mode: "plan",
          executed: false,
          runId,
          network: containerNetwork,
          baseImage: resolveBaseImageInfo(matrix, env),
          secretEnvNames: names,
          pack: { argv: plan.pack.argv, cwd: plan.pack.cwd, artifact: plan.pack.predictedArtifact },
          builds: builds.map((entry) => ({ harnessId: entry.harnessId, argv: entry.argv })),
          cases: plan.cases.map((entry) => ({
            id: entry.caseId,
            harness: entry.harness,
            image: entry.image,
            name: entry.name,
            cidfile: entry.cidfile,
            secretEnvNames: entry.secretEnvNames,
            excludedSecretNames: entry.excludedSecretNames,
            argv: entry.argv,
          })),
          warnings,
          note: "dry run: nothing was executed; live runs execute sha256 image ids with --pull=never and add --harness/--scenario/--artifact-sha256/--container-name plus the harness model env",
        });
        return plan;
      }
      write("phase 1 plan (dry run: no Docker calls, no pack executed)");
      write(`run id: ${runId}`);
      write(baseImageLine());
      write("");
      write("pack once:");
      write(`  ${displayArgv(plan.pack.argv, sanitize)}`);
      write(`  cwd: ${sanitize(plan.pack.cwd)}`);
      write(`  artifact: ${sanitize(plan.pack.predictedArtifact)}`);
      write("");
      write("build (staged minimal context: Dockerfile + container-verify.mjs):");
      for (const entry of builds) write(`  [${entry.harnessId}] ${displayArgv(entry.argv, sanitize)}`);
      write("");
      write(`cases (${plan.cases.length}), one fresh container each (live runs substitute the sha256 image id):`);
      for (const entry of plan.cases) {
        write(`  [${entry.caseId}] ${entry.name}`);
        write(`    secrets: ${entry.secretEnvNames.join(", ") || "none"}${entry.excludedSecretNames.length ? ` (excluded: ${entry.excludedSecretNames.join(", ")})` : ""}`);
        write(`    ${displayArgv(entry.argv, sanitize)}`);
      }
      for (const warning of warnings) write(warning);
      write("");
      write("reminder: repository/HOME/config are never mounted; secrets are inherited by name only;");
      write("case runs use the isolated bridge network (internet/LAN reachable, host network namespace never shared).");
      return plan;
    },

    pack({ keep = false, json = false } = {}) {
      const dirs = makeLifecycleDirs("skill-router-pack-");
      try {
        const artifact = packArtifact({ destination: dirs.artifactDir });
        if (json) {
          jsonWrite({ file: artifact.fileName, sha256: artifact.sha256, bytes: artifact.bytes, artifact: artifact.artifactPath, kept: keep, runsPerInvocation: 1 });
        } else {
          write(`packed once: ${artifact.fileName}`);
          write(`sha256: ${artifact.sha256}`);
          write(`bytes: ${artifact.bytes}`);
          write(
            keep
              ? `artifact (kept on request): ${artifact.artifactPath}`
              : `artifact: ${sanitize(artifact.artifactPath)} (removed after hashing; the enclosing lifecycle keeps it until cleanup)`,
          );
        }
        return { ...artifact, kept: keep };
      } finally {
        removeLifecycleDirs(dirs, { keep });
      }
    },

    build({ harnessIds = [], dryRun = false, json = false, noCache = false, skipBuild = false, keepWorkdir = false } = {}) {
      const synthetic = path.join(tmpdir, "skill-router-container-plan");
      const plans = planBuild({
        manifest: matrix,
        repoRoot: cwd,
        env,
        harnesses: harnessIds,
        contextDir: path.join(synthetic, "context"),
        iidDir: path.join(synthetic, "iid"),
      });
      if (dryRun) {
        if (json) jsonWrite({ mode: "build", executed: false, baseImage: resolveBaseImageInfo(matrix, env), commands: plans.map((entry) => ({ harnessId: entry.harnessId, image: entry.image, argv: entry.argv })) });
        else {
          write("phase 1 build plan (dry run: nothing was executed)");
          write(baseImageLine());
          for (const entry of plans) write(`  [${entry.harnessId}] ${displayArgv(entry.argv, sanitize)}`);
        }
        return plans;
      }
      checkDocker();
      checkBuildSupport();
      const dirs = makeLifecycleDirs("skill-router-build-");
      try {
        stageContext(dirs);
        const images = buildOrResolveImages({ dirs, harnessIds, noCache, skipBuild });
        const summary = [...images.values()].map((entry) => ({ harnessId: entry.id, imageId: entry.imageId, ...entry.info }));
        if (json) jsonWrite({ mode: "build", executed: true, baseImage: resolveBaseImageInfo(matrix, env), images: summary });
        else write(baseImageLine());
        return summary;
      } finally {
        removeLifecycleDirs(dirs, { keep: keepWorkdir });
      }
    },

    smoke({ harnessIds = [], dryRun = false, json = false, skipBuild = false, keepWorkdir = false } = {}) {
      const runId = newRunId();
      const synthetic = path.join(tmpdir, "skill-router-container-plan");
      const plan = planSmoke({
        manifest: matrix,
        repoRoot: cwd,
        env,
        harnesses: harnessIds,
        runId,
        contextDir: path.join(synthetic, "context"),
        iidDir: path.join(synthetic, "iid"),
        cidfileDir: path.join(synthetic, "cidfiles"),
      });
      if (dryRun) {
        if (json) {
          jsonWrite({
            mode: "smoke",
            executed: false,
            runId,
            baseImage: resolveBaseImageInfo(matrix, env),
            builds: plan.builds.map((entry) => ({ harnessId: entry.harnessId, argv: entry.argv })),
            runs: plan.runs.map((entry) => ({ harnessId: entry.harnessId, name: entry.name, cidfile: entry.cidfile, argv: entry.argv })),
          });
        } else {
          write("phase 1 smoke plan (dry run: nothing was executed)");
          write(baseImageLine());
          write("");
          write("build:");
          for (const entry of plan.builds) write(`  [${entry.harnessId}] ${displayArgv(entry.argv, sanitize)}`);
          write("");
          write("fresh container per harness by immutable image id (--pull=never, --network=none, no credentials):");
          for (const entry of plan.runs) write(`  [${entry.harnessId}] ${displayArgv(entry.argv, sanitize)}`);
        }
        return plan;
      }

      checkDocker();
      checkBuildSupport();
      const dirs = makeLifecycleDirs("skill-router-smoke-");
      let primary = null;
      let artifact = null;
      let images = null;
      const verified = [];
      try {
        stageContext(dirs);
        artifact = packArtifact({ destination: dirs.artifactDir });
        if (!json) write(`packed once: ${artifact.fileName} sha256=${artifact.sha256}`);
        images = buildOrResolveImages({ dirs, harnessIds, skipBuild, quiet: json });
        for (const entry of plan.runs) {
          const image = images.get(entry.harnessId);
          if (!image) throw new PlanError(`no resolved image for harness ${entry.harnessId}`);
          const spec = resolveSpecImage(
            { ...entry.spec, cidfile: path.join(dirs.cidDir, `${entry.name}.cid`) },
            image.imageId,
          );
          const result = executeRun(spec, { label: `smoke ${entry.harnessId}` });
          const report = parseReport(result, { label: `smoke ${entry.harnessId}`, argv: runSpecToArgv(spec) });
          const validated = validateSmokeReport({ report, harness: image, imageInfo: image.info });
          verified.push(validated);
          if (!json) write(formatSmokeSuccess({ harnessId: entry.harnessId, report: validated, imageInfo: image.info, containerName: entry.name, sanitize }));
        }
      } catch (error) {
        primary = error;
      }
      // Cleanup and the label sweep must both prove absence before any
      // success output is produced; failures here make the command exit nonzero.
      const finalized = finalizeLifecycle({ runId, dirs, keep: keepWorkdir, primary });
      const architecture = images.values().next().value?.info?.architecture ?? daemonArch;
      if (json) {
        jsonWrite({
          mode: "smoke",
          executed: true,
          runId,
          baseImage: resolveBaseImageInfo(matrix, env),
          artifact: { file: artifact.fileName, sha256: artifact.sha256, bytes: artifact.bytes },
          runtimeCoverage: { os: "linux", architecture, note: "native daemon architecture only" },
          images: [...images.values()].map((entry) => ({ harnessId: entry.id, imageId: entry.imageId, ...entry.info })),
          verified,
          cleanup: {
            trackedPending: finalized.cleanup.pending.length,
            sweepMatched: finalized.sweep.matched,
            verifiedAbsent: finalized.sweep.verifiedAbsent,
          },
        });
      } else {
        write(`runtime coverage: linux/${architecture} (native daemon architecture only, not multi-arch)`);
        write(
          `cleanup: verified — tracked pending ${finalized.cleanup.pending.length}, ` +
            `label sweep matched ${finalized.sweep.matched}, 0 remaining for run ${runId}`,
        );
      }
      return { runId, verified, images: [...images.values()], cleanup: finalized.cleanup, sweep: finalized.sweep };
    },

    /**
     * Credential-free fake-auth validation (Docker seam, no model request):
     * a *generated* dummy OpenCode auth document is pushed through the exact
     * validation + snapshot path a real one uses, then one fresh
     * `--network=none` container per OpenCode harness mounts it at the fixed
     * destination and proves locally that the pinned image recognizes both
     * supported providers. A real host auth file is never read here.
     */
    authCheck({
      harnessIds = [],
      json = false,
      dryRun = false,
      noCache = false,
      skipBuild = false,
      keepWorkdir = false,
    } = {}) {
      const selected = harnessIds.length ? harnessIds : [...openCodeIds];
      for (const id of selected) {
        if (!openCodeIds.includes(id)) {
          throw new PlanError(`auth-check only supports the OpenCode harnesses: ${openCodeIds.join(", ")}`);
        }
      }
      const runId = newRunId();
      const synthetic = path.join(tmpdir, "skill-router-container-plan");
      const dryCredentialDir = path.join(synthetic, "opencode-credential");
      const dryPlans = selected.map((id) =>
        planAuthCheckRun({
          manifest: matrix,
          harness: expandHarnesses(matrix, { env, harnesses: [id] })[0],
          runId,
          credentialDir: dryCredentialDir,
          cidfile: path.join(synthetic, "cidfiles", `skill-router-authcheck-${id}-${runId}.cid`),
        }),
      );
      if (dryRun) {
        if (json) {
          jsonWrite({
            mode: "auth-check",
            executed: false,
            runId,
            providers: [...OPENCODE_AUTH_SUPPORTED_PROVIDERS],
            commands: dryPlans.map((entry) => ({ harnessId: entry.harnessId, argv: entry.argv })),
          });
        } else {
          write("auth-check plan (dry run: nothing was executed)");
          write(`run id: ${runId}`);
          write(`generated dummy providers: ${OPENCODE_AUTH_SUPPORTED_PROVIDERS.join(", ")} (never a real host credential)`);
          for (const entry of dryPlans) write(`  [${entry.harnessId}] ${displayArgv(entry.argv, sanitize)}`);
        }
        return dryPlans;
      }

      checkDocker();
      checkBuildSupport();
      const dirs = makeLifecycleDirs("skill-router-authcheck-");
      let primary = null;
      let images = null;
      const verified = [];
      // Arm interruption cleanup before any credential file exists.
      janitor.arm();
      try {
        /**
         * Generated dummy document: written owner-only, validated by the same
         * resolver a real file uses, then snapshotted. Its staging source lives
         * *outside* the mounted directory and is scrubbed as soon as the
         * snapshot exists, so the mounted directory holds exactly the two
         * credential files (legacy v1 JSON + generated v2 import JSON).
         */
        const stagingPath = path.join(dirs.workdir, "dummy-auth-source.json");
        writeFileSync(stagingPath, dummyOpenCodeAuthBytes(), { mode: 0o600 });
        chmodSync(stagingPath, 0o600);
        const descriptor = resolveOpenCodeAuthFile({ requested: stagingPath });
        dirs.credentialDir = path.join(dirs.workdir, "opencode-credential");
        credential.dir = dirs.credentialDir; // registered before creation
        credential.stagingPath = stagingPath;
        const snapshot = createOpenCodeAuthSnapshot({
          descriptor,
          credentialDir: dirs.credentialDir,
          providers: [...OPENCODE_AUTH_SUPPORTED_PROVIDERS],
        });
        credential.legacyPath = snapshot.legacyPath;
        credential.importPath = snapshot.importPath;
        snapshotSanitizer = createSanitizer({
          paths: [
            { value: snapshot.importPath, label: "[opencode-auth-import]" },
            { value: snapshot.legacyPath, label: "[opencode-auth]" },
            { value: stagingPath, label: "[opencode-auth-source]" },
            { value: dirs.credentialDir, label: "[opencode-auth-dir]" },
          ],
          secrets: [...descriptor.values],
        });
        rmSync(stagingPath, { force: true });
        credential.stagingPath = null;

        stageContext(dirs);
        images = buildOrResolveImages({ dirs, harnessIds: selected, noCache, quiet: json });

        for (const id of selected) {
          const harness = images.get(id);
          if (!harness) throw new PlanError(`no resolved image for harness ${id}`);
          const plan = planAuthCheckRun({
            manifest: matrix,
            harness,
            runId,
            credentialDir: dirs.credentialDir,
            cidfile: path.join(dirs.cidDir, `skill-router-authcheck-${id}-${runId}.cid`),
          });
          const spec = resolveSpecImage(plan.spec, harness.imageId);
          const result = executeRun(spec, { label: `auth-check ${id}` });
          const report = parseReport(result, { label: `auth-check ${id}`, argv: runSpecToArgv(spec) });
          const validated = validateAuthCheckReport({ report, harness });
          verified.push(validated);
          if (!json) {
            write(
              `auth-check ${id}: ok ${harness.package}@${harness.version} recognition=${validated.recognition} ` +
                `providers=[${validated.providers.join(",")}] (uid ${validated.uid}, network=none, ` +
                `no model request, fresh container ${plan.name})`,
            );
          }
        }
      } catch (error) {
        primary = error;
      }
      const finalized = finalizeLifecycle({ runId, dirs, keep: keepWorkdir, primary });
      if (json) {
        jsonWrite({
          mode: "auth-check",
          executed: true,
          runId,
          providers: [...OPENCODE_AUTH_SUPPORTED_PROVIDERS],
          verified,
          cleanup: {
            trackedPending: finalized.cleanup.pending.length,
            sweepMatched: finalized.sweep.matched,
            verifiedAbsent: finalized.sweep.verifiedAbsent,
          },
        });
      } else {
        write(
          `cleanup: verified — tracked pending ${finalized.cleanup.pending.length}, ` +
            `label sweep matched ${finalized.sweep.matched}, 0 remaining for run ${runId}`,
        );
      }
      return { runId, verified, cleanup: finalized.cleanup, sweep: finalized.sweep };
    },

    /**
     * Production Phase 2 entrypoint: the runner owns Docker execution and
     * executes the manifest cases (default `executeCases: true`), one fresh
     * container per case, through the canonical executeRun/cleanup/sweep path.
     *
     * Preflight (explicit model envs + required credentials) fails before any
     * pack, build, probe, or container starts. Each case receives:
     *   - the production in-container command (run-case.mjs with case id,
     *     harness, scenario, locked artifact sha256, container name) unless an
     *     adapter supplies a typed in-container command instead;
     *   - the required non-secret model env for its harness (never defaulted);
     *   - exactly its per-harness selected secrets (values inherited).
     *
     * The runner parses exactly one JSON report from the container, validates
     * every expected field (identity, locked artifact hash, sessionCount,
     * structural chain, outcome, container freshness), prints a concise
     * sanitized success line, and hands only that validated summary to an
     * optional `caseReporter` hook — raw container output never leaves here.
     *
     * Low-level dependency injection stays at the command `executor`.
     */
    run({
      caseIds = [],
      harnessIds = [],
      secretEnv = [],
      json = false,
      network = null,
      dryRun = false,
      noCache = false,
      skipBuild = false,
      keepWorkdir = false,
      executeCases = true,
      caseCommander = null,
      caseReporter = null,
    } = {}) {
      if (skipBuild) {
        throw new PlanError(
          "`run --no-build` is forbidden: live case execution must build its own images so every case " +
            "runs an immutable image id that this invocation verified, never a mutable local tag. " +
            "Use `build --no-build` or `smoke --no-build` (both credential-free) to resolve existing tags.",
        );
      }
      const { names, missing } = selectedSecretNames(secretEnv);
      const containerNetwork = network ?? env[ENV_KEYS.network] ?? DEFAULT_CASE_NETWORK;
      if (dryRun) {
        return api.plan({ caseIds, harnessIds, secretEnv, json, network: containerNetwork });
      }
      /**
       * Explicit OpenCode auth input is resolved *inside* preflight, which
       * chooses the auth mode deterministically: a usable selected mapped key
       * wins (`environment`, file never read), otherwise the explicitly
       * requested file is validated (only when OpenCode cases are selected).
       * A Claude-only or executeCases=false run never reads the file.
       */
      const authRequest = opencodeAuthFile ?? env[ENV_KEYS.opencodeAuthFile] ?? null;

      // Phase 2 preflight: required model envs and credentials must be present
      // before any pack, build, probe, or container starts.
      let preflight = { cases: [], models: {}, notes: [], auth: { mode: "none", provider: null, snapshot: null } };
      if (executeCases) {
        preflight = preflightLiveCases({
          manifest: matrix,
          env,
          caseIds,
          harnessIds,
          selectedSecretNames: names,
          authFile: authRequest,
        });
        assertSecretValuesUsable(env, names);
        if (!json) for (const note of preflight.notes) write(note);
      }
      const authMode = preflight.auth ?? { mode: "none", provider: null, snapshot: null };
      checkDocker();
      checkBuildSupport();
      const runId = newRunId();
      const dirs = makeLifecycleDirs("skill-router-run-");
      let primary = null;
      let packed = null;
      let images = null;
      let planned = null;
      let resolved = [];
      const executed = [];
      const executedByCase = new Map();
      // Arm interruption cleanup before any credential file exists and before
      // pack/build start, so a signal in those windows still scrubs credentials.
      janitor.arm();
      try {
        if (authMode.mode === "snapshot" && authMode.snapshot) {
          const authSnapshot = authMode.snapshot;
          if (isInside(authSnapshot.path, dirs.workdir)) {
            throw new PlanError("the requested OpenCode auth file must not live inside the lifecycle temp directory");
          }
          dirs.credentialDir = path.join(dirs.workdir, "opencode-credential");
          // Register the directory BEFORE writing anything into it, so an
          // interrupt during creation still scrubs whatever was written.
          credential.dir = dirs.credentialDir;
          // Provider-filtered snapshot: both files carry exactly the selected
          // model provider, nothing else.
          const snapshot = createOpenCodeAuthSnapshot({
            descriptor: authSnapshot,
            credentialDir: dirs.credentialDir,
            providers: [authMode.provider],
          });
          credential.legacyPath = snapshot.legacyPath;
          credential.importPath = snapshot.importPath;
          // Path + value redaction for every later message and audit line.
          snapshotSanitizer = createSanitizer({
            paths: [
              { value: snapshot.importPath, label: "[opencode-auth-import]" },
              { value: snapshot.legacyPath, label: "[opencode-auth]" },
              { value: authSnapshot.path, label: "[opencode-auth-file]" },
              { value: dirs.credentialDir, label: "[opencode-auth-dir]" },
            ],
            secrets: [...authSnapshot.values],
          });
        }
        stageContext(dirs);
        packed = packArtifact({ destination: dirs.artifactDir });
        images = buildOrResolveImages({ dirs, harnessIds, noCache, quiet: json });
        planned = planMatrix({
          manifest: matrix,
          repoRoot: cwd,
          packageMetadata,
          destination: dirs.artifactDir,
          artifactPath: packed.artifactPath,
          runId,
          secretEnvNames: names,
          network: containerNetwork,
          cases: caseIds,
          harnesses: harnessIds,
          home: homedir,
          env,
          cidfileDir: dirs.cidDir,
          authPath: credential.dir,
          credentialDir: credential.dir,
        });
        const descriptors = new Map(
          expandMatrix(matrix, { env, cases: caseIds, harnesses: harnessIds }).map((entry) => [entry.id, entry]),
        );
        resolved = planned.cases.map((entry) => {
          const image = images.get(entry.harness);
          if (!image) throw new PlanError(`no resolved image for harness ${entry.harness}`);
          return { entry, spec: resolveSpecImage(entry.spec, image.imageId) };
        });
        for (const { spec } of resolved) {
          assertSafeRunSpec(spec, {
            repoRoot: cwd,
            home: homedir,
            manifest: matrix,
            credentialDir: credential.dir,
            requireImageId: true,
          });
        }
        if (executeCases) {
          for (const { entry, spec } of resolved) {
            const descriptor = descriptors.get(entry.caseId);
            if (!descriptor) throw new PlanError(`plan produced an unknown case: ${entry.caseId}`);
            const command = caseCommandFor(descriptor, caseCommander) ?? productionCaseCommand(descriptor, spec, packed.sha256);
            const finalSpec = Object.freeze({
              ...spec,
              command: Object.freeze(command),
              env: Object.freeze([...spec.env, modelEnvEntry(descriptor, env)]),
            });
            assertSafeRunSpec(finalSpec, {
              repoRoot: cwd,
              home: homedir,
              manifest: matrix,
              credentialDir: credential.dir,
              requireImageId: true,
            });
            const result = executeRun(finalSpec, { label: `case ${entry.caseId}` });
            const report = parseCaseReportStdout(result.stdout);
            const summary = validateCaseReport({
              report,
              caseDescriptor: descriptor,
              containerName: spec.name,
              artifactSha256: packed.sha256,
            });
            if (!json) write(formatCaseSuccess(summary, sanitize));
            if (caseReporter) caseReporter(summary);
            executed.push({ caseId: entry.caseId, exitStatus: result.status ?? 0, spec: finalSpec, report: summary });
            executedByCase.set(entry.caseId, finalSpec);
          }
        }
      } catch (error) {
        primary = error;
      }
      // Cleanup + label sweep must prove absence before any success output.
      const finalized = finalizeLifecycle({ runId, dirs, keep: keepWorkdir, primary });
      const containerNames = resolved.map(({ spec }) => spec.name);
      const cidfilePaths = resolved.map(({ spec }) => spec.cidfile);
      const freshness = {
        containers: containerNames.length,
        uniqueContainerNames: new Set(containerNames).size,
        uniqueCidfiles: new Set(cidfilePaths).size,
        oneCasePerContainer:
          new Set(containerNames).size === containerNames.length &&
          resolved.every(({ entry, spec }) => spec.labels[LABELS.case] === entry.caseId),
      };
      if (json) {
        jsonWrite({
          mode: "run",
          runId,
          executed: executed.length > 0,
          skipped: executed.length === 0 && !executeCases ? "executeCases=false" : null,
          preflight: { cases: preflight.cases, models: preflight.models, notes: preflight.notes },
          auth: {
            mode: authMode.mode,
            providers: authMode.provider ? [authMode.provider] : [],
          },
          baseImage: resolveBaseImageInfo(matrix, env),
          artifact: { file: packed.fileName, sha256: packed.sha256, bytes: packed.bytes, path: packed.artifactPath },
          images: [...images.values()].map((entry) => ({ harnessId: entry.id, imageId: entry.imageId, ...entry.info })),
          cases: resolved.map(({ entry, spec }) => {
            // Audit the spec that was actually executed (post-adapter).
            const finalSpec = executedByCase.get(entry.caseId) ?? spec;
            return {
              id: entry.caseId,
              name: finalSpec.name,
              imageId: finalSpec.imageId,
              cidfile: finalSpec.cidfile,
              labels: { ...finalSpec.labels },
              artifactMount: finalSpec.mounts[0]?.src ?? null,
              secretEnvNames: [...finalSpec.secretNames],
              excludedSecretNames: [...finalSpec.excludedSecretNames],
              command: [...finalSpec.command],
              argv: runSpecToArgv(finalSpec),
            };
          }),
          executedCases: executed.map((entry) => ({
            caseId: entry.caseId,
            exitStatus: entry.exitStatus,
            command: [...entry.spec.command],
            argv: runSpecToArgv(entry.spec),
            report: entry.report,
          })),
          freshness,
          cleanup: {
            trackedPending: finalized.cleanup.pending.length,
            sweepMatched: finalized.sweep.matched,
            verifiedAbsent: finalized.sweep.verifiedAbsent,
          },
          warnings: missing.length ? [`allowlisted secret env not set: ${missing.join(", ")}`] : [],
        });
      } else {
        write(`lifecycle: staged context, packed once (sha256=${packed.sha256}), resolved ${images.size} immutable image ids`);
        write(`cases planned: ${resolved.length} (each mounts ${sanitize(packed.artifactPath)})`);
        if (executed.length) {
          write(`cases executed: ${executed.length} across ${freshness.uniqueContainerNames} unique containers (one case per container)`);
        } else {
          write("cases not executed (executeCases=false)");
        }
        write(
          `cleanup: verified — tracked pending ${finalized.cleanup.pending.length}, ` +
            `label sweep matched ${finalized.sweep.matched}, 0 remaining for run ${runId}`,
        );
      }
      return {
        runId,
        packed,
        images: [...images.values()],
        planned,
        executed,
        cleanup: finalized.cleanup,
        sweep: finalized.sweep,
        preflight,
        freshness,
      };
    },
  };

  return api;
}

/**
 * Phase 2 seam helper: an adapter may supply only the *in-container* command
 * for a case. The host Docker argv/execution always stays with the runner.
 */
function caseCommandFor(descriptor, caseCommander) {
  if (!caseCommander) return null;
  if (!descriptor) throw new PlanError("case commander requested for an unknown case");
  const supplied = caseCommander({ case: descriptor });
  if (supplied === null || supplied === undefined) return null;
  const command = Array.isArray(supplied) ? supplied : supplied?.command;
  if (command === null || command === undefined) {
    throw new PlanError(`case commander returned an invalid in-container command for case ${descriptor.id}`);
  }
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((token) => typeof token !== "string" || token === "" || token.includes("\n"))
  ) {
    throw new PlanError(`case commander returned an invalid in-container command for case ${descriptor.id}`);
  }
  if (command[0].startsWith("-")) {
    throw new PlanError(
      `case commander must return an in-container executable (not options) for case ${descriptor.id}`,
    );
  }
  return [...command];
}

/** Production in-container command for one case (Phase 2). */
function productionCaseCommand(descriptor, spec, artifactSha256) {
  return [
    "node",
    RUNTIME.caseEntrypoint,
    `--case=${descriptor.id}`,
    `--harness=${descriptor.harness}`,
    `--scenario=${descriptor.scenario}`,
    `--artifact-sha256=${artifactSha256}`,
    `--container-name=${spec.name}`,
  ];
}

/**
 * Required non-secret model env for the case's harness. The value comes only
 * from an explicit host env (preflight enforces presence/format); no default
 * billable model is ever chosen.
 */
function modelEnvEntry(descriptor, hostEnv) {
  const name = descriptor.harness === "claude" ? CASE_ENV.claudeModel : CASE_ENV.opencodeModel;
  const value = String(hostEnv[name] ?? "").trim();
  if (!value) {
    throw new PlanError(`${name} is required to execute case ${descriptor.id}; no default billable model is chosen`);
  }
  return { name, value };
}

function insertAfter(argv, token, index) {
  const copy = [...argv];
  copy.splice(index, 0, token);
  return copy;
}

export function parseArgs(argv) {
  const options = {
    command: null,
    caseIds: [],
    harnessIds: [],
    secretEnv: [],
    network: null,
    opencodeAuthFile: null,
    json: false,
    dryRun: false,
    keep: false,
    noBuild: false,
    noCache: false,
    help: false,
    errors: [],
  };
  const listFlags = {
    "--case": "caseIds",
    "--harness": "harnessIds",
    "--secret-env": "secretEnv",
    "--network": "network",
    "--opencode-auth-file": "opencodeAuthFile",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--list") {
      options.command ??= "list";
      continue;
    }
    if (token === "-h" || token === "--help") {
      options.help = true;
      continue;
    }
    if (token === "--json") options.json = true;
    else if (token === "--dry-run") options.dryRun = true;
    else if (token === "--keep") options.keep = true;
    else if (token === "--no-build") options.noBuild = true;
    else if (token === "--no-cache") options.noCache = true;
    else if (token.startsWith("--") && token.includes("=")) {
      const key = token.slice(0, token.indexOf("="));
      const value = token.slice(token.indexOf("=") + 1);
      applyValue(options, listFlags, key, value);
    } else if (Object.hasOwn(listFlags, token)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        options.errors.push(`${token} requires a value`);
        continue;
      }
      applyValue(options, listFlags, token, value);
      index += 1;
    } else if (token.startsWith("-")) {
      options.errors.push(`unknown option: ${token}`);
    } else if (options.command === null) {
      options.command = token;
    } else {
      options.errors.push(`unexpected argument: ${token}`);
    }
  }
  return options;
}

function applyValue(options, listFlags, key, value) {
  const field = listFlags[key];
  if (!field) {
    options.errors.push(`unknown option: ${key}`);
    return;
  }
  if (field === "network") options.network = value;
  else if (field === "opencodeAuthFile") options.opencodeAuthFile = value;
  else {
    const values = value.split(",").map((item) => item.trim()).filter(Boolean);
    if (values.length === 0) options.errors.push(`${key} requires a value`);
    else options[field].push(...values);
  }
}

export async function main(argv) {
  const options = parseArgs(argv);
  const sanitize = createHostSanitizer({});
  const write = (line) => process.stdout.write(`${line}\n`);
  const writeError = (line) => process.stderr.write(`${line}\n`);

  if (options.help || options.command === null || options.command === "help") {
    write(USAGE.trimEnd());
    return options.help || options.command === null ? 0 : 2;
  }
  if (options.errors.length) {
    for (const error of options.errors) writeError(`error: ${sanitize(error)}`);
    writeError(USAGE.trimEnd());
    return 2;
  }

  let runner = null;
  try {
    runner = createRunner({ opencodeAuthFile: options.opencodeAuthFile });
    switch (options.command) {
      case "list":
        runner.list({ json: options.json });
        break;
      case "plan":
        runner.plan({
          caseIds: options.caseIds,
          harnessIds: options.harnessIds,
          secretEnv: options.secretEnv,
          json: options.json,
          network: options.network,
        });
        break;
      case "pack":
        runner.pack({ keep: options.keep, json: options.json });
        break;
      case "build":
        runner.build({
          harnessIds: options.harnessIds,
          dryRun: options.dryRun,
          json: options.json,
          noCache: options.noCache,
          skipBuild: options.noBuild,
          keepWorkdir: options.keep,
        });
        break;
      case "smoke":
        runner.smoke({
          harnessIds: options.harnessIds,
          dryRun: options.dryRun,
          json: options.json,
          skipBuild: options.noBuild,
          keepWorkdir: options.keep,
        });
        break;
      case "auth-check":
        runner.authCheck({
          harnessIds: options.harnessIds,
          json: options.json,
          dryRun: options.dryRun,
          noCache: options.noCache,
          skipBuild: options.noBuild,
          keepWorkdir: options.keep,
        });
        break;
      case "run":
        runner.run({
          caseIds: options.caseIds,
          harnessIds: options.harnessIds,
          secretEnv: options.secretEnv,
          json: options.json,
          network: options.network,
          dryRun: options.dryRun,
          noCache: options.noCache,
          skipBuild: options.noBuild,
          keepWorkdir: options.keep,
        });
        break;
      default:
        writeError(`error: unknown command "${sanitize(options.command)}"`);
        writeError(USAGE.trimEnd());
        return 2;
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const sanitizeError = runner ? runner.sanitize : sanitize;
    writeError(sanitizeError(message));
    if (error instanceof PlanError) {
      return /Phase 2 work/.test(message) ? 2 : 1;
    }
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
