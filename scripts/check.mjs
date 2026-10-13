#!/usr/bin/env node
// Release gate for development and CI: syntax -> isolated runtime imports ->
// CLI bootstrap. Node >= 20, ESM, built-ins only, no network access.
//
// The checker never executes mutating CLI commands and never touches the real
// home, Claude, or XDG directories: every child process runs with a private
// HOME/CLAUDE_CONFIG_DIR/XDG_CONFIG_HOME/TMPDIR and cwd inside one
// checker-owned temporary root that is removed in a finally block.
//
// Sandbox integrity: the sandbox root and every isolation directory are
// fingerprinted at creation (ordinary-directory check plus dev:ino identity on
// POSIX). Every scan re-verifies them with lstat (never stat, never following
// links) and treats missing paths, wrong types, symlinks, identity drift, or
// any lstat/readdir error as a finding — an observation failure is never
// reported as clean. Documented limits: where inode identity is unavailable
// (Windows, or filesystems reporting ino <= 0) the check degrades to
// "exact ordinary directory, not a link", so a same-path replacement by a
// fresh empty directory cannot be distinguished on those platforms.
//
// Process trees: checked children are spawned detached (own process group) on
// POSIX so a timeout escalates SIGTERM -> SIGKILL against the child's group
// only, never the checker's own group. On Windows the forced step uses an
// awaited, bounded `taskkill /PID <pid> /T /F` with a direct-child kill
// fallback. Lifecycle invariant: runChild never settles any spawned
// execution until a bounded residual tree-termination step has completed —
// after a normal close (success or failure) and again at grace expiry on
// timeout, where a direct close/exit records the result but must not settle
// or cancel the grace. Documented limits: deliberately re-daemonized or
// new-session descendants are outside the tree and may survive; ordinary
// inherited descendants do not. On Windows, once the direct child has
// exited, taskkill cannot enumerate orphaned descendants — the checker
// confirms the root is gone, records that limit in the tree note, and fails
// closed (treeUnconfirmed) whenever the root or tree kill cannot be
// confirmed.

import { spawn } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const ISOLATION_DIRS = ["home", "claude", "xdg", "tmp", "cwd"];
const CHILD_TIMEOUT_MS = 30_000;
const TIMEOUT_KILL_GRACE_MS = 750;
const RESIDUAL_GRACE_MS = 100;
const TASKKILL_TIMEOUT_MS = 3000;
const WINDOWS_FALLBACK_WAIT_MS = 150;
const WINDOWS_FALLBACK_RETRIES = 4;
const CLEANUP_MAX_DEPTH = 16;
const CLEANUP_MAX_ENTRIES = 1000;
const MAX_CHILD_OUTPUT = 64 * 1024;
const EXCERPT_LINES = 6;
const EXCERPT_LINE = 160;
const EXCERPT_TOTAL = 900;
const DEFAULT_PATH_LIMIT = 300;

class CheckFailure extends Error {
  constructor(phase, file, details) {
    super(`check failed in ${phase}${file ? `: ${file}` : ""}`);
    this.name = "CheckFailure";
    this.phase = phase;
    this.file = file;
    this.details = details;
  }
}

function fail(phase, file, details) {
  throw new CheckFailure(phase, file, details);
}

