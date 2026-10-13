import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MAX_FILE_BYTES,
  assertDirectoryIdentitySupport,
  durableAtomicWrite,
  durableCreateFile,
  durableFsInternals,
  durableRename,
  durableUnlink,
  fileIdentity,
  identitiesEqual,
  identityRecord,
  isIdentityAvailable,
  isOwnerOnlyMode,
  isUnsupportedDirectorySyncError,
  readRegularFileNoFollow,
  sha256Bytes,
  syncDirectory,
} from "../src/durable-fs.js";

async function withInternals(overrides, run) {
  const saved = {};
  for (const key of Object.keys(overrides)) saved[key] = durableFsInternals[key];
  Object.assign(durableFsInternals, overrides);
  try {
    return await run();
  } finally {
    Object.assign(durableFsInternals, saved);
  }
}

async function withTemp(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-durable-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fsError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

/**
 * Simulates a filesystem that reports no strong file identity for exactly the
 * given paths: the real stat is observed, but its inode is replaced with 0 so
 * `fileIdentity` tags it unavailable. Prototype methods (isFile, ...) survive.
 */
async function withWeakIdentity(targets, run) {
  const weakened = new Set(targets.map((target) => path.resolve(target)));
  const original = durableFsInternals.lstat;
  return withInternals(
    {
      lstat: async (target) => {
        const stat = await original(target);
        if (!weakened.has(path.resolve(target))) return stat;
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: 0 });
      },
    },
    run,
  );
}

test("durableAtomicWrite orders write, file sync, close, rename, parent sync with owner-only mode", async () => {
  await withTemp(async (root) => {
    const target = path.join(root, "owner.json");
    const events = [];
    const original = {
      writeAll: durableFsInternals.writeAll,
      syncFile: durableFsInternals.syncFile,
      closeHandle: durableFsInternals.closeHandle,
      rename: durableFsInternals.rename,
      syncDirectoryHandle: durableFsInternals.syncDirectoryHandle,
    };
    await withInternals(
      {
        writeAll: async (handle, data) => {
          events.push("write");
          return original.writeAll(handle, data);
        },
        syncFile: async (handle, targetPath) => {
          events.push("file-sync");
          return original.syncFile(handle, targetPath);
        },
        closeHandle: async (handle) => {
          events.push("close");
          return original.closeHandle(handle);
        },
        rename: async (from, to) => {
          events.push("rename");
          return original.rename(from, to);
        },
        syncDirectoryHandle: async (handle, targetPath) => {
          events.push("dir-sync");
          return original.syncDirectoryHandle(handle, targetPath);
        },
      },
      async () => {
        await durableAtomicWrite(target, Buffer.from("payload"), { mode: 0o600 });
      },
    );

    // The trailing "close" is the directory handle used for the parent fsync.
    assert.deepEqual(events, ["write", "file-sync", "close", "rename", "dir-sync", "close"]);
    assert.equal(await readFile(target, "utf8"), "payload");
    const stat = await lstat(target);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.deepEqual(await readdir(root), ["owner.json"], "no temporary file is left behind");
  });
});

test("durableAtomicWrite loops over short writes until every byte is stored", async () => {
  await withTemp(async (root) => {
    const target = path.join(root, "journal.json");
    const data = Buffer.from("x".repeat(5000));
    const original = durableFsInternals.writeChunk;
    await withInternals(
      {
        writeChunk: async (handle, buffer, offset) => {
          const length = Math.min(3, buffer.length - offset);
          const { bytesWritten } = await handle.write(buffer, offset, length, offset);
          return bytesWritten;
        },
      },
      async () => {
        await durableAtomicWrite(target, data, { mode: 0o600 });
      },
    );
    assert.equal(typeof original, "function");
    const written = await readFile(target);
    assert.equal(written.length, data.length);
    assert.ok(written.equals(data));
  });
});

test("durableAtomicWrite cleans the exact temp and keeps an existing destination on write failure", async () => {
  await withTemp(async (root) => {
    const target = path.join(root, "owner.json");
    await writeFile(target, "old-content", { mode: 0o600 });
    const original = durableFsInternals.writeChunk;
    let calls = 0;
    await withInternals(
      {
        writeChunk: async (handle, buffer, offset) => {
          calls += 1;
          if (calls > 1) throw fsError("ENOSPC", "no space left on device");
          const { bytesWritten } = await handle.write(buffer, offset, Math.min(3, buffer.length - offset), offset);
          return bytesWritten;
        },
      },
      async () => {
        await assert.rejects(() => durableAtomicWrite(target, Buffer.from("new-content")), (error) => error.code === "ENOSPC");
      },
    );
    assert.equal(await readFile(target, "utf8"), "old-content");
    assert.deepEqual(await readdir(root), ["owner.json"], "the failed temp is removed");
  });
});

