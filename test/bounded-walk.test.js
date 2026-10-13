import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BOUNDED_WALK_LIMITS,
  BOUNDED_WALK_REASONS,
  BOUNDED_WALK_SKIP_NAMES,
  BoundedWalkError,
  boundedWalk,
  boundedWalkInternals,
  createWalkBudget,
  isBoundedWalkLimit,
  isBoundedWalkUnsafe,
  readBoundedFile,
} from "../src/bounded-walk.js";
import { fileIdentity, isIdentityAvailable } from "../src/durable-fs.js";

async function makeTree(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-bounded-walk-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (directory, entries) => {
    for (const [name, content] of Object.entries(entries)) {
      const target = path.join(directory, name);
      if (typeof content === "object" && content !== null && !Buffer.isBuffer(content)) {
        await mkdir(target, { recursive: true });
        await write(target, content);
      } else {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content);
      }
    }
  };
  await write(root, files);
  return root;
}

/** Deepest-first chain of `levels` directories under `root`, with a file inside the deepest one. */
async function makeChain(t, root, levels) {
  let directory = root;
  for (let level = 1; level < levels; level += 1) {
    directory = path.join(directory, `d${String(level).padStart(2, "0")}`);
    await mkdir(directory, { recursive: true });
  }
  await writeFile(path.join(directory, "leaf.md"), "leaf\n");
  return directory;
}

const collect = (root, options = {}) => {
  const files = [];
  const symlinks = [];
  const specials = [];
  return {
    files,
    symlinks,
    specials,
    result: boundedWalk(root, {
      ...options,
      onFile: async (entry) => {
        files.push(entry.relative);
        if (options.onFile) await options.onFile(entry);
      },
      onSymlink: (entry) => {
        symlinks.push(entry.relative);
        if (options.onSymlink) options.onSymlink(entry);
      },
      onSpecial: (entry) => {
        specials.push(entry.relative);
        if (options.onSpecial) options.onSpecial(entry);
      },
    }),
  };
};

test("the production limits are fixed, frozen, and never user-configurable", () => {
  assert.deepEqual({ ...BOUNDED_WALK_LIMITS }, {
    maxEntries: 4096,
    maxDepth: 32,
    maxFileBytes: 16 * 1024 * 1024,
    maxTotalBytes: 64 * 1024 * 1024,
  });
  assert.equal(Object.isFrozen(BOUNDED_WALK_LIMITS), true);
  assert.equal(Object.isFrozen(BOUNDED_WALK_SKIP_NAMES), true);
  assert.deepEqual([...BOUNDED_WALK_SKIP_NAMES], [".git", "node_modules"]);
  assert.deepEqual([...BOUNDED_WALK_REASONS], ["entries", "depth", "file-bytes", "total-bytes"]);
  // A shared budget always starts from the fixed defaults.
  assert.deepEqual({ ...createWalkBudget().limits }, { ...BOUNDED_WALK_LIMITS });
  assert.equal(createWalkBudget().bytesRead, 0);
});

test("a bound failure carries exactly one stable reason and never a path", async (t) => {
  const root = await makeTree(t, { "a.md": "a\n", "b.md": "b\n" });
  const error = await boundedWalk(root, { limits: { maxEntries: 1 } }).then(
    () => null,
    (thrown) => thrown,
  );
  assert.equal(error instanceof BoundedWalkError, true);
  assert.equal(error.reason, "entries");
  assert.equal(error.code, "BOUNDED_WALK_LIMIT");
  assert.equal(isBoundedWalkLimit(error), true);
  assert.equal(isBoundedWalkLimit(new Error("other")), false);
  assert.equal(error.message.includes(root), false, "the root path is never echoed");
  assert.equal(error.message, "Bounded filesystem traversal exceeded its entries limit");
  assert.match(error.message, /^Bounded filesystem traversal exceeded its (entries|depth|file-bytes|total-bytes) limit$/);
  assert.throws(() => new BoundedWalkError("everything"), TypeError);
});

test("the exact entry limit passes and one more entry fails, reading nothing after the overflow", async (t) => {
  const root = await makeTree(t, { f01: "1\n", f02: "2\n", later: { "x.md": "x\n" } });
  // `.git`-style structure: `later` is a directory whose child would be the
  // 5th observed entry.
  const exact = await collect(root, { limits: { maxEntries: 4 } });
  await exact.result;
  assert.deepEqual(exact.files, ["f01", "f02", "later/x.md"]);

  const overflow = await collect(root, { limits: { maxEntries: 3 } });
  await assert.rejects(overflow.result, (error) => isBoundedWalkLimit(error) && error.reason === "entries");
  // The overflowing entry is never classified or reported, and its subtree is
  // never opened: no read happens after the overflow.
  assert.deepEqual(overflow.files, ["f01", "f02"]);
});

