// Phase 14 — package platform contract, README agreement, and packed shape.
//
// Phase 14's lanes are runtime lanes; this file pins the single metadata
// addition they make — `"os": ["darwin", "linux"]`, mirrored into the lock
// root by a package-lock-only npm run — and proves that README.md states the
// *same* contracts the runtime enforces:
//
//   1. the platform support matrix (Linux supported and CI/release-gated,
//      macOS intended and developer-tested but not CI-qualified, Windows
//      unsupported and refused with `PLATFORM_UNSUPPORTED` before any router
//      filesystem mutation, `--help`/`--version` unaffected, no live
//      macOS/Windows evidence claimed);
//   2. the strong-identity fail-closed error vocabulary
//      (`REQUEST-IDENTITY-UNAVAILABLE`, `RECOVERY_CONFLICT`,
//      `LOCK_COMPROMISED`) with plain numeric `{dev, ino}` journal identity,
//      error privacy scoped to the surfaces that are actually path-free
//      (request/body/token/digest never exposed; some operational errors may
//      name the path needed for remediation), deletion scoped to the exact
//      supported classes that carry external durable attribution records
//      (spool `.removal-<nonce>.json`, recovery `<claim>.json`, restoration
//      `.reserve-<txid>.json`) with the final syscall window still qualified,
//      and unprovable artifacts preserved rather than deleted;
//   3. the fixed, non-configurable traversal limits — the shared
//      source/support/Claude walker (one shared 64 MiB budget) told apart
//      from the separately bounded managed-state inspection/finalization
//      (64 MiB *total-tree* cap), with 4096/depth-32 fixed in both, symlink
//      refusal qualified by the residual away-and-back ABA window, and
//      fail-closed no-partial-inventory behaviour;
//   4. OpenCode capability resolution (existing shape wins, bounded
//      `--version` probe, 1.x object / 2.x+ array, fail-closed shape-neutral
//      rerun, no config write, dry-run never probes, v1→v2 migration noted
//      without a forward-compatibility claim);
//   5. `--root` `~`/`~/` expansion and `~user` rejection;
//   6. schema-v1 direct source directories, scan-gated re-enablement, and the
//      live `enabled: false` veto;
//   7. the items this phase keeps explicitly deferred;
//   8. qualified recovery/cleanup claims — implemented fail-closed/claim
//      protocols, the residual final-pathname ABA windows (no `unlinkat`,
//      no no-clobber directory rename), unsafe restoration not attempted,
//      and Windows refused rather than owner/mode-degraded;
//   9. the explicit threat model — crashes, ordinary concurrency, and
//      persistent symlink/replacement/hardlink ambiguity are in scope; a
//      malicious same-UID process racing `unlink`/`rmdir`/recursive
//      removal/`rename` is out of scope, and final-pathname checks narrow
//      those windows without guaranteeing fail-closed behaviour inside them;
//   10. a control directory (or missing parent) a run creates itself is
//       documented as intentionally left owner-private and inert instead of
//       automatically removed — nothing is rmdir'd by path, and only the
//       attributed `control.json` anchor is ever dropped.
//
// Absolute phrasings the review rejected are asserted *absent*, so a future
// edit cannot silently reintroduce them.
//
// Everything is read-only: the file parses package metadata, parses the lock,
// reads README and a few runtime modules, and runs `npm pack --dry-run` (no
// tarball, no scratch directory, no network).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BOUNDED_WALK_LIMITS } from "../src/bounded-walk.js";
import { STATE_TREE_LIMITS } from "../src/managed-state.js";
import { PLATFORM_ERROR_CODE, UNSUPPORTED_PLATFORM } from "../src/platform.js";
import { OPENCODE_PROBE_TIMEOUT_MS } from "../src/opencode.js";

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageText = readFileSync(path.join(repository, "package.json"), "utf8");
const packageJson = JSON.parse(packageText);
const packageLock = JSON.parse(readFileSync(path.join(repository, "package-lock.json"), "utf8"));
const readme = readFileSync(path.join(repository, "README.md"), "utf8");
/** Phrase matching ignores markdown wrapping: prose is asserted on one line. */
const flat = readme.replace(/\s+/g, " ");
const lockRoot = packageLock.packages[""];