test("durableAtomicWrite removes the temp when the destination did not exist yet", async () => {
  await withTemp(async (root) => {
    const target = path.join(root, "missing-before.json");
    await assert.rejects(
      withInternals(
        {
          syncFile: async () => {
            throw fsError("EIO", "io failure");
          },
        },
        () => durableAtomicWrite(target, Buffer.from("data")),
      ),
      (error) => error.code === "EIO",
    );
    assert.deepEqual(await readdir(root), [], "no destination and no temp remain");
  });
});

test("durableAtomicWrite preserves the temp when the rename primitive itself fails", async () => {
  await withTemp(async (root) => {
    const target = path.join(root, "owner.json");
    await writeFile(target, "unchanged", { mode: 0o600 });
    const original = durableFsInternals.rename;
    await withInternals(
      {
        rename: async (from, to) => {
          throw fsError("EXDEV", "cross-device link");
        },
      },
      async () => {
        await assert.rejects(() => durableAtomicWrite(target, Buffer.from("data")), (error) => error.code === "EXDEV");
      },
    );
    assert.equal(typeof original, "function");
    assert.equal(await readFile(target, "utf8"), "unchanged");
    // B1: the temp is removed only through the claim-based attributed path,
    // which needs the same rename primitive that is failing here - so the
    // unproven-by-failure temp is preserved, never raw-unlinked.
    const entries = (await readdir(root)).filter((name) => name !== "owner.json");
    assert.equal(entries.length, 1, "exactly the temp survives, never raw-unlinked");
    assert.match(entries[0], /^\.owner\.json\.[0-9a-f]{16}\.tmp$/);
  });
});

test("durableAtomicWrite cleans the temp when close fails before rename", async () => {
  await withTemp(async (root) => {
    const target = path.join(root, "owner.json");
    const original = durableFsInternals.closeHandle;
    let first = true;
    await withInternals(
      {
        closeHandle: async (handle) => {
          if (first) {
            first = false;
            throw fsError("EIO", "close failed");
          }
          return original(handle);
        },
      },
      async () => {
        await assert.rejects(() => durableAtomicWrite(target, Buffer.from("data")), (error) => error.code === "EIO");
      },
    );
    assert.deepEqual(await readdir(root), [], "no destination and no temp remain");
  });
});

test("durableAtomicWrite refuses to replace a symlink destination", async () => {
  await withTemp(async (root) => {
    const real = path.join(root, "real.json");
    const link = path.join(root, "owner.json");
    await writeFile(real, "precious", { mode: 0o600 });
    await symlink(real, link);
    await assert.rejects(() => durableAtomicWrite(link, Buffer.from("evil")), (error) => error.code === "ELOOP");
    assert.equal((await lstat(link)).isSymbolicLink(), true, "the symlink is left in place");
    assert.equal(await readFile(real, "utf8"), "precious", "the symlink target is untouched");
    assert.deepEqual((await readdir(root)).sort(), ["owner.json", "real.json"], "no temp is left behind");
  });
});

test("durableAtomicWrite refuses directory and FIFO destinations", async () => {
  await withTemp(async (root) => {
    const directoryTarget = path.join(root, "as-directory");
    await mkdir(directoryTarget);
    await assert.rejects(() => durableAtomicWrite(directoryTarget, Buffer.from("data")), (error) => error.code === "EFTYPE");
    assert.equal((await lstat(directoryTarget)).isDirectory(), true);

    const fifo = path.join(root, "as-fifo");
    const created = spawnSync("mkfifo", [fifo]).status === 0;
    if (created) {
      await assert.rejects(() => durableAtomicWrite(fifo, Buffer.from("data")), (error) => error.code === "EFTYPE");
      assert.equal((await lstat(fifo)).isFIFO(), true, "the FIFO is left in place");
    }
  });
});

