/**
 * Shared public identifier contract for skill-router.
 *
 * A portable ID is the only identifier form that may cross module boundaries
 * as a skill ID, a workflow ID, or an alias target: exactly ASCII lowercase
 * letters and digits separated by single hyphens, 1..64 characters, compared
 * exactly. There is no normalization and no case folding, so the grammar is
 * the security boundary: an accepted ID can never contain path separators,
 * control characters, whitespace, or prototype-polluting punctuation.
 * Exactly one value, "skill-router", is reserved for the router itself.
 *
 * Note on PORTABLE_ID: JavaScript's `$` anchor also matches immediately
 * before a trailing newline, so `PORTABLE_ID.test("abc\n")` is true. The
 * exported regex documents the grammar; classifyId() is the enforcement
 * entry point and additionally rejects anything outside [a-z0-9-].
 *
 * Diagnostics produced here are fixed and bounded: they never echo the value
 * under validation. Callers pass labels they control (for example
 * "skills key"); an untrusted value may only enter a label after
 * classifyId() has accepted it.
 */

export const PORTABLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_ID_LENGTH = 64;
export const RESERVED_ID = "skill-router";

/** Reason codes distinguish why a value is not a portable ID, without it. */
export const ID_PROBLEMS = Object.freeze(["type", "empty", "length", "grammar", "reserved"]);

const NON_PORTABLE_CHARACTERS = /[^a-z0-9-]/;

/**
 * Classify why a value fails the portable ID contract, or null when it is a
 * valid public ID. The returned reason is one of ID_PROBLEMS and never
 * embeds the value, so it is safe to log or attach to diagnostics.
 */
export function classifyId(value) {
  if (typeof value !== "string") return "type";
  if (value.length === 0) return "empty";
  if (value.length > MAX_ID_LENGTH) return "length";
  if (!PORTABLE_ID.test(value) || NON_PORTABLE_CHARACTERS.test(value)) return "grammar";
  if (value === RESERVED_ID) return "reserved";
  return null;
}

/** Boolean form of classifyId. */
export function isValidId(value) {
  return classifyId(value) === null;
}

/** Exact, case-sensitive reservation check. Only "skill-router" is reserved. */
export function isReservedId(value) {
  return value === RESERVED_ID;
}

/**
 * Throw a fixed, bounded error when the value is not a valid public ID.
 * `label` is interpolated verbatim and must come from a trusted caller.
 */
export function assertValidId(value, label = "ID") {
  const problem = classifyId(value);
  if (problem === null) return;
  if (problem === "reserved") {
    throw new Error(`${label} uses the reserved ${RESERVED_ID} ID`);
  }
  throw new Error(
    `${label} must be a portable ID: lowercase letters, digits, and hyphens, at most ${MAX_ID_LENGTH} characters`,
  );
}
