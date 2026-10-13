import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporary = mkdtempSync(path.join(os.tmpdir(), "skill-router-e2e-"));
const home = path.join(temporary, "router-home");
const install = path.join(temporary, "install");
const project = path.join(temporary, "project");
const external = path.join(temporary, "external");
const initial = path.join(external, "initial");
const additional = path.join(external, "additional");
const openCodeConfig = path.join(temporary, "opencode-config");
const openCode = process.env.SKILL_ROUTER_OPENCODE_BIN || "opencode";
mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });
mkdirSync(openCodeConfig, { recursive: true });

function section(title) {
  process.stdout.write(`\n=== ${title} ===\n`);
}

// Central redaction policy for every command failure and assertion detail.
// Raw command stderr/stdout must never reach assertion output or logs unchanged:
// credential/token forms and fixture/repository/host path details are removed first.
function sanitizeText(value) {
  if (typeof value !== "string" || value === "") return "";
  const hostHome = process.env.HOME || os.homedir();
  const redacted = value
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bAuthorization["']?\s*[:=]\s*["'][^"']+["']/gi, "Authorization: [redacted]")
    .replace(/\bAuthorization["']?\s*[:=]\s*\S+/gi, "Authorization: [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted-jwt]")
    .replace(/\b(?:sk|pat|api|key|token|secret|auth|password|passwd|bearer)[-_:][A-Za-z0-9_./+=-]{8,}\b/gi, "[redacted]")
    .replace(
      /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret|password|passwd|token|credential)["']?\s*[:=]\s*["']?[^\s"',;)}\]]+/gi,
      (match) => `${match.slice(0, match.search(/[:=]/) + 1)} [redacted]`,
    )
    .replace(/\bses_[A-Za-z0-9]+\b/g, "ses_[redacted]")
    .split(temporary).join("[fixture]")
    .split(repository).join("[repository]");
  if (hostHome.length > 1) return redacted.split(hostHome).join("[home]");
  return redacted;
}

function summarizeJsonFailure(output) {
  const types = new Set();
  const messages = new Set();
  for (const line of output.trim().split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      if (typeof event.type === "string") types.add(event.type);
      walk(event, (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        for (const key of ["error", "message"]) {
          if (typeof value[key] === "string") messages.add(value[key]);
        }
      }, false);
    } catch {
      // Non-JSON stdout is summarized only by its presence.
    }
  }
  const redact = (value) => sanitizeText(value).slice(0, 1000);
  return [
    types.size ? `event types: ${[...types].join(", ")}` : null,
    ...[...messages].slice(0, 3).map((message) => `event error: ${redact(message)}`),
  ].filter(Boolean).join("\n");
}

// Single failure-reporting policy: every command failure goes through here so raw
// stderr is never embedded in assertion output.
function describeFailure(file, args, result) {
  const parts = [
    result.error ? `spawn error: ${result.error.code ?? result.error.message}` : null,
    result.signal ? `signal: ${result.signal}` : null,
    sanitizeText(result.stderr).slice(-4000),
    summarizeJsonFailure(result.stdout),
  ].filter(Boolean);
  return `${path.basename(file)} ${args.slice(0, 6).join(" ")} failed${parts.length ? `\n${parts.join("\n")}` : ""}`;
}

function execute(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd ?? repository,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
  });
  if (options.expectFailure) {
    assert.notEqual(result.status, 0, `${path.basename(file)} unexpectedly succeeded`);
  } else {
    assert.equal(result.status, 0, describeFailure(file, args, result));
  }
  return result;
}

