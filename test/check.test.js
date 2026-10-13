import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const checker = path.join(repository, "scripts", "check.mjs");
const CHECKER_SOURCE = await readFile(checker, "utf8");
const PACKAGE_VERSION = JSON.parse(await readFile(path.join(repository, "package.json"), "utf8")).version;

const MAX_TEST_OUTPUT = 256 * 1024;
const CONTROL_BYTES = /[\u0000-\u0008\u000B-\u001F\u007F]/;
const POSIX_MODES = process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;
const INODE_IDENTITY = process.platform !== "win32" && statSync(os.tmpdir()).ino > 0;
const SYMLINKS_SUPPORTED = process.platform !== "win32";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    return true; // EPERM means it exists but is not ours
  }
}

async function waitForDeath(pid, budgetMs = 5000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return;
    await sleep(100);
  }
}

function waitClose(child, budgetMs = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), budgetMs);
    child.on("close", () => {
      clearTimeout(timer);
      resolve("closed");
    });
  });
}

function run(nodeArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, nodeArgs, {
      cwd: options.cwd ?? repository,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (target) => (chunk) => {
      if (target.text.length >= MAX_TEST_OUTPUT) return;
      target.text += chunk.toString("utf8").slice(0, MAX_TEST_OUTPUT - target.text.length);
    };
    const out = { text: "" };
    const err = { text: "" };
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout: out.text, stderr: err.text }));
  });
}

async function countDirectFiles(directory, extension) {
  const entries = await readdir(path.join(repository, directory), { withFileTypes: true });
  return entries.filter((entry) => !entry.isDirectory() && entry.name.endsWith(extension)).length;
}