/** The exact platform contract this phase adds, in declaration order. */
const SUPPORTED_OS = ["darwin", "linux"];

/** Lifecycle scripts a publication must never carry (same set as Phase 12). */
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

function source(file) {
  return readFileSync(path.join(repository, "src", file), "utf8");
}

/** The exact inline JSON rendering README uses for the npm `os` contract. */
function osContractText() {
  return `"os": [${SUPPORTED_OS.map((value) => `"${value}"`).join(", ")}]`;
}

test("package.json declares exactly the supported npm os contract", () => {
  assert.deepEqual(packageJson.os, SUPPORTED_OS, "os is exactly darwin then linux, nothing else");
  assert.equal(JSON.stringify(packageJson.os), JSON.stringify(SUPPORTED_OS), "no extra entries or ordering drift");
  assert.ok(!("cpu" in packageJson), "no cpu contract is declared");

  // Phase 12/13 publication metadata must be untouched by this addition.
  assert.deepEqual(packageJson.files, ["src", "README.md", "LICENSE"], "the files allowlist is unchanged");
  assert.deepEqual(packageJson.bin, { "skill-router": "./src/cli.js" }, "the bin is unchanged");
  assert.deepEqual(
    packageJson.publishConfig,
    { registry: "https://registry.npmjs.org/", access: "public", tag: "latest" },
    "publishConfig is unchanged",
  );
  assert.deepEqual(packageJson.engines, { node: ">=20" }, "engines is unchanged");
  assert.deepEqual(packageJson.dependencies, { yaml: "2.9.1" }, "dependencies are unchanged");
  for (const name of FORBIDDEN_LIFECYCLE) {
    assert.ok(!(name in packageJson.scripts), `package.json must not define the ${name} script`);
  }
});

test("package-lock.json records the same os contract in its root package", () => {
  assert.equal(packageLock.lockfileVersion, 3, "the lock stays on lockfileVersion 3");
  assert.deepEqual(lockRoot.os, SUPPORTED_OS, "the lock root records os exactly as package.json declares it");
  assert.deepEqual(lockRoot.os, packageJson.os, "the lock root and package.json agree on the platform contract");
  // The rest of the root record must still be the Phase 12/13 shape.
  assert.equal(lockRoot.name, packageJson.name);
  assert.equal(lockRoot.version, packageJson.version);
  assert.equal(lockRoot.license, packageJson.license);
  assert.deepEqual(lockRoot.bin, { "skill-router": "src/cli.js" });
  assert.deepEqual(lockRoot.engines, packageJson.engines);
  assert.deepEqual(lockRoot.dependencies, packageJson.dependencies);
  // Only the root entry carries a platform contract; the pinned dependency
  // does not gain one from our declaration.
  const entries = Object.keys(packageLock.packages);
  assert.deepEqual(entries, ["", "node_modules/yaml"], "no extra package entries appeared");
  assert.ok(!("os" in packageLock.packages["node_modules/yaml"]), "the dependency's own os contract is untouched");
});

test("README and package metadata agree on the platform support matrix", () => {
  assert.ok(flat.includes("## Platform support (Phase 14)"), "README carries a platform support section");
  assert.ok(flat.includes(osContractText()), `README quotes the exact npm contract ${osContractText()}`);
  assert.ok(
    flat.includes("`package-lock.json` records the same list"),
    "README states that the lock records the same list",
  );

  // Linux: supported, and gated by CI and the release workflow.
  assert.match(flat, /Linux \| \*\*Supported\*\* \| CI and the release gate run every job on `ubuntu-latest` \|/);
  assert.ok(flat.includes("the only CI- and release-gated platform"), "Linux is called out as the gated platform");

  // macOS: intended POSIX runtime, developer-tested, explicitly not CI-qualified.
  assert.ok(
    flat.includes("the intended POSIX runtime, developer-tested"),
    "macOS is the intended POSIX runtime and developer-tested",
  );
  assert.ok(flat.includes("no macOS CI job"), "the missing macOS CI job is stated");
  assert.ok(flat.includes("not CI-qualified"), "macOS is explicitly not CI-qualified");

  // Windows: unsupported, stable code, refused before any filesystem effect.
  assert.match(flat, /Windows \| \*\*Unsupported\*\* \| Refused at runtime with `PLATFORM_UNSUPPORTED`/);
  assert.equal(PLATFORM_ERROR_CODE, "PLATFORM_UNSUPPORTED", "the runtime code is the documented one");
  assert.equal(UNSUPPORTED_PLATFORM, "win32");
  assert.ok(
    flat.includes("fails with the stable code `PLATFORM_UNSUPPORTED` *before* the first `mkdir`, `chmod`, lock, journal,"),
    "the refusal happens before the first router filesystem effect",
  );
  assert.ok(
    flat.includes("`skill-router --help` and `skill-router --version` never reach the guard"),
    "help and version are documented as unaffected",
  );

  // No live macOS/Windows evidence may be claimed.
  assert.ok(
    flat.includes("it is **not** a claim of live cross-platform evidence"),
    "the matrix is explicitly not a live-evidence claim",
  );
  assert.ok(
    flat.includes("No live Windows execution and no macOS CI job backs it"),
    "the absence of live Windows/macOS evidence is stated",
  );
  assert.ok(
    flat.includes("nothing here claims any Windows filesystem enforcement"),
    "no Windows filesystem enforcement is claimed",
  );
  assert.ok(
    flat.includes("the guard is an explicit deny of exactly `win32` rather than an allowlist"),
    "the npm contract and the runtime guard are told apart",
  );
});

