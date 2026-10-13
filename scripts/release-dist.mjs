#!/usr/bin/env node
// Phase 11 release artifact builder: turn an exact `v<version>` tag into the
// two files a GitHub Release may carry — the validated npm tarball and
// `SHA256SUMS` — without publishing anything to npm.
//
// Contract:
//   1. `RELEASE_TAG` must equal `v` plus the exact `package.json` version
//      before any other work happens (fail closed, no partial artifacts).
//   2. Before anything in `dist/` is created, removed, or listed — and before
//      either release-level fingerprint command runs — the environment is
//      scrubbed and `git` is resolved through gate-lib's `resolveExecutable`
//      to one canonical absolute executable, with the *canonical* repository
//      root as `forbiddenRoot`. A missing PATH, an empty or relative PATH
//      component, or a repository-local fake `git` is therefore refused
//      before any mutation, and the exact resolved path (plus `forbiddenRoot`)
//      is handed to both `repositoryState()` calls. `runGate` resolves its own
//      git/npm the same way; nothing here replaces that.
//   3. `dist/` must be canonically inside the repository: the repository root
//      and every existing component of the path at or below it are `lstat`ed
//      (never `stat`ed) and must be real directories — a symlink anywhere in
//      the chain would redirect the pack destination out of the work tree —
//      and `realpath(dist)` must stay inside `realpath(repository)`. The same
//      walk runs again after the directory is created, so a component that
//      appears mid-run cannot slip through.
//   4. Starting over removes only controlled generated state: regular files
//      named `SHA256SUMS`, a safe `*.tgz` artifact name, or this script's own
//      temp file. Symlinks, directories, and any other name are refused, and
//      removal is per-entry `unlink` (no removal ever follows a link).
//   5. The tarball is built by the core clean-candidate gate
//      (`runGate({ artifactDir: dist })`), i.e. packed from the validated clean
//      clone and checked there for exact name/version/filename identity.
//   6. `dist/SHA256SUMS` is written through an exclusive (`O_CREAT|O_EXCL`,
//      no-follow) temporary regular file: written, `fsync`ed, `fstat`ed,
//      `lstat`ed before the atomic `rename`, `lstat`ed again after it, then
//      read back through a no-follow descriptor and re-verified against a
//      fresh hash of the tarball.
//   7. Handoff re-validates the exact two entries, their identities, sizes,
//      and both checksums as the last thing that happens before returning.
//   8. Any failure after the pack removes only artifacts this run created and
//      only once their dev/ino/size identity is re-checked; if cleanup cannot
//      be proven the run fails closed as a `cleanup` failure instead of
//      reporting the original error alone.
//   9. The repository fingerprint (status, index digest, HEAD, root entries)
//      must be identical before and after, apart from the gitignored `dist/`
//      this script owns.
//
// The workflow transfers those two files to a separate, freshly started
// release job (no checkout, no candidate code) which attaches them with the
// built-in `gh` CLI. npm publication is Phase 12 and never happens here.

import {
  closeSync,
  constants as FS,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GateFailure,
  assertTagMatchesVersion,
  boundTail,
  expectedTarballFilename,
  formatChecksumFile,
  formatGateFailure,
  parseChecksumFile,
  resolveExecutable,
  runCommand,
  scrubEnvironment,
  sha256File,
} from "./gate-lib.mjs";
import {
  REPOSITORY,
  assertRepositoryStateUnchanged,
  readPackageMetadata,
  repositoryState,
  runGate,
} from "./clean-candidate.mjs";

export const CHECKSUM_FILENAME = "SHA256SUMS";

/** Plain artifact names only: no separators, no leading dot, no traversal. */
const SAFE_ARTIFACT_NAME = /^[0-9A-Za-z][0-9A-Za-z._~+-]*$/;
/** The only temp name this script ever creates, for stale-run recovery. */
const TEMP_NAME = /^\.[0-9A-Za-z][0-9A-Za-z._-]*\.[0-9]{1,12}\.[0-9a-f]{1,16}\.tmp$/;

function isInside(candidate, parent) {
  const child = path.resolve(candidate);
  const root = path.resolve(parent);
  return child !== root && child.startsWith(root + path.sep);
}

function lstatOrNull(target) {
  try {
    return lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new GateFailure("release", `cannot inspect ${JSON.stringify(target)}: ${error?.code ?? String(error)}`);
  }
}

function identityOf(stats) {
  return { dev: stats.dev, ino: stats.ino, size: stats.size };
}

