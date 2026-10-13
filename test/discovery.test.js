import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverSource, discoverSources } from "../src/discovery.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const document = (name) => `---\nname: ${name}\ndescription: Test skill\n---\n\nBody.\n`;

async function makeSource(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return root;
}

const detailedInvalidIds = (result) => result.diagnostics.filter((item) => item.code === "invalid-skill-id");

test("discovers flat and nested skills without loading bodies into entries", async () => {
  const result = await discoverSource(path.join(fixtures, "source-low"));
  assert.deepEqual(result.skills.map((skill) => skill.id), ["review", "release"]);
  const review = result.skills.find((skill) => skill.id === "review");
  assert.equal(review.opencodeAutoinvoke, false);
  assert.equal(review.description, "Review code for correctness and maintainability");
  assert.equal(Object.hasOwn(review, "body"), false);
});

test("tracks source precedence", async () => {
  const result = await discoverSources([
    path.join(fixtures, "source-low"),
    path.join(fixtures, "source-high"),
  ]);
  const releases = result.skills.filter((skill) => skill.id === "release");
  assert.deepEqual(releases.map((skill) => skill.sourceIndex), [0, 1]);
});

test("reports malformed skills and missing sources", async () => {
  const malformed = await discoverSource(path.join(fixtures, "source-malformed"));
  assert.equal(malformed.skills.length, 0);
  assert.equal(malformed.diagnostics[0].code, "invalid-skill");

  const missing = await discoverSource(path.join(fixtures, "absent"));
  assert.equal(missing.diagnostics[0].code, "source-not-found");
});

test("rejects a source-root SKILL.md literal ID and omits it", async () => {
  const result = await discoverSource(path.join(fixtures, "source-root-skill"));
  assert.deepEqual(result.skills, []);
  const invalid = detailedInvalidIds(result);
  assert.equal(invalid.length, 1, "exactly one invalid-skill-id error");
  assert.equal(invalid[0].level, "error");
  assert.equal(invalid[0].reason, "grammar");
  assert.equal(result.diagnostics.some((item) => item.code === "root-skill-id"), false);
  assert.equal(result.diagnostics.some((item) => item.code === "non-portable-id"), false);
  // The rejected candidate still contributes to the source fingerprint.
  const candidate = result.fingerprintEntries.find((item) => item.kind === "candidate");
  assert.match(candidate.contentHash, /^[a-f0-9]{64}$/);
});

test("omits invalid-ID candidates with a bounded error and keeps valid siblings", async (t) => {
  const root = await makeSource(t, {
    "good.md": document("Good"),
    "Bad_Name.md": document("Bad"),
    "nested/AlsoBad Name/SKILL.md": document("Also"),
  });
  const result = await discoverSource(root);
  assert.deepEqual(result.skills.map((skill) => skill.id), ["good"]);

  const invalid = detailedInvalidIds(result);
  assert.equal(invalid.length, 2);
  assert.ok(invalid.every((item) => item.level === "error"));
  assert.ok(invalid.every((item) => item.reason === "grammar"));
  for (const item of invalid) {
    assert.ok(!/[\u0000-\u001f]/.test(item.message + item.path), "diagnostics are control-free");
    assert.ok(!path.isAbsolute(item.path), "path is source-relative");
    assert.equal(item.message.includes("Bad_Name"), false, "malformed ID is never echoed");
    assert.equal(item.message.includes("AlsoBad"), false, "malformed ID is never echoed");
    assert.equal(Object.hasOwn(item, "id"), false, "diagnostic never carries the malformed ID");
  }
  assert.deepEqual(
    invalid.map((item) => item.path).sort(),
    ["Bad_Name.md", "nested/AlsoBad Name/SKILL.md"],
  );

  // Rejected candidates still hash into the fingerprint.
  const candidates = result.fingerprintEntries.filter((item) => item.kind === "candidate");
  assert.equal(candidates.length, 3);
  assert.ok(candidates.every((item) => /^[a-f0-9]{64}$/.test(item.contentHash)));
});