test("README documents the identity error vocabulary with qualified error privacy", () => {
  assert.ok(flat.includes("## Reliability contracts (Phase 14)"), "README carries the reliability contracts section");
  for (const code of ["REQUEST-IDENTITY-UNAVAILABLE", "RECOVERY_CONFLICT", "LOCK_COMPROMISED"]) {
    assert.ok(flat.includes(`\`${code}\``), `README documents ${code}`);
  }
  // The same vocabulary must be the one the runtime raises.
  assert.ok(source("requests.js").includes('"REQUEST-IDENTITY-UNAVAILABLE"'), "requests.js owns that code");
  assert.ok(source("journal.js").includes("RECOVERY_CONFLICT:"), "journal.js owns RECOVERY_CONFLICT");
  assert.ok(source("mutation-lock.js").includes("LOCK_COMPROMISED:"), "mutation-lock.js owns LOCK_COMPROMISED");

  const identitySection = flat.slice(flat.indexOf("### Strong file identity"), flat.indexOf("### Fixed traversal limits"));
  assert.ok(identitySection.length > 0, "the identity subsection exists");

  // Error privacy, as qualified: request material is never exposed anywhere,
  // path-freedom is claimed only where it is guaranteed, and some local
  // operational errors legitimately name the path you must remediate.
  assert.ok(
    !identitySection.includes("no message they carry ever contains a path"),
    "the absolute 'every message is path-free' claim is gone",
  );
  assert.ok(
    identitySection.includes(
      "Request bytes, request bodies, spool tokens, and their digests are **never** exposed",
    ),
    "request/body/token/digest exposure is ruled out everywhere",
  );
  assert.ok(
    identitySection.includes("Path-freedom is narrower and is claimed only where it is actually guaranteed"),
    "path-freedom is scoped to the guaranteed surfaces",
  );
  assert.ok(
    identitySection.includes("bounded-walker limit refusals, the request-spool diagnostic vocabulary"),
    "the guaranteed path-free surfaces are named",
  );
  assert.ok(
    identitySection.includes("some local operational errors deliberately name the filesystem path"),
    "operational errors may name a filesystem path for remediation",
  );
  assert.ok(
    identitySection.includes(
      "several `RECOVERY_CONFLICT` and `LOCK_COMPROMISED` messages name the claim, lock, or artifact path",
    ),
    "the identity codes are not claimed path-free",
  );
  assert.ok(
    identitySection.includes('plain numeric `{ "dev", "ino" }` pair'),
    "persisted journal identity is documented as a plain numeric dev/ino pair",
  );
  assert.ok(
    identitySection.includes("never `BigInt`, never a string, exactly those two keys"),
    "the persisted identity shape is spelled out",
  );
  assert.ok(
    identitySection.includes("can never authorize a deletion"),
    "an invalid or zero identity never authorizes deletion",
  );

  // Deletion claims are scoped to exact classes, authorized by external
  // durable attribution records, and explicitly *not* an identity-bound
  // guarantee over the final syscall window.
  assert.ok(
    !identitySection.includes("created, verified, reclaimed, and deleted against"),
    "the absolute 'every artifact is identity-deleted' claim is gone",
  );
  assert.ok(!identitySection.includes("nothing else is ever deleted"), "the absolute deletion claim is gone");
  assert.ok(
    !identitySection.includes("Until an external attribution protocol exists"),
    "the stale 'until an external attribution protocol exists' wording is gone",
  );
  assert.ok(
    identitySection.includes("authorized by an **external durable attribution record**, never by a pathname alone"),
    "deletion authority is documented as an external durable attribution record",
  );
  for (const record of [".removal-<nonce>.json", "`<claim>.json`", ".reserve-<txid>.json"]) {
    assert.ok(identitySection.includes(record), `the external record ${record} is documented`);
  }
  assert.ok(
    identitySection.includes("fsynced *before* anything is claimed"),
    "the spool removal record is written before anything is claimed",
  );
  assert.ok(identitySection.includes("outlives its container"), "the claim record outlives its container");
  assert.ok(
    identitySection.includes("Re-entry trusts only a valid record plus the claims it matches — never a bare name or shape"),
    "re-entry trusts only a valid record plus matching claims",
  );
  assert.ok(
    identitySection.includes("a record-less lookalike is never adopted or removed"),
    "a record-less lookalike is never adopted or removed",
  );
  assert.ok(
    identitySection.includes("records each payload's identity in the journal document"),
    "journal payload identity is recorded externally in the journal",
  );
  assert.ok(
    identitySection.includes("narrow the final syscall window; they do not close it"),
    "the final syscall window stays qualified",
  );
  assert.ok(
    identitySection.includes("**not** as an identity-bound deletion guarantee over every window"),
    "identity-bound deletion over every window is explicitly not claimed",
  );
  assert.ok(identitySection.includes("created, verified, and reclaimed against"), "creation/verification/reclaim still claim identity");
  assert.ok(
    identitySection.includes("Deletion is attempted **only for the exact classes below**"),
    "deletion scope is qualified to exact supported classes",
  );
  assert.ok(
    identitySection.includes("The re-checks shrink the final window; they do not close it"),
    "the claim re-checks are described as narrowing, not closing, the window",
  );
  for (const artifactClass of [
    "**Regular files** — the journal file, its payloads and transients, lock and claim records, control/owner records, and request-spool entries",
    "**Empty router-owned directories**",
    "**Managed-state trees and recorded prior state**",
  ]) {
    assert.ok(identitySection.includes(artifactClass), `the documented deletion class is stated: ${artifactClass.slice(0, 40)}`);
  }
  assert.ok(
    identitySection.includes("No other class is deleted by design"),
    "classes outside the list are not deleted",
  );
  assert.ok(
    identitySection.includes("is **preserved and refused, never deleted**"),
    "an unprovable artifact is preserved, never deleted",
  );
  assert.ok(
    identitySection.includes("a same-UID process racing the final pathname syscall is the documented exclusion"),
    "the same-UID race is stated as the documented exclusion",
  );
  assert.ok(
    identitySection.includes("stays available to a later `recover` run"),
    "a preserved artifact stays available to a later recover run",
  );
});