function regularFileOrThrow(target, label) {
  const stats = lstatOrNull(target);
  if (stats === null) {
    throw new GateFailure("release", `${label} is missing: ${target}`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new GateFailure("release", `${label} is not a regular file: ${target}`);
  }
  return stats;
}

/**
 * Names this script is allowed to delete from `dist/`: its own two artifacts,
 * a stale `*.tgz` of an earlier pack, and its own temp file. Anything else in
 * the directory it does not own is never removed.
 */
function isControlledGeneratedState(name) {
  if (typeof name !== "string" || name === "") return false;
  if (name === CHECKSUM_FILENAME) return true;
  if (TEMP_NAME.test(name)) return true;
  return SAFE_ARTIFACT_NAME.test(name) && name.endsWith(".tgz");
}

/**
 * The repository's canonical (`realpath`) root. Every containment decision in
 * this script — tool resolution above all — is made against this path, never
 * against a caller-supplied spelling that a symlinked ancestor could bend.
 */
function canonicalRepositoryRoot(repository) {
  const stats = lstatOrNull(repository);
  if (stats === null || stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new GateFailure("release", `repository root is not a real directory: ${repository}`);
  }
  try {
    return realpathSync(repository);
  } catch (error) {
    throw new GateFailure("release", `cannot resolve the repository root: ${error?.code ?? String(error)}`);
  }
}

/**
 * Resolve `git` to one canonical absolute executable before any work: the
 * environment is scrubbed first, and the *canonical* repository root is the
 * forbidden root, so an empty or relative `PATH` component and a
 * repository-local fake are refused here — before `dist/` is touched, listed,
 * or emptied, and before either release-level fingerprint command runs. The
 * returned path is the only git this script executes; `runGate` continues to
 * resolve its own git/npm through the same helper.
 */
function resolveTrustedGit({ repositoryReal, env }) {
  const gitEnv = scrubEnvironment(env);
  let gitExecutable;
  try {
    gitExecutable = resolveExecutable("git", { env: gitEnv, forbiddenRoot: repositoryReal, step: "release" });
  } catch (error) {
    if (error instanceof GateFailure) throw error;
    throw new GateFailure("release", `cannot resolve a trusted git executable: ${error?.code ?? String(error)}`, [
      ["detail", "PATH must carry a real git installation outside the repository"],
    ]);
  }
  if (typeof gitExecutable !== "string" || !path.isAbsolute(gitExecutable)) {
    throw new GateFailure("release", "the resolved git executable is not a canonical absolute path");
  }
  return { gitEnv, gitExecutable };
}

/**
 * Canonically validate `dist`: the repository root must be a real directory,
 * `dist` must resolve inside it, and every existing component at or below the
 * root must be a real directory rather than a symlink. Components above the
 * repository root cannot redirect the write away from the work tree — the
 * `realpath` containment check below is what decides that — while a link
 * *inside* the tree would move `dist` (and everything packed into it) to an
 * arbitrary location.
 *
 * With `requireExisting` the whole path must already exist; without it the
 * first absent component ends the walk (those components are created by this
 * script and re-validated immediately afterwards).
 */
function assertCanonicalArtifactsPath({ repository, repositoryReal = null, dist, requireExisting = false }) {
  const canonicalRoot = repositoryReal ?? canonicalRepositoryRoot(repository);

  const root = path.resolve(repository);
  const target = path.resolve(dist);
  if (target === root) {
    throw new GateFailure("release", "the artifacts directory must not be the repository root");
  }
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new GateFailure("release", `refusing to write artifacts outside the repository: ${dist}`);
  }

  let current = root;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    const stats = lstatOrNull(current);
    if (stats === null) {
      if (requireExisting) {
        throw new GateFailure("release", `artifacts path component disappeared: ${current}`);
      }
      break;
    }
    if (stats.isSymbolicLink()) {
      throw new GateFailure("release", `refusing a symlinked path component: ${current}`, [
        ["detail", "a link anywhere under the repository root would move the pack destination out of the work tree"],
      ]);
    }
    if (!stats.isDirectory()) {
      throw new GateFailure("release", `path component is not a directory: ${current}`);
    }
  }

  if (requireExisting) {
    let distReal;
    try {
      distReal = realpathSync(target);
    } catch (error) {
      throw new GateFailure("release", `cannot resolve the artifacts directory: ${error?.code ?? String(error)}`);
    }
    if (distReal !== canonicalRoot && !isInside(distReal, canonicalRoot)) {
      throw new GateFailure("release", `the artifacts directory escapes the repository: ${distReal}`, [
        ["detail", `repository ${canonicalRoot}`],
      ]);
    }
  }
  return true;
}

