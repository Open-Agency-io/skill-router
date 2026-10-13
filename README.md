# Skill Router

Skill Router is a standalone, low-token router for portable agent skills. It
builds a compact registry from installed skill metadata, selects likely skills
locally, and lets the active harness load only the selected skill body.

This repository is independent of Context Curator. It does not import, bundle,
or share runtime state with that project.

## Project links

- **Repository**: https://github.com/Open-Agency-io/skill-router
- **Issues**: https://github.com/Open-Agency-io/skill-router/issues
- **Contributing**: [CONTRIBUTING.md](CONTRIBUTING.md)
- **Security policy**: [SECURITY.md](SECURITY.md)
- **Code of Conduct**: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- **Package**: `@openagency/skill-router` — **not published to npm yet**, see
  "npm publication (Phase 12)" in the Development section. The unscoped name
  `skill-router` belongs to an unrelated publisher and must never be used.

## Support, contributing, and security

- **Support** — non-sensitive bugs and usage questions belong in
  https://github.com/Open-Agency-io/skill-router/issues; search existing
  issues first. Do not post vulnerabilities or sensitive personal data in
  public issues.
- **Contributing** — [CONTRIBUTING.md](CONTRIBUTING.md) covers the Node 20+
  development setup, the required credential-free gates (`npm test`, `npm
  run check`), the optional container and model-backed gates, the platform
  matrix, and the privacy/error/threat contracts a change must preserve.
  Pull requests target `main`.
- **Security** — report vulnerabilities **privately**, never through a
  public issue, exactly as [SECURITY.md](SECURITY.md) describes. Enabling
  GitHub private vulnerability reporting for this repository is an external
  release gate that must be confirmed in repository settings before public
  release; SECURITY.md states the current limitation honestly instead of
  claiming the channel is already active.
- **Conduct** — [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) is the behavior and
  moderation policy for all repository participation. It names no private
  reporting contact because none is designated yet, and says so.

## Install

Node.js 20 or newer is required. From a published package (**the package is
not on npm yet** — the command below works only after the deferred bootstrap
described in "npm publication (Phase 12)"):

```sh
npm install --global @openagency/skill-router
skill-router init
```

For repository development, use `node src/cli.js` in place of `skill-router`.

## Platform support (Phase 14)

| Platform | Support | Evidence |
| --- | --- | --- |
| Linux | **Supported** | CI and the release gate run every job on `ubuntu-latest` |
| macOS (`darwin`) | **Supported — the intended POSIX runtime, developer-tested** | The development suite runs on macOS; there is **no macOS CI job**, so macOS is not CI-qualified |
| Windows | **Unsupported** | Refused at runtime with `PLATFORM_UNSUPPORTED`, before any router filesystem mutation |

`package.json` states exactly this contract to npm as
`"os": ["darwin", "linux"]`, and `package-lock.json` records the same list in
its root package entry. Nothing else is declared supported.

- **Linux** is the only CI- and release-gated platform: the CI matrix, the
  Phase 11 release gate, and the Phase 12 staging workflow all run on Linux.
- **macOS** is the intended POSIX runtime and the platform this repository is
  developed and tested on by hand. It is not CI-qualified — no macOS job runs
  the suite — so macOS support is a stated, developer-tested intent, not a
  CI-proven result.
- **Windows** is unsupported. Every command that crosses the controlled
  boundary — `init`, `add`, `scan`, `route`, `check`, `uninstall`, `recover`,
  and the request-spool API — fails with the stable code
  `PLATFORM_UNSUPPORTED` *before* the first `mkdir`, `chmod`, lock, journal,
  claim, anchor, or write, so an unsupported runtime can never leave a
  partially-created router state behind. The refusal message names the
  platform only; it carries no path, token, digest, or request bytes.
  `skill-router --help` and `skill-router --version` never reach the guard and
  behave identically on every platform.

This matrix is a declared, structurally-tested contract — it is **not** a
claim of live cross-platform evidence. No live Windows execution and no macOS
CI job backs it, and nothing here claims any Windows filesystem enforcement.

The npm contract and the runtime guard are deliberately not the same shape:
`os` declares exactly the two platforms in this table, while the guard is an
explicit deny of exactly `win32` rather than an allowlist — so any other host
is undeclared, untested, and not claimed here.

## Commands

```sh
# Discover installed skills, create the compact registry, install managed
# OpenCode skill overlays, and register their source.
skill-router init

# Optional: also (or only) integrate Claude Code.
skill-router init --harness all

# Add an installed skill by ID or a local skill/directory by path.
skill-router add git-release
skill-router add ./team-skills/review --alias "inspect this"

# Refresh after source changes, route a request, and diagnose the installation.
skill-router scan
skill-router route --json -- "prepare a release"
skill-router check

# Remove every recorded integration and the owned router state.
skill-router uninstall

# Finish an interrupted transaction and report what was recovered.
skill-router recover
```

Agent integrations must not interpolate untrusted request text into a shell
command. The generated OpenCode and Claude router skills pick a unique
32-lowercase-hex token, write the exact request bytes as `<spool>/<token>.txt`
with a single filesystem write or patch (never a shell command, never by
creating or replacing the spool directory), and invoke
`skill-router route --request-token <token>`. The CLI atomically claims that
one entry, routes it, and consumes it at most once — this is no longer a plain
"consume and delete" of a request file: a crash after the final removal means
the request must be resubmitted. See "Request privacy (stable spool)" below.

Use `--global` for user-wide state or `--project` (the default) for the current
project. Every mutating command supports `--dry-run`; every command supports
machine-readable `--json` output where applicable. `--lock-timeout <ms>` sets
how long a command waits for the mutation lock (0..300000; default 10000, and
2000 for read-only commands).

`add` also supports `--source`, `--replace`, repeatable `--alias`,
`--description`, `--no-enable`, and `--yes` for a directory containing multiple
skills.

`add` disambiguates deterministically. With `--source`, the positional target
is a skill-ID selector and must be a valid public ID (validated before any
source is scanned). Without `--source`, an exact currently discovered valid ID
wins over an existing same-named local path: `add review` selects the
discovered skill, while `add ./review` selects the path. A target that is
neither an existing local path nor a valid public ID is refused with a fixed
error; a valid but undiscovered ID reports `No skill found`. Path spelling
itself may be arbitrary, but every candidate ID derived from it must satisfy
the public ID grammar.

### Uninstall

`skill-router uninstall` removes every recorded harness integration together
with the marker-owned router state directory, at project or global scope.
Selective or per-harness removal is deliberately not offered: partial ownership
cannot be attributed safely.

- The router configuration (`.skill-router.json` or the explicit `--config`) is
  user-owned and always stays in place, so reinstalling needs no re-setup.
  Removing the npm package is not claimed.
- Strict JSON OpenCode configuration is rewritten transactionally so only the
  exact managed `skills` / `skills.paths` entry disappears; every other field
  and source survives, and the configuration file itself stays on disk even if
  the router created or emptied it. JSONC that still lists the entry must be
  edited by hand first: uninstall prints the exact entry to remove and exits
  non-zero before anything else runs.
- Claude state is observed read-only and classified before any mutation. Only a
  fully healthy registration is detached (exact plugin first, then the exact
  scope-owned marketplace), a fully absent registration is skipped without
  inspecting the generated source, and any drift refuses with actionable
  reasons: wrong path, scope, version, disabled or duplicate registrations, or
  an extra plugin owned by the generated marketplace. Repair with
  `skill-router init` and retry.
- `--dry-run` runs every ownership, manual-action, drift, and strict
  generated-source check, then stops without writing or mutating anything.
- The same-parent rename of owned state is the commit boundary, and a
  successful rename commits immediately: a final re-verification of both
  integrations runs just before it, so a source or registration reintroduced
  during the run aborts pre-commit. Failures before the rename restore the
  OpenCode bytes (leaving any concurrent edit in place) and re-register the
  previously healthy Claude plugin. After the rename nothing is rolled back or
  reinstalled: an unverifiable backup and a failed backup cleanup each raise
  their own committed error naming the exact leftover path.
- An installation that is already gone is an idempotent no-op that probes
  neither harness.

### Recovery

Every command takes an exclusive lease on a fixed control directory —
`<project>/.skill-router-control/` for project scope, and
`~/.local/share/skill-router-control/` for `--global` — before it reads,
plans, or writes anything. That directory holds an owner-only `control.json`
anchor (schema, owner, scope, root, timestamp), the lease, and at most one
transaction journal recording paths, digests, and Claude action intents and
outcomes; journal and control bytes never contain request text, skill bodies,
configuration bodies, or environment values.

A control directory — or a missing parent — that a run creates itself is
**intentionally left in place** rather than automatically removed. An empty
leftover is owner-private (`0700`) and inert — no journal, no lease, nothing
to recover — and after a completed run only the `control.json` anchor may
survive, which is ordinary control data. Nothing ever infers "created by us"
at cleanup time and nothing is `rmdir`'d by path: skipping that automatic
cleanup removes the removal race entirely. The attributed anchor drop still
runs when nothing needs the anchor any more, and it unlinks only the
`control.json` this run created and proved by identity — never the directory
around it.

- Mutating commands (`init`, `add`, `scan`, `uninstall`) recover a pending
  transaction first and then continue exactly once, so an interrupted run is
  finished or rolled back before new work starts.
- `--dry-run` and read-only commands never recover: a pending journal raises
  `RECOVERY_REQUIRED` (non-zero exit; `check` reports a single bounded
  `recovery-required` diagnostic instead of probing sources or Claude), and a
  malformed journal fails closed with its stable code. `route` and
  `route --request-token` refuse before claiming or consuming a request.
- `skill-router recover [--json]` runs only that recovery under the same lease
  and reports `recover: clean`, or `recover: recovered <kind> <transaction>`
  with a `committed` or `rolled-back` outcome plus any concurrent configuration
  edits that were preserved rather than overwritten.
- Recovery is observation-driven and re-enterable: recorded endpoint identity
  and digest decide whether an interrupted transaction completes (roll
  forward) or restores the recorded prior state (roll back), and completed
  transactions finish their exact cleanup. Foreign or ambiguous artifacts are
  refused behind a stable error under the claim protocols this implementation
  actually has — each cleanup step moves the exact entry it classified into a
  container it created exclusively (or renames it to an unpredictable
  same-directory claim, for a file), re-proves that claim against the recorded
  identity immediately before acting — a window-narrowing check, not a
  guarantee inside the final pathname window, as the residual below states —
  and preserves — never deletes — anything it cannot re-prove.
