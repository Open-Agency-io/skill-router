#!/usr/bin/env node
/**
 * In-image/in-container harness verification (dependency-free).
 *
 * Used three times:
 *   1. at `docker build` time, to prove the image really contains the pinned
 *      package version rather than merely having requested it;
 *   2. at smoke run time, inside a fresh container, to prove the installed
 *      binary reports that exact version (and that the runtime user is
 *      non-root when --expect-non-root is passed);
 *   3. at auth-check run time, inside a fresh `--network=none` container, to
 *      stage a generated dummy OpenCode auth snapshot into the tmpfs XDG data
 *      path and prove — locally, without any model request — that the pinned
 *      harness recognizes each requested provider;
 *   4. for the OpenCode v1 image only, on the version/smoke path (build-time
 *      RUN and the `--network=none` smoke run), to prove the *system* ripgrep
 *      executes without any network or download (see `verifySystemRipgrep`).
 *
 * Deliberately credential-free: the harness binary is executed with an
 * explicitly constructed environment that never forwards API keys or other
 * inherited secrets, and no network access is required. Output is a single
 * JSON line plus sanitized failure text on stderr.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const OPENCODE_AUTH_MOUNT = "/input/opencode-credential";
const OPENCODE_AUTH_LEGACY = "auth.json";
const OPENCODE_AUTH_IMPORT = "auth-import.json";
const OPENCODE_AUTH_DATA = "opencode/auth.json";

/**
 * Immutable system ripgrep contract — OpenCode v1 only.
 *
 * v1's Skill tool enumerates companion files through `Ripgrep.Service.find`,
 * whose binary resolver prefers a system `rg` and otherwise *downloads* one
 * into `Global.Path.bin`. Every writable tmpfs in this harness is `noexec`, so
 * a downloaded copy can never execute and the Skill call fails. The Debian
 * package therefore ships in the read-only rootfs of the v1 image only.
 */
const RIPGREP_BINARY = "/usr/bin/rg";
const RIPGREP_PACKAGE = "ripgrep";
const RIPGREP_REQUIRED_HARNESS = "opencode-v1";
const RIPGREP_REPORT_VALUE = "system-ok";
/** Bounded fallback when the image does not publish its own pin. */
const RIPGREP_DEFAULT_MAJOR = 13;
const RIPGREP_PROBE_FILE = "probe.txt";
const RIPGREP_PROBE_TEXT = "harmless ripgrep probe file\n";