/**
 * Empty `dist/` of controlled generated state. Everything is validated first
 * and only then unlinked, entry by entry, so a refused entry never leads to a
 * half-cleared directory full of unknowns.
 */
function removeControlledState(directory) {
  const stats = lstatOrNull(directory);
  if (stats === null) return { existed: false, removed: [] };
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new GateFailure("release", `refusing to reuse the artifacts path: it is not a real directory: ${directory}`);
  }

  const targets = [];
  for (const name of readdirSync(directory).sort()) {
    if (!isControlledGeneratedState(name)) {
      throw new GateFailure("release", `refusing to remove uncontrolled state from the artifacts directory: ${JSON.stringify(name)}`, [
        ["detail", "only SHA256SUMS, a safe *.tgz artifact name, or this script's own temp file may be removed"],
        ["detail", "dist/ is generated output; anything else in it must be inspected by a human first"],
      ]);
    }
    const target = path.join(directory, name);
    const entryStats = lstatOrNull(target);
    if (entryStats === null) continue;
    if (entryStats.isSymbolicLink() || !entryStats.isFile()) {
      throw new GateFailure("release", `refusing to remove a non-regular entry from the artifacts directory: ${name}`, [
        ["detail", "removal is per-entry unlink and never follows a link"],
      ]);
    }
    targets.push({ name, target });
  }

  const removed = [];
  for (const { name, target } of targets) {
    try {
      unlinkSync(target);
    } catch (error) {
      throw new GateFailure("release", `cannot remove stale artifact ${JSON.stringify(name)}: ${error?.code ?? String(error)}`);
    }
    if (lstatOrNull(target) !== null) {
      throw new GateFailure("release", `stale artifact survived removal: ${JSON.stringify(name)}`);
    }
    removed.push(name);
  }
  return { existed: true, removed };
}

/**
 * Record everything currently in `dist/` as "created by this run" — the
 * directory was provably emptied before the gate started, so any regular file
 * that appears belongs to this run. Entries that cannot be proven (symlinks,
 * directories, uncontrolled names) are returned as problems instead.
 */
function absorbDistEntries({ directory, tracked }) {
  const problems = [];
  let names;
  try {
    names = readdirSync(directory).sort();
  } catch (error) {
    return [`cannot enumerate the artifacts directory: ${error?.code ?? String(error)}`];
  }
  for (const name of names) {
    if (tracked.has(name)) continue;
    const target = path.join(directory, name);
    const stats = lstatOrNull(target);
    if (stats === null) continue;
    if (stats.isSymbolicLink() || !stats.isFile()) {
      problems.push(`${name}: not a regular file, so this run cannot prove it created it`);
      continue;
    }
    if (!isControlledGeneratedState(name)) {
      problems.push(`${name}: uncontrolled entry in the artifacts directory`);
      continue;
    }
    tracked.set(name, { path: target, ...identityOf(stats) });
  }
  return problems;
}

/**
 * Remove exactly the artifacts this run created, each only after its
 * dev/ino/size identity is re-checked against the recorded one. Returns the
 * list of reasons cleanup could not be proven (empty means proven).
 */
function cleanupDistArtifacts({ directory, tracked }) {
  const problems = absorbDistEntries({ directory, tracked });
  for (const [name, record] of tracked) {
    const stats = lstatOrNull(record.path);
    if (stats === null) continue; // already gone
    if (stats.isSymbolicLink() || !stats.isFile()) {
      problems.push(`${name}: replaced by a non-regular entry; refusing to remove something this run did not create`);
      continue;
    }
    if (stats.dev !== record.dev || stats.ino !== record.ino) {
      problems.push(`${name}: identity drifted (dev ${record.dev} ino ${record.ino} -> dev ${stats.dev} ino ${stats.ino}); refusing to remove it`);
      continue;
    }
    if (record.size !== null && stats.size !== record.size) {
      problems.push(`${name}: size drifted from ${record.size} to ${stats.size}; refusing to remove it`);
      continue;
    }
    try {
      unlinkSync(record.path);
    } catch (error) {
      problems.push(`${name}: cannot be removed (${error?.code ?? String(error)})`);
      continue;
    }
    if (lstatOrNull(record.path) !== null) {
      problems.push(`${name}: still present after removal`);
    }
  }
  try {
    const leftover = readdirSync(directory).sort();
    if (leftover.length > 0) problems.push(`unremoved entries: ${leftover.join(", ")}`);
  } catch (error) {
    problems.push(`cannot re-enumerate the artifacts directory: ${error?.code ?? String(error)}`);
  }
  return problems;
}

