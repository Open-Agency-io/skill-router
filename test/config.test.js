import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, normalizeConfig } from "../src/config.js";

test("normalizes defaults without sharing mutable values", () => {
  const first = normalizeConfig();
  const second = normalizeConfig();
  first.sources.push("one");
  assert.deepEqual(second.sources, []);
  assert.equal(first.routing.minimumScore, 0.55);
});

test("merges routing configuration", () => {
  const config = normalizeConfig({ routing: { minimumScore: 0.7 } });
  assert.equal(config.routing.minimumScore, 0.7);
  assert.equal(config.routing.maxCandidates, 5);
});

test("rejects unsafe configuration shapes", () => {
  assert.throws(() => normalizeConfig({ sources: "skills" }), /sources/);
  assert.throws(() => normalizeConfig({ routing: { minimumMargin: 2 } }), /minimumMargin/);
  assert.throws(() => normalizeConfig({ aliases: { release: false } }), /aliases/);
  assert.throws(() => normalizeConfig({ stateDirectory: "." }), /router-owned/);
  assert.throws(() => normalizeConfig({ schemaVersion: 3 }), /schemaVersion must be 1 or 2/);
});

test("keeps schemaVersion 1 unchanged and requires opt-in for schemaVersion 2 features", () => {
  const legacy = normalizeConfig({ schemaVersion: 1, aliases: { release: "git-release" } });
  assert.equal(legacy.schemaVersion, 1);
  assert.equal(legacy.routing.mode, undefined);
  assert.equal(Object.hasOwn(legacy, "workflows"), false);

  assert.throws(
    () => normalizeConfig({ schemaVersion: 1, workflows: { flow: { steps: [{ skill: "git-release" }] } } }),
    /workflows require schemaVersion 2/,
  );
  assert.throws(
    () => normalizeConfig({ schemaVersion: 1, routing: { mode: "advisory" } }),
    /routing\.mode requires schemaVersion 2/,
  );
  assert.throws(
    () => normalizeConfig({ schemaVersion: 1, skills: { "git-release": { invocation: "advisory" } } }),
    /skills\.git-release\.invocation requires schemaVersion 2/,
  );
  assert.throws(
    () => normalizeConfig({ schemaVersion: 1, skills: { "git-release": { applicability: { all: ["release"] } } } }),
    /applicability requires schemaVersion 2/,
  );

  const modern = normalizeConfig({ schemaVersion: 2 });
  assert.equal(modern.routing.mode, "automatic");
  assert.deepEqual(Object.keys(modern.workflows), []);
});

test("validates schemaVersion 2 enums, identifiers, and unknown keys", () => {
  assert.throws(
    () => normalizeConfig({ schemaVersion: 2, routing: { mode: "silent" } }),
    /routing\.mode must be one of automatic, advisory/,
  );
  assert.throws(
    () => normalizeConfig({ schemaVersion: 2, skills: { release: { invocation: "always" } } }),
    /invocation must be one of automatic, advisory, explicit-only/,
  );
  assert.throws(
    () => normalizeConfig({
      schemaVersion: 2,
      routing: { allowSequences: true },
      workflows: { "Release Flow": { steps: [{ skill: "release" }] } },
    }),
    /workflows key must be a portable ID/,
  );
  assert.throws(
    () => normalizeConfig({
      schemaVersion: 2,
      routing: { allowSequences: true },
      workflows: { "skill-router": { steps: [{ skill: "release" }] } },
    }),
    /reserved skill-router/,
  );
  assert.throws(() => normalizeConfig({ schemaVersion: 2, workflow: {} }), /Unknown configuration key: "workflow"/);
  assert.throws(
    () => normalizeConfig({ schemaVersion: 2, skills: { release: { invocations: "automatic" } } }),
    /Unknown skills\.release key/,
  );
  assert.throws(
    () => normalizeConfig({ schemaVersion: 2, skills: { "Bad ID": {} } }),
    /skills key must be a portable ID/,
  );
  assert.throws(
    () => normalizeConfig({ schemaVersion: 2, skills: { release: { source: "https://example.com/skill" } } }),
    /remote sources are not supported/,
  );
});

test("validates skills keys and alias targets in both schema versions", () => {
  for (const schemaVersion of [1, 2]) {
    // The key is never echoed: it is untrusted until it passes the grammar.
    assert.throws(
      () => normalizeConfig({ schemaVersion, skills: { "Bad ID": {} } }),
      /^Error: skills key must be a portable ID/,
    );
    assert.throws(
      () => normalizeConfig({ schemaVersion, skills: { "skill-router": {} } }),
      /^Error: skills key uses the reserved skill-router ID/,
    );
    assert.throws(
      () => normalizeConfig({ schemaVersion, skills: { "": {} } }),
      /^Error: skills key must be a portable ID/,
    );
    assert.throws(
      () => normalizeConfig({ schemaVersion, aliases: { "ship it": "Bad Target" } }),
      /^Error: alias target must be a portable ID/,
    );
    assert.throws(
      () => normalizeConfig({ schemaVersion, aliases: { "ship it": "skill-router" } }),
      /^Error: alias target uses the reserved skill-router ID/,
    );
    assert.throws(
      () => normalizeConfig({ schemaVersion, aliases: { "ship it": "x".repeat(65) } }),
      /^Error: alias target must be a portable ID/,
    );
  }
});

