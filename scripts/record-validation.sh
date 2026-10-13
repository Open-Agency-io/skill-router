#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$repo/artifacts"
cd "$repo"

exec asciinema record \
  --headless \
  --return \
  --overwrite \
  --idle-time-limit 1 \
  --window-size 120x40 \
  --title "Skill Router packaged OpenCode validation" \
  --command "npm run test:opencode-e2e" \
  "$repo/artifacts/skill-router-validation.cast"