const USAGE =
  "usage: verify-harness --package=<npm package> --version=<exact version> " +
  "--binary=<binary name> --major=<expected major> --harness=<harness id> " +
  "[--expect-non-root] [--check-opencode-auth --providers=<id,id>]";

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument "${token}"`);
    }
    const equal = token.indexOf("=");
    const key = equal === -1 ? token.slice(2) : token.slice(2, equal);
    let value = equal === -1 ? undefined : token.slice(equal + 1);

    if (key === "expect-non-root") {
      options.expectNonRoot = value === undefined || value === "" || value === "true";
      continue;
    }
    if (key === "check-opencode-auth") {
      options.checkOpencodeAuth = value === undefined || value === "" || value === "true";
      continue;
    }
    if (!["package", "version", "binary", "major", "harness", "providers"].includes(key)) {
      throw new Error(`unknown option --${key}`);
    }
    if (value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`missing value for --${key}`);
      }
      value = next;
      index += 1;
    }
    options[key] = value;
  }
  return options;
}

function fail(message) {
  process.stderr.write(`verify-harness failed: ${message}\n`);
  process.exit(1);
}

/** Environment handed to the harness binary: fixed names only, never inherited secrets. */
function harnessEnvironment() {
  const environment = {
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    TERM: "dumb",
    DISABLE_AUTOUPDATER: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return environment;
}

function globalNodeModulesRoots() {
  const roots = [];
  for (const candidate of ["/usr/local/lib/node_modules", "/usr/lib/node_modules"]) {
    if (existsSync(candidate)) roots.push(candidate);
  }
  try {
    const output = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      timeout: 60_000,
      env: harnessEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const reported = lines.at(-1);
    if (reported && reported.startsWith("/") && !roots.includes(reported)) roots.push(reported);
  } catch {
    // npm is optional for locating the root; the fixed candidates cover images.
  }
  return roots;
}

function readInstalledPackageVersion(packageName) {
  const failures = [];
  for (const root of globalNodeModulesRoots()) {
    const manifest = path.join(root, packageName, "package.json");
    if (!existsSync(manifest)) {
      failures.push(`missing ${manifest}`);
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(manifest, "utf8"));
      return { version: String(parsed.version ?? ""), manifest };
    } catch (error) {
      failures.push(`unreadable ${manifest}: ${error.code ?? "parse-error"}`);
    }
  }
  throw new Error(`installed package not found in global node_modules (${failures.join("; ")})`);
}

function binaryInstallLocation(binaryName) {
  const roots = globalNodeModulesRoots();
  const candidates = [path.join("/usr/local/bin", binaryName), ...roots.map((root) => path.join(root, binaryName))];
  for (const entry of candidates) {
    if (!existsSync(entry)) continue;
    try {
      const resolved = realpathSync(entry);
      if (roots.some((root) => resolved.startsWith(`${root}${path.sep}`))) return resolved;
    } catch {
      // Broken link or unreadable entry; keep looking.
    }
  }
  return null;
}

/**
 * Normalize harness output for structural provider probing: strip ANSI,
 * lowercase, and collapse non-alphanumerics to a single `-`, so display names
 * such as "OpenCode Go"/"OpenAI" can be matched against provider ids. Mirrors
 * the case runner's helper; a host test proves both behave identically. The
 * raw text itself is never echoed or stored.
 */
export function normalizeProviderProbeText(text) {
  return String(text ?? "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** True when the probe output structurally names the provider id. */
export function providerRecognized(output, provider) {
  const id = String(provider ?? "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) return false;
  const normalized = normalizeProviderProbeText(output);
  if (!normalized) return false;
  return (
    normalized === id || normalized.startsWith(`${id}-`) || normalized.endsWith(`-${id}`) || normalized.includes(`-${id}-`)
  );
}

/**
 * Credential-free auth validation inside the container. This runs **before**
 * any other OpenCode invocation (including `--version`), so nothing can
 * initialize the credential database before staging/import:
 *   - **v1**: copy the mounted legacy `auth.json` into the fresh tmpfs XDG
 *     data path (mode 0600, byte-identical), then `opencode auth list`;
 *   - **v2**: `opencode auth import <mounted auth-import.json> --standalone`
 *     (status 0 required), then `opencode auth list --standalone`.
 *
 * Every requested provider must be named by that listing — an empty or absent
 * listing fails. Raw stdout/stderr never leave this function. `exec` is
 * injectable for tests.
 */
/**
 * Credential-free proof that the v1 image's **system** ripgrep executes.
 *
 * Runs as the container user (uid 1000 at build and smoke time) and requires,
 * in order: a regular non-symlink root-owned `/usr/bin/rg` no more permissive
 * than 0755 and executable by every user; `rg --version` reporting the bounded
 * major (and, when the image publishes its pin, the exact Debian package
 * version); then a real `opencode debug rg files` in a fresh writable project
 * containing exactly one harmless file, which must list that file and must not
 * materialize any `rg` copy under the probe root, HOME, or XDG roots — i.e. no
 * network/download path was used. Runs are injected for tests. Failure text is
 * structural only (no paths, no file contents, no directory listings), and the
 * probe directory is always removed.
 *
 * Returns `{ ripgrep: "system-ok", ripgrepVersion }`, or `null` for harnesses
 * that do not require an image ripgrep (target isolation).
 */
export function verifySystemRipgrep({
  harness = null,
  env = process.env,
  exec = spawnSync,
  execFile = execFileSync,
  binary = RIPGREP_BINARY,
  expectedOwner = 0,
  tmpBase = null,
} = {}) {
  if (harness !== RIPGREP_REQUIRED_HARNESS) return null;

  const packageName = String(env.RIPGREP_PACKAGE || RIPGREP_PACKAGE);
  const expectedVersion = String(env.RIPGREP_VERSION ?? "");
  const expectedMajor = Number.parseInt(String(env.RIPGREP_MAJOR ?? RIPGREP_DEFAULT_MAJOR), 10);
  if (!Number.isInteger(expectedMajor) || expectedMajor < 1) {
    throw new Error("system ripgrep major bound is missing");
  }

  const link = (() => {
    try {
      return lstatSync(binary);
    } catch {
      return null;
    }
  })();
  if (!link) throw new Error("system ripgrep is missing from the image");
  if (link.isSymbolicLink() || !link.isFile()) throw new Error("system ripgrep must be a regular non-symlink file");
  if (link.uid !== expectedOwner) throw new Error("system ripgrep is not image-root owned");
  const mode = link.mode & 0o7777;
  if (mode & ~0o755) throw new Error("system ripgrep is more permissive than 0755");
  if ((mode & 0o111) !== 0o111) throw new Error("system ripgrep is not executable by every user");

  let reported;
  try {
    reported = String(
      execFile(binary, ["--version"], {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        env: harnessEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).trim();
  } catch {
    throw new Error("system ripgrep could not be executed by the runtime user");
  }
  const reportedMatch = reported.match(/^ripgrep\s+(\d+)\.(\d+)\.(\d+)/m);
  if (!reportedMatch) throw new Error("system ripgrep reported an unrecognized version");
  const ripgrepVersion = `${reportedMatch[1]}.${reportedMatch[2]}.${reportedMatch[3]}`;
  if (Number.parseInt(reportedMatch[1], 10) !== expectedMajor) {
    throw new Error(`system ripgrep reports major ${reportedMatch[1]}, expected major ${expectedMajor}`);
  }

  if (expectedVersion) {
    let installedVersion;
    try {
      installedVersion = String(
        execFile("dpkg-query", ["-W", "-f=${Version}", packageName], {
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          env: harnessEnvironment(),
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ).trim();
    } catch {
      throw new Error("system ripgrep package pin could not be read");
    }
    if (installedVersion !== expectedVersion) {
      throw new Error(`system ripgrep package reports ${installedVersion}, expected pinned ${expectedVersion}`);
    }
  }

  // Real pinned internal path: `opencode debug rg files` enumerates the probe
  // project through the same ripgrep service the Skill tool uses.
  const root = mkdtempSync(path.join(tmpBase ?? os.tmpdir(), "skill-router-rg-probe-"));
  try {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    const xdg = {
      config: path.join(root, "xdg-config"),
      data: path.join(root, "xdg-data"),
      cache: path.join(root, "xdg-cache"),
      state: path.join(root, "xdg-state"),
    };
    for (const directory of [project, home, ...Object.values(xdg)]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    writeFileSync(path.join(project, RIPGREP_PROBE_FILE), RIPGREP_PROBE_TEXT, { mode: 0o600 });

    const probe = exec("opencode", ["debug", "rg", "files"], {
      cwd: project,
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...harnessEnvironment(),
        HOME: home,
        XDG_CONFIG_HOME: xdg.config,
        XDG_DATA_HOME: xdg.data,
        XDG_CACHE_HOME: xdg.cache,
        XDG_STATE_HOME: xdg.state,
      },
    });
    if (probe.error) throw new Error(`opencode ripgrep probe failed to start (${probe.error.code ?? "spawn error"})`);
    if (probe.status !== 0) throw new Error(`opencode ripgrep enumeration exited with status ${String(probe.status)}`);
    if (!String(probe.stdout ?? "").includes(RIPGREP_PROBE_FILE)) {
      throw new Error("opencode ripgrep enumeration did not list the probe file");
    }

    const writableRoots = [
      root,
      env.HOME,
      env.XDG_DATA_HOME,
      env.XDG_CACHE_HOME,
      env.XDG_STATE_HOME,
      env.XDG_CONFIG_HOME,
    ].filter(Boolean);
    if (findDownloadedRipgrep(writableRoots)) {
      throw new Error("a ripgrep binary was materialized in writable storage");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  return { ripgrep: RIPGREP_REPORT_VALUE, ripgrepVersion };
}

/**
 * Any `rg` regular file or symlink inside writable storage means the resolver
 * fell back to a download — which can never execute on a noexec tmpfs and is
 * never accepted as proof. Only names are inspected; nothing is reported.
 */
function findDownloadedRipgrep(roots) {
  const seen = new Set();
  for (const candidate of roots) {
    const root = path.resolve(String(candidate));
    if (seen.has(root) || !existsSync(root)) continue;
    seen.add(root);
    let entries;
    try {
      entries = readdirSync(root, { recursive: true, withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name !== "rg") continue;
      if (entry.isFile() || entry.isSymbolicLink()) return true;
    }
  }
  return false;
}

export function stageAndProbeOpenCodeAuth({ providers, harness = null, env = process.env, exec = spawnSync }) {
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error("no auth providers were requested");
  }
  const requested = [...providers].map((id) => String(id).toLowerCase()).sort();
  const probeEnv = { ...env, NO_COLOR: "1" };
  let args = ["auth", "list"];

  if (harness === "opencode-v2") {
    const importFile = path.join(OPENCODE_AUTH_MOUNT, OPENCODE_AUTH_IMPORT);
    assertOwnerOnlyRegularFile(importFile, "mounted v2 credential import file");
    assertImportCarriesExactly(importFile, requested);
    const imported = exec("opencode", ["auth", "import", importFile, "--standalone"], {
      env: probeEnv,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (imported.error) throw new Error(`opencode auth import failed to start (${imported.error.code ?? "spawn error"})`);
    if (imported.status !== 0) throw new Error(`opencode auth import exited with status ${String(imported.status)}`);
    args = ["auth", "list", "--standalone"];
  } else {
    const legacyFile = path.join(OPENCODE_AUTH_MOUNT, OPENCODE_AUTH_LEGACY);
    assertOwnerOnlyRegularFile(legacyFile, "mounted legacy auth file");
    assertLegacyCarriesExactly(legacyFile, requested);
    const dataHome = env.XDG_DATA_HOME;
    if (typeof dataHome !== "string" || dataHome === "") throw new Error("XDG_DATA_HOME is not set");
    const target = path.join(dataHome, OPENCODE_AUTH_DATA);
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const bytes = readFileSync(legacyFile);
    writeFileSync(target, bytes, { mode: 0o600 });
    chmodSync(target, 0o600);
    const staged = statSync(target);
    if (!staged.isFile() || (staged.mode & 0o077) !== 0 || staged.size !== bytes.length) {
      throw new Error("staged auth file is not an owner-only byte-identical copy");
    }
  }

  const probe = exec("opencode", args, {
    env: probeEnv,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (probe.error) throw new Error(`opencode auth list failed to start (${probe.error.code ?? "spawn error"})`);
  if (probe.status !== 0) throw new Error(`opencode auth list exited with status ${String(probe.status)}`);
  const missing = requested.filter((id) => !providerRecognized(String(probe.stdout ?? ""), id));
  if (missing.length) throw new Error(`opencode did not recognize provider(s): ${missing.join(", ")}`);
  return { providers: requested, recognition: "listed" };
}

function assertOwnerOnlyRegularFile(target, label) {
  if (!existsSync(target)) throw new Error(`${label} is missing from the mount`);
  const stat = statSync(target);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${label} must be owner-only`);
}

