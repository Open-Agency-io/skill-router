import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { writeFakeClaudeBin } from "./fake-claude.js";
import { initOperation } from "../src/operations.js";
import { journaledTransactionInternals } from "../src/transaction.js";
import { after } from "node:test";

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repository, "src", "cli.js");

/**
 * Host-independent OpenCode capability: every CLI run inherits a fake
 * `opencode` that prints exactly one clean semantic version, so the bounded
 * capability probe resolves the same skills shape on every machine instead of
 * depending on whatever OpenCode happens to be installed.
 */
const openCodeProbeDirectory = await mkdtemp(path.join(os.tmpdir(), "skill-router-cli-opencode-probe-"));
const openCodeProbeBin = path.join(openCodeProbeDirectory, "opencode");
await writeFile(openCodeProbeBin, "#!/bin/sh\nprintf '%s\\n' '2.0.0'\n", { mode: 0o755 });
const previousOpenCodeBin = process.env.SKILL_ROUTER_OPENCODE_BIN;
process.env.SKILL_ROUTER_OPENCODE_BIN = openCodeProbeBin;
after(async () => {
  if (previousOpenCodeBin === undefined) delete process.env.SKILL_ROUTER_OPENCODE_BIN;
  else process.env.SKILL_ROUTER_OPENCODE_BIN = previousOpenCodeBin;
  await rm(openCodeProbeDirectory, { recursive: true, force: true });
});

function run(args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: environment.cwd ?? repository,
      env: { ...process.env, SKILL_ROUTER_HOME: environment.home, ...(environment.env ?? {}) },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("CLI exposes init, add, route, scan, and check as JSON workflows", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "skill-router-cli-"));
  const environment = {
    home: path.join(directory, "home"),
    root: path.join(directory, "project"),
    external: path.join(directory, "external"),
  };
  await mkdir(environment.home, { recursive: true });
  await mkdir(environment.root, { recursive: true });
  await mkdir(path.join(environment.external, "review"), { recursive: true });
  await writeFile(
    path.join(environment.external, "review", "SKILL.md"),
    "---\nname: Review\ndescription: Review code for correctness\n---\n\nReview it.\n",
  );

  try {
    const dryRun = await run(["init", "--root", environment.root, "--dry-run", "--json"], environment);
    assert.equal(dryRun.code, 0, dryRun.stderr);
    assert.equal(JSON.parse(dryRun.stdout).dryRun, true);
    await assert.rejects(() => access(path.join(environment.root, ".skill-router.json")), /ENOENT/);

    const initialized = await run(["init", "--root", environment.root, "--harness", "opencode", "--json"], environment);
    assert.equal(initialized.code, 0, initialized.stderr);
    assert.equal(JSON.parse(initialized.stdout).command, "init");

    const added = await run(
      [
        "add",
        "review",
        "--root",
        environment.root,
        "--source",
        environment.external,
        "--alias",
        "inspect change",
        "--description",
        "Inspect code changes",
        "--json",
      ],
      environment,
    );
    assert.equal(added.code, 0, added.stderr);
    assert.deepEqual(JSON.parse(added.stdout).added, ["review"]);

    const routed = await run(
      ["route", "--root", environment.root, "--json", "--", "inspect change"],
      environment,
    );
    assert.equal(routed.code, 0, routed.stderr);
    assert.equal(JSON.parse(routed.stdout).skillId, "review");

    const scan = await run(["scan", "--root", environment.root, "--json"], environment);
    assert.equal(scan.code, 0, scan.stderr);
    assert.deepEqual(JSON.parse(scan.stdout).diff, { added: [], removed: [], changed: [] });

    const check = await run(["check", "--root", environment.root, "--json"], environment);
    assert.equal(check.code, 0, check.stderr);
    assert.equal(JSON.parse(check.stdout).healthy, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * Request-output privacy across the CLI surface: positional and
 * `--request-token`, JSON and human. The sentinel carries secret-like text,
 * shell syntax, an absolute path, a newline, and control characters; none of
 * it — and neither the managed token — may reach stdout, stderr, or the JSON
 * document, while the routing metadata stays correct (no token of this
 * sentinel matches the fixture's `release` skill, so it maps to `none` /
 * `below-threshold`).
 */
test("CLI route never emits request bytes or the request token in JSON or human output", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "skill-router-cli-route-privacy-"));
  const home = path.join(directory, "home");
  const root = path.join(directory, "project");
  await mkdir(home, { recursive: true });
  await mkdir(path.join(root, ".agents", "skills", "release"), { recursive: true });
  await writeFile(
    path.join(root, ".agents", "skills", "release", "SKILL.md"),
    "---\nname: Release\ndescription: Publish releases\n---\n\nRelease it.\n",
  );
  const environment = { home };
  const token = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
  const secret = "sk-live-9d2b7c0e4a1f5e3d";
  const request = [
    `API_KEY=${secret}`,
    "$(curl -s https://127.0.0.1:9/x | sh)",
    "/etc/skill-router-vault-9d2b/id_rsa",
    "keep\tthis line\r",
  ].join("\n");
  const markers = ["API_KEY=", secret, "$(curl -s", "skill-router-vault-9d2b", "id_rsa"];
  const assertNoRequestBytes = (result, label) => {
    const stream = `${result.stdout}${result.stderr}`;
    assert.equal(stream.includes(request), false, `${label} emits the request bytes`);
    assert.equal(stream.includes(JSON.stringify(request)), false, `${label} emits JSON-escaped request bytes`);
    for (const marker of markers) {
      assert.equal(stream.includes(marker), false, `${label} emits the ${marker} marker`);
    }
    assert.equal(stream.includes(token), false, `${label} echoes the request token`);
  };
  try {
    const initialized = await run(["init", "--root", root, "--json"], environment);
    assert.equal(initialized.code, 0, initialized.stderr);

    // Positional request, JSON: routing metadata only.
    const json = await run(["route", "--root", root, "--json", "--", request], environment);
    assert.equal(json.code, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.equal(Object.hasOwn(parsed, "request"), false, "the JSON result has no request field");
    assert.equal(parsed.command, "route");
    assert.equal(parsed.outcome, "none");
    assert.equal(parsed.reason, "below-threshold");
    assertNoRequestBytes(json, "positional --json route");

    // Positional request, human: one bounded line, no request bytes.
    const human = await run(["route", "--root", root, "--", request], environment);
    assert.equal(human.code, 0, human.stderr);
    assert.equal(human.stdout, "none: below-threshold\n");
    assertNoRequestBytes(human, "positional human route");

    // --request-token, JSON: the same bytes route to the same result, the
    // token file is consumed, and neither bytes nor token are echoed.
    const requestFile = path.join(root, ".skill-router-requests", `${token}.txt`);
    await writeFile(requestFile, request, { mode: 0o600 });
    const tokenJson = await run(["route", "--root", root, "--json", "--request-token", token], environment);
    assert.equal(tokenJson.code, 0, tokenJson.stderr);
    const tokenParsed = JSON.parse(tokenJson.stdout);
    assert.equal(Object.hasOwn(tokenParsed, "request"), false, "the token JSON result has no request field");
    assert.deepEqual(tokenParsed, parsed, "both transports route the same bytes to the same result");
    assert.equal(existsSync(requestFile), false, "the token file is consumed");
    assertNoRequestBytes(tokenJson, "request-token --json route");

    // --request-token, human.
    await writeFile(requestFile, request, { mode: 0o600 });
    const tokenHuman = await run(["route", "--root", root, "--request-token", token], environment);
    assert.equal(tokenHuman.code, 0, tokenHuman.stderr);
    assert.equal(tokenHuman.stdout, "none: below-threshold\n");
    assert.equal(existsSync(requestFile), false, "the token file is consumed");
    assertNoRequestBytes(tokenHuman, "request-token human route");

    // A pending journal refuses before the request is read: the token file is
    // untouched and the generic refusal carries no request bytes or token.
    await writeFile(requestFile, request, { mode: 0o600 });
    const previousStep = journaledTransactionInternals.onStep;
    journaledTransactionInternals.onStep = async (name) => {
      if (name === "stage:build" || name === "recovery:files") throw new Error(`stop at ${name}`);
    };
    const previousHome = process.env.SKILL_ROUTER_HOME;
    process.env.SKILL_ROUTER_HOME = home;
    try {
      await initOperation({ root }).catch(() => {});
    } finally {
      journaledTransactionInternals.onStep = previousStep;
      if (previousHome === undefined) delete process.env.SKILL_ROUTER_HOME;
      else process.env.SKILL_ROUTER_HOME = previousHome;
    }
    assert.ok(existsSync(path.join(root, ".skill-router-control", "transaction.json")), "journal seeded");
    const pending = await run(["route", "--root", root, "--json", "--request-token", token], environment);
    assert.equal(pending.code, 1, pending.stderr);
    assert.match(pending.stderr, /must be recovered before this command can run/);
    assert.equal(await readFile(requestFile, "utf8"), request, "the refusal leaves the token file untouched");
    assertNoRequestBytes(pending, "pending-journal route refusal");

    // A malformed token is refused generically without echoing its value.
    const invalid = await run(["route", "--root", root, "--request-token", `sk-${secret}`], environment);
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /--request-token must be exactly 32 lowercase hexadecimal characters/);
    assert.equal(invalid.stdout.includes(secret), false, "the refusal does not echo the token value");
    assert.equal(invalid.stderr.includes(secret), false, "the refusal does not echo the token value");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI rejects conflicting scope and unknown commands", async () => {
  const environment = { home: os.tmpdir() };
  const conflict = await run(["init", "--global", "--project"], environment);
  assert.equal(conflict.code, 1);
  assert.match(conflict.stderr, /either --global or --project/);
  const unknown = await run(["unknown"], environment);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown command/);
  const invalidOption = await run(["check", "--dry-run"], environment);
  assert.equal(invalidOption.code, 1);
  assert.match(invalidOption.stderr, /not valid for check/);
});