- Residuals no Node primitive removes are stated rather than hidden: Node
  exposes no fd-relative unlink (`unlinkat(fd, ...)`) and no no-clobber
  directory rename (`renameat2`-style `RENAME_NOREPLACE`), so a **final
  pathname ABA window remains for each destructive step — `unlink`, `rmdir`,
  recursive removal, and `rename`** (a claim rename, a claim-container
  preparation, a restoration rename). The claim, re-stat, and re-prove checks
  around those syscalls *narrow* the window; **they cannot guarantee
  fail-closed behaviour inside it**, which is precisely the same-UID race the
  threat model under "Reliability contracts (Phase 14)" excludes. For the same
  reason an **unsafe restoration is not attempted**: a canonical destination
  that is present again is never renamed over, so the recorded backup (the
  restoration claim) and every claim that cannot be re-proven are preserved
  for a later `recover` run instead of being clobbered or removed.

### Request privacy (stable spool)

Request ingress travels through an owner-private **stable spool** that is
deliberately outside replaceable router state:

- Project scope uses `<resolved-project-root>/.skill-router-requests/`; global
  scope uses `~/.local/share/skill-router-requests/`. Neither depends on the
  configured `stateDirectory`, so transaction digests and backups, journals,
  payloads, control data, and `init`/`scan` regeneration never hash, copy, or
  move request bytes.
- The generated OpenCode and Claude router instructions embed that exact
  absolute spool path and direct the harness to pick a unique 32-lowercase-hex
  token, create **only** `<token>.txt` there with one filesystem write or patch
  — no shell command, no directory creation or replacement — and then run
  `skill-router route --json --root . --request-token <token>`.
- Owner privacy is a POSIX boundary: a current-user-owned, non-symlink
  directory that is exactly `0700` and carries an owner-only marker. A harness
  tool may create the ingress file itself, but it stays hidden inside that
  directory; the router then atomically claims it by renaming it to a hidden
  name, normalizes it to `0600` **before** reading, bounds the body to strict
  UTF-8 of at most 100000 bytes, and consumes it with identity re-verification
  at every step. There is no weaker fallback mode: Windows is a refused
  runtime (`PLATFORM_UNSUPPORTED`), so the spool API is refused before it runs
  and these POSIX owner/mode checks are never degraded for an unsupported
  platform.
- Output privacy: no route result (API, `--json`, or human line) ever returns
  the original request bytes or the token. Routing metadata (outcome,
  skill/workflow id, confidence, candidates, reason, handoffs) is derived from
  the request and is returned unchanged; errors, control records, journals,
  router state, and the Claude fingerprint sidecar never carry request bytes,
  their hash, or the token.
- Delivery is at-most-once. Failures *before* the claim leave the public entry
  untouched; failures *after* the claim keep the hidden claim so a later
  `route --request-token` resumes it. A successful removal is the at-most-once
  boundary: a crash after it but before the result is emitted requires
  resubmission. A pending journal, a live mutation lock, a missing registry, or
  a stale policy/registry refuses before anything is claimed, and a request
  that is still pending survives `init`, `scan`, and `recover` because the
  spool is stable.
- The retired legacy `<state>/requests` directory is only a consume-only
  fallback: the stable spool wins unless that directory holds the same token,
  and a token found in both locations (or beside a claim, or several claims) is
  ambiguity that fails closed with nothing renamed, read, or removed. Any entry
  still pending there blocks `init`/`add`/`scan` regeneration and `uninstall`
  (`check` reports it as `legacy-requests-pending`). `uninstall` refuses while
  any request is pending and removes the spool only when it is an exact, empty,
  owned directory.

### Managed-state confidentiality

Generated router state is owner-private: every directory the router creates is
`0700` and every generated file is `0600`, including copied support files and
executable source copies, so no public or executable source mode survives in
generated state. `check` verifies this independently and read-only
(`state-confidentiality-invalid`, or `state-confidentiality-limited` only when
a runtime reports no uid/mode semantics at all — Windows never reaches that
diagnostic, because it is refused with `PLATFORM_UNSUPPORTED` before `check`
runs) and never repairs it; `init`/`scan` regeneration
produces exact modes again. Pre-existing owner-safe but broader modes remain
attributable — ownership is the state marker, not the mode — so those trees
stay safely regenerable and removable, and rollback restores the exact prior
state directory (renamed back, not re-created), including its prior modes.

For Claude, the private `.skill-router-claude-fingerprint-inputs.json` sidecar
beside the generated tree records the exact path/mode inputs of the generated
fingerprint. It keeps source chmod-only changes reflected in the
fingerprint/version while every installed file stays `0600`. A missing sidecar
means a legacy install that removal still understands; a present but malformed
sidecar fails closed rather than falling back to the legacy algorithm.

## How OpenCode integration works

Skill Router discovers the standard `.claude/skills`, `.agents/skills`, and
OpenCode skill locations plus explicit router sources. It writes only generated
state under `.skill-router/` and adds that absolute generated source to
`.opencode/opencode.json`. The adapter preserves either supported configuration
shape and, for a new file, detects legacy OpenCode 1.x `skills.paths` or native
OpenCode 2.x `skills` arrays from the installed CLI.

Each routed skill is copied into the managed source with
`metadata.opencode/autoinvoke: false`. The source skill is never edited, the
managed copy remains explicitly loadable by ID, and only the small
`skill-router` skill is advertised automatically. Re-running `init` or `scan`
regenerates managed copies from their sources.

Strict JSON configuration is updated automatically. Existing JSONC is parsed
for configured skill sources but is never rewritten: initialization completes
and prints the exact `skills` or `skills.paths` entry to add manually.
`skill-router check`
remains unhealthy until that entry is present.

### Capability resolution

Capability resolution is fixed, bounded, and fail-closed:

1. An existing, valid skills shape in the configuration **always wins** and
   the OpenCode CLI is never spawned to decide it.
2. Otherwise a normal (non-dry) run performs exactly **one bounded
   asynchronous `opencode --version` probe** — 10 s timeout, 64 KiB output
   cap, stdout only, no synchronous variant — and reads nothing but its shape.
3. A recognized `1.x` version selects the object form (`skills.paths`, plus
   `skills.urls`); `2.x` and later select the `skills` array.