test("README states the Phase 14 threat model, including its same-UID exclusion", () => {
  const threat = flat.slice(flat.indexOf("### Threat model"), flat.indexOf("### Strong file identity"));
  assert.ok(threat.length > 0, "the threat-model subsection exists");

  // In scope: crashes, ordinary concurrency, persistent ambiguity.
  assert.ok(threat.includes("**Crashes and interrupted runs.**"), "crashes and interrupted runs are in scope");
  assert.ok(threat.includes("**Ordinary concurrency.**"), "ordinary concurrency is in scope");
  assert.ok(threat.includes("**Persistent filesystem ambiguity.**"), "persistent filesystem ambiguity is in scope");
  assert.ok(
    threat.includes("A symlink, a replacement, or an unexpected extra hard link"),
    "symlink/replacement/hardlink ambiguity is named",
  );

  // Out of scope: a malicious same-UID process racing final pathname syscalls.
  assert.ok(threat.includes("**not an OS sandbox**"), "owner-private local state is not claimed to be an OS sandbox");
  assert.ok(threat.includes("malicious *same-UID* process"), "the same-UID adversary is named");
  for (const operation of ["`unlink`", "`rmdir`", "recursive removal", "`rename`"]) {
    assert.ok(threat.includes(operation), `the raced operation ${operation} is documented`);
  }
  assert.ok(
    threat.includes("no fd-relative form of those operations"),
    "the missing fd-relative primitive is stated",
  );
  assert.ok(
    threat.includes("they cannot guarantee fail-closed behaviour inside them"),
    "final pathname checks are explicitly not claimed to guarantee fail-closed inside the window",
  );
  assert.ok(
    threat.includes("narrow those windows"),
    "final pathname checks are described as narrowing the windows",
  );
});

