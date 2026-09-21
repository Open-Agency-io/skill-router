import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repository, "src", "cli.js");

function run(args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: repository,
      env: { ...process.env, SKILL_ROUTER_HOME: environment.home },
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