/**
 * Write `content` to `directory/SHA256SUMS` through an exclusive, no-follow
 * temp file: `O_CREAT|O_EXCL` refuses an existing path (including a symlink
 * already sitting there), the bytes are fsynced, the descriptor and the path
 * are identity-compared before and after the atomic rename, and the temp name
 * is tracked so a failure anywhere afterwards removes it by identity only.
 */
export function writeChecksumExclusive({ directory, content, tracked = new Map() }) {
  if (typeof content !== "string" || content === "") {
    throw new GateFailure("release", "refusing to write an empty checksum file");
  }
  const finalPath = path.join(directory, CHECKSUM_FILENAME);
  const tempName = `.${CHECKSUM_FILENAME}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const tempPath = path.join(directory, tempName);
  const noFollow = FS.O_NOFOLLOW ?? 0;

  let fd = null;
  let fdIdentity = null;
  try {
    try {
      fd = openSync(tempPath, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | noFollow, 0o644);
    } catch (error) {
      throw new GateFailure("release", `cannot create the exclusive checksum temp file: ${error?.code ?? String(error)}`);
    }
    fdIdentity = identityOf(fstatSync(fd));
    // Tracked from the first instant: if anything later fails, cleanup removes
    // this file by identity, and a *different* file at this path is never
    // touched.
    tracked.set(tempName, { path: tempPath, dev: fdIdentity.dev, ino: fdIdentity.ino, size: null });

    const buffer = Buffer.from(content, "utf8");
    let offset = 0;
    while (offset < buffer.length) {
      offset += writeSync(fd, buffer, offset, buffer.length - offset);
    }
    fsyncSync(fd);

    const written = identityOf(fstatSync(fd));
    if (written.dev !== fdIdentity.dev || written.ino !== fdIdentity.ino) {
      throw new GateFailure("release", "the checksum temp file was replaced while it was being written");
    }
    if (written.size !== buffer.length) {
      throw new GateFailure("release", `the checksum temp file holds ${written.size} bytes, expected ${buffer.length}`);
    }

    const preRename = lstatOrNull(tempPath);
    if (preRename === null || preRename.isSymbolicLink() || !preRename.isFile()) {
      throw new GateFailure("release", "the checksum temp file is not a regular file before the rename");
    }
    if (preRename.dev !== written.dev || preRename.ino !== written.ino || preRename.size !== written.size) {
      throw new GateFailure("release", "the checksum temp file on disk does not match the descriptor that wrote it");
    }
    if (lstatOrNull(finalPath) !== null) {
      throw new GateFailure("release", `refusing to replace an existing ${CHECKSUM_FILENAME} in the artifacts directory`);
    }

    renameSync(tempPath, finalPath);
    tracked.delete(tempName);
    // Tracked immediately: from this instant the final path is this run's
    // artifact, so a failure in the checks below still removes it by identity.
    tracked.set(CHECKSUM_FILENAME, { path: finalPath, ...written });

    const postRename = lstatOrNull(finalPath);
    if (postRename === null || postRename.isSymbolicLink() || !postRename.isFile()) {
      throw new GateFailure("release", `${CHECKSUM_FILENAME} is not a regular file after the rename`);
    }
    if (postRename.dev !== written.dev || postRename.ino !== written.ino || postRename.size !== written.size) {
      throw new GateFailure("release", `${CHECKSUM_FILENAME} does not carry the identity of the file that was just written`);
    }
    return { path: finalPath, ...identityOf(postRename) };
  } catch (error) {
    // Remove the temp file this run created — but only when its identity on
    // disk still matches the descriptor that created it. Anything else stays
    // tracked so the caller reports an unproven cleanup instead of deleting a
    // file it cannot prove it owns.
    const record = tracked.get(tempName);
    if (record !== undefined) {
      const stats = lstatOrNull(tempPath);
      if (stats === null) {
        tracked.delete(tempName);
      } else if (!stats.isSymbolicLink() && stats.isFile() && stats.dev === record.dev && stats.ino === record.ino) {
        try {
          unlinkSync(tempPath);
          tracked.delete(tempName);
        } catch {
          /* keep it tracked: the caller's cleanup re-tries, then fails closed */
        }
      }
    }
    if (error instanceof GateFailure) throw error;
    throw new GateFailure("release", `cannot write ${CHECKSUM_FILENAME}: ${error?.code ?? String(error)}`);
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* the descriptor is already gone; the identity checks above decide */
      }
    }
  }
}

/** Read a file through an `O_NOFOLLOW` descriptor that must match `expected`. */
function readVerifiedFile(target, expected, label) {
  let fd = null;
  try {
    fd = openSync(target, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0));
  } catch (error) {
    throw new GateFailure("release", `cannot open ${label} without following links: ${error?.code ?? String(error)}`, [
      ["file", target],
    ]);
  }
  try {
    const stats = fstatSync(fd);
    if (stats.dev !== expected.dev || stats.ino !== expected.ino || stats.size !== expected.size) {
      throw new GateFailure("release", `${label} changed between the lstat that validated it and the read`);
    }
    return readFileSync(fd, "utf8");
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

/**
 * The last thing before handoff: exactly two entries, both regular and
 * identity-stable, sizes matching what was recorded, `SHA256SUMS` parsing to
 * a single record for the tarball, and a fresh hash of every file agreeing
 * with the gate and with the checksum file.
 */
async function verifyHandoff({ directory, tarballName, gate, tracked }) {
  const entries = readdirSync(directory).sort();
  const expectedEntries = [CHECKSUM_FILENAME, tarballName].sort();
  if (entries.join("\n") !== expectedEntries.join("\n")) {
    throw new GateFailure("release", "the artifacts directory must hold exactly the tarball and the checksum file", [
      ["entries", entries.join("\n") || "(none)"],
      ["expected", expectedEntries.join("\n")],
    ]);
  }

  const tarballPath = path.join(directory, tarballName);
  const checksumPath = path.join(directory, CHECKSUM_FILENAME);
  const tarballStats = regularFileOrThrow(tarballPath, "tarball");
  const checksumStats = regularFileOrThrow(checksumPath, CHECKSUM_FILENAME);

  const recordedTarball = tracked.get(tarballName);
  if (
    recordedTarball === undefined ||
    tarballStats.dev !== recordedTarball.dev ||
    tarballStats.ino !== recordedTarball.ino ||
    tarballStats.size !== recordedTarball.size
  ) {
    throw new GateFailure("release", "the tarball identity changed after it was validated", [["file", tarballPath]]);
  }
  const recordedChecksum = tracked.get(CHECKSUM_FILENAME);
  if (
    recordedChecksum === undefined ||
    checksumStats.dev !== recordedChecksum.dev ||
    checksumStats.ino !== recordedChecksum.ino ||
    checksumStats.size !== recordedChecksum.size
  ) {
    throw new GateFailure("release", `${CHECKSUM_FILENAME} changed after it was written`, [["file", checksumPath]]);
  }

  const text = readVerifiedFile(checksumPath, identityOf(checksumStats), CHECKSUM_FILENAME);
  const parsed = parseChecksumFile(text);
  const tarballDigest = await sha256File(tarballPath);
  if (parsed.length !== 1 || parsed[0].filename !== tarballName || parsed[0].digest !== tarballDigest) {
    throw new GateFailure("release", `${CHECKSUM_FILENAME} does not verify against the tarball in the artifacts directory`, [
      ["file", boundTail(text, 512).text],
      ["recomputed", tarballDigest],
    ]);
  }
  if (tarballDigest !== gate.tarball.sha256) {
    throw new GateFailure("release", "the tarball no longer matches the gate-validated artifact", [
      ["gate", gate.tarball.sha256],
      ["dist", tarballDigest],
    ]);
  }
  const checksumDigest = await sha256File(checksumPath);
  return [
    { filename: tarballName, size: tarballStats.size, sha256: tarballDigest },
    { filename: CHECKSUM_FILENAME, size: checksumStats.size, sha256: checksumDigest },
  ];
}

/**
 * Build the release artifacts. Returns `{ tag, version, gate, artifacts }`.
 * `tag` defaults to the `RELEASE_TAG` environment variable, which is how the
 * workflow passes context (never interpolated into a command line).
 */
export async function buildReleaseArtifacts(options = {}) {
  const {
    repository = REPOSITORY,
    tag = process.env.RELEASE_TAG,
    env = process.env,
    run = runCommand,
    tmpParent = undefined,
    dist = path.join(repository, "dist"),
  } = options;

  // 1. Exact tag/version match first: a mistyped or non-semver tag must fail
  //    before anything is built or removed.
  const metadata = readPackageMetadata(repository);
  assertTagMatchesVersion(tag, metadata.version);
  const tarballName = expectedTarballFilename(metadata.name, metadata.version);

  // 2. Trusted tooling first: nothing in `dist/` is listed, removed, or
  //    created — and neither release-level fingerprint command runs — until
  //    `git` is one canonical absolute executable outside the repository. A
  //    hostile PATH fails here, with `dist/` still exactly as it was.
  const repositoryReal = canonicalRepositoryRoot(repository);
  const { gitEnv, gitExecutable } = resolveTrustedGit({ repositoryReal, env });
  const fingerprint = {
    repository,
    run,
    env: gitEnv,
    includeRootEntries: true,
    hooksDir: null,
    forbiddenRoot: repositoryReal,
    resolvedCommand: gitExecutable,
  };

  // 3. Artifacts belong under the repository's own `dist/` (gitignored), and
  //    every path component must prove that: writing through a symlink or
  //    outside the work tree could dirty or escape the repository.
  assertCanonicalArtifactsPath({ repository, repositoryReal, dist });
  const removed = removeControlledState(dist);
  mkdirSync(dist, { recursive: true });
  assertCanonicalArtifactsPath({ repository, repositoryReal, dist, requireExisting: true });

  // From here on `dist/` is empty and owned by this run: everything that
  // appears in it was created by this run and may be removed by identity.
  const tracked = new Map();
  try {
    const before = await repositoryState(fingerprint);

    // 4. The clean-candidate gate packs into `dist/` from the clean clone.
    const gate = await runGate({ repository, artifactDir: dist, env, run, tmpParent });

    const absorbed = absorbDistEntries({ directory: dist, tracked });
    if (absorbed.length > 0) {
      throw new GateFailure("release", "the gate left something unproven in the artifacts directory", [["detail", absorbed.join("\n")]]);
    }

    // 5. The tarball the gate validated must be the one sitting in `dist/`.
    const tarballPath = path.join(dist, tarballName);
    const tarballStats = regularFileOrThrow(tarballPath, "tarball");
    const tarballDigest = await sha256File(tarballPath);
    if (tarballDigest !== gate.tarball.sha256) {
      throw new GateFailure("release", "the tarball in the artifacts directory no longer matches the gate-validated artifact", [
        ["gate", gate.tarball.sha256],
        ["dist", tarballDigest],
      ]);
    }

    // 6. Exclusive, no-follow, fsynced, identity-checked, atomic rename.
    const checksums = formatChecksumFile([{ filename: tarballName, digest: tarballDigest }]);
    writeChecksumExclusive({ directory: dist, content: checksums, tracked });

    // 7. Read back, re-parse, re-hash — then do it all again as the very last
    //    thing before the result is handed to the workflow.
    await verifyHandoff({ directory: dist, tarballName, gate, tracked });

    const after = await repositoryState(fingerprint);
    assertRepositoryStateUnchanged(before, after);

    const artifacts = await verifyHandoff({ directory: dist, tarballName, gate, tracked });
    return {
      tag,
      version: metadata.version,
      gate,
      removedStale: removed.removed,
      artifacts,
    };
  } catch (error) {
    // 8. Fail closed: remove only what this run created, and only after the
    //    identity of each file is re-checked. If that cannot be proven, say so
    //    instead of reporting the original failure as though `dist/` were clean.
    const problems = cleanupDistArtifacts({ directory: dist, tracked });
    if (problems.length > 0) {
      throw new GateFailure(
        "cleanup",
        `release failed at step ${error?.step ?? "unknown"} (${error?.message ?? error}) and artifact cleanup could not be proven`,
        [["leftovers", problems.join("\n")]],
      );
    }
    throw error;
  }
}

/** Bounded, fixed-length summary: tag, gate result, and the two artifacts. */
export function formatReleaseSummary(result) {
  const lines = [`release: ready | tag ${result.tag} | version ${result.version} | candidates ${result.gate.candidates.files}`];
  for (const artifact of result.artifacts) {
    lines.push(`  ${artifact.filename} ${artifact.size} bytes sha256 ${artifact.sha256}`);
  }
  return lines.join("\n");
}

async function main() {
  const result = await buildReleaseArtifacts({ repository: REPOSITORY, env: process.env });
  process.stdout.write(`${formatReleaseSummary(result)}\n`);
}

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
      process.stderr.write(formatGateFailure(error));
      process.exitCode = 1;
    },
  );
}