4. An unknown or noisy result — a missing binary, timeout, nonzero exit,
   truncated/oversized output, or an unrecognized line — **fails closed** to a
   shape-neutral manual instruction that names neither shape ("make a
   supported OpenCode CLI available … and rerun skill-router"), and **no
   OpenCode configuration is written** in that case.
5. `--dry-run` never probes and never spawns OpenCode.

OpenCode's current published source migrates a v1 `skills` object
(`paths`/`urls`) into the v2 `skills` array; the router accepts both shapes,
never rewrites a document it cannot round-trip (JSONC stays manual), and
claims no compatibility with future OpenCode versions — that migration
describes OpenCode as it stands today, nothing more.

## Harness selection

`init` accepts `--harness opencode|claude|all`, with `--all` kept as a legacy
alias. A fresh `init` without a flag records OpenCode only, existing
installations keep their recorded harnesses, explicit selections are additive,
and state without `installation.json` is treated as OpenCode-only. `add` and
`scan` regenerate every recorded integration, `check` validates only recorded
integrations, and `route` stays harness-neutral: it always returns bare skill
IDs.

## How Claude Code integration works

With the `claude` harness recorded, the router generates a local plugin inside
router-owned state (`.skill-router/claude/`, or
`~/.local/share/skill-router/claude/` globally): an inert plugin manifest, a
local marketplace manifest, and one `skills/<id>/SKILL.md` per enabled skill
rendered from the source document rather than from the rewritten OpenCode
copies. The manifest is inert metadata only — no hooks, MCP servers, commands,
agents, dependencies, or executables. Project installations use the plugin
namespace `openagency-skill-router` at Claude `local` scope; global
installations use `openagency-skill-router-global` at `user` scope, and the
marketplace name is a stable hash of that scope plus the canonical state path.

Registration runs exclusively through the official CLI (`plugin validate
--strict`, `plugin marketplace add --scope`, `plugin install|update --scope`,
`plugin list --json`), so Claude's own settings are never written directly.
Every project/local command executes with `cwd` equal to the `--root` passed to
the router — never the caller's directory — so `local`-scope registration lands
in exactly one `<root>/.claude/settings.local.json` and `check` re-reads that
scope-owned declaration plus the visible registration from the same root. The
marketplace decision compares name, path, and scope first: an unchanged
declaration is skipped idempotently, an absent one is added (and exactly
compensated if the attempt fails), and a same-name declaration at a different
path fails the operation before any mutation — conflicting marketplaces are
never removed or re-added, because they may own unrelated plugins.
`--dry-run` never invokes the Claude CLI, and a failed
registration restores the router and OpenCode state while reconciling observed
Claude state: only references this attempt installed are removed, only the
marketplace it created is removed, and an updated plugin is restored to its
exact prior version and scope — every compensation step verifies its own
result. `skill-router check` verifies the generated tree (bytes and normalized
file modes), the recorded fingerprint, strict validation, and the exact
installed plugin reference at its scope. `SKILL_ROUTER_CLAUDE_BIN` selects the
CLI executable (default `claude`).

Public route and configuration IDs stay bare; the generated Claude router skill
maps every returned skill ID and workflow step to `<plugin>:<id>`.

## Configuration

Project configuration is stored in `.skill-router.json`. Global configuration
is stored in `~/.config/skill-router/config.json`. The generated registry and
managed skill source are under `.skill-router/` for projects and
`~/.local/share/skill-router/` globally. Request ingress does not live in that
replaceable state directory: it uses the owner-private stable spool described
under "Request privacy (stable spool)". The configuration file is the only
public registration interface: the generated registry is internal and is
rewritten by `init`, `add`, and `scan`.

The configuration must stay outside the router-owned state directory, both
lexically and after any existing symlink is resolved. `init`, `add`, `scan`,
and `uninstall` refuse a configuration placed inside state — before writing
anything — and ask you to copy it outside state and retry; read-only `check`
and `route` remain available for diagnosis.

```json
{
  "schemaVersion": 1,
  "sources": ["./team-skills"],
  "include": ["*"],
  "exclude": ["experimental-*"],
  "aliases": { "ship it": "git-release" },
  "skills": {},
  "routing": {
    "minimumScore": 0.55,
    "minimumMargin": 0.15,
    "maxCandidates": 5,
    "allowSequences": false
  },
  "stateDirectory": ".skill-router"
}
```

The router first checks exact IDs and aliases, then uses deterministic local
term scoring. It selects only above both the confidence and margin thresholds;
otherwise it returns `clarify` or `none`. Skill bodies are never placed in the
registry or routing output.

### Root selection (`--root`)

`--root` means exactly one thing for every command. An exact `~` expands to
the router home — `SKILL_ROUTER_HOME` when it is set, otherwise the user home —
and a leading `~/...` expands through that same home (`--root ~/work/site`).
A `~user` prefix is rejected with an error instead of being silently resolved
against the wrong home, and any other `~` stays a literal path character.
There is deliberately no backslash or drive-letter expansion: the Windows
runtime is unsupported.

### Schema version 1

`schemaVersion: 1` stays the default and keeps its original, more permissive
model:

- **Direct source directories.** A declared `skills.<id>.source` may be the
  skill directory that contains its `SKILL.md`, not only the file itself —
  resolved through the same no-follow direct-source resolution schema v2 uses.
  Under schema v1 that declaration is permissive: there is no "must resolve to
  exactly one skill" or ID-match diagnostic, and a declared source that
  discovery never finds stays inert instead of failing the build. Top-level
  `sources` entries keep their existing meaning: a parent directory of
  skills, or a single skill file.
- **Enablement.** `skills.<id>.enabled` is honored live from the current
  configuration, and a live `enabled: false` vetoes routing immediately — it
  is never treated as staleness. Re-enabling a skill that the installed
  registry still records as disabled is *not* live: `route` refuses with
  `Registry skill enablement is stale; run skill-router scan first` and
  `check` reports `enablement-stale` until `skill-router scan` rebuilds the
  registry.

### Schema version 2

`schemaVersion: 1` stays the default; its routing, alias, and workflow
semantics are unchanged, with one narrow identifier-safety exception: in both
schema versions, `skills` keys and alias target values must now be valid
public IDs (see "Public identifiers"). Version 2 is opt-in and adds explicit
skill registration, invocation and applicability policy, and workflow plans:

```json
{
  "schemaVersion": 2,
  "sources": ["./team-skills"],
  "aliases": { "inspect change": "code-review" },
  "skills": {
    "code-review": {
      "source": "./team-skills/code-review",
      "invocation": "advisory",
      "applicability": { "none": ["docs only"] },
      "handoffTo": ["git-release"]
    }
  },
  "routing": {
    "minimumScore": 0.55,
    "minimumMargin": 0.15,
    "maxCandidates": 5,
    "allowSequences": true,
    "mode": "automatic"
  },
  "workflows": {
    "change-gate": {
      "description": "Review a change, then publish the release",
      "invocation": "automatic",
      "applicability": { "any": ["review the change"] },
      "steps": [
        { "skill": "code-review" },
        { "skill": "git-release", "when": "tests passed" }
      ]
    }
  },
  "stateDirectory": ".skill-router"
}
```

### Public identifiers

Skills and schema-v2 workflows share one public, bare ID namespace. An ID is
1–64 characters of ASCII lowercase letters and digits with single hyphen
separators — no leading, trailing, or consecutive hyphens — matching exactly
`^[a-z0-9]+(?:-[a-z0-9]+)*$`. Comparison is exact and case-sensitive: the
router never canonicalizes, normalizes, or lowercases an ID, and a value that
fails the grammar is rejected rather than rewritten. `skill-router` is the
only router-reserved ID, because it names the generated router skill in both
the managed OpenCode source and the Claude plugin. Names such as `synced`,
`anthropic-skills`, `anthropic`, `claude`, `claude-helper`, `verify`,
`simplify`, and `doctor` are ordinary valid IDs in the router-owned
integration — the router reserves nothing beyond `skill-router` — though you
may still avoid IDs that collide with your harness's own existing skills.

Both schema versions validate `skills` keys and alias target values against
this grammar; schema v2 additionally validates workflow keys, workflow step
skills, and `handoffTo` targets. Identifier errors never echo the invalid
value. Alias keys remain free-form request phrases, `include`/`exclude`
entries remain glob patterns, and source paths (including
`skills.<id>.source`) are paths, not IDs — none of them must satisfy the ID
grammar.

Skill IDs are derived from the source layout: a root-level skill file
contributes its basename without `.md`, and a nested or directly selected
`SKILL.md` contributes its parent directory name. Generated frontmatter names
and managed copies use that canonical ID. A directory source's root-level
`SKILL.md` would derive the literal uppercase `SKILL`, which the grammar
rejects: select the file directly instead (when its parent directory is a
valid ID) or move it under `<valid-id>/SKILL.md`.

An invalid or reserved candidate is an error, not a warning: `init`, `add`,
and `scan` — dry runs included — refuse to regenerate while any configured
source contains one, and the candidate is omitted from the registry while
still counting toward source freshness, so fixing or removing the file
changes the fingerprint. `check` reports invalid discovery, and reports a
single bounded `registry-invalid-id` — without joining or using any stored
identifier as a filesystem path — when an installed registry contains one; `route` refuses an
invalid installed registry before scoring. Nothing is lowercased, migrated,
or rewritten automatically.

Existing schema-v1 configurations and installed registries that predate this
contract must be migrated by hand: rename the skill files, directories, or
`skills` keys to valid IDs, update alias targets, handoffs, and workflow
steps to reference the new IDs, then run `skill-router scan` to rebuild the
registry. `skill-router uninstall` stays ownership-driven and remains
available once the current configuration can be loaded, regardless of what an
older registry contains.

`skills.<id>.source` registers a skill directly. It is a local path — the skill
file itself or the skill directory that contains its `SKILL.md` — resolved
relative to the project, from `~`, or as an absolute path. Remote URLs are
rejected, and the path must resolve to exactly one discovered skill whose ID
equals the configuration key.

`invocation` controls how a skill or workflow may run:

- `automatic` (default for skills): eligible for inferred routing.
- `advisory` (default for workflows): never auto-selected. The router returns
  `advise` with a recommendation instead, including for exact IDs and aliases.
- `explicit-only`: excluded from inference, but still selectable by exact ID,
  alias, or as an explicit workflow step.

`routing.mode: "advisory"` additionally downgrades every `select` and
`sequence` to `advise`.

`applicability` phrases are matched against the request on token boundaries:

- `none` vetoes the skill or workflow for that request everywhere: exact IDs,
  aliases, inference, and workflow steps.
- `all` and `any` gate inference, workflow matching, and workflow steps. Exact
  IDs and aliases deliberately ignore positive clauses.
- A workflow is inferred only when it declares at least one `all` or `any`
  phrase. A step's `when` phrase is evaluated against the original request, and
  every workflow keeps at least one unconditional step.

`handoffTo` lists related skill IDs. The router returns them as `handoffs` and
never follows them.

Workflows are advisory planning constructs: ordered steps with optional `when`
phrases. There is no expression language, no nested workflows, no remote fetch,
and no execution state.

Routing precedence is aliases, exact skill IDs, exact workflow IDs, applicable
workflows (several matches return `clarify`), then deterministic local term
scoring. Outcomes are `select`, `sequence`, `advise`, `clarify`, and `none`.

After any configuration edit, run `skill-router scan`. The generated registry
fingerprints discovered skill material and the derived routing policy, so
`skill-router route` refuses a stale policy and `skill-router check` reports
`policy-stale` until the registry is refreshed.

## Reliability contracts (Phase 14)

### Threat model

What these contracts do and do not protect:

- **Crashes and interrupted runs.** Every mutating command journals its intent
  first and is re-enterable, so a process that dies mid-operation is finished
  or rolled back by the next run instead of being left half-applied.
- **Ordinary concurrency.** The exclusive lease, the compare-and-swap against
  observed bytes, and the claim-then-re-prove steps keep two cooperating runs
  (or an interrupted run plus a later one) from interleaving into corrupt
  state.
- **Persistent filesystem ambiguity.** A symlink, a replacement, or an
  unexpected extra hard link already sitting at a path when the router arrives
  is refused by `lstat`/type and identity checks (journal payloads
  additionally pin link topology) rather than followed or overwritten.

What they do **not** protect against: this owner-private local state is **not
an OS sandbox**. A malicious *same-UID* process that precisely races the final
pathname syscalls — `unlink`, `rmdir`, recursive removal, and `rename` — is
outside the guarantee: Node exposes no fd-relative form of those operations,
so nothing binds them to the object that was just verified. The
final-pathname checks described below narrow those windows; **they cannot
guarantee fail-closed behaviour inside them**.

### Strong file identity and fail-closed errors

Every router-owned artifact — the mutation lock and the claims derived from
it, the transaction journal and its payloads, request spool entries, and
managed state — is created, verified, and reclaimed against **strong file
identity** (device + inode). Deletion is attempted **only for the exact
classes below**, and only after an identity check.

Claiming and removing a whole artifact is authorized by an **external durable
attribution record**, never by a pathname alone: the request spool's
`.removal-<nonce>.json` removal record (fsynced *before* anything is
claimed), a recovery claim's sibling `<claim>.json` attribution record (which
outlives its container), and a restoration's `.reserve-<txid>.json`
reservation record each bind the transaction, the exact recorded identities,
and — for claims — the recursive-deletion intent. Re-entry trusts only a
valid record plus the claims it matches — never a bare name or shape — so a
record-less lookalike is never adopted or removed; the journal likewise
records each payload's identity in the journal document, and the spool's
owner-only marker anchors the whole spool removal. Those records and the
identity re-checks around each step **narrow the final syscall window; they
do not close it** (see the threat model above), so read what follows as
exactness for the supported classes — **not** as an identity-bound deletion
guarantee over every window:

- **Regular files** — the journal file, its payloads and transients, lock and
  claim records, control/owner records, and request-spool entries — normally
  use the claim protocol: rename to an unpredictable same-directory claim,
  re-check regular-file type and the same strong identity twice, then unlink.
  Terminal spool-removal, recovery-claim, and restoration-reservation records
  are the bounded exception: after immediate invariant and identity reproof,
  they are directly unlinked and their parent directory is synced so no hidden
  claim can be stranded. The re-checks shrink the final window; they do not
  close it.
- **Empty router-owned directories** (a claim container, the spool directory
  itself) are removed only after a check that they are empty and ours
  immediately before the non-recursive step.
- **Managed-state trees and recorded prior state** are removed only after
  classification proves the ownership marker and the recorded identity, and
  only as a claimed artifact — never by deleting whatever happens to sit at
  the original path.

No other class is deleted by design. An artifact this filesystem cannot prove
— a missing, invalid, or zero identity, a replacement, an unclassified tree —
is **preserved and refused, never deleted** by these code paths (a same-UID
process racing the final pathname syscall is the documented exclusion) and
stays available to a later `recover` run.

**Error privacy.** Request bytes, request bodies, spool tokens, and their
digests are **never** exposed in any error, result, record, or diagnostic —
that guarantee holds everywhere. Path-freedom is narrower and is claimed only
where it is actually guaranteed: the bounded-walker limit refusals, the
request-spool diagnostic vocabulary, the platform refusal, and `check`'s
confidentiality issue codes are fixed and path-free by construction. That is
*not* a property of every message the router prints: some local operational
errors deliberately name the filesystem path you need in order to remediate —
several `RECOVERY_CONFLICT` and `LOCK_COMPROMISED` messages name the claim,
lock, or artifact path they are about. The three codes below are stable and
enumerable; treat their text as operational, not as a promise that no path
appears:

- `LOCK_COMPROMISED` — the lock (or a claim derived from it) names identity
  this filesystem can no longer prove; such a lock is never reclaimed,
  released, or trusted on an unprovable identity.
- `RECOVERY_CONFLICT` — a journal, payload, or recovery artifact does not
  match what was recorded (altered, foreign, wrong type, or unobservable):
  everything is preserved and refused, never "cleaned up".
- `REQUEST-IDENTITY-UNAVAILABLE` — the request spool cannot provide a stable
  file identity on this filesystem, so a spool entry is never renamed,
  consumed, or replaced by path alone.

Persisted journal identity stays the **plain numeric `{ "dev", "ino" }` pair**
— never `BigInt`, never a string, exactly those two keys. An invalid, missing,
or zero identity is never *available*, and an unavailable identity never
equals another identity, so an older record that carries a zero or invalid
pair can never authorize a deletion.

### Fixed traversal limits

Two bounded walkers are in play. They share the same fixed entry and depth
caps — **4096 observed entries and depth 32 (root included)** — and are
bounded separately on bytes. Both run on production limits that are **fixed
and not user-configurable**: no flag, environment variable, or configuration
key can widen them.

**The shared source/support/Claude walker** serves skill-source discovery,
support-tree collection and copy, plan-time document reads, and Claude tree
inspection. It charges **one shared budget across a traversal *and* the file
reads that follow it** (at plan/copy time, across every support tree in that
plan or stage):

| Bound | Value |
| --- | --- |
| Observed entries per traversal | 4096 |
| Directory depth, root included | 32 |
| Bytes per file read | 16 MiB |
| Aggregate bytes per shared budget | 64 MiB |