// Strip terminal control sequences, then render any residual control byte as
// printable text so failure output can never smuggle escape codes to a tty.
function sanitize(text) {
  const withoutSequences = String(text)
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)?/g, "")
    .replace(/\u001B[@-Z\\-_]/g, "");
  return withoutSequences.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g,
    (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

function bounded(text, limit = DEFAULT_PATH_LIMIT) {
  const clean = sanitize(text);
  return clean.length > limit ? `${clean.slice(0, limit)}...` : clean;
}

function excerpt(text, truncated = false) {
  const clean = sanitize(text ?? "");
  if (clean === "") return truncated ? "... (child output truncated)" : "";
  const lines = clean.split("\n");
  const kept = [];
  let budget = EXCERPT_TOTAL;
  let clipped = truncated;
  for (const line of lines) {
    if (kept.length >= EXCERPT_LINES) {
      clipped = true;
      break;
    }
    let value = line.length > EXCERPT_LINE ? `${line.slice(0, EXCERPT_LINE)}...` : line;
    if (value.length > budget) {
      kept.push(`${value.slice(0, Math.max(0, budget))}...`);
      clipped = true;
      break;
    }
    budget -= value.length + 1;
    kept.push(value);
  }
  const body = kept.join("\n");
  return clipped ? `${body}\n... (truncated)` : body;
}

function formatFailure(failure) {
  const lines = ["check: fail", `  phase: ${bounded(failure.phase, 60)}`];
  if (failure.file) lines.push(`  file: ${bounded(failure.file)}`);
  for (const [label, text, truncated] of failure.details ?? []) {
    const body = excerpt(text, truncated);
    if (body === "") continue;
    lines.push(`  ${bounded(label, 60)}:`);
    for (const line of body.split("\n")) lines.push(`    ${line}`);
  }
  return `${lines.join("\n")}\n`;
}

// Deterministic, shell-glob-free enumeration of direct children only.
function enumerate(directory, extension) {
  let entries;
  try {
    entries = readdirSync(path.join(repository, directory), { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => !entry.isDirectory() && entry.name.endsWith(extension))
    .map((entry) => entry.name)
    .sort()
    .map((name) => `${directory}/${name}`);
}

function absolute(file) {
  return path.join(repository, ...file.split("/"));
}

function readPackageVersion() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path.join(repository, "package.json"), "utf8"));
  } catch (error) {
    fail("setup", "package.json", [["detail", `unable to read package.json: ${error?.message ?? error}`]]);
  }
  if (typeof parsed?.version !== "string" || parsed.version === "") {
    fail("setup", "package.json", [["detail", "package.json has no version"]]);
  }
  return parsed.version;
}

function errorCode(error) {
  return error?.code ?? error?.message ?? "unknown error";
}

function describeType(stat) {
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  if (stat.isSocket?.()) return "socket";
  if (stat.isFIFO?.()) return "fifo";
  if (stat.isCharacterDevice?.()) return "character-device";
  if (stat.isBlockDevice?.()) return "block-device";
  return "special";
}

// dev:ino identity on POSIX; null where inode semantics are absent (documented
// in the header: type-only verification there, no drift detection).
function inodeIdentity(stat) {
  if (process.platform === "win32") return null;
  if (typeof stat.ino !== "number" || !Number.isFinite(stat.ino) || stat.ino <= 0) return null;
  if (typeof stat.dev !== "number" || !Number.isFinite(stat.dev)) return null;
  return `${stat.dev}:${stat.ino}`;
}

// lstat only: never follows links, never trusts a cached type.
function observeDirectory(absolutePath) {
  let stat;
  try {
    stat = lstatSync(absolutePath);
  } catch (error) {
    return { problem: `lstat failed: ${errorCode(error)}` };
  }
  if (stat.isSymbolicLink()) return { problem: "not an ordinary directory: symlink" };
  if (!stat.isDirectory()) return { problem: `not an ordinary directory: ${describeType(stat)}` };
  return { identity: inodeIdentity(stat) };
}

function captureExpected(absolutePath, label) {
  const observed = observeDirectory(absolutePath);
  if (observed.problem) {
    fail("setup", null, [["detail", `sandbox isolation path ${label} is unusable: ${observed.problem}`]]);
  }
  return { label, absolute: absolutePath, identity: observed.identity };
}

function createSandbox(root) {
  const dirs = {};
  for (const name of ISOLATION_DIRS) {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    dirs[name] = dir;
  }
  const expected = [captureExpected(root, ".")];
  for (const name of ISOLATION_DIRS) expected.push(captureExpected(dirs[name], name));
  return {
    root,
    cwd: dirs.cwd,
    expected,
    env: {
      ...process.env,
      HOME: dirs.home,
      USERPROFILE: dirs.home,
      CLAUDE_CONFIG_DIR: dirs.claude,
      XDG_CONFIG_HOME: dirs.xdg,
      TMPDIR: dirs.tmp,
      TMP: dirs.tmp,
      TEMP: dirs.tmp,
      SKILL_ROUTER_HOME: dirs.home,
    },
  };
}

// Re-verify one recorded path: present, still an ordinary directory, same
// identity. Any problem is a finding; a false return means "do not descend".
function verifyExpected(entry, findings) {
  const observed = observeDirectory(entry.absolute);
  if (observed.problem) {
    findings.push({ path: entry.label, kind: "entry", problem: observed.problem });
    return false;
  }
  if (entry.identity !== null && observed.identity !== entry.identity) {
    findings.push({
      path: entry.label,
      kind: "entry",
      problem: `identity drift: ${entry.identity} -> ${observed.identity ?? "unobservable"}`,
    });
    return false;
  }
  return true;
}

function observationFailure(findings, at, operation, error) {
  findings.push({ path: at, kind: "entry", problem: `${operation} failed: ${errorCode(error)}` });
}