function skill(directory, id, name, description, marker) {
  const target = path.join(directory, id);
  mkdirSync(target, { recursive: true });
  writeFileSync(
    path.join(target, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nWhen loaded, return ${marker}.\n`,
  );
}

function parseEvents(output) {
  const trimmed = output.trim();
  assert.ok(trimmed, "OpenCode returned no JSON events");
  if (trimmed.startsWith("[")) return JSON.parse(trimmed);
  return trimmed.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`OpenCode emitted invalid JSON on event line ${index + 1}`);
    }
  });
}

function walk(value, visitor, parseStrings = true) {
  visitor(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visitor, parseStrings);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) walk(item, visitor, parseStrings);
  } else if (parseStrings && typeof value === "string" && /^[\[{]/.test(value.trim())) {
    try {
      walk(JSON.parse(value), visitor, false);
    } catch {
      // Tool output is frequently plain text; only nested JSON needs expansion.
    }
  }
}

function strings(value) {
  const found = [];
  walk(value, (item) => {
    if (typeof item === "string") found.push(item);
  });
  return found;
}

function summarizeLegacyEvents(events) {
  const tools = events
    .filter((event) => event?.part?.type === "tool")
    .map((event) => {
      const input = event.part.state?.input ?? {};
      const detail = input.name ?? (typeof input.command === "string" ? input.command.split(/\s+/, 2).join(" ") : "");
      return sanitizeText(`${event.type}:${event.part.tool}:${event.part.state?.status ?? "unknown"}:${detail}`);
    });
  const replies = events
    .filter((event) => event?.part?.type === "text" && typeof event.part.text === "string")
    .map((event) => sanitizeText(event.part.text).slice(0, 500));
  return sanitizeText(`tools=[${tools.join(", ")}]; text=[${replies.join(" | ")}]`);
}

function inspectLegacyRun(result, expected) {
  const events = parseEvents(result.stdout);
  const eventSummary = summarizeLegacyEvents(events);
  const completedTool = (event) =>
    event?.type === "tool_use" &&
    event.part?.type === "tool" &&
    event.part.state?.status === "completed";
  const skillCall = (event, name) =>
    completedTool(event) && event.part.tool === "skill" && event.part.state.input?.name === name;
  const routerSkillIndex = events.findIndex((event) => skillCall(event, "skill-router"));
  assert.notEqual(routerSkillIndex, -1, `agent did not load the skill-router skill; ${eventSummary}`);
  const routeIndex = events.findIndex((event, index) => {
    const command = event?.part?.state?.input?.command;
    return index > routerSkillIndex && completedTool(event) && typeof command === "string" &&
      command.includes("skill-router route") && command.includes("--request-token");
  });
  assert.notEqual(routeIndex, -1, `agent did not invoke the router CLI with shell-safe request transport; ${eventSummary}`);
  let routeOutput;
  try {
    routeOutput = JSON.parse(events[routeIndex].part.state.output);
  } catch {
    throw new Error("router CLI tool output was not JSON");
  }
  assert.equal(routeOutput.outcome, expected.outcome, `router did not return ${expected.outcome}`);
  if (expected.skillId) {
    assert.equal(routeOutput.skillId, expected.skillId, "router selected the wrong skill");
    const selectedSkillIndex = events.findIndex(
      (event, index) => index > routeIndex && skillCall(event, expected.skillId),
    );
    assert.notEqual(selectedSkillIndex, -1, "agent did not load the selected skill after routing");
    assert.equal(
      events.slice(selectedSkillIndex + 1).some((event) =>
        event.type === "text" && event.part?.type === "text" && event.part.text?.includes(expected.marker)),
      true,
      "final response omitted the hidden skill marker",
    );
  } else {
    assert.equal(events.some((event) => skillCall(event, "release")), false, "unrelated request loaded release skill");
    assert.equal(strings(events).some((text) => text.includes(expected.marker)), false, "unrelated request exposed the release marker");
  }
  const sessions = new Set(events.map((event) => event.sessionID).filter(Boolean));
  assert.equal(sessions.size, 1, "OpenCode events did not belong to exactly one session");
  return [...sessions][0];
}

const keep = process.env.SKILL_ROUTER_KEEP_FIXTURE === "1";
let copiedAuth = null;
try {
  const version = execute(openCode, ["--version"]).stdout.trim();
  const versionMatch = version.match(/^(?:opencode\s+)?v?(\d+)\.\d+\.\d+/i);
  assert.ok(versionMatch, "OpenCode returned an unrecognized version");
  const versionMajor = Number.parseInt(versionMatch[1], 10);
  if (versionMajor >= 2) {
    throw new Error(
      `unsupported OpenCode v${versionMajor}: this E2E covers OpenCode v1 only. ` +
      "OpenCode v2 lacks equivalent HOME/XDG/auth isolation and the structural assertions this script relies on, " +
      "so no OpenCode v2 coverage is claimed; point SKILL_ROUTER_OPENCODE_BIN at a v1 binary.",
    );
  }

  section("Pack and install published artifact shape");
  const packed = execute("npm", ["pack", "--silent", "--pack-destination", temporary])
    .stdout.trim().split("\n").at(-1);
  const tarball = path.join(temporary, packed);
  execute("npm", ["install", "--prefix", install, "--ignore-scripts", tarball]);
  const router = path.join(install, "node_modules", ".bin", "skill-router");
  process.stdout.write(`installed ${packed}\n`);

  skill(initial, "release", "Release", "Prepare notes and publish releases", "RELEASE_SKILL_LOADED");
  skill(initial, "deploy-api", "Deploy API", "Deploy a service to production", "DEPLOY_API_LOADED");
  skill(initial, "deploy-web", "Deploy Web", "Deploy a service to production", "DEPLOY_WEB_LOADED");
  skill(additional, "review", "Review", "Review code for correctness", "REVIEW_SKILL_LOADED");
  skill(additional, "format", "Format", "Format source files", "FORMAT_SKILL_LOADED");
  writeFileSync(path.join(project, ".skill-router.json"), `${JSON.stringify({ schemaVersion: 1, sources: [initial] }, null, 2)}\n`);

  const model = process.env.SKILL_ROUTER_OPENCODE_MODEL || "opencode-go/gpt-5.6-luna";
  const provider = model.split("/", 1)[0];
  assert.ok(provider && model.includes("/"), "SKILL_ROUTER_OPENCODE_MODEL must use provider/model format");

  const environment = {
    ...process.env,
    OPENCODE_CONFIG_DIR: openCodeConfig,
    OPENCODE2_CONFIG_DIR: openCodeConfig,
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    PWD: project,
    SKILL_ROUTER_HOME: home,
    SKILL_ROUTER_OPENCODE_BIN: openCode,
    PATH: `${path.dirname(router)}${path.delimiter}${process.env.PATH}`,
  };
  for (const key of [
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_AUTH_CONTENT",
    "OPENCODE_PERMISSION",
    "OPENCODE_PLUGIN_META_FILE",
    "OPENCODE_DB",
    "INIT_CWD",
    "OLDPWD",
  ]) delete environment[key];

  let legacyHome;
  if (versionMajor < 2) {
    legacyHome = path.join(temporary, "opencode-home");
    const legacyConfig = path.join(legacyHome, ".config");
    const legacyData = path.join(legacyHome, ".local", "share");
    const legacyCache = path.join(legacyHome, ".cache");
    const legacyState = path.join(legacyHome, ".local", "state");
    mkdirSync(path.join(legacyData, "opencode"), { recursive: true, mode: 0o700 });
    mkdirSync(legacyConfig, { recursive: true, mode: 0o700 });
    mkdirSync(legacyCache, { recursive: true, mode: 0o700 });
    mkdirSync(legacyState, { recursive: true, mode: 0o700 });

    const hostHome = process.env.HOME || os.homedir();
    const hostData = process.env.XDG_DATA_HOME || path.join(hostHome, ".local", "share");
    try {
      const hostAuth = JSON.parse(readFileSync(path.join(hostData, "opencode", "auth.json"), "utf8"));
      const credential = hostAuth[provider];
      if (credential) {
        assert.notEqual(credential.type, "wellknown", "wellknown credentials cannot be isolated safely");
        copiedAuth = path.join(legacyData, "opencode", "auth.json");
        writeFileSync(
          copiedAuth,
          `${JSON.stringify({ [provider]: credential }, null, 2)}\n`,
          { mode: 0o600 },
        );
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    Object.assign(environment, {
      HOME: legacyHome,
      OPENCODE_TEST_HOME: legacyHome,
      XDG_CONFIG_HOME: legacyConfig,
      XDG_DATA_HOME: legacyData,
      XDG_CACHE_HOME: legacyCache,
      XDG_STATE_HOME: legacyState,
      OPENCODE_CONFIG_DIR: openCodeConfig,
      OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(legacyHome, "managed"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        model,
        default_agent: "build",
        enabled_providers: [provider],
        share: "disabled",
        autoupdate: false,
        snapshot: false,
        mcp: {},
        plugin: [],
      }),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_DISABLE_AUTOCOMPACT: "1",
    });
  }
  const route = (...args) => execute(router, args, { env: environment });
  const json = (...args) => {
    const separator = args.indexOf("--");
    if (separator === -1) args.push("--json");
    else args.splice(separator, 0, "--json");
    const stdout = route(...args).stdout;
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error(`skill-router returned invalid JSON: ${sanitizeText(stdout).slice(0, 500)}`);
    }
  };

  section("Initialize and exercise every public command");
  assert.equal(json("init", "--root", project, "--dry-run").dryRun, true);
  assert.equal(json("init", "--root", project).skillCount, 3);
  const repeated = json("init", "--root", project);
  assert.equal(repeated.skillCount, 3);
  assert.equal(json("route", "--root", project, "--", "release").skillId, "release");
  assert.equal(json("route", "--root", project, "--", "calculate orbital velocity").outcome, "none");
  assert.equal(json("route", "--root", project, "--", "deploy service production").outcome, "clarify");

  const added = json(
    "add", "review", "--root", project, "--source", additional,
    "--alias", "inspect change", "--description", "Inspect code changes",
  );
  assert.deepEqual(added.added, ["review"]);
  assert.equal(json("route", "--root", project, "--", "inspect change").skillId, "review");
  json("add", path.join(additional, "format"), "--root", project, "--no-enable");
  assert.equal(json("route", "--root", project, "--", "format").outcome, "none");
  assert.deepEqual(json("scan", "--root", project).diff, { added: [], removed: [], changed: [] });
  assert.equal(json("check", "--root", project).healthy, true);

  const managedReview = path.join(project, ".skill-router", "opencode-skills", "review", "SKILL.md");
  rmSync(managedReview);
  execute(router, ["check", "--root", project, "--json"], { env: environment, expectFailure: true });
  json("scan", "--root", project);
  assert.equal(json("check", "--root", project).healthy, true);

  const openCodeDocument = JSON.parse(readFileSync(path.join(project, ".opencode", "opencode.json"), "utf8"));
  assert.equal(Array.isArray(openCodeDocument.skills), false, "router wrote the wrong OpenCode skill shape");

  if (versionMajor < 2) {
    const resolvedPaths = Object.fromEntries(
      execute(openCode, ["debug", "paths", "--pure"], { cwd: project, env: environment }).stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => line.trim().match(/^(\S+)\s+(.+)$/)?.slice(1))
        .filter(Boolean),
    );
    for (const key of ["config", "data", "cache", "state"]) {
      assert.ok(
        resolvedPaths[key] === legacyHome || resolvedPaths[key]?.startsWith(`${legacyHome}${path.sep}`),
        `legacy OpenCode ${key} path escaped the fixture`,
      );
    }
    const resolvedConfig = JSON.parse(
      execute(openCode, ["debug", "config", "--pure"], { cwd: project, env: environment }).stdout,
    );
    assert.equal(resolvedConfig.model, model, "isolated OpenCode model was not applied");
    assert.equal(resolvedConfig.default_agent, "build", "isolated OpenCode agent was not applied");
    assert.deepEqual(Object.keys(resolvedConfig.mcp ?? {}), [], "isolated OpenCode inherited MCP servers");
    assert.deepEqual(resolvedConfig.plugin ?? [], [], "isolated OpenCode inherited plugins");
    assert.deepEqual(resolvedConfig.enabled_providers, [provider], "isolated OpenCode enabled unexpected providers");
    assert.ok(
      resolvedConfig.skills?.paths?.includes(path.join(project, ".skill-router", "opencode-skills")),
      "isolated OpenCode omitted the managed skill source",
    );
    const availableModels = execute(openCode, ["models", provider, "--pure"], {
      cwd: project,
      env: environment,
    }).stdout.split(/\r?\n/);
    assert.ok(availableModels.includes(model), `isolated OpenCode catalog does not contain ${model}`);
    const discovered = JSON.parse(execute(openCode, ["debug", "skill", "--pure"], {
      cwd: project,
      env: environment,
    }).stdout);
    const byName = new Map(discovered.map((entry) => [entry.name, entry.location]));
    assert.equal(
      byName.get("skill-router"),
      path.join(project, ".skill-router", "opencode-skills", "skill-router", "SKILL.md"),
      "legacy OpenCode did not discover the generated router skill",
    );
    assert.equal(
      byName.get("release"),
      path.join(project, ".skill-router", "opencode-skills", "release", "SKILL.md"),
      "legacy OpenCode did not discover the routed release skill",
    );
  }

  section("Validate genuinely fresh OpenCode sessions");
  const run = (title, prompt) => execute(
    openCode,
    [
      "run",
      "--pure",
      "--auto",
      "--format", "json",
      "--model", model,
      "--agent", "build",
      "--title", title,
      prompt,
    ],
    { cwd: project, env: environment, timeout: 300_000 },
  );
  const first = inspectLegacyRun(
    run(
      "skill-router-e2e-1",
      "Load and use the `skill-router` skill for this request: prepare and publish a release. After loading the selected skill, return the marker that its instructions tell you to return.",
    ),
    { outcome: "select", skillId: "release", marker: "RELEASE_SKILL_LOADED" },
  );
  process.stdout.write("release request routed and loaded in a fresh session\n");

  const second = inspectLegacyRun(
    run(
      "skill-router-e2e-2",
      "Load and use the `skill-router` skill for this unrelated request: calculate orbital velocity. Report only the router outcome.",
    ),
    { outcome: "none", marker: "RELEASE_SKILL_LOADED" },
  );
  assert.notEqual(first, second, "OpenCode validation reused a session");
  process.stdout.write("unrelated request abstained in a distinct fresh session\n");

  section("Validation passed");
} finally {
  if (copiedAuth) {
    try {
      rmSync(copiedAuth, { force: true });
    } catch (error) {
      process.stderr.write(`warning: could not remove isolated auth.json: ${sanitizeText(String(error.message))}\n`);
    }
  }
  if (keep) process.stdout.write("fixture retained by request\n");
  else rmSync(temporary, { recursive: true, force: true });
}