test("README documents the fixed traversal limits the runtime enforces", () => {
  assert.deepEqual(
    BOUNDED_WALK_LIMITS,
    { maxEntries: 4096, maxDepth: 32, maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 },
    "the shared-walker production limits are fixed",
  );
  assert.deepEqual(
    STATE_TREE_LIMITS,
    { maxEntries: 4096, maxBytes: 64 * 1024 * 1024, maxDepth: 32 },
    "the managed-state limits are fixed and separate",
  );
  const limitsSection = flat.slice(flat.indexOf("### Fixed traversal limits"), flat.indexOf("### Explicitly deferred"));
  assert.ok(limitsSection.length > 0, "the traversal-limits subsection exists");

  // The shared source/support/Claude walker and its one shared budget.
  assert.ok(limitsSection.includes("**The shared source/support/Claude walker**"), "the shared walker is named");
  assert.ok(
    limitsSection.includes("one shared budget across a traversal *and* the file reads that follow it"),
    "the shared budget spans traversal and the reads that follow",
  );
  assert.ok(limitsSection.includes(`| Observed entries per traversal | ${BOUNDED_WALK_LIMITS.maxEntries} |`), "4096 entries are documented");
  assert.ok(limitsSection.includes(`| Directory depth, root included | ${BOUNDED_WALK_LIMITS.maxDepth} |`), "depth 32 is documented");
  assert.ok(limitsSection.includes("| Bytes per file read | 16 MiB |"), "16 MiB per file is documented");
  assert.ok(limitsSection.includes("| Aggregate bytes per shared budget | 64 MiB |"), "the 64 MiB shared budget is documented");
  assert.equal(BOUNDED_WALK_LIMITS.maxFileBytes / (1024 * 1024), 16, "16 MiB matches the runtime bound");
  assert.equal(BOUNDED_WALK_LIMITS.maxTotalBytes / (1024 * 1024), 64, "64 MiB matches the shared-budget bound");

  // Managed-state inspection/finalization is a *separate* bound with a
  // total-tree (not per-traversal) 64 MiB semantics.
  assert.ok(
    limitsSection.includes("**Managed-state inspection and stage finalization are separately bounded**"),
    "the managed-state walker is distinguished from the shared one",
  );
  assert.ok(limitsSection.includes("`STATE_TREE_LIMITS`"), "the separate limits object is named");
  assert.ok(
    limitsSection.includes("the same 4096 entries and depth 32"),
    "the fixed 4096/depth-32 caps hold for the managed-state walk too",
  );
  assert.ok(limitsSection.includes("**64 MiB total-tree cap**"), "the managed-state total-tree cap is documented");
  assert.ok(
    limitsSection.includes("the ceiling on the *sum of file bytes in the owned state tree*"),
    "the total-tree cap semantics are spelled out",
  );
  assert.ok(
    limitsSection.includes("not a per-traversal read budget like the shared one"),
    "the two 64 MiB semantics are told apart",
  );

  assert.ok(limitsSection.includes("not user-configurable"), "the limits are documented as not user-configurable");

  // Symlink handling is stated as refusal plus the residual ABA window —
  // never as an absolute "never follows a symlink".
  assert.ok(!limitsSection.includes("never follows a symlink"), "the absolute no-symlink claim is gone");
  assert.ok(
    limitsSection.includes("**Persistent symlinks and final-component symlinks are refused rather than traversed**"),
    "persistent/final-component symlink refusal is documented",
  );
  assert.ok(
    limitsSection.includes("away-and-back ABA across the async open"),
    "the away-and-back ABA residual is documented",
  );
  assert.ok(
    limitsSection.includes("no fd-relative (`openat`/`O_PATH`) directory enumeration"),
    "the missing fd-relative enumeration primitive is named",
  );
  assert.ok(
    limitsSection.includes("is not observable by these checks"),
    "the residual is scoped to what pathname checks cannot observe",
  );

  assert.ok(limitsSection.includes("a failure blocks the operation and no partial inventory"), "a failure blocks with no partial inventory");
  assert.ok(
    limitsSection.includes("(`entries`, `depth`, `file-bytes`, `total-bytes`)"),
    "the complete reason enum is documented",
  );
  assert.ok(
    limitsSection.includes("exactly one path-free reason"),
    "the bounded-walker refusal is still claimed path-free — one of the guaranteed surfaces",
  );
  assert.ok(source("bounded-walk.js").includes("maxEntries: 4096"), "the runtime keeps the documented entry bound");
  assert.ok(source("managed-state.js").includes("maxBytes: 64 * 1024 * 1024"), "the managed-state tree cap is real");
});

