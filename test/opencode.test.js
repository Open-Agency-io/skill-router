import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  configuredSkillSources,
  OPENCODE_PROBE_TIMEOUT_MS,
  OPENCODE_SHAPE_UNKNOWN_ACTION,
  planOpenCodeConfig,
  planOpenCodeRemoval,
  probeOpenCodeSkillShape,
  skillShapeFromOpenCodeVersion,
  verifyOpenCodeRemoval,
} from "../src/opencode.js";

/** exec seam that answers exactly once, asynchronously, like `execFile`. */
function callbackExec({ error = null, stdout = "", stderr = "" } = {}) {
  return (executable, args, options, callback) => {
    queueMicrotask(() => callback(error, stdout, stderr));
  };
}

/** exec seam that behaves like a real spawn failure. */
function failureExec(code, extra = {}) {
  return callbackExec({ error: Object.assign(new Error(code), { code, ...extra }) });
}

/** exec seam that reports one clean version, like the official CLI. */
function versionExec(version) {
  return callbackExec({ stdout: `${version}\n` });
}

test("preserves strict JSON fields and adds the managed source idempotently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-opencode-"));
  const file = path.join(root, "opencode.json");
  try {
    await writeFile(file, JSON.stringify({ model: "example/model", skills: ["./team"] }));
    const first = await planOpenCodeConfig(file, "/managed", "array");
    assert.equal(first.config.model, "example/model");
    assert.deepEqual(first.config.skills, ["./team", "/managed"]);
    await writeFile(file, first.content);
    const second = await planOpenCodeConfig(file, "/managed", "array");
    assert.deepEqual(second.config.skills, ["./team", "/managed"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supports OpenCode 1.x skills.paths configuration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-opencode-"));
  const file = path.join(root, "opencode.json");
  try {
    const plan = await planOpenCodeConfig(file, "/managed", "paths");
    assert.deepEqual(plan.config.skills, { paths: ["/managed"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves an existing skills.paths object and its extra fields", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-opencode-"));
  const file = path.join(root, "opencode.json");
  try {
    await writeFile(file, JSON.stringify({ skills: { paths: ["./team"], urls: ["https://example.test/skills"] } }));
    const first = await planOpenCodeConfig(file, "/managed", "array");
    assert.deepEqual(first.config.skills, {
      paths: ["./team", "/managed"],
      urls: ["https://example.test/skills"],
    });
    await writeFile(file, first.content);
    const second = await planOpenCodeConfig(file, "/managed", "array");
    assert.deepEqual(second.config.skills, first.config.skills);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts a paths-less skills object when the target shape is paths, idempotently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-opencode-"));
  const file = path.join(root, "opencode.json");
  try {
    await writeFile(
      file,
      JSON.stringify({ model: "example/model", skills: { urls: ["https://example.test/skills"] } }),
    );
    const first = await planOpenCodeConfig(file, "/managed", "paths");
    assert.equal(first.manual, false);
    assert.equal(first.config.model, "example/model");
    assert.deepEqual(first.config.skills, {
      urls: ["https://example.test/skills"],
      paths: ["/managed"],
    });
    await writeFile(file, first.content);
    const second = await planOpenCodeConfig(file, "/managed", "paths");
    assert.deepEqual(second.config.skills, first.config.skills);
    assert.equal(second.content, first.content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a paths-less skills object when the target shape is array", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-opencode-"));
  const file = path.join(root, "opencode.json");
  try {
    await writeFile(file, JSON.stringify({ skills: { urls: ["https://example.test/skills"] } }));
    await assert.rejects(() => planOpenCodeConfig(file, "/managed", "array"), /array or an object with paths/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns shape-specific manual actions rather than rewriting JSONC comments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-opencode-"));
  const file = path.join(root, "opencode.json");
  try {
    await writeFile(file, '{\n  // keep this\n  "skills": []\n}\n');
    const arrayPlan = await planOpenCodeConfig(file, "/managed", "paths");
    assert.equal(arrayPlan.manual, true);
    assert.equal(arrayPlan.content, null);
    assert.match(arrayPlan.instruction, /Add.*managed.*skills array/);
    await writeFile(file, '{\n  // keep this\n  "skills": ["/managed"],\n}\n');
    const configured = await planOpenCodeConfig(file, "/managed", "paths");
    assert.equal(configured.manual, true);
    assert.equal(configured.content, null);
    assert.equal(configured.instruction, undefined);

    await writeFile(file, '{\n  // keep this too\n  "skills": { "paths": [] },\n}\n');
    const pathsPlan = await planOpenCodeConfig(file, "/managed", "array");
    assert.match(pathsPlan.instruction, /skills\.paths array/);

    await writeFile(file, '{\n  // keep this three\n  "skills": { "urls": ["https://example.test/skills"] },\n}\n');
    const pathsLessPlan = await planOpenCodeConfig(file, "/managed", "paths");
    assert.equal(pathsLessPlan.manual, true);
    assert.equal(pathsLessPlan.content, null);
    assert.match(pathsLessPlan.instruction, /skills\.paths array/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects malformed OpenCode skill configuration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-opencode-"));
  const file = path.join(root, "opencode.json");
  try {
    await writeFile(file, JSON.stringify({ skills: { paths: "./team" } }));
    await assert.rejects(() => planOpenCodeConfig(file, "/managed", "array"), /array or an object with paths/);
    await assert.rejects(() => planOpenCodeConfig(file, "/managed", "paths"), /array or an object with paths/);
    await writeFile(file, JSON.stringify({ skills: "./team" }));
    await assert.rejects(() => planOpenCodeConfig(file, "/managed", "paths"), /array or an object with paths/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads both supported source shapes", () => {
  assert.deepEqual(configuredSkillSources({ skills: ["./one"] }), ["./one"]);
  assert.deepEqual(configuredSkillSources({ skills: { paths: ["./two"], urls: [] } }), ["./two"]);
  assert.deepEqual(configuredSkillSources({ skills: null }), []);
});

test("parses only complete OpenCode semantic versions", () => {
  assert.equal(skillShapeFromOpenCodeVersion("1.18.20\n"), "paths");
  assert.equal(skillShapeFromOpenCodeVersion("opencode v2.0.14"), "array");
  assert.equal(skillShapeFromOpenCodeVersion("warning from 2026: 1.18.20"), null);
  assert.equal(skillShapeFromOpenCodeVersion("2"), null);
});

test("the capability probe accepts only a single clean version and never guesses", async () => {
  const calls = [];
  const recording = (outcome) => (executable, args, options, callback) => {
    calls.push({ executable, args, options });
    queueMicrotask(() => callback(outcome.error ?? null, outcome.stdout ?? "", outcome.stderr ?? ""));
  };

  // Official output: one complete semantic version on stdout. 1.x means the
  // object-with-paths shape, 2.x means the array shape.
  assert.deepEqual(await probeOpenCodeSkillShape({ exec: recording({ stdout: "1.18.20\n" }) }), {
    status: "known",
    shape: "paths",
  });
  assert.deepEqual(await probeOpenCodeSkillShape({ exec: recording({ stdout: "opencode v2.0.26" }) }), {
    status: "known",
    shape: "array",
  });
  // Stderr noise does not contaminate a clean stdout version.
  assert.deepEqual(
    await probeOpenCodeSkillShape({ exec: recording({ stdout: "2.0.0\n", stderr: "experimental warning\n" }) }),
    { status: "known", shape: "array" },
  );

  // Anything else is a structured unknown — never a guessed shape.
  for (const outcome of [
    { stdout: "warning from 2026: 1.18.20\n" },
    { stdout: "2.0.0\nextra line\n" },
    { stdout: "" },
  ]) {
    assert.deepEqual(await probeOpenCodeSkillShape({ exec: recording(outcome) }), {
      status: "unknown",
      reason: "unrecognized-output",
    });
  }
  assert.deepEqual(await probeOpenCodeSkillShape({ exec: failureExec("ENOENT") }), {
    status: "unknown",
    reason: "not-found",
  });
  assert.deepEqual(
    await probeOpenCodeSkillShape({
      exec: failureExec(null, { killed: true, code: null, signal: "SIGTERM" }),
    }),
    { status: "unknown", reason: "timeout" },
  );
  assert.deepEqual(await probeOpenCodeSkillShape({ exec: failureExec(3) }), {
    status: "unknown",
    reason: "nonzero-exit",
  });
  assert.deepEqual(await probeOpenCodeSkillShape({ exec: failureExec("ERR_CHILD_PROCESS_STDIO_MAXBUFFER") }), {
    status: "unknown",
    reason: "noisy-output",
  });
  // A synchronous throw inside the seam degrades to a structured unknown.
  assert.deepEqual(
    await probeOpenCodeSkillShape({
      exec: () => {
        throw new Error("spawn exploded");
      },
    }),
    { status: "unknown", reason: "failed" },
  );

  // Every probe asks only for `--version`, asynchronously, with a bounded
  // timeout and bounded streams. Structured results never carry output text.
  assert.equal(calls.length, 6);
  for (const call of calls) {
    assert.deepEqual(call.args, ["--version"]);
    assert.equal(call.options.timeout, OPENCODE_PROBE_TIMEOUT_MS);
    assert.equal(call.options.encoding, "utf8");
    assert.equal(typeof call.options.maxBuffer, "number");
    assert.ok(call.options.maxBuffer > 0 && call.options.maxBuffer <= 1024 * 1024, "streams stay bounded");
  }
});

test("an existing valid skills shape wins without ever spawning the CLI", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-opencode-"));
  const file = path.join(root, "opencode.json");
  const forbidden = () => {
    throw new Error("the OpenCode CLI must not be spawned");
  };
  try {
    await writeFile(file, JSON.stringify({ model: "example/model", skills: ["./team"] }));
    const arrayPlan = await planOpenCodeConfig(file, "/managed", undefined, { exec: forbidden });
    assert.equal(arrayPlan.manual, false);
    assert.deepEqual(arrayPlan.config.skills, ["./team", "/managed"]);

    await writeFile(file, JSON.stringify({ skills: { paths: ["./team"], urls: [] } }));
    const pathsPlan = await planOpenCodeConfig(file, "/managed", undefined, { exec: forbidden });
    assert.equal(pathsPlan.manual, false);
    assert.deepEqual(pathsPlan.config.skills, { paths: ["./team", "/managed"], urls: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the probe decides the shape only when the configuration says nothing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-opencode-"));
  const file = path.join(root, "opencode.json");
  try {
    const pathsPlan = await planOpenCodeConfig(file, "/managed", undefined, { exec: versionExec("1.18.20") });
    assert.equal(pathsPlan.manual, false);
    assert.deepEqual(pathsPlan.config.skills, { paths: ["/managed"] });

    const arrayPlan = await planOpenCodeConfig(file, "/managed", undefined, { exec: versionExec("opencode v2.0.26") });
    assert.equal(arrayPlan.manual, false);
    assert.deepEqual(arrayPlan.config.skills, ["/managed"]);

    // A paths-less skills object still refuses a probed array shape instead of
    // dropping the object's fields into the wrong container.
    await writeFile(file, JSON.stringify({ skills: { urls: ["https://example.test/skills"] } }));
    await assert.rejects(
      () => planOpenCodeConfig(file, "/managed", undefined, { exec: versionExec("2.0.0") }),
      /array or an object with paths/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an uninferable shape defers the OpenCode write with one fixed shape-neutral action", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-opencode-"));
  const file = path.join(root, "opencode.json");
  try {
    // Missing binary, timeout, nonzero exit, and noisy output all defer the
    // same way: router-owned planning continues, nothing is written.
    for (const exec of [
      failureExec("ENOENT"),
      failureExec(null, { killed: true, code: null, signal: "SIGTERM" }),
      failureExec(1),
      callbackExec({ stdout: "warning from 2026: 1.18.20\n" }),
    ]) {
      const plan = await planOpenCodeConfig(file, "/managed", undefined, { exec });
      assert.equal(plan.deferred, true);
      assert.equal(plan.manual, true);
      assert.equal(plan.content, null);
      assert.equal(plan.instruction, OPENCODE_SHAPE_UNKNOWN_ACTION);
      assert.equal(/paths|array/i.test(plan.instruction), false, "the action never recommends either shape");
    }

    // A paths-less skills object with an unknown shape defers instead of
    // guessing (and instead of throwing).
    await writeFile(file, JSON.stringify({ skills: { urls: ["https://example.test/skills"] } }));
    const deferred = await planOpenCodeConfig(file, "/managed", undefined, { exec: failureExec("ENOENT") });
    assert.equal(deferred.deferred, true);
    assert.equal(deferred.content, null);
    assert.equal(deferred.instruction, OPENCODE_SHAPE_UNKNOWN_ACTION);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a dry run never spawns OpenCode and defers when the shape is unknown", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-opencode-"));
  const file = path.join(root, "opencode.json");
  let invocations = 0;
  const counting = (...args) => {
    invocations += 1;
    return versionExec("2.0.0")(...args);
  };
  try {
    const deferred = await planOpenCodeConfig(file, "/managed", undefined, { dryRun: true, exec: counting });
    assert.equal(invocations, 0, "a dry run never spawns OpenCode");
    assert.equal(deferred.deferred, true);
    assert.equal(deferred.content, null);
    assert.equal(deferred.instruction, OPENCODE_SHAPE_UNKNOWN_ACTION);

    // A dry run with a known shape still plans the rewrite without spawning.
    await writeFile(file, JSON.stringify({ skills: [] }));
    const known = await planOpenCodeConfig(file, "/managed", undefined, { dryRun: true, exec: counting });
    assert.equal(invocations, 0, "an existing shape needs no probe in a dry run either");
    assert.equal(known.deferred, undefined);
    assert.deepEqual(known.config.skills, ["/managed"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes every exact managed entry from a strict JSON skills array and preserves everything else", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-opencode-"));
  const file = path.join(root, "opencode.json");
  try {
    const original = {
      $schema: "https://opencode.ai/config.json",
      model: "example/model",
      theme: "dark",
      skills: ["/team", "/managed", "./managed", "/managed-extra", "/managed"],
      tools: { write: true },
    };
    const before = `${JSON.stringify(original, null, 2)}\n`;
    await writeFile(file, before);

    const plan = await planOpenCodeRemoval(file, "/managed");
    assert.equal(plan.status, "rewrite");
    assert.equal(plan.manual, false);
    assert.equal(plan.strict, true);
    assert.equal(plan.occurrenceCount, 2);
    assert.deepEqual(plan.config, {
      $schema: "https://opencode.ai/config.json",
      model: "example/model",
      theme: "dark",
      skills: ["/team", "./managed", "/managed-extra"],
      tools: { write: true },
    });
    assert.equal(plan.content, `${JSON.stringify(plan.config, null, 2)}\n`);

    // The plan alone proves nothing: the document is still untouched.
    await assert.rejects(() => verifyOpenCodeRemoval(plan), /planned removal bytes/);
    assert.equal(await readFile(file, "utf8"), before);

    await writeFile(file, plan.content);
    assert.equal(await verifyOpenCodeRemoval(plan), true);

    const again = await planOpenCodeRemoval(file, "/managed");
    assert.equal(again.status, "absent");
    assert.equal(again.occurrenceCount, 0);
    assert.equal(again.content, null);
    assert.equal(await verifyOpenCodeRemoval(again), true);
    assert.equal(await readFile(file, "utf8"), plan.content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes the managed path from skills.paths while preserving sibling sources and fields", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-opencode-"));
  const file = path.join(root, "opencode.json");
  try {
    const original = {
      model: "example/model",
      skills: { paths: ["/team", "/managed"], urls: ["https://example.test/skills"], disabled: [] },
      theme: "light",
    };
    await writeFile(file, `${JSON.stringify(original, null, 2)}\n`);

    const plan = await planOpenCodeRemoval(file, "/managed");
    assert.equal(plan.status, "rewrite");
    assert.equal(plan.occurrenceCount, 1);
    assert.deepEqual(plan.config, {
      model: "example/model",
      skills: { paths: ["/team"], urls: ["https://example.test/skills"], disabled: [] },
      theme: "light",
    });

    await writeFile(file, plan.content);
    assert.equal(await verifyOpenCodeRemoval(plan), true);
    const again = await planOpenCodeRemoval(file, "/managed");
    assert.equal(again.status, "absent");
    assert.equal(await verifyOpenCodeRemoval(again), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes every duplicate of the managed path so no occurrence survives", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-opencode-"));
  const file = path.join(root, "opencode.json");
  try {
    await writeFile(file, `${JSON.stringify({ skills: ["/managed", "/team", "/managed"] }, null, 2)}\n`);
    const plan = await planOpenCodeRemoval(file, "/managed");
    assert.equal(plan.occurrenceCount, 2);
    assert.deepEqual(plan.config.skills, ["/team"]);
    await writeFile(file, plan.content);
    assert.equal(await verifyOpenCodeRemoval(plan), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("treats a missing configuration as already detached and proves exact absence later", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-opencode-"));
  const file = path.join(root, "opencode.json");
  try {
    const plan = await planOpenCodeRemoval(file, "/managed");
    assert.deepEqual(plan, {
      file,
      skillsDirectory: "/managed",
      status: "absent",
      manual: false,
      config: null,
      content: null,
      strict: false,
      occurrenceCount: 0,
    });
    assert.equal(await verifyOpenCodeRemoval(plan), true);

    await writeFile(file, `${JSON.stringify({ skills: ["/managed"] }, null, 2)}\n`);
    await assert.rejects(() => verifyOpenCodeRemoval(plan), /still configured/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports an existing configuration without the exact entry as already detached", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-opencode-"));
  const file = path.join(root, "opencode.json");
  try {
    const before = `${JSON.stringify({ model: "example/model", skills: ["/team", "/managed-extra", "./managed"] }, null, 2)}\n`;
    await writeFile(file, before);

    const plan = await planOpenCodeRemoval(file, "/managed");
    assert.equal(plan.status, "absent");
    assert.equal(plan.manual, false);
    assert.equal(plan.strict, true);
    assert.equal(plan.content, null);
    assert.deepEqual(plan.config.skills, ["/team", "/managed-extra", "./managed"]);
    assert.equal(await readFile(file, "utf8"), before, "an absent plan never rewrites the configuration");
    assert.equal(await verifyOpenCodeRemoval(plan), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires manual removal for JSONC that still lists the managed directory and never rewrites it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-opencode-"));
  const file = path.join(root, "opencode.json");
  try {
    const jsonc = '{\n  // keep this comment\n  "skills": ["/team", "/managed"],\n}\n';
    await writeFile(file, jsonc);

    const plan = await planOpenCodeRemoval(file, "/managed");
    assert.equal(plan.status, "manual");
    assert.equal(plan.manual, true);
    assert.equal(plan.content, null);
    assert.equal(plan.strict, false);
    assert.equal(plan.occurrenceCount, 1);
    assert.match(plan.instruction, /skills array/);
    assert.match(plan.instruction, /"\/managed"/);
    assert.equal(await readFile(file, "utf8"), jsonc, "JSONC is never rewritten by a removal plan");
    await assert.rejects(() => verifyOpenCodeRemoval(plan), /manual removal/);

    const pathsJsonc = '{\n  // keep this too\n  "skills": { "paths": ["/managed"] },\n}\n';
    await writeFile(file, pathsJsonc);
    const pathsPlan = await planOpenCodeRemoval(file, "/managed");
    assert.equal(pathsPlan.status, "manual");
    assert.match(pathsPlan.instruction, /skills\.paths array/);
    assert.equal(await readFile(file, "utf8"), pathsJsonc);

    const detachedJsonc = '{\n  // still here\n  "skills": ["/team"],\n}\n';
    await writeFile(file, detachedJsonc);
    const absent = await planOpenCodeRemoval(file, "/managed");
    assert.equal(absent.status, "absent");
    assert.equal(absent.strict, false);
    assert.equal(await readFile(file, "utf8"), detachedJsonc);
    assert.equal(await verifyOpenCodeRemoval(absent), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed on malformed and unsupported OpenCode removal shapes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-opencode-"));
  const file = path.join(root, "opencode.json");
  try {
    await writeFile(file, '{ "skills": [');
    await assert.rejects(() => planOpenCodeRemoval(file, "/managed"), /Invalid/);

    const unsupported = ['{"skills":"./team"}', '{"skills":null}', '{"skills":{"paths":"./team"}}'];
    for (const document of unsupported) {
      await writeFile(file, document);
      await assert.rejects(
        () => planOpenCodeRemoval(file, "/managed"),
        /must be an array or an object with paths/,
      );
    }

    await writeFile(file, "[]");
    await assert.rejects(() => planOpenCodeRemoval(file, "/managed"), /must be an object/);
    await writeFile(file, '"just a string"');
    await assert.rejects(() => planOpenCodeRemoval(file, "/managed"), /must be an object/);
    await assert.rejects(() => planOpenCodeRemoval(file, ""), /managed skills directory is required/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("never treats the router configuration as an OpenCode configuration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-opencode-"));
  try {
    const routerConfig = path.join(root, ".skill-router.json");
    const document = `${JSON.stringify({ skills: ["/managed"] }, null, 2)}\n`;
    await writeFile(routerConfig, document);
    await assert.rejects(() => planOpenCodeRemoval(routerConfig, "/managed"), /router configuration/);
    assert.equal(await readFile(routerConfig, "utf8"), document);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses non-regular and symlinked configurations only when a rewrite would be required", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-opencode-"));
  const target = path.join(root, "target.json");
  const link = path.join(root, "opencode.json");
  const directoryTarget = path.join(root, "directory-config.json");
  try {
    await writeFile(target, `${JSON.stringify({ skills: ["/managed"] }, null, 2)}\n`);
    await symlink(target, link);
    await assert.rejects(() => planOpenCodeRemoval(link, "/managed"), /symlinked OpenCode configuration/);

    await writeFile(target, `${JSON.stringify({ skills: ["/team"] }, null, 2)}\n`);
    const detached = await planOpenCodeRemoval(link, "/managed");
    assert.equal(detached.status, "absent", "a symlink with no entry needs no rewrite");

    await rm(target, { force: true });
    const dangling = await planOpenCodeRemoval(link, "/managed");
    assert.equal(dangling.status, "absent");
    assert.equal(await verifyOpenCodeRemoval(dangling), true);

    await mkdir(directoryTarget);
    await assert.rejects(() => planOpenCodeRemoval(directoryTarget, "/managed"), /non-regular OpenCode configuration/);
    await assert.rejects(() => verifyOpenCodeRemoval({ file: directoryTarget, skillsDirectory: "/managed", status: "absent" }), /non-regular OpenCode configuration/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification fails when the managed entry returns or the bytes drift", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-opencode-"));
  const file = path.join(root, "opencode.json");
  try {
    await writeFile(file, `${JSON.stringify({ skills: ["/managed"] }, null, 2)}\n`);
    const plan = await planOpenCodeRemoval(file, "/managed");
    await writeFile(file, plan.content);
    assert.equal(await verifyOpenCodeRemoval(plan), true);

    // Semantically detached but byte-drifted: the rewrite contract is exact.
    await writeFile(file, '{"skills":[]}');
    await assert.rejects(() => verifyOpenCodeRemoval(plan), /planned removal bytes/);

    await writeFile(file, plan.content);
    assert.equal(await verifyOpenCodeRemoval(plan), true);

    // An already-absent plan must still prove exact absence afterwards.
    await writeFile(file, `${JSON.stringify({ skills: ["/team"] }, null, 2)}\n`);
    const absent = await planOpenCodeRemoval(file, "/managed");
    assert.equal(absent.status, "absent");
    assert.equal(await verifyOpenCodeRemoval(absent), true);
    await writeFile(file, `${JSON.stringify({ skills: ["/team", "/managed"] }, null, 2)}\n`);
    await assert.rejects(() => verifyOpenCodeRemoval(absent), /still configured/);

    await writeFile(file, "{ nope");
    await assert.rejects(() => verifyOpenCodeRemoval(absent), /Invalid/);
    await assert.rejects(() => verifyOpenCodeRemoval(plan), /planned removal bytes/);
    await assert.rejects(() => verifyOpenCodeRemoval(null), /plan is required/);
    await assert.rejects(() => verifyOpenCodeRemoval({ file, skillsDirectory: "/managed", status: "unknown" }), /Unsupported/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a rewrite plan records the exact bytes it observed on disk", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-opencode-"));
  const file = path.join(root, "opencode.json");
  try {
    // Deliberately uncanonical formatting: the recorded bytes are the file's,
    // never a reserialization of the parsed document.
    const document = '{"model":   "example/model","skills":["/team","/managed"]}';
    await writeFile(file, document);
    const plan = await planOpenCodeRemoval(file, "/managed");
    assert.equal(plan.status, "rewrite");
    assert.ok(Buffer.isBuffer(plan.original), "the plan records a byte buffer");
    assert.equal(plan.original.toString("utf8"), document, "the recorded bytes are exactly what is on disk");
    assert.notEqual(plan.content, document, "the rewrite itself stays canonical");
    assert.equal(
      (await readFile(file, "utf8")),
      document,
      "planning never rewrites the configuration",
    );

    const detached = `${JSON.stringify({ model: "example/model", skills: ["/team"] }, null, 2)}\n`;
    await writeFile(file, detached);
    const absent = await planOpenCodeRemoval(file, "/managed");
    assert.equal(absent.status, "absent");
    assert.equal(absent.original, undefined, "an absent plan never claims bytes it will not write");

    await writeFile(file, '{\n  // keep me\n  "skills": ["/managed"],\n}\n');
    const manual = await planOpenCodeRemoval(file, "/managed");
    assert.equal(manual.status, "manual");
    assert.equal(manual.original, undefined, "a manual plan never claims bytes either");

    const missing = await planOpenCodeRemoval(path.join(root, "absent.json"), "/managed");
    assert.equal(missing.status, "absent");
    assert.equal(missing.original, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every configuration plan records the exact observed bytes and existence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-router-opencode-"));
  const file = path.join(root, "opencode.json");
  try {
    // An absent configuration: every outcome records absence explicitly, so a
    // caller can bind its write to "must still be absent".
    const absentRewrite = await planOpenCodeConfig(file, "/managed", "array");
    assert.equal(absentRewrite.exists, false);
    assert.equal(absentRewrite.original, null);
    assert.equal(absentRewrite.manual, false);
    const absentDeferred = await planOpenCodeConfig(file, "/managed", undefined, { exec: failureExec("ENOENT") });
    assert.equal(absentDeferred.deferred, true);
    assert.equal(absentDeferred.exists, false);
    assert.equal(absentDeferred.original, null);

    // An existing configuration: the exact bytes, for rewrite, JSONC-manual,
    // and deferred plans alike.
    const strictDocument = `${JSON.stringify({ skills: [] }, null, 2)}\n`;
    await writeFile(file, strictDocument);
    const rewrite = await planOpenCodeConfig(file, "/managed", "array");
    assert.equal(rewrite.exists, true);
    assert.ok(Buffer.isBuffer(rewrite.original), "the observed bytes are a byte buffer");
    assert.equal(rewrite.original.toString("utf8"), strictDocument);
    assert.notEqual(rewrite.content, strictDocument, "the rewrite itself stays canonical");

    const jsonc = '{\n  // keep\n  "skills": ["/managed"],\n}\n';
    await writeFile(file, jsonc);
    const manual = await planOpenCodeConfig(file, "/managed", "array");
    assert.equal(manual.manual, true);
    assert.equal(manual.content, null, "JSONC is never rewritten");
    assert.equal(manual.exists, true);
    assert.equal(manual.original.toString("utf8"), jsonc, "the manual plan still records the observed bytes");

    // A deferred plan over an *existing* document: the file carries no skills
    // shape, so the failing probe defers — and the observed bytes are still
    // recorded.
    const jsoncNoSkills = '{\n  // keep\n  "theme": "dark",\n}\n';
    await writeFile(file, jsoncNoSkills);
    const deferred = await planOpenCodeConfig(file, "/managed", undefined, { exec: failureExec("ENOENT") });
    assert.equal(deferred.deferred, true);
    assert.equal(deferred.content, null);
    assert.equal(deferred.exists, true);
    assert.equal(deferred.original.toString("utf8"), jsoncNoSkills, "the deferred plan still records the observed bytes");
    assert.equal(await readFile(file, "utf8"), jsoncNoSkills, "planning never rewrites the configuration");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the probe owns an independent deadline and ignores any late answer", async () => {
  const kills = [];
  const child = {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kill: (signal) => {
      kills.push(signal);
      return true;
    },
  };
  let lateCallback = null;
  const hanging = (executable, args, options, callback) => {
    assert.deepEqual(args, ["--version"], "the probe still asks only for --version");
    lateCallback = callback;
    return child;
  };

  // The executor never calls back; the probe still settles on its own small
  // deadline as a structured timeout and terminates the retained child.
  const result = await probeOpenCodeSkillShape({ exec: hanging, timeoutMs: 25 });
  assert.deepEqual(result, { status: "unknown", reason: "timeout" });
  assert.deepEqual(kills, ["SIGTERM"], "the retained child handle is terminated at the deadline");

  // A late, perfectly clean answer cannot change the settled result.
  lateCallback(null, "opencode v9.9.9\n", "");
  assert.deepEqual(result, { status: "unknown", reason: "timeout" });
});

test("a probe child that ignores SIGTERM gets exactly one bounded escalation", async () => {
  const kills = [];
  // `exitCode` stays null: the child never exits, so the bounded escalation
  // runs once. The handle is a plain fake — this test spawns no process.
  const stubborn = {
    pid: 4343,
    exitCode: null,
    signalCode: null,
    kill: (signal) => {
      kills.push(signal);
      return true;
    },
  };
  const result = await probeOpenCodeSkillShape({
    exec: (executable, args, options, callback) => stubborn,
    timeoutMs: 20,
  });
  assert.deepEqual(result, { status: "unknown", reason: "timeout" });
  assert.deepEqual(kills, ["SIGTERM"]);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(kills, ["SIGTERM", "SIGKILL"], "one escalation, then nothing");
});

test("an executor without a handle still settles on the probe's own deadline", async () => {
  const result = await probeOpenCodeSkillShape({
    exec: () => undefined,
    timeoutMs: 20,
  });
  assert.deepEqual(result, { status: "unknown", reason: "timeout" });
});