/** The mounted legacy document must carry exactly the requested providers. */
function assertLegacyCarriesExactly(file, expected) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error("mounted legacy credential file is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("mounted legacy credential file is not a JSON object");
  }
  const ids = Object.keys(parsed).map((id) => id.toLowerCase()).sort();
  if (ids.length !== expected.length || ids.some((id, index) => id !== expected[index])) {
    throw new Error("mounted legacy credential file must carry exactly the requested providers");
  }
}

/** The generated v2 import array must carry exactly the requested providers. */
function assertImportCarriesExactly(file, expected) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error("mounted v2 credential import file is not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("mounted v2 credential import file must be an array");
  const ids = [...new Set(parsed.map((entry) => String(entry?.integrationID ?? "").toLowerCase()))].sort();
  if (ids.length !== expected.length || ids.some((id, index) => id !== expected[index])) {
    throw new Error("mounted v2 credential import file must carry exactly the requested providers");
  }
}

function binaryVersion(binaryName) {
  let stdout = "";
  let stderr = "";
  try {
    stdout = execFileSync(binaryName, ["--version"], {
      encoding: "utf8",
      timeout: 120_000,
      env: harnessEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    stderr = String(error.stderr ?? "").trim();
    const status = error.status === undefined ? "no exit status" : `exit status ${error.status}`;
    throw new Error(`"${binaryName} --version" failed (${status})${stderr ? `: ${stderr.slice(0, 500)}` : ""}`);
  }
  return stdout.trim();
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    process.exit(2);
    return;
  }

  for (const key of ["package", "version", "binary", "major", "harness"]) {
    if (!options[key]) {
      process.stderr.write(`missing --${key}\n${USAGE}\n`);
      process.exit(2);
      return;
    }
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(options.harness)) {
    process.stderr.write(`--harness must be a lowercase matrix harness id\n${USAGE}\n`);
    process.exit(2);
    return;
  }
  if (process.env.HARNESS_ID && process.env.HARNESS_ID !== options.harness) {
    fail(`image HARNESS_ID "${process.env.HARNESS_ID}" does not match requested harness "${options.harness}"`);
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (options.expectNonRoot && uid === 0) {
    fail("expected a non-root runtime user but the container is running as uid 0");
  }

  /**
   * Credential staging/import runs FIRST: nothing else in this verifier may
   * invoke the harness binary before credentials are in place, so no OpenCode
   * invocation can initialize the credential database against an empty data
   * root. Failure text is structural only (no paths, no CLI output, no values).
   */
  let authProviders = [];
  let authRecognition = null;
  if (options.checkOpencodeAuth) {
    const requested = String(options.providers ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (requested.length === 0) {
      process.stderr.write(`--check-opencode-auth requires --providers\n${USAGE}\n`);
      process.exit(2);
      return;
    }
    try {
      const staged = stageAndProbeOpenCodeAuth({ providers: requested, harness: options.harness });
      authProviders = staged.providers;
      authRecognition = staged.recognition;
    } catch (error) {
      fail(error.message);
      return;
    }
  }

  let installed;
  try {
    installed = readInstalledPackageVersion(options.package);
  } catch (error) {
    fail(error.message);
    return;
  }
  if (installed.version !== options.version) {
    fail(`package ${options.package} reports version ${installed.version}, expected exact version ${options.version}`);
  }

  const resolved = binaryInstallLocation(options.binary);
  if (!resolved) {
    fail(`binary "${options.binary}" was not found inside the image's global node_modules`);
  }

  let reported;
  try {
    reported = binaryVersion(options.binary);
  } catch (error) {
    fail(error.message);
    return;
  }
  const match = reported.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  if (!match) {
    fail(`binary "${options.binary}" reported an unrecognized version: ${reported.slice(0, 200)}`);
  }
  if (match[0] !== options.version) {
    fail(`binary "${options.binary}" reports ${match[0]}, expected exact version ${options.version}`);
  }
  const reportedMajor = Number.parseInt(match[0].split(".")[0], 10);
  const expectedMajor = Number.parseInt(options.major, 10);
  if (!Number.isInteger(expectedMajor) || reportedMajor !== expectedMajor) {
    fail(`binary "${options.binary}" reports major ${reportedMajor}, expected major ${options.major}`);
  }
  if (Number.parseInt(installed.version.split(".")[0], 10) !== expectedMajor) {
    fail(`package ${options.package} major does not match expected major ${options.major}`);
  }

  /**
   * System ripgrep proof: OpenCode v1 only, and only on the version/smoke
   * path. The auth-check seam publishes an audited exact field set, so it does
   * not run there; every other v1 verification (build-time RUN and the
   * `--network=none` smoke run) proves the system ripgrep executes with no
   * network and no download. Non-v1 images require nothing here.
   */
  let ripgrepVerdict = null;
  if (options.harness === RIPGREP_REQUIRED_HARNESS && !options.checkOpencodeAuth) {
    try {
      ripgrepVerdict = verifySystemRipgrep({ harness: options.harness });
    } catch (error) {
      fail(error.message);
      return;
    }
  }

  // Optional credential-free auth validation ran before any harness binary
  // invocation (see above), so its verdicts are attached to the report here.

  const report = {
    ok: true,
    harnessId: options.harness,
    package: options.package,
    packageVersion: installed.version,
    binary: options.binary,
    binaryVersion: match[0],
    major: reportedMajor,
    uid,
    nonRoot: uid !== 0,
    platform: {
      os: process.platform,
      arch: process.arch,
      node: process.version,
    },
  };
  if (options.checkOpencodeAuth) {
    report.providers = authProviders;
    report.recognition = authRecognition;
    report.auth = { mode: "snapshot" };
  }
  if (ripgrepVerdict) {
    report.ripgrep = ripgrepVerdict.ripgrep;
    report.ripgrepVersion = ripgrepVerdict.ripgrepVersion;
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) main();