test("rejects the reserved skill-router ID at discovery time", async (t) => {
  const root = await makeSource(t, {
    "skill-router/SKILL.md": document("Reserved"),
    "keeper.md": document("Keeper"),
  });
  const result = await discoverSource(root);
  assert.deepEqual(result.skills.map((skill) => skill.id), ["keeper"]);
  const invalid = detailedInvalidIds(result);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].reason, "reserved");
  assert.equal(result.skills.some((skill) => skill.id === "skill-router"), false, "reserved never reaches skills");
});

test("keeps a direct SKILL.md whose parent directory is a portable ID", async (t) => {
  const root = await makeSource(t, { "my-skill/SKILL.md": document("Direct") });
  const result = await discoverSource(path.join(root, "my-skill", "SKILL.md"));
  assert.deepEqual(result.skills.map((skill) => skill.id), ["my-skill"]);
  assert.deepEqual(result.diagnostics, []);

  const bad = await makeSource(t, { "Bad Parent/SKILL.md": document("Direct") });
  const badResult = await discoverSource(path.join(bad, "Bad Parent", "SKILL.md"));
  assert.deepEqual(badResult.skills, []);
  assert.equal(detailedInvalidIds(badResult).length, 1);
});

test("enforces the exact 64-character boundary", async (t) => {
  const root = await makeSource(t, {
    [`ok/${"a".repeat(64)}/SKILL.md`]: document("Exact"),
    [`too-long/${"b".repeat(65)}/SKILL.md`]: document("Overflow"),
  });
  const result = await discoverSource(root);
  assert.deepEqual(result.skills.map((skill) => skill.id), ["a".repeat(64)]);
  const invalid = detailedInvalidIds(result);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].reason, "length");
});

test("caps detailed invalid-ID diagnostics at 20 plus one overflow summary", async (t) => {
  const files = { "keeper.md": document("Keeper") };
  for (let index = 0; index < 25; index += 1) {
    files[`bad_${index}.md`] = document(`Bad ${index}`);
  }
  const root = await makeSource(t, files);
  const result = await discoverSource(root);

  assert.deepEqual(result.skills.map((skill) => skill.id), ["keeper"]);
  const invalid = detailedInvalidIds(result);
  assert.equal(invalid.length, 20);
  assert.ok(invalid.every((item) => item.message.length < 120), "messages stay bounded");
  const overflow = result.diagnostics.filter((item) => item.code === "invalid-skill-id-overflow");
  assert.equal(overflow.length, 1);
  assert.equal(overflow[0].level, "error");
  assert.equal(overflow[0].suppressed, 5);
  assert.equal(overflow[0].message.length < 200, true);
});

test("bounds hostile paths and keeps valid candidates in the same source", async (t) => {
  const root = await makeSource(t, {
    "good.md": document("Good"),
    "evil\u0001name.md": document("Evil"),
    [`deep/${"d".repeat(80)}/very-long-directory-name-${"e".repeat(80)}/SKILL.md`]: document("Deep"),
  });
  const result = await discoverSource(root);
  assert.deepEqual(result.skills.map((skill) => skill.id), ["good"]);
  const invalid = detailedInvalidIds(result);
  assert.equal(invalid.length, 2);
  for (const item of invalid) {
    assert.ok(!/[\u0000-\u001f]/.test(item.message), "message is control-free");
    assert.ok(!/[\u0000-\u001f]/.test(item.path), "path is control-free");
    assert.ok(item.path.length <= 200, "path is bounded");
    assert.ok(!path.isAbsolute(item.path));
  }
});