// Recurse only into ordinary directories; lstat before every decision; never
// follow a symlink; never treat an observation error as clean.
function scanInside(directory, relative, findings) {
  let names;
  try {
    names = readdirSync(directory).sort();
  } catch (error) {
    observationFailure(findings, relative, "readdir", error);
    return;
  }
  for (const name of names) {
    const absolutePath = path.join(directory, name);
    const child = `${relative}/${name}`;
    let stat;
    try {
      stat = lstatSync(absolutePath);
    } catch (error) {
      observationFailure(findings, child, "lstat", error);
      continue;
    }
    if (stat.isSymbolicLink()) {
      findings.push({ path: child, kind: "symlink", problem: "unexpected symlink (not followed)" });
      continue;
    }
    if (stat.isDirectory()) {
      findings.push({ path: child, kind: "directory", problem: "unexpected directory" });
      scanInside(absolutePath, child, findings);
      continue;
    }
    findings.push({ path: child, kind: describeType(stat), problem: "unexpected entry" });
  }
}

// A full scan: the root must still be the directory we created, every
// isolation directory must still exist as the directory we created (whether or
// not it still appears in the listing), and anything else under the root is a
// finding. Diagnostics stay sandbox-relative and never read a link target or
// an external directory.
function scanSandbox(sandbox) {
  const findings = [];
  const rootEntry = sandbox.expected.find((entry) => entry.label === ".");
  if (!rootEntry || !verifyExpected(rootEntry, findings)) return findings;

  let names;
  try {
    names = readdirSync(sandbox.root).sort();
  } catch (error) {
    observationFailure(findings, ".", "readdir", error);
    return findings;
  }
  const listed = new Set(names);
  for (const entry of sandbox.expected) {
    if (entry.label === ".") continue;
    if (verifyExpected(entry, findings) && listed.has(entry.label)) {
      scanInside(entry.absolute, entry.label, findings);
    }
  }
  for (const name of names) {
    if (ISOLATION_DIRS.includes(name)) continue;
    const absolutePath = path.join(sandbox.root, name);
    let stat;
    try {
      stat = lstatSync(absolutePath);
    } catch (error) {
      observationFailure(findings, name, "lstat", error);
      continue;
    }
    findings.push({
      path: name,
      kind: describeType(stat),
      problem: "unexpected top-level entry (not followed)",
    });
  }
  return findings;
}

function assertSandbox(sandbox, phase, file) {
  const findings = scanSandbox(sandbox);
  if (findings.length === 0) return;
  const shown = findings
    .slice(0, 3)
    .map((finding) => `${finding.kind} ${bounded(finding.path, 160)} (${bounded(finding.problem, 120)})`);
  if (findings.length > 3) shown.push(`(+${findings.length - 3} more)`);
  fail(phase, file, [
    [
      "detail",
      `unexpected filesystem effect in sandbox (${findings.length} entr${findings.length === 1 ? "y" : "ies"}): ${shown.join(", ")}`,
    ],
  ]);
}

// Bounded, symlink-refusing fallback for a root that is no longer removable by
// the plain recursive rm (e.g. an unreadable sandbox subdirectory). Depth- and
// entry-capped; refuses oversized trees; never follows a link; chmod applies
// only to ordinary directories inside the checker-owned tree.
function removeTreeWithoutFollowing(directory, depth) {
  if (depth > CLEANUP_MAX_DEPTH) return;
  let names;
  try {
    names = readdirSync(directory);
  } catch (error) {
    if ((error?.code === "EACCES" || error?.code === "EPERM") && depth > 0) {
      try {
        chmodSync(directory, 0o700);
        names = readdirSync(directory);
      } catch {
        return;
      }
    } else {
      return;
    }
  }
  if (names.length > CLEANUP_MAX_ENTRIES) return;
  for (const name of names) {
    const at = path.join(directory, name);
    let stat;
    try {
      stat = lstatSync(at);
    } catch {
      continue;
    }
    if (stat.isDirectory()) removeTreeWithoutFollowing(at, depth + 1);
    else {
      try {
        unlinkSync(at);
      } catch {
        // best effort
      }
    }
  }
  try {
    rmdirSync(directory);
  } catch {
    // best effort
  }
}