test("depth 32 passes and depth 33 fails on the fixed production limit, reading nothing deeper", async (t) => {
  const shallow = await makeTree(t, {});
  const deepest = await makeChain(t, shallow, 32);
  const ok = await collect(shallow);
  await ok.result;
  assert.deepEqual(ok.files, [
    "d01/d02/d03/d04/d05/d06/d07/d08/d09/d10/d11/d12/d13/d14/d15/d16/d17/d18/d19/d20/d21/d22/d23/d24/d25/d26/d27/d28/d29/d30/d31/leaf.md",
  ]);
  assert.ok(deepest.includes("d31"));

  const deeper = await makeTree(t, {});
  await makeChain(t, deeper, 33);
  const overflow = await collect(deeper);
  await assert.rejects(overflow.result, (error) => isBoundedWalkLimit(error) && error.reason === "depth");
  assert.deepEqual(overflow.files, [], "no file at or below the overflowing depth is ever reported");
});

test("a per-file byte overflow and an aggregate byte overflow are distinct bound failures", async (t) => {
  const root = await makeTree(t, { "four.md": "1234", "also-four.md": "5678" });

  const perFile = createWalkBudget({ maxFileBytes: 4, maxTotalBytes: 100 });
  assert.equal((await readBoundedFile(path.join(root, "four.md"), perFile)).length, 4);
  await assert.rejects(
    readBoundedFile(path.join(root, "also-four.md"), createWalkBudget({ maxFileBytes: 3 })),
    (error) => isBoundedWalkLimit(error) && error.reason === "file-bytes",
  );

  const aggregate = createWalkBudget({ maxFileBytes: 4, maxTotalBytes: 7 });
  await readBoundedFile(path.join(root, "four.md"), aggregate);
  await assert.rejects(
    readBoundedFile(path.join(root, "also-four.md"), aggregate),
    (error) => isBoundedWalkLimit(error) && error.reason === "total-bytes",
  );

  // Exact budgets charge the actual bytes and pass.
  const exact = createWalkBudget({ maxFileBytes: 4, maxTotalBytes: 8 });
  await readBoundedFile(path.join(root, "four.md"), exact);
  await readBoundedFile(path.join(root, "also-four.md"), exact);
  assert.equal(exact.bytesRead, 8);
});

test("a walk never reads a file it does not hand to a callback, and charges nothing itself", async (t) => {
  const root = await makeTree(t, { "a.md": "aaaa", "b.md": "bbbb" });
  const budget = createWalkBudget({ maxFileBytes: 4, maxTotalBytes: 8 });
  const seen = [];
  const walk = await boundedWalk(root, {
    budget,
    onFile: (entry) => {
      seen.push(entry.name);
    },
  });
  assert.deepEqual(seen, ["a.md", "b.md"]);
  assert.equal(walk.bytesRead, 0, "the walk itself reads no content");
  assert.equal(walk.entries, 2);
  // Reads through the same budget afterwards are what charge it.
  await readBoundedFile(path.join(root, "a.md"), budget);
  assert.equal(budget.bytesRead, 4);
});

test("traversal is deterministic and lexical regardless of creation order", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-bounded-order-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Created in a deliberately non-lexical order.
  for (const relative of ["c.md", "b/x.md", "a.md", "a/z.md", "B.md"]) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "x\n");
  }
  const first = await collect(root);
  assert.deepEqual(await first.result, { entries: 7, bytesRead: 0, limits: BOUNDED_WALK_LIMITS });
  // Depth-first: a directory is entered where its name sorts, so `a/` is
  // visited before the sibling file `a.md`.
  assert.deepEqual(first.files, ["B.md", "a/z.md", "a.md", "b/x.md", "c.md"]);
  const second = await collect(root);
  await second.result;
  assert.deepEqual(second.files, first.files, "two walks of the same tree report the same order");
});

test("symlinks are never followed and the root itself must be a real directory", async (t) => {
  const root = await makeTree(t, { "real.md": "real\n" });
  const outside = await makeTree(t, { "secret.md": "secret\n" });
  await symlink(outside, path.join(root, "escape"));
  await symlink(path.join(root, "real.md"), path.join(root, "alias.md"));

  const walk = await collect(root);
  assert.deepEqual(await walk.result, { entries: 3, bytesRead: 0, limits: BOUNDED_WALK_LIMITS });
  assert.deepEqual(walk.files, ["real.md"], "neither the directory link nor the file link yields a file");
  assert.deepEqual(walk.symlinks, ["alias.md", "escape"]);
  assert.deepEqual(walk.specials, []);

  const linkedRoot = path.join(outside, "link-root");
  await symlink(root, linkedRoot);
  await assert.rejects(boundedWalk(linkedRoot), /Refusing to walk a symbolic-link root/);
  await assert.rejects(boundedWalk(path.join(root, "real.md")), /Refusing to walk a non-directory root/);
  await assert.rejects(boundedWalk(path.join(root, "absent")), /ENOENT/);
});