test("durableAtomicWrite rejects non owner-only modes", async () => {
  await withTemp(async (root) => {
    await assert.rejects(
      () => durableAtomicWrite(path.join(root, "a"), Buffer.from("x"), { mode: 0o644 }),
      (error) => error.code === "EINVAL",
    );
    await assert.rejects(
      () => durableAtomicWrite(path.join(root, "b"), Buffer.from("x"), { mode: 0o666 }),
      (error) => error.code === "EINVAL",
    );
    await assert.rejects(() => durableAtomicWrite(path.join(root, "c"), Buffer.from("x"), { mode: "600" }), TypeError);
    await assert.rejects(() => durableAtomicWrite(path.join(root, "d"), "not-bytes"), TypeError);
    assert.deepEqual(await readdir(root), [], "nothing was written");
  });
});

test("durableAtomicWrite applies an explicit owner-only mode when overwriting", async () => {
  await withTemp(async (root) => {
    const target = path.join(root, "readonly.json");
    await durableAtomicWrite(target, Buffer.from("first"), { mode: 0o600 });
    await durableAtomicWrite(target, Buffer.from("second"), { mode: 0o400 });
    assert.equal(await readFile(target, "utf8"), "second");
    assert.equal((await lstat(target)).mode & 0o777, 0o400);
    assert.deepEqual(await readdir(root), ["readonly.json"]);
  });
});

test("syncDirectory tolerates documented unsupported errors and propagates real ones", async () => {
  await withTemp(async (root) => {
    for (const code of ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EPERM"]) {
      const synced = await withInternals(
        {
          syncDirectoryHandle: async () => {
            throw fsError(code, `directory fsync not supported: ${code}`);
          },
        },
        () => syncDirectory(root),
      );
      assert.equal(synced, false, `${code} is suppressed`);
      assert.equal(isUnsupportedDirectorySyncError(fsError(code)), true);
    }

    await assert.rejects(
      withInternals(
        {
          syncDirectoryHandle: async () => {
            throw fsError("EIO", "real io failure");
          },
        },
        () => syncDirectory(root),
      ),
      (error) => error.code === "EIO",
    );
    assert.equal(isUnsupportedDirectorySyncError(fsError("EIO")), false);

    const regularFile = path.join(root, "file.txt");
    await writeFile(regularFile, "x");
    await assert.rejects(() => syncDirectory(regularFile), (error) => error.code === "ENOTDIR");

    // A tolerated parent-dir sync still completes the atomic write.
    const tolerated = path.join(root, "tolerated.json");
    await withInternals(
      {
        syncDirectoryHandle: async () => {
          throw fsError("EINVAL", "unsupported");
        },
      },
      async () => {
        await durableAtomicWrite(tolerated, Buffer.from("ok"));
      },
    );
    assert.equal(await readFile(tolerated, "utf8"), "ok");

    // A real parent-dir sync failure propagates even though the rename committed.
    const failing = path.join(root, "failing.json");
    await assert.rejects(
      withInternals(
        {
          syncDirectoryHandle: async () => {
            throw fsError("EIO", "real dir io failure");
          },
        },
        () => durableAtomicWrite(failing, Buffer.from("committed")),
      ),
      (error) => error.code === "EIO",
    );
    assert.equal(await readFile(failing, "utf8"), "committed");
  });
});

test("readRegularFileNoFollow returns exact bounded bytes and distinguishes ENOENT only when asked", async () => {
  await withTemp(async (root) => {
    const file = path.join(root, "owner.json");
    const content = Buffer.from("0123456789");
    await writeFile(file, content, { mode: 0o600 });
    const read = await readRegularFileNoFollow(file, { maxBytes: 100 });
    assert.ok(read.equals(content));
    assert.equal(read.length, 10);
    assert.equal(DEFAULT_MAX_FILE_BYTES, 1024 * 1024);

    const missing = path.join(root, "missing.json");
    assert.equal(await readRegularFileNoFollow(missing, { maxBytes: 10, allowMissing: true }), null);
    await assert.rejects(() => readRegularFileNoFollow(missing, { maxBytes: 10 }), (error) => error.code === "ENOENT");
    await assert.rejects(() => readRegularFileNoFollow(file, { maxBytes: -1 }), TypeError);
  });
});

