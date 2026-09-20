import assert from "node:assert/strict";
import test from "node:test";
import { parseFrontmatter, skillMetadata } from "../src/frontmatter.js";

test("parses supported portable metadata and nested OpenCode metadata", () => {
  const parsed = parseFrontmatter(`---\nname: "Review"\ndescription: Review code\nmetadata:\n  opencode/autoinvoke: false\n---\n\nBody\n`);
  assert.deepEqual(skillMetadata(parsed.attributes), {
    name: "Review",
    description: "Review code",
    compatibility: undefined,
    opencodeAutoinvoke: false,
  });
  assert.equal(parsed.body, "\nBody\n");
});

test("treats a document without frontmatter as a body", () => {
  const parsed = parseFrontmatter("Instructions only\n");
  assert.equal(parsed.hasFrontmatter, false);
  assert.deepEqual(parsed.attributes, {});
});

test("rejects missing delimiters and duplicate keys", () => {
  assert.throws(() => parseFrontmatter("---\nname: broken\n"), /closing/);
  assert.throws(
    () => parseFrontmatter("---\nname: one\nname: two\n---\n"),
    /duplicate/,
  );
});

test("does not allow prototype keys to smuggle skill metadata", () => {
  const parsed = parseFrontmatter(
    "---\n__proto__:\n  name: Smuggled\n  description: Smuggled description\n---\nBody",
  );
  assert.equal(Object.getPrototypeOf(parsed.attributes), null);
  assert.equal(skillMetadata(parsed.attributes).name, undefined);
  assert.equal(skillMetadata(parsed.attributes).description, undefined);

  const nested = parseFrontmatter(
    "---\nmetadata:\n  __proto__:\n    opencode/autoinvoke: false\n---\nBody",
  );
  assert.equal(Object.getPrototypeOf(nested.attributes.metadata), null);
  assert.equal(skillMetadata(nested.attributes).opencodeAutoinvoke, undefined);
});

test("supports block scalar descriptions, comments, and a closing delimiter at EOF", () => {
  const folded = parseFrontmatter(
    "---\nname: Release # display name\ndescription: >\n  Prepare notes and\n  publish artifacts\n---",
  );
  assert.equal(skillMetadata(folded.attributes).name, "Release");
  assert.equal(skillMetadata(folded.attributes).description, "Prepare notes and publish artifacts");
  assert.equal(folded.body, "");
});