// Never traverses an attacker-supplied symlink: a wrong-type root is removed
// with a single unlink (the link only, never its target); a drifted ordinary
// directory gets the bounded fallback above; the verified root uses the
// recursive rm (Node's recursive rm unlinks symlinks without following them),
// with the bounded fallback if the rm cannot complete (e.g. mode-000 child).
function cleanupSandbox(root, expectedIdentity) {
  let stat;
  try {
    stat = lstatSync(root);
  } catch {
    return; // already gone
  }
  if (!stat.isDirectory()) {
    try {
      unlinkSync(root);
    } catch {
      // best effort
    }
    return;
  }
  const identity = inodeIdentity(stat);
  if (expectedIdentity === null || identity === expectedIdentity) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      // fall through to the bounded no-follow walk
    }
    removeTreeWithoutFollowing(root, 0);
    return;
  }
  removeTreeWithoutFollowing(root, 0);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// POSIX: children are detached group leaders, so -pid targets only the
// child's own group (never the checker's). Windows: no process groups, so
// signals degrade to a direct-child kill; the tree kill lives in
// windowsTreeKill.
function killProcessTree(child, signal) {
  const pid = child?.pid;
  if (!Number.isInteger(pid) || pid <= 1) return;
  if (process.platform === "win32") {
    try {
      child.kill();
    } catch {
      // already gone
    }
    return;
  }
  const ownGroup = typeof process.getpgrp === "function" ? process.getpgrp() : -1;
  if (pid === process.pid || pid === ownGroup) return; // never signal our own group
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
}

function destroyStreams(child) {
  try {
    child.stdout?.destroy();
  } catch {
    // best effort
  }
  try {
    child.stderr?.destroy();
  } catch {
    // best effort
  }
}

function defaultSpawnTaskkill(pid) {
  const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  killer.unref?.();
  return killer;
}

// Bounded taskkill attempt: resolves on the taskkill child's close/error or a
// hard internal timeout that kills the taskkill child itself. No timer or
// handle survives the resolution.
function runTaskkill(pid, timeoutMs, spawnTaskkill) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const done = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    let killer = null;
    try {
      killer = spawnTaskkill(pid);
    } catch (error) {
      resolve({ code: null, timedOut: false, spawnError: error });
      return;
    }
    timer = setTimeout(() => {
      try {
        killer?.kill?.();
      } catch {
        // best effort
      }
      done({ code: null, timedOut: true, spawnError: null });
    }, timeoutMs);
    killer?.on?.("error", (error) => done({ code: null, timedOut: false, spawnError: error }));
    killer?.on?.("close", (code) => done({ code, timedOut: false, spawnError: null }));
  });
}

// Windows residual tree termination. Awaited and bounded; a failed or hung
// taskkill falls back to killing the direct child and probing, with bounded
// retries. Fails closed (confirmed: false) if the root survives both steps.
// Documented limit: after the root exits, taskkill /T cannot enumerate
// orphaned Windows descendants; the note records that honestly.
async function windowsTreeKill(pid, child, deps = {}) {
  const wait = deps.wait ?? sleep;
  const probeAlive = deps.probeAlive ?? pidAlive;
  const taskkillTimeoutMs = deps.taskkillTimeoutMs ?? TASKKILL_TIMEOUT_MS;
  const spawnTaskkill = deps.spawnTaskkill ?? defaultSpawnTaskkill;

  const attempt = await runTaskkill(pid, taskkillTimeoutMs, spawnTaskkill);
  if (!attempt.timedOut && attempt.spawnError === null && attempt.code === 0) {
    return { confirmed: true, note: "taskkill /T /F terminated the process tree" };
  }
  try {
    child?.kill?.();
  } catch {
    // already gone
  }
  for (let retries = 0; retries < WINDOWS_FALLBACK_RETRIES && probeAlive(pid); retries += 1) {
    await wait(WINDOWS_FALLBACK_WAIT_MS);
  }
  if (probeAlive(pid)) {
    return { confirmed: false, note: `pid ${pid} survived taskkill and the direct-child kill (fail closed)` };
  }
  return {
    confirmed: true,
    note: "direct-child fallback terminated the root; Windows cannot enumerate orphaned descendants after root exit (documented limit)",
  };
}