test("README states the recovery/cleanup residuals instead of absolute removal claims", () => {
  const recovery = flat.slice(flat.indexOf("### Recovery"), flat.indexOf("### Request privacy"));
  assert.ok(recovery.length > 0, "the recovery subsection exists");

  // A control directory (or missing parent) this run creates itself is left
  // owner-private and inert on purpose — never automatically rmdir'd by path.
  assert.ok(
    recovery.includes("**intentionally left in place** rather than automatically removed"),
    "a control directory this run created is documented as intentionally left in place",
  );
  assert.ok(
    recovery.includes("An empty leftover is owner-private (`0700`) and inert"),
    "an empty control-directory leftover is documented as owner-private and inert",
  );
  assert.ok(
    recovery.includes('Nothing ever infers "created by us" at cleanup time'),
    "no created-by-us inference happens at cleanup time",
  );
  assert.ok(recovery.includes("nothing is `rmdir`'d by path"), "nothing is rmdir'd by path");
  assert.ok(recovery.includes("removes the removal race entirely"), "the reason for skipping that cleanup is stated");
  assert.ok(recovery.includes("The attributed anchor drop still runs"), "the attributed anchor drop still runs");
  assert.ok(recovery.includes("never the directory around it"), "only the anchor — never the directory — is removed");
  assert.ok(
    !recovery.includes("removed when it is still empty"),
    "the stale 'a control directory … is removed when it is still empty' claim is gone",
  );

  // Qualified, not absolute: the protocols that exist are named, and the
  // residual pathname windows are stated instead of being declared impossible.
  assert.ok(
    !recovery.includes("are left untouched behind a stable error instead of being guessed at"),
    "the absolute 'foreign/ambiguous untouched' claim is gone",
  );
  assert.ok(
    recovery.includes("claim protocols this implementation actually has"),
    "foreign/ambiguous handling is qualified to the implemented claim protocols",
  );
  assert.ok(
    recovery.includes("preserves — never deletes — anything it cannot re-prove"),
    "what the protocols preserve is spelled out",
  );
  assert.ok(
    recovery.includes("**final pathname ABA window remains for each destructive step"),
    "the residual final-pathname ABA window is documented",
  );
  for (const operation of ["`unlink`", "`rmdir`", "recursive removal", "`rename`"]) {
    assert.ok(recovery.includes(operation), `the destructive step ${operation} is covered by the residual`);
  }
  assert.ok(recovery.includes("unlinkat(fd, ...)"), "the missing fd-relative unlink primitive is named");
  assert.ok(recovery.includes("RENAME_NOREPLACE"), "the missing no-clobber directory rename is named");
  assert.ok(
    !recovery.includes("is identity-checked and fails closed but is not structurally excluded"),
    "the claim that checks 'fail closed' inside the window is gone",
  );
  assert.ok(
    recovery.includes("they cannot guarantee fail-closed behaviour inside it"),
    "fail-closed inside the final window is explicitly not guaranteed",
  );
  assert.ok(
    recovery.includes("a window-narrowing check, not a guarantee inside the final pathname window"),
    "claim re-proof is documented as window-narrowing, not a guarantee",
  );
  assert.ok(recovery.includes("**unsafe restoration is not attempted**"), "unsafe restoration is documented as not attempted");
  assert.ok(recovery.includes("is never renamed over"), "a present destination is never renamed over");
  assert.ok(
    recovery.includes("preserved for a later `recover` run"),
    "preserved claims stay available for a later recover run",
  );

  // Windows: the old owner/mode degradation wording must be gone; the runtime
  // is refused instead.
  assert.ok(!flat.includes("degrade to what that platform can prove"), "the Windows owner/mode degradation wording is removed");
  assert.ok(!flat.includes("no Windows enforcement is claimed"), "the no-Windows-enforcement disclaimer is removed");
  assert.ok(flat.includes("Windows is a refused runtime (`PLATFORM_UNSUPPORTED`)"), "Windows is documented as refused");
  assert.ok(
    flat.includes("these POSIX owner/mode checks are never degraded for an unsupported platform"),
    "the spool owner/mode checks are documented as never degraded",
  );
  assert.ok(
    flat.includes("`state-confidentiality-limited` only when") && flat.includes("Windows never reaches that diagnostic"),
    "the limited-confidentiality diagnostic is scoped away from Windows",
  );
});