test("skipped names are counted but never descended into", async (t) => {
  const root = await makeTree(t, {
    "keeper.md": "keeper\n",
    ".git": { "config": "[core]\n", "objects": { "aa": "blob\n" } },
    "node_modules": { "left-pad": { "index.js": "module\n" } },
  });
  // Keeper + `.git` + `node_modules` = exactly three observed entries; the
  // skipped subtrees are never opened, so nothing inside them is ever read.
  const exact = await collect(root, { limits: { maxEntries: 3 } });
  assert.deepEqual(await exact.result, { entries: 3, bytesRead: 0, limits: { ...BOUNDED_WALK_LIMITS, maxEntries: 3 } });
  assert.deepEqual(exact.files, ["keeper.md"]);

  const overflow = await collect(root, { limits: { maxEntries: 2 } });
  await assert.rejects(overflow.result, (error) => error.reason === "entries");
  assert.deepEqual(overflow.files, [], "a skipped entry still counts toward the cap");
});

test("special files are reported through their callback and never typed as files", async (t) => {
  const root = await makeTree(t, { "keeper.md": "keeper\n" });
  const pipe = path.join(root, "pipe");
  const supported = spawnSync("mkfifo", [pipe]).status === 0;
  if (!supported) return;
  const walk = await collect(root);
  await walk.result;
  assert.deepEqual(walk.files, ["keeper.md"]);
  assert.deepEqual(walk.specials, ["pipe"]);
});

test("a throwing callback aborts the walk with its own error, not a bound failure", async (t) => {
  const root = await makeTree(t, { "a.md": "a\n", "b.md": "b\n" });
  await assert.rejects(
    boundedWalk(root, {
      onFile: (entry) => {
        if (entry.name === "b.md") throw new Error("callback refusal");
      },
    }),
    /callback refusal/,
  );
});

test("onDirectory reports every entered directory before its children, never a skipped one", async (t) => {
  const root = await makeTree(t, {
    "b/x.md": "x\n",
    "a": {},
    "a/nested/y.md": "y\n",
    ".git": { "config": "[core]\n" },
  });
  const directories = [];
  await boundedWalk(root, {
    onDirectory: (entry) => {
      directories.push(entry.relative);
    },
  });
  // `a` is reported even though it is empty, `a/nested` before its child, and
  // the skipped `.git` subtree is never reported or entered.
  assert.deepEqual(directories, ["a", "a/nested", "b"]);
});

test("a directory that would break the depth bound is refused before onDirectory reports it", async (t) => {
  const root = await makeTree(t, {});
  await makeChain(t, root, 33);
  const directories = [];
  const files = [];
  await assert.rejects(
    boundedWalk(root, {
      onDirectory: (entry) => {
        directories.push(entry.relative);
      },
      onFile: (entry) => {
        files.push(entry.relative);
      },
    }),
    (error) => isBoundedWalkLimit(error) && error.reason === "depth",
  );
  // The deepest reported directory is exactly at the bound; the overflowing
  // one is never handed to onDirectory, so a mirroring caller never creates
  // it, and nothing below it is ever reported.
  assert.equal(directories.length, 31, "every directory up to the bound is still reported");
  assert.equal(directories.at(-1).split("/").length, 31, "the deepest reported directory sits exactly at the bound");
  assert.equal(
    directories.some((relative) => relative.split("/").length >= 32),
    false,
    "the overflowing directory is never callback-reported",
  );
  assert.deepEqual(files, [], "no file below the overflowing directory is ever reported");
});

