# Skill Router container harness images (Phase 1 substrate).
#
# The build context contains exactly four audited files: this Dockerfile,
# container-verify.mjs, run-case.mjs and router-wrapper.mjs
# (scripts/container-lib.mjs stages exactly those four into a private temporary
# context before building, so the daemon never receives the repository, HOME, or
# any host configuration). No host repository files, HOME, or configuration are
# copied into image layers; the packed skill-router artifact is mounted
# read-only at run time instead.
#
# Immutable router wrapper: every writable tmpfs this harness mounts (/tmp,
# /workspace, /home/node, /opt/skill-router-install) is `noexec` at run time
# (empirically reported as noexec by Docker Desktop even when omitted), so no
# runtime-created file can ever be executed. The wrapper therefore ships in the
# read-only rootfs at /usr/local/bin/skill-router — root-owned, mode 0555,
# sha256 6c0a7f4a60c40d2584f00ede1aca6ff5d8876f4fd9d58715ce84ec8cb890bf64 — and is shared by all three targets below.
#
# One Dockerfile, one build mechanism, three targets:
#   opencode-v1, opencode-v2, claude
#
# OpenCode v1 only: a Debian-pinned system `ripgrep` is installed into the
# read-only rootfs. OpenCode 1.x enumerates Skill companion files through
# Ripgrep.Service.find, whose binary resolver falls back to *downloading* `rg`
# into Global.Path.bin; every writable tmpfs here is noexec, so that download
# could never execute and the Skill tool failed (`skill:error:...`). The pin is
# an audited ARG default mirrored in test/container/matrix.json and asserted by
# test/container-plan.test.js; v2 and Claude images deliberately do not get it.
#
# Per-target ARG defaults must match test/container/matrix.json (asserted by
# test/container-plan.test.js). Overrides arrive as --build-arg values and are
# verified inside the image by scripts/container-verify.mjs: package.json
# version must equal the requested pin exactly, the harness binary must report
# that exact version, the reported major must match, and the harness id must
# match the target. The base image is pinned by multi-architecture manifest
# digest; an override weakens the reproducibility claim and is reported by the
# runner.

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

FROM ${NODE_IMAGE} AS os-base

ENV DEBIAN_FRONTEND=noninteractive \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false \
    HOME=/home/node

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && test "$(id -u node)" = "1000" \
 && rm -f /home/node/.bashrc /home/node/.profile /home/node/.bash_logout \
 && mkdir -p /input /workspace /opt/skill-router-install \
 && chown node:node /workspace /opt/skill-router-install \
 && chmod 0755 /input

WORKDIR /workspace

FROM os-base AS harness-common

COPY container-verify.mjs /usr/local/lib/skill-router/verify-harness.mjs
COPY run-case.mjs /usr/local/lib/skill-router/run-case.mjs
RUN chmod 0555 /usr/local/lib/skill-router/verify-harness.mjs /usr/local/lib/skill-router/run-case.mjs

# Immutable router wrapper: root-owned, mode 0555, pinned bytes, shared by all
# three targets. The package it runs is installed at *case* runtime, so at build
# time it can only be proven executable on the image layer: the wrapper must run
# and report the deterministic "target missing" status 1 (a non-executable or
# unreadable file yields 126/127 instead), never a permission failure.
COPY --chown=root:root --chmod=0555 router-wrapper.mjs /usr/local/bin/skill-router
RUN test "$(stat -c %a /usr/local/bin/skill-router)" = "555" \
 && test "$(stat -c %U /usr/local/bin/skill-router)" = "root" \
 && test "$(sha256sum /usr/local/bin/skill-router | cut -d' ' -f1)" = "6c0a7f4a60c40d2584f00ede1aca6ff5d8876f4fd9d58715ce84ec8cb890bf64" \
 && { code=0; /usr/local/bin/skill-router --version >/dev/null 2>&1 || code=$?; test "$code" -eq 1; }

# --- OpenCode 1.x -------------------------------------------------------------
FROM harness-common AS opencode-v1

ARG HARNESS_PACKAGE=opencode-ai
ARG HARNESS_VERSION=1.18.34
ARG HARNESS_BINARY=opencode
ARG HARNESS_MAJOR=1
ARG HARNESS_ID=opencode-v1

