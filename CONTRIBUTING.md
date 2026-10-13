# Contributing to Skill Router

Thank you for considering a contribution. This document is the complete
contributor guide: development setup, the gates every change must pass, and
the contracts a change must not regress.

## Where to contribute

- Pull requests target `main`.
- Non-sensitive bugs and usage questions belong in
  [GitHub Issues](https://github.com/Open-Agency-io/skill-router/issues).
  Search existing issues first.
- **Never** post vulnerabilities, request bodies, spool tokens, digests, or
  sensitive filesystem paths in a public issue — see [SECURITY.md](SECURITY.md)
  for private reporting and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for
  repository conduct.

## Development setup

Requirements:

- **Node.js 20 or newer** (`engines.node` is `>=20`; CI runs Node 20 and
  Node 24).
- npm (ships with Node). `npm ci` needs registry access for the pinned
  dependencies.

Setup and the required gates:

```sh
npm ci            # install the exact pinned dependency tree
npm test          # full test suite (node --test); no network, no credentials
npm run check     # syntax-check src/*.js and scripts/*.mjs, import every
                  # runtime module in a private sandbox, and verify the real
                  # CLI --version output
node src/cli.js --help   # run the CLI directly during development
node src/cli.js --version
```

Before the package is published to npm, run the CLI as `node src/cli.js`;
the `skill-router` bin name only exists once the package is installed.

### Optional gates (not required for most contributions)

```sh
npm run gate:clean    # clean-clone gate (~2 min): builds a clean clone of the
                      # candidate set, then runs npm ci, check, and test there
```

The container harness has two strictly separated layers:

- `npm run test:container` (the container plan/security/lifecycle/case
  tests) is **credential-free and Docker-free** — it is structural testing
  that already runs inside `npm test` and therefore inside CI on every push
  and pull request.
- `npm run container:list`, `npm run container:plan`, and `npm run
  container:pack` inspect, plan, and pack **without invoking Docker**.
- `npm run container:build`, `npm run container:smoke`, and `npm run
  container:auth-check` **require Docker**. `container:build` builds the
  required harness images.
- `npm run container:run` additionally requires explicit model configuration
  and corresponding credentials on top of Docker.

Only the Docker- and credential-backed commands are optional maintainer
gates: no contribution is required to run them, and **CI executes no live
container run** — the CI jobs run `npm ci`, `npm run check`, `npm test`
(whose container tests are only the credential-free structural layer above),
and the clean-candidate gate. The model-backed OpenCode/Claude E2E scripts
are likewise optional and credential-gated. Credentialed or model-backed
validation is never a substitute for the required credential-free suite.

`SKILL_ROUTER_HOME` can point tests at an isolated home directory; it is an
internal verification affordance, not required for normal development.

## Platform contract

The support matrix is exact and structurally tested; do not broaden it in
documentation without the matching runtime and test evidence:

| Platform | Contract |
| --- | --- |
| Linux | **Supported.** The only CI- and release-gated platform (CI matrix and release jobs run on `ubuntu-latest`). |
| macOS (`darwin`) | Intended POSIX runtime, developer-tested. There is **no macOS CI job**, so it is not CI-qualified. |
| Windows | **Unsupported.** Refused with `PLATFORM_UNSUPPORTED` before any router filesystem mutation. |

`package.json` declares exactly `"os": ["darwin", "linux"]` (mirrored in the
lockfile root). A change that touches platform behavior must keep the Windows
refusal intact and must not claim live Windows or macOS CI evidence.

## Contracts a change must not regress

These are pinned by tests; read the matching README sections for the full
detail:

- **Request privacy** — request bytes, request bodies, spool tokens, and
  their digests are never exposed in any error, result, record, or
  diagnostic. Agent integrations must never interpolate untrusted request
  text into a shell command (see the request-token flow in the README).
- **Error vocabulary** — `REQUEST-IDENTITY-UNAVAILABLE`,
  `RECOVERY_CONFLICT`, and `LOCK_COMPROMISED` are stable codes; path-freedom
  is claimed only for the surfaces that actually guarantee it.
- **Threat model** — crash recovery, ordinary concurrency, and
  persistent-symlink refusal are in scope; a malicious same-UID process
  racing final pathname syscalls is a documented exclusion. Do not add
  claims the tests do not prove, and do not reintroduce absolute wording
  ("guaranteed", "never contains a path") that the documentation tests
  explicitly forbid.
- **Fail-closed state** — mutating commands journal intent, hold the
  mutation lock, and never commit state derived from incomplete discovery.
- **No unsupported live-validation claims** — documentation may describe
  structurally tested contracts; it may not assert cross-platform or
  credentialed evidence that no gate produced.

## Package and dependency policy

- **No lifecycle scripts, ever.** `package.json` must not gain `install`,
  `prepare`, `prepack`, `prepublishOnly`, or any other lifecycle hook:
  publication is designed to run no repository code, and the staged-publish
  verifier refuses a tarball that carries one.
- **No new runtime dependencies without discussion.** The only runtime
  dependency is the exactly pinned `yaml`. Open an issue before adding one;
  prefer Node built-ins.
- The npm `files` allowlist stays exactly `["src", "README.md", "LICENSE"]`.
  Community files (this file, SECURITY.md, CODE_OF_CONDUCT.md, `.github/`
  templates) intentionally live only in the repository, not in the tarball.

## What a pull request should include

1. Tests for the behavior you change — this suite is the project's primary
   specification, and documentation contracts are pinned by dedicated test
   files.
2. Documentation updates (README and, where applicable, the phase notes) for
   any user-visible change.
3. A description of how you validated the change: at minimum `npm test` and
   `npm run check` locally; mention any optional gate you ran.

Before requesting review, confirm:

- [ ] `npm test` passes.
- [ ] `npm run check` passes.
- [ ] No secrets, credentials, request bodies, tokens, digests, or sensitive
      local paths appear in code, tests, fixtures, or the PR description.
- [ ] No lifecycle scripts were added and no new dependencies were added
      without an agreed issue.
- [ ] The platform contract (Linux gated, macOS intended, Windows refused)
      and the privacy/error contracts above are preserved, or deliberately
      updated together with the tests that pin them.

## Licensing

Contributions are accepted under the repository's [MIT License](LICENSE).
By contributing you agree that your contribution is licensed under the same
terms.