// Residual process-tree termination that must run before every settle.
// POSIX: force (timeout) sends SIGKILL to the child's own group immediately;
// normal close sends SIGTERM, waits a bounded grace only while members remain,
// then force-kills. After the detached leader exits, -pid still reaches
// surviving same-group descendants. Windows: awaited, bounded tree kill.
async function terminateResidualTree(child, options = {}) {
  const pid = child?.pid;
  if (!Number.isInteger(pid) || pid <= 1) {
    return { confirmed: true, note: "no pid to terminate" };
  }
  if (process.platform === "win32") return windowsTreeKill(pid, child, options.deps ?? {});

  const ownGroup = typeof process.getpgrp === "function" ? process.getpgrp() : -1;
  if (pid === process.pid || pid === ownGroup) {
    return { confirmed: true, note: "refused to signal the checker's own process group" };
  }
  if (options.force === true) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
    return { confirmed: true, note: "process group force-terminated (SIGKILL)" };
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // already gone
  }
  const wait = options.deps?.wait ?? sleep;
  if (!groupAlive(pid)) return { confirmed: true, note: "process group empty" };
  await wait(RESIDUAL_GRACE_MS);
  if (groupAlive(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
    return { confirmed: true, note: "residual group members force-terminated (SIGKILL)" };
  }
  return { confirmed: true, note: "residual group members exited on SIGTERM" };
}

// Lifecycle invariant: a spawned execution never settles until the bounded
// residual tree termination has completed (the only exception is a spawn
// error that produced no valid pid). On timeout, a direct close/exit only
// records the result; settlement happens at grace expiry after the forced
// tree kill, so a SIGTERM-ignoring same-group descendant cannot survive a
// compliant direct child.
function runChild(args, sandbox) {
  return new Promise((resolve) => {
    const stdout = { value: "", truncated: false };
    const stderr = { value: "", truncated: false };
    let timedOut = false;
    let forcedKill = false;
    let settled = false;
    let exitRecord = null;
    let cleanupPromise = null;
    let timeoutTimer = null;
    let graceTimer = null;

    const collect = (sink) => (chunk) => {
      if (sink.value.length >= MAX_CHILD_OUTPUT) {
        sink.truncated = true;
        return;
      }
      const remaining = MAX_CHILD_OUTPUT - sink.value.length;
      if (chunk.length > remaining) {
        sink.truncated = true;
        sink.value += chunk.subarray(0, remaining).toString("utf8");
      } else {
        sink.value += chunk.toString("utf8");
      }
    };

    const child = spawn(process.execPath, args, {
      cwd: sandbox.cwd,
      env: sandbox.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const finishSettle = (tree) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({
        code: exitRecord?.code ?? null,
        signal: exitRecord?.signal ?? null,
        spawnError: exitRecord?.spawnError ?? null,
        timedOut,
        forcedKill,
        treeCleanup: tree ?? null,
        treeUnconfirmed: tree ? tree.confirmed === false : false,
        stdout: stdout.value,
        stderr: stderr.value,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    };

    // Runs (once) the residual tree termination, then settles with its outcome.
    const cleanupThenSettle = (force) => {
      if (!cleanupPromise) {
        cleanupPromise = terminateResidualTree(child, { force }).catch(() => ({
          confirmed: false,
          note: "residual tree termination failed (fail closed)",
        }));
      }
      cleanupPromise.then(finishSettle);
    };

    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => {
      if (settled) return;
      if (!exitRecord) exitRecord = { code: null, signal: null, spawnError: error };
      const pid = child.pid;
      if (!Number.isInteger(pid) || pid <= 1) {
        finishSettle({ confirmed: true, note: "spawn error without a pid" });
        return;
      }
      cleanupThenSettle(true);
    });
    child.on("exit", (code, signal) => {
      if (settled || exitRecord) return;
      exitRecord = { code, signal, spawnError: null };
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (!exitRecord) exitRecord = { code, signal, spawnError: null };
      if (timedOut) return; // timeout settles only at grace expiry
      cleanupThenSettle(false);
    });

    timeoutTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killProcessTree(child, "SIGTERM");
      graceTimer = setTimeout(() => {
        if (settled) return;
        forcedKill = true;
        destroyStreams(child);
        cleanupThenSettle(true);
      }, TIMEOUT_KILL_GRACE_MS);
    }, CHILD_TIMEOUT_MS);
  });
}

function childFailed(result) {
  return Boolean(result.spawnError || result.timedOut || result.signal || result.code !== 0 || result.treeUnconfirmed);
}

function exitDetail(label, result) {
  const treeNote = result.treeCleanup ? ` [tree: ${result.treeCleanup.note}]` : "";
  if (result.spawnError) return `${label} could not start node: ${result.spawnError.message}${treeNote}`;
  if (result.timedOut) {
    const direct = result.signal
      ? `signal ${result.signal}`
      : result.code !== null && result.code !== undefined
        ? `code ${result.code}`
        : "no direct exit";
    return `${label} timed out after ${CHILD_TIMEOUT_MS}ms (process tree terminated${result.forcedKill ? ", forced kill" : ""}; direct child ${direct})${treeNote}`;
  }
  if (result.treeUnconfirmed) return `${label} exited but residual process-tree termination is unconfirmed${treeNote}`;
  if (result.signal) return `${label} terminated by signal ${result.signal}${treeNote}`;
  return `${label} exited with code ${result.code}${treeNote}`;
}