# Audited system ripgrep pin (mirrored in test/container/matrix.json as
# harnesses["opencode-v1"].ripgrep): the exact version the digest-pinned
# bookworm base offers on linux/amd64 and linux/arm64 (`apt-cache policy
# ripgrep`, verified 2026-10-07). The package version is pinned exactly; the
# reported major is bounded separately because `rg --version` prints the crate
# version (`ripgrep 13.0.0`), not the Debian revision. Debian may later re-point
# bookworm to a new binNMU revision: the build then fails closed on the exact
# pin (override with --build-arg RIPGREP_VERSION=..., still bounded by
# RIPGREP_MAJOR) instead of silently falling back to a runtime download.
ARG RIPGREP_PACKAGE=ripgrep
ARG RIPGREP_VERSION=13.0.0-4+b2
ARG RIPGREP_MAJOR=13
ENV RIPGREP_PACKAGE=${RIPGREP_PACKAGE} \
    RIPGREP_VERSION=${RIPGREP_VERSION} \
    RIPGREP_MAJOR=${RIPGREP_MAJOR}

# System ripgrep for this target only, installed while still root and before
# USER node. Exact package pin, then a structural build-time proof the verifier
# repeats as uid 1000 at build and smoke time: regular non-symlink root-owned
# 0755 file whose reported major is bounded. apt lists and caches are removed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends "${RIPGREP_PACKAGE}=${RIPGREP_VERSION}" \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* \
 && test "$(dpkg-query -W ripgrep | cut -f2)" = "${RIPGREP_VERSION}" \
 && test -f /usr/bin/rg \
 && test ! -L /usr/bin/rg \
 && test "$(stat -c %U /usr/bin/rg)" = "root" \
 && test "$(stat -c %a /usr/bin/rg)" = "755" \
 && rg --version | head -1 | grep -Eq "^ripgrep ${RIPGREP_MAJOR}\\." \
 && command -v rg

RUN HOME=/tmp/build-home npm install -g --no-audit --no-fund --cache /tmp/skill-router-npm-cache "${HARNESS_PACKAGE}@${HARNESS_VERSION}" \
 && rm -rf /tmp/skill-router-npm-cache /tmp/build-home \
 && test -n "$(command -v "${HARNESS_BINARY}")" \
 && test "$(stat -c %a /usr/local/bin/skill-router)" = "555" \
 && test "$(stat -c %U /usr/local/bin/skill-router)" = "root" \
 && test "$(sha256sum /usr/local/bin/skill-router | cut -d' ' -f1)" = "6c0a7f4a60c40d2584f00ede1aca6ff5d8876f4fd9d58715ce84ec8cb890bf64"

USER node
RUN HOME=/tmp/harness-verify \
    XDG_CONFIG_HOME=/tmp/harness-verify/.config \
    XDG_DATA_HOME=/tmp/harness-verify/.local/share \
    XDG_CACHE_HOME=/tmp/harness-verify/.cache \
    XDG_STATE_HOME=/tmp/harness-verify/.local/state \
    node /usr/local/lib/skill-router/verify-harness.mjs \
      --package="${HARNESS_PACKAGE}" --version="${HARNESS_VERSION}" \
      --binary="${HARNESS_BINARY}" --major="${HARNESS_MAJOR}" \
      --harness="${HARNESS_ID}" --expect-non-root \
 && rm -rf /tmp/harness-verify \
 && entries="$(ls -A /home/node)" && if [ -n "$entries" ]; then echo "image HOME must stay pristine, found: $entries" >&2; exit 1; fi \
 && echo "verified ${HARNESS_PACKAGE}@${HARNESS_VERSION} via ${HARNESS_BINARY} (non-root)"

ENV HARNESS_ID=opencode-v1
LABEL dev.openagency.skill-router.harness="opencode-v1"

# --- OpenCode 2.x (@opencode/cli) --------------------------------------------
FROM harness-common AS opencode-v2

ARG HARNESS_PACKAGE=@opencode/cli
ARG HARNESS_VERSION=2.0.24
ARG HARNESS_BINARY=opencode
ARG HARNESS_MAJOR=2
ARG HARNESS_ID=opencode-v2