test("readRegularFileNoFollow rejects symlinks and non-regular files", async () => {
  await withTemp(async (root) => {
    const real = path.join(root, "real.json");
    const link = path.join(root, "link.json");
    await writeFile(real, "content", { mode: 0o600 });
    await symlink(real, link);
    await assert.rejects(() => readRegularFileNoFollow(link, { maxBytes: 100 }), (error) => error.code === "ELOOP");

    const dangling = path.join(root, "dangling.json");
    await symlink(path.join(root, "gone"), dangling);
    await assert.rejects(() => readRegularFileNoFollow(dangling, { maxBytes: 100 }), (error) => error.code === "ELOOP");

    const directory = path.join(root, "dir");
    await mkdir(directory);
    await assert.rejects(() => readRegularFileNoFollow(directory, { maxBytes: 100 }), (error) => error.code === "EFTYPE");

    const fifo = path.join(root, "fifo");
    if (spawnSync("mkfifo", [fifo]).status === 0) {
      await assert.rejects(() => readRegularFileNoFollow(fifo, { maxBytes: 100 }), (error) => error.code === "EFTYPE");
    }
  });
});

test("readRegularFileNoFollow rejects oversize files and growth during the read", async () => {
  await withTemp(async (root) => {
    const file = path.join(root, "big.json");
    await writeFile(file, Buffer.alloc(64, 0x61), { mode: 0o600 });
    await assert.rejects(() => readRegularFileNoFollow(file, { maxBytes: 32 }), (error) => error.code === "EFBIG");

    const growing = path.join(root, "growing.json");
    await writeFile(growing, Buffer.alloc(10, 0x62), { mode: 0o600 });
    await assert.rejects(
      withInternals(
        {
          afterReadProbe: async () => {
            await writeFile(growing, Buffer.alloc(20, 0x62));
          },
        },
        () => readRegularFileNoFollow(growing, { maxBytes: 100 }),
      ),
      (error) => error.code === "EBUSY",
    );
  });
});