test("fingerprint freshness still tracks invalid candidates", async (t) => {
  const root = await makeSource(t, {
    "bad_id.md": document("Bad"),
    "good.md": document("Good"),
  });
  const first = await discoverSource(root);
  const before = first.fingerprintEntries.find((item) => item.kind === "candidate" && item.path.endsWith("bad_id.md"));

  await writeFile(path.join(root, "bad_id.md"), document("Changed"));
  const second = await discoverSource(root);
  const after = second.fingerprintEntries.find((item) => item.kind === "candidate" && item.path.endsWith("bad_id.md"));
  assert.notEqual(before.contentHash, after.contentHash, "editing an invalid file changes its fingerprint");

  await rm(path.join(root, "bad_id.md"));
  const third = await discoverSource(root);
  assert.equal(
    third.fingerprintEntries.some((item) => item.kind === "candidate" && item.path.endsWith("bad_id.md")),
    false,
    "removing an invalid file removes its fingerprint entry",
  );
  assert.equal(detailedInvalidIds(third).length, 0);
  assert.deepEqual(third.skills.map((skill) => skill.id), ["good"]);
});

test("keeps valid candidates across mixed sources while rejecting invalid ones", async (t) => {
  const low = await makeSource(t, { "Bad_Name.md": document("Bad"), "keeper.md": document("Keeper") });
  const high = await makeSource(t, { "skill-router/SKILL.md": document("Reserved") });
  const result = await discoverSources([low, high]);
  assert.deepEqual(result.skills.map((skill) => skill.id), ["keeper"]);
  assert.equal(result.diagnostics.filter((item) => item.code === "invalid-skill-id").length, 2);
});

test("an invalid-ID candidate with a broken body emits only the capped invalid-ID diagnostic", async (t) => {
  const root = await makeSource(t, {
    "good.md": document("Good"),
    // Terminal-control filename plus a body the parser rejects.
    "evil\u0001\u001b[31m.md": "---\nname: Evil\ndescription: Broken\n",
    "nested/Bad Name/SKILL.md": "---\nname: Also\ndescription: Broken\n",
  });
  const result = await discoverSource(root);
  assert.deepEqual(result.skills.map((skill) => skill.id), ["good"]);
  assert.equal(
    result.diagnostics.some((item) => item.code === "invalid-skill"),
    false,
    "a broken invalid-ID candidate never emits a parallel parse error",
  );
  const invalid = detailedInvalidIds(result);
  assert.equal(invalid.length, 2);
  assert.ok(invalid.every((item) => item.level === "error" && item.reason === "grammar"));
  assert.ok(invalid.every((item) => !path.isAbsolute(item.path)));

  // The serialized diagnostics are bounded and control-free: no raw control
  // byte, no escape sequence, no malformed ID fragment, no absolute path.
  const serialized = JSON.stringify(result.diagnostics);
  assert.equal(/[\u0000-\u001f]/.test(serialized), false, "diagnostics are control-free");
  assert.equal(serialized.includes("\u0001"), false);
  assert.equal(serialized.includes("\u001b[31m"), false, "no escape sequence survives");
  assert.equal(serialized.includes("Evil"), false, "the malformed ID is never echoed");
  assert.equal(serialized.includes(root), false, "no absolute source path");
  assert.ok(serialized.length < 2000, "diagnostics stay bounded");

  // Freshness still covers the broken invalid candidates.
  const candidates = result.fingerprintEntries.filter((item) => item.kind === "candidate");
  assert.equal(candidates.length, 3);
  assert.ok(candidates.every((item) => /^[a-f0-9]{64}$/.test(item.contentHash)));
});

test("25 malformed invalid candidates produce exactly 20 detailed errors plus one overflow", async (t) => {
  const files = { "keeper.md": document("Keeper") };
  for (let index = 0; index < 25; index += 1) {
    files[`bad_${index}.md`] = "---\nname: Broken\ndescription: No closing delimiter\n";
  }
  const root = await makeSource(t, files);
  const result = await discoverSource(root);
  assert.deepEqual(result.skills.map((skill) => skill.id), ["keeper"]);
  assert.equal(detailedInvalidIds(result).length, 20, "exactly 20 detailed invalid-ID diagnostics");
  assert.equal(
    result.diagnostics.filter((item) => item.code === "invalid-skill").length,
    0,
    "no parallel parse errors bypass the cap",
  );
  const overflow = result.diagnostics.filter((item) => item.code === "invalid-skill-id-overflow");
  assert.equal(overflow.length, 1);
  assert.equal(overflow[0].suppressed, 5);
  const candidates = result.fingerprintEntries.filter((item) => item.kind === "candidate");
  assert.equal(candidates.length, 26, "every candidate keeps its fingerprint entry");
});