test("README documents OpenCode capability resolution and its fail-closed path", () => {  const opencode = flat.slice(flat.indexOf("### Capability resolution"), flat.indexOf("## Harness selection"));
  assert.ok(opencode.length > 0, "the OpenCode capability subsection exists");

  assert.ok(
    opencode.includes("An existing, valid skills shape in the configuration **always wins**"),
    "an existing valid shape wins",
  );
  assert.ok(
    opencode.includes("one bounded asynchronous `opencode --version` probe"),
    "a normal run uses the bounded --version probe",
  );
  assert.ok(opencode.includes("`opencode --version` probe"), "the probe is the --version probe");
  assert.ok(opencode.includes("10 s timeout, 64 KiB output cap"), "the probe bounds are documented");
  assert.equal(OPENCODE_PROBE_TIMEOUT_MS, 10_000, "the documented timeout is the runtime timeout");
  assert.ok(
    opencode.includes("A recognized `1.x` version selects the object form (`skills.paths`, plus `skills.urls`); `2.x` and later select the `skills` array"),
    "1.x selects the object form and 2.x+ the array",
  );
  assert.ok(
    opencode.includes("**fails closed** to a shape-neutral manual instruction that names neither shape"),
    "unknown/noisy/missing results fail closed shape-neutrally",
  );
  assert.ok(
    opencode.includes("**no OpenCode configuration is written** in that case"),
    "a failed probe writes no OpenCode configuration",
  );
  assert.ok(
    opencode.includes("`--dry-run` never probes and never spawns OpenCode."),
    "dry-run never probes",
  );
  assert.ok(
    opencode.includes("migrates a v1 `skills` object (`paths`/`urls`) into the v2 `skills` array"),
    "the official current v1→v2 skills migration is documented",
  );
  assert.ok(
    opencode.includes("claims no compatibility with future OpenCode versions"),
    "no future OpenCode compatibility is claimed",
  );
  // Cross-check the documented shape rule against the runtime parser.
  assert.ok(source("opencode.js").includes("['--version']") || source("opencode.js").includes('["--version"]'), "the runtime probes --version only");
});

test("README documents --root ~ expansion and rejection of ~user", () => {
  const rootSection = flat.slice(flat.indexOf("### Root selection"), flat.indexOf("### Schema version 1"));
  assert.ok(rootSection.length > 0, "the root-selection subsection exists");
  assert.ok(rootSection.includes("`--root` means exactly one thing for every command"), "one meaning for every command");
  assert.ok(
    rootSection.includes("An exact `~` expands to the router home"),
    "an exact ~ expands to the router home",
  );
  assert.ok(rootSection.includes("`SKILL_ROUTER_HOME`"), "the router home override is named");
  assert.ok(rootSection.includes("a leading `~/...` expands through that same home"), "~/ is documented");
  assert.ok(
    rootSection.includes("A `~user` prefix is rejected with an error"),
    "~user is rejected, never silently resolved",
  );
  assert.ok(
    rootSection.includes("any other `~` stays a literal path character"),
    "a bare ~ that is not exact stays literal",
  );
  assert.ok(
    rootSection.includes("no backslash or drive-letter expansion"),
    "no Windows path expansion is offered",
  );
});