test("keeps alias phrases, include/exclude globs, and applicability/source paths unconstrained", () => {
  const config = normalizeConfig({
    schemaVersion: 1,
    include: ["**/*.md", "[bad", "??*", "*.MD"],
    exclude: ["a/**", "b?(c)", "!*.txt"],
    aliases: { "!!!": "release", "Ship  It?": "git-release", "🙂 ship": "one", "—": "two" },
  });
  assert.deepEqual(config.include, ["**/*.md", "[bad", "??*", "*.MD"]);
  assert.deepEqual(config.exclude, ["a/**", "b?(c)", "!*.txt"]);
  assert.deepEqual(Object.keys(config.aliases), ["!!!", "Ship  It?", "🙂 ship", "—"]);
});

test("accepts prototype-sensitive and broad Claude-family IDs without prototype hazards", () => {
  const ids = [
    "constructor",
    "prototype",
    "to-string",
    "synced",
    "anthropic-skills",
    "anthropic",
    "claude",
    "claude-helper",
    "verify",
    "simplify",
    "doctor",
  ];
  const skills = Object.fromEntries(ids.map((id) => [id, id === "constructor" ? { handoffTo: ["doctor"] } : {}]));
  const config = normalizeConfig({
    schemaVersion: 2,
    routing: { allowSequences: true },
    skills,
    workflows: {
      "release-flow": { steps: [{ skill: "constructor" }, { skill: "verify" }] },
    },
  });
  assert.deepEqual(Object.keys(config.skills), ids);
  assert.equal(Object.getPrototypeOf(config.skills), null, "skills stays null-prototype");
  assert.equal(config.skills.hasOwnProperty, undefined, "prototype names cannot resolve inherited members");
  assert.deepEqual(config.skills.constructor, { handoffTo: ["doctor"] });
  assert.deepEqual(Object.keys(config.workflows), ["release-flow"]);

  // Schema v1 accepts the same IDs under the same null-prototype safety.
  const legacy = normalizeConfig({ schemaVersion: 1, skills: { constructor: {}, prototype: {} } });
  assert.equal(Object.getPrototypeOf(legacy.skills), null);
  assert.deepEqual(legacy.skills.prototype, {});
});

test("validates v2 workflow IDs, step skills, and handoff targets", () => {
  const v2 = (extra) => normalizeConfig({ schemaVersion: 2, routing: { allowSequences: true }, ...extra });

  assert.throws(
    () => v2({ workflows: { "Bad Flow": { steps: [{ skill: "release" }] } } }),
    /^Error: workflows key must be a portable ID/,
  );
  assert.throws(
    () => v2({ workflows: { "skill-router": { steps: [{ skill: "release" }] } } }),
    /^Error: workflows key uses the reserved skill-router ID/,
  );
  assert.throws(
    () => v2({ workflows: { flow: { steps: [{ skill: "Bad Skill" }] } } }),
    /^Error: workflows\.flow\.steps\[0\]\.skill must be a portable ID/,
  );
  assert.throws(
    () => v2({ workflows: { flow: { steps: [{ skill: "skill-router" }] } } }),
    /^Error: workflows\.flow\.steps\[0\]\.skill uses the reserved skill-router ID/,
  );
  assert.throws(
    () => v2({ workflows: { flow: { steps: [{ skill: "x".repeat(65) }] } } }),
    /^Error: workflows\.flow\.steps\[0\]\.skill must be a portable ID/,
  );
  assert.throws(
    () => v2({ skills: { release: { handoffTo: ["Bad Target"] } } }),
    /^Error: skills\.release\.handoffTo\[0\] must be a portable ID/,
  );
  assert.throws(
    () => v2({ skills: { release: { handoffTo: ["skill-router"] } } }),
    /^Error: skills\.release\.handoffTo\[0\] uses the reserved skill-router ID/,
  );
  // Existing checks still hold after the grammar gate.
  assert.throws(
    () => v2({ skills: { release: { handoffTo: ["release", "release"] } } }),
    /more than once/,
  );
  assert.doesNotThrow(() =>
    v2({ skills: { release: { handoffTo: ["review"] } }, workflows: { flow: { steps: [{ skill: "review" }] } } }),
  );
});