test("CLI validates harness selections and keeps --all as a legacy alias", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "skill-router-cli-harness-"));
  const environment = { home: path.join(directory, "home"), root: path.join(directory, "project") };
  await mkdir(environment.home, { recursive: true });
  await mkdir(environment.root, { recursive: true });
  try {
    const invalid = await run(["init", "--root", environment.root, "--harness", "codex"], environment);
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /Unsupported harness: codex/);

    const dry = await run(["init", "--root", environment.root, "--harness", "all", "--dry-run", "--json"], environment);
    assert.equal(dry.code, 0, dry.stderr);
    const planned = JSON.parse(dry.stdout);
    assert.equal(planned.dryRun, true);
    assert.deepEqual(planned.harnesses, ["opencode", "claude"]);
    assert.equal(planned.claude.plugin, "openagency-skill-router");
    assert.equal(planned.claude.scope, "local");
    await assert.rejects(() => access(path.join(environment.root, ".skill-router")), /ENOENT/);

    const legacy = await run(["init", "--root", environment.root, "--all", "--dry-run", "--json"], environment);
    assert.equal(legacy.code, 0, legacy.stderr);
    assert.deepEqual(JSON.parse(legacy.stdout).harnesses, ["opencode", "claude"]);

    const claudeOnly = await run(
      ["init", "--root", environment.root, "--harness", "claude", "--dry-run", "--json"],
      environment,
    );
    assert.equal(claudeOnly.code, 0, claudeOnly.stderr);
    assert.deepEqual(JSON.parse(claudeOnly.stdout).harnesses, ["claude"]);

    const human = await run(["init", "--root", environment.root, "--harness", "claude", "--dry-run"], environment);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /integrations: claude/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI registers and verifies a Claude plugin through SKILL_ROUTER_CLAUDE_BIN", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "skill-router-cli-claude-"));
  const home = path.join(directory, "home");
  const root = path.join(directory, "project");
  const other = path.join(directory, "other");
  await mkdir(home, { recursive: true });
  await mkdir(other, { recursive: true });
  await mkdir(path.join(root, ".agents", "skills", "release"), { recursive: true });
  await writeFile(
    path.join(root, ".agents", "skills", "release", "SKILL.md"),
    "---\nname: Release\ndescription: Publish a release\n---\n\nRelease instructions.\n",
  );
  const fake = await writeFakeClaudeBin(path.join(directory, "fake-claude"));
  const logFile = path.join(directory, "claude-invocations.log");
  const environment = {
    home,
    env: {
      SKILL_ROUTER_CLAUDE_BIN: fake.bin,
      FAKE_CLAUDE_STATE: fake.stateFile,
      FAKE_CLAUDE_LOG: logFile,
    },
  };
  try {
    const initialized = await run(["init", "--root", root, "--harness", "all", "--json"], environment);
    assert.equal(initialized.code, 0, initialized.stderr);
    const init = JSON.parse(initialized.stdout);
    assert.deepEqual(init.harnesses, ["opencode", "claude"]);
    assert.equal(init.claude.scope, "local");

    const fakeState = JSON.parse(await readFile(fake.stateFile, "utf8"));
    assert.equal(fakeState.plugins.length, 1);
    assert.match(fakeState.plugins[0].id, /^openagency-skill-router@skill-router-[0-9a-f]{24}$/);
    assert.equal(fakeState.plugins[0].scope, "local");
    assert.equal(fakeState.marketplaces.length, 1);

    const checked = await run(["check", "--root", root, "--json"], environment);
    assert.equal(checked.code, 0, checked.stderr);
    assert.equal(JSON.parse(checked.stdout).healthy, true, checked.stdout);

    // Every spawn above runs with the caller cwd = the repository while
    // `--root` points at the project: each Claude command must still execute
    // with cwd = the router root, and the local registration must land there.
    const realRoot = realpathSync(root);
    const invocations = (await readFile(logFile, "utf8")).trim().split("\n").filter(Boolean);
    assert.ok(invocations.length > 0, "the fake CLI recorded invocations");
    for (const invocation of invocations) {
      assert.ok(
        invocation.endsWith(` cwd=${realRoot}`),
        `a Claude command ran outside the router root: ${invocation}`,
      );
      assert.ok(!invocation.includes(`cwd=${repository}`), "no command runs in the caller's cwd");
    }
    const marketplaceName = init.claude.marketplace;
    const declaration = JSON.parse(
      await readFile(path.join(root, ".claude", "settings.local.json"), "utf8"),
    );
    assert.equal(
      declaration.extraKnownMarketplaces?.[marketplaceName]?.source?.path,
      init.claude.marketplaceDirectory,
      "the scope-owned declaration lives under --root",
    );
    const callerDeclaration = path.join(repository, ".claude", "settings.local.json");
    if (existsSync(callerDeclaration)) {
      const caller = JSON.parse(await readFile(callerDeclaration, "utf8"));
      assert.equal(
        caller.extraKnownMarketplaces?.[marketplaceName],
        undefined,
        "the caller's cwd never gains a declaration",
      );
    }

    const scanned = await run(["scan", "--root", root, "--json"], environment);
    assert.equal(scanned.code, 0, scanned.stderr);
    assert.equal(JSON.parse(scanned.stdout).diff.added.length, 0);

    const before = await readFile(logFile, "utf8");
    const otherRun = await run(["init", "--root", other, "--json"], environment);
    assert.equal(otherRun.code, 0, otherRun.stderr);
    assert.deepEqual(JSON.parse(otherRun.stdout).harnesses, ["opencode"]);
    const after = await readFile(logFile, "utf8");
    assert.equal(after, before, "OpenCode-only CLI work must not invoke the Claude CLI");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI resolves the initialized ancestor from a nested cwd and from a nested --root", async () => {
  // The temp root is realpath-normalized once so `--root` values and cwd-derived
  // roots spell the same path (the resolver deliberately does not realpath).
  const directory = realpathSync(await mkdtemp(path.join(os.tmpdir(), "skill-router-cli-root-")));
  const home = path.join(directory, "home");
  const project = path.join(directory, "project");
  const nested = path.join(project, "sub", "deep");
  await mkdir(home, { recursive: true });
  await mkdir(nested, { recursive: true });
  await mkdir(path.join(project, ".agents", "skills", "release"), { recursive: true });
  await writeFile(
    path.join(project, ".agents", "skills", "release", "SKILL.md"),
    "---\nname: Release\ndescription: Publish releases\n---\n\nRelease instructions.\n",
  );
  const environment = { home };
  const fromNested = { home, cwd: nested };
  const exists = async (target) => {
    try {
      await access(target);
      return true;
    } catch {
      return false;
    }
  };
  try {
    const initialized = await run(["init", "--root", project, "--json"], environment);
    assert.equal(initialized.code, 0, initialized.stderr);
    assert.equal(JSON.parse(initialized.stdout).root, project);

    // Nested cwd without --root: every command resolves the ancestor install.
    const checked = await run(["check", "--json"], fromNested);
    assert.equal(checked.code, 0, checked.stderr);
    assert.equal(JSON.parse(checked.stdout).healthy, true);
    assert.equal(JSON.parse(checked.stdout).root, project, "cwd-only invocation resolves the ancestor root");
    const routed = await run(["route", "--json", "--", "publish releases"], fromNested);
    assert.equal(routed.code, 0, routed.stderr);
    assert.equal(JSON.parse(routed.stdout).skillId, "release");

    // --root pointing at the nested directory still resolves the ancestor.
    const nestedRootInit = await run(["init", "--root", nested, "--json"], fromNested);
    assert.equal(nestedRootInit.code, 0, nestedRootInit.stderr);
    const nestedRootPlan = JSON.parse(nestedRootInit.stdout);
    assert.equal(nestedRootPlan.root, project, "--root nested resolves the ancestor root");
    assert.equal(nestedRootPlan.configFile, path.join(project, ".skill-router.json"));
    assert.deepEqual(nestedRootPlan.harnesses, ["opencode"], "the ancestor install stays additive and OpenCode-only");

    // No --root at all from the nested cwd behaves the same way.
    const cwdInit = await run(["init", "--json"], fromNested);
    assert.equal(cwdInit.code, 0, cwdInit.stderr);
    assert.equal(JSON.parse(cwdInit.stdout).root, project);

    // Nothing shadowed the project under the nested directory.
    for (const shadow of [".skill-router", ".skill-router.json", ".opencode"]) {
      assert.equal(await exists(path.join(nested, shadow)), false, `no nested ${shadow} surface is created`);
    }
    assert.equal(await exists(path.join(project, ".skill-router", "registry.json")), true, "ancestor state is intact");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI exposes uninstall as JSON, human, and dry-run output", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "skill-router-cli-uninstall-"));
  const home = path.join(directory, "home");
  const root = path.join(directory, "project");
  await mkdir(home, { recursive: true });
  await mkdir(path.join(root, ".agents", "skills", "release"), { recursive: true });
  await writeFile(
    path.join(root, ".agents", "skills", "release", "SKILL.md"),
    "---\nname: Release\ndescription: Publish a release\n---\n\nRelease instructions.\n",
  );
  const environment = { home };
  try {
    const help = await run(["--help"], environment);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /skill-router uninstall \[--dry-run\] \[--json\]/);

    const initialized = await run(["init", "--root", root, "--json"], environment);
    assert.equal(initialized.code, 0, initialized.stderr);
    const routerConfig = path.join(root, ".skill-router.json");
    const configBefore = await readFile(routerConfig, "utf8");

    const dry = await run(["uninstall", "--root", root, "--dry-run", "--json"], environment);
    assert.equal(dry.code, 0, dry.stderr);
    const dryResult = JSON.parse(dry.stdout);
    assert.equal(dryResult.command, "uninstall");
    assert.equal(dryResult.status, "would-remove");
    assert.equal(dryResult.dryRun, true);
    assert.equal(dryResult.configPreserved, true);
    assert.equal(dryResult.requestSpool, "would-remove", "the dry run reports the spool plan");
    assert.deepEqual(dryResult.harnesses, ["opencode"]);
    assert.equal(dryResult.opencode.status, "would-detach");
    assert.ok(existsSync(path.join(root, ".skill-router")), "dry-run keeps the state directory");
    assert.ok(existsSync(path.join(root, ".skill-router-requests")), "dry-run keeps the request spool");

    const removed = await run(["uninstall", "--root", root, "--json"], environment);
    assert.equal(removed.code, 0, removed.stderr);
    const removedResult = JSON.parse(removed.stdout);
    assert.equal(removedResult.status, "removed");
    assert.equal(removedResult.requestSpool, "removed", "the empty spool is removed with the installation");
    assert.equal(removedResult.root, root);
    assert.equal(removedResult.scope, "project");
    assert.equal(removedResult.opencode.status, "detached");
    assert.equal(await readFile(routerConfig, "utf8"), configBefore, "the router configuration is preserved");
    assert.equal(existsSync(path.join(root, ".skill-router")), false, "the owned state is removed");
    assert.equal(existsSync(path.join(root, ".skill-router-requests")), false, "the empty spool is removed");
    assert.equal(existsSync(path.join(root, ".opencode", "opencode.json")), true, "the OpenCode configuration is retained");

    const human = await run(["uninstall", "--root", root], environment);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /^uninstall: already absent/m);
    assert.match(human.stdout, /^state: /m);
    assert.match(human.stdout, /^config preserved: /m);
    assert.equal(human.stdout.includes(".skill-router-requests"), false, "human output never echoes the spool path");

    const removedHuman = await run(["init", "--root", root, "--json"], environment);
    assert.equal(removedHuman.code, 0, removedHuman.stderr);
    const secondHuman = await run(["uninstall", "--root", root], environment);
    assert.equal(secondHuman.code, 0, secondHuman.stderr);
    assert.match(secondHuman.stdout, /^uninstall: removed/m);
    assert.match(secondHuman.stdout, /^harnesses: opencode$/m);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI rejects uninstall positionals, harness selections, and other invalid options", async () => {
  const environment = { home: os.tmpdir() };
  const positional = await run(["uninstall", "everything"], environment);
  assert.equal(positional.code, 1);
  assert.match(positional.stderr, /uninstall does not accept positional arguments/);

  const harness = await run(["uninstall", "--harness", "all"], environment);
  assert.equal(harness.code, 1);
  assert.match(harness.stderr, /--harness is not valid for uninstall/);

  const replace = await run(["uninstall", "--replace"], environment);
  assert.equal(replace.code, 1);
  assert.match(replace.stderr, /--replace is not valid for uninstall/);

  const token = await run(["uninstall", "--request-token", "0123456789abcdef0123456789abcdef"], environment);
  assert.equal(token.code, 1);
  assert.match(token.stderr, /--request-token is not valid for uninstall/);

  const unknown = await run(["uninstall", "--nope"], environment);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown option: --nope/);
});