test("README documents schema-v1 direct sources, scan-gated re-enablement, and the live veto", () => {
  const v1 = flat.slice(flat.indexOf("### Schema version 1"), flat.indexOf("### Schema version 2"));
  assert.ok(v1.length > 0, "the schema-version-1 subsection exists");
  assert.ok(
    v1.includes("may be the skill directory that contains its `SKILL.md`, not only the file itself"),
    "direct source directory support is documented",
  );
  assert.ok(
    v1.includes("the same no-follow direct-source resolution schema v2 uses"),
    "directory resolution is shared with schema v2",
  );
  assert.ok(
    v1.includes("a declared source that discovery never finds stays inert"),
    "an undiscovered v1 source stays inert",
  );
  assert.ok(v1.includes("a live `enabled: false` vetoes routing immediately"), "the live false veto is documented");
  assert.ok(v1.includes("it is never treated as staleness"), "live false is never staleness");

  const staleMessage = "Registry skill enablement is stale; run skill-router scan first";
  assert.ok(v1.includes(staleMessage), "re-enabling requires `skill-router scan`");
  assert.ok(source("operations.js").includes(staleMessage), "the documented refusal is the runtime refusal");
  assert.ok(v1.includes("`check` reports `enablement-stale`"), "check reports the same stale state");
});

test("README keeps every deferred Phase 14 item explicitly deferred", () => {
  const deferred = flat.slice(flat.indexOf("### Explicitly deferred"), flat.indexOf("## Development"));
  assert.ok(deferred.length > 0, "the deferred subsection exists");
  assert.ok(
    deferred.includes("### Explicitly deferred — not promised in this phase"),
    "the heading states the items are not promised",
  );
  assert.ok(deferred.includes("**A4c v1 warnings**"), "A4c v1 warnings stay deferred");
  assert.ok(deferred.includes("**A structured `--json` error envelope**"), "the structured --json error envelope stays deferred");
  assert.ok(
    deferred.includes("one bounded line on stderr"),
    "the current stderr-only error shape is described",
  );
  assert.ok(deferred.includes("**Windows enablement**"), "Windows enablement stays deferred");
  assert.ok(deferred.includes("device-name, long-path"), "device names and long paths are named as deferred");
  assert.ok(deferred.includes("**macOS CI**"), "macOS CI stays deferred");
  assert.ok(deferred.includes("**User-configurable traversal limits**"), "user-configurable limits stay deferred");
  assert.ok(
    deferred.includes("neither implements nor commits to them"),
    "the deferred items are not promised",
  );
});

test("npm pack still ships only the allowlisted surfaces and no skills payload", (t) => {
  const probe = spawnSync("npm", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    t.skip("npm is unavailable");
    return;
  }
  const packed = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
    cwd: repository,
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(packed.status, 0, `npm pack --dry-run failed: ${packed.stderr}`);
  const [report] = JSON.parse(packed.stdout);
  assert.equal(report.name, packageJson.name);
  assert.equal(report.version, packageJson.version);

  const shipped = report.files.map((entry) => entry.path).sort();
  const sourceModules = readdirSync(path.join(repository, "src"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => `src/${name}`)
    .sort();
  const intended = ["LICENSE", "README.md", "package.json", ...sourceModules].sort();

  assert.deepEqual(shipped, intended, "the tarball is exactly package.json + README + LICENSE + src modules");
  assert.equal(report.entryCount, intended.length, "entryCount matches the intended set");
  assert.equal(sourceModules.length, 26, "26 shipped source modules — Phase 13 shipped 23, Phase 14 adds platform coverage");
  assert.equal(report.entryCount, 29, "26 src modules plus package.json, README.md, LICENSE");
  assert.equal(
    shipped.filter((name) => name === "skills" || name.startsWith("skills/")).length,
    0,
    "no skills/ payload is ever packed",
  );
  assert.equal(shipped.filter((name) => name.endsWith(".js") && !name.startsWith("src/")).length, 0, "no code outside src/ is packed");

  const cli = report.files.find((entry) => entry.path === "src/cli.js");
  assert.equal(cli.mode & 0o111, 0o111, "the declared bin stays executable");
});