test("bounds errors for huge or control-character identifiers and keys", () => {
  const huge = "x".repeat(100_000);
  for (const schemaVersion of [1, 2]) {
    assert.throws(
      () => normalizeConfig({ schemaVersion, skills: { [huge]: {} } }),
      (error) => {
        assert.ok(error.message.length < 200, "skills key error stays bounded");
        assert.equal(error.message.includes("xxx"), false, "huge ID is absent from the message");
        return true;
      },
    );
    assert.throws(
      () => normalizeConfig({ schemaVersion, aliases: { "ship it": huge } }),
      (error) => {
        assert.ok(error.message.length < 200, "alias target error stays bounded");
        assert.equal(error.message.includes("xxx"), false, "huge ID is absent from the message");
        return true;
      },
    );
  }

  const control = "a\u0000\u0001b\u001b[31m";
  assert.throws(
    () => normalizeConfig({ skills: { [control]: {} } }),
    (error) => {
      assert.equal(/[\u0000-\u001f]/.test(error.message), false, "skills key error is control-free");
      assert.equal(error.message.includes("[31m"), false);
      return true;
    },
  );

  // Untrusted top-level keys are bounded echoes: at most MAX_ECHO_LENGTH
  // characters of the key survive, never the whole value.
  assert.throws(
    () => normalizeConfig({ schemaVersion: 2, [huge]: {} }),
    (error) => {
      assert.ok(error.message.length < 200);
      assert.equal(error.message.includes("x".repeat(65)), false, "echo is truncated");
      assert.equal(/[\u0000-\u001f]/.test(error.message), false);
      return true;
    },
  );
  // v2 alias collision messages stay bounded even with hostile phrases.
  assert.throws(
    () => normalizeConfig({ schemaVersion: 2, aliases: { [huge]: "one", [`${huge} `]: "two" } }),
    (error) => {
      assert.ok(error.message.length < 300, "collision message stays bounded");
      assert.equal(error.message.includes("x".repeat(65)), false, "echo is truncated");
      assert.equal(/[\u0000-\u001f]/.test(error.message), false);
      return true;
    },
  );
});

test("validates applicability phrases deterministically", () => {
  const app = (applicability) => normalizeConfig({ schemaVersion: 2, skills: { release: { applicability } } });
  assert.throws(() => app({ all: [""] }), /non-empty phrase/);
  assert.throws(() => app({ any: ["the"] }), /matchable token/);
  assert.throws(() => app({ all: ["review code", "code-review"] }), /repeats the normalized phrase/);
  assert.throws(() => app({ all: ["release notes"], none: ["notes for release"] }), /positive and a negative/);
  assert.throws(() => app({ none: ["release", "deploy"] , matches: [] }), /not supported/);
  assert.doesNotThrow(() => app({ all: ["release notes"], any: ["ship"], none: ["docs"] }));
});

test("rejects schema v2 aliases that collide under routing normalization", () => {
  const alias = (aliases, extra = {}) =>
    normalizeConfig({ schemaVersion: 2, routing: { allowSequences: true }, ...extra, aliases });

  // An alias normalizes exactly like a request, so it would hide the skill.
  assert.throws(
    () => alias({ "git release": "ship" }, { skills: { "git-release": {} } }),
    /Alias "git release" collides with skill git-release after normalization/,
  );
  assert.throws(
    () => alias({ "git-release": "ship" }, { skills: { "git-release": {} } }),
    /collides with skill git-release after normalization/,
  );
  assert.throws(
    () =>
      alias({ "change gate": "ship" }, {
        workflows: { "change-gate": { steps: [{ skill: "ship" }] } },
      }),
    /collides with workflow change-gate after normalization/,
  );

  // Alias-to-alias collisions are rejected in either insertion order.
  const colliding = ["ship it", "ship-it"];
  const targets = { "ship it": "one", "ship-it": "two" };
  const [first, second] = colliding;
  assert.throws(
    () => alias({ [first]: targets[first], [second]: targets[second] }),
    /collides with alias/,
  );
  assert.throws(
    () => alias({ [second]: targets[second], [first]: targets[first] }),
    new RegExp(`Alias "${second}" collides with alias "${first}" after normalization`),
  );

  // Schema v1 keeps its historical alias-first semantics.
  assert.doesNotThrow(() =>
    normalizeConfig({
      schemaVersion: 1,
      skills: { "git-release": {} },
      aliases: { "git release": "other" },
    }),
  );
  assert.doesNotThrow(() =>
    normalizeConfig({ schemaVersion: 1, aliases: { "ship it": "one", "ship-it": "two" } }),
  );
});