**Managed-state inspection and stage finalization are separately bounded**
(they carry their own `STATE_TREE_LIMITS`): the same 4096 entries and depth
32, plus a **64 MiB total-tree cap** — the ceiling on the *sum of file bytes
in the owned state tree* being classified, digested, or finalized (and that
walk's per-file read ceiling), not a per-traversal read budget like the
shared one. Exceeding either walker's bound fails the operation outright; it
never downgrades to a partial result.

Traversal streams through `opendir` in deterministic lexical order and counts
every observed entry (`.git` and `node_modules` are counted but never
descended into). **Persistent symlinks and final-component symlinks are
refused rather than traversed**: the root and every child directory is
`lstat`ed before it is opened and re-verified on the same path after the
open, a symlink entry is only ever reported (or skipped) and never opened,
and file bodies go through the no-follow reader that pins the opened file's
identity and size across the read. What those pathname checks cannot exclude
is an **away-and-back ABA across the async open**: Node exposes no
fd-relative (`openat`/`O_PATH`) directory enumeration, so the post-open
verification re-resolves the path — a component swapped away before the open
and restored before it, or swapped between that verification and the
enumeration, is not observable by these checks; content-level certainty comes
from the per-file no-follow reads.

Exceeding a shared-walker bound stops the walk at that moment and surfaces
exactly one path-free reason (`entries`, `depth`, `file-bytes`,
`total-bytes`); for a skill source that becomes a single blocking
`source-limit-exceeded` diagnostic, so **a failure blocks the operation and no
partial inventory or partial fingerprint survives it**.

### Explicitly deferred — not promised in this phase

- **A4c v1 warnings** — deferred and not promised; this phase neither
  implements nor commits to them.
- **A structured `--json` error envelope** — an error is still one bounded
  line on stderr with a nonzero exit code, in both human and `--json` mode;
  only successful results are JSON documents today.
- **Windows enablement** — beyond the `PLATFORM_UNSUPPORTED` refusal above:
  no device-name, long-path, or other Windows filesystem work is in scope.
- **macOS CI** — macOS stays developer-tested only; no macOS job runs the
  suite yet.
- **User-configurable traversal limits** — the fixed bounds above stay fixed.

## Development

```sh
npm test
npm run check
node src/cli.js --help
```

`npm run check` runs `scripts/check.mjs`: it syntax-checks every shipped
source file (`src/*.js`) and release script (`scripts/*.mjs`), then imports
every runtime module in a private sandbox (fresh `HOME`, `CLAUDE_CONFIG_DIR`,
`XDG_CONFIG_HOME`, `TMPDIR`, and working directory), then launches the real
`src/cli.js --version` and requires the exact package version on stdout with
empty stderr. Any file, symlink, or special entry appearing in the sandbox —
for example an import-time write into `HOME` — fails the check.

`SKILL_ROUTER_HOME` can point tests at an isolated home directory. It is an
internal verification affordance, not required for normal use.

### Release gates (Phase 11)

```sh
npm run gate:clean                      # local clean-candidate gate (~2 min)
RELEASE_TAG=v0.1.0 npm run gate:release # validated release artifacts in dist/
```

`npm run gate:clean` (`scripts/clean-candidate.mjs`) proves the *current*
candidate — every tracked and untracked file that is not ignored, exactly as a
fresh checkout would see it — works from a clean clone:

1. candidates come from `git ls-files --cached --others --exclude-standard`
   under an isolated git configuration (empty global/system config) and are
   also enumerated under the ambient host configuration; any disagreement
   between the two sets — for example a host-level ignore rule that would hide
   a file from the deterministic set — refuses the gate generically *before*
   anything is copied, disclosing neither a filename nor any content (a host
   exclusion must be resolved in the repository's own `.gitignore`). Every
   candidate is bound into a complete manifest: validated strict-UTF-8 path,
   type, size, content SHA-256, normalized executable mode, and link count;
   symlinks, hard links (`nlink > 1`), special files, and paths whose ancestors
   are not ordinary, non-symlink directories all fail closed;
2. they are copied through no-follow (`O_NOFOLLOW`) descriptors into a
   temporary Git repository under a gate-owned temp root (prefix `sr-g-*`,
   outside the repository) — the real index is never staged, reset, or written
   — committed there, then `git clone`d into a second temp directory and
   required to be clean, with the manifest's executable modes preserved in the
   staged clone;
3. `npm ci`, `npm run check`, and `npm test` run in that clean clone, whose
   `package.json` — read once through a bounded (256 KiB), no-follow,
   single-link descriptor — must hash to the manifest digest and re-parse to
   the same name/version/bin, so package metadata is bound to the committed
   snapshot rather than to a mutable work tree;
4. `npm pack --json` must report the exact package name/version/filename and the
   required files; the tarball installs into a fresh consumer project with
   `--ignore-scripts`; and exactly `node_modules/.bin/skill-router` — the only
   bin the package metadata contract allows, whose shim must `realpath` inside
   the consumer's `node_modules` and resolve to the declared bin target — must
   print exactly the package version on stdout with empty stderr;
5. the source candidate manifest (re-enumerated and re-hashed), repository
   status, the hashed `.git/index` bytes (located through a strictly parsed
   `gitdir:` file when `.git` is a gitfile), the exact HEAD ref and commit id
   (git's documented quiet exit codes distinguished from real failures), and
   the top-level entries are reconciled before and after on both the success
   *and* failure paths; a pack artifact this run created in a caller-owned
   artifact directory is removed by identity on any later failure; the temp root
   is removed and that removal is proven by inode (path absent, no renamed
   same-inode entry), and a leftover fails the gate.

Every child runs with `SKILL_ROUTER_GATE_ACTIVE=1`, and the gate refuses to
start under that flag when the repository it was pointed at *canonicalizes*
(realpath, not a lexical compare — and a path that cannot be canonicalized is
refused rather than assumed different) to the gate's own repository — so the
gate's own `npm test` cannot launch another gate, and a symlinked or aliased
path to the same repository does not slip through. The check runs before any
temp directory is created. Output is bounded (tail kept) and a passing gate
prints a single summary line.

Trust boundary: this is an integrity and reproducibility gate for *trusted*
candidate code, not an OS sandbox. The code under test is executed with the
gate's own privileges, so it can read anything otherwise available to the OS
user — other processes' environments, host files, and network endpoints — and
no step below claims otherwise. What the gate bounds is the *candidate set* and
the *repository*: what gets copied, what gets executed from where, and what the
real index and HEAD may become. Process containment covers ordinary descendants
that stay in the child's process group — bounded SIGTERM, then SIGKILL, before
the step settles — but intentionally detached or re-daemonized descendants and
hostile same-user filesystem races are not claimed contained, and the gate
never claims an escaped process was killed.

Environment: POSIX only (live Windows process behaviour is structurally tested
only where currently true, no Windows CI job exists, and live Windows
validation is a later gate); `npm ci` needs registry access for the pinned
dependencies; children receive a narrow scrubbed environment with a gate-owned
`TMPDIR` inside the temp root — the ambient `TMPDIR` is never inherited — while
`HOME`, Claude, XDG, router home, git config, and the npm cache also stay
inside that root. That scrubbing strips the *recognized* credential and
configuration channels — npm/git/CI lifecycle variables, tool and cloud
configuration prefixes, and token/secret/key/auth-shaped variable names — and
CI checks out with `persist-credentials: false`, so no repository write token
is deliberately supplied to the jobs that run candidate code. Neither is a
guarantee against a hostile program: a trusted candidate that wants the host's
secrets is outside this gate's threat model entirely. Credentialed, Docker,
model-backed, broad live-platform, and npm-publication validation belong to
later gates. The gate's own tests are `test/gate-lib.test.js`,
`test/clean-candidate.test.js`, `test/release-dist.test.js`, and
`test/release-workflows.test.js` — they require no network, no real
credentials, and no containers.

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run check`, and `npm test`
in a matrix on Node 20 (the declared `engines.node` minimum) and Node 24; one
dependent Node 24 job then runs `npm run gate:clean` once (the gate repeats
check and test inside its own clean clone, so that cost is not paid per matrix
line). Every job is `contents: read` with job timeouts, concurrency
cancellation, and `persist-credentials: false`, so no repository write token is
deliberately supplied to the candidate-running jobs — again a hygiene measure,
not containment. Both CI and the gate need `package-lock.json` in the
candidate set: a lockfile that is missing or ignored fails the gate with an
explicit message, because `npm ci` cannot run without it.

Pushing a `v*` tag (`.github/workflows/release.yml`) first requires an exact
`v<package.json version>` match and resolves `git` to one trusted canonical
absolute path outside the repository (before `dist/` is listed, emptied, or
written, and before either release-level fingerprint runs — a repository-local
fake `git` is refused), then runs the full clean gate with the
repository's canonical `dist/` as the artifact directory (so the tarball is
packed from the validated clean clone), writes `dist/SHA256SUMS` through an
exclusive, no-follow temp file with identity checks, leaves `dist/` holding
exactly those two files, and revalidates them immediately before handoff; any
failure removes only the artifacts this run created — each after its identity
is re-checked — and fails closed when that cleanup cannot be proven. A separate
build job (`contents: read`, checked out with `persist-credentials: false`, so
no repository write token is deliberately present where candidate code runs)
uploads that exact bundle through a commit-SHA-pinned action; a fresh
`contents: write` job — which checks out nothing and runs no candidate code —
downloads it through a pinned action, revalidates the exact two files, sizes,
and digests, refuses an
existing release for the tag, creates the release once, and then verifies the
release carries exactly those two remote assets, checking server-reported
digests whenever GitHub publishes them. External actions are pinned to
immutable commit SHAs. **Nothing is published to npm** — npm publication is
Phase 12.

### npm publication (Phase 12)

**Nothing has been published, and nothing may be published from this
repository right now.** The provisional package name stays
`@openagency/skill-router` under the MIT license; the `@openagency` npm scope
already exists but **our rights to it are unconfirmed**, and the unscoped name
`skill-router` is already owned by an unrelated publisher — it is never used
or suggested here. Every npm credential, bootstrap, and release action is
deferred to a future, explicitly authorized operator step.

The three project links below are also in `package.json` as `repository`,
`homepage`, and `bugs`, so they travel inside every packed tarball:

- `repository`: full object `{"type": "git", "url": "git+https://github.com/Open-Agency-io/skill-router.git"}`
- `homepage`: `https://github.com/Open-Agency-io/skill-router#readme`
- `bugs`: `https://github.com/Open-Agency-io/skill-router/issues`
- `publishConfig`: registry `https://registry.npmjs.org/`, access `public`,
  tag `latest` — fixed, so a publish cannot silently change registry, access,
  or dist-tag

#### 1. Manual bootstrap — future operator only, do not run now

> **Warning.** No command in this subsection may be run today. They document
> the one-time bootstrap an authorized human performs later, in person, with
> 2FA. npm staged publishing *can* create a package that does not exist yet,
> but this repository's OIDC design cannot: npm only accepts a trusted
> publisher for a package that is already on the registry, so a manual
> bootstrap has to come first — and it is the only step that publishes
> anything at all. The bootstrapped first version therefore **cannot carry
> trusted-publisher/OIDC provenance**: it is published by a person with 2FA.
> Later public versions staged through the workflow below do get npm's
> automatic provenance, provided the repository and the package are public.

0. **Stop unless the scope rights are confirmed.** The `@openagency` scope
   exists and our rights to it are unconfirmed. Until ownership is confirmed
   in writing, do not proceed past this point — nothing below may be run, and
   no alternative (unscoped) name may be used: `skill-router` is owned by an
   unrelated publisher.
1. Work in a **fresh, empty directory** of its own — never in a checkout or a
   directory that already holds assets — and fetch the *existing* release,
   then confirm it is exactly the release you intend and that it carries
   exactly two assets before downloading anything:

   ```sh
   mkdir fresh-bootstrap && cd fresh-bootstrap     # a directory of its own
   gh release view v0.1.0 --repo Open-Agency-io/skill-router \
     --json tagName,isDraft,isPrerelease,assets \
     --jq '{tag: .tagName, draft: .isDraft, prerelease: .isPrerelease, assets: [.assets[] | {name, size, digest}]}'
   gh release download v0.1.0 --repo Open-Agency-io/skill-router --dir release-assets
   ls -A release-assets        # exactly two entries: openagency-skill-router-0.1.0.tgz and SHA256SUMS
   ```

   Expected: `tag` = `v0.1.0`, `draft`/`prerelease` both `false`, and exactly
   the two assets above with sensible sizes. Anything else stops the
   bootstrap.
2. Check the digest **without ever handing the checksum file a path to
   follow**: hash the tarball file itself and read `SHA256SUMS` as text,
   comparing the two by eye. Never pipe `SHA256SUMS` into
   `sha256sum --check` (or any checker): its second field is a file name, and
   a tampered copy could name some other file entirely.

   ```sh
   sha256sum release-assets/openagency-skill-router-0.1.0.tgz
   cat release-assets/SHA256SUMS      # the same 64 hex characters, then two spaces, then the file name
   ```

3. Publish **exactly that tarball file** — never a directory, never a repacked
   or re-zipped copy — with lifecycle scripts disabled, under 2FA:

   ```sh
   npm publish ./release-assets/openagency-skill-router-0.1.0.tgz --access public --tag latest --ignore-scripts
   ```

   `--ignore-scripts` is mandatory: the tarball must reach the registry byte
   for byte exactly as the release gate validated it, so no install, prepare,
   prepack, or prepublish script can run on the way in. Publishing a
   *directory* would repack the package and destroy that guarantee.

4. Confirm what landed: `npm view @openagency/skill-router version`.

There is deliberately no `prepublishOnly`, `prepare`, `prepack`, or any other
lifecycle script in `package.json`: publication runs no repository code at
all, and the workflow below refuses to stage a tarball that carries one.

#### 2. Configure the npm trusted publisher (inside npm's allowed bootstrap)

npm staged publishing can create a brand-new package, but **this OIDC design
cannot**: the trusted publisher is what lets the workflow mint an npm identity,
and npm only accepts one for a package that already exists on the registry.
So this step comes strictly after the bootstrap, and only once the scope rights
are confirmed. Configure npm's trusted publisher within npm's own supported
configuration flow:

- repository: `Open-Agency-io/skill-router` (exact casing — the GitHub OIDC
  subject must match it),
- workflow filename: `publish-npm.yml` (npm requires the exact filename),
- permission: **stage-only**, so the identity can stage a version but never
  publish one.

#### 3. The manual staging workflow

`.github/workflows/publish-npm.yml` is `workflow_dispatch`-only: it never runs
on push, tag, release, or schedule, and the job holds exactly `contents: read`
and `id-token: write`. Its only credential is the read-only `github.token` —
no npm token and no long-lived token of any kind. When an operator runs it
with an existing release tag it:

1. refuses to run unless `GITHUB_REPOSITORY` is exactly
   `Open-Agency-io/skill-router`, and requires the tag to be an exact stable
   `vX.Y.Z` (no prerelease can stage `latest`);
2. pins npm to exactly 11.20.0 (staged publishing needs npm ≥ 11.15 with Node
   ≥ 22.14; trusted publishing needs npm ≥ 11.5.1) and fails on any other
   version;
3. queries the release and its **complete asset list first** — exact tag, not
   draft, not prerelease, exactly `openagency-skill-router-<version>.tgz` and
   `SHA256SUMS`, no extras/missing/renamed/duplicates, each size inside a
   strict bound, and each server `sha256:` digest recorded when GitHub
   publishes one — and only then downloads those two assets with the built-in
   `gh` and the read-only `github.token`;
4. requires exactly two ordinary non-symlink files under exactly the promised
   name, and reconciles downloaded names, sizes, and server digests against
   the release contract;
5. runs a strict verifier, written to the runner workspace from fixed script
   text, that reads `SHA256SUMS` and the tarball by descriptor (bounded,
   `O_NOFOLLOW`, single-link, identity/size/mode re-checked around the read),
   accepts only the exact one-line `64-hex + two spaces + expected file name +
   newline` form — **no path from the checksum file is ever opened** — hashes
   the tarball it already holds, decompresses **exactly one gzip member** —
   the fixed header, one raw DEFLATE stream consumed exactly, and one CRC32 +
   ISIZE footer are parsed and verified in-process, so a concatenated second
   member (empty or not) or any trailing byte is refused — parses the archive
   strictly in memory (POSIX
   ustar only, no pax/GNU/link/device members, canonical `package/…` names,
   no duplicates, bounded members and sizes, directory members with no body,
   exact terminator, no extraction), and reads `package/package.json` to check
   name, version == tag, the full
   repository object, homepage, bugs, exact `publishConfig`, and the absence of
   any lifecycle script;
6. re-runs that same verifier immediately before staging — re-reading both
   files by descriptor and comparing size, digest, and mode against the
   recorded values — and only then runs exactly
   `npm stage publish "./release-assets/<tarball>" --access public --tag latest --ignore-scripts`.

   What that does and does not prove: the immediate revalidation catches
   ordinary drift between the two steps (both files are re-read through a
   bounded, `O_NOFOLLOW`, single-link reader that re-compares identity, size,
   mode, link count, and timestamps before and after the read), but **no check
   can atomically bind the verifier's successful exit to npm's *later* open of
   the same pathname** — a hostile concurrent same-user writer inside that
   window, and hostile same-user writers generally, are outside this control.

Authentication to npm is OIDC trusted publishing: **no npm token and no
long-lived token exists in the job** — no `NODE_AUTH_TOKEN`, no `NPM_TOKEN`,
no `_authToken` value. `actions/setup-node`'s `registry-url` does write a
runner-side npmrc that *names* `${NODE_AUTH_TOKEN}` as a placeholder (via
`NPM_CONFIG_USERCONFIG`); that variable is never set here, so the placeholder
stays empty and npm authenticates through OIDC instead. npm attaches provenance
to the staged version automatically for that identity, provided the repository
and the package are public. The version is now **staged, not public**:
approving it is a separate, manual npm-maintainer action that requires 2FA
(`npm stage approve <stage-id>` or the npm website). This repository never
approves, and never can approve, its own staged release.

### Container harness testing (Phase 1 substrate, Phase 2 cases)

The container matrix runs each harness in a fresh, isolated container. Phase 2
wires the production `run` command to execute the seven manifest cases — one
fresh container per case — through the canonical lifecycle below.

```sh
npm run container:list    # case/harness/version matrix, digest-pinned base
npm run container:plan    # dry run: pack-once + one hardened docker run per case
npm run container:pack    # pack the artifact once, print sha256
npm run container:build   # stage context, build images, record+inspect image ids
npm run container:smoke   # full lifecycle, then verify exact versions in one
                          # fresh credential-free container per harness; the
                          # v1 image additionally proves its *system* ripgrep
                          # executes under --network=none (no download)
npm run container:run     # execute the seven cases (needs model envs + keys)
npm run container:auth-check
                          # credential-free fake-auth validation: one
                          # --network=none container per OpenCode image with a
                          # *generated* dummy credential directory mounted (no
                          # model call, never the real host file); both pinned
                          # images must report recognition=listed
npm run test:container    # focused matrix/security/lifecycle/case tests (also in npm test)
```

Enclosing lifecycle (shared by `build`, `smoke`, `run`): private temp dir ->
stage a minimal build context of exactly four audited files (`Dockerfile`,
`container-verify.mjs`, `run-case.mjs`, `router-wrapper.mjs`, so the Docker
daemon never receives the repository, the rest of `scripts/`, HOME, or any
secret) -> `npm pack`
once -> hash/lock the artifact -> build with `docker build --iidfile` and
inspect labels/OS/architecture host-side -> execute containers sequentially by
immutable `sha256:` image id with `--pull=never` -> forced `docker rm -f`
cleanup whose exit status is inspected (success and explicit
already-absent/no-such-container count as cleaned; anything else keeps the
target and cidfile tracked for retry and fails the command) -> a final
label-based sweep (`docker ps -aq` by the exact run label, force-remove, then
re-list to prove absence; it fails closed if Docker cannot prove absence) ->
remove the temp dir in the finally path. `--rm` remains as a second layer, and
`SIGINT`/`SIGTERM`/`SIGHUP` handlers force removal of active containers.
Success output such as `cleanup: verified … 0 remaining` is only printed after
the sweep verifies absence; cleanup failures make the command exit nonzero.

Credential handling inside that lifecycle: the interruption handlers are armed
**before** any credential file exists (and therefore before pack/build), the
credential directory is registered for cleanup **before** its first byte is
written, and snapshot creation removes any partial file/directory it leaves
behind. That interruption handling is held under an explicit **lifecycle lease**:
it stays armed regardless of the active container count — between sequential
cases, while reports are parsed, and after the final container — until
`finalizeLifecycle` explicitly releases it, so per-container cleanup can never
open an interruption gap and no handler outlives finalization.

Finalization runs in a fixed order: force-remove every container of this run
and prove absence with the label sweep, **then** scrub the credential directory
(never delete the path while a container may still be mounting the inode), and
only then handle the non-secret temp dir. The scrub happens on success, with
`--keep`, on execution failure, and on container-cleanup failure; a scrub
failure is itself a hard, non-zero failure.

Honest limits on those guarantees:

- **Absence is only ever claimed when the sweep proved it.** `cleanup: verified`
  is printed only after the label sweep could not find a single container of
  this run. If Docker cannot prove absence, the command fails instead, and the
  failure text explicitly states that a leftover container may still hold the
  already-mounted credential inode — with its bytes — even though the host
  credential paths were scrubbed.
- `SIGKILL` and a host crash/kill -9 cannot run handlers: a credential
  directory in a retained temp dir (`--keep`) may survive, so scrub the temp
  dir manually if the runner is killed that way. `SIGINT`/`SIGTERM`/`SIGHUP`
  are handled on a best-effort basis only.
- The Docker daemon and anyone who can administer it (root on the host) are
  trusted and outside the guarantee: `docker inspect` prints a container's
  environment (including inherited secret *names/values*) for as long as that
  container exists, which is exactly why containers are removed before the
  credential scrub and why live containers are kept short-lived.
- The host credential file itself is only ever read through a no-follow
  descriptor and never mounted; the mounted copy exists inside one private
  temp directory that this runner removes.

Every host-side subprocess (npm pack, docker build/probe/inspect/ps/rm) runs
with a credential-free environment derived by deleting the global secret
allowlist. Only Docker case commands receive an environment built from that
safe base plus exactly the case's selected secret names (required for
`--env NAME` inheritance); smoke/build/probe/inspect never see a provider key.

Execution ownership: the production runner owns Docker execution. `run` builds
the canonical argv with `runSpecToArgv(spec)` and refuses any argv that is not
deep-equal to it (plus duplicate/conflicting option and unsupported-option
checks: no `--cap-add`, no repeated `--user`/`--network`, no conflicting
labels/env/tmpfs/mounts). The typed spec has exactly one optional extra field
beyond the artifact bind: `auth`, the read-only OpenCode credential directory at
the fixed `/input/opencode-credential` destination (exactly `auth.json` +
`auth-import.json` inside), allowed only for OpenCode case specs whose source
**is** this invocation's credential directory — Claude and smoke specs must have
none, and a duplicate, nested, foreign, repository, or HOME source is rejected
before the image boundary. Adapters may inject only a typed
*in-container*
command (`caseCommander`) or observe the validated case report summary
(`caseReporter` — never raw container output); low-level injection stays at
the command executor used by tests. `run --no-build` is forbidden (live cases
must build and verify their own immutable image ids); `build --no-build` and
`smoke --no-build` remain credential-free tag resolution.

Phase 2 case execution: `npm run container:run` executes all seven manifest
cases (OpenCode v1 select/none, OpenCode v2 select/none, Claude
control/select/none), one fresh container each, through `executeRun` with the
same cleanup/sweep guarantees. Each case container runs
`/usr/local/lib/skill-router/run-case.mjs`, which verifies the mounted
artifact's sha256 against the lifecycle-locked hash, installs only the packed
artifact into `/opt/skill-router-install`, creates only its own `release`
fixture under `/workspace/project`, proves `init`/`check`/registry/managed
files (and the OpenCode `skills.paths`/`skills` array config shape), runs
exactly one harness invocation, and asserts the ordered structural chain
(router skill load -> completed filesystem write proof at the exact
project-local stable spool path
`/workspace/project/.skill-router-requests/<32hex>.txt` with bytes equal to the
request -> exactly one managed route invocation
`skill-router route --json --root . --request-token <32hex>` with an exit of
exactly 0 and a whole-value JSON result -> release load + hidden marker for
select, or abstention for none). The write proof accepts
the `write` tool or the pinned OpenCode v2 `patch` tool (`{patchText}` in the
`*** Begin Patch` / `*** Add File` / `*** End Patch` dialect): a patch counts
only when it is a single completed section that creates (or provably creates
from an empty file) exactly that file with the exact request bytes — a single
trailing newline is tolerated because the pinned tool appends one — occurs
before the route, and carries the same token. Any shell/bash command naming a
request spool is rejected in every form — relative, `./`-prefixed, absolute,
quoted, or backslash-separated — for the stable spool **and** for the retired
legacy `.skill-router/requests` path, which is detected as suspicious input and
never accepted as proof; the same two-path denial applies to Claude Bash calls.
Wrong tool/path/content/token, a write into a nested, copy, or legacy
directory, failed or out-of-order writes, duplicate writers, multi-file,
delete-only, rename, malformed, and mere mention of the path are all rejected,
and `read`/`grep`/`glob` observations of the path never satisfy the proof. The
extracted route JSON is non-echoing too: a `request` field, the sentinel
request bytes, or the token anywhere in the router result fails the case, so
only the write event and the route command may carry them. Claude select/none run the packaged CLI as
`skill-router init --harness claude`, which generates the production plugin
under router-owned state at
`/workspace/project/.skill-router/claude/plugins/openagency-skill-router`: an
inert `.claude-plugin/plugin.json` (metadata only: no paths, hooks, commands,
agents, or executable declarations) plus `skills/{skill-router,release}/…`
rendered from the *source* skill documents rather than the rewritten OpenCode
copies. Registration runs through the official CLI with `cwd` equal to the
router root, so the project owns exactly one `.claude/settings.local.json`
declaration while the CLI cache stays in a scratch `CLAUDE_CONFIG_DIR` outside
HOME. That generated plugin directory is the only plugin source and is passed
exclusively as
`--plugin-dir /workspace/project/.skill-router/claude/plugins/openagency-skill-router`
for routed cases — `--add-dir` skill discovery is suppressed by
restricted/project setting-source semantics and `--restricted` ignores
project/local settings anyway, which is why the explicit plugin is required.
The plugin namespace is the production `openagency-skill-router`, so the Skill
tool must name the canonical IDs `openagency-skill-router:skill-router` and
`openagency-skill-router:release`, while the public `.skill-router.json`
IDs and the route result `release` stay bare. The exposed tool set stays
restricted by `--tools Skill,Write,Bash` while the scoped `--allowedTools`
permission rules are retained; Claude runs non-bare (no `--bare`) so the
`claude setup-token` credential (inherited by name as `CLAUDE_CODE_OAUTH_TOKEN`)
is honoured, with `--permission-mode dontAsk` and `--permission-prompts none`
making every non-allowlisted request a deterministic denial instead of a prompt,
plus `--restricted` (confine file tools to the working directories incl. the
generated plugin, ignore user/project/local settings files, refuse
`bypassPermissions`) and `--strict-mcp-config` (only `--mcp-config` servers
count, and none are passed). The full generated plugin manifest is captured and
re-verified after the model run (every relative path, type, byte size, and
sha256 must be unchanged), the project registration file must be byte-identical
afterwards, and the managed policy surface under `/etc/claude-code` must be
absent before launch. The
pinned Claude 2.1.291 `system/init` event must report exactly two built-in
plugins — `cc-plugin-agents-md` and `cc-plugin-plugin-authoring`, both at path
`builtin` — plus the generated plugin at the exact
`/workspace/project/.skill-router/claude/plugins/openagency-skill-router` path
for routed cases (control reports only the two built-ins). The control case
initializes nothing and passes no `--plugin-dir`, and the runner asserts
project, HOME, and config surfaces expose no router skill (and no Claude
settings/hooks/commands/agents/plugins/MCP of their own) before launch, so
unavailability is observed structurally rather than assumed. The container emits exactly one compact JSON
report; the host validates every field (case/harness/scenario, locked artifact
hash, `sessionCount: 1`, exact chain, outcome/skill id, container freshness)
and prints one concise sanitized success line. Raw stdout/stderr, prompts,
model content, credentials, session ids, request tokens, and absolute paths
never leave the container.

#### OpenCode v1: system ripgrep for the Skill tool

The v1 Skill tool enumerates a skill's companion files through
`Ripgrep.Service.find`, and OpenCode's ripgrep resolver prefers a system `rg`
but otherwise **downloads** one into `Global.Path.bin`. Every writable tmpfs
in this harness is `noexec`, so a downloaded copy can never execute. That is
the root cause of the `skill:error:skill-router` / `skill:error:release`
failures: reproduced credential-free in the pre-fix image with
`opencode debug rg files` in a fresh project under `--network=none`
(`ripgrep execution failed`, exit 1), while `opencode debug skill --pure` still
listed all three skills — config and registration were never the problem.

The `opencode-v1` target therefore installs Debian `ripgrep` into the
read-only rootfs, still as root and before `USER node`, with apt lists and
caches removed, pinned exactly (`ARG RIPGREP_VERSION=13.0.0-4+b2`, mirrored by
`harnesses["opencode-v1"].ripgrep` in `test/container/matrix.json` and asserted
against the Dockerfile by `test/container-plan.test.js`). Because
`rg --version` reports the crate version (`ripgrep 13.0.0`) rather than the
Debian revision, the reported major is bounded separately
(`RIPGREP_MAJOR=13`). The `opencode-v2` and `claude` targets install nothing
extra and never reference `/usr/bin/rg`; tests assert that isolation.

Proof, all credential-free and network-free:

- **build time** — the target asserts the exact `dpkg` version, a regular
  non-symlink root-owned `0755` `/usr/bin/rg`, and `rg --version` matching the
  bounded major; the baked-in verifier then executes that `rg` *as uid 1000*
  and runs a real `opencode debug rg files` over a fresh writable project
  containing exactly one harmless file, requiring the file to be listed and
  requiring **no** `rg` copy to appear in the probe root, `HOME`, or any XDG
  root.
- **smoke** — the same verifier runs inside the `--network=none`, non-root
  smoke container and emits the neutral `ripgrep: "system-ok"` verdict (plus
  its reported version) in the JSON report the harness parses; a missing or
  non-executable system `rg`, a version or ownership/mode drift, or any
  materialized download fails the run with a structural message.
- **no fallback counts as proof** — the download path is rejected outright, so
  `--network=none`, `noexec`, uid 1000, `--read-only`, and the mount layout all
  stay exactly as they were.

If Debian later re-points bookworm's `ripgrep` to a new binNMU revision, the
build fails closed on the exact pin (override with `--build-arg
RIPGREP_VERSION=...`, still bounded by `RIPGREP_MAJOR`) rather than silently
falling back to a runtime download.

Route execution is fail-closed end to end:

- **Immutable image-layer wrapper: no runtime-created executables.** Every
  writable tmpfs this harness mounts — `/tmp`, `/workspace`, `/home/node`, and
  `/opt/skill-router-install` — is explicitly `noexec` (empirically Docker
  Desktop reports `noexec` for all four even when it is omitted), and nothing
  ever executes from them: harness binaries live in the read-only rootfs and
  node only *reads* package files. Package storage is therefore treated as
  non-executable, so the package `.bin`
  (`/opt/skill-router-install/node_modules/.bin/skill-router`) is never placed
  on PATH. Instead `scripts/router-wrapper.mjs` is COPY'd into the image at
  `/usr/local/bin/skill-router` — root-owned, mode 0555, digest pinned in both
  the Dockerfile and the runner — shared by all three targets and re-checked
  after each target's global package install. That tiny wrapper re-invokes the
  known container Node binary with the fixed package bin and forwards
  `process.argv.slice(2)` and a numeric exit status unchanged: no shell, no
  interpolation, no environment or user input. Before any model process the
  case runner verifies it with `lstat`/read (regular non-symlink, image-root
  owner, mode no more permissive than 0555 and usable by uid 1000, sha256 equal
  to the pinned source digest) and fails closed with fixed messages that print
  no path, content, or hash; then it runs a status-only `skill-router --version`
  with that same PATH-scoped environment and `cwd=/workspace/project`,
  requiring spawn success and exit status 0 while discarding stdout/stderr — no
  value or version string is ever reported. `/usr/local/bin` is prepended to
  child PATH **exactly once** (incoming PATH preserved, any direct package
  `.bin` entry stripped), and the router env, OpenCode child, Claude child, and
  preflight share that PATH. Case runs are uid 1000 on a `--read-only` rootfs
  and cannot alter the wrapper; no `chmod`, mount, or package file is relaxed
  to make it work. Image smoke cannot execute `skill-router --version` (the
  router package is only installed at case runtime), so the executable proof is
  this in-case preflight plus the build-time executability probe in the
  Dockerfile — the smoke run does not claim it.
- **Exactly one managed route invocation.** The command must be structurally
  equivalent to `skill-router route --json --root . --request-token <32hex>`
  (the managed `--global` form is accepted too). Only whitespace and argument
  ordering may vary; pipes, redirects, chaining/background operators,
  command/variable substitution, wrappers or absolute paths, unknown options,
  extra positionals, missing/duplicate flags, a non-`.` root, and duplicate
  route attempts are rejected — as are commands that merely quote or grep the
  phrase. Failures name neither the command nor the token.
- **Route exit and output.** When the shell event carries its metadata block,
  the exit must be an integer exactly `0` (v2 can settle `completed` with a
  nonzero exit; legacy events without that block keep their previous contract).
  The result is the *whole-value* JSON object from the canonical `state.output`
  or, when absent, from exactly one documented text item in the nested content
  array — never brace-scanned, never prose, never ANSI-stripped, capped at
  64 KiB, and rejected when absent, oversized, ambiguous, or conflicting. A
  `command` field, when present, must equal `"route"`.
- **Bounded parse diagnostics.** A route-output parse failure attaches at most
  4 candidate events with a fixed key set: allowlisted field names only, and
  value types, string byte lengths, array lengths, and a content-item
  key/type/text-length inventory — never a command, output, text, path, token,
  or secret-shaped value, in the failure report or anywhere else.

Required environment before `container:run` starts any subprocess (there is no
default billable model, and missing inputs fail before pack/build/container):

```sh
SKILL_ROUTER_OPENCODE_MODEL=provider/model  # strict provider/model; the provider must be
                                            # an audited providerKeyMap id from matrix.json:
                                            # anthropic, openai, openrouter, deepseek,
                                            # mistral, groq, xai, together
                                            # (google/gemini are not mapped -> rejected)
SKILL_ROUTER_CLAUDE_MODEL=sonnet            # Claude alias sonnet/opus/haiku or an
                                            # Anthropic id like claude-sonnet-4-5;
                                            # OpenCode provider/model syntax is rejected
CLAUDE_CODE_OAUTH_TOKEN=...                 # Claude non-bare setup-token auth; select it with
npm run container:run -- --secret-env CLAUDE_CODE_OAUTH_TOKEN \
  --secret-env OPENAI_API_KEY               # the key must match the OpenCode
                                            # model's provider (providerKeyMap)
# …or satisfy the OpenCode provider with an explicit legacy auth snapshot
# (no key selected; the provider must be carried by the snapshot):
npm run container:run -- --secret-env CLAUDE_CODE_OAUTH_TOKEN \
  --opencode-auth-file "$HOME/.local/share/opencode/auth.json"
# Claude cases no longer require ANTHROPIC_API_KEY: an API key never satisfies
# their preflight and is never passed to a Claude container
```

Claude credentials (`claude setup-token`):

```sh
claude setup-token                          # run once, interactively, where you
                                            # are already logged in to Claude Code
```

- It prints a long-lived `CLAUDE_CODE_OAUTH_TOKEN` (about one year) for scripted
  subscription use. Revoke it any time from your Anthropic account settings
  (revoke the token, then run `claude setup-token` again for a fresh one);
  treat it like a password because it carries your subscription.
- Export it **only in the shell/CI server that launches the runner**
  (`CLAUDE_CODE_OAUTH_TOKEN=... npm run container:run -- ...`). Never paste or
  store it in the repository, a file, an issue, a chat, or any generated
  artifact: it is not in `matrix.json`, never appears on argv (containers
  inherit the *name* with `--env=CLAUDE_CODE_OAUTH_TOKEN`), and every plan,
  audit, success, and failure line is sanitized so the value cannot leak.
- `--bare` is deliberately not used: bare mode ignores
  `CLAUDE_CODE_OAUTH_TOKEN` and would force API-key auth, so Claude cases run
  non-bare with the explicit model, `--no-session-persistence`, and the
  permission flags above.
- Non-bare stays hermetic here because nothing else is discoverable: each case
  gets a fresh tmpfs `HOME`, a fresh empty `CLAUDE_CONFIG_DIR` under it, a
  generated project whose only Claude surface is the single
  `.claude/settings.local.json` written by local-scope registration (never
  `.claude.json` or `.mcp.json`, and none at all for control), no host
  config/settings mounts (only the packed artifact is mounted read-only), no
  session persistence, exact tool exposure, and only the generated
  `/workspace/project/.skill-router/claude/plugins/openagency-skill-router`
  plugin via `--plugin-dir` for select/none — control initializes nothing and
  gets neither `--plugin-dir` nor a plugin. `--restricted` drops
  project/local settings for the model run, so the runner asserts those
  surfaces are clean before launching Claude and the generated plugin is the
  only skill surface in play.

OpenCode credentials (explicit legacy `auth.json` snapshot):

```sh
# one-time: point the runner at your existing OpenCode credentials file
npm run container:run -- --secret-env CLAUDE_CODE_OAUTH_TOKEN \
  --opencode-auth-file "$HOME/.local/share/opencode/auth.json"
# same input via the environment (the flag wins when both are given):
SKILL_ROUTER_OPENCODE_AUTH_FILE="$HOME/.local/share/opencode/auth.json" \
  npm run container:run -- --secret-env CLAUDE_CODE_OAUTH_TOKEN
```

- **Explicit only, never defaulted.** Without `--opencode-auth-file` /
  `SKILL_ROUTER_OPENCODE_AUTH_FILE` nothing is read and OpenCode cases fall
  back to `--secret-env <mapped key>`; with it, the file is opened **once**
  with `O_RDONLY | O_NOFOLLOW` (a platform without no-follow semantics is
  refused rather than downgraded), every check and the byte read happen on that
  same descriptor with a second `fstat` proving type/size/mode did not drift,
  and the file must be a regular owner-only file (`chmod 600`, no group/other
  bits), fit a 65536-byte bound, and parse as a strict JSON object whose entries
  are lowercase provider ids with a valid `type`. Supported providers must carry
  convertible credential material (`api`/`wellknown` key, or `oauth` with
  refresh+access) so nothing fails later inside a container. Validation happens
  *before* any npm/Docker subprocess; every failure message is structural and
  never carries the path, the content, or a value.
- **Provider matching and auth-mode precedence stay explicit.**
  `SKILL_ROUTER_OPENCODE_MODEL` is still required in strict `provider/model`
  form, and the selected provider decides the mode with deterministic
  precedence:
  1. **environment** — if that provider's mapped `providerKeyMap` key is
     selected with `--secret-env` *and* usable (present, ≥ 8 chars), the key
     wins: the supplied auth file is **never read**, no snapshot is created and
     nothing is mounted, even when `--opencode-auth-file` was given. A key that
     is selected but unusable is an error, never a silent fallback to the file.
  2. **snapshot** — otherwise an explicitly supplied auth file is read (at most
     once, before any subprocess) and used only if it carries the selected
     provider from the fixed support list (`openai`, `opencode-go`).
  3. otherwise an actionable preflight issue (missing/short key, unsupported
     provider). An unrelated key or an unknown file entry never satisfies
     anything, and google/gemini remain rejected.
- **OAuth refresh policy.** An `oauth` snapshot credential is a single
  immutable copy of a rotating refresh token, and the host file is never
  written back. The rule applies to the **selected** (and therefore mounted)
  provider entry only: it is accepted when **exactly one** filtered OpenCode
  case is selected, and a full or multi-case selection with that OAuth entry is
  rejected during preflight (zero subprocesses) with the rotation rationale.
  API credentials (`type: "api"`, e.g. the intended `opencode-go` account) may
  run all four OpenCode cases, and the mapped env-key mode is unaffected.
- **One fixed, provider-filtered credential-directory mount.** After preflight
  chooses snapshot mode, the selected provider's entry is written exactly once
  into this invocation's private credential directory (directory mode 0700,
  files mode 0600), each file read back and byte/hash compared, and the
  directory must then contain exactly two files: `auth.json` (a legacy document
  carrying **only** the selected provider) and `auth-import.json` (the
  generated v2 `Credential.Entry[]` for exactly that provider, with
  deterministic non-secret ids derived from the provider id). Unrelated
  providers, values, and labels from the host file are never copied — a mixed
  `{openai oauth, opencode-go api}` file with an `opencode-go/*` model yields
  files that contain no OpenAI material at all. Only that directory is mounted
  — read-only at the fixed `/input/opencode-credential` destination, for
  OpenCode case specs only. Claude cases, smoke runs, and `plan` never receive
  it (the Claude case runner asserts the mount is absent). The original file is
  never mounted, moved, or re-read, and no host config directory, settings file,
  or OpenCode database is ever mounted.
- **Inside the container, before the harness starts** (and before anything else
  can initialize the OpenCode credential database):
  - **v1** copies the mounted `auth.json` into the fresh tmpfs
    `<XDG_DATA_HOME>/opencode/auth.json` (mode 0600) and requires
    `opencode auth list` to name the selected provider;
  - **v2** runs `opencode auth import /input/opencode-credential/auth-import.json
    --standalone` (exit status 0 required) against its fresh tmpfs database and
    then requires `opencode auth list --standalone` to name the selected
    provider. The legacy file is deliberately not staged for v2, so the only
    credential path is that explicit import.

  In both cases the verdict must be `recognition="listed"`; an empty listing
  fails, and the mounted file must carry **exactly** the selected provider (an
  unfiltered or malformed credential file is rejected before the harness runs).
  Raw stdout/stderr (paths, account labels) never cross the boundary, and every
  refresh stays in tmpfs.
- **Cleanup is ordered and truthful**: containers are force-removed and absence
  is proven first, then the credential directory is scrubbed (never the other
  way round), including under `--keep`, execution failure, container-cleanup
  failure, and best-effort signal handling; a scrub failure exits non-zero. If
  Docker cannot prove absence, the runner still scrubs the host paths but
  **never claims cleanup/absence**: the failure text states that a leftover
  container may still hold the already-mounted credential inode (and its bytes)
  even after the host-path scrub. See the lifecycle limits above for what is
  *not* guaranteed (`SIGKILL`/host crash, Docker daemon/root, and
  `docker inspect` exposing a live container's environment).
- **Audit stays neutral.** The JSON audit carries only
  `auth: { mode: "snapshot" | "environment" | "none", providers: [provider] }`
  — the mode plus the single selected provider id (validated, structural
  metadata; environment mode reports the provider the mapped key satisfied) —
  and renders the credential directory in argv as `[opencode-auth-dir]`; the
  original path, credential paths, file contents, hash, account labels, and
  values never appear in plan, audit, success, or failure output.
- **Credential-free validation seam**: `npm run container:auth-check` builds a
  *generated* dummy `openai`/`opencode-go` document (never a real host file),
  pushes it through the same validation + snapshot path, and runs one
  `--network=none` container per pinned OpenCode image; staging/import happens
  before any other OpenCode invocation, and **both** images must report
  `recognition=listed` (no weaker verdict exists) without any model request.

Provider -> key binding comes from `providerKeyMap` in `test/container/matrix.json`;
an unrelated selected key never satisfies the requirement, and a validated auth
snapshot satisfies only its own fixed provider list (`openai`, `opencode-go`).
`--case` and `--harness` filters narrow the selection and the preflight follows
both (a Claude-only run never demands OpenCode model/provider inputs and never
reads the auth file even when one is requested, and an OpenCode-only run never
demands Claude inputs). `plan` still reports missing secrets/models without
executing anything. The JSON audit includes `freshness`
(seven unique container names, one case per container, unique cidfiles),
per-case labels/argv, and each validated case report.

Requirements: Docker 20.10+ with BuildKit (`docker build --help` must list
`--iidfile`, `docker run --help` must list `--pull` and `--cidfile`) and Linux
containers. Pins live in `test/container/matrix.json`: harness versions
overridable with `SKILL_ROUTER_OPENCODE_V1_VERSION`,
`SKILL_ROUTER_OPENCODE_V2_VERSION`, `SKILL_ROUTER_CLAUDE_CODE_VERSION`; the base
image is pinned by multi-architecture manifest digest
(`node:22-bookworm-slim@sha256:...`, re-verify with `docker buildx imagetools
inspect`). `SKILL_ROUTER_CONTAINER_BASE_IMAGE` overrides it and is reported in
output as a weakened reproducibility claim; `SKILL_ROUTER_IMAGE_PREFIX` renames
images. Exact package and binary versions, the harness id, uid/gid, and
runtime OS/architecture are verified inside each container and re-validated
host-side (a report is never trusted on `ok: true` alone). Coverage is the
native daemon architecture only (e.g. `linux/arm64`), not all architectures.

Secrets contract: only allowlisted *names* may reach containers, always as
`--env=NAME` inheritance (never as values in argv, build args, logs, or
generated files), and allowlists are scoped per harness — Claude Code cases
accept only `CLAUDE_CODE_OAUTH_TOKEN` (the `claude setup-token` credential,
inherited by name into Claude containers only), OpenCode accepts the broader
provider list and never receives that token; secrets are never fanned into a
harness that cannot use them, and host `pack`/`build`/`probe`/`smoke` commands
run with every allowlisted name stripped. The OpenCode credentials are the one
thing that travels as a file: an explicit, validated, owner-only copy written
into a private directory (legacy `auth.json` + generated `auth-import.json`,
both read back and hash-verified) mounted read-only at a fixed path for OpenCode
cases only, with its long string values and entry keys added to the in-memory
redaction set (never logged or stored) and its host paths rendered as
placeholders. Provider ids stay visible on purpose: they are validated,
structural metadata reported in the audit. Present values shorter than 8
characters are rejected before execution, and every nonempty selected value is
redacted centrally along with host paths. The repository, `HOME`, and host
config are never mounted; only the packed artifact is mounted read-only,
alongside container-local tmpfs for `HOME`, workspace, and install directories.
`host` networking and host namespaces are rejected during planning and
validation. `list`, `plan`, `pack`, `build`, and `smoke` need no credentials;
`run` requires the explicit model envs and selected secrets documented under
"Phase 2 case execution" above.

Networking note: smoke runs with `--network=none`; planned case runs use the
isolated bridge network, where live traffic can reach the internet and
potentially the host/LAN — the host network namespace is never shared.
