import assert from "node:assert/strict";
import test from "node:test";
import { parse, parseDocument } from "yaml";
import { parseFrontmatter, skillMetadata } from "../src/frontmatter.js";
import {
  OPENCODE_AUTOINVOKE_KEY,
  renderClaudeSkill,
  renderOpenCodeSkill,
  splitSkillDocument,
  transformSkillDocument,
} from "../src/skill-document.js";

const RENDERERS = [transformSkillDocument, renderClaudeSkill, renderOpenCodeSkill];

/** One frontmatter document with a body. */
const fm = (frontmatter) => `---\n${frontmatter}---\nBody\n`;

/** Effective (merge- and alias-resolved) mapping of a rendered document. */
function effective(rendered) {
  return parseDocument(splitSkillDocument(rendered).yaml, { merge: true }).toJS({ maxAliasCount: 100 });
}

/** Render through a harness wrapper with the canonical identity overrides. */
function renderWith(render, text) {
  return render({ text, name: "release", description: "Effective description" });
}

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

test("the shared transformation fails closed on malformed, duplicate, and non-mapping YAML", () => {
  const cases = [
    ["malformed flow sequence", "---\nbroken: [1,\n---\nbody\n", /Invalid skill frontmatter/],
    ["duplicate keys", "---\nname: one\nname: two\n---\nbody\n", /Invalid skill frontmatter/],
    ["non-mapping document", "---\njust a scalar\n---\nbody\n", /must be a YAML mapping/],
    ["unterminated frontmatter", "---\nname: one\n", /closing --- delimiter/],
  ];
  for (const [label, text, pattern] of cases) {
    for (const render of RENDERERS) {
      assert.throws(
        () => render({ text, name: "release", description: "Effective description" }),
        pattern,
        `${label} is rejected by ${render.name}`,
      );
    }
  }
});

test("harness metadata patches never replace non-mapping source metadata", () => {
  const invalidSources = [
    "metadata: legacy-string\n",
    "metadata: [a, b]\n",
    "metadata:\n",
    // The same failures apply to values that are only effective through a
    // merge: validation is based on the resolved mapping, not the AST.
    "defaults: &d\n  metadata: legacy\n<<: *d\n",
    "defaults: &d\n  metadata:\n<<: *d\n",
  ];
  for (const metadataLine of invalidSources) {
    const text = `---\nname: release\ndescription: Original\n${metadataLine}---\nbody\n`;
    assert.throws(
      () => renderOpenCodeSkill({ text, name: "release", description: "Effective description" }),
      /frontmatter metadata must be a YAML mapping/,
      `${metadataLine.trim().split("\n").at(-1) || "metadata:"} fails closed instead of being discarded`,
    );
  }
  // The Claude wrapper patches no metadata, so a non-mapping source value is
  // preserved untouched rather than rejected.
  const claude = renderClaudeSkill({
    text: "---\nname: release\ndescription: Original\nmetadata: legacy-string\n---\nbody\n",
    name: "release",
    description: "Effective description",
  });
  assert.match(claude, /metadata: legacy-string/, "Claude leaves source metadata alone");
  assert.equal(parse(splitSkillDocument(claude).yaml).metadata, "legacy-string");
});