test("rejects schema v2 aliases that normalize to an empty phrase", () => {
  for (const alias of ["!", "—", "   "]) {
    assert.throws(
      () => normalizeConfig({ schemaVersion: 2, aliases: { [alias]: "git-release" } }),
      new RegExp(`Alias ${JSON.stringify(alias)} normalizes to an empty phrase`),
    );
  }
  // Schema v1 keeps its historical behavior: these aliases are still accepted.
  assert.doesNotThrow(() => normalizeConfig({ schemaVersion: 1, aliases: { "!": "git-release" } }));
});

test("validates workflow graphs and shared namespaces", () => {
  const workflow = (workflows, routing = { allowSequences: true }) =>
    normalizeConfig({ schemaVersion: 2, routing, workflows });
  assert.throws(
    () => normalizeConfig({ schemaVersion: 2, routing: { allowSequences: false }, workflows: { flow: { steps: [{ skill: "release" }] } } }),
    /allowSequences must be true/,
  );
  assert.throws(() => workflow({ flow: {} }), /steps must be a non-empty array/);
  assert.throws(() => workflow({ flow: { steps: [] } }), /steps must be a non-empty array/);
  assert.throws(
    () => workflow({ flow: { steps: [{ skill: "release", when: "only when shipping" }] } }),
    /at least one step without a when condition/,
  );
  assert.throws(
    () => workflow({ flow: { steps: [{ skill: "flow" }, { skill: "release" }] } }),
    /nested workflows are not supported/,
  );
  assert.throws(
    () => workflow({ flow: { steps: [{ skill: "release", when: "the" }, { skill: "release" }] } }),
    /matchable token/,
  );
  assert.throws(() => workflow({ flow: { invocation: "sometimes", steps: [{ skill: "release" }] } }), /invocation must be one of/);
  assert.throws(
    () => workflow({ flow: { steps: [{ skill: "release" }, { unknown: true }] } }),
    /Unknown workflows\.flow\.steps\[1\] key/,
  );
  assert.throws(
    () =>
      normalizeConfig({
        schemaVersion: 2,
        routing: { allowSequences: true },
        skills: { release: {} },
        workflows: { release: { steps: [{ skill: "release" }] } },
      }),
    /Skill and workflow IDs share one namespace and must be unique/,
  );
  // Declared IDs are portable lowercase, so a case-only collision cannot be
  // written; the registry keeps the case-insensitive shared namespace instead.
  assert.throws(
    () => normalizeConfig({ schemaVersion: 2, skills: { Release: {} } }),
    /skills key must be a portable ID/,
  );
  assert.doesNotThrow(() =>
    workflow({ flow: { description: "Run the gate", steps: [{ skill: "release" }, { skill: "review" }] } }),
  );
});

test("configuration loading reports bounded JSON and read errors, never document bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-config-"));
  try {
    const secret = "sk-live-9d2b7c0e4a1f5e3d";
    const file = path.join(root, ".skill-router.json");
    // Malformed document: fixed file context plus a safely derived
    // line/column, and never the parser's snippet or the document bytes.
    await writeFile(file, `{\n  "sources": [],\n  "leak": "${secret}",\n}\n`);
    const error = await loadConfig(root).then(() => null, (failure) => failure);
    assert.ok(error instanceof Error);
    assert.match(error.message, /^Invalid JSON in .+ at line \d+, column \d+$/);
    assert.equal(error.message.includes(file), true, "the error keeps fixed file context");
    assert.equal(error.message.includes(secret), false, "document bytes never reach the message");
    assert.equal(error.message.includes("is not valid JSON"), false, "parser text is never copied");
    assert.equal(/[\u0000-\u001f]/.test(error.message), false, "the message is control-free");

    // An unreadable document path gets one fixed mapped error instead of a
    // raw filesystem message, and the code stays classifiable.
    const directory = path.join(root, "directory-config.json");
    await mkdir(directory);
    const readError = await loadConfig(root, "directory-config.json").then(() => null, (failure) => failure);
    assert.ok(readError instanceof Error);
    assert.match(readError.message, /^Cannot read JSON document in .+ \(EISDIR\)$/);
    assert.equal(readError.code, "EISDIR");

    // A missing configuration still yields the defaults; a valid one loads.
    await rm(file);
    assert.deepEqual((await loadConfig(root)).config.sources, []);
    await writeFile(file, `${JSON.stringify({ schemaVersion: 2, sources: ["declared"] })}\n`);
    assert.deepEqual((await loadConfig(root)).config.sources, ["declared"]);

    // Validation failures stay validation failures: they are not rewritten
    // into JSON syntax errors.
    await writeFile(file, `${JSON.stringify({ schemaVersion: 1, stateDirectory: "elsewhere" })}\n`);
    await assert.rejects(() => loadConfig(root), /stateDirectory must be the router-owned path/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
