// Phase 14 - the runtime platform guard.
//
// Windows is unsupported for router filesystem state in Phase 14: the guard
// refuses it before the first mkdir, chmod, lock, journal, claim, or write, at
// the controlled runners (test/mutation-runner.test.js) and at the direct
// request-spool API (test/requests.test.js). This file focuses on the guard
// itself: the stable refusal, its bounded shape, and the injected seam tests
// use instead of monkeypatching `process`.
import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import {
  PLATFORM_ERROR_CODE,
  PlatformUnsupportedError,
  UNSUPPORTED_PLATFORM,
  assertSupportedRuntimePlatform,
  isSupportedRuntimePlatform,
  platformInternals,
} from "../src/platform.js";

test("the runtime platform guard refuses exactly win32 with a stable bounded error", () => {
  let error = null;
  try {
    assertSupportedRuntimePlatform("win32");
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof PlatformUnsupportedError, "the refusal is the stable platform error");
  assert.equal(error.code, PLATFORM_ERROR_CODE);
  assert.equal(error.code, "PLATFORM_UNSUPPORTED");
  assert.equal(error.platform, "win32");
  assert.equal(error.name, "PlatformUnsupportedError");
  // Bounded message: the platform only, never a path, token, digest, or bytes.
  assert.match(error.message, /not supported on win32/);
  assert.equal(error.message.length < 200, true);

  assert.equal(UNSUPPORTED_PLATFORM, "win32");
});

test("linux, darwin, and other POSIX runtimes continue unchanged", () => {
  for (const platform of ["linux", "darwin", "freebsd", "sunos", "aix"]) {
    assert.equal(isSupportedRuntimePlatform(platform), true, `${platform} stays supported`);
    assert.equal(assertSupportedRuntimePlatform(platform), platform);
  }
  assert.equal(isSupportedRuntimePlatform("win32"), false);
  // The current runtime is supported wherever this suite runs.
  assert.equal(isSupportedRuntimePlatform(process.platform), process.platform !== "win32");
});

test("the default guard reads the injected platform seam, never a flag or environment variable", () => {
  const original = platformInternals.platform;
  try {
    assert.equal(platformInternals.platform(), process.platform);
    assert.equal(assertSupportedRuntimePlatform(), process.platform);

    platformInternals.platform = () => "win32";
    assert.throws(() => assertSupportedRuntimePlatform(), (error) => error.code === PLATFORM_ERROR_CODE);

    platformInternals.platform = () => "linux";
    assert.equal(assertSupportedRuntimePlatform(), "linux");
  } finally {
    platformInternals.platform = original;
  }
  assert.equal(platformInternals.platform(), process.platform, "the seam is restored");
});

test("a missing or non-string platform is refused as unknown rather than assumed safe", () => {
  assert.throws(() => assertSupportedRuntimePlatform(""), (error) => error.code === PLATFORM_ERROR_CODE);
  assert.throws(() => assertSupportedRuntimePlatform(null), (error) => error.code === PLATFORM_ERROR_CODE);
  assert.throws(() => assertSupportedRuntimePlatform(42), (error) => error.code === PLATFORM_ERROR_CODE);
  // Only an *omitted* argument consults the injected seam.
  assert.equal(assertSupportedRuntimePlatform(), platformInternals.platform());
});
