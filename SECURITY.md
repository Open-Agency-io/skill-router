# Security Policy

## Supported versions

Skill Router is pre-1.0. Security fixes, when warranted, are made on the
latest released `0.1.x` line only:

| Version | Supported |
| --- | --- |
| latest `0.1.x` | Yes |
| any older version | No |
| the npm registry | Yes — only `@openagency.io/skill-router`; see "Package provenance" below |

There is no long-term support, no backporting, and no extended-support
commitment for older versions.

## Scope

This policy covers the surfaces this repository ships:

- the `skill-router` CLI and the runtime modules in `src/`;
- the packed npm artifact exactly as the release gate validates it;
- the repository's GitHub Actions workflows (`ci.yml`, `release.yml`,
  `publish-npm.yml`).

Out of scope, among others: the OpenCode and Claude Code harnesses
themselves, skill content that users route through the router, the malicious
same-UID process races that the README threat model explicitly excludes, and
any third-party package squatting a similar name.

## Package provenance (read before installing)

- The package name is `@openagency.io/skill-router`. The `openagency.io` npm
  organization was selected deliberately and ownership was **verified** (the
  npm account `openagency-io` is an organization owner); there is no
  scope-rights question left open. The package **is published** on the public
  npm registry; `0.1.x` is the current line.
- The first version, `0.1.0`, reached the registry through a one-time manual
  bootstrap: an authenticated `npm stage publish` of the exact release
  tarball with `--ignore-scripts`, which publicly created a `0.0.0-stage`
  placeholder before a maintainer reviewed and approved the staged `0.1.0`
  with 2FA. Because that bootstrap was a human step, `0.1.0` carries **no
  trusted-publisher/OIDC provenance** — a permanent historical fact.
- The trusted publisher for repository `Open-Agency-io/skill-router`,
  workflow `publish-npm.yml`, **is configured** with stage-only permission.
  Configuration alone proves nothing: npm's trusted-publisher actor and
  provenance appear on a staged version only after a successful run of that
  workflow, and the staged npm record from that run is the evidence. npm
  expires a newly configured trusted publisher unless a successful stage
  lands within two days of configuration.
- The unscoped name `skill-router` belongs to an **unrelated third-party
  publisher** and must never be installed or suggested as this project.
- Install only `@openagency.io/skill-router` from the official registry
  record; any other registry package claiming to be Skill Router is
  unofficial.

## Supply-chain posture

The release design deliberately removes the usual supply-chain footguns:

- **No lifecycle scripts.** `package.json` contains no `install`,
  `preinstall`, `postinstall`, `prepare`, `prepack`, or `prepublish` hook, so
  installing or publishing the package runs no repository code. The
  staged-publish verifier refuses a tarball that carries one.
- **One pinned runtime dependency** (`yaml`), recorded exactly in
  `package-lock.json`.
- **Checksummed releases.** Each GitHub Release carries exactly two assets —
  the gate-validated tarball and `SHA256SUMS`. Verify downloads against
  `SHA256SUMS` (compare the tarball's own sha256 to the file's text; do not
  let any checker follow paths from the checksum file).
- **`--ignore-scripts` publication.** Both the manual bootstrap of `0.1.0`
  and every `publish-npm.yml` staging run publish the exact release tarball
  with `--ignore-scripts` so the bytes the gate validated are the bytes that
  land on the registry.
- **Least-privilege CI.** Jobs that execute candidate code hold only
  `contents: read` and check out with `persist-credentials: false`.

## Reporting a vulnerability

Report vulnerabilities **privately**, through GitHub's private vulnerability
reporting form for this repository:

- **https://github.com/Open-Agency-io/skill-router/security/advisories/new**

Do **not** open a public issue for a vulnerability, and do not include
exploit details, request bodies, spool tokens, digests, credentials, or
sensitive filesystem paths in any public report.

Two honest limitations, stated plainly:

1. **Private vulnerability reporting is a repository setting, not a file.**
   Enabling it for `Open-Agency-io/skill-router` is an **external release
   gate** that must be confirmed in repository settings before this project
   is announced as publicly released. Until it is confirmed enabled, the URL
   above will not accept reports — this policy does **not** claim it is
   already active.
2. **No service-level commitment.** There is no response-time SLA, no
   dedicated security email address, and no bug-bounty program. Reports are
   handled by the maintainers on a best-effort basis once the private channel
   above is active.

If private reporting is unavailable and you must reach the maintainers, use a
private contact method actually listed on a maintainer's public GitHub
profile at the time you look — this repository deliberately does not invent
or hard-code one.