// Copies the real checker into a fixture root; `options.timeoutMs` rewrites
// the copied timeout constant only (the production checker and its environment
// are never given a timeout override).
async function createFixture(label, files, options = {}) {
  let source = CHECKER_SOURCE;
  if (options.timeoutMs !== undefined) {
    const transformed = source.replace(
      /const CHILD_TIMEOUT_MS = [\d_]+;/,
      `const CHILD_TIMEOUT_MS = ${options.timeoutMs};`,
    );
    assert.notEqual(transformed, source, "timeout transform must apply to the copied checker");
    source = transformed;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), `skill-router-check-fixture-${label}-`));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: `check-fixture-${label}`, version: "9.9.9", type: "module", private: true }, null, 2)}\n`,
  );
  await writeFile(path.join(root, "scripts", "check.mjs"), source);
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(root, ...file.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return root;
}

// Runs the fixture's copy of the checker with an isolated TMPDIR parent so the
// test can assert the checker removed its own temporary sandbox. `options.env`
// passes test-owned values through the checker into its children (the checker
// spreads its inherited environment).
async function runFixture(root, options = {}) {
  const tmpParent = path.join(root, "checker-tmp");
  await mkdir(tmpParent, { recursive: true });
  const result = await run([path.join(root, "scripts", "check.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      TMPDIR: tmpParent,
      TMP: tmpParent,
      TEMP: tmpParent,
      HOME: path.join(root, "fixture-home"),
      USERPROFILE: path.join(root, "fixture-home"),
      ...(options.env ?? {}),
    },
  });
  const leftovers = await readdir(tmpParent);
  return { ...result, leftovers };
}

// The pre-Phase-10 gate, expanded the way the shell did it: syntax only.
async function legacySyntaxGate(root) {
  const results = [];
  for (const [directory, extension] of [
    ["src", ".js"],
    ["scripts", ".mjs"],
  ]) {
    const entries = await readdir(path.join(root, directory), { withFileTypes: true });
    const files = entries
      .filter((entry) => !entry.isDirectory() && entry.name.endsWith(extension))
      .map((entry) => `${directory}/${entry.name}`)
      .sort();
    for (const file of files) {
      results.push({ file, ...(await run(["--check", path.join(root, ...file.split("/"))], { cwd: root })) });
    }
  }
  return results;
}

const MINIMAL_CLI = `#!/usr/bin/env node
import { readFile } from "node:fs/promises";
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
process.stdout.write(\`\${packageJson.version}\\n\`);
`;

const UNRESOLVED_IMPORT = 'import "./missing.js";\n';
const TOP_LEVEL_THROW = 'throw new Error("boom at import time");\n';

test("real checker passes with exact counts and preserves sentinel homes", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "skill-router-check-real-"));
  const home = path.join(base, "home");
  const claude = path.join(base, "claude");
  const xdg = path.join(base, "xdg");
  const tmpParent = path.join(base, "tmp");
  for (const directory of [home, claude, xdg, tmpParent]) await mkdir(directory, { recursive: true });

  const sentinel = Buffer.from("sentinel\u0000bytes\n", "utf8");
  await writeFile(path.join(home, "sentinel"), sentinel);
  await writeFile(path.join(claude, "settings.json"), sentinel);
  await writeFile(path.join(xdg, "sentinel"), sentinel);

  const snapshot = async () => {
    const state = {};
    for (const [name, directory] of [
      ["home", home],
      ["claude", claude],
      ["xdg", xdg],
    ]) {
      const entries = (await readdir(directory)).sort();
      const bytes = [];
      for (const entry of entries) bytes.push(await readFile(path.join(directory, entry)));
      state[name] = { entries, bytes };
    }
    return state;
  };
  const before = await snapshot();

  try {
    const result = await run([checker], {
      cwd: repository,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: claude,
        XDG_CONFIG_HOME: xdg,
        SKILL_ROUTER_HOME: home,
        TMPDIR: tmpParent,
        TMP: tmpParent,
        TEMP: tmpParent,
      },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");

    const sources = await countDirectFiles("src", ".js");
    const scripts = await countDirectFiles("scripts", ".mjs");
    assert.ok(sources >= 2 && scripts >= 2, `unexpected counts src=${sources} scripts=${scripts}`);
    assert.equal(
      result.stdout,
      `check: ok | syntax ${sources + scripts} (src ${sources}, scripts ${scripts}) | imports ${sources - 1} | cli --version ${PACKAGE_VERSION} | sandbox clean\n`,
    );

    assert.deepEqual(await snapshot(), before, "sentinel homes must stay byte-identical");
    assert.deepEqual(await readdir(tmpParent), [], "no checker temp must remain");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("fixture: syntax-invalid src and script files fail the syntax phase", async () => {
  const srcRoot = await createFixture("syntax-src", {
    "src/cli.js": MINIMAL_CLI,
    "src/broken.js": "const = ;\n",
  });
  const scriptRoot = await createFixture("syntax-script", {
    "src/cli.js": MINIMAL_CLI,
    "scripts/broken.mjs": "export const = ;\n",
  });
  try {
    const srcResult = await runFixture(srcRoot);
    assert.equal(srcResult.code, 1);
    assert.equal(srcResult.stdout, "");
    assert.match(srcResult.stderr, /phase: syntax/);
    assert.match(srcResult.stderr, /file: src\/broken\.js/);

    const scriptResult = await runFixture(scriptRoot);
    assert.equal(scriptResult.code, 1);
    assert.equal(scriptResult.stdout, "");
    assert.match(scriptResult.stderr, /phase: syntax/);
    assert.match(scriptResult.stderr, /file: scripts\/broken\.mjs/);

    assert.deepEqual(srcResult.leftovers, []);
    assert.deepEqual(scriptResult.leftovers, []);
  } finally {
    await rm(srcRoot, { recursive: true, force: true });
    await rm(scriptRoot, { recursive: true, force: true });
  }
});

test("fixture: unresolved import and top-level throw fail the import phase", async () => {
  const importRoot = await createFixture("unresolved-import", {
    "src/cli.js": MINIMAL_CLI,
    "src/importer.js": UNRESOLVED_IMPORT,
  });
  const throwRoot = await createFixture("top-level-throw", {
    "src/cli.js": MINIMAL_CLI,
    "src/topthrow.js": TOP_LEVEL_THROW,
  });
  try {
    const importResult = await runFixture(importRoot);
    assert.equal(importResult.code, 1);
    assert.equal(importResult.stdout, "");
    assert.match(importResult.stderr, /phase: imports/);
    assert.match(importResult.stderr, /file: src\/importer\.js/);

    const throwResult = await runFixture(throwRoot);
    assert.equal(throwResult.code, 1);
    assert.equal(throwResult.stdout, "");
    assert.match(throwResult.stderr, /phase: imports/);
    assert.match(throwResult.stderr, /file: src\/topthrow\.js/);
    assert.match(throwResult.stderr, /boom at import time/);

    assert.deepEqual(importResult.leftovers, []);
    assert.deepEqual(throwResult.leftovers, []);
  } finally {
    await rm(importRoot, { recursive: true, force: true });
    await rm(throwRoot, { recursive: true, force: true });
  }
});

test("fixture: CLI nonzero exit, wrong version, and extra output fail the cli phase", async () => {
  const exitRoot = await createFixture("cli-exit", {
    "src/cli.js": '#!/usr/bin/env node\nprocess.stderr.write("cli exploded\\n");\nprocess.exit(1);\n',
  });
  const wrongRoot = await createFixture("cli-wrong", {
    "src/cli.js": '#!/usr/bin/env node\nprocess.stdout.write("0.0.0\\n");\n',
  });
  const extraRoot = await createFixture("cli-extra", {
    "src/cli.js": `${MINIMAL_CLI}process.stdout.write("extra line\\n");\n`,
  });
  try {
    const exitResult = await runFixture(exitRoot);
    assert.equal(exitResult.code, 1);
    assert.equal(exitResult.stdout, "");
    assert.match(exitResult.stderr, /phase: cli/);
    assert.match(exitResult.stderr, /file: src\/cli\.js/);
    assert.match(exitResult.stderr, /exited with code 1/);

    const wrongResult = await runFixture(wrongRoot);
    assert.equal(wrongResult.code, 1);
    assert.equal(wrongResult.stdout, "");
    assert.match(wrongResult.stderr, /phase: cli/);
    assert.match(wrongResult.stderr, /file: src\/cli\.js/);

    const extraResult = await runFixture(extraRoot);
    assert.equal(extraResult.code, 1);
    assert.equal(extraResult.stdout, "");
    assert.match(extraResult.stderr, /phase: cli/);
    assert.match(extraResult.stderr, /must print exactly <9\.9\.9>/);

    for (const result of [exitResult, wrongResult, extraResult]) assert.deepEqual(result.leftovers, []);
  } finally {
    await rm(exitRoot, { recursive: true, force: true });
    await rm(wrongRoot, { recursive: true, force: true });
    await rm(extraRoot, { recursive: true, force: true });
  }
});

test("fixture: import-time write into HOME fails the side-effect phase and cleans the sandbox", async () => {
  const root = await createFixture("side-effect", {
    "src/cli.js": MINIMAL_CLI,
    "src/leaker.js":
      'import { writeFileSync } from "node:fs";\nimport path from "node:path";\nimport process from "node:process";\nwriteFileSync(path.join(process.env.HOME ?? ".", "leak.txt"), "leak\\n");\n',
  });
  try {
    const result = await runFixture(root);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /phase: side-effect/);
    assert.match(result.stderr, /file: src\/leaker\.js/);
    assert.match(result.stderr, /home\/leak\.txt/);
    assert.deepEqual(result.leftovers, [], "checker sandbox must be removed after the failure");
    assert.deepEqual((await readdir(root)).sort(), ["checker-tmp", "package.json", "scripts", "src"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy node --check passes fixtures the runtime checker rejects", async () => {
  const runtimeRoot = await createFixture("legacy-runtime", {
    "src/cli.js": '#!/usr/bin/env node\nprocess.stdout.write("0.0.0\\n");\n',
    "src/importer.js": UNRESOLVED_IMPORT,
    "src/topthrow.js": TOP_LEVEL_THROW,
  });
  const cliRoot = await createFixture("legacy-cli", {
    "src/cli.js": '#!/usr/bin/env node\nprocess.stderr.write("boom\\n");\nprocess.exit(3);\n',
  });
  try {
    const runtimeGate = await legacySyntaxGate(runtimeRoot);
    assert.ok(runtimeGate.length >= 3);
    for (const entry of runtimeGate) {
      assert.equal(entry.code, 0, `legacy node --check unexpectedly failed ${entry.file}: ${entry.stderr}`);
    }

    const runtimeResult = await runFixture(runtimeRoot);
    assert.equal(runtimeResult.code, 1);
    assert.match(runtimeResult.stderr, /phase: imports/);
    assert.match(runtimeResult.stderr, /file: src\/importer\.js/);

    const cliGate = await legacySyntaxGate(cliRoot);
    for (const entry of cliGate) {
      assert.equal(entry.code, 0, `legacy node --check unexpectedly failed ${entry.file}: ${entry.stderr}`);
    }
    const cliResult = await runFixture(cliRoot);
    assert.equal(cliResult.code, 1);
    assert.match(cliResult.stderr, /phase: cli/);
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
    await rm(cliRoot, { recursive: true, force: true });
  }
});

test("fixture: control-heavy failure output is sanitized and bounded", async () => {
  const noisyModule = [
    'const color = "\\u001b[31m";',
    `throw new Error("boom " + color + ${JSON.stringify("x".repeat(4000))} + "\\u0000" + ${JSON.stringify("y".repeat(4000))});`,
    "",
  ].join("\n");
  const root = await createFixture("control-heavy", {
    "src/cli.js": MINIMAL_CLI,
    "src/bad\u0007name.js": noisyModule,
  });
  try {
    const result = await runFixture(root);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /phase: imports/);
    assert.ok(!CONTROL_BYTES.test(result.stderr), "no raw control byte may reach the checker output");
    assert.ok(!result.stderr.includes("x".repeat(300)), "long child payloads must be truncated");
    assert.ok(result.stderr.length < 4096, `checker stderr must stay bounded, got ${result.stderr.length}`);
    assert.ok(result.stderr.includes("file: src/bad"), "control-heavy file name stays identifiable after sanitizing");
    assert.ok(result.stderr.includes("\\x07"), "control byte is rendered as printable text");
    assert.deepEqual(result.leftovers, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const REMOVE_HOME = `import { rmSync } from "node:fs";
import process from "node:process";
rmSync(process.env.HOME ?? ".", { recursive: true, force: true });
`;

test("fixture: removed sandbox HOME fails the side-effect phase", async () => {
  const root = await createFixture("home-removed", {
    "src/cli.js": MINIMAL_CLI,
    "src/homeremover.js": REMOVE_HOME,
  });
  try {
    const result = await runFixture(root);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /phase: side-effect/);
    assert.match(result.stderr, /file: src\/homeremover\.js/);
    assert.match(result.stderr, /entry home \(lstat failed: ENOENT\)/);
    assert.ok(!CONTROL_BYTES.test(result.stderr));
    assert.ok(result.stderr.length < 4096, `checker stderr must stay bounded, got ${result.stderr.length}`);
    assert.deepEqual(result.leftovers, [], "checker sandbox must be removed after the failure");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fixture: sandbox HOME replaced with a regular file fails the side-effect phase", async () => {
  const root = await createFixture("home-file", {
    "src/cli.js": MINIMAL_CLI,
    "src/homefiler.js": `import { rmSync, writeFileSync } from "node:fs";
import process from "node:process";
rmSync(process.env.HOME ?? ".", { recursive: true, force: true });
writeFileSync(process.env.HOME ?? ".", "not a directory\\n");
`,
  });
  try {
    const result = await runFixture(root);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /phase: side-effect/);
    assert.match(result.stderr, /file: src\/homefiler\.js/);
    assert.match(result.stderr, /entry home \(not an ordinary directory: file\)/);
    assert.ok(!CONTROL_BYTES.test(result.stderr));
    assert.deepEqual(result.leftovers, [], "checker sandbox must be removed after the failure");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fixture: sandbox HOME replaced with a fresh empty directory fails on identity drift", { skip: INODE_IDENTITY ? false : "no usable inode identity on this platform" }, async () => {
  const root = await createFixture("home-drift", {
    "src/cli.js": MINIMAL_CLI,
    "src/homedrifter.js": `import { mkdirSync, renameSync } from "node:fs";
import process from "node:process";
// Rename the original HOME aside instead of deleting it: an inode allocator
// with eager reuse (ext4 on the Linux runner) can give the fresh directory
// the same dev/ino the deleted one just freed, erasing the drift. A renamed
// original keeps its inode allocated, so the replacement always differs.
renameSync(process.env.HOME ?? ".", (process.env.HOME ?? ".") + "-pinned");
mkdirSync(process.env.HOME ?? ".");
`,
  });
  try {
    const result = await runFixture(root);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /phase: side-effect/);
    assert.match(result.stderr, /file: src\/homedrifter\.js/);
    assert.match(result.stderr, /entry home \(identity drift: \d+:\d+ -> \d+:\d+\)/);
    assert.ok(!CONTROL_BYTES.test(result.stderr));
    assert.ok(result.stderr.length < 4096, `checker stderr must stay bounded, got ${result.stderr.length}`);
    assert.deepEqual(result.leftovers, [], "checker sandbox must be removed after the failure");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fixture: sandbox HOME replaced with a symlink to an external directory is never followed", { skip: SYMLINKS_SUPPORTED ? false : "symlink creation unavailable on this platform" }, async () => {
  const external = await mkdtemp(path.join(os.tmpdir(), "skill-router-check-external-"));
  const marker = path.join(external, "external-marker.txt");
  const markerBytes = "external sentinel bytes\n";
  await writeFile(marker, markerBytes);
  const root = await createFixture("home-symlink", {
    "src/cli.js": MINIMAL_CLI,
    "src/homelinker.js": [
      'import { rmSync, symlinkSync } from "node:fs";',
      'import process from "node:process";',
      'rmSync(process.env.HOME ?? ".", { recursive: true, force: true });',
      `symlinkSync(${JSON.stringify(external)}, process.env.HOME ?? ".", "dir");`,
      "",
    ].join("\n"),
  });
  try {
    const result = await runFixture(root);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /phase: side-effect/);
    assert.match(result.stderr, /file: src\/homelinker\.js/);
    assert.match(result.stderr, /entry home \(not an ordinary directory: symlink\)/);
    assert.ok(!result.stderr.includes(external), "the external target path must not be named");
    assert.ok(!result.stderr.includes("external-marker.txt"), "external contents must not be named");
    assert.ok(!CONTROL_BYTES.test(result.stderr));
    assert.ok(result.stderr.length < 4096, `checker stderr must stay bounded, got ${result.stderr.length}`);
    assert.deepEqual(await readdir(external), ["external-marker.txt"], "external directory stays untouched");
    assert.equal(await readFile(marker, "utf8"), markerBytes, "external sentinel stays byte-identical");
    assert.deepEqual(result.leftovers, [], "checker sandbox must be removed after the failure");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("fixture: unreadable sandbox HOME is reported as an observation failure, not clean", { skip: POSIX_MODES ? false : "POSIX mode bits unavailable or running privileged" }, async () => {
  const root = await createFixture("home-chmod", {
    "src/cli.js": MINIMAL_CLI,
    "src/homechmodder.js": 'import { chmodSync } from "node:fs";\nimport process from "node:process";\nchmodSync(process.env.HOME ?? ".", 0o000);\n',
  });
  try {
    const result = await runFixture(root);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /phase: side-effect/);
    assert.match(result.stderr, /file: src\/homechmodder\.js/);
    assert.match(result.stderr, /entry home \(readdir failed: EACCES\)/);
    assert.ok(result.stderr.length < 4096, `checker stderr must stay bounded, got ${result.stderr.length}`);
    assert.deepEqual(result.leftovers, [], "checker sandbox must be removed after the failure");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const DESCENDANT_SCRIPT = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
const HANG_MODULE = [
  'import { spawn } from "node:child_process";',
  'import process from "node:process";',
  'process.on("SIGTERM", () => {});',
  `const descendant = spawn(process.execPath, [${JSON.stringify("-e")}, ${JSON.stringify(DESCENDANT_SCRIPT)}], { stdio: ["ignore", "inherit", "inherit"] });`,
  "process.stdout.write(`DESCENDANT_PID=${descendant.pid}\\n`);",
  "setInterval(() => {}, 1000);",
  "",
].join("\n");

test("fixture: timed-out import terminates its descendant process group and settles", async () => {
  const timeoutMs = 1200;
  const root = await createFixture(
    "timeout",
    {
      "src/cli.js": MINIMAL_CLI,
      "src/hang.js": HANG_MODULE,
    },
    { timeoutMs },
  );
  try {
    const started = Date.now();
    const result = await runFixture(root);
    const duration = Date.now() - started;

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /phase: imports/);
    assert.match(result.stderr, /file: src\/hang\.js/);
    assert.match(result.stderr, new RegExp(`timed out after ${timeoutMs}ms`));
    assert.ok(!CONTROL_BYTES.test(result.stderr), "no raw control byte may reach the checker output");
    assert.ok(result.stderr.length < 4096, `checker stderr must stay bounded, got ${result.stderr.length}`);
    assert.ok(duration >= timeoutMs, `must not settle before the timeout, got ${duration}ms`);
    assert.ok(duration < 10000, `must settle within the bounded grace window, got ${duration}ms`);
    assert.deepEqual(result.leftovers, [], "checker sandbox must be removed after the timeout");

    const match = result.stderr.match(/DESCENDANT_PID=(\d+)/);
    assert.ok(match, `descendant pid must be reported in bounded output: ${result.stderr}`);
    const descendantPid = Number(match[1]);
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 1, `implausible descendant pid ${descendantPid}`);
    await waitForDeath(descendantPid);
    assert.ok(!alive(descendantPid), `descendant ${descendantPid} must not survive the group kill`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy direct-child-only kill leaves the ordinary descendant alive", async () => {
  const root = await createFixture("old-kill", {
    "src/cli.js": MINIMAL_CLI,
    "src/hang.js": HANG_MODULE,
  });
  const scratch = await mkdtemp(path.join(os.tmpdir(), "skill-router-check-oldkill-"));
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(pathToFileURL(path.join(root, "src", "hang.js")).href)});\nprocess.exit(0);\n`,
    ],
    {
      cwd: scratch,
      env: { ...process.env, HOME: scratch, USERPROFILE: scratch, SKILL_ROUTER_HOME: scratch },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  let stdout = "";
  let closed = false;
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.on("close", () => (closed = true));
  try {
    let descendantPid = null;
    const deadline = Date.now() + 10000;
    while (descendantPid === null && Date.now() < deadline) {
      const match = stdout.match(/DESCENDANT_PID=(\d+)/);
      if (match) descendantPid = Number(match[1]);
      else await sleep(50);
    }
    assert.ok(descendantPid, `descendant pid must be reported: ${stdout}`);

    // The pre-remediation behavior: signal only the direct child.
    child.kill("SIGKILL");
    await sleep(750);
    assert.ok(alive(descendantPid), "old direct-child kill must leave the descendant alive");
    assert.ok(!closed, "old direct-child kill never closes the pipes the descendant still holds");

    // The remediation's mechanism: the child's own process group carries it.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
    await waitForDeath(descendantPid);
    assert.ok(!alive(descendantPid), "group kill must terminate the descendant");
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

// The direct parent is SIGTERM-compliant (no handler): it dies at the
// timeout's SIGTERM, so its close fires inside the grace window. A
// never-resolving top-level await keeps the direct child itself alive (so the
// timeout fires at all), while the descendant ignores SIGTERM and holds no
// pipes.
const HANG_MODULE_TERM_COMPLIANT = [
  'import { spawn } from "node:child_process";',
  'import process from "node:process";',
  `const descendant = spawn(process.execPath, [${JSON.stringify("-e")}, ${JSON.stringify(DESCENDANT_SCRIPT)}], { stdio: ["ignore", "ignore", "ignore"] });`,
  "process.stdout.write(`DESCENDANT_PID=${descendant.pid}\\n`);",
  "await new Promise(() => {});",
  "",
].join("\n");

// Spawns a long-lived SIGTERM-resistant ordinary descendant with ignored
// stdio, reports the pid through a test-owned channel outside the sandbox,
// and returns normally.
const RESIDUAL_MODULE = [
  'import { spawn } from "node:child_process";',
  'import { writeFileSync } from "node:fs";',
  'import process from "node:process";',
  `const descendant = spawn(process.execPath, [${JSON.stringify("-e")}, ${JSON.stringify(DESCENDANT_SCRIPT)}], { stdio: ["ignore", "ignore", "ignore"] });`,
  'if (process.env.CHECK_PID_CHANNEL) writeFileSync(process.env.CHECK_PID_CHANNEL, `${descendant.pid}\\n`);',
  "",
].join("\n");

test("fixture: timeout with a SIGTERM-compliant parent still force-terminates the descendant tree", async () => {
  const timeoutMs = 1200;
  const root = await createFixture(
    "timeout-compliant",
    {
      "src/cli.js": MINIMAL_CLI,
      "src/hangterm.js": HANG_MODULE_TERM_COMPLIANT,
    },
    { timeoutMs },
  );
  try {
    const started = Date.now();
    const result = await runFixture(root);
    const duration = Date.now() - started;

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /phase: imports/);
    assert.match(result.stderr, /file: src\/hangterm\.js/);
    assert.match(result.stderr, new RegExp(`timed out after ${timeoutMs}ms`));
    assert.match(result.stderr, /direct child signal SIGTERM/, "the direct parent must die on the timeout SIGTERM");
    assert.ok(!CONTROL_BYTES.test(result.stderr), "no raw control byte may reach the checker output");
    assert.ok(result.stderr.length < 4096, `checker stderr must stay bounded, got ${result.stderr.length}`);
    assert.ok(duration >= timeoutMs, `must not settle before the timeout, got ${duration}ms`);
    assert.ok(duration < 10000, `must settle within the bounded grace window, got ${duration}ms`);
    assert.deepEqual(result.leftovers, [], "checker sandbox must be removed after the timeout");

    const match = result.stderr.match(/DESCENDANT_PID=(\d+)/);
    assert.ok(match, `descendant pid must be reported in bounded output: ${result.stderr}`);
    const descendantPid = Number(match[1]);
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 1);
    await waitForDeath(descendantPid);
    assert.ok(!alive(descendantPid), `descendant ${descendantPid} must not survive the forced tree kill`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fixture: a normally-closed import leaves no residual descendant alive", async () => {
  const root = await createFixture("normal-residual", {
    "src/cli.js": MINIMAL_CLI,
    "src/spawner.js": RESIDUAL_MODULE,
  });
  const channel = path.join(root, "pid-channel");
  await mkdir(channel, { recursive: true });
  const pidFile = path.join(channel, "descendant.pid");
  try {
    const result = await runFixture(root, { env: { CHECK_PID_CHANNEL: pidFile } });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^check: ok \|/);
    assert.deepEqual(result.leftovers, [], "checker sandbox must stay clean on a passing run");
    assert.ok(!result.stdout.includes(pidFile) && !result.stderr.includes(pidFile), "pid channel path must not be exposed");
    assert.ok(!result.stdout.includes("pid-channel") && !result.stderr.includes("pid-channel"));

    const pid = Number((await readFile(pidFile, "utf8")).trim());
    assert.ok(Number.isInteger(pid) && pid > 1, `implausible descendant pid ${pid}`);
    assert.ok(!result.stdout.includes(String(pid)) && !result.stderr.includes(String(pid)), "descendant pid must not be exposed");
    await waitForDeath(pid);
    assert.ok(!alive(pid), `residual descendant ${pid} must not survive the settled child`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("windows tree kill is awaited, bounded, and fails closed", async () => {
  const { lifecycleInternals } = await import(pathToFileURL(checker).href);
  const { windowsTreeKill, TASKKILL_TIMEOUT_MS } = lifecycleInternals;
  assert.ok(Number.isFinite(TASKKILL_TIMEOUT_MS) && TASKKILL_TIMEOUT_MS >= 1000, "production taskkill bound must stay sane");

  const makeKiller = () => {
    const listeners = new Map();
    const killer = {
      killed: false,
      on(event, callback) {
        listeners.set(event, [...(listeners.get(event) ?? []), callback]);
        return killer;
      },
      kill() {
        killer.killed = true;
      },
      emit(event, value) {
        for (const callback of listeners.get(event) ?? []) callback(value);
      },
    };
    return killer;
  };

  // (a) A successful taskkill is awaited before settling; the fallback never runs.
  const awaitedKiller = makeKiller();
  let resolved = false;
  const pending = windowsTreeKill(
    4242,
    {
      kill() {
        throw new Error("direct-child fallback must not run after a confirmed taskkill");
      },
    },
    {
      spawnTaskkill: () => {
        setTimeout(() => awaitedKiller.emit("close", 0), 80);
        return awaitedKiller;
      },
      wait: async () => {},
      probeAlive: () => true,
    },
  ).then((outcome) => {
    resolved = true;
    return outcome;
  });
  await sleep(30);
  assert.equal(resolved, false, "taskkill completion must be awaited, not fire-and-forget");
  const confirmed = await pending;
  assert.equal(confirmed.confirmed, true);
  assert.match(confirmed.note, /taskkill/);
  assert.equal(awaitedKiller.killed, false, "no fallback kill after a confirmed taskkill");

  // (b) A hanging taskkill is bounded by the internal timeout; its child is killed.
  const hangingKiller = makeKiller();
  const started = Date.now();
  const bounded = await windowsTreeKill(
    4243,
    {
      kill() {},
    },
    {
      spawnTaskkill: () => hangingKiller,
      wait: async () => {},
      probeAlive: () => false,
      taskkillTimeoutMs: 60,
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `hung taskkill must be bounded, took ${elapsed}ms`);
  assert.equal(hangingKiller.killed, true, "the hung taskkill child must be terminated");
  assert.equal(bounded.confirmed, true, "root observed dead via the fallback");

  // (c) Fail closed: the root surviving both steps is never claimed clean.
  const survivor = await windowsTreeKill(
    4244,
    {
      kill() {},
    },
    {
      spawnTaskkill: () => {
        const killer = makeKiller();
        setTimeout(() => killer.emit("close", 1), 5);
        return killer;
      },
      wait: async () => {},
      probeAlive: () => true,
      taskkillTimeoutMs: 100,
    },
  );
  assert.equal(survivor.confirmed, false, "an unkillable root must fail closed");
  assert.match(survivor.note, /fail closed/);
});

test("legacy timeout lifecycle (settle on direct close) leaves the SIGTERM-ignoring descendant alive", async () => {
  const root = await createFixture("old-timeout-close", {
    "src/cli.js": MINIMAL_CLI,
    "src/hangterm.js": HANG_MODULE_TERM_COMPLIANT,
  });
  const scratch = await mkdtemp(path.join(os.tmpdir(), "skill-router-check-oldtimeout-"));
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(pathToFileURL(path.join(root, "src", "hangterm.js")).href)});\nprocess.exit(0);\n`,
    ],
    {
      cwd: scratch,
      env: { ...process.env, HOME: scratch, USERPROFILE: scratch, SKILL_ROUTER_HOME: scratch },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  try {
    let descendantPid = null;
    const deadline = Date.now() + 10000;
    while (descendantPid === null && Date.now() < deadline) {
      const match = stdout.match(/DESCENDANT_PID=(\d+)/);
      if (match) descendantPid = Number(match[1]);
      else await sleep(50);
    }
    assert.ok(descendantPid, `descendant pid must be reported: ${stdout}`);

    // The pre-fix lifecycle: the timeout SIGTERMs the direct child and the
    // run settles as soon as close fires, with no forced tree step.
    const closing = waitClose(child);
    child.kill("SIGTERM");
    assert.equal(await closing, "closed", "SIGTERM-compliant parent must close during the grace window");
    await sleep(400);
    assert.ok(alive(descendantPid), "pre-fix settle-on-close leaves the descendant alive");

    // The remediation's mechanism: the child's own process group carries it.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
    await waitForDeath(descendantPid);
    assert.ok(!alive(descendantPid), "group kill must terminate the descendant");
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});