RUN HOME=/tmp/build-home npm install -g --no-audit --no-fund --cache /tmp/skill-router-npm-cache "${HARNESS_PACKAGE}@${HARNESS_VERSION}" \
 && rm -rf /tmp/skill-router-npm-cache /tmp/build-home \
 && test -n "$(command -v "${HARNESS_BINARY}")" \
 && test "$(stat -c %a /usr/local/bin/skill-router)" = "555" \
 && test "$(stat -c %U /usr/local/bin/skill-router)" = "root" \
 && test "$(sha256sum /usr/local/bin/skill-router | cut -d' ' -f1)" = "6c0a7f4a60c40d2584f00ede1aca6ff5d8876f4fd9d58715ce84ec8cb890bf64"

USER node
RUN HOME=/tmp/harness-verify \
    XDG_CONFIG_HOME=/tmp/harness-verify/.config \
    XDG_DATA_HOME=/tmp/harness-verify/.local/share \
    XDG_CACHE_HOME=/tmp/harness-verify/.cache \
    XDG_STATE_HOME=/tmp/harness-verify/.local/state \
    node /usr/local/lib/skill-router/verify-harness.mjs \
      --package="${HARNESS_PACKAGE}" --version="${HARNESS_VERSION}" \
      --binary="${HARNESS_BINARY}" --major="${HARNESS_MAJOR}" \
      --harness="${HARNESS_ID}" --expect-non-root \
 && rm -rf /tmp/harness-verify \
 && entries="$(ls -A /home/node)" && if [ -n "$entries" ]; then echo "image HOME must stay pristine, found: $entries" >&2; exit 1; fi \
 && echo "verified ${HARNESS_PACKAGE}@${HARNESS_VERSION} via ${HARNESS_BINARY} (non-root)"

ENV HARNESS_ID=opencode-v2
LABEL dev.openagency.skill-router.harness="opencode-v2"

# --- Claude Code --------------------------------------------------------------
FROM harness-common AS claude

ARG HARNESS_PACKAGE=@anthropic-ai/claude-code
ARG HARNESS_VERSION=2.1.291
ARG HARNESS_BINARY=claude
ARG HARNESS_MAJOR=2
ARG HARNESS_ID=claude

RUN HOME=/tmp/build-home npm install -g --no-audit --no-fund --cache /tmp/skill-router-npm-cache "${HARNESS_PACKAGE}@${HARNESS_VERSION}" \
 && rm -rf /tmp/skill-router-npm-cache /tmp/build-home \
 && test -n "$(command -v "${HARNESS_BINARY}")" \
 && test "$(stat -c %a /usr/local/bin/skill-router)" = "555" \
 && test "$(stat -c %U /usr/local/bin/skill-router)" = "root" \
 && test "$(sha256sum /usr/local/bin/skill-router | cut -d' ' -f1)" = "6c0a7f4a60c40d2584f00ede1aca6ff5d8876f4fd9d58715ce84ec8cb890bf64"

USER node
RUN HOME=/tmp/harness-verify \
    XDG_CONFIG_HOME=/tmp/harness-verify/.config \
    XDG_DATA_HOME=/tmp/harness-verify/.local/share \
    XDG_CACHE_HOME=/tmp/harness-verify/.cache \
    XDG_STATE_HOME=/tmp/harness-verify/.local/state \
    node /usr/local/lib/skill-router/verify-harness.mjs \
      --package="${HARNESS_PACKAGE}" --version="${HARNESS_VERSION}" \
      --binary="${HARNESS_BINARY}" --major="${HARNESS_MAJOR}" \
      --harness="${HARNESS_ID}" --expect-non-root \
 && rm -rf /tmp/harness-verify \
 && entries="$(ls -A /home/node)" && if [ -n "$entries" ]; then echo "image HOME must stay pristine, found: $entries" >&2; exit 1; fi \
 && echo "verified ${HARNESS_PACKAGE}@${HARNESS_VERSION} via ${HARNESS_BINARY} (non-root)"

ENV HARNESS_ID=claude
LABEL dev.openagency.skill-router.harness="claude"