async function syntaxPhase(files, sandbox) {
  for (const file of files) {
    const result = await runChild(["--check", absolute(file)], sandbox);
    if (childFailed(result)) {
      fail("syntax", file, [
        ["detail", exitDetail("node --check", result)],
        ["stderr", result.stderr, result.stderrTruncated],
        ["stdout", result.stdout, result.stdoutTruncated],
      ]);
    }
  }
}

async function importsPhase(files, sandbox) {
  for (const file of files) {
    const specifier = pathToFileURL(absolute(file)).href;
    const script = `await import(${JSON.stringify(specifier)});\nprocess.exit(0);\n`;
    const result = await runChild(["--input-type=module", "--eval", script], sandbox);
    if (childFailed(result)) {
      fail("imports", file, [
        ["detail", exitDetail("runtime import", result)],
        ["stderr", result.stderr, result.stderrTruncated],
        ["stdout", result.stdout, result.stdoutTruncated],
      ]);
    }
    assertSandbox(sandbox, "side-effect", file);
  }
}

async function cliPhase(file, version, sandbox) {
  const label = `${file} --version`;
  const expected = `${version}\n`;
  const result = await runChild([absolute(file), "--version"], sandbox);
  if (childFailed(result)) {
    fail("cli", file, [
      ["detail", exitDetail(label, result)],
      ["stderr", result.stderr, result.stderrTruncated],
      ["stdout", result.stdout, result.stdoutTruncated],
    ]);
  }
  if (result.stderr !== "") {
    fail("cli", file, [
      ["detail", `${label} must write nothing to stderr`],
      ["stderr", result.stderr, result.stderrTruncated],
      ["stdout", result.stdout, result.stdoutTruncated],
    ]);
  }
  if (result.stdout !== expected) {
    fail("cli", file, [
      ["detail", `${label} must print exactly <${version}> plus a newline`],
      ["stdout", result.stdout, result.stdoutTruncated],
      ["stderr", result.stderr, result.stderrTruncated],
    ]);
  }
  assertSandbox(sandbox, "side-effect", file);
}

async function main() {
  const version = readPackageVersion();
  const sources = enumerate("src", ".js");
  const scripts = enumerate("scripts", ".mjs");
  const sandboxRoot = mkdtempSync(path.join(tmpdir(), "skill-router-check-"));
  let sandbox = null;
  try {
    sandbox = createSandbox(sandboxRoot);

    await syntaxPhase([...sources, ...scripts], sandbox);

    const importFiles = sources.filter((file) => file !== "src/cli.js");
    await importsPhase(importFiles, sandbox);

    await cliPhase("src/cli.js", version, sandbox);

    assertSandbox(sandbox, "side-effect", null);

    process.stdout.write(
      `check: ok | syntax ${sources.length + scripts.length} (src ${sources.length}, scripts ${scripts.length}) | imports ${importFiles.length} | cli --version ${version} | sandbox clean\n`,
    );
  } finally {
    const rootIdentity = sandbox?.expected.find((entry) => entry.label === ".")?.identity ?? null;
    cleanupSandbox(sandboxRoot, rootIdentity);
  }
}

// Test seam for the unexecuted-on-this-host Windows path: tests import these
// internals and inject fakes; there is no environment or flag that can reach
// or weaken them in a real run.
export const lifecycleInternals = {
  runTaskkill,
  windowsTreeKill,
  terminateResidualTree,
  TASKKILL_TIMEOUT_MS,
  CHILD_TIMEOUT_MS,
  TIMEOUT_KILL_GRACE_MS,
};

// Run only when invoked as a script (never on import), so the test file can
// load the seam without executing the gate.
function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return path.resolve(entry) === self;
  }
}

if (invokedDirectly()) {
  main().then(
    () => {
      process.exitCode = 0;
    },
    (error) => {
      if (error instanceof CheckFailure) {
        process.stderr.write(formatFailure(error));
      } else {
        process.stderr.write(formatFailure(new CheckFailure("setup", null, [["detail", error?.stack ?? String(error)]])));
      }
      process.exitCode = 1;
    },
  );
}
