## What does this PR change, and why?

<!-- A few sentences of rationale. Link the issue this closes, if any. -->

## How was it validated?

<!-- At minimum: `npm test` and `npm run check`. Mention any optional gate
     (gate:clean, container matrix, model-backed E2E) you actually ran —
     never claim a gate you did not run. -->

## Checklist

- [ ] `npm test` passes locally.
- [ ] `npm run check` passes locally.
- [ ] Tests cover the changed behavior (this suite is the specification).
- [ ] User-visible changes are documented (README and/or phase notes).
- [ ] No secrets, credentials, request bodies, spool tokens, digests, or
      sensitive local paths appear in code, tests, fixtures, or this
      description.
- [ ] No lifecycle scripts were added, and no new dependency was added
      without an agreed issue.
- [ ] The platform contract is preserved (Linux gated, macOS intended but
      not CI-qualified, Windows refused with `PLATFORM_UNSUPPORTED` before
      any router filesystem mutation).
- [ ] The privacy and error-vocabulary contracts are preserved (request
      material never exposed; stable codes documented if touched).
- [ ] No unsupported claims were added (no invented live-validation,
      cross-platform, SLA, or publication evidence).
