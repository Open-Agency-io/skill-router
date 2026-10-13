// Shared Phase 11 fixture guard. Every Phase-11 fixture `git add` and
// `git commit` goes through `guardedFixtureGitMutation`, which calls
// `assertFixtureOutsideRealRepository` immediately before spawning Git — one
// exported choke point per call site, so a command that skips the guard is
// obvious in review.
//
// Why this exists: a validation fixture that runs `git add`/`git commit` from
// a directory that merely *sits inside* the real work tree without its own
// `.git` is resolved by git to the real repository — staging the real index
// and committing the real HEAD. (That is the exact shape of the accidental
// `7bfd1d4` incident: a probe under an ignored, repository-local temp root,
// with `TMPDIR` pinned there, that forgot `git init`.) The guard refuses that
// shape before any git command runs, and proves the positive case instead: an
// independent repository — even one nested under an ignored repo-local temp
// root — may be committed freely, because its commits can only ever reach its
// own `.git`.
//
// Rejected: the real repository itself, any ancestor that contains it, a
// missing `.git`, a symlinked `.git`, and a file-form `.git` (a gitfile).
// Accepted: an ordinary directory `.git`, wherever the fixture lives.
//
// This module has no import-time side effects: the test runner may execute it
// as a file as well as importing it.

import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guarded fixture git mutation — the single choke point every Phase-11
 * fixture `git add` and `git commit` must go through.
 *
 * It validates the arguments, runs `assertFixtureOutsideRealRepository` for
 * *this* call site, and only then invokes the supplied runner. If the guard
 * refuses, the runner is never called, so no git process can be spawned —
 * which is exactly what a test can prove by handing in a runner that records
 * its invocations.
 *
 * Scope: mutations that require an existing repository (`add`, `commit`, and
 * other ref/config changes). `git init` deliberately stays outside it (there
 * is no `.git` to prove yet, and an init cannot reach the real index), as do
 * read-only queries (`status`, `ls-files`, `rev-parse`). Because the guard
 * runs at every call site rather than inside a shared wrapper for the whole
 * test file, a future command that skips it is obvious in review: it will be
 * the one not calling this helper.
 *
 * @param {string} fixture repository the mutation will run in
 * @param {string[]} args git arguments for this single mutation
 * @param {(args: string[]) => Promise<unknown>} run supplied runner; called at
 *   most once, and only after the guard passes
 * @returns {Promise<unknown>} the runner's result
 */
export async function guardedFixtureGitMutation(fixture, args, run) {
  if (!Array.isArray(args) || args.length === 0 || args.some((argument) => typeof argument !== "string")) {
    throw new Error("a fixture git mutation needs a non-empty array of string arguments");
  }
  if (typeof run !== "function") {
    throw new Error("a fixture git mutation needs a supplied runner");
  }
  assertFixtureOutsideRealRepository(fixture);
  return run(args);
}

/** The real repository this suite lives in (never a target of a fixture commit). */
export const REPOSITORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Assert that `fixture` is an independent git repository that cannot reach the
 * real one, then return its resolved path. Throws (fails the test) otherwise.
 *
 * The "outside the real repository" property is asserted semantically rather
 * than by a naive path prefix, because validation deliberately pins
 * `TMPDIR`/`TMP`/TEMP to an ignored, repository-local root
 * (`node_modules/…`): a fixture created there still lives inside the real work
 * tree's path, but it owns its `.git`, so it is a separate repository.
 */
export function assertFixtureOutsideRealRepository(fixture) {
  if (typeof fixture !== "string" || fixture === "") {
    throw new Error("fixture repository path is required");
  }
  let real;
  try {
    real = realpathSync(REPOSITORY);
  } catch (error) {
    throw new Error(`cannot resolve the real repository for the fixture guard: ${error?.code ?? String(error)}`);
  }
  const lexical = path.resolve(fixture);
  const candidates = new Set([lexical]);
  try {
    candidates.add(realpathSync(lexical));
  } catch {
    // An unresolved fixture path is still checked lexically below; the .git
    // requirement will refuse it anyway if it does not exist.
  }
  for (const candidate of candidates) {
    if (candidate === real) {
      throw new Error(`refusing to run git in the real repository: ${candidate}`);
    }
    if (real.startsWith(`${candidate}${path.sep}`)) {
      throw new Error(`refusing to run git from a directory that contains the real repository: ${candidate}`);
    }
  }

  let dotGit;
  try {
    dotGit = lstatSync(path.join(lexical, ".git"));
  } catch (error) {
    throw new Error(`fixture is not its own repository (no .git directory): ${lexical} (${error?.code ?? String(error)})`);
  }
  if (dotGit.isSymbolicLink()) {
    throw new Error(`fixture .git must not be a symbolic link: ${lexical}`);
  }
  if (!dotGit.isDirectory()) {
    throw new Error(`fixture .git must be an ordinary directory, not a file or special entry: ${lexical}`);
  }
  return lexical;
}