test("file identity is tagged available/unavailable and equality never matches an unprovable pair", async () => {
  assert.equal(sha256Bytes(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.throws(() => sha256Bytes("not-bytes"), TypeError);
  assert.equal(isOwnerOnlyMode(0o600), true);
  assert.equal(isOwnerOnlyMode(0o400), true);
  assert.equal(isOwnerOnlyMode(0o644), false);
  assert.equal(isOwnerOnlyMode(0o666), false);
  assert.equal(isOwnerOnlyMode(0o640), false);

  const identity = fileIdentity({ dev: 3, ino: 42 });
  assert.deepEqual(identity, { status: "available", dev: 3, ino: 42 });
  assert.equal(isIdentityAvailable(identity), true);
  assert.equal(identitiesEqual(identity, { dev: 3, ino: 42 }), true, "recorded plain identities compare too");
  assert.equal(identitiesEqual(identity, { dev: 3, ino: 43 }), false);
  assert.equal(identitiesEqual(identity, { dev: 4, ino: 42 }), false);
  assert.equal(identitiesEqual(null, identity), false);
  assert.equal(identitiesEqual(identity, null), false);
  assert.throws(() => fileIdentity(null), TypeError);

  // Only finite, safe, non-negative integers with ino != 0 are strong.
  const weakObservations = [
    { dev: 0, ino: 0 },
    { dev: 3, ino: 0 },
    { dev: Number.NaN, ino: 42 },
    { dev: 3, ino: Number.NaN },
    { dev: Number.NaN, ino: Number.NaN },
    { dev: 3.5, ino: 42 },
    { dev: 3, ino: 42.5 },
    { dev: -1, ino: 42 },
    { dev: 3, ino: -1 },
    { dev: Number.MAX_VALUE, ino: 42 },
    { dev: 3, ino: Number.MAX_VALUE },
    { dev: 9007199254740993, ino: 42 },
    { dev: 3, ino: 9007199254740993 },
    { dev: undefined, ino: undefined },
    { dev: "3", ino: "42" },
    {},
  ];
  for (const observation of weakObservations) {
    const tagged = fileIdentity(observation);
    assert.equal(tagged.status, "unavailable", `unavailable for ${JSON.stringify(observation)}`);
    assert.equal(isIdentityAvailable(tagged), false);
    assert.equal(identitiesEqual(tagged, identity), false);
    assert.equal(identitiesEqual(identity, tagged), false);
    assert.equal(identityRecord(tagged), null, "an unprovable identity is never recorded");
  }

  // Two unavailable identities are never equal - not even to each other.
  const zeroA = fileIdentity({ dev: 0, ino: 0 });
  const zeroB = fileIdentity({ dev: 0, ino: 0 });
  assert.deepEqual(zeroA, { status: "unavailable", dev: null, ino: null });
  assert.equal(identitiesEqual(zeroA, zeroB), false);
  assert.equal(identitiesEqual(zeroA, zeroA), false);
  assert.equal(identitiesEqual({ dev: 0, ino: 0 }, { dev: 0, ino: 0 }), false);
  assert.equal(isIdentityAvailable(zeroA), false);

  // The plain durable-record form only exists for strong identities.
  assert.deepEqual(identityRecord(identity), { dev: 3, ino: 42 });
  assert.deepEqual(identityRecord({ dev: 3, ino: 42 }), { dev: 3, ino: 42 });
  assert.equal(identityRecord(null), null);
});

test("durableRename moves content and syncs both affected parents", async () => {
  await withTemp(async (root) => {
    const fromDirectory = path.join(root, "a");
    const toDirectory = path.join(root, "b");
    await mkdir(fromDirectory);
    await mkdir(toDirectory);
    const from = path.join(fromDirectory, "claim.json");
    const to = path.join(toDirectory, "claim.json");
    await writeFile(from, "moving");

    let syncs = 0;
    const original = durableFsInternals.syncDirectoryHandle;
    await withInternals(
      {
        syncDirectoryHandle: async (handle, target) => {
          syncs += 1;
          return original(handle, target);
        },
      },
      async () => {
        await durableRename(from, to);
      },
    );
    assert.equal(syncs, 2, "both parents are fsynced");
    assert.equal(await readFile(to, "utf8"), "moving");
    await assert.rejects(() => readFile(from), (error) => error.code === "ENOENT");

    const sameDirectory = path.join(fromDirectory, "stay.json");
    await writeFile(from, "again");
    syncs = 0;
    await withInternals(
      {
        syncDirectoryHandle: async (handle, target) => {
          syncs += 1;
          return original(handle, target);
        },
      },
      async () => {
        await durableRename(from, sameDirectory);
      },
    );
    assert.equal(syncs, 1, "a same-directory rename syncs the single parent once");
    assert.equal(await readFile(sameDirectory, "utf8"), "again");
  });
});

test("durableUnlink removes exactly one entry, syncs the parent, and refuses directories", async () => {
  await withTemp(async (root) => {
    const file = path.join(root, "owner.json");
    const directory = path.join(root, "keep");
    await writeFile(file, "bye", { mode: 0o600 });
    await mkdir(directory);

    let syncs = 0;
    const original = durableFsInternals.syncDirectoryHandle;
    await withInternals(
      {
        syncDirectoryHandle: async (handle, target) => {
          syncs += 1;
          return original(handle, target);
        },
      },
      async () => {
        await durableUnlink(file, fileIdentity(await lstat(file)));
      },
    );
    assert.equal(syncs, 1);
    assert.deepEqual(await readdir(root), ["keep"]);
    await assert.rejects(
      async () => durableUnlink(file, fileIdentity(await lstat(directory))),
      (error) => error.code === "ENOENT",
    );
    await assert.rejects(
      async () => durableUnlink(directory, fileIdentity(await lstat(directory))),
      (error) => error.code === "EFTYPE",
    );
    assert.equal((await lstat(directory)).isDirectory(), true, "directories are never deleted by durableUnlink");
  });
});

test("durableCreateFile writes exact final-path content with ordered durability", async () => {
  await withTemp(async (root) => {
    const target = path.join(root, "transaction.json");
    const events = [];
    const original = {
      writeAll: durableFsInternals.writeAll,
      syncFile: durableFsInternals.syncFile,
      closeHandle: durableFsInternals.closeHandle,
      syncDirectoryHandle: durableFsInternals.syncDirectoryHandle,
      rename: durableFsInternals.rename,
    };
    await withInternals(
      {
        writeAll: async (handle, data) => {
          events.push("write");
          return original.writeAll(handle, data);
        },
        syncFile: async (handle, targetPath) => {
          events.push("file-sync");
          return original.syncFile(handle, targetPath);
        },
        closeHandle: async (handle) => {
          events.push("close");
          return original.closeHandle(handle);
        },
        syncDirectoryHandle: async (handle, targetPath) => {
          events.push("dir-sync");
          return original.syncDirectoryHandle(handle, targetPath);
        },
        rename: async (from, to) => {
          events.push("rename");
          return original.rename(from, to);
        },
      },
      async () => {
        await durableCreateFile(target, Buffer.from("journal-bytes"), { mode: 0o600 });
      },
    );

    // The trailing "close" is the directory handle used for the parent fsync.
    assert.deepEqual(events, ["write", "file-sync", "close", "dir-sync", "close"], "final path, never a temp rename");
    assert.equal(await readFile(target, "utf8"), "journal-bytes");
    assert.equal((await lstat(target)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(root), ["transaction.json"], "no temporary file is created");

    // Zero-byte creation is also durable and exclusive.
    const empty = path.join(root, "empty.bin");
    await durableCreateFile(empty, Buffer.alloc(0), { mode: 0o600 });
    assert.equal((await lstat(empty)).size, 0);
    assert.equal((await lstat(empty)).mode & 0o777, 0o600);
  });
});

test("durableCreateFile refuses any existing entry without replacing it", async () => {
  await withTemp(async (root) => {
    const target = path.join(root, "transaction.json");
    await writeFile(target, "original", { mode: 0o600 });
    await assert.rejects(() => durableCreateFile(target, Buffer.from("overwrite")), (error) => error.code === "EEXIST");
    assert.equal(await readFile(target, "utf8"), "original", "existing content preserved");
    assert.deepEqual(await readdir(root), ["transaction.json"], "no temp left behind");

    const linkTarget = path.join(root, "link-target");
    const link = path.join(root, "linked.json");
    await writeFile(linkTarget, "precious", { mode: 0o600 });
    await symlink(linkTarget, link);
    await assert.rejects(() => durableCreateFile(link, Buffer.from("x")), (error) => error.code === "ELOOP");
    assert.equal(await readFile(linkTarget, "utf8"), "precious", "symlink target untouched");

    const directory = path.join(root, "as-directory");
    await mkdir(directory);
    await assert.rejects(() => durableCreateFile(directory, Buffer.from("x")), (error) => error.code === "EFTYPE");
    assert.equal((await lstat(directory)).isDirectory(), true);

    const fifo = path.join(root, "as-fifo");
    if (spawnSync("mkfifo", [fifo]).status === 0) {
      await assert.rejects(() => durableCreateFile(fifo, Buffer.from("x")), (error) => error.code === "EFTYPE");
      assert.equal((await lstat(fifo)).isFIFO(), true, "the FIFO is left in place");
    }
  });
});

test("durableCreateFile removes only its own file on failure", async () => {
  await withTemp(async (root) => {
    const target = path.join(root, "transaction.json");

    await withInternals(
      { writeChunk: async () => { throw fsError("ENOSPC", "no space left on device"); } },
      async () => {
        await assert.rejects(() => durableCreateFile(target, Buffer.from("data")), (error) => error.code === "ENOSPC");
      },
    );
    await assert.rejects(() => lstat(target), (error) => error.code === "ENOENT");

    await withInternals(
      { syncFile: async () => { throw fsError("EIO", "injected fsync failure"); } },
      async () => {
        await assert.rejects(() => durableCreateFile(target, Buffer.from("data")), (error) => error.code === "EIO");
      },
    );
    await assert.rejects(() => lstat(target), (error) => error.code === "ENOENT");
    assert.deepEqual(await readdir(root), [], "failed creates leave nothing behind");

    // A file swapped into the path keeps its new identity: never deleted.
    const aside = path.join(root, ".aside");
    await withInternals(
      {
        syncFile: async () => {
          await rename(target, aside);
          await writeFile(target, "foreign-content", { mode: 0o600 });
          throw fsError("EIO", "injected fsync failure");
        },
      },
      async () => {
        await assert.rejects(() => durableCreateFile(target, Buffer.from("data")), (error) => error.code === "EIO");
      },
    );
    assert.equal(await readFile(target, "utf8"), "foreign-content", "identity-checked cleanup preserved the swap");
    await rm(aside, { force: true });
  });
});

test("durableCreateFile enforces owner-only modes and parent sync semantics", async () => {
  await withTemp(async (root) => {
    const target = path.join(root, "transaction.json");
    await assert.rejects(() => durableCreateFile(target, Buffer.from("x"), { mode: 0o644 }), (error) => error.code === "EINVAL");
    await assert.rejects(() => durableCreateFile(target, Buffer.from("x"), { mode: 0o666 }), (error) => error.code === "EINVAL");
    await assert.rejects(() => durableCreateFile(target, Buffer.from("x"), { mode: "600" }), TypeError);
    await assert.rejects(() => durableCreateFile(target, "not-bytes"), TypeError);
    await assert.rejects(() => durableCreateFile("", Buffer.from("x")), TypeError);
    assert.deepEqual(await readdir(root), []);

    // An unsupported parent sync is tolerated.
    await withInternals(
      { syncDirectoryHandle: async () => { throw fsError("EINVAL", "directory fsync unsupported"); } },
      async () => {
        await durableCreateFile(target, Buffer.from("tolerated"));
      },
    );
    assert.equal(await readFile(target, "utf8"), "tolerated");

    // A real parent sync failure propagates, but the creation is committed.
    const second = path.join(root, "second.json");
    await assert.rejects(
      withInternals(
        { syncDirectoryHandle: async () => { throw fsError("EIO", "directory io failure"); } },
        () => durableCreateFile(second, Buffer.from("committed")),
      ),
      (error) => error.code === "EIO",
    );
    assert.equal(await readFile(second, "utf8"), "committed", "the file itself is durable before the parent sync");
  });
});

/* ================================================================== *
 * Phase 14 - strong file identity is required for every create and
 * destructive exact-entry operation, and never guessed at
 * ================================================================== */

test("creates refuse a filesystem without stable file identity before any temp or file exists", async () => {
  await withTemp(async (root) => {
    await withWeakIdentity([root], async () => {
      await assert.rejects(
        () => durableAtomicWrite(path.join(root, "owner.json"), Buffer.from("payload")),
        (error) => error.code === "ENOTSUP",
      );
      await assert.rejects(
        () => durableCreateFile(path.join(root, "transaction.json"), Buffer.from("journal")),
        (error) => error.code === "ENOTSUP",
      );
      await assert.rejects(() => assertDirectoryIdentitySupport(root), (error) => error.code === "ENOTSUP");
    });
    assert.deepEqual(await readdir(root), [], "no temp file, journal, or control record was created");
    // The preflight is a read-only observation: an ordinary directory still
    // reports support and the writes then succeed.
    assert.equal(await assertDirectoryIdentitySupport(root), true);
    await durableCreateFile(path.join(root, "transaction.json"), Buffer.from("journal"));
    assert.equal(await readFile(path.join(root, "transaction.json"), "utf8"), "journal");
  });
});

test("durableUnlink refuses an entry whose identity cannot be proven and preserves it", async () => {
  await withTemp(async (root) => {
    const file = path.join(root, "owner.json");
    await writeFile(file, "precious", { mode: 0o600 });
    await withWeakIdentity([file], async () => {
      await assert.rejects(
        () => durableUnlink(file, { status: "available", dev: 1, ino: 1 }),
        (error) => error.code === "ENOTSUP",
      );
    });
    assert.equal(await readFile(file, "utf8"), "precious", "the unprovable entry is preserved byte for byte");

    // A proven entry is still removed exactly, with its attributed identity.
    await durableUnlink(file, fileIdentity(await lstat(file)));
    assert.deepEqual(await readdir(root), []);
  });
});

test("failure cleanup preserves a temp entry whose identity cannot be proven", async () => {
  await withTemp(async (root) => {
    const target = path.join(root, "owner.json");
    const originalSync = durableFsInternals.syncFile;
    durableFsInternals.syncFile = async () => {
      throw fsError("EIO", "injected fsync failure");
    };
    // The temp name is `.owner.json.<random>.tmp`; weaken exactly that shape
    // so the destination check and the directory preflight stay ordinary.
    const tempPattern = /^\.owner\.json\.[0-9a-f]{16}\.tmp$/;
    const originalLstat = durableFsInternals.lstat;
    try {
      await withInternals(
        {
          lstat: async (targetPath) => {
            const stat = await originalLstat(targetPath);
            if (!tempPattern.test(path.basename(targetPath))) return stat;
            return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: 0 });
          },
        },
        async () => {
          await assert.rejects(() => durableAtomicWrite(target, Buffer.from("data")), (error) => error.code === "EIO");
        },
      );
    } finally {
      durableFsInternals.syncFile = originalSync;
    }
    const entries = await readdir(root);
    assert.equal(entries.length, 1, "the temp entry survives the failed write");
    assert.match(entries[0], tempPattern);
    assert.equal(await readFile(path.join(root, entries[0]), "utf8"), "data", "the unprovable temp is never deleted");
    assert.equal(await exists(target), false, "nothing lands at the destination");
    await rm(path.join(root, entries[0]), { force: true });
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

test("durableUnlink preserves a replacement that appears at the fresh claim (B1)", async () => {
  await withTemp(async (root) => {
    const file = path.join(root, "owner.json");
    await writeFile(file, "precious", { mode: 0o600 });

    const originalRename = durableFsInternals.rename;
    let claimPath = null;
    await withInternals(
      {
        rename: async (from, to) => {
          await originalRename(from, to);
          if (path.resolve(from) === path.resolve(file)) {
            // B1 injection: a hostile same-user replacement appears at the
            // fresh claim right after the rename that created it. The claim is
            // renamed aside, not deleted: an inode allocator with eager reuse
            // (ext4 on the Linux runner) can give the replacement the same
            // dev/ino the deleted claim just freed, which would make the swap
            // invisible to the identity recheck. Renaming keeps that inode
            // allocated, so the replacement provably differs everywhere.
            claimPath = to;
            await rename(to, path.join(root, "pinned-original"));
            await writeFile(to, "swapped", { mode: 0o600 });
          }
        },
      },
      async () => {
        await assert.rejects(
          async () => durableUnlink(file, fileIdentity(await lstat(file))),
          (error) => error.code === "EBUSY",
        );
      },
    );
    assert.ok(claimPath, "the removal actually reached the claim rename");
    assert.equal(await readFile(claimPath, "utf8"), "swapped", "the replacement survives");
    assert.deepEqual(
      (await readdir(root)).sort(),
      [path.basename(claimPath), "pinned-original"].sort(),
      "only the preserved replacement and the pinned original remain",
    );
  });
});

test("durableUnlink removes the entry through its claim and leaves no name behind", async () => {
  await withTemp(async (root) => {
    const file = path.join(root, "owner.json");
    await writeFile(file, "bye", { mode: 0o600 });
    await durableUnlink(file, fileIdentity(await lstat(file)));
    assert.deepEqual(await readdir(root), [], "the entry and its claim are both gone");
  });
});

test("B1: a replacement that appears before durableUnlink's first observation survives byte-identical", async () => {
  await withTemp(async (root) => {
    const file = path.join(root, "owner.json");
    await writeFile(file, "attributed", { mode: 0o600 });
    const attributed = fileIdentity(await lstat(file));

    // The hostile replacement lands between the caller's attribution and this
    // call's first observation: the attributed identity no longer matches, so
    // nothing is renamed, claimed, or unlinked. The original is renamed aside
    // rather than deleted: an inode allocator with eager reuse (ext4 on the
    // Linux runner) can hand the replacement the same dev/ino the deleted file
    // just freed, which would make the swap invisible to the identity check.
    // Renaming keeps the old inode allocated, so the replacement always
    // differs on every platform.
    await rename(file, path.join(root, "owner.json.pinned"));
    await writeFile(file, "replacement", { mode: 0o600 });
    await assert.rejects(() => durableUnlink(file, attributed), (error) => error.code === "EBUSY");
    assert.equal(await readFile(file, "utf8"), "replacement", "the replacement survives byte-identical");
    assert.deepEqual(
      (await readdir(root)).sort(),
      ["owner.json", "owner.json.pinned"].sort(),
      "no claim was created",
    );

    // With the current attribution the same call succeeds exactly.
    await durableUnlink(file, fileIdentity(await lstat(file)));
    assert.deepEqual(await readdir(root), ["owner.json.pinned"]);
  });
});

test("B1: durableUnlink rejects a malformed expected identity and an unprovable one", async () => {
  await withTemp(async (root) => {
    const file = path.join(root, "owner.json");
    await writeFile(file, "keep", { mode: 0o600 });
    await assert.rejects(() => durableUnlink(file, "3:42"), TypeError);
    await assert.rejects(() => durableUnlink(file, { dev: 0, ino: 0 }), (error) => error.code === "ENOTSUP");
    assert.equal(await readFile(file, "utf8"), "keep", "nothing was touched");
  });
});

test("B1: every durableUnlink call in src passes an expected identity (static audit)", async () => {
  const srcDirectory = fileURLToPath(new URL("../src/", import.meta.url));
  const offenders = [];
  for (const name of (await readdir(srcDirectory)).filter((entry) => entry.endsWith(".js"))) {
    const text = await readFile(path.join(srcDirectory, name), "utf8");
    for (const match of text.matchAll(/\bdurableUnlink\s*\(([\s\S]*?)\)/g)) {
      const args = match[1]
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part !== "");
      if (args.length < 2) offenders.push(`${name}: ${match[0].replace(/\s+/g, " ")}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "every durableUnlink call must pass the caller's expected strong identity",
  );
});