test("CLI uninstall refuses a manual JSONC configuration before touching Claude", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "skill-router-cli-uninstall-manual-"));
  const home = path.join(directory, "home");
  const root = path.join(directory, "project");
  await mkdir(home, { recursive: true });
  await mkdir(path.join(root, ".agents", "skills", "release"), { recursive: true });
  await writeFile(
    path.join(root, ".agents", "skills", "release", "SKILL.md"),
    "---\nname: Release\ndescription: Publish a release\n---\n\nRelease instructions.\n",
  );
  const fake = await writeFakeClaudeBin(path.join(directory, "fake-claude"));
  const logFile = path.join(directory, "claude-invocations.log");
  const environment = {
    home,
    env: {
      SKILL_ROUTER_CLAUDE_BIN: fake.bin,
      FAKE_CLAUDE_STATE: fake.stateFile,
      FAKE_CLAUDE_LOG: logFile,
    },
  };
  try {
    const initialized = await run(["init", "--root", root, "--harness", "all", "--json"], environment);
    assert.equal(initialized.code, 0, initialized.stderr);
    const managed = path.join(root, ".skill-router", "opencode-skills");
    const openCodeFile = path.join(root, ".opencode", "opencode.json");
    const jsonc = `{\n  // keep this comment\n  "skills": { "paths": [${JSON.stringify(managed)}] },\n}\n`;
    await writeFile(openCodeFile, jsonc);
    const before = await readFile(logFile, "utf8");

    const refused = await run(["uninstall", "--root", root, "--json"], environment);
    assert.equal(refused.code, 1, refused.stderr);
    assert.match(refused.stderr, /Manual change required before uninstall/);
    assert.match(refused.stderr, /skills\.paths array/);
    assert.match(refused.stderr, new RegExp(managed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(await readFile(logFile, "utf8"), before, "no Claude command runs for a manual refusal");
    assert.equal(await readFile(openCodeFile, "utf8"), jsonc, "JSONC is never rewritten");
    assert.equal(existsSync(path.join(root, ".skill-router")), true, "the state survives the refusal");

    const human = await run(["uninstall", "--root", root], environment);
    assert.equal(human.code, 1);
    assert.match(human.stderr, /Manual change required before uninstall/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI uninstall detaches a dual installation at the router root", async () => {
  const directory = realpathSync(await mkdtemp(path.join(os.tmpdir(), "skill-router-cli-uninstall-claude-")));
  const home = path.join(directory, "home");
  const root = path.join(directory, "project");
  await mkdir(home, { recursive: true });
  await mkdir(path.join(root, ".agents", "skills", "release"), { recursive: true });
  await writeFile(
    path.join(root, ".agents", "skills", "release", "SKILL.md"),
    "---\nname: Release\ndescription: Publish a release\n---\n\nRelease instructions.\n",
  );
  const fake = await writeFakeClaudeBin(path.join(directory, "fake-claude"));
  const logFile = path.join(directory, "claude-invocations.log");
  const environment = {
    home,
    cwd: directory,
    env: {
      SKILL_ROUTER_CLAUDE_BIN: fake.bin,
      FAKE_CLAUDE_STATE: fake.stateFile,
      FAKE_CLAUDE_LOG: logFile,
    },
  };
  try {
    const initialized = await run(["init", "--root", root, "--harness", "all", "--json"], environment);
    assert.equal(initialized.code, 0, initialized.stderr);
    const init = JSON.parse(initialized.stdout);
    const routerConfig = path.join(root, ".skill-router.json");
    const configBefore = await readFile(routerConfig, "utf8");
    await writeFile(logFile, "");

    const removed = await run(["uninstall", "--root", root, "--json"], environment);
    assert.equal(removed.code, 0, removed.stderr);
    const result = JSON.parse(removed.stdout);
    assert.equal(result.status, "removed");
    assert.deepEqual(result.harnesses, ["opencode", "claude"]);
    assert.equal(result.claude.status, "detached");
    assert.equal(result.claude.classification, "healthy");
    assert.equal(result.claude.marketplace, init.claude.marketplace);
    assert.equal(existsSync(path.join(root, ".skill-router")), false, "the owned state is removed");
    assert.equal(await readFile(routerConfig, "utf8"), configBefore, "the router configuration is preserved");

    const fakeState = JSON.parse(await readFile(fake.stateFile, "utf8"));
    assert.deepEqual(fakeState.plugins, [], "the exact plugin reference is uninstalled");
    assert.deepEqual(fakeState.marketplaces, [], "the exact scope-owned marketplace is removed");
    const declaration = JSON.parse(await readFile(path.join(root, ".claude", "settings.local.json"), "utf8"));
    assert.equal(declaration.extraKnownMarketplaces?.[init.claude.marketplace], undefined);

    const invocations = (await readFile(logFile, "utf8")).trim().split("\n").filter(Boolean);
    assert.ok(invocations.length > 0, "the fake CLI recorded the uninstall");
    for (const invocation of invocations) {
      assert.ok(invocation.endsWith(` cwd=${root}`), `a Claude command ran outside the router root: ${invocation}`);
      assert.ok(!invocation.endsWith(`cwd=${directory}`), "no command runs in the caller's cwd");
    }

    const again = await run(["uninstall", "--root", root, "--json"], environment);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).status, "already-absent");
    const repeatInvocations = (await readFile(logFile, "utf8")).trim().split("\n").filter(Boolean);
    assert.deepEqual(repeatInvocations, invocations, "an already-absent uninstall never probes Claude");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI refuses a router configuration inside router-owned state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "skill-router-cli-config-in-state-"));
  const home = path.join(directory, "home");
  const root = path.join(directory, "project");
  await mkdir(home, { recursive: true });
  await mkdir(path.join(root, ".agents", "skills", "release"), { recursive: true });
  await writeFile(
    path.join(root, ".agents", "skills", "release", "SKILL.md"),
    "---\nname: Release\ndescription: Publish a release\n---\n\nRelease instructions.\n",
  );
  const environment = { home };
  try {
    const refused = await run(
      ["init", "--root", root, "--config", ".skill-router/router.json", "--json"],
      environment,
    );
    assert.equal(refused.code, 1, refused.stderr);
    assert.match(refused.stderr, /is inside/);
    assert.match(refused.stderr, /Copy the configuration file outside the router-owned state directory and retry/);
    assert.equal(existsSync(path.join(root, ".skill-router")), false, "nothing is written before the refusal");
    assert.equal(existsSync(path.join(root, ".skill-router.json")), false);

    const initialized = await run(["init", "--root", root, "--json"], environment);
    assert.equal(initialized.code, 0, initialized.stderr);
    const installationBefore = await readFile(path.join(root, ".skill-router", "installation.json"), "utf8");

    const blocked = await run(
      ["uninstall", "--root", root, "--config", ".skill-router/router.json", "--json"],
      environment,
    );
    assert.equal(blocked.code, 1, blocked.stderr);
    assert.match(blocked.stderr, /Copy the configuration file outside the router-owned state directory and retry/);
    assert.equal(
      await readFile(path.join(root, ".skill-router", "installation.json"), "utf8"),
      installationBefore,
      "uninstall refuses before touching ownership",
    );

    const removed = await run(["uninstall", "--root", root, "--json"], environment);
    assert.equal(removed.code, 0, removed.stderr);
    assert.equal(JSON.parse(removed.stdout).status, "removed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI recover reports clean and recovered outcomes and validates its own flags", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "skill-router-cli-recover-"));
  const home = path.join(directory, "home");
  const root = path.join(directory, "project");
  await mkdir(home, { recursive: true });
  await mkdir(path.join(root, ".agents", "skills", "release"), { recursive: true });
  await writeFile(
    path.join(root, ".agents", "skills", "release", "SKILL.md"),
    "---\nname: Release\ndescription: Publish releases\n---\n\nRelease it.\n",
  );
  const environment = { home };
  try {
    // Nothing pending: the JSON contract is exactly {command, status}.
    const clean = await run(["recover", "--root", root, "--json"], environment);
    assert.equal(clean.code, 0, clean.stderr);
    assert.deepEqual(JSON.parse(clean.stdout), { command: "recover", status: "clean" });
    const cleanControl = path.join(root, ".skill-router-control");
    assert.equal(existsSync(cleanControl), true, "a clean recover leaves its inert control directory");
    assert.deepEqual(await readdir(cleanControl), [], "the preserved control directory is empty");
    if (process.platform !== "win32") {
      assert.equal((await stat(cleanControl)).mode & 0o777, 0o700, "the preserved control directory is owner-private");
    }

    // Seed a real pending journal through the public init wrapper.
    const previous = journaledTransactionInternals.onStep;
    journaledTransactionInternals.onStep = async (name) => {
      if (name === "file-write" || name === "recovery:files") throw new Error(`stop at ${name}`);
    };
    try {
      await initOperation({ root }).catch(() => {});
    } finally {
      journaledTransactionInternals.onStep = previous;
    }
    assert.ok(existsSync(path.join(root, ".skill-router-control", "transaction.json")), "journal seeded");

    // Human output names the recovered transaction and its outcome...
    const recovered = await run(["recover", "--root", root], environment);
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.match(recovered.stdout, /recover: recovered managed [0-9a-f]{64}/);
    assert.match(recovered.stdout, /outcome: rolled-back/);

    // ...and the JSON contract is stable on the repeat run.
    const second = await run(["recover", "--root", root, "--json"], environment);
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout), { command: "recover", status: "clean" }, "recovery is repeatable");
    const human = await run(["recover", "--root", root], environment);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /recover: clean/);

    // recover takes scope/root/config and --lock-timeout, nothing else.
    const dry = await run(["recover", "--root", root, "--dry-run"], environment);
    assert.equal(dry.code, 1);
    assert.match(dry.stderr, /--dry-run is not valid for recover/);
    const harness = await run(["recover", "--root", root, "--harness", "all"], environment);
    assert.equal(harness.code, 1);
    assert.match(harness.stderr, /--harness is not valid for recover/);
    const positional = await run(["recover", "--root", root, "extra"], environment);
    assert.equal(positional.code, 1);
    assert.match(positional.stderr, /recover does not accept positional arguments/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI validates --lock-timeout as a strict integer in range for every command", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "skill-router-cli-lock-"));
  const home = path.join(directory, "home");
  const root = path.join(directory, "project");
  await mkdir(home, { recursive: true });
  await mkdir(root, { recursive: true });
  const environment = { home };
  try {
    for (const bad of ["abc", "-1", "1.5", "300001", "1e3", ""]) {
      const result = await run(["recover", "--root", root, "--lock-timeout", bad], environment);
      assert.equal(result.code, 1, `--lock-timeout ${JSON.stringify(bad)} is rejected`);
      assert.match(result.stderr, /--lock-timeout must be an integer between 0 and 300000/);
    }
    const missing = await run(["recover", "--root", root, "--lock-timeout"], environment);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /--lock-timeout requires a value/);

    // Accepted values reach every command, including the read commands.
    const accepted = await run(["recover", "--root", root, "--lock-timeout", "0", "--json"], environment);
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.equal(JSON.parse(accepted.stdout).status, "clean");
    const check = await run(["check", "--root", root, "--lock-timeout", "250", "--json"], environment);
    assert.equal(check.stderr, "", "the accepted value produces no usage error");
    assert.equal(JSON.parse(check.stdout).command, "check");
    assert.equal(JSON.parse(check.stdout).healthy, false, "an uninitialized directory is unhealthy (exit 1)");
    const help = await run(["--help"], environment);
    assert.match(help.stdout, /skill-router recover/);
    assert.match(help.stdout, /--lock-timeout/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI check never echoes a legacy request token, path, bytes, or hash", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "skill-router-cli-"));
  const home = path.join(directory, "home");
  const root = path.join(directory, "project");
  await mkdir(home, { recursive: true });
  await mkdir(root, { recursive: true });
  const environment = { home, cwd: root };
  const token = "0123456789abcdef0123456789abcdef";
  const requestBytes = "legacy CLI sentinel request\n";
  const requestHash = createHash("sha256").update(requestBytes).digest("hex");
  try {
    await mkdir(path.join(root, ".agents", "skills", "release"), { recursive: true });
    await writeFile(
      path.join(root, ".agents", "skills", "release", "SKILL.md"),
      "---\nname: Release\ndescription: Publish releases\n---\n\nRelease instructions.\n",
    );
    const initialized = await run(["init", "--root", root, "--harness", "opencode", "--json"], environment);
    assert.equal(initialized.code, 0, initialized.stderr);

    // A legacy request file under router state, broad-mode: the confidentiality
    // sample path for it *is* `requests/<token>.txt`, so any path in the
    // diagnostic would echo the token.
    const legacy = path.join(root, ".skill-router", "requests");
    await mkdir(legacy, { recursive: true, mode: 0o700 });
    await writeFile(path.join(legacy, `${token}.txt`), requestBytes, { mode: 0o644 });

    const leakScan = (stream, label) => {
      assert.equal(stream.includes(token), false, `${label} must not carry the token`);
      assert.equal(stream.includes(`requests/${token}.txt`), false, `${label} must not carry the request path`);
      assert.equal(stream.includes(requestBytes.trim()), false, `${label} must not carry request bytes`);
      assert.equal(stream.includes(requestHash), false, `${label} must not carry the request hash`);
    };

    // JSON output: unhealthy, with the code, and no request material.
    const json = await run(["check", "--root", root, "--json"], environment);
    assert.equal(json.code, 1, "an unhealthy check exits 1");
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.healthy, false);
    assert.ok(
      payload.diagnostics.some((item) => item.code === "state-confidentiality-invalid"),
      "the confidentiality code is reported",
    );
    assert.ok(
      payload.diagnostics.some((item) => item.code === "legacy-requests-pending"),
      "the pending legacy request is reported",
    );
    leakScan(json.stdout, "check --json stdout");
    leakScan(json.stderr, "check --json stderr");

    // Human output: unhealthy status plus the same path-free message.
    const human = await run(["check", "--root", root], environment);
    assert.equal(human.code, 1);
    assert.ok(human.stdout.includes("Skill Router has errors"));
    assert.ok(human.stdout.includes("not owner-private"), "the confidentiality rule is stated");
    assert.ok(human.stdout.includes("(issues: "), "only allowlisted issue codes are named");
    leakScan(human.stdout, "check stdout");
    leakScan(human.stderr, "check stderr");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * Phase 8 CLI surface: a poisoned installed registry or an invalid `add`
 * target produces bounded, control-free diagnostics in JSON and human output,
 * never echoing the hostile identifier, an outside path, or a control
 * sequence, and `check` reports exactly one `registry-invalid-id`.
 */
test("CLI check, route, and add report bounded identifier refusals without echoing hostile input", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "skill-router-cli-ids-"));
  const home = path.join(directory, "home");
  const root = path.join(directory, "project");
  await mkdir(home, { recursive: true });
  await mkdir(root, { recursive: true });
  const environment = { home, cwd: root };
  const huge = "x".repeat(100_000);
  const controlName = "claude\u0001\u001b[31m";
  try {
    await mkdir(path.join(root, ".agents", "skills", "release"), { recursive: true });
    await writeFile(
      path.join(root, ".agents", "skills", "release", "SKILL.md"),
      "---\nname: Release\ndescription: Publish releases\n---\n\nRelease instructions.\n",
    );
    const initialized = await run(["init", "--root", root, "--harness", "opencode", "--json"], environment);
    assert.equal(initialized.code, 0, initialized.stderr);

    const registryFile = path.join(root, ".skill-router", "registry.json");
    const installed = JSON.parse(await readFile(registryFile, "utf8"));
    await writeFile(
      registryFile,
      `${JSON.stringify(
        {
          ...installed,
          skills: [
            ...installed.skills,
            { id: "../../outside/sentinel", enabled: true },
            { id: huge, enabled: true },
            { id: controlName, enabled: true },
            { id: "skill-router", enabled: true },
          ],
          workflows: [{ id: "poison-flow", steps: [{ skill: "../../../../sentinel" }] }],
        },
        null,
        2,
      )}\n`,
    );

    const hostile = (stream, label) => {
      assert.equal(stream.includes("sentinel"), false, `${label} leaks a poisoned ID`);
      assert.equal(stream.includes(huge.slice(0, 80)), false, `${label} leaks the huge ID`);
      assert.equal(stream.includes("\u0001"), false, `${label} leaks a control character`);
      assert.equal(stream.includes("[31m"), false, `${label} leaks an escape sequence`);
      // Newlines and carriage returns format the output; no other control
      // byte may ever appear.
      assert.equal(/[\u0000-\u0009\u000b-\u001f\u007f]/.test(stream), false, `${label} carries raw control bytes`);
      assert.ok(stream.length < 20_000, `${label} stays bounded`);
    };

    const json = await run(["check", "--root", root, "--json"], environment);
    assert.equal(json.code, 1, "an unhealthy check exits 1");
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.healthy, false);
    assert.equal(payload.diagnostics.filter((item) => item.code === "registry-invalid-id").length, 1);
    assert.equal(payload.diagnostics.some((item) => item.code === "managed-skill-invalid"), false);
    hostile(json.stdout, "check --json stdout");
    hostile(json.stderr, "check --json stderr");

    const human = await run(["check", "--root", root], environment);
    assert.equal(human.code, 1);
    assert.ok(human.stdout.includes("Skill Router has errors"));
    assert.ok(human.stdout.includes("invalid skill or workflow IDs"));
    hostile(human.stdout, "check stdout");
    hostile(human.stderr, "check stderr");

    const routed = await run(["route", "--root", root, "--json", "--", "release"], environment);
    assert.equal(routed.code, 1);
    assert.match(routed.stderr, /invalid skill or workflow IDs/);
    hostile(routed.stdout, "route --json stdout");
    hostile(routed.stderr, "route --json stderr");

    // Invalid `add` targets: the fixed refusals, in JSON-spawned stderr.
    for (const target of ["../evil", huge, controlName]) {
      const added = await run(["add", target, "--root", root, "--json"], environment);
      assert.equal(added.code, 1);
      assert.match(added.stderr, /Add target is neither an existing local path nor a valid public skill ID/);
      hostile(added.stdout, `add ${target.length} stdout`);
      hostile(added.stderr, `add ${target.length} stderr`);
    }

    // An invalid discovery candidate refuses init with the same bounded rules.
    await mkdir(path.join(root, ".agents", "skills", "Bad Name"), { recursive: true });
    await writeFile(
      path.join(root, ".agents", "skills", "Bad Name", "SKILL.md"),
      "---\nname: Bad\ndescription: Invalid ID\n---\n\nBody.\n",
    );
    const refused = await run(["init", "--root", root, "--harness", "opencode", "--json"], environment);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /derived skill ID is not a portable public ID \(reason: grammar\)/);
    hostile(refused.stdout, "refused init stdout");
    hostile(refused.stderr, "refused init stderr");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * Blocker 1 CLI surface: a terminal-control filename whose body is also
 * malformed must never leak through spawned JSON or human output — no raw
 * control byte, no malformed ID, no absolute source path, no raw parser or
 * errno text, and bounded output on every command that touches discovery.
 */
