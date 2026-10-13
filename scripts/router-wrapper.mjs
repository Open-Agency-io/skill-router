#!/usr/local/bin/node
"use strict";
// Immutable image-layer router wrapper.
//
// Every writable tmpfs in this harness is mounted `noexec` (verified from
// /proc/mounts on Docker Desktop), so no runtime-created file can be executed.
// This file is COPY'd into the read-only rootfs at /usr/local/bin/skill-router
// (root-owned, mode 0555) by test/container/Dockerfile and shared by all three
// image targets.
//
// It runs the fixed package bin through the known container Node binary,
// forwards argv exactly, inherits stdio, and forwards a numeric exit status.
// Fixed inputs only: no shell, no interpolation, no environment, no path or
// user input, and a single built-in import.
const { spawnSync } = require("node:child_process");

const result = spawnSync(
  process.execPath,
  ["/opt/skill-router-install/node_modules/.bin/skill-router", ...process.argv.slice(2)],
  { stdio: "inherit" },
);

if (result.error) {
  process.stderr.write("skill-router wrapper failed to start\n");
  process.exit(127);
}

// Signal or missing status collapse to a fixed nonzero code; a numeric child
// status is forwarded unchanged.
process.exit(result.signal ? 1 : result.status === null ? 1 : result.status);