test("the shared transformation overrides only identity and keeps body, comments, and key order", () => {
  const text = [
    "---",
    "# retained comment",
    "name: Release Display Name",
    'description: "Original description"',
    "license: MIT",
    "---",
    "",
    "Body stays byte-identical.",
    "",
  ].join("\n");
  const rendered = transformSkillDocument({
    text,
    name: "release",
    description: "Effective description",
  });
  const yaml = splitSkillDocument(rendered).yaml;
  const data = parse(yaml);
  assert.equal(data.name, "release", "canonical name wins");
  assert.equal(data.description, "Effective description", "effective registry description wins");
  assert.equal(data.license, "MIT", "unrelated source fields survive");
  assert.match(yaml, /# retained comment/, "source comments survive");
  const topLevelKeys = yaml
    .split("\n")
    .map((line) => line.match(/^([A-Za-z][A-Za-z0-9-]*):/)?.[1])
    .filter(Boolean);
  assert.deepEqual(topLevelKeys, ["name", "description", "license"], "key order is preserved");
  assert.equal(splitSkillDocument(rendered).body, splitSkillDocument(text).body, "the body is copied verbatim");
  // A document without frontmatter synthesizes identity and keeps the original
  // content as the body.
  const plain = transformSkillDocument({
    text: "# Instructions only\n",
    name: "release",
    description: "Effective description",
  });
  assert.deepEqual(parse(splitSkillDocument(plain).yaml), {
    name: "release",
    description: "Effective description",
  });
  assert.equal(splitSkillDocument(plain).body, "# Instructions only\n");
});

test("an unquoted top-level identity scalar with colon-space renders instead of aborting", () => {
  const text = [
    "---",
    "# retained comment",
    "name: Release",
    "description: Use when: testing",
    "license: MIT",
    "---",
    "",
    "Body stays byte-identical.",
    "",
  ].join("\n");

  // The exact reported input fails strict YAML parsing — the 0.1.1 behavior
  // that blocked `init --harness claude` even though discovery's compact
  // parser accepts the same line as a plain string.
  const strictOnly = parseDocument("name: Release\ndescription: Use when: testing\n", {
    prettyErrors: true,
    merge: true,
  });
  assert.equal(strictOnly.errors.length, 1, "strict parsing reports exactly the compact-mapping failure");
  assert.match(
    strictOnly.errors[0].message.split("\n")[0],
    /Nested mappings are not allowed in compact mappings at line 2, column 14/,
    "the reported source frontmatter is rejected by strict parsing alone",
  );

  for (const render of RENDERERS) {
    const rendered = render({ text, name: "release", description: "Effective description" });
    const yaml = splitSkillDocument(rendered).yaml;
    const data = parse(yaml, { merge: true });
    assert.equal(data.name, "release", `${render.name}: canonical name wins`);
    assert.equal(data.description, "Effective description", `${render.name}: canonical description wins`);
    assert.equal(data.license, "MIT", `${render.name}: unrelated source fields survive`);
    assert.match(yaml, /# retained comment/, `${render.name}: source comments survive`);
    const topLevelKeys = yaml
      .split("\n")
      .map((line) => line.match(/^([A-Za-z][A-Za-z0-9-]*):/)?.[1])
      .filter(Boolean);
    // OpenCode additionally appends its own marker key at the end.
    const expectedKeys =
      render === renderOpenCodeSkill ? ["name", "description", "license", "metadata"] : ["name", "description", "license"];
    assert.deepEqual(topLevelKeys, expectedKeys, `${render.name}: key order is preserved`);
    assert.equal(
      splitSkillDocument(rendered).body,
      splitSkillDocument(text).body,
      `${render.name}: the body is copied verbatim`,
    );
  }

  // The harness-specific outputs stay distinct: Claude injects no OpenCode
  // marker, OpenCode still patches one into the same compatible document.
  const claude = renderClaudeSkill({ text, name: "release", description: "Effective description" });
  assert.equal(claude.includes(OPENCODE_AUTOINVOKE_KEY), false, "the Claude copy carries no OpenCode marker");
  const opencode = renderOpenCodeSkill({ text, name: "release", description: "Effective description" });
  assert.equal(effective(opencode).metadata[OPENCODE_AUTOINVOKE_KEY], false, "the OpenCode marker still lands");
});

/** The exact diagnostic strict YAML reports for a document's own frontmatter. */
function strictDiagnostic(text) {
  const doc = parseDocument(splitSkillDocument(text).yaml, { prettyErrors: true, merge: true });
  assert.ok(doc.errors.length > 0, "an oracle frontmatter must fail strict parsing");
  return `Invalid skill frontmatter: ${doc.errors[0].message.split("\n")[0]}`;
}

test("every qualifying plain identity shape renders canonical YAML", () => {
  const options = { name: "release", description: "Effective description" };
  const cases = [
    ["name carrying colon-space only", "name: Use when: testing\nlicense: MIT\n", null],
    ["description carrying colon-space only", "description: Use when: testing\nlicense: MIT\n", null],
    ["both identity keys carrying colon-space", "name: Use when: testing\ndescription: Use when: testing\nlicense: MIT\n", null],
    ["a trailing comment on the qualifying line", "name: Use when: testing # why now\nlicense: MIT\n", "# why now"],
    [
      "a comment-only identity beside a legitimate candidate",
      "description: # note: x\nname: Use when: testing\nlicense: MIT\n",
      "# note: x",
    ],
    // `-` is a plain-scalar opening only when it is not followed by a space,
    // which is exactly the boundary the compatibility gate must hold.
    ["an indicator opening followed by a non-space", "name: Release\ndescription: -foo: bar\n", null],
  ];
  for (const [label, frontmatter, comment] of cases) {
    const text = `---\n${frontmatter}---\nBody\n`;
    for (const render of RENDERERS) {
      const rendered = render({ text, ...options });
      const yaml = splitSkillDocument(rendered).yaml;
      const data = parse(yaml, { merge: true });
      assert.equal(data.name, "release", `${label}: ${render.name} canonical name`);
      assert.equal(
        data.description,
        "Effective description",
        `${label}: ${render.name} canonical description`,
      );
      assert.equal(data.license, frontmatter.includes("license:") ? "MIT" : undefined, `${label}: ${render.name} keeps unrelated fields`);
      assert.equal(
        splitSkillDocument(rendered).body,
        splitSkillDocument(text).body,
        `${label}: ${render.name} copies the body verbatim`,
      );
      if (comment) assert.ok(yaml.includes(comment), `${label}: ${render.name} preserves ${comment}`);
    }
  }

  // CRLF sources normalize exactly like their LF twins before any parsing.
  const crlf = "---\r\nname: Use when: testing\r\ndescription: Use when: testing\r\n---\r\nBody\r\n";
  for (const render of RENDERERS) {
    const data = parse(splitSkillDocument(render({ text: crlf, ...options })).yaml, { merge: true });
    assert.equal(data.name, "release", `CRLF: ${render.name} canonical name`);
    assert.equal(data.description, "Effective description", `CRLF: ${render.name} canonical description`);
  }

  // Repeated identities: regenerating from an already canonical document (what
  // every scan does) parses strictly on its own and stays canonical.
  const generated = renderClaudeSkill({ text: fm("name: Use when: testing\ndescription: Use when: testing\n"), ...options });
  for (const render of RENDERERS) {
    const again = render({ text: generated, ...options });
    const data = parse(splitSkillDocument(again).yaml, { merge: true });
    assert.equal(data.name, "release", `re-render: ${render.name} canonical name`);
    assert.equal(data.description, "Effective description", `re-render: ${render.name} canonical description`);
    assert.equal(
      splitSkillDocument(again).body,
      splitSkillDocument(generated).body,
      `re-render: ${render.name} keeps the body`,
    );
  }
});

test("every non-plain or non-identity failure keeps the original strict diagnostic", () => {
  const options = { name: "release", description: "Effective description" };
  const rejected = [
    // The six malformed indicator forms that must never be rewritten.
    ["block sequence entry value", "name: Release\ndescription: - foo: bar\n"],
    ["explicit key value", "name: Release\ndescription: ? foo: bar\n"],
    ["mapping-value indicator", "name: Release\ndescription: : foo: bar\n"],
    ["flow separator", "name: Release\ndescription: , foo: bar\n"],
    ["flow sequence end", "name: Release\ndescription: ] foo: bar\n"],
    ["flow mapping end", "name: Release\ndescription: } foo: bar\n"],
    // Root flow contexts: the identity line is never a rewrite candidate there.
    ["a multi-line root flow mapping", "{\nname: Use when: testing\n}\n"],
    ["a multi-line root flow sequence", "[\nname: Use when: testing\n]\n"],
    ["a one-line root flow mapping", "{ name: a: b }\n"],
    ["a root flow mapping closed after the identity line", "{ name: a: b,\ndescription: c: d }\n"],
    // Tabs, which discovery refuses outright.
    ["a tab inside the identity value", "name: Release\ndescription: Use\twhen: testing\n"],
    ["a tab between key and value", "name:\tRelease\ndescription: Use when: testing\n"],
    ["a tab as indentation", "name: Release\n\tdescription: Use when: testing\n"],
    // Tags, anchors, aliases, directives, quotes, block scalars, flow openings.
    ["a tag opening", "name: Release\ndescription: !tag Use: x\n"],
    ["an anchor opening", "name: Release\ndescription: &anc Use: x\n"],
    ["an alias opening", "name: Release\ndescription: *anc Use: x\n"],
    ["a directive line", "name: Release\n%YAML 1.2\ndescription: Use when: testing\n"],
    ["a directive opening", "name: Release\ndescription: %YAML: x\n"],
    ["an unterminated double quote", 'name: Release\ndescription: "Use when: testing\n'],
    ["an unterminated single quote", "name: Release\ndescription: 'Use when: testing\n"],
    ["a block literal header", "name: Release\ndescription: | Use: x\n"],
    ["a block folded header", "name: Release\ndescription: > Use: x\n"],
    ["a flow mapping opening", "name: Release\ndescription: {a: b: c}\n"],
    // Duplicates, unknown/nested colon-space, and other malformed YAML.
    ["a duplicate identity key", "name: Release\ndescription: Use when: testing\nname: Other: Thing\n"],
    ["an unknown key with colon-space", "name: Release\ndescription: Use when: testing\nrequires: Use when: testing\n"],
    ["a nested field with colon-space", "name: Release\ndescription: Use when: testing\nmetadata:\n  note: Use when: testing\n"],
    ["an indented identity-shaped key", "name: Release\ndescription: Use when: testing\nmetadata:\n  description: Use when: testing\n"],
    ["malformed flow syntax beside a valid identity", "name: Release\ndescription: Use when: testing\nbroken: [1,\n"],
    ["an anchor-wrapped identity value", "name: Release\ndescription: &a Use when: testing\n"],
  ];
  for (const [label, frontmatter] of rejected) {
    const text = `---\n${frontmatter}---\nBody\n`;
    const expected = strictDiagnostic(text);
    for (const render of RENDERERS) {
      assert.throws(
        () => render({ text, ...options }),
        (error) => {
          assert.equal(
            error.message,
            expected,
            `${label}: ${render.name} rejects with the untouched original strict diagnostic`,
          );
          return true;
        },
        `${label} is rejected by ${render.name}`,
      );
    }
  }
});

test("compatible documents keep their security semantics", () => {
  const options = { name: "release", description: "Effective description" };
  // Cycles are judged on the effective mapping of the compatible document,
  // never on the raw source text.
  const cyclic = "---\na: &x\n  b: *x\nname: Release\ndescription: Use when: testing\n---\nBody\n";
  for (const render of RENDERERS) {
    assert.throws(
      () => render({ text: cyclic, ...options }),
      /Invalid skill frontmatter: the document contains a cyclic alias/,
      `${render.name} still rejects the cyclic alias`,
    );
  }
  const disabled = "---\nname: Release\ndescription: Use when: testing\ndisable-model-invocation: true\n---\nBody\n";
  assert.throws(
    () => renderClaudeSkill({ text: disabled, ...options }),
    /which is incompatible/,
    "disable-model-invocation is still enforced for a compatible document",
  );
  const allowed = renderOpenCodeSkill({ text: disabled, ...options });
  assert.equal(effective(allowed)["disable-model-invocation"], true, "the flag itself is preserved untouched");
});

test("merge keys resolve into the effective mapping before validation and patching", () => {
  const claudeOptions = { name: "release", description: "Effective description" };

  // An effective `disable-model-invocation: true` inherited through `<<` is
  // rejected, even though the source never states it explicitly.
  const inherited = fm("defaults: &d\n  disable-model-invocation: true\nname: release\n<<: *d\n");
  assert.throws(
    () => renderClaudeSkill({ text: inherited, ...claudeOptions }),
    /disable-model-invocation: true, which is incompatible/,
    "an inherited truthy value is rejected",
  );
  const inheritedYes = fm("base: &b\n  disable-model-invocation: yes\nname: release\n<<: *b\n");
  assert.throws(
    () => renderClaudeSkill({ text: inheritedYes, ...claudeOptions }),
    /resolved from "yes"/,
    "the whole truthy-value rule applies to inherited values too",
  );

  // An explicit false wins over a merged true under YAML semantics, so the
  // document is allowed; the merge construct outside metadata is preserved and
  // no OpenCode marker is injected.
  const overridden = fm(
    "defaults: &d\n  disable-model-invocation: true\nname: release\n<<: *d\ndisable-model-invocation: false\n",
  );
  const allowed = renderClaudeSkill({ text: overridden, ...claudeOptions });
  assert.equal(effective(allowed)["disable-model-invocation"], false, "explicit false wins over merged true");
  assert.ok(allowed.includes("<<: *d"), "the merge construct is preserved");
  assert.equal(allowed.includes("opencode/autoinvoke"), false, "Claude injects no OpenCode marker");

  // Multiple merges: YAML gives precedence to the earliest merged entry.
  const trueFirst = fm(
    "a: &a\n  disable-model-invocation: true\nb: &b\n  disable-model-invocation: false\nname: release\n<<: [*a, *b]\n",
  );
  assert.throws(
    () => renderClaudeSkill({ text: trueFirst, ...claudeOptions }),
    /which is incompatible/,
    "the earliest merged entry (true) decides the effective value",
  );
  const falseFirst = fm(
    "a: &a\n  disable-model-invocation: true\nb: &b\n  disable-model-invocation: false\nname: release\n<<: [*b, *a]\n",
  );
  const multiAllowed = renderClaudeSkill({ text: falseFirst, ...claudeOptions });
  assert.equal(effective(multiAllowed)["disable-model-invocation"], false, "earliest merged entry (false) decides");

  // An explicit key still beats every merge entry.
  const explicitBeatsMerge = fm(
    "a: &a\n  disable-model-invocation: false\nname: release\n<<: *a\ndisable-model-invocation: true\n",
  );
  assert.throws(
    () => renderClaudeSkill({ text: explicitBeatsMerge, ...claudeOptions }),
    /which is incompatible/,
    "an explicit truthy key wins over a merged false",
  );
});

test("top-level merged metadata survives the OpenCode patch", () => {
  const merged = fm(
    "base: &b\n  tier: 2\n  owner: platform\ndefaults: &d\n  metadata: *b\nname: release\n<<: *d\n",
  );
  const rendered = renderWith(renderOpenCodeSkill, merged);
  assert.deepEqual(
    effective(rendered).metadata,
    { tier: 2, owner: "platform", "opencode/autoinvoke": false },
    "every inherited metadata key survives and only the marker is set",
  );
  // The inherited mapping was not representable as an explicit node, so it is
  // materialized; the surrounding merge/anchor constructs stay in the source.
  assert.ok(rendered.includes("metadata: *b"), "the nested anchor definition survives");
  assert.ok(rendered.includes("<<: *d"), "the top-level merge construct survives");
  assert.match(rendered, /^metadata:$/m, "an explicit top-level metadata mapping is materialized");
  assert.equal(splitSkillDocument(rendered).body, splitSkillDocument(merged).body, "the body is unchanged");
});

test("aliased metadata is materialized without losing keys or other anchors", () => {
  const aliased = fm("anchor: &m\n  tier: 3\n  owner: platform\n  opencode/autoinvoke: true\nmetadata: *m\nname: release\n");
  const rendered = renderWith(renderOpenCodeSkill, aliased);
  const data = effective(rendered);
  assert.deepEqual(
    data.metadata,
    { tier: 3, owner: "platform", "opencode/autoinvoke": false },
    "the alias target is materialized and the marker is overridden",
  );
  assert.equal(data.anchor.tier, 3, "the anchor definition outside metadata is untouched");
  assert.ok(rendered.includes("anchor: &m"), "the anchor definition survives");
  assert.equal(rendered.includes("metadata: *m"), false, "the alias is replaced by an explicit mapping");

  // An explicit metadata mapping that itself merges keeps its inherited keys:
  // the patch is applied in place instead of materializing.
  const innerMerge = fm("base: &b\n  owner: platform\nmetadata:\n  <<: *b\n  tier: 1\nname: release\n");
  const patched = renderWith(renderOpenCodeSkill, innerMerge);
  assert.deepEqual(effective(patched).metadata, {
    owner: "platform",
    tier: 1,
    "opencode/autoinvoke": false,
  });
  assert.ok(patched.includes("<<: *b"), "the inner merge construct survives in place");
});

test("explicit metadata takes precedence over merged metadata", () => {
  const precedence = fm(
    "base: &b\n  metadata:\n    tier: 1\n    keep: from-base\nname: release\n<<: *b\nmetadata:\n  tier: 2\n",
  );
  const rendered = renderWith(renderOpenCodeSkill, precedence);
  assert.deepEqual(
    effective(rendered).metadata,
    { tier: 2, "opencode/autoinvoke": false },
    "the explicit metadata mapping replaces the merged one, then receives the patch",
  );
  assert.match(rendered, /tier: 2/, "the explicit value is what gets rendered");
});

test("hostile alias structures fail closed without hanging", () => {
  const started = Date.now();
  const claudeOptions = { name: "release", description: "Effective description" };

  // Self-referential metadata: resolved structures are checked for cycles
  // before anything is materialized.
  assert.throws(
    () => renderOpenCodeSkill({ text: fm("name: release\nmetadata: &m\n  self: *m\n"), ...claudeOptions }),
    /Invalid skill frontmatter: the document contains a cyclic alias/,
  );
  assert.throws(
    () => renderClaudeSkill({ text: fm("a: &x\n  b: *x\nname: release\n"), ...claudeOptions }),
    /Invalid skill frontmatter: the document contains a cyclic alias/,
    "the Claude gate rejects cycles too",
  );

  // Alias expansion bombs are bounded by maxAliasCount.
  const lines = ["a: &a", "  - x", "  - x"];
  for (let index = 1; index < 200; index += 1) {
    lines.push(`n${index}: &n${index}`);
    for (let copy = 0; copy < 6; copy += 1) lines.push(`  - ${index === 1 ? "*a" : `*n${index - 1}`}`);
  }
  assert.throws(
    () => transformSkillDocument({ text: fm(`${lines.join("\n")}\n`), ...claudeOptions }),
    /Invalid skill frontmatter: alias resolution failed: Excessive alias count/,
  );

  // Malformed and duplicate YAML keep failing closed with scoped messages.
  assert.throws(
    () => transformSkillDocument({ text: "---\nbroken: [1,\n---\nBody\n", ...claudeOptions }),
    /Invalid skill frontmatter: Flow sequence/,
  );
  assert.throws(
    () => transformSkillDocument({ text: "---\nname: one\nname: two\n---\nBody\n", ...claudeOptions }),
    /Invalid skill frontmatter: .*unique/,
  );
  assert.ok(Date.now() - started < 5000, "hostile documents fail closed quickly instead of hanging");
});
