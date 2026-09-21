# Skill Router

Skill Router is a standalone, low-token router for portable agent skills. It
builds a compact registry from installed skill metadata, selects likely skills
locally, and lets the active harness load only the selected skill body.

This repository is independent of Context Curator. It does not import, bundle,
or share runtime state with that project.

## Install

Node.js 20 or newer is required. From a published package:

```sh
npm install --global @openagency/skill-router
skill-router init
```

For repository development, use `node src/cli.js` in place of `skill-router`.

## Commands

```sh
# Discover installed skills, create the compact registry, install managed
# OpenCode skill overlays, and register their source.
skill-router init

# Add an installed skill by ID or a local skill/directory by path.
skill-router add git-release
skill-router add ./team-skills/review --alias "inspect this"

# Refresh after source changes, route a request, and diagnose the installation.
skill-router scan
skill-router route --json -- "prepare a release"
skill-router check
```

Agent integrations must not interpolate untrusted request text into a shell
command. The generated OpenCode router skill writes the request with a
filesystem tool under a unique validated token and invokes
`skill-router route --request-token <token>`; the CLI consumes and deletes only
that invocation's managed request file.

Use `--global` for user-wide state or `--project` (the default) for the current
project. Every mutating command supports `--dry-run`; every command supports
machine-readable `--json` output where applicable.

`add` also supports `--source`, `--replace`, repeatable `--alias`,
`--description`, `--no-enable`, and `--yes` for a directory containing multiple
skills.

## How OpenCode integration works

Skill Router discovers the standard `.claude/skills`, `.agents/skills`, and
OpenCode skill locations plus explicit router sources. It writes only generated
state under `.skill-router/` and adds that absolute generated source to
`.opencode/opencode.json`.

Each routed skill is copied into the managed source with
`metadata.opencode/autoinvoke: false`. The source skill is never edited, the
managed copy remains explicitly loadable by ID, and only the small
`skill-router` skill is advertised automatically. Re-running `init` or `scan`
regenerates managed copies from their sources.

Strict JSON configuration is updated automatically. Existing JSONC is parsed
for configured skill sources but is never rewritten: initialization completes
and prints the exact `skills` entry to add manually. `skill-router check`
remains unhealthy until that entry is present.

## Configuration

Project configuration is stored in `.skill-router.json`. Global configuration
is stored in `~/.config/skill-router/config.json`. The generated registry and
managed skill source are under `.skill-router/` for projects and
`~/.local/share/skill-router/` globally.

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

## Development

```sh
npm test
npm run check
node src/cli.js --help
```

`SKILL_ROUTER_HOME` can point tests at an isolated home directory. It is an
internal verification affordance, not required for normal use.
