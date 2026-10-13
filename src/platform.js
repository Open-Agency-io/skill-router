// Runtime platform guard for router filesystem state (Phase 14).
//
// Every piece of control data this router owns - the mutation lock, its
// owner/heartbeat metadata, the transaction journal and its payloads, request
// spool entries and claims, and managed state - depends on POSIX semantics the
// runtime must actually enforce: owner-only mode bits, current-uid
// attribution, no-follow opens, and strong dev/ino file identity. Windows
// reports none of them, so Phase 14 refuses every command that touches router
// filesystem state there, *before* the first mkdir, chmod, lock, journal,
// claim, or write. Linux and macOS continue unchanged, and so does every other
// POSIX-like host that already reports uid/mode semantics: the guard refuses
// exactly `win32`, it never weakens an existing POSIX check, and `--help` /
// `--version` never reach it.
//
// The refusal lives at the common controlled boundary (the mutation/read/
// recovery runners in `src/mutation-runner.js`) and at the direct request-spool
// API, so callers cannot sprinkle - or forget - per-call-site checks. This
// module is deliberately tiny and side-effect free; `platformInternals` is the
// single narrow injection seam tests use to prove the refusal ordering with a
// synthetic win32 runtime. Nothing here reads package metadata.

/** Stable refusal code; never carries a path, token, digest, or request bytes. */
export const PLATFORM_ERROR_CODE = "PLATFORM_UNSUPPORTED";

/** The only refused runtime platform in Phase 14. */
export const UNSUPPORTED_PLATFORM = "win32";

/**
 * Bounded, stable error for a runtime that cannot uphold the router's POSIX
 * filesystem contract. The message names the platform only.
 */
export class PlatformUnsupportedError extends Error {
  constructor(platform) {
    super(
      `skill-router filesystem operations are not supported on ${platform}; ` +
        `Phase 14 requires a POSIX platform such as linux or darwin`,
    );
    this.name = "PlatformUnsupportedError";
    this.code = PLATFORM_ERROR_CODE;
    this.platform = platform;
  }
}

// Narrow deterministic-injection seam. Production callers must treat this as
// read-only; tests override it and restore it afterwards. There is no
// environment variable or flag that can reach or weaken it in a real run.
export const platformInternals = {
  platform() {
    return process.platform;
  },
};

/**
 * True for every runtime except Windows. Phase 14 refuses Windows because its
 * filesystem reports no usable POSIX privacy or identity semantics; refusing a
 * working POSIX platform would be a regression, so this is an explicit deny of
 * exactly `win32`, not an allowlist.
 */
export function isSupportedRuntimePlatform(platform) {
  return platform !== UNSUPPORTED_PLATFORM;
}

/**
 * The single platform guard. Throws the stable `PLATFORM_UNSUPPORTED` error on
 * an unsupported runtime - and also when the runtime platform cannot be
 * determined at all, because an unknown platform is never assumed safe - and
 * otherwise returns the evaluated platform string. Call it as the first
 * statement of any operation that will touch router filesystem state, so an
 * unsupported runtime fails before any mkdir, chmod, lock, journal, claim, or
 * write can happen.
 */
export function assertSupportedRuntimePlatform(platform = platformInternals.platform()) {
  if (typeof platform !== "string" || platform === "") throw new PlatformUnsupportedError("unknown");
  if (!isSupportedRuntimePlatform(platform)) throw new PlatformUnsupportedError(platform);
  return platform;
}