test("a root replaced by a symlink in the open window is refused before any entry is observed", async (t) => {
  const root = await makeTree(t, { "keeper.md": "keeper\n" });
  const outside = await makeTree(t, { "secret.md": "secret\n" });
  const original = boundedWalkInternals.opendir;
  boundedWalkInternals.opendir = async (target) => {
    if (path.resolve(target) === path.resolve(root)) {
      // Deterministic TOCTOU: the root is swapped for a symlink to an outside
      // tree immediately before the open, so the open resolves elsewhere.
      await rm(root, { recursive: true, force: true });
      await symlink(outside, root);
    }
    return original(target);
  };
  const observed = { files: [], directories: [], symlinks: [], specials: [] };
  let error;
  try {
    await boundedWalk(root, {
      onFile: (entry) => observed.files.push(entry.relative),
      onDirectory: (entry) => observed.directories.push(entry.relative),
      onSymlink: (entry) => observed.symlinks.push(entry.relative),
      onSpecial: (entry) => observed.specials.push(entry.relative),
    }).catch((caught) => {
      error = caught;
    });
  } finally {
    boundedWalkInternals.opendir = original;
  }
  assert.equal(isBoundedWalkUnsafe(error), true, "the replaced root fails closed");
  assert.equal(error.message.includes(root), false, "the refusal is path-free");
  assert.deepEqual(observed, { files: [], directories: [], symlinks: [], specials: [] });
  const serialized = JSON.stringify(observed);
  assert.equal(serialized.includes("secret"), false, "no outside entry is ever observed");
  assert.equal(serialized.includes("keeper"), false, "no entry of the replaced root survives either");
});

test("a child swapped for a symlink or another directory in the open window is refused", async (t) => {
  const outside = await makeTree(t, { "secret.md": "secret\n" });

  const swapAndWalk = async (root, child, swap) => {
    const original = boundedWalkInternals.opendir;
    boundedWalkInternals.opendir = async (target) => {
      if (path.resolve(target) === path.resolve(child)) await swap();
      return original(target);
    };
    const files = [];
    let error;
    try {
      await boundedWalk(root, { onFile: (entry) => files.push(entry.relative) }).catch((caught) => {
        error = caught;
      });
    } finally {
      boundedWalkInternals.opendir = original;
    }
    return { files, error };
  };

  // Swap to a symlink pointing outside: the post-open re-inspection sees a
  // symlink and refuses before a single entry of the target is read.
  const symlinked = await makeTree(t, { "a.md": "a\n", "z": { "inside.md": "inside\n" } });
  const symlinkResult = await swapAndWalk(symlinked, path.join(symlinked, "z"), async () => {
    await rm(path.join(symlinked, "z"), { recursive: true, force: true });
    await symlink(outside, path.join(symlinked, "z"));
  });
  assert.equal(isBoundedWalkUnsafe(symlinkResult.error), true);
  assert.deepEqual(symlinkResult.files, ["a.md"], "entries verified before the swap are kept; the replacement contributes none");
  assert.equal(JSON.stringify(symlinkResult.files).includes("secret"), false);

  // Swap to a *different real directory*: same type, different identity, so
  // the identity pin refuses it (strong-identity filesystems only).
  const replaced = await makeTree(t, { "a.md": "a\n", "z": { "inside.md": "inside\n" } });
  const other = await makeTree(t, { "other.md": "other\n" });
  const replaceResult = await swapAndWalk(replaced, path.join(replaced, "z"), async () => {
    await rm(path.join(replaced, "z"), { recursive: true, force: true });
    await mkdir(path.join(replaced, "z"), { recursive: true });
    await writeFile(path.join(replaced, "z", "other.md"), "other\n");
  });
  assert.equal(isBoundedWalkUnsafe(replaceResult.error), true);
  assert.deepEqual(replaceResult.files, ["a.md"], "the replacement directory contributes no entries");
  if (isIdentityAvailable(fileIdentity(await lstat(other)))) {
    assert.equal(replaceResult.files.includes("z/other.md"), false);
  }
});

test("the production entry cap stops a huge directory at 4097 observations without materializing it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-bounded-cap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const names = Array.from({ length: BOUNDED_WALK_LIMITS.maxEntries + 4 }, (_, index) => `f${String(index).padStart(4, "0")}`);
  for (let offset = 0; offset < names.length; offset += 256) {
    await Promise.all(names.slice(offset, offset + 256).map((name) => writeFile(path.join(root, name), "x")));
  }

  let pulled = 0;
  const original = boundedWalkInternals.opendir;
  boundedWalkInternals.opendir = async (target) => {
    const handle = await original(target);
    if (path.resolve(target) !== path.resolve(root)) return handle;
    return {
      async *[Symbol.asyncIterator]() {
        for await (const dirent of handle) {
          pulled += 1;
          yield dirent;
        }
      },
      close: () => handle.close(),
    };
  };
  try {
    await assert.rejects(
      boundedWalk(root),
      (error) => isBoundedWalkLimit(error) && error.reason === "entries",
    );
  } finally {
    boundedWalkInternals.opendir = original;
  }
  assert.equal(
    pulled,
    BOUNDED_WALK_LIMITS.maxEntries + 1,
    "enumeration stopped at the first overflowing entry; the remaining entries were never pulled",
  );
});
