# Skill Router

Skill Router is a standalone, low-token router for portable agent skills. It
builds a compact registry from installed skill metadata, selects likely skills
locally, and lets the active harness load only the selected skill body.

This repository is independent of Context Curator. It does not import, bundle,
or share runtime state with that project.

## Status

The repository currently contains the Phase 1 foundation:

- dependency-free Node.js 20+ package;
- portable `SKILL.md` and root-level Markdown discovery;
- safe frontmatter metadata parsing;
- deterministic source precedence and duplicate diagnostics;
- compact registry and source fingerprints;
- atomic JSON writes.

The public `init`, `add`, `scan`, `route`, and `check` commands are implemented
in later phases.

## Development

```sh
npm test
npm run check
node src/cli.js --help
```

Generated router state will live in `.skill-router/` and must not be committed.