test("CLI never leaks a hostile invalid candidate through init, scan, add, or check", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "skill-router-cli-hostile-"));
  const home = path.join(directory, "home");
  const root = path.join(directory, "project");
  await mkdir(home, { recursive: true });
  await mkdir(root, { recursive: true });
  const environment = { home, cwd: root };
  const hostileId = "evil\u0001\u001b[31m";
  try {
    await mkdir(path.join(root, ".agents", "skills", "release"), { recursive: true });
    await writeFile(
      path.join(root, ".agents", "skills", "release", "SKILL.md"),
      "---\nname: Release\ndescription: Publish releases\n---\n\nRelease instructions.\n",
    );
    const initialized = await run(["init", "--root", root, "--harness", "opencode", "--json"], environment);
    assert.equal(initialized.code, 0, initialized.stderr);

    // A hostile candidate with a broken body joins a configured source.
    const source = path.join(directory, "hostile");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, `${hostileId}.md`), "---\nname: Evil\ndescription: Broken\n");
    const configFile = path.join(root, ".skill-router.json");
    const config = JSON.parse(await readFile(configFile, "utf8"));
    config.sources = [source];
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`);

    const hostile = (stream, label) => {
      // Newlines and carriage returns format the output; no other control
      // byte may ever appear.
      assert.equal(/[\u0000-\u0009\u000b-\u001f\u007f]/.test(stream), false, `${label} carries raw control bytes`);
      assert.equal(stream.includes(hostileId), false, `${label} leaks the malformed ID`);
      assert.equal(stream.includes("\u001b"), false, `${label} leaks an escape sequence`);
      assert.equal(stream.includes(source), false, `${label} leaks the absolute source path`);
      assert.equal(/EACCES|ENOENT|errno|syscall|closing delimiter/.test(stream), false, `${label} leaks a raw cause`);
      assert.ok(stream.length < 20_000, `${label} stays bounded`);
    };

    for (const args of [
      ["init", "--root", root, "--harness", "opencode", "--json"],
      ["scan", "--root", root, "--json"],
      ["add", "release", "--root", root, "--json"],
    ]) {
      const refused = await run(args, environment);
      assert.equal(refused.code, 1, args.join(" "));
      assert.match(refused.stderr, /derived skill ID is not a portable public ID \(reason: grammar\)/);
      hostile(refused.stdout, `${args[0]} stdout`);
      hostile(refused.stderr, `${args[0]} stderr`);
    }

    const json = await run(["check", "--root", root, "--json"], environment);
    assert.equal(json.code, 1);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.healthy, false);
    assert.equal(payload.diagnostics.filter((item) => item.code === "invalid-skill-id").length, 1);
    assert.equal(payload.diagnostics.some((item) => item.code === "invalid-skill"), false);
    hostile(json.stdout, "check --json stdout");
    hostile(json.stderr, "check --json stderr");

    const human = await run(["check", "--root", root], environment);
    assert.equal(human.code, 1);
    assert.ok(human.stdout.includes("not a portable public ID"));
    hostile(human.stdout, "check stdout");
    hostile(human.stderr, "check stderr");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * Final blocker CLI surface: a schema-v2 direct source under an absolute
 * ancestor with escape bytes/sensitive components must refuse on every
 * mutating command and on check (JSON and human) while identifying only the
 * validated config key and fixed counts — never the source path, an escape
 * byte, a raw cause, or unbounded output.
 */
test("CLI never leaks a hostile direct-source path", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "skill-router-cli-direct-"));
  const home = path.join(directory, "home");
  const root = path.join(directory, "project");
  await mkdir(home, { recursive: true });
  await mkdir(root, { recursive: true });
  const environment = { home, cwd: root };
  try {
    await mkdir(path.join(root, ".agents", "skills", "release"), { recursive: true });
    await writeFile(
      path.join(root, ".agents", "skills", "release", "SKILL.md"),
      "---\nname: Release\ndescription: Publish releases\n---\n\nRelease instructions.\n",
    );
    const initialized = await run(["init", "--root", root, "--harness", "opencode", "--json"], environment);
    assert.equal(initialized.code, 0, initialized.stderr);

    // Valid derived ID, malformed frontmatter, hostile absolute ancestor.
    const source = path.join(directory, "sent\u001binel", "safe-id");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "---\nname: Safe\ndescription: Broken\n");
    const configFile = path.join(root, ".skill-router.json");
    await writeFile(
      configFile,
      `${JSON.stringify({ schemaVersion: 2, skills: { "safe-id": { source } } }, null, 2)}\n`,
    );

    const hostile = (stream, label) => {
      // Newlines and carriage returns format the output; no other control
      // byte may ever appear.
      assert.equal(/[\u0000-\u0009\u000b-\u001f\u007f]/.test(stream), false, `${label} carries raw control bytes`);
      assert.equal(stream.includes(source), false, `${label} leaks the absolute source path`);
      assert.equal(stream.includes("\u001b"), false, `${label} leaks an escape sequence`);
      assert.equal(/EACCES|ENOENT|errno|syscall|closing delimiter/.test(stream), false, `${label} leaks a raw cause`);
      assert.ok(stream.length < 20_000, `${label} stays bounded`);
    };

    for (const args of [
      ["init", "--root", root, "--harness", "opencode", "--json"],
      ["scan", "--root", root, "--json"],
      ["add", "release", "--root", root, "--json"],
    ]) {
      const refused = await run(args, environment);
      assert.equal(refused.code, 1, args.join(" "));
      assert.match(refused.stderr, /skills\.safe-id\.source must resolve to exactly one skill \(0 found\)/);
      hostile(refused.stdout, `${args[0]} stdout`);
      hostile(refused.stderr, `${args[0]} stderr`);
    }

    const json = await run(["check", "--root", root, "--json"], environment);
    assert.equal(json.code, 1);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.healthy, false);
    const unresolved = payload.diagnostics.filter((item) => item.code === "direct-source-unresolved");
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].id, "safe-id");
    assert.equal(unresolved[0].message, "skills.safe-id.source must resolve to exactly one skill (0 found)");
    hostile(json.stdout, "check --json stdout");
    hostile(json.stderr, "check --json stderr");

    const human = await run(["check", "--root", root], environment);
    assert.equal(human.code, 1);
    assert.ok(human.stdout.includes("skills.safe-id.source must resolve to exactly one skill (0 found)"));
    hostile(human.stdout, "check stdout");
    hostile(human.stderr, "check stderr");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