test("valid-ID load failures keep the invalid-skill code with a fixed bounded shape", async (t) => {
  const root = await makeSource(t, {
    "broken.md": "---\nname: Broken\ndescription: No closing delimiter\n",
  });
  const secret = path.join(root, "secret.md");
  await writeFile(secret, document("Secret"));
  await chmod(secret, 0o000);
  let readable = true;
  try {
    await readFile(secret);
  } catch {
    readable = false;
  }

  const result = await discoverSource(root);
  // An unreadable candidate is a read failure; a readable one loads fine.
  assert.deepEqual(result.skills.map((skill) => skill.id), readable ? ["secret"] : []);
  const failures = result.diagnostics.filter((item) => item.code === "invalid-skill");
  assert.equal(failures.length, readable ? 1 : 2);
  const reasons = new Map();
  for (const item of failures) {
    assert.equal(item.level, "error");
    assert.match(item.message, /^Skill file cannot be loaded \(reason: (read|frontmatter)\)$/);
    assert.equal(item.reason === "read" || item.reason === "frontmatter", true);
    assert.equal(path.isAbsolute(item.path), false, "path is source-relative");
    assert.equal(/[\u0000-\u001f]/.test(item.message + item.path), false, "control-free");
    assert.ok(item.path.length <= 200, "path stays bounded");
    assert.equal(item.id, path.basename(item.path, ".md"), "the validated ID is included");
    assert.match(item.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    reasons.set(item.path, item.reason);
  }
  assert.equal(reasons.get("broken.md"), "frontmatter");
  if (!readable) assert.equal(reasons.get("secret.md"), "read");

  // No absolute path, raw cause, errno, or syscall text anywhere.
  const serialized = JSON.stringify(result.diagnostics);
  assert.equal(serialized.includes(root), false);
  assert.equal(/EACCES|ENOENT|errno|syscall/.test(serialized), false);
  assert.equal(serialized.includes("closing delimiter"), false, "no parser text");
  // The failures still block: they are error-level diagnostics.
  assert.ok(failures.every((item) => item.level === "error"));

  // Fingerprint entries still cover both candidates.
  const candidates = result.fingerprintEntries.filter((item) => item.kind === "candidate");
  assert.equal(candidates.length, 2);
  if (!readable) {
    assert.ok(candidates.some((item) => item.status === "unreadable"), "the unreadable candidate still fingerprints");
  } else {
    assert.ok(candidates.every((item) => /^[a-f0-9]{64}$/.test(item.contentHash)));
  }
  await chmod(secret, 0o644);
});

test("a source exactly at the entry bound inventories normally and one more entry blocks it", async (t) => {
  const root = await makeSource(t, { "extra.md": document("Extra"), "keeper.md": document("Keeper") });
  // Exactly two observed entries; the default limits and the injected exact
  // bound both accept the same inventory.
  assert.deepEqual((await discoverSource(root)).skills.map((skill) => skill.id), ["extra", "keeper"]);
  const exact = await discoverSource(root, 0, { limits: { maxEntries: 2 } });
  assert.deepEqual(exact.skills.map((skill) => skill.id), ["extra", "keeper"]);

  const overflow = await discoverSource(root, 0, { limits: { maxEntries: 1 } });
  assert.deepEqual(overflow.skills, [], "no partial skill inventory");
  assert.deepEqual(overflow.diagnostics, [
    {
      level: "error",
      code: "source-limit-exceeded",
      message: "Skill source exceeds the supported size limits (reason: entries)",
      reason: "entries",
    },
  ]);
  assert.deepEqual(overflow.fingerprintEntries, [
    { kind: "source", source: root, sourceIndex: 0, status: "directory" },
  ]);
  const serialized = JSON.stringify(overflow.diagnostics);
  assert.equal(serialized.includes(root), false, "no absolute path reaches the refusal");
  assert.equal(serialized.includes("extra"), false, "no candidate name reaches the refusal");
});

test("a bound failure never returns a partial inventory or parallel candidate diagnostics", async (t) => {
  // Both documents are the same length, so the first read fits the aggregate
  // budget exactly and the second one is what overflows it.
  const first = document("Alpha");
  const root = await makeSource(t, { "aaa.md": first, "zeta.md": document("Gamma") });
  assert.equal(Buffer.byteLength(first), Buffer.byteLength(document("Gamma")));

  const overflow = await discoverSource(root, 0, { limits: { maxTotalBytes: Buffer.byteLength(first) } });
  assert.deepEqual(overflow.skills, [], "the already-read candidate is dropped, not returned");
  assert.deepEqual(overflow.diagnostics.map((item) => item.code), ["source-limit-exceeded"]);
  assert.equal(overflow.diagnostics[0].reason, "total-bytes");
  assert.deepEqual(
    overflow.fingerprintEntries.filter((item) => item.kind === "candidate"),
    [],
    "no partial candidate fingerprints survive either",
  );

  // A per-file overflow maps the same way.
  const perFile = await discoverSource(root, 0, { limits: { maxFileBytes: Buffer.byteLength(first) - 1 } });
  assert.deepEqual(perFile.skills, []);
  assert.deepEqual(perFile.diagnostics.map((item) => item.code), ["source-limit-exceeded"]);
  assert.equal(perFile.diagnostics[0].reason, "file-bytes");
});

test("depth beyond the fixed bound blocks the source while the exact bound still discovers it", async (t) => {
  const chain = (levels) =>
    [...Array(levels)].map((_, index) => `d${String(index + 1).padStart(2, "0")}`).join("/") + "/SKILL.md";
  const shallow = await makeSource(t, { [chain(31)]: document("Deep") });
  assert.deepEqual((await discoverSource(shallow)).skills.map((skill) => skill.id), ["d31"]);

  const deep = await makeSource(t, { [chain(32)]: document("Deeper") });
  const overflow = await discoverSource(deep);
  assert.deepEqual(overflow.skills, []);
  assert.deepEqual(overflow.diagnostics.map((item) => item.code), ["source-limit-exceeded"]);
  assert.equal(overflow.diagnostics[0].reason, "depth");
});

test("discovery skips .git and node_modules subtrees while still counting their entries", async (t) => {
  const root = await makeSource(t, {
    "keeper.md": document("Keeper"),
    ".git/config": "[core]\n",
    "node_modules/pkg/SKILL.md": document("Pkg"),
  });
  assert.deepEqual((await discoverSource(root)).skills.map((skill) => skill.id), ["keeper"]);
  // keeper.md + `.git` + `node_modules` are exactly three observed entries;
  // the skipped subtrees are never opened, so the hidden SKILL.md is not a
  // candidate even at the exact bound.
  const exact = await discoverSource(root, 0, { limits: { maxEntries: 3 } });
  assert.deepEqual(exact.skills.map((skill) => skill.id), ["keeper"]);
  const overflow = await discoverSource(root, 0, { limits: { maxEntries: 2 } });
  assert.deepEqual(overflow.skills, []);
  assert.equal(overflow.diagnostics[0].code, "source-limit-exceeded");
  assert.equal(overflow.diagnostics[0].reason, "entries");
});

test("a symlinked candidate stays silently skipped: never read, never diagnosed", async (t) => {
  const root = await makeSource(t, { "keeper.md": document("Keeper") });
  await symlink(path.join(root, "keeper.md"), path.join(root, "linked.md"));
  const result = await discoverSource(root);
  assert.deepEqual(result.skills.map((skill) => skill.id), ["keeper"]);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(
    result.fingerprintEntries.filter((item) => item.kind === "candidate").length,
    1,
    "the symlink is never hashed or fingerprinted",
  );
});
